/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  extractStepOptions,
  extractStepPrompt,
  extractOptionsFromPromptText,
  matchLiteralOption,
  evaluateSemanticStepMatch,
  evaluateSemanticCondition,
} from "./semantic-match";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { loadAiConfig } from "@/lib/ai/config";
import { retrieveKnowledge } from "@/lib/ai/knowledge";
import { buildSystemPrompt } from "@/lib/ai/defaults";
import { generateReply } from "@/lib/ai/generate";
import { logAiUsage } from "@/lib/ai/usage";
import { buildConversationContext } from "@/lib/ai/context";
import {
  type AiReplyNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type HandoffNodeConfig,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type FlowTriggerType,
  type FlowFallbackPolicy,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "ai_reply"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains": {
      if (args.subjectValue === undefined) return false;
      const val = (args.configValue ?? "").trim();
      if (!val) return false;
      const sub = args.subjectValue.trim();
      if (sub.includes(val)) return true;

      const subLower = sub.toLowerCase();
      const valLower = val.toLowerCase();
      if (subLower.includes(valLower)) return true;

      // Allow comma-separated alternatives, e.g. "1, face"
      const alternatives = valLower
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        alternatives.length > 1 &&
        alternatives.some((alt) => subLower.includes(alt))
      ) {
        return true;
      }

      // If user typed a full option phrase like "1 - Face" and customer typed "1" or "face"
      const tokens = valLower.split(/[\s,-]+/).filter((t) => t.length > 0);
      if (
        tokens.length > 1 &&
        tokens.some((t) => subLower === t || subLower.includes(t))
      ) {
        return true;
      }

      return false;
    }
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as unknown as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    } else if (flow.trigger_type === "new_message_received") {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Variable & Contact Property Interpolation
// ============================================================

/**
 * Load contact variables for message interpolation.
 * Resolves standard contact fields (name, first_name, last_name, phone, email, company)
 * and custom fields into a flat string-keyed map.
 */
export async function loadContactVars(
  db: AdminClient,
  contactId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!contactId) return {};
  try {
    const { data: contact } = await db
      .from("contacts")
      .select("name, phone, email, company")
      .eq("id", contactId)
      .maybeSingle();

    if (!contact) return {};
    const c = contact as {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      company?: string | null;
    };
    const name = (c.name ?? "").trim();
    const parts = name.split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? "";
    const lastName = parts.slice(1).join(" ") ?? "";
    const phone = (c.phone ?? "").trim();
    const email = (c.email ?? "").trim();
    const company = (c.company ?? "").trim();

    const vars: Record<string, string> = {
      name,
      first_name: firstName,
      last_name: lastName,
      phone,
      email,
      company,
    };

    // Load custom values if available
    try {
      const { data: customValues } = await db
        .from("contact_custom_values")
        .select("value, custom_fields(field_name)")
        .eq("contact_id", contactId);

      if (customValues && Array.isArray(customValues)) {
        for (const row of customValues as unknown as Array<{
          value: string | null;
          custom_fields: { field_name: string } | Array<{ field_name: string }> | null;
        }>) {
          const cf = Array.isArray(row.custom_fields) ? row.custom_fields[0] : row.custom_fields;
          const fieldName = cf?.field_name;
          if (fieldName && row.value !== null && row.value !== undefined) {
            const val = String(row.value);
            vars[fieldName] = val;
            vars[`custom_${fieldName}`] = val;
            vars[fieldName.toLowerCase().replace(/[^a-z0-9_]/g, "_")] = val;
          }
        }
      }
    } catch {
      // Custom values optional
    }

    return vars;
  } catch (err) {
    console.warn("[flows] loadContactVars error:", err);
    return {};
  }
}

/**
 * Message text interpolation supporting both flow runtime variables (`{{vars.key}}`)
 * and contact properties (`{{contact.name}}`, `{{contact.first_name}}`, `{{contact.phone}}`,
 * `{{contact.email}}`, `{{contact.company}}`, custom fields, and bare aliases like `{{name}}`).
 * Missing variables render as empty strings.
 */
export function interpolateVars(
  template: string,
  vars: Record<string, unknown> = {},
  contactVars: Record<string, unknown> = {},
): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expression: string) => {
    const raw = expression.trim();

    // 1. Explicit contact namespace: {{ contact.name }}, {{ contact.first_name }}, {{ contact.custom.city }}
    if (raw.startsWith("contact.")) {
      const prop = raw.slice("contact.".length).replace(/^custom\./, "");
      const val = contactVars[prop] ?? contactVars[prop.toLowerCase()];
      return val === undefined || val === null ? "" : String(val);
    }

    // 2. Explicit vars namespace: {{ vars.name }}, {{ var.name }}
    if (raw.startsWith("vars.")) {
      const key = raw.slice("vars.".length);
      const val = vars[key];
      return val === undefined || val === null ? "" : String(val);
    }
    if (raw.startsWith("var.")) {
      const key = raw.slice("var.".length);
      const val = vars[key];
      return val === undefined || val === null ? "" : String(val);
    }

    // 3. Shorthands and bare keys: {{ name }}, {{ first_name }}, {{ phone }}, etc.
    // Flow captured vars take precedence if authored, otherwise contact vars
    if (vars[raw] !== undefined && vars[raw] !== null) {
      return String(vars[raw]);
    }
    if (contactVars[raw] !== undefined && contactVars[raw] !== null) {
      return String(contactVars[raw]);
    }
    const lower = raw.toLowerCase();
    if (contactVars[lower] !== undefined && contactVars[lower] !== null) {
      return String(contactVars[lower]);
    }

    return "";
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
  contactVars?: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars, contactVars);
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cachedContactVars?: Record<string, string>,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const contactVars = cachedContactVars ?? (await loadContactVars(db, run.contact_id));
  // Every customer-visible string is interpolated against run.vars and contact variables
  // (`reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored). Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, contactVars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, contactVars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, contactVars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars, contactVars),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cachedContactVars?: Record<string, string>,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const contactVars = cachedContactVars ?? (await loadContactVars(db, run.contact_id));
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, contactVars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars, contactVars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, contactVars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, contactVars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars, contactVars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars, contactVars),
        description: interpolateOptionalVars(r.description, run.vars, contactVars),
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as HandoffNodeConfig;
  const isAi = cfg.target === "ai";

  if (isAi) {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({
          ai_autoreply_disabled: false,
          assigned_agent_id: null,
          status: "open",
          updated_at: new Date().toISOString(),
          ...(cfg.note ? { ai_handoff_summary: cfg.note } : {}),
        })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", node.node_key, {
      target: "ai",
      note: cfg.note ?? null,
    });
    await endRun(db, run.id, "handed_off", "handoff_ai");
    return;
  }

  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    target: "human",
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

async function executeAiReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: AiReplyNodeConfig,
  cachedContactVars?: Record<string, string>,
): Promise<void> {
  let query = "";
  if (cfg.input_source === "var" && cfg.var_key) {
    query = String(run.vars[cfg.var_key] ?? "").trim();
  } else if (cfg.input_source === "custom" && cfg.custom_query) {
    const contactVars = cachedContactVars ?? (await loadContactVars(db, run.contact_id));
    query = interpolateVars(cfg.custom_query, run.vars, contactVars).trim();
  } else if (run.conversation_id) {
    const { data: lastMsg } = await db
      .from("messages")
      .select("content, text")
      .eq("conversation_id", run.conversation_id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = lastMsg?.content as Record<string, unknown> | null;
    query = (
      lastMsg?.text ||
      (typeof content?.text === "string" ? content.text : "") ||
      ""
    ).trim();
  }

  const aiConfig = await loadAiConfig(db, run.account_id);
  if (!aiConfig || !aiConfig.isActive) {
    throw new Error("AI Assistant is not active or configured for this workspace");
  }

  const knowledge = await retrieveKnowledge(
    db,
    run.account_id,
    aiConfig,
    query || "Customer inquiry",
  );

  const userPrompt = cfg.prompt?.trim() || aiConfig.systemPrompt;
  const systemPrompt = buildSystemPrompt({
    userPrompt,
    mode: "auto_reply",
    knowledge,
  });

  const messages = run.conversation_id
    ? await buildConversationContext(db, run.conversation_id)
    : [];

  if (query && (messages.length === 0 || messages[messages.length - 1].content !== query)) {
    messages.push({ role: "user", content: query });
  }

  const { text, usage } = await generateReply({
    config: aiConfig,
    systemPrompt,
    messages,
  });

  if (!text || !text.trim()) {
    throw new Error("AI returned empty reply");
  }

  const replyText = text.trim();

  if (cfg.store_reply_var && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.store_reply_var)) {
    run.vars[cfg.store_reply_var] = replyText;
    await db
      .from("flow_runs")
      .update({ vars: run.vars })
      .eq("id", run.id);
  }

  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: replyText,
  });

  void logAiUsage(db, {
    accountId: run.account_id,
    conversationId: run.conversation_id!,
    mode: "auto_reply",
    provider: aiConfig.provider,
    model: aiConfig.model,
    usage,
  });

  await logEvent(db, run.id, "message_sent", node.node_key, {
    whatsapp_message_id,
    text: replyText,
    tokens: usage?.totalTokens ?? 0,
  });
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  const literalResult = evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
  if (literalResult) return true;

  // AI semantic lookup fallback for equals / contains predicates:
  if (
    !literalResult &&
    (cfg.operator === "equals" || cfg.operator === "contains") &&
    subjectValue &&
    cfg.value
  ) {
    try {
      const aiConfig = await loadAiConfig(db, run.account_id, {
        requireActive: false,
      });
      if (aiConfig?.apiKey) {
        const semanticMatch = await evaluateSemanticCondition({
          aiConfig,
          subjectKey: cfg.subject_key,
          subjectValue,
          targetValue: cfg.value,
        });
        if (semanticMatch) return true;
      }
    } catch (semErr) {
      console.error("[flows] condition semantic check error:", semErr);
    }
  }

  return false;
}


async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function applyNodeDelay(
  cfg: Record<string, unknown>,
  isAutoAdvance = false,
): Promise<void> {
  if (process.env.NODE_ENV === "test" && !cfg.delay_seconds) {
    return;
  }
  let sec =
    typeof cfg.delay_seconds === "number" && cfg.delay_seconds > 0
      ? Math.min(10, cfg.delay_seconds)
      : 0;
  if (sec === 0 && isAutoAdvance && process.env.NODE_ENV !== "test") {
    sec = 1.5;
  }
  if (sec > 0) {
    await new Promise((resolve) => setTimeout(resolve, sec * 1000));
  }
}

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  cachedContactVars?: Record<string, string>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  const contactVars = cachedContactVars ?? (await loadContactVars(db, run.contact_id));
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    const isAutoAdvance = safety > 0;

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      await applyNodeDelay(cfg as unknown as Record<string, unknown>, isAutoAdvance);
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars, contactVars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
        if (cfg.wait_for_reply) {
          const { data: msg } = await db
            .from("messages")
            .select("id")
            .eq("message_id", whatsapp_message_id)
            .maybeSingle();
          await db
            .from("flow_runs")
            .update({
              current_node_key: node.node_key,
              last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
            })
            .eq("id", run.id);
          return { outcome: "advanced" };
        }
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      await applyNodeDelay(cfg as unknown as Record<string, unknown>, isAutoAdvance);
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars, contactVars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
        if (cfg.wait_for_reply) {
          const { data: msg } = await db
            .from("messages")
            .select("id")
            .eq("message_id", whatsapp_message_id)
            .maybeSingle();
          await db
            .from("flow_runs")
            .update({
              current_node_key: node.node_key,
              last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
            })
            .eq("id", run.id);
          return { outcome: "advanced" };
        }
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars, contactVars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await applyNodeDelay(node.config as unknown as Record<string, unknown>, isAutoAdvance);
      try {
        await sendButtonsAndSuspend(db, run, node, contactVars);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await applyNodeDelay(node.config as unknown as Record<string, unknown>, isAutoAdvance);
      try {
        await sendListAndSuspend(db, run, node, contactVars);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "ai_reply") {
      const cfg = node.config as unknown as AiReplyNodeConfig;
      try {
        await executeAiReply(db, run, node, cfg, contactVars);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "ai_reply_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        if (cfg.fallback_text?.trim()) {
          try {
            const fallbackBody = interpolateVars(cfg.fallback_text, run.vars, contactVars);
            await engineSendText({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              text: fallbackBody,
            });
            await logEvent(db, run.id, "message_sent", node.node_key, {
              text: fallbackBody,
              is_fallback: true,
            });
          } catch (fallbackErr) {
            console.error("[flows] ai_reply fallback send failed:", fallbackErr);
          }
        }
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

/**
 * Evaluates whether a non-message event matches a flow's trigger configuration.
 */
export function matchesTriggerConfig(
  triggerType: FlowTriggerType,
  triggerConfig: Record<string, unknown>,
  context?: {
    tag_id?: string;
    property?: string;
    value?: unknown;
    old_value?: unknown;
    agent_id?: string;
    [key: string]: unknown;
  },
): boolean {
  if (triggerType === "tag_added" || triggerType === "tag_removed") {
    const requiredTagId =
      typeof triggerConfig.tag_id === "string" ? triggerConfig.tag_id.trim() : "";
    if (!requiredTagId) return true; // Any tag matches
    return context?.tag_id === requiredTagId;
  }

  if (triggerType === "contact_property") {
    const targetProperty =
      typeof triggerConfig.property === "string" ? triggerConfig.property.trim() : "";
    if (!targetProperty) return false;
    if (context?.property && context.property !== targetProperty) return false;

    const op = (triggerConfig.operator as string) || "any_change";
    const val = context?.value;
    const expected = triggerConfig.value !== undefined ? String(triggerConfig.value) : "";

    switch (op) {
      case "any_change":
        return true;
      case "equals":
        return String(val ?? "") === expected;
      case "not_equals":
        return String(val ?? "") !== expected;
      case "contains":
        return String(val ?? "").toLowerCase().includes(expected.toLowerCase());
      case "is_set":
        return val !== null && val !== undefined && val !== "";
      case "is_not_set":
        return val === null || val === undefined || val === "";
      default:
        return true;
    }
  }

  if (triggerType === "conversation_assigned") {
    const requiredAgent =
      typeof triggerConfig.agent_id === "string" ? triggerConfig.agent_id.trim() : "";
    if (!requiredAgent) return true;
    return context?.agent_id === requiredAgent;
  }

  if (triggerType === "new_contact_created" || triggerType === "new_message_received") {
    return true;
  }

  return false;
}

export interface DispatchEventToFlowsInput {
  accountId: string;
  triggerType: FlowTriggerType;
  contactId: string;
  conversationId?: string | null;
  context?: {
    tag_id?: string;
    property?: string;
    value?: unknown;
    old_value?: unknown;
    agent_id?: string;
    [key: string]: unknown;
  };
}

export interface DispatchEventToFlowsResult {
  dispatched: boolean;
  flow_run_ids: string[];
}

/**
 * Public entry point for event-based triggers (tag_added, tag_removed,
 * contact_property, new_contact_created, conversation_assigned).
 */
export async function dispatchTriggerToFlows(
  input: DispatchEventToFlowsInput,
): Promise<DispatchEventToFlowsResult> {
  const db = supabaseAdmin();
  try {
    const { data: flows, error } = await db
      .from("flows")
      .select("*")
      .eq("account_id", input.accountId)
      .eq("status", "active")
      .eq("trigger_type", input.triggerType)
      .order("created_at", { ascending: true });

    if (error || !flows || flows.length === 0) {
      return { dispatched: false, flow_run_ids: [] };
    }

    const flowRunIds: string[] = [];

    for (const flow of flows as FlowRow[]) {
      if (!flow.entry_node_id) continue;
      if (!matchesTriggerConfig(flow.trigger_type, flow.trigger_config, input.context)) {
        continue;
      }

      // If contact already has an active run, skip starting a parallel run
      const { data: existingRun } = await db
        .from("flow_runs")
        .select("id")
        .eq("account_id", flow.account_id)
        .eq("contact_id", input.contactId)
        .eq("status", "active")
        .maybeSingle();

      if (existingRun) {
        continue;
      }

      // Resolve conversation
      let conversationId = input.conversationId ?? null;
      if (!conversationId) {
        const { data: conv } = await db
          .from("conversations")
          .select("id")
          .eq("account_id", flow.account_id)
          .eq("contact_id", input.contactId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        conversationId = (conv as { id: string } | null)?.id ?? null;
      }

      if (!conversationId) {
        const { data: createdConv } = await db
          .from("conversations")
          .insert({
            account_id: flow.account_id,
            contact_id: input.contactId,
            status: "open",
          })
          .select("id")
          .maybeSingle();
        conversationId = (createdConv as { id: string } | null)?.id ?? null;
      }

      const { data: inserted, error: insErr } = await db
        .from("flow_runs")
        .insert({
          flow_id: flow.id,
          account_id: flow.account_id,
          user_id: flow.user_id,
          contact_id: input.contactId,
          conversation_id: conversationId,
          status: "active",
          current_node_key: flow.entry_node_id,
        })
        .select("*")
        .maybeSingle();

      if (insErr || !inserted) {
        continue;
      }

      const run = inserted as FlowRunRow;
      flowRunIds.push(run.id);

      await logEvent(db, run.id, "started", flow.entry_node_id, {
        flow_id: flow.id,
        trigger_type: flow.trigger_type,
        context: input.context,
      });

      await db.rpc("increment_flow_execution_count", {
        p_flow_id: flow.id,
      });

      const nodes = await loadAllNodes(db, flow.id);
      await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
    }

    return {
      dispatched: flowRunIds.length > 0,
      flow_run_ids: flowRunIds,
    };
  } catch (err) {
    console.error(
      "[flows] dispatchTriggerToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { dispatched: false, flow_run_ids: [] };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Ways a reply can advance:
  //   1. Interactive button/list tap on send_buttons/send_list.
  //   2. Literal text match (number or title) on send_buttons/send_list.
  //   3. AI semantic intent match on send_buttons/send_list (e.g. "Tummy tuck" -> "Body").
  //   4. Text reply on collect_input (if not an off-topic inquiry).
  //   5. Text reply on wait_for_reply node.
  //
  // Everything else falls through to the AI / flow fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    const stepOptions = extractStepOptions(currentNode);
    // 1. Literal matching first (e.g. "1", "2", "3", "Body", "Breast")
    const literal = matchLiteralOption(message.text, stepOptions);
    if (literal) {
      matched = literal.next_node_key;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        matched_option: literal.title,
        match_type: "literal_text",
      });
    } else {
      // 2. Semantic AI matching (e.g. "Tummy tuck" -> "Body")
      try {
        const aiConfig = await loadAiConfig(db, run.account_id, {
          requireActive: false,
        });
        if (aiConfig?.apiKey) {
          const stepPrompt = extractStepPrompt(currentNode);
          const semantic = await evaluateSemanticStepMatch({
            aiConfig,
            stepPrompt,
            options: stepOptions,
            customerReply: message.text,
          });

          if (semantic.is_relevant_answer && semantic.matched_option) {
            matched = semantic.matched_option.next_node_key;
            if (semantic.inferred_value) {
              const newVars = {
                ...run.vars,
                _last_answer: semantic.inferred_value,
              };
              await db
                .from("flow_runs")
                .update({ vars: newVars })
                .eq("id", run.id);
              run.vars = newVars;
            }
            await logEvent(db, run.id, "node_entered", currentNode.node_key, {
              matched_option: semantic.matched_option.title,
              inferred_value: semantic.inferred_value,
              match_type: "ai_semantic",
              reason: semantic.reason,
            });
          }
        }
      } catch (semErr) {
        console.error("[flows] semantic step match error:", semErr);
      }
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0) {
      // Check if customer asked an inquiry question instead of answering
      let isOffTopicQuestion = false;
      try {
        const aiConfig = await loadAiConfig(db, run.account_id, {
          requireActive: false,
        });
        if (aiConfig?.apiKey) {
          const stepPrompt = extractStepPrompt(currentNode);
          const semantic = await evaluateSemanticStepMatch({
            aiConfig,
            stepPrompt,
            options: [],
            customerReply: captured,
          });
          if (semantic.is_question_or_inquiry && !semantic.is_relevant_answer) {
            isOffTopicQuestion = true;
          }
        }
      } catch (err) {
        console.error("[flows] collect_input semantic check error:", err);
      }

      if (!isOffTopicQuestion && cfg.var_key) {
        // Persist captured value + reset reprompt count atomically.
        const newVars = { ...run.vars, [cfg.var_key]: captured };
        const { error: capErr } = await db
          .from("flow_runs")
          .update({
            vars: newVars,
            reprompt_count: 0,
          })
          .eq("id", run.id);
        if (!capErr) {
          run.vars = newVars;
          run.reprompt_count = 0;
          await logEvent(db, run.id, "node_entered", currentNode.node_key, {
            captured_key: cfg.var_key,
            captured_length: captured.length,
          });
          matched = cfg.next_node_key;
        }
      }
    }
  } else if (
    (currentNode.node_type === "send_message" ||
      currentNode.node_type === "send_media") &&
    (currentNode.config as { wait_for_reply?: boolean }).wait_for_reply === true
  ) {
    const cfg = currentNode.config as {
      wait_for_reply?: boolean;
      next_node_key?: string;
      var_key?: string;
    };
    const replyText =
      message.kind === "text"
        ? message.text.trim()
        : message.kind === "interactive_reply"
          ? message.reply_title?.trim() || message.reply_id
          : "";

    // If customer asked a question rather than answering, or gave an off-option reply:
    let isOffTopicQuestion = false;
    let isInvalidOptionReply = false;
    let normalizedValue = replyText;
    if (message.kind === "text" && replyText.length > 0) {
      const stepOptions = extractStepOptions(currentNode);
      try {
        const aiConfig = await loadAiConfig(db, run.account_id, {
          requireActive: false,
        });
        if (aiConfig?.apiKey) {
          const stepPrompt = extractStepPrompt(currentNode);
          const semantic = await evaluateSemanticStepMatch({
            aiConfig,
            stepPrompt,
            options: stepOptions,
            customerReply: replyText,
          });
          if (semantic.is_question_or_inquiry && !semantic.is_relevant_answer) {
            isOffTopicQuestion = true;
          } else if (semantic.is_relevant_answer) {
            if (semantic.inferred_value) {
              normalizedValue = semantic.inferred_value;
            }
          } else {
            // The customer reply did not answer this step accordingly
            isInvalidOptionReply = true;
          }
        } else if (stepOptions.length > 0) {
          const literal = matchLiteralOption(replyText, stepOptions);
          if (literal) {
            normalizedValue = literal.title;
          } else {
            isInvalidOptionReply = true;
          }
        }
      } catch (err) {
        console.error("[flows] wait_for_reply semantic check error:", err);
      }
    }

    if (!isOffTopicQuestion && !isInvalidOptionReply) {
      if (cfg.var_key && replyText) {
        const newVars = {
          ...run.vars,
          [cfg.var_key]: normalizedValue,
          [`${cfg.var_key}_raw`]: replyText,
        };
        const { error: capErr } = await db
          .from("flow_runs")
          .update({
            vars: newVars,
            reprompt_count: 0,
          })
          .eq("id", run.id);
        if (!capErr) {
          run.vars = newVars;
          run.reprompt_count = 0;
          await logEvent(db, run.id, "node_entered", currentNode.node_key, {
            captured_key: cfg.var_key,
            captured_length: normalizedValue.length,
            inferred_value: normalizedValue,
          });
        }
      }
      matched = cfg.next_node_key ?? null;
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "ai_fallback") {
    try {
      await handleAiFallback(db, run, currentNode, policy, message, newReprompts);
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "ai_fallback_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      try {
        await repromptCurrentNode(db, run, currentNode);
      } catch (repromptErr) {
        console.error("[flows] fallback reprompt failed:", repromptErr);
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "reprompt") {
    try {
      await repromptCurrentNode(db, run, currentNode);
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function repromptCurrentNode(
  db: AdminClient,
  run: FlowRunRow,
  currentNode: FlowNodeRow,
  cachedContactVars?: Record<string, string>,
): Promise<void> {
  const contactVars = cachedContactVars ?? (await loadContactVars(db, run.contact_id));
  if (currentNode.node_type === "send_buttons") {
    await sendButtonsAndSuspend(db, run, currentNode, contactVars);
  } else if (currentNode.node_type === "send_list") {
    await sendListAndSuspend(db, run, currentNode, contactVars);
  } else if (currentNode.node_type === "collect_input") {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: interpolateVars(cfg.prompt_text, run.vars, contactVars),
    });
  } else if (
    currentNode.node_type === "send_message" &&
    (currentNode.config as unknown as SendMessageNodeConfig).wait_for_reply
  ) {
    const cfg = currentNode.config as unknown as SendMessageNodeConfig;
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: interpolateVars(cfg.text, run.vars, contactVars),
    });
  } else if (
    currentNode.node_type === "send_media" &&
    (currentNode.config as unknown as SendMediaNodeConfig).wait_for_reply
  ) {
    const cfg = currentNode.config as unknown as SendMediaNodeConfig;
    // When re-prompting a media node, sending the video/image again is slow and spammy.
    // Send the caption text to re-prompt smoothly.
    if (cfg.caption) {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: interpolateVars(cfg.caption, run.vars, contactVars),
      });
    }
  }
}

async function handleAiFallback(
  db: AdminClient,
  run: FlowRunRow,
  currentNode: FlowNodeRow,
  policy: FlowFallbackPolicy,
  message: ParsedInbound,
  newReprompts: number,
): Promise<void> {
  const query = (
    message.kind === "text"
      ? message.text
      : message.kind === "interactive_reply"
      ? message.reply_title
      : ""
  ).trim();

  const aiConfig = await loadAiConfig(db, run.account_id, {
    requireActive: false,
  });
  if (!aiConfig || !aiConfig.apiKey) {
    await repromptCurrentNode(db, run, currentNode);
    return;
  }

  const knowledge = await retrieveKnowledge(
    db,
    run.account_id,
    aiConfig,
    query || "Customer question",
  );

  const contactVars = await loadContactVars(db, run.contact_id);

  const stepPrompt = extractStepPrompt(currentNode);
  const stepOptions = extractStepOptions(currentNode);
  const optionsText =
    stepOptions.length > 0
      ? `\nAvailable options at this step:\n${stepOptions.map((o, i) => `${i + 1} - ${o.title}`).join("\n")}`
      : "";

  const customPrompt = policy.ai_fallback_prompt?.trim() || aiConfig.systemPrompt || "";
  const systemPrompt = buildSystemPrompt({
    userPrompt: `${customPrompt}\n\n` +
      `IMPORTANT CONTEXT: The customer is currently in an active WhatsApp flow at this step: "${stepPrompt}".${optionsText}\n` +
      `Customer message: "${query}".\n\n` +
      `YOUR INSTRUCTIONS:\n` +
      `1. If the customer asked a question or expressed concern, answer warmly and concisely (1-2 sentences) using the business knowledge.\n` +
      `2. If their message did not answer the step, politely and warmly remind them what to do next to continue (e.g. choose an option from the list, or select a consultation time slot).\n` +
      `3. Be human, empathetic, warm, and professional (like Ashley, their personal clinic coordinator). Never say you are an AI or bot. Keep your total reply under 3 sentences.`,
    mode: "auto_reply",
    knowledge,
  });

  const messages = run.conversation_id
    ? await buildConversationContext(db, run.conversation_id)
    : [];

  if (query && (messages.length === 0 || messages[messages.length - 1].content !== query)) {
    messages.push({ role: "user", content: query });
  }

  const { text, usage } = await generateReply({
    config: aiConfig,
    systemPrompt,
    messages,
  });

  if (text?.trim()) {
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: text.trim(),
    });

    if (usage) {
      await logAiUsage(db, {
        accountId: run.account_id,
        conversationId: run.conversation_id!,
        provider: aiConfig.provider,
        model: aiConfig.model,
        mode: "auto_reply",
        usage,
      });
    }

    await logEvent(db, run.id, "message_sent", currentNode.node_key, {
      text: text.trim(),
      is_ai_fallback: true,
      reprompt_count: newReprompts,
    });
  }

  if (policy.ai_fallback_resend_prompt !== false) {
    if (
      currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list"
    ) {
      await repromptCurrentNode(db, run, currentNode, contactVars);
    }
  }
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
