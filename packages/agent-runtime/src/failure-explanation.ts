import type { ModelTurnResult } from "../../model-client/src/contracts.js";
import {
  FAILURE_HYPOTHESES_TOOL,
  failureExplanationRequest,
  failureHypotheses,
  incompleteHypotheses,
  type FailureExplanationInput,
  type FailureHypothesis,
} from "../../eval-authoring/src/failure-explanation-request.js";
import type { PreparationDispatcher } from "./preparation-models.js";

/** The stage of the one request. It has its own ledger entry and receipts. */
const EXPLANATION_STAGE = "explanation";

/** The answers of one request. Complete only when each answer is complete. */
interface FailureExplanationResult {
  state: "complete" | "incomplete";
  requestHash: string | null;
  hypotheses: FailureHypothesis[];
  reason: string | null;
}

function unreadable(result: ModelTurnResult): string | null {
  if (result.kind !== "assistant") return `The model request failed: ${result.errorClass}.`;
  if (result.stopReason === "max_tokens")
    return "The model reached its output limit before it completed the hypotheses.";
  const calls = result.message.toolCalls;
  return calls.length === 1 && calls[0]!.name === FAILURE_HYPOTHESES_TOOL
    ? null
    : `The model did not submit exactly one ${FAILURE_HYPOTHESES_TOOL} call.`;
}

/**
 * A second model answers the fixed questions about each flagged criterion in one request. The
 * answers are hypotheses for a person. A dispatch error stops the explanation, so the person can
 * resume it. A response that Basalt cannot read gives incomplete answers, and Basalt does not
 * send the request again.
 */
export async function explainFailures(input: {
  dispatcher: PreparationDispatcher;
  model: { id: string; maxOutputTokens: number };
  seed: number;
  material: FailureExplanationInput;
}): Promise<FailureExplanationResult> {
  const result = await input.dispatcher.complete(
    EXPLANATION_STAGE,
    failureExplanationRequest(input.model, input.seed, input.material),
  );
  const reason = unreadable(result);
  const hypotheses =
    reason || result.kind !== "assistant"
      ? incompleteHypotheses(input.material, reason ?? "The model request failed.")
      : failureHypotheses(result.message.toolCalls[0]!.arguments, input.material);
  const incomplete = hypotheses.filter((item) => item.state === "incomplete");
  return {
    state: incomplete.length ? "incomplete" : "complete",
    requestHash: result.requestHash,
    hypotheses,
    reason:
      reason ??
      (incomplete.length
        ? `${incomplete.length} of ${hypotheses.length} answers are incomplete.`
        : null),
  };
}
