import type { HarnessDefinition } from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";
// Import transport-neutral contracts directly; the package barrel would load the provider SDK.
import type {
  ModelMessage,
  ModelToolDefinition,
  ModelTurnRequest,
  ModelTurnResult,
} from "../../model-client/src/contracts.js";

/** The largest summary that replaces a conversation. */
const MAX_SUMMARY_BYTES = 64 * 1024;

// The compaction text is part of each summary request hash. A change makes the stored summary
// requests of each paid build unverifiable.
export const COMPACTION_SYSTEM_PROMPT =
  "You summarize the work of a Roblox builder agent so that the agent can continue with less context. Keep each fact that the agent needs: the task requirements in its own words, the files it changed and why, the current hash of each changed file, the results of verification and development tests, and the problems that remain. Do not invent results. Do not write code that the agent did not write.";

export const COMPACTION_INSTRUCTION =
  "The conversation above is too long. Call context.summary one time with a complete summary of the work so far. The conversation will restart from the original task, your summary and the current workspace.list result.";

/** The transport needs one tool. The answer tool takes the summary; no builder tool is offered. */
export const COMPACTION_TOOL: ModelToolDefinition = {
  name: "context.summary",
  description: "Submit the summary of the work so far.",
  parameters: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
};

/** The summary request of a conversation. It has the reasoning of the builder requests. */
export function compactionRequest(input: {
  model: string;
  seed: number;
  messages: ModelMessage[];
  reasoning: Pick<ModelTurnRequest, "reasoning">;
}): Omit<ModelTurnRequest, "maxOutputTokens"> {
  return {
    model: input.model,
    seed: input.seed,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [...input.messages, { role: "user", content: COMPACTION_INSTRUCTION }],
    tools: [structuredClone(COMPACTION_TOOL)],
    ...input.reasoning,
  };
}

/**
 * The summary of an assistant answer: the argument of its one `context.summary` call, or its
 * text when it called no tool. Any other answer gives no summary.
 */
export function compactionSummary(
  result: Extract<ModelTurnResult, { kind: "assistant" }>,
): string | null {
  const calls = result.message.toolCalls;
  const summary =
    calls.length === 0
      ? result.message.content
      : calls.length === 1 &&
          calls[0]!.name === COMPACTION_TOOL.name &&
          isRecord(calls[0]!.arguments) &&
          typeof calls[0]!.arguments.summary === "string"
        ? calls[0]!.arguments.summary
        : null;
  return summary?.trim() && Buffer.byteLength(summary, "utf8") <= MAX_SUMMARY_BYTES
    ? summary
    : null;
}

/** The conversation after a compaction: the seed prompt, the summary and the current workspace. */
export function compactedConversation(input: {
  seed: ModelMessage;
  summary: string;
  compaction: number;
  harness: Pick<HarnessDefinition, "compaction">;
  /** The bounded result of a workspace.list call, as the model gets it. */
  workspace: string;
}): ModelMessage[] {
  const limit =
    input.harness.compaction.kind === "summarize_at" ? input.harness.compaction.maxSummaries : 0;
  return [
    structuredClone(input.seed),
    {
      role: "user",
      content: [
        `Context summary ${input.compaction} of at most ${limit}. The earlier conversation was replaced by this summary:`,
        input.summary,
        "",
        `Current workspace.list result: ${input.workspace}`,
      ].join("\n"),
    },
  ];
}
