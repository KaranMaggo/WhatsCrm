import { describe, it, expect, vi } from "vitest";
import {
  extractStepOptions,
  extractStepPrompt,
  matchLiteralOption,
  evaluateSemanticStepMatch,
  type FlowStepOption,
} from "./semantic-match";
import type { FlowNodeRow } from "./types";
import type { AiConfig } from "@/lib/ai/types";
import * as generateModule from "@/lib/ai/generate";

describe("semantic-match", () => {
  const dummyButtonsNode: FlowNodeRow = {
    id: "n1",
    flow_id: "f1",
    node_key: "send_buttons_5",
    node_type: "send_buttons",
    config: {
      text: "Which area would you like our surgeon to assess?",
      buttons: [
        { reply_id: "yes", title: "Face or Neck", next_node_key: "node_face" },
        { reply_id: "btn_2", title: "Breast", next_node_key: "node_breast" },
        { reply_id: "btn_3", title: "Body", next_node_key: "node_body" },
      ],
    },
    ui_position_x: 0,
    ui_position_y: 0,
    created_at: "",
    updated_at: "",
  };

  const sampleOptions: FlowStepOption[] = [
    { id: "yes", title: "Face or Neck", next_node_key: "node_face" },
    { id: "btn_2", title: "Breast", next_node_key: "node_breast" },
    { id: "btn_3", title: "Body", next_node_key: "node_body" },
  ];

  it("extracts options from send_buttons node", () => {
    const options = extractStepOptions(dummyButtonsNode);
    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({
      id: "yes",
      title: "Face or Neck",
      next_node_key: "node_face",
    });
    expect(options[2].title).toBe("Body");
    expect(options[2].next_node_key).toBe("node_body");
  });

  it("extracts prompt text from send_buttons node", () => {
    expect(extractStepPrompt(dummyButtonsNode)).toBe(
      "Which area would you like our surgeon to assess?",
    );
  });

  describe("matchLiteralOption", () => {
    it("matches numbers 1, 2, 3", () => {
      expect(matchLiteralOption("1", sampleOptions)?.id).toBe("yes");
      expect(matchLiteralOption("2", sampleOptions)?.id).toBe("btn_2");
      expect(matchLiteralOption("3", sampleOptions)?.id).toBe("btn_3");
      expect(matchLiteralOption("#2", sampleOptions)?.id).toBe("btn_2");
      expect(matchLiteralOption("Option 3", sampleOptions)?.id).toBe("btn_3");
    });

    it("matches ordinals first, second, third", () => {
      expect(matchLiteralOption("first", sampleOptions)?.id).toBe("yes");
      expect(matchLiteralOption("second", sampleOptions)?.id).toBe("btn_2");
      expect(matchLiteralOption("third", sampleOptions)?.id).toBe("btn_3");
    });

    it("matches exact or substring title", () => {
      expect(matchLiteralOption("body", sampleOptions)?.id).toBe("btn_3");
      expect(matchLiteralOption("Face", sampleOptions)?.id).toBe("yes");
      expect(matchLiteralOption("breast", sampleOptions)?.id).toBe("btn_2");
    });

    it("matches reply_id", () => {
      expect(matchLiteralOption("yes", sampleOptions)?.next_node_key).toBe("node_face");
      expect(matchLiteralOption("btn_3", sampleOptions)?.next_node_key).toBe("node_body");
    });

    it("returns null for non-literal text like procedure names or questions", () => {
      expect(matchLiteralOption("Tummy tuck", sampleOptions)).toBeNull();
      expect(matchLiteralOption("Rhinoplasty", sampleOptions)).toBeNull();
      expect(matchLiteralOption("How much does it cost?", sampleOptions)).toBeNull();
    });
  });

  describe("evaluateSemanticStepMatch", () => {
    const dummyAiConfig: AiConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseUrl: null,
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: true,
      autoReplyMaxPerConversation: 10,
      handoffAgentId: null,
      embeddingsApiKey: null,
    };

    it("interprets 'Tummy tuck' as matching 'Body' (Option 3)", async () => {
      vi.spyOn(generateModule, "generateReply").mockResolvedValueOnce({
        text: JSON.stringify({
          is_relevant_answer: true,
          matched_option_index: 2,
          inferred_value: "Body (Tummy tuck)",
          is_question_or_inquiry: false,
          reason: "Tummy tuck is a body contouring procedure corresponding to option 3 Body",
        }),
        handoff: false,
        usage: null,
      });

      const result = await evaluateSemanticStepMatch({
        aiConfig: dummyAiConfig,
        stepPrompt: "Which area would you like our surgeon to assess?",
        options: sampleOptions,
        customerReply: "Tummy tuck",
      });

      expect(result.is_relevant_answer).toBe(true);
      expect(result.matched_option?.title).toBe("Body");
      expect(result.matched_option?.next_node_key).toBe("node_body");
      expect(result.inferred_value).toBe("Body (Tummy tuck)");
      expect(result.is_question_or_inquiry).toBe(false);
    });

    it("identifies inquiry questions like 'How much does it cost?' as non-answers", async () => {
      vi.spyOn(generateModule, "generateReply").mockResolvedValueOnce({
        text: JSON.stringify({
          is_relevant_answer: false,
          matched_option_index: null,
          inferred_value: null,
          is_question_or_inquiry: true,
          reason: "Customer is asking about treatment pricing rather than selecting an area.",
        }),
        handoff: false,
        usage: null,
      });

      const result = await evaluateSemanticStepMatch({
        aiConfig: dummyAiConfig,
        stepPrompt: "Which area would you like our surgeon to assess?",
        options: sampleOptions,
        customerReply: "How much does it cost in total?",
      });

      expect(result.is_relevant_answer).toBe(false);
      expect(result.matched_option).toBeNull();
      expect(result.is_question_or_inquiry).toBe(true);
    });
  });
});
