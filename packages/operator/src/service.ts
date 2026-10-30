import { assessmentProgress, assessmentPlan, updateAssessment } from "./assessment.js";
import {
  exemplarComparisonPlan,
  exemplarComparisonProgress,
  updateExemplarComparison,
} from "./exemplar-comparison.js";
import { savedLifecycle } from "./lifecycle.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import {
  authoringProgress,
  authoringActionResult,
  stopAuthoringAction,
  resumeAuthoringAction,
} from "./authoring-operation.js";
import { startOperationDriver } from "./driver.js";
import { operationProgress } from "./operation.js";
import { stopFrozenRun, resumeFrozenRun } from "./run-report.js";
import { reconcileOperationBilling } from "./reconcile.js";
import { runStartProgress, updateRunStart } from "./run-request.js";
import { assertOperationOwnerStopped } from "./process-owner.js";
import { bindOperationImplementation } from "./execution-guard.js";
import { hashJson } from "../../contracts/src/index.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { workflowRecord, updateWorkflow } from "./workflow.js";

export async function continueSavedOperation(
  root: string,
  id: string,
  workerModule?: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const workflow = await workflowRecord(root, id);
  if (workflow && workflow.state !== "active")
    throw new Error("This run is not active. Select Resume to continue it.");
  return startOperationDriver(root, id, workerModule, adapters);
}

async function isFrozenRun(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read("operation_progress", id) !== null;
  } finally {
    journal.close();
  }
}

export async function stopSavedOperation(root: string, id: string, reason: string) {
  if (!(await savedLifecycle(root, id)).capabilities.stop.allowed)
    throw new Error("Basalt cannot stop this run in its current state.");
  if (await assessmentProgress(root, id)) return updateAssessment(root, id, { stopped: true });
  if (await exemplarComparisonProgress(root, id))
    return updateExemplarComparison(root, id, { stopped: true });
  const workflow = await workflowRecord(root, id);
  if (workflow?.state === "complete")
    throw new Error("This run is complete. Basalt cannot stop it.");
  if (await isFrozenRun(root, id)) {
    const result = await stopFrozenRun(root, id, reason);
    await updateWorkflow(root, id, { state: "stopped" });
    return result;
  }
  if (await runStartProgress(root, id)) {
    const result = await updateRunStart(root, id, { stopped: true });
    await updateWorkflow(root, id, { state: "stopped" });
    return result;
  }
  if (!(await authoringProgress(root, id))) {
    if (workflow) return updateWorkflow(root, id, { state: "stopped" });
    throw new Error("No saved operation");
  }
  const result = await stopAuthoringAction(root, id);
  await updateWorkflow(root, id, { state: "stopped" });
  return result;
}

export async function resumeSavedOperation(
  root: string,
  id: string,
  workerModule?: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  await assertOperationOwnerStopped(root, id);
  const assessment = await assessmentProgress(root, id);
  if (assessment) {
    if (assessment.finished) throw new Error("This run is complete. Basalt cannot resume it.");
    await bindOperationImplementation(
      root,
      id,
      hashJson({ inputHash: (await assessmentPlan(root, id)).inputHash }),
    );
    await reconcileOperationBilling(root, id, adapters);
    await updateAssessment(root, id, { stopped: false, error: null });
    return startOperationDriver(root, id, workerModule, adapters);
  }
  const comparison = await exemplarComparisonProgress(root, id);
  if (comparison) {
    if (comparison.finished) throw new Error("This run is complete. Basalt cannot resume it.");
    await bindOperationImplementation(
      root,
      id,
      hashJson({ inputHash: (await exemplarComparisonPlan(root, id)).inputHash }),
    );
    await reconcileOperationBilling(root, id, adapters);
    await updateExemplarComparison(root, id, { stopped: false, error: null });
    return startOperationDriver(root, id, workerModule, adapters);
  }
  const workflow = await workflowRecord(root, id);
  if (workflow?.state === "complete")
    throw new Error("This run is complete. Basalt cannot resume it.");
  const preparation = await authoringProgress(root, id);
  if (
    workflow &&
    ((workflow.phase === "preparation" &&
      (!preparation || workflow.revisions[preparation.action.draftId])) ||
      (!preparation && !(await runStartProgress(root, id)) && !(await isFrozenRun(root, id))))
  ) {
    const { queueWorkflowStage } = await import("./workflow.js");
    let queued: boolean;
    try {
      queued = await queueWorkflowStage(root, workflow, undefined, adapters);
    } catch (error) {
      await updateWorkflow(root, id, {
        state: "attention",
        blocker: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await updateWorkflow(root, id, { state: queued ? "active" : "complete", blocker: null });
    if (!queued) return workflowRecord(root, id);
    return startOperationDriver(root, id, workerModule, adapters);
  }
  if (await isFrozenRun(root, id)) {
    const progress = await operationProgress(root, id);
    if (!progress.stopped && !progress.finished)
      await stopFrozenRun(root, id, "Basalt examined the saved work before it resumed the run.");
    const result = await resumeFrozenRun(root, id, adapters);
    await updateWorkflow(root, id, { state: "active", blocker: null });
    await startOperationDriver(root, id, workerModule, adapters);
    return result;
  }
  const start = await runStartProgress(root, id);
  if (start) {
    await assertOperationOwnerStopped(root, id);
    await bindOperationImplementation(root, id, hashJson({ inputHash: start.inputHash }));
    const result = await updateRunStart(root, id, { stopped: false, state: "queued", error: null });
    await updateWorkflow(root, id, { state: "active", blocker: null });
    await startOperationDriver(root, id, workerModule, adapters);
    return result;
  }
  await reconcileOperationBilling(root, id, adapters);
  const saved = await authoringActionResult(root, id);
  // Only a preparation runs under a workflow. Reference tests and explanations have no workflow.
  if (workflow && saved.state === "completed") {
    const result = saved.result as { validation?: { status: string } };
    if (result.validation?.status !== "ready")
      throw new Error("The saved preparation is not ready. Edit the evaluation to continue.");
    const journal = await OperationJournal.open(root);
    try {
      const { result: _result, preparation: _preparation, ...progress } = saved;
      journal.put("authoring_progress", id, {
        ...progress,
        stopped: false,
      });
    } finally {
      journal.close();
    }
    await updateWorkflow(root, id, { state: "active", blocker: null });
    return startOperationDriver(root, id, workerModule, adapters);
  }
  const result = await resumeAuthoringAction(root, id);
  await updateWorkflow(root, id, { state: "active", blocker: null });
  await startOperationDriver(root, id, workerModule, adapters);
  return result;
}
