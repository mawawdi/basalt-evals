import { OperationJournal } from "../../artifact-store/src/journal.js";
import type {
  ExecutionProgress,
  SavedOperationProgress,
  SpendingProgress,
} from "../../contracts/src/console.js";
import type {
  EvaluationWorkflow,
  AuthoringProgress,
  RunStart,
} from "../../contracts/src/execution.js";
import { decodeAssessmentProgress } from "../../contracts/src/assessments.js";
import { identity } from "../../contracts/src/validation.js";

export function readExecutionProgress(journal: OperationJournal, id: string): ExecutionProgress {
  const progress = journal.read<ExecutionProgress>("operation_progress", id);
  const spending = journal.read<SpendingProgress>("spending_progress", id);
  if (!progress || !spending)
    throw new Error("No current operation progress; historical operations are archives");
  const owner = journal.read<{
    active: boolean;
    error: string | null;
    waiting?: "review" | "studio" | null;
  }>("drivers", id);
  return {
    ...progress,
    ...spending,
    driver: owner
      ? { active: owner.active, error: owner.error, waiting: owner.waiting ?? null }
      : null,
    measurementComplete: progress.measurementComplete && !spending.uncertainBilling,
  };
}

/** A single journal snapshot for progress, ownership, spending and workflow identity. */
export function readSavedProgress(journal: OperationJournal, id: string): SavedOperationProgress {
  identity(id);
  const workflow = journal.read<EvaluationWorkflow>("workflows", id);
  const assessment = journal.read<unknown>("assessment_progress", id);
  if (assessment) return { ...decodeAssessmentProgress(assessment), workflow, kind: "assessment" };
  const comparison = journal.read<unknown>("comparison_progress", id);
  if (comparison) return { ...decodeAssessmentProgress(comparison), workflow, kind: "comparison" };
  if (journal.read("operation_progress", id))
    return { ...readExecutionProgress(journal, id), workflow, kind: "evaluation" };
  const start = journal.read<RunStart>("run_starts", id);
  if (start) return { ...start, workflow, kind: "starting" };
  const authoring = journal.read<AuthoringProgress>("authoring_progress", id);
  const spending = journal.read<SpendingProgress>("spending_progress", id);
  if (!authoring && workflow)
    return {
      kind: "admission",
      operationId: id,
      state:
        workflow.state === "stopped"
          ? "stopped"
          : workflow.state === "complete"
            ? "completed"
            : workflow.state === "attention"
              ? "incomplete"
              : "queued",
      error: workflow.blocker,
      workflow,
    };
  if (!authoring || !spending) throw new Error("No saved operation");
  const owner = journal.read<{
    active: boolean;
    error: string | null;
    waiting?: "review" | "studio" | null;
  }>("drivers", id);
  return {
    ...authoring,
    ...spending,
    workflow,
    driver: owner
      ? { active: owner.active, error: owner.error, waiting: owner.waiting ?? null }
      : null,
    kind: "authoring",
  };
}
