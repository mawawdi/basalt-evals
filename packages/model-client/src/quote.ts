import { hashJson } from "../../contracts/src/index.js";
import { maximumUsageCost, type ModelSnapshot } from "./catalog.js";
import { modelLimits } from "./model-limits.js";
import type { ModelRequestReasoning, ModelSampling } from "./contracts.js";
import { assertRequestReasoning } from "./reasoning.js";
import { assertRequestSampling } from "./sampling.js";

type WorkStage =
  | "preparation"
  | "coverage"
  | "explanation"
  | "controls"
  | "builder"
  | "public_development"
  | "final_capture"
  | "grading"
  | "repair";

export interface QuotedModelWork {
  stage: WorkStage;
  modelId: string;
  calls: number;
  reasoning?: ModelRequestReasoning;
  sampling?: ModelSampling;
  expected: {
    inputTokens: number;
    outputTokens: number;
    images: number;
    imageInputTokens: number;
  } | null;
  upper: { inputTokens: number; outputTokens: number; images: number; imageInputTokens: number };
}

export interface RunWorkload {
  independentBuilderTrials: number;
  nativeCaptureRepetitions: number;
  capturePasses: number;
  nativeRootLaunches: number;
  nativeClientLaunches: number;
  startupRecoveryRootLaunches: number;
  startupRecoveryClientLaunches: number;
  criterionOutcomes: number;
  judgmentBatches: number;
  modelWork: QuotedModelWork[];
}

export interface RunQuote {
  schema: "basalt-evals/run-quote";
  id: string;
  subjectId: string | null;
  capturedAt: string;
  workload: RunWorkload;
  models: ModelSnapshot[];
  priorCommittedUsd: number;
  priorAuthorizedCeilingUsd: number;
}

/**
 * A checking request that ends in a priced answer that breaks the requested structure may be
 * followed by at most this many distinct new requests. Thus every quoted checking call carries
 * the cost of its retries. The multiplier covers only these answers. A rate limit has no
 * charge, and the bounded client tries it again in the same call.
 */
export const JUDGMENT_RETRIES = 2;

/** Exact maximum for new quoted model work, excluding already incurred preparation charges. */
export function workloadCeiling(quote: RunQuote): number {
  return quote.workload.modelWork.reduce((sum, work) => {
    const model = quote.models.find((item) => item.id === work.modelId);
    if (!model) throw new Error("Quoted work has no frozen model");
    const calls = work.stage === "grading" ? work.calls * (1 + JUDGMENT_RETRIES) : work.calls;
    return sum + calls * maximumUsageCost(model, work.upper);
  }, 0);
}

export function checkingCeiling(quote: RunQuote): number {
  return workloadCeiling({
    ...quote,
    workload: {
      ...quote.workload,
      modelWork: quote.workload.modelWork.filter(
        (work) => !["builder", "repair"].includes(work.stage),
      ),
    },
  });
}

function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(label + " must be a nonnegative integer");
}

/** A frozen workload binds request liabilities; it makes no expected-spending recommendation. */
export function createRunQuote(
  workload: RunWorkload,
  models: ModelSnapshot[],
  subjectId: string | null = null,
): RunQuote {
  for (const [label, value] of Object.entries(workload)) {
    if (label !== "modelWork") count(value as number, label);
  }
  const byId = new Map(models.map((model) => [model.id, model]));
  if (byId.size !== models.length) throw new Error("Quote model snapshots must be unique");
  for (const item of workload.modelWork) {
    count(item.calls, "Model call count");
    const model = byId.get(item.modelId as ModelSnapshot["id"]);
    if (!model) throw new Error("Workload model has no frozen catalog snapshot: " + item.modelId);
    assertRequestReasoning(item.reasoning, model);
    assertRequestSampling(item.sampling, model);
    for (const metric of ["inputTokens", "outputTokens", "images", "imageInputTokens"] as const) {
      if (item.expected) count(item.expected[metric], "Expected " + metric);
      count(item.upper[metric], "Upper " + metric);
      if (item.expected && item.expected[metric] > item.upper[metric])
        throw new Error("Expected usage exceeds the bounded workload: " + metric);
    }
    const limits = modelLimits(model);
    if (
      item.upper.inputTokens + item.upper.imageInputTokens + item.upper.outputTokens >
      limits.contextLength
    )
      throw new Error("Quoted request exceeds the context length of the selected endpoints");
    if (item.upper.outputTokens > limits.maxOutputTokens)
      throw new Error("Quoted response exceeds the output limit of the selected endpoints");
  }
  const body = {
    schema: "basalt-evals/run-quote" as const,
    subjectId,
    capturedAt: models[0]?.capturedAt ?? new Date().toISOString(),
    workload,
    models,
    priorCommittedUsd: 0,
    priorAuthorizedCeilingUsd: 0,
  };
  return { ...body, id: hashJson(body) };
}

/** A continuation quote includes billed spend and the full liability of unresolved calls. */
export function includePriorCommittedSpend(
  quote: RunQuote,
  priorCommittedUsd: number,
  priorAuthorizedCeilingUsd = 0,
): RunQuote {
  if (
    !Number.isFinite(priorCommittedUsd) ||
    priorCommittedUsd < 0 ||
    !Number.isFinite(priorAuthorizedCeilingUsd) ||
    priorAuthorizedCeilingUsd < 0
  )
    throw new Error("Prior committed spend and authorized ceiling must be nonnegative USD amounts");
  const { id: _id, ...body } = quote;
  const cumulative = {
    ...body,
    priorCommittedUsd,
    priorAuthorizedCeilingUsd,
  };
  return { ...cumulative, id: hashJson(cumulative) };
}
