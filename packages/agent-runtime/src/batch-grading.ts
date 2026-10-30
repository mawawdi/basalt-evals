import { hashJson } from "../../contracts/src/index.js";
import {
  assertBatchJudgmentInput,
  batchJudgmentRequest,
  judgedCriteria,
  observationRequest,
  parseBatchJudgment,
  parseObservation,
  type BatchCriterion,
  type BatchFrameContext,
  type BatchRequestConfiguration,
  type GroundedObservation,
  type JudgmentPresentation,
} from "../../eval-authoring/src/batch-judgment.js";
import {
  BoundedModelClient,
  type RateLimitPause,
  type RequestCheck,
  type RequestPermit,
} from "../../model-client/src/bounded-client.js";
import { completeWithinRetries } from "./retries.js";
import type { DurableSpendLedger } from "../../model-client/src/ledger.js";
import {
  validateModelImages,
  type ModelClient,
  type ModelImage,
  type ModelTurnResult,
} from "../../model-client/src/contracts.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import type { CriterionMaterial } from "../../eval-authoring/src/criterion-material.js";

/** One or two calls, each replayable only from its retained response and shared reservation. */
export async function runJudgmentBatch(input: {
  client: ModelClient;
  ledger: DurableSpendLedger;
  snapshot: ModelSnapshot;
  stage: string;
  configuration: BatchRequestConfiguration;
  presentation: JudgmentPresentation;
  publicTask: string;
  criteria: BatchCriterion[];
  context: BatchFrameContext;
  images: ModelImage[];
  criterionEvidence: CriterionMaterial[];
  beforeRequest?: RequestCheck;
  /** The ordinals of saved failures that paused the batch before a person resumed the run. */
  acknowledged?: number[];
  /** The permit of the judge model for each new request. */
  permit?: RequestPermit;
  signal?: AbortSignal;
  replayOnly?: boolean;
  /** The wait before a retry of a rate limit. Tests replace it so that they do not wait. */
  rateLimitPause?: RateLimitPause;
}) {
  if (
    input.configuration.modelId !== input.snapshot.id ||
    !input.criterionEvidence.length ||
    input.images.length !== input.context.intervals.length
  )
    throw new Error("Judgment requires its exact model and complete frame presentation");
  if (input.images.length) validateModelImages(input.images);
  // Validate the complete judgment input before even the rubric-free observation call.
  assertBatchJudgmentInput({ ...input, observation: null });
  const decisionAuthorities = Object.fromEntries(
    input.criterionEvidence.map((material) => [
      material.criterionId,
      material.unavailable.length ? ("deterministic" as const) : ("model" as const),
    ]),
  );
  // The pre-call gate: a criterion with an unavailable reason never reaches a model.
  const judged = judgedCriteria(input.criteria, input.criterionEvidence);
  if (!judged.length) {
    return {
      decisionAuthorities,
      decisions: input.criteria.map((criterion) => ({
        criterionId: criterion.id,
        verdict: "insufficient" as const,
        answer: "insufficient" as const,
        score: null,
        confidence: 0,
        rationale: input.criterionEvidence
          .find((item) => item.criterionId === criterion.id)!
          .unavailable.join("; "),
      })),
      observation: null,
      // No model read the build output, so no report exists.
      addressedToEvaluator: null,
      responses: [] as ModelTurnResult[],
      responseHashes: [] as string[],
    };
  }
  const client = new BoundedModelClient(
    input.client,
    input.ledger,
    [input.snapshot],
    input.stage,
    input.replayOnly ?? false,
    input.beforeRequest,
    0,
    input.acknowledged ?? [],
    input.permit,
  );
  if (input.rateLimitPause) client.pause = input.rateLimitPause;
  const complete = <T>(
    request: Parameters<BoundedModelClient["complete"]>[0],
    parse: (response: ModelTurnResult) => T,
  ) => completeWithinRetries(client, request, parse, input.signal);
  let observation: GroundedObservation | null = null;
  const responses: ModelTurnResult[] = [];
  if (input.presentation === "grounded-sequence" && input.images.length) {
    const observed = await complete(
      observationRequest(input.configuration, input.context, input.images),
      (response) => parseObservation(response, input.context),
    );
    responses.push(observed.response);
    observation = observed.value;
  }
  const result = await complete(
    batchJudgmentRequest({ ...input, images: observation ? [] : input.images, observation }),
    (response) => parseBatchJudgment(response, judged),
  );
  responses.push(result.response);
  const decisions = input.criteria.map((criterion) => {
    const material = input.criterionEvidence.find((item) => item.criterionId === criterion.id)!;
    return material.unavailable.length
      ? {
          criterionId: criterion.id,
          verdict: "insufficient" as const,
          answer: "insufficient" as const,
          score: null,
          confidence: 0,
          rationale: material.unavailable.join("; "),
        }
      : result.value.decisions.find((decision) => decision.criterionId === criterion.id)!;
  });
  return {
    decisions,
    decisionAuthorities,
    observation,
    addressedToEvaluator: result.value.addressedToEvaluator,
    responses,
    responseHashes: responses.map(hashJson),
  };
}
