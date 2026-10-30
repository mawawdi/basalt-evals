import type { EvaluationSummary } from "./catalog.js";
import type { LaunchSelection, RunOperationEvent } from "./execution.js";
import type { HarnessDefinition } from "./harness.js";

export interface LaunchCatalog {
  models: ReadonlyArray<{ id: string; name: string }>;
  /** The registered tool sets. The run setup shows their settings, and a person cannot edit them. */
  harnesses: HarnessDefinition[];
  evals: EvaluationSummary[];
}
export interface LaunchOptions {
  models: LaunchCatalog["models"];
  harnesses: LaunchCatalog["harnesses"];
  defaults: Omit<LaunchSelection, "sources">;
}
export interface LocalReadinessCheck {
  name: string;
  ready: boolean;
  help: string;
}

import type { OperationContext } from "./launch.js";
import type { AuthoringAction } from "./execution.js";
import type { ReviewTreatment } from "./review.js";

export type OperatorEvidence = {
  operationId: string;
  manifestHash: string;
  unavailableEvidence: {
    captureId: string;
    reason: "integrity_unavailable";
  }[];
  candidates: {
    id: string;
    title: string;
    /** The evaluation of the build. A sensitivity test pools builds of one evaluation. */
    evaluationId: string;
    /** The executable criteria of the revision of the build, also those that this run did not plan. */
    criterionCount: number;
    kind: "repair" | "generated" | "retained" | "control";
    builder: import("./index.js").Treatment | null;
    builderName: string;
    /** Why the build never started. Null for a build of a stage that the run reached. */
    notReached: import("./catalog.js").ResultSummary["notReached"];
    sealed: boolean;
    builderCostUsd: number | null;
    builderToolCalls: number | null;
    builderElapsedMs: number | null;
    captured: number;
    plannedCaptures: number;
    cells: {
      id: string;
      treatment: import("./review.js").ReviewTreatment | null;
      automaticDecision: {
        operationId: string;
        recordId: string;
        criterionId: string;
        artifactHash: string | null;
        configurationHash: string;
      };
      criterionId: string;
      statement: string;
      /**
       * The place of the criterion among the executable criteria of its revision, in the authored
       * order, from 1. Null when the revision does not have the criterion.
       */
      number: number | null;
      method: "deterministic" | "visual";
      /**
       * The evidence class that the rubric author set, for a judge check. Null for a code check
       * and for a criterion without a class.
       */
      evidenceClass: import("./index.js").EvidenceClass | null;
      pass: number;
      outcome: string;
      decisionAuthority: "model" | "deterministic" | null;
      /** The decision of the judge when the cell has one judge sample. */
      judgment: import("../../eval-authoring/src/batch-judgment.js").BatchDecision | null;
      /**
       * The combined answer of the judge samples, with the decision of each sample in sample
       * order. Null for a code check.
       */
      samples:
        | (import("../../experiments/src/judge-samples.js").CombinedSamples & {
            decisions: Array<
              import("../../eval-authoring/src/batch-judgment.js").BatchDecision | null
            >;
          })
        | null;
      /** Text in the build output that speaks to the judge. Null without a judge answer. */
      addressedToEvaluator:
        import("../../eval-authoring/src/criterion-response.js").AddressedToEvaluator | null;
      explanation: string | null;
      score: number | null;
      verdict: "satisfied" | "violated" | "insufficient" | null;
      criterion: import("./index.js").CriterionResult | null;
      itemId: string | null;
      passId: string | null;
      evidenceHashes: string[];
    }[];
    items: import("./review.js").EvidenceView[];
  }[];
  claims: string[];
  planned: Omit<import("../../model-client/src/quote.js").RunWorkload, "modelWork">;
};

/**
 * Two builds of one evaluation, one criterion and one observation, on one screen. Rows align
 * the images of the two builds by player, recorded phase and time, never by frame index.
 */
export interface SideBySideEvidence {
  criterion: { id: string; statement: string; method: "deterministic" | "visual" };
  pass: number;
  /** Two images pair when their offsets from the same anchor differ by this many ms or less. */
  toleranceMs: number;
  /** The observations in which either build has an answer for this criterion. */
  observations: number[];
  /** All builds of the evaluation in this run, in plan order, so either side can change. */
  builds: Array<{ candidateId: string; title: string; model: string }>;
  sides: Array<{
    /** The build of this side. `builds` gives its title and model. */
    candidateId: string;
    /** The answer of the build for this criterion and observation. */
    cell: OperatorEvidence["candidates"][number]["cells"][number] | null;
    itemId: string | null;
    passId: string | null;
    /** Why this side has no evidence, or null when it has evidence. */
    absent: string | null;
  }>;
  /** One row for a pair of images, or for an image of one build with no image of the other. */
  rows: Array<{
    player: string | null;
    /** The plan label of the phase of a snapshot, or of the recorded scenario. */
    label: string;
    phase: { kind: "transition" | "capture"; id: string } | { kind: "recording" };
    /** `roles` names why the judge saw a frame. It is empty for a frame that the judge did not see. */
    sides: Array<{ imageId: string; offsetMs: number; roles: string[] } | null>;
  }>;
}

export type ExecutionProgress = Omit<
  import("./execution.js").RunOperationStatus,
  "events" | "manifest" | "completedUnits" | "pauseRecords"
> & {
  manifest: Pick<import("./execution.js").RunOperationManifest, "id" | "planned"> & {
    protocolKind:
      NonNullable<import("./execution.js").RunOperationManifest["protocol"]>["kind"] | null;
  };
  completedStageCount: number;
  /** The authorization hash at each unit paused for spending. Only a new authorization resumes it. */
  pausedAuthorizationHashes: string[];
  /** The units that a provider failure paused. Only Resume continues them. */
  providerPauses: ProviderPauseView[];
  /**
   * The answers of the checks of the builds that the run reached. A judge check counts one
   * time, with the combined answer of its samples.
   */
  answers: import("./catalog.js").AnswerCounts;
  driver: { active: boolean; error: string | null; waiting: "review" | "studio" | null } | null;
};
/** One build or judgment that a provider failure paused, and the cause of the pause. */
export interface ProviderPauseView {
  stage: "builder" | "judgment";
  unitId: string;
  scope: import("./execution.js").ProviderPauseScope;
  errorClass: string;
}

/**
 * The console sentence for the provider pauses of a run, or null without a pause. An account
 * pause comes first, because it holds all paid work. The driver uses the same sentence.
 */
export function providerPauseSentence(
  pauses: ReadonlyArray<Pick<ProviderPauseView, "scope" | "errorClass">>,
): string | null {
  const pause =
    pauses.find((item) => item.scope === "account") ??
    pauses.find((item) => item.scope === "model") ??
    pauses[0];
  if (!pause) return null;
  const status = /_([45][0-9]{2})$/u.exec(pause.errorClass)?.[1];
  if (pause.scope === "account")
    return status === "401"
      ? "Paused: OpenRouter rejected the API key. Fix the key, then resume."
      : status === "402"
        ? "Paused: the OpenRouter account is out of credits. Add credits, then resume."
        : "Paused: OpenRouter refused requests from this account. Fix the account, then resume.";
  if (pause.scope === "model")
    return "Paused: OpenRouter can’t serve a model of this run. Check the model on OpenRouter, then resume.";
  return "Paused: the model provider kept failing after several tries. Resume when it works again.";
}

export interface SpendingProgress {
  authorizationHash: string;
  ceilingUsd: number;
  billedUsd: number;
  reservedUsd: number;
  availableUsd: number;
  pendingBilling: boolean;
  uncertainBilling: boolean;
  uncertainRequests: number;
}
export type SavedOperationProgress = (
  | {
      kind: "admission";
      operationId: string;
      state: "queued" | "incomplete" | "stopped" | "completed";
      error: string | null;
    }
  | ({ kind: "assessment" } & import("./assessments.js").AssessmentProgress)
  | ({ kind: "comparison" } & import("./assessments.js").AssessmentProgress)
  | ({ kind: "evaluation" } & ExecutionProgress)
  | ({ kind: "starting" } & import("./execution.js").RunStart)
  | ({
      kind: "authoring";
      driver: { active: boolean; error: string | null; waiting: "review" | "studio" | null } | null;
    } & import("./execution.js").AuthoringProgress &
      SpendingProgress)
) & { workflow: import("./execution.js").EvaluationWorkflow | null };
/** One unit in flight. Several units can run at the same time. */
export interface JourneyActivity {
  stage: "readiness" | "builder" | "capture" | "scoring" | "execution";
  action: string;
  startedAt: string;
  /** The recorded gameplay of one observation; null for other work. */
  observationWindowMs: number | null;
  /** The time after which a Studio step counts as stuck; null for other work. */
  limitMs: number | null;
}
export interface JourneyProgress {
  /** The earliest stage that has work left. The timeline shows the earlier stages as done. */
  stage: string;
  /** The stages that have work in flight now. */
  activeStages: string[];
  action: string;
  startedAt: string | null;
  endedAt: string | null;
  /** The units in flight, in start order. */
  activity: JourneyActivity[];
  recentFailure: { action: string; reason: string; at: string } | null;
  evaluatedModelStarted: boolean;
  preparationSkipped: boolean;
  limitBasis: string;
  completedCandidates: number;
  plannedCandidates: number;
  /** The planned builds of a later stage that the run did not reach. They never start. */
  notReachedCandidates: number;
  completedCaptures: number;
  /** The planned observations, without the observations of builds that the run did not reach. */
  plannedCaptures: number | null;
}
export interface OperationView {
  preparationProblem: PreparationProblem | null;
  testedModels: string[];
  journey: JourneyProgress | null;
  /** Why the build of the recent failure stopped, from its saved run. */
  buildStop: string | null;
  status: SavedOperationProgress;
  context: OperationContext | null;
  lineage: import("./launch.js").LineageSpending;
  lifecycle: import("./lifecycle.js").OperationLifecycle;
  capabilities: import("./lifecycle.js").OperationLifecycle["capabilities"];
  interruption: string | null;
  /** The run's one shared spending limit; null before its ledger exists. */
  ceilingUsd: number | null;
  spending: Pick<SpendingProgress, "billedUsd" | "reservedUsd" | "availableUsd">;
}
export interface PreparationProblem {
  status: string;
  explanation: string;
  diagnostics: string[];
}
export interface SpendingDetail {
  id: string;
  name: string;
  chargedUsd: number;
  pendingUsd: number;
}

export type AuthoringResult = {
  result: unknown;
  preparation: unknown;
  action: AuthoringAction;
  state: "queued" | "running" | "completed" | "incomplete";
  stopped: boolean;
  resultHash: string | null;
  error: string | null;
};

export type ReviewSelectionView = {
  total: number;
  page: number;
  pages: number;
  limit: number;
  items: {
    operationId: string;
    title: string;
    state: string;
    unavailable: string | null;
  }[];
  id: string;
  operationIds: string[];
  createdAt: string;
};

export type ReviewTreatmentCatalog = {
  items: {
    operationId: string;
    title: string;
    treatments: ReviewTreatment[];
  }[];
};

/**
 * A run event with what its unit covers, in the words of the results table, for example
 * "OpenAI: GPT-6 Luna · Build 2 · observation 1 · criteria 1–13 · judge sample 2". Null when the
 * event has no unit, or when the run has no frozen plan.
 */
export interface ActivityEvent extends RunOperationEvent {
  unit: string | null;
  /** Why a build stopped, from its saved run. Null for every other event. */
  buildStop: string | null;
}
