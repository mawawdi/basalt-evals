import type { BoundedModelClient } from "../../model-client/src/bounded-client.js";
import type { ModelTurnRequest, ModelTurnResult } from "../../model-client/src/contracts.js";
import {
  classifyProviderFailure,
  type ProviderFailureScope,
} from "../../model-client/src/provider-failure.js";
import { JUDGMENT_RETRIES } from "../../model-client/src/quote.js";

/**
 * An account, model or persistent provider failure paused the stage. The failure has a known
 * charge. After a person resumes the run, the client acknowledges `ordinal` and sends the next
 * ordinal.
 */
export class ProviderPauseError extends Error {
  constructor(
    readonly scope: Exclude<ProviderFailureScope, "request">,
    readonly errorClass: string,
    readonly ordinal: number,
  ) {
    super(`The provider failure ${errorClass} paused this work. Basalt recorded its known charge.`);
    this.name = "ProviderPauseError";
  }
}

/** The model or a content policy refused the request. Basalt does not send it again. */
export class ModelRefusalError extends Error {
  constructor(readonly errorClass: string | null) {
    super(
      errorClass
        ? `The provider refused the request (${errorClass}).`
        : "The model refused the request.",
    );
    this.name = "ModelRefusalError";
  }
}

/** A finished answer; truncated, refused and failed responses are never retried blind. */
function finishedAnswer(response: ModelTurnResult) {
  return (
    response.kind === "assistant" &&
    (response.stopReason === "tool_calls" || response.stopReason === "end_turn")
  );
}

/**
 * A finished answer that breaks the requested structure keeps its receipt and charge. Each retry
 * is the next ordinal of the same client, so it is a distinct ledger request. The bounded client
 * retries a rate limit itself. Replay follows the same saved sequence and sends nothing.
 * Returns the accepted response, its parsed value and the ordinal of that response.
 */
export async function completeWithinRetries<T>(
  client: BoundedModelClient,
  request: ModelTurnRequest,
  parse: (response: ModelTurnResult) => T,
  signal?: AbortSignal,
): Promise<{ response: ModelTurnResult; value: T; ordinal: number }> {
  for (let retry = 0; ; retry++) {
    const response = await client.complete(request, signal);
    const failure = classifyProviderFailure(response);
    // A rate limit after the final try is a persistent failure, so it pauses too.
    if (failure && failure.scope !== "request")
      throw new ProviderPauseError(
        failure.scope,
        response.kind === "provider_error" ? response.errorClass : "provider_error",
        client.completedCalls,
      );
    if (
      failure?.refusal ||
      (response.kind === "assistant" &&
        response.stopReason === "refusal" &&
        response.message.toolCalls.length === 0)
    )
      throw new ModelRefusalError(response.kind === "provider_error" ? response.errorClass : null);
    try {
      return { response, value: parse(response), ordinal: client.completedCalls };
    } catch (error) {
      if (retry === JUDGMENT_RETRIES || !finishedAnswer(response)) throw error;
    }
  }
}
