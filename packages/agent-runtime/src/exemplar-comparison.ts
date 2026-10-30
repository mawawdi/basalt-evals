import { hashJson } from "../../contracts/src/index.js";
import {
  COMPARISON_ORDERS,
  pairOutcome,
  preferenceOf,
  type BuildAnswer,
  type ComparisonOrder,
  type PairOutcome,
  type PairPreference,
} from "../../contracts/src/exemplars.js";
import type {
  BatchCriterion,
  BatchRequestConfiguration,
} from "../../eval-authoring/src/batch-judgment.js";
import {
  buildComparisonRequest,
  parseBuildComparison,
} from "../../eval-authoring/src/exemplar-comparison.js";
import type { AddressedToEvaluator } from "../../eval-authoring/src/criterion-response.js";
import { BoundedModelClient } from "../../model-client/src/bounded-client.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import {
  validateModelImages,
  type ModelClient,
  type ModelTurnResult,
} from "../../model-client/src/contracts.js";
import type { DurableSpendLedger } from "../../model-client/src/ledger.js";
import {
  alignBuildFrames,
  pairedPresentation,
  type BuildEvidence,
  type FrameAlignment,
} from "../../studio-runner/src/paired-evidence.js";
import { completeWithinRetries } from "./retries.js";

/**
 * One build against one exemplar for one appearance criterion. Code pairs the frames once.
 * Then the judge answers in both orders: first with the build under judgment as Build A,
 * then with the exemplar as Build A. Each request is replayable only from its retained
 * response and its own reservation. A consistent preference gives a win or a loss; a
 * different preference in each order gives a flip.
 */
export async function runExemplarComparison(input: {
  client: ModelClient;
  ledger: DurableSpendLedger;
  snapshot: ModelSnapshot;
  stage: string;
  configuration: BatchRequestConfiguration;
  criterion: BatchCriterion;
  publicTask: string;
  candidate: BuildEvidence;
  exemplar: BuildEvidence;
  /** The tolerance of two paired frames: the authored maximum frame gap of the view. */
  toleranceMs: number;
  beforeRequest?: () => Promise<void>;
  signal?: AbortSignal;
  replayOnly?: boolean;
}): Promise<{
  alignment: FrameAlignment;
  answers: Array<{
    order: ComparisonOrder;
    better: BuildAnswer;
    preference: PairPreference;
    rationale: string;
    addressedToEvaluator: AddressedToEvaluator;
  }>;
  outcome: PairOutcome;
  responses: ModelTurnResult[];
  responseHashes: string[];
}> {
  if (input.configuration.modelId !== input.snapshot.id)
    throw new Error("A build comparison requires its exact model");
  validateModelImages([...input.candidate.images, ...input.exemplar.images]);
  const alignment = alignBuildFrames(input.candidate, input.exemplar, input.toleranceMs);
  // Build both requests before the first call, so that a malformed order spends nothing.
  const requests = COMPARISON_ORDERS.map((order) => {
    const presented = pairedPresentation(input.candidate, input.exemplar, alignment, order);
    return {
      order,
      request: buildComparisonRequest({
        configuration: input.configuration,
        criterion: input.criterion,
        publicTask: input.publicTask,
        ...presented,
      }),
    };
  });
  const client = new BoundedModelClient(
    input.client,
    input.ledger,
    [input.snapshot],
    input.stage,
    input.replayOnly ?? false,
    input.beforeRequest,
  );
  const responses: ModelTurnResult[] = [];
  const answers = [];
  for (const { order, request } of requests) {
    const result = await completeWithinRetries(client, request, parseBuildComparison, input.signal);
    responses.push(result.response);
    answers.push({ order, ...result.value, preference: preferenceOf(result.value.better, order) });
  }
  return {
    alignment,
    answers,
    outcome: pairOutcome(answers[0]!.preference, answers[1]!.preference),
    responses,
    responseHashes: responses.map(hashJson),
  };
}
