export interface ComparisonCell {
  evaluationId: string;
  rubricHash: string;
  candidateId: string;
  criterionId: string;
  /** The position of the criterion in the authored order of its evaluation. */
  criterionOrder: number;
  statement: string;
  scale: string | null;
  captureId: string;
  pass: number;
  /** The evidence cell of the answer in its own run; null for an answer of a reassessment. */
  evidenceCellId: string | null;
  acquisitionHash: string;
  graderIdentity: string;
  generatorIdentity: string | null;
  method: "functional" | "qualitative";
  /**
   * The answer of the check. `split` is a judge check whose samples disagree. `insufficient` is
   * the answer "not enough evidence". `incomplete` is a check without an answer.
   */
  outcome: "met" | "rejected" | "split" | "scored" | "insufficient" | "incomplete";
  score: number | null;
  scaleHash: string | null;
}
export interface ComparisonPopulation {
  operationId: string;
  manifestHash: string;
  kind: "execution" | "assessment";
  sourceOperationId: string | null;
  title: string;
  /** The public titles of the evaluations of the run, in plan order. */
  evaluations: Array<{ evaluationId: string; title: string }>;
  recordedAt: string | null;
  conditions: Record<string, unknown>;
  cells: ComparisonCell[];
  independentBuilds: number;
  captures: number;
  billedUsd: number;
  reservedUsd: number;
  toolCalls: number | null;
  elapsedMs: number | null;
}
export type ComparisonCompatibility = "direct" | "descriptive" | "incompatible";
/** The classification of two runs of a comparison. `left` and `right` are operation IDs. */
export interface ComparisonPair {
  left: string;
  right: string;
  compatibility: ComparisonCompatibility;
  reasons: string[];
  pairing: "unpaired" | "same_retained_evidence";
}
/**
 * A comparison of two to six runs in the order that a person chose. Each pair of runs has its
 * own classification, and the comparison has the classification of its worst pair.
 */
export interface RunComparison {
  id: string;
  populations: ComparisonPopulation[];
  /** The answers of each run that the shared scope of saved evidence excluded. */
  scope: Array<{ operationId: string; decisionsExcluded: number }>;
  pairs: ComparisonPair[];
  compatibility: ComparisonCompatibility;
  createdAt: string;
}
/**
 * A grader reference binds only development captures. A generation reference can bind
 * withheld captures; `withheldCaptureIds` names them, and each save records a holdout look.
 */
export interface RegressionReference {
  id: string;
  title: string;
  purpose: "generation" | "grader";
  operationId: string;
  manifestHash: string;
  subjectId: string;
  evaluationId: string;
  validationRecordHash: string;
  criterionIds: string[];
  evidenceSetIds: string[];
  withheldCaptureIds: string[];
  createdAt: string;
}

/**
 * One look at withheld material of an evaluation, so that a report can state it.
 * `recordId` is the regression reference or the authorized reassessment.
 */
export interface HoldoutLook {
  at: string;
  purpose:
    | "generation_regression"
    | "reassessment"
    | "sensitivity_test"
    | "exemplar_comparison"
    | "recheck"
    | "known_build";
  recordId: string;
  operationId: string;
  /** The builds whose withheld captures the look reads. */
  subjectIds: string[];
  captureIds: string[];
}

/** The access record of one study holdout: the withheld partition of one evaluation. */
export interface HoldoutAccess {
  evaluationId: string;
  looks: HoldoutLook[];
}
