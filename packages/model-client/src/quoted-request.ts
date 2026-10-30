import type { ModelTurnRequest } from "./contracts.js";
import type { ModelSnapshot } from "./catalog.js";
import type { QuotedModelWork } from "./quote.js";
import { assertImageRequestLimits } from "./image-limits.js";
import { imageTokenWork } from "./image-tokens.js";
import { promptCapacity, requestTextBound } from "./request-workload.js";
import { assertRequestReasoning } from "./reasoning.js";
import { assertRequestSampling } from "./sampling.js";

/** Quote a concrete request plus explicitly bounded material acquired later. */
export function quoteRequest(input: {
  stage: QuotedModelWork["stage"];
  snapshot: ModelSnapshot;
  request: ModelTurnRequest;
  calls: number;
  futureTextBytes: number;
  expectedFutureTextBytes: number;
  imageDimensions: Array<{ width: number | null; height: number | null }>;
}): QuotedModelWork {
  if (
    ![input.calls, input.futureTextBytes, input.expectedFutureTextBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    input.expectedFutureTextBytes > input.futureTextBytes
  )
    throw new Error("Invalid bounded future request material");
  assertRequestReasoning(input.request.reasoning, input.snapshot);
  assertRequestSampling(input.request.sampling, input.snapshot);
  // Encoded sizes are unknown before capture; dispatch admission checks them again.
  assertImageRequestLimits(
    input.snapshot,
    input.imageDimensions.map((dimensions) => ({ ...dimensions, encodedBytes: null })),
    null,
  );
  const capacity = promptCapacity(input.snapshot, input.request.maxOutputTokens);
  const base = requestTextBound(input.request);
  if (base > capacity)
    throw new Error(
      "The request text is larger than the context limit of the selected model. Select a different model.",
    );
  const imageWork = imageTokenWork(input.snapshot, input.imageDimensions, capacity - base);
  if (base + imageWork.upper > capacity)
    throw new Error(
      "The request text and images are larger than the context limit of the selected model. Select a different model.",
    );
  const inputTokens = Math.min(base + input.futureTextBytes, capacity - imageWork.upper);
  return {
    stage: input.stage,
    modelId: input.snapshot.id,
    calls: input.calls,
    ...(input.request.reasoning ? { reasoning: input.request.reasoning } : {}),
    ...(input.request.sampling ? { sampling: input.request.sampling } : {}),
    expected:
      imageWork.expected === null
        ? null
        : {
            inputTokens: Math.min(
              inputTokens,
              Math.ceil((base + input.expectedFutureTextBytes) / 3),
            ),
            outputTokens: Math.min(2048, input.request.maxOutputTokens),
            images: input.imageDimensions.length,
            imageInputTokens: imageWork.expected,
          },
    upper: {
      inputTokens,
      outputTokens: input.request.maxOutputTokens,
      images: input.imageDimensions.length,
      imageInputTokens: imageWork.upper,
    },
  };
}
