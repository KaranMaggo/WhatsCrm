/**
 * Fallback-policy resolver.
 *
 * Pure logic that decides what the engine does when a customer reply
 * doesn't match any option on the current `send_buttons` / `send_list`
 * node. Lifted out of `engine.ts` so it can be unit-tested without a
 * Supabase / Meta mock.
 *
 * The policy lives on `flows.fallback_policy` (JSONB) and is loaded
 * with the run; defaults filled in by `resolveFallbackPolicy` so an
 * older flow row (or a partial JSONB blob) doesn't crash the runner.
 */

import {
  DEFAULT_FALLBACK_POLICY,
  type FlowFallbackPolicy,
} from "./types";

export type FallbackAction =
  /** Re-send the same prompt and wait again. */
  | { type: "reprompt" }
  /** Answer with AI grounded in KB and bridge back to the flow. */
  | { type: "ai_fallback" }
  /** End the run with status='handed_off', flip conversation to pending. */
  | { type: "handoff" }
  /** End the run with status='completed' (the `end` exhaust option). */
  | { type: "end" }
  /** Do nothing — the message wasn't for us. */
  | { type: "ignore" };

/**
 * Merge a partial / null fallback_policy from the DB with the defaults.
 */
export function resolveFallbackPolicy(
  raw: unknown,
): FlowFallbackPolicy {
  if (!raw || typeof raw !== "object") return DEFAULT_FALLBACK_POLICY;
  const r = raw as Partial<FlowFallbackPolicy>;
  return {
    on_unknown_reply:
      r.on_unknown_reply === "handoff" ||
      r.on_unknown_reply === "ignore" ||
      r.on_unknown_reply === "reprompt" ||
      r.on_unknown_reply === "ai_fallback"
        ? r.on_unknown_reply
        : DEFAULT_FALLBACK_POLICY.on_unknown_reply,
    max_reprompts:
      typeof r.max_reprompts === "number" && r.max_reprompts >= 0
        ? Math.floor(r.max_reprompts)
        : DEFAULT_FALLBACK_POLICY.max_reprompts,
    on_timeout_hours:
      typeof r.on_timeout_hours === "number" && r.on_timeout_hours > 0
        ? r.on_timeout_hours
        : DEFAULT_FALLBACK_POLICY.on_timeout_hours,
    on_exhaust:
      r.on_exhaust === "handoff" || r.on_exhaust === "end"
        ? r.on_exhaust
        : DEFAULT_FALLBACK_POLICY.on_exhaust,
    ai_fallback_prompt:
      typeof r.ai_fallback_prompt === "string" ? r.ai_fallback_prompt : undefined,
    ai_fallback_resend_prompt: r.ai_fallback_resend_prompt !== false,
    followup_enabled: Boolean(r.followup_enabled),
    followups: Array.isArray(r.followups)
      ? r.followups
          .filter((f) => f && typeof f === "object")
          .map((f) => ({
            delay_hours:
              typeof f.delay_hours === "number" && f.delay_hours > 0
                ? f.delay_hours
                : 2,
            message: typeof f.message === "string" ? f.message : "",
          }))
      : DEFAULT_FALLBACK_POLICY.followups,
  };
}

/**
 * Decide the action when the customer's reply doesn't match a button
 * id or expected input on the current node.
 */
export function decideFallback(args: {
  policy: FlowFallbackPolicy;
  /** Reprompt count AFTER incrementing (so 1 = first reprompt / AI answer). */
  reprompt_count: number;
}): FallbackAction {
  const { policy, reprompt_count } = args;

  if (policy.on_unknown_reply === "ignore") return { type: "ignore" };
  if (policy.on_unknown_reply === "handoff") return { type: "handoff" };

  if (policy.on_unknown_reply === "ai_fallback") {
    if (reprompt_count <= policy.max_reprompts) {
      return { type: "ai_fallback" };
    }
    return policy.on_exhaust === "end"
      ? { type: "end" }
      : { type: "handoff" };
  }

  // 'reprompt' — guarded by max_reprompts.
  if (reprompt_count <= policy.max_reprompts) {
    return { type: "reprompt" };
  }
  return policy.on_exhaust === "end"
    ? { type: "end" }
    : { type: "handoff" };
}
