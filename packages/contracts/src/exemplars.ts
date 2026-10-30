import { hashJson } from "./index.js";

/*
 * Exemplar builds and the exemplar comparison stream. For one appearance criterion, a person
 * chooses one or two exemplar builds. Each exemplar shows the lowest level that meets the
 * criterion. The judge compares a build with each exemplar, in both orders. No model chooses
 * or changes an exemplar.
 */

/** The registered identity of the comparison stream. It is not an evidence presentation. */
export const EXEMPLAR_COMPARISON_STREAM = "exemplar_comparison" as const;
export const MAX_EXEMPLARS = 2;
export const EXEMPLAR_REASON_CHARS = 300;

/** One exemplar: one build and one development observation of it. */
export interface ExemplarBuild {
  /** The saved example that holds the build, or null for a build of a run. */
  savedExampleId: string | null;
  operationId: string;
  manifestHash: string;
  subjectId: string;
  /** One development observation of the build. A withheld observation is refused. */
  captureId: string;
  /** The content identity of the build source. */
  sourceHash: string;
  /** The model that made the build, or null when no model made it. */
  builderModelId: string | null;
}

/** The authored exemplar choice of one criterion, with the identity of the person. */
export interface ExemplarChoice {
  id: string;
  evaluationId: string;
  criterionId: string;
  exemplars: ExemplarBuild[];
  /** The server identity of the reviewer profile of the person who chose. */
  reviewerId: string;
  /** One sentence of the person: why each exemplar shows the lowest level that meets the criterion. */
  reason: string;
  chosenAt: string;
}

/** The two orders of one comparison. In the first order, the build under judgment is Build A. */
export const COMPARISON_ORDERS = ["candidate_first", "exemplar_first"] as const;
export type ComparisonOrder = (typeof COMPARISON_ORDERS)[number];
/** The neutral name of a build in a request. Build A is the first build of the order. */
export type BuildName = "A" | "B";
/** The answer of one request. */
export type BuildAnswer = BuildName | "insufficient";
/** The build that one answer prefers, after the order is removed. */
export type PairPreference = "candidate" | "exemplar" | "insufficient";
/**
 * The result of one build against one exemplar over both orders. A win and a loss are
 * consistent over both orders. A flip prefers a different build in each order.
 */
export type PairOutcome = "win" | "loss" | "flip" | "insufficient";

const hashPattern = /^[a-f0-9]{64}$/u;
const identityPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;
const criterionPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;

/** Remove the order from one answer. */
export function preferenceOf(answer: BuildAnswer, order: ComparisonOrder): PairPreference {
  if (answer === "insufficient") return "insufficient";
  if (answer !== "A" && answer !== "B") throw new Error("A build answer is A, B or insufficient");
  if (!(COMPARISON_ORDERS as readonly string[]).includes(order))
    throw new Error("Unknown comparison order");
  return (answer === "A") === (order === "candidate_first") ? "candidate" : "exemplar";
}

/** Combine the two orders of one exemplar. An insufficient answer in either order is insufficient. */
export function pairOutcome(
  candidateFirst: PairPreference,
  exemplarFirst: PairPreference,
): PairOutcome {
  if (candidateFirst === "insufficient" || exemplarFirst === "insufficient") return "insufficient";
  if (candidateFirst !== exemplarFirst) return "flip";
  return candidateFirst === "candidate" ? "win" : "loss";
}

/**
 * The verdict of one criterion over its exemplars. A consistent win over every exemplar
 * satisfies the criterion. A consistent loss to every exemplar violates it. Each other
 * combination is insufficient: a flip, an insufficient answer, or a build between the
 * exemplars.
 */
export function exemplarVerdict(
  outcomes: PairOutcome[],
): "satisfied" | "violated" | "insufficient" {
  if (!outcomes.length || outcomes.length > MAX_EXEMPLARS)
    throw new Error("A criterion has one or two exemplars");
  if (outcomes.every((outcome) => outcome === "win")) return "satisfied";
  if (outcomes.every((outcome) => outcome === "loss")) return "violated";
  return "insufficient";
}

function exemplarBuild(value: unknown): ExemplarBuild {
  const row = value as ExemplarBuild;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !==
      "builderModelId,captureId,manifestHash,operationId,savedExampleId,sourceHash,subjectId" ||
    (row.savedExampleId !== null && !hashPattern.test(String(row.savedExampleId))) ||
    ![row.operationId, row.subjectId, row.captureId].every(
      (item) => typeof item === "string" && identityPattern.test(item),
    ) ||
    ![row.manifestHash, row.sourceHash].every(
      (item) => typeof item === "string" && hashPattern.test(item),
    ) ||
    (row.builderModelId !== null &&
      (typeof row.builderModelId !== "string" ||
        !/^[a-z0-9][a-z0-9./:-]{0,127}$/u.test(row.builderModelId)))
  )
    throw new Error("Invalid exemplar build");
  return row;
}

/** Validate an exemplar choice and its content identity. */
export function assertExemplarChoice(value: unknown): ExemplarChoice {
  const row = value as ExemplarChoice;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !==
      "chosenAt,criterionId,evaluationId,exemplars,id,reason,reviewerId" ||
    !hashPattern.test(String(row.evaluationId)) ||
    typeof row.criterionId !== "string" ||
    !criterionPattern.test(row.criterionId) ||
    typeof row.reviewerId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(row.reviewerId) ||
    typeof row.reason !== "string" ||
    !row.reason.trim() ||
    row.reason.length > EXEMPLAR_REASON_CHARS ||
    typeof row.chosenAt !== "string" ||
    !Number.isFinite(Date.parse(row.chosenAt)) ||
    !Array.isArray(row.exemplars) ||
    !row.exemplars.length ||
    row.exemplars.length > MAX_EXEMPLARS
  )
    throw new Error("Invalid exemplar choice");
  const exemplars = row.exemplars.map(exemplarBuild);
  if (new Set(exemplars.map((item) => item.sourceHash)).size !== exemplars.length)
    throw new Error(
      "The anchor builds of one criterion are the same build. Choose two different builds.",
    );
  const { id, ...body } = row;
  if (id !== hashJson(body)) throw new Error("Exemplar choice changed");
  return row;
}

/** The selection of one exemplar comparison run. */
export interface ExemplarComparisonSelection {
  operationId: string;
  subjectId: string;
  modelId: string;
  criterionIds: string[];
  /** The registered plan that pins the stream. Null permits development observations only. */
  analysisPlanId: string | null;
}

/** The frozen rendered evidence of one build for one criterion. */
export interface FrozenBuildEvidence {
  operationId: string;
  captureId: string;
  /** The content identity of the evidence summary: receipt, source, frames, labels and images. */
  evidenceHash: string;
  /** Reasons that the evidence cannot support the criterion. A reason gives no call. */
  unavailable: string[];
}

/** One build against one exemplar for one criterion and one observation, in both orders. */
export interface ExemplarComparisonUnit {
  id: string;
  captureId: string;
  partition: "development" | "withheld";
  criterionId: string;
  choiceId: string;
  /** The position of the exemplar in the authored choice. */
  exemplar: number;
  /** The tolerance of two paired frames: the maximum frame gap of the view. */
  toleranceMs: number;
  candidate: FrozenBuildEvidence;
  exemplarEvidence: FrozenBuildEvidence;
}

export interface ExemplarComparisonPreview {
  id: string;
  stream: typeof EXEMPLAR_COMPARISON_STREAM;
  selection: ExemplarComparisonSelection;
  sourceManifestHash: string;
  title: string;
  configuration: import("../../eval-authoring/src/batch-judgment.js").BatchRequestConfiguration;
  choiceIds: string[];
  /** Criteria that cannot use the stream, with the reasons. They get no unit and no call. */
  notApplicable: Array<{ criterionId: string; reasons: string[] }>;
  units: ExemplarComparisonUnit[];
  /** Planned calls: two for each unit with available evidence. */
  calls: number;
  quote: import("../../model-client/src/quote.js").RunQuote;
  budget: import("./execution.js").BudgetSummary;
}

export interface ExemplarComparisonRunPlan {
  createdAt: string;
  id: string;
  previewId: string;
  inputHash: string;
  implementationCommit: string;
  buildIdentityHash: string;
  model: import("../../model-client/src/catalog.js").ModelSnapshot;
  ceilingUsd: number;
}

/** The answers of one unit. A unit without available evidence has no answers and no call. */
export interface ExemplarComparisonResult {
  operationId: string;
  unitId: string;
  treatmentIdentity: string;
  candidateEvidenceHash: string;
  exemplarEvidenceHash: string;
  answers: Array<{
    order: ComparisonOrder;
    better: BuildAnswer;
    preference: PairPreference;
    rationale: string;
    /** The report of the guard. It never changes the answer. */
    addressedToEvaluator: import("../../eval-authoring/src/criterion-response.js").AddressedToEvaluator;
  }>;
  outcome: PairOutcome;
  /** The reasons of an insufficient outcome without a call. */
  unavailable: string[];
  responseHashes: string[];
  costUsd: number | null;
}

export interface ExemplarComparisonReport {
  plan: ExemplarComparisonRunPlan;
  selection: ExemplarComparisonSelection;
  criteria: Array<{ id: string; statement: string; choiceId: string; exemplars: number }>;
  planned: number;
  results: Array<{
    unitId: string;
    captureId: string;
    partition: "development" | "withheld";
    pass: number;
    criterionId: string;
    exemplar: number;
    result: ExemplarComparisonResult | null;
    error: string | null;
  }>;
  /** The verdict of each observation and criterion over its exemplars. Null while a unit has no result. */
  verdicts: Array<{
    captureId: string;
    criterionId: string;
    verdict: "satisfied" | "violated" | "insufficient" | null;
  }>;
  spending: {
    billedUsd: number;
    reservedUsd: number;
    availableUsd: number;
    pendingBilling: boolean;
    uncertainBilling: boolean;
    uncertainRequests: number;
  };
  lineage: import("./launch.js").LineageSpending;
  limitation: string;
}
