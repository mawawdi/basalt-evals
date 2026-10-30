import type { FailureRecord } from "../../contracts/src/failure.js";
import type { AssessmentProgress } from "../../contracts/src/assessments.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { operationLifecycle, type OperationLifecycle } from "../../contracts/src/lifecycle.js";
import type {
  AuthoringProgress,
  EvaluationWorkflow,
  RunStart,
} from "../../contracts/src/execution.js";
import { processAlive } from "./process-owner.js";
import { preparationProblem } from "./preparation-outcome.js";
import { runArchived } from "./run-visibility.js";

/** One snapshot, no artifact verification or full event/population reads. */
export function readLifecycle(journal: OperationJournal, id: string): OperationLifecycle {
  const assessment =
    journal.read<AssessmentProgress>("assessment_progress", id) ??
    journal.read<AssessmentProgress>("comparison_progress", id);
  const workflow = journal.read<EvaluationWorkflow>("workflows", id);
  const execution = journal.read<import("../../contracts/src/console.js").ExecutionProgress>(
    "operation_progress",
    id,
  );
  const start = journal.read<RunStart>("run_starts", id);
  const authoring = journal.read<AuthoringProgress>("authoring_progress", id);
  if (!assessment && !workflow && !execution && !start && !authoring)
    throw new Error("No saved operation");
  const owner = journal.read<{
    active: boolean;
    pid: number;
    error: string | null;
    waiting: "review" | "studio" | null;
  }>("drivers", id);
  const spending = journal.read<{
    pendingBilling: boolean;
    availableUsd: number;
    authorizationHash: string;
  }>("spending_progress", id);
  const readiness = journal.read<{ state: string }>("readiness_progress", id);
  const ownerActive = !!owner?.active && processAlive(owner.pid);
  const problem = preparationProblem(journal, id);
  const finished = workflow
    ? workflow.state === "complete"
    : (assessment?.finished ?? execution?.finished ?? authoring?.state === "completed");
  const stopped =
    workflow?.state === "stopped" ||
    (assessment?.stopped ?? execution?.stopped ?? start?.stopped ?? authoring?.stopped ?? false);
  const result = operationLifecycle({
    phase:
      (readiness && readiness.state !== "ready" ? "readiness" : null) ??
      workflow?.phase ??
      (assessment || execution || start ? "execution" : authoring!.action.stage),
    finished,
    stopped,
    ownerActive,
    ownerInterrupted: !!owner && !ownerActive && !finished && !stopped && !spending?.pendingBilling,
    blocker:
      problem?.explanation ??
      assessment?.error ??
      workflow?.blocker ??
      owner?.error ??
      start?.error ??
      authoring?.error ??
      (owner?.waiting === "review" && !ownerActive && !finished && !stopped
        ? "The run waits for a required review. Complete the review to continue the run."
        : null) ??
      null,
    pendingBilling: spending?.pendingBilling ?? false,
    hasWorkflow: !!workflow,
    hasBudget: !!spending || !!workflow,
    hasExecution: !!execution || !!assessment,
  });
  const failures = Object.values(
    journal.read<Record<string, FailureRecord>>("failure_heads", id) ?? {},
  );
  const studioUpdate = failures.find((failure) => failure.causeCode === "studio_update_required");
  if (!ownerActive && result.blocker && studioUpdate) {
    result.capabilities.resume = { allowed: false, reason: studioUpdate.explanation };
    result.capabilities.budget = {
      allowed: false,
      reason: "Update Studio. Then start a new run with the updated Studio.",
    };
  }
  const blocking =
    !ownerActive &&
    result.blocker &&
    failures.find(
      (failure) =>
        failure.causeCode === "preparation_output_limit" ||
        ([
          "preparation",
          "prepare_public",
          "prepare_private_plan",
          "prepare_private_criteria",
        ].includes(failure.unit.stage) &&
          failure.recoveryActions.every((action) => action === "inspect")) ||
        (["prepare_public", "prepare_private_plan", "prepare_private_criteria"].includes(
          failure.unit.stage,
        ) &&
          /429$/.test(failure.causeCode)),
    );
  const preparationBlocker = problem?.explanation ?? (blocking ? blocking.explanation : null);
  if (preparationBlocker)
    result.capabilities.resume = {
      allowed: false,
      reason: preparationBlocker,
    };
  if (problem)
    result.capabilities.budget = {
      allowed: false,
      reason: "A higher spending limit cannot correct the saved preparation result.",
    };
  // A run without model builds and without judge checks sends no model request, for example a
  // Studio replay of a saved build, so a higher spending limit changes nothing.
  if (
    execution &&
    execution.manifest.planned.independentBuilderTrials === 0 &&
    execution.manifest.planned.judgmentBatches === 0
  )
    result.capabilities.budget = {
      allowed: false,
      reason: "This run sends no model requests, so a higher spending limit changes nothing.",
    };
  if (execution && !ownerActive) {
    // A unit paused for spending continues only after a new authorization raises the limit. A
    // provider pause continues only after Resume, so Resume stays available beside it.
    const paused = execution.pausedAuthorizationHashes;
    if (
      paused.length &&
      !execution.providerPauses.length &&
      paused.every((hash) => hash === spending?.authorizationHash)
    )
      result.capabilities.resume = {
        allowed: false,
        reason: "Increase the spending limit before you continue the paused work.",
      };
  }
  // An archived run is out of the lists, so it cannot start work. Check payment status stays.
  if (runArchived(journal, id))
    for (const command of ["resume", "budget", "amend", "setup"] as const)
      result.capabilities[command] = {
        allowed: false,
        reason: "Restore the run before you continue it.",
      };
  return result;
}

export async function savedLifecycle(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => readLifecycle(journal, id));
  } finally {
    journal.close();
  }
}
