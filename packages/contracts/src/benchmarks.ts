import type { ModelTurnResult, ModelUsage } from "../../model-client/src/contracts.js";
import type { OutputLimitCut } from "../../model-client/src/output-limit.js";
import type { EvidenceClass, JsonPrimitive } from "./index.js";
import type { CauseUnits } from "./failure.js";

type BenchmarkRequestRole = "builder" | "grader" | "preparation" | "other";

export function benchmarkRequestRole(stage: string): BenchmarkRequestRole {
  const kind = stage.split(":")[0];
  if (kind === "builder" || kind === "repair") return "builder";
  if (kind === "judgment" || kind === "grading" || kind === "assessment") return "grader";
  if (
    [
      "prepare_public",
      "prepare_private_plan",
      "prepare_private_criteria",
      "preparation",
      "controls",
      "control",
      "control_build",
      "control_judgment",
    ].includes(kind ?? "") ||
    kind === "control-judge" ||
    kind?.startsWith("control_")
  )
    return "preparation";
  return "other";
}

/** Verified retained request data, never a quote or a guessed missing counter. */
export interface BenchmarkRequestTelemetry {
  operationId: string;
  requestId: string;
  stage: string;
  role: BenchmarkRequestRole;
  dispatched: boolean | null;
  /** The content hash of the saved response file, as Basalt read it. */
  receiptHash: string | null;
  status: "pending" | "billed";
  billedUsd: number | null;
  reservedUsd: number;
  usage: ModelUsage | null;
  /**
   * The images of the request, in request order. With `usage.inputTokens` they let a check
   * without model calls compare billed prompt tokens for the same images on other endpoints.
   */
  imageInputs: Array<{ hash: string; width: number; height: number }> | null;
  latencyMs: number | null;
  resultKind: "assistant" | "invalid_model_response" | "provider_error" | null;
  /** Why the response stopped, as the transport saved it. Null without an assistant response. */
  stopReason: Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"] | null;
  /** How the output limit cut the response. Null when the limit did not stop it. */
  cut: OutputLimitCut | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  servingProvider: string | null;
  issue: string | null;
}

export interface BenchmarkCounter {
  /** Known subtotal; null when no contributing request supplied this field. */
  knownTotal: number | null;
  knownRequests: number;
  eligibleRequests: number;
}

export interface BenchmarkDistribution {
  count: number;
  eligible: number;
  minimum: number | null;
  median: number | null;
  maximum: number | null;
}

export interface BenchmarkRoleTelemetry {
  role: BenchmarkRequestRole;
  requests: {
    retained: number;
    dispatched: number;
    dispatchUnknown: number;
    notDispatched: number;
  };
  charges: {
    knownUsd: number | null;
    settledRequests: number;
    retainedRequests: number;
    activeReservedUsd: number;
  };
  tokens: Record<Exclude<keyof ModelUsage, "costUsd">, BenchmarkCounter>;
  modelTurnElapsedMs: BenchmarkDistribution;
  knownFailedRequests: number;
  telemetryIssues: number;
}

export interface BenchmarkTelemetry {
  roles: BenchmarkRoleTelemetry[];
  knownChargeUsd: number | null;
  activeReservedUsd: number;
}

export interface BenchmarkCaseAttempts {
  evaluationId: string;
  /** The build disposition rule that decided this case; null when its required criteria are unknown. */
  successRuleHash: string | null;
  /** A build of a stage that the run did not reach is `not_reached`. It counts apart. */
  attempts: Array<{
    subjectId: string;
    outcome: "succeeded" | "failed" | "unknown" | "not_reached";
  }>;
}

export interface BenchmarkSuccessBounds {
  cases: number;
  casesWithRule: number;
  plannedAttempts: number;
  knownSuccesses: number;
  knownFailures: number;
  unknown: number;
  /** Builds of stages that the run did not reach. The bounds leave them out. */
  notReached: number;
  /** Full-plan missing-outcome bounds, not confidence intervals or prediction guarantees. */
  macroAttemptSuccess: { lower: number; upper: number } | null;
  allAttemptsSuccess: { lower: number; upper: number } | null;
}

/** One Studio session: a builder development run or a final capture. */
export interface BenchmarkStudioSession {
  stage: "builder" | "final_capture";
  unitId: string;
  activeMs: number | null;
  queueMs: number | null;
}

export interface BenchmarkStudioTime {
  builderSessions: number;
  builderActiveMs: number | null;
  builderQueueMs: number | null;
  captureSessions: number;
  captureActiveMs: number | null;
  captureQueueMs: number | null;
}

export interface BenchmarkStageTiming {
  stage: "builder" | "final_capture" | "judgment" | "grading";
  elapsedMs: BenchmarkDistribution;
  terminalUnits: number;
  failedUnits: number;
  censoredUnits: number;
  missingBoundaries: number;
}

export interface BenchmarkOutcomeCounts {
  planned: number;
  met: number;
  rejected: number;
  scored: number;
  insufficient: number;
  missing: number;
  /** Judge samples that disagree. A split answer is neither met nor not met. */
  split: number;
}

/**
 * One saved answer. The saved records give one answer for each code check and each judge
 * sample. The projection combines the samples of a sample group into one answer, with the sample
 * group as its cell.
 */
export interface BenchmarkCriterionOutcome {
  /** The grading cell of a code check, the batch of a judge sample, or a sample group. */
  cellId: string;
  criterionId: string;
  method: "deterministic" | "model";
  /** Only a combined answer is split. */
  outcome: "met" | "rejected" | "split" | "scored" | "insufficient";
  score: number | null;
  /** The planned judge samples of a combined answer and the samples that say met. */
  samples: { met: number; of: number } | null;
  /** The Studio values that a code check read. Null for a judge check. */
  observed: JsonPrimitive[] | null;
}

export interface BenchmarkCriterionDefinition {
  evaluationId: string;
  criterionId: string;
  statement: string;
  required: boolean;
  /** The evidence class that the author set. Null for a code check and for a criterion without one. */
  evidenceClass: EvidenceClass | null;
  scaleHash: string | null;
  scale: string | null;
}

/**
 * The answers of one group of checks in one row. A slice is never added to the other slices,
 * so it gives no overall score and no rank.
 */
export interface BenchmarkSlice {
  answers: BenchmarkOutcomeCounts;
  /** Each evaluation with planned answers in the group, so the coverage stays per evaluation. */
  cases: Array<{ evaluationId: string; answers: BenchmarkOutcomeCounts }>;
}

export interface BenchmarkTreatmentReport {
  id: string;
  modelId: string;
  modelName: string;
  modelRevision: string;
  /** The providers of the frozen endpoint set. Each receipt names the provider that served it. */
  providers: string[];
  quantizations: string[];
  harnessId: string;
  /** The title of the frozen tool set. */
  harnessTitle: string;
  subjectIds: string[];
  plannedBuilds: number;
  captures: { planned: number; available: number };
  success: BenchmarkSuccessBounds;
  answers: BenchmarkOutcomeCounts;
  /** The code checks and the judge checks. */
  methods: { deterministic: BenchmarkSlice; model: BenchmarkSlice };
  /**
   * The judge checks of each evidence class: appearance, timing, motion, causality, then null for
   * a judge criterion without a class. An evidence class describes judge evidence, so code checks
   * stay in `methods.deterministic`.
   */
  classes: Array<BenchmarkSlice & { evidenceClass: EvidenceClass | null }>;
  scores: Array<BenchmarkCriterionDefinition & { values: number[]; planned: number }>;
  telemetry: BenchmarkTelemetry;
  timing: BenchmarkStageTiming[];
  /** Signed Studio session time and native lane queue time inside the stage clocks; null is unrecorded. */
  studio: BenchmarkStudioTime;
  /** The units of the row that did not finish, by recorded cause in the fixed precedence. */
  causes: CauseUnits[];
  /** Every case remains separate; repetitions and captures are never independent case weights. */
  cases: Array<{ evaluationId: string; builds: BenchmarkBuild[]; answers: BenchmarkOutcomeCounts }>;
  conditionsHash: string;
}

export interface BenchmarkReport {
  operationId: string;
  manifestHash: string;
  title: string;
  suiteHash: string;
  caseCount: number;
  /**
   * Public task titles in plan order; null when the authored revision could not be read. Each
   * stage of a staged evaluation is its own evaluation, in stage order. `firstEvaluationId` is
   * the evaluation that the library knows: the revision of stage 1.
   */
  evaluations: Array<{
    evaluationId: string;
    title: string | null;
    stage: { index: number; count: number; firstEvaluationId: string };
  }>;
  /** The criteria of each evaluation in authored order. */
  criteria: BenchmarkCriterionDefinition[];
  plannedBuilds: number;
  plannedCaptures: number;
  finished: boolean;
  stopped: boolean;
  /** The units in flight now, in start order. Several units can run at the same time. */
  activeUnits: Array<{ stage: string; unitId: string }>;
  campaignWallMs: number | null;
  queueWaitMs: number | null;
  requiredHumanJudgments: 0;
  source: "retained_operation_journal_and_bound_receipts";
  conditions: Record<string, unknown>;
  rows: BenchmarkTreatmentReport[];
  telemetry: BenchmarkTelemetry;
  /** Shared preparation and unmatched accounting are included once, with no implicit per-model allocation. */
  sharedTelemetry: BenchmarkTelemetry;
  issues: string[];
  /** Signs that a private check may not tell builds apart. A warning never changes an answer. */
  planWarnings: BenchmarkPlanWarning[];
}

/**
 * The kinds of a plan warning. The first three kinds read the answers of the generated builds,
 * and need at least the minimum number of builds without an insufficient or missing answer.
 *
 * - `same_observed_failure`: every build fails, and the check read the same value each time.
 * - `every_build_fails`: every build fails.
 * - `every_build_meets`: every build meets the criterion.
 * - `passes_empty_build`: a required code check passes on the empty build.
 * - `known_build_disagrees`: the answer for a known build differs from its expected answer.
 */
export const PLAN_WARNING_KINDS = [
  "same_observed_failure",
  "every_build_fails",
  "every_build_meets",
  "passes_empty_build",
  "known_build_disagrees",
] as const;
export type PlanWarningKind = (typeof PLAN_WARNING_KINDS)[number];

export interface BenchmarkPlanWarning {
  evaluationId: string;
  criterionId: string;
  kind: PlanWarningKind;
  /** The generated builds that the warning reads. Zero for the empty build and known builds. */
  builds: number;
  /** The value that every failure read, or the value of the empty build. Null otherwise. */
  observed: JsonPrimitive[] | null;
  /** The known builds whose answers differ from their expected answers. */
  knownBuildIds: string[];
}

export interface BenchmarkCatalogEntry {
  id: string;
  title: string;
  state: string;
  at: string;
  frozen: boolean;
  models: string[];
  cases: number;
  harnesses: string[];
}
export interface ConsoleNotification {
  id: string;
  title: string;
  detail: string;
  href: string;
  kind: "interruption" | "billing";
  /** The time of the last recorded change of the run that has the problem. */
  at: string;
}

/** One planned answer of a build: one criterion in one observation. */
export interface BenchmarkMark {
  subjectId: string;
  /** The observation number in the build. */
  pass: number;
  criterionId: string;
  /** The grading method of the planned check: a code check or a judge check. */
  method: BenchmarkCriterionOutcome["method"];
  /** The evidence cell: `${batchId}:${criterionId}` for a judge check, the grading cell ID for a code check. */
  evidenceCellId: string;
  /** A planned answer without a saved record is missing. It is not a failure. */
  outcome: BenchmarkCriterionOutcome["outcome"] | "missing";
  score: number | null;
  /** The combined judge samples of a judge check. Null for a code check. */
  samples: BenchmarkCriterionOutcome["samples"];
  observed: BenchmarkCriterionOutcome["observed"];
}

/**
 * The charges and times of one build. Null is an unrecorded part. The parts can overlap, so
 * they have no total.
 */
export interface BenchmarkBuildBreakdown {
  charge: { builderUsd: number | null; judgeUsd: number | null; pendingUsd: number };
  time: {
    /** The active time of the build stage. Paused intervals do not count. */
    buildMs: number | null;
    builderTurnsMs: number | null;
    builderStudioWaitMs: number | null;
    builderStudioMs: number | null;
    observationStudioWaitMs: number | null;
    observationStudioMs: number | null;
    judgeMs: number | null;
  };
}

export interface BenchmarkBuild {
  subjectId: string;
  /** The position of the build in the run plan, the same number as "Build n" in the evidence. */
  number: number;
  /** One mark for each planned answer, in observation order. */
  marks: BenchmarkMark[];
  breakdown: BenchmarkBuildBreakdown;
  /** The build of the stage before that this build continues, or null. */
  parentSubjectId: string | null;
  /** The run did not reach the stage of this build, so the build never started. */
  notReached: boolean;
}
