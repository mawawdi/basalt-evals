import type { ModelTurnResult } from "./contracts.js";

/**
 * The two kinds of a response that the output limit stopped. No provider guarantees a split
 * between reasoning and answer tokens, so either kind can occur at any output limit.
 */
export type OutputLimitCut = "reasoning_exhausted" | "answer_truncated";

/**
 * Classify a response that the output limit stopped; null for every other response. A response
 * with no text and no tool call used the whole limit before it started an answer.
 */
export function outputLimitCut(response: ModelTurnResult): OutputLimitCut | null {
  if (response.kind !== "assistant" || response.stopReason !== "max_tokens") return null;
  return response.message.content.trim() || response.message.toolCalls.length
    ? "answer_truncated"
    : "reasoning_exhausted";
}
