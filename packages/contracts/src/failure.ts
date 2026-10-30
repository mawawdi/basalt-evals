import type { RunStage } from "./execution.js";
import type { FailureClassification } from "./index.js";

/** Recorded cause and dependency are authority; prose is never a grouping key. */
export interface ExecutionFailure {
  causeCode: string;
  category:
    "provider" | "startup" | "acquisition" | "integrity" | "budget" | "recovery" | "unknown";
  dependency: string | null;
  unit: { stage: string; id: string };
  evidenceRefs: string[];
  recoveryActions: Array<"inspect" | "reconcile" | "resume" | "amend_budget" | "amend_inputs">;
  explanation: string;
}
export interface FailureRecord extends ExecutionFailure {
  id: string;
  operationId: string;
  at: string;
}
export class ExecutionFault extends Error {
  constructor(readonly failure: ExecutionFailure) {
    super(failure.explanation);
    this.name = "ExecutionFault";
  }
}
export function unknownFailure(stage: string, id: string, explanation: string): ExecutionFailure {
  return {
    causeCode: "unclassified",
    category: "unknown",
    dependency: null,
    unit: { stage, id },
    evidenceRefs: [],
    recoveryActions: ["inspect"],
    explanation: explanation.slice(0, 500),
  };
}

/**
 * The cause of an outcome that did not finish: a failure class, or "unclassified" when no record
 * names one. The class "unknown" names no cause, so it is never an outcome cause.
 */
export type OutcomeCause = Exclude<FailureClassification, "unknown"> | "unclassified";

/** The units of one cause. Each unit names its build, or null for a unit of the whole run. */
export interface CauseUnits {
  cause: OutcomeCause;
  units: Array<{ stage: RunStage; unitId: string; subjectId: string | null }>;
}

/** Why the units of a run did not finish, with the title of each build that a unit names. */
export interface RunCauses {
  causes: CauseUnits[];
  buildTitles: Record<string, string>;
}

/** The authority that admitted a failure category. A model attributor only proposes a hypothesis. */
type FailureAdmission = "rule" | "control" | "reviewer" | "hypothesis";

/** One candidate failure category and the authority that admitted it. */
export interface FailureAttribution {
  classification: FailureClassification;
  detail: string;
  admission: FailureAdmission;
}

/**
 * Fixed precedence. Causes outside the candidate come first: provider, environment, limits,
 * harness, task, grader and missing evidence. A candidate cause follows only after them.
 */
export const FAILURE_PRECEDENCE: readonly FailureClassification[] = [
  "provider_or_transport_failure",
  "environment_failure",
  "budget_or_stop_failure",
  "harness_context_failure",
  "harness_feedback_failure",
  "task_spec_failure",
  "grader_failure",
  "evidence_incomplete",
  "workspace_or_security_failure",
  "model_refusal",
  "model_tool_use_failure",
  "model_reasoning_failure",
  "static_or_luau_failure",
  "studio_mutation_failure",
  "engine_runtime_failure",
  "visual_or_interaction_failure",
  "human_product_rejection",
  "unknown",
];

/** The outcome causes in the fixed precedence. "unclassified" comes last. */
export const OUTCOME_CAUSE_ORDER: readonly OutcomeCause[] = [
  ...FAILURE_PRECEDENCE.filter(
    (cause): cause is Exclude<OutcomeCause, "unclassified"> => cause !== "unknown",
  ),
  "unclassified",
];

/** Admitted attributions in precedence order. A hypothesis follows them and never leads. */
export function orderFailureAttributions<T extends FailureAttribution>(
  attributions: readonly T[],
): T[] {
  const rank = (attribution: FailureAttribution) =>
    (attribution.admission === "hypothesis" ? FAILURE_PRECEDENCE.length : 0) +
    FAILURE_PRECEDENCE.indexOf(attribution.classification);
  return [...attributions].sort((left, right) => rank(left) - rank(right));
}
