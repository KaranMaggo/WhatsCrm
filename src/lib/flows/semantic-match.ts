import type { FlowNodeRow } from "./types";
import type { AiConfig } from "@/lib/ai/types";
import { generateReply } from "@/lib/ai/generate";

export interface FlowStepOption {
  id: string;
  title: string;
  description?: string;
  next_node_key: string;
}

export interface SemanticMatchArgs {
  aiConfig: AiConfig;
  stepPrompt: string;
  options: FlowStepOption[];
  customerReply: string;
  varKey?: string;
}

export interface SemanticMatchResult {
  /** True if customer's reply is a valid answer/choice for this step. */
  is_relevant_answer: boolean;
  /** The matched option, if one of the choices was selected. */
  matched_option: FlowStepOption | null;
  /** Inferred or normalized answer (e.g. "Body (Tummy tuck)"). */
  inferred_value?: string;
  /** True if the customer asked a question or inquiry instead of answering. */
  is_question_or_inquiry: boolean;
  /** Brief explanation from the classifier. */
  reason?: string;
}

/**
 * Extracts selectable options from a flow node (buttons or list rows).
 */
export function extractStepOptions(node: FlowNodeRow): FlowStepOption[] {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as {
      buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
    };
    return (cfg.buttons || []).map((b) => ({
      id: b.reply_id,
      title: b.title,
      next_node_key: b.next_node_key,
    }));
  }

  if (node.node_type === "send_list") {
    const cfg = node.config as {
      sections?: Array<{
        rows?: Array<{
          reply_id: string;
          title: string;
          description?: string;
          next_node_key: string;
        }>;
      }>;
    };
    const res: FlowStepOption[] = [];
    for (const sec of cfg.sections || []) {
      for (const row of sec.rows || []) {
        res.push({
          id: row.reply_id,
          title: row.title,
          description: row.description,
          next_node_key: row.next_node_key,
        });
      }
    }
    return res;
  }

  // Also check if text / caption has numbered options like "1 - Face\n2 - Body\n3 - Breasts"
  const prompt = extractStepPrompt(node);
  if (prompt) {
    const textOptions = extractOptionsFromPromptText(prompt);
    if (textOptions.length > 0) {
      return textOptions;
    }
  }

  return [];
}

/**
 * Extracts numbered list options formatted as text in message bodies or captions.
 * e.g. "1 - Face\n2 - Body\n3 - Breasts"
 */
export function extractOptionsFromPromptText(prompt: string): FlowStepOption[] {
  if (!prompt) return [];
  const lines = prompt.split("\n");
  const options: FlowStepOption[] = [];
  const lineRegex = /^(?:option\s+|step\s+[0-9]+\s*-\s*)?([0-9]+)[\s\.\-\)\:]+(.+)$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(lineRegex);
    if (match) {
      const num = match[1];
      const title = match[2].trim();
      // Skip if the title is very long (like a whole paragraph) or looks like a prompt question
      if (
        title.length > 0 &&
        title.length < 50 &&
        !title.toLowerCase().startsWith("are you looking") &&
        !title.toLowerCase().startsWith("pick a time")
      ) {
        options.push({
          id: num,
          title: `${num} - ${title}`,
          next_node_key: "",
        });
      }
    }
  }
  return options;
}

/**
 * Extracts the user-visible question or prompt from a node.
 */
export function extractStepPrompt(node: FlowNodeRow): string {
  const cfg = node.config as Record<string, unknown>;
  if (typeof cfg.text === "string" && cfg.text.trim()) {
    return cfg.text.trim();
  }
  if (typeof cfg.prompt_text === "string" && cfg.prompt_text.trim()) {
    return cfg.prompt_text.trim();
  }
  if (typeof cfg.caption === "string" && cfg.caption.trim()) {
    return cfg.caption.trim();
  }
  return "";
}

/**
 * Fast literal matching without an LLM call:
 * Checks numbers ("1", "2"), option titles ("Body"), and IDs.
 */
export function matchLiteralOption(
  text: string,
  options: FlowStepOption[],
): FlowStepOption | null {
  if (!text || options.length === 0) return null;
  const clean = text.trim().toLowerCase();
  if (!clean) return null;

  // 1. Direct number check: "1", "1.", "1)", "#1", "option 1"
  const numMatch = clean.match(/^(?:option\s+|#)?([1-9]\d*)(?:[\.\)\:\-\s]|$)/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx];
    }
  }

  // 2. Word ordinal check: "first", "second", "third"
  const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const ordIdx = ordinals.indexOf(clean);
  if (ordIdx >= 0 && ordIdx < options.length) {
    return options[ordIdx];
  }

  // 3. Exact match against reply_id or title
  for (const opt of options) {
    const optId = opt.id.toLowerCase();
    const optTitle = opt.title.toLowerCase();
    if (clean === optId || clean === optTitle) {
      return opt;
    }
  }

  // 4. Normalized phrase / substring match
  // e.g. customer typed "body" and option is "3. Body" or "Body Area"
  for (const opt of options) {
    const strippedTitle = opt.title
      .toLowerCase()
      .replace(/^[0-9]+[\s\.\-\)]+/, "")
      .trim();
    if (strippedTitle) {
      if (clean === strippedTitle) return opt;
      if (strippedTitle.length >= 3 && clean.includes(strippedTitle)) return opt;
      if (clean.length >= 3 && strippedTitle.includes(clean)) return opt;
    }
  }

  return null;
}

/**
 * Evaluates customer text semantically using AI:
 * Checks if the text answers the step (maps to an option or input)
 * or if the customer is asking an inquiry question.
 */
export async function evaluateSemanticStepMatch(
  args: SemanticMatchArgs,
): Promise<SemanticMatchResult> {
  const { aiConfig, stepPrompt, options, customerReply } = args;

  if (!customerReply.trim() || !aiConfig.apiKey) {
    return {
      is_relevant_answer: false,
      matched_option: null,
      is_question_or_inquiry: false,
    };
  }

  const optionsListText =
    options.length > 0
      ? options
          .map(
            (opt, i) =>
              `${i + 1}. "${opt.title}"${opt.description ? ` - ${opt.description}` : ""}`,
          )
          .join("\n")
      : "No fixed options. The step asked for open text response.";

  const systemPrompt = `You are an intelligent conversation classifier for a WhatsApp business assistant.
The business asked a question at a specific step in a workflow.
Your job is to determine whether the customer's reply is:
1) Answering the question / choosing one of the available options (even if phrased in their own words, colloquial slang, or specifying a specific procedure/service/item that belongs to an option).
   Example: If options are "1. Face or Neck", "2. Breast", "3. Body", and the customer says "Tummy tuck" or "Lipo", that answers option 3 ("Body"). If they say "Rhinoplasty" or "Nose", that answers option 1 ("Face or Neck").
2) Asking a question or inquiry (e.g. asking about prices, doctor credentials, clinic address/location, discounts, timing, financing, etc.).
3) Unrelated or gibberish.

STEP QUESTION ASKED TO CUSTOMER:
"${stepPrompt || "Choose an option"}"

AVAILABLE OPTIONS:
${optionsListText}

Respond ONLY with a JSON object in this exact format:
{
  "is_relevant_answer": boolean,
  "matched_option_index": number | null,
  "inferred_value": string | null,
  "is_question_or_inquiry": boolean,
  "reason": string
}
Rules:
- matched_option_index MUST be 0-based (0 for option 1, 1 for option 2, 2 for option 3, etc.) or null if no option matches.
- If customer is asking a question (even if it mentions a treatment, like "How much does a tummy tuck cost?"), set is_relevant_answer: false and is_question_or_inquiry: true.
- If customer is simply stating what they want (e.g. "Tummy tuck", "I want teeth whitening", "Option 2"), set is_relevant_answer: true, match the option index, and is_question_or_inquiry: false.`;

  try {
    const { text } = await generateReply({
      config: aiConfig,
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Customer reply: "${customerReply.trim()}"`,
        },
      ],
    });

    const parsed = parseJsonClassification(text);
    if (!parsed) {
      return {
        is_relevant_answer: false,
        matched_option: null,
        is_question_or_inquiry: true,
      };
    }

    let matchedOption: FlowStepOption | null = null;
    if (
      parsed.is_relevant_answer &&
      typeof parsed.matched_option_index === "number" &&
      parsed.matched_option_index >= 0 &&
      parsed.matched_option_index < options.length
    ) {
      matchedOption = options[parsed.matched_option_index];
    }

    return {
      is_relevant_answer: Boolean(parsed.is_relevant_answer && (matchedOption || options.length === 0)),
      matched_option: matchedOption,
      inferred_value: parsed.inferred_value || (matchedOption ? matchedOption.title : customerReply.trim()),
      is_question_or_inquiry: Boolean(parsed.is_question_or_inquiry),
      reason: parsed.reason,
    };
  } catch (err) {
    console.error("[flows] semantic step match failed:", err);
    return {
      is_relevant_answer: false,
      matched_option: null,
      is_question_or_inquiry: true,
    };
  }
}

export interface SemanticConditionArgs {
  aiConfig: AiConfig;
  subjectKey: string;
  subjectValue: string;
  targetValue: string;
}

/**
 * Checks whether customer value (e.g. "Tummy tuck") semantically matches
 * a target condition value (e.g. "2 - Body" or "Body") via LLM.
 */
export async function evaluateSemanticCondition(
  args: SemanticConditionArgs,
): Promise<boolean> {
  const { aiConfig, subjectKey, subjectValue, targetValue } = args;
  if (!subjectValue.trim() || !targetValue.trim() || !aiConfig.apiKey) {
    return false;
  }

  const systemPrompt = `You are an intelligent condition evaluator for a workflow automation.
A workflow condition is checking if the variable "${subjectKey}" matches the target value "${targetValue}".
The customer provided: "${subjectValue}".

Does the customer's value ("${subjectValue}") semantically correspond to, belong to, or match "${targetValue}"?
Examples:
- Value "Tummy tuck" vs Target "2 - Body" -> MATCH (Tummy tuck is a body contouring procedure).
- Value "Rhinoplasty" vs Target "1 - Face" -> MATCH (Nose surgery is on the face).
- Value "Breast reduction" vs Target "3 - Breasts" -> MATCH.
- Value "Liposuction" vs Target "2 - Body" -> MATCH.
- Value "Tummy tuck" vs Target "1 - Face" -> NO MATCH.
- Value "Dental implants" vs Target "2 - Body" -> NO MATCH.

Respond ONLY with a JSON object:
{
  "matches": boolean,
  "confidence": "high" | "medium" | "low",
  "reason": string
}`;

  try {
    const { text } = await generateReply({
      config: aiConfig,
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Test condition:\nVariable: ${subjectKey}\nCustomer Value: "${subjectValue}"\nTarget Value: "${targetValue}"`,
        },
      ],
    });

    const parsed = parseJsonClassification(text) as { matches?: boolean } | null;
    return Boolean(parsed?.matches);
  } catch (err) {
    console.error("[flows] evaluateSemanticCondition failed:", err);
    return false;
  }
}

function parseJsonClassification(raw: string): {
  is_relevant_answer?: boolean;
  matched_option_index?: number | null;
  inferred_value?: string | null;
  is_question_or_inquiry?: boolean;
  matches?: boolean;
  reason?: string;
} | null {
  try {
    // Strip markdown code fences if present
    const clean = raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();

    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

