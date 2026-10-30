import { ensureStudioReadiness } from "./studio-readiness.js";
import { runArchived } from "./run-visibility.js";
import {
  assessmentProgress,
  assessmentPlan,
  executeAssessment,
  updateAssessment,
} from "./assessment.js";
import {
  executeExemplarComparison,
  exemplarComparisonPlan,
  exemplarComparisonProgress,
  updateExemplarComparison,
} from "./exemplar-comparison.js";
import { savedLifecycle } from "./lifecycle.js";
import type { RunOperationStatus, RunUnit } from "../../contracts/src/execution.js";
import {
  recordExecutionFailure,
  recordFailureStack,
  resolveExecutionFailures,
} from "../../artifact-store/src/failures.js";
import { providerPauseSentence } from "../../contracts/src/console.js";
import { ExecutionFault, unknownFailure } from "../../contracts/src/failure.js";
import { projectRun } from "./catalog-projection.js";
import { operationInputHash } from "./operation-binding.js";
import { manifestHash, operationSubject } from "./run-manifest.js";
import { recordNotReached } from "./stage-reach.js";
import { queuedStudioAdapter, runConcurrentUnits, StudioQueue, unitKey } from "./run-scheduler.js";
import { ModelPermits } from "./model-permits.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { sealRegisteredSubject } from "./seal-source.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { recoverEvalBuilderUnit } from "./builder-stage.js";
import { assertExecutionImplementation, bindOperationImplementation } from "./execution-guard.js";
import { authoringProgress, executeAuthoringAction } from "./authoring-operation.js";
import { pausedUnits, providerPausedUnits, RunOperationStore } from "./operation.js";
import { ModelRequestPendingError } from "../../model-client/src/contracts.js";
import { freezeSelectionRun } from "./selection-run.js";
import { freezeStageRun } from "./stage-run.js";
import { executeFrozenBuilderCell, frozenRunStatus } from "./run-builder.js";
import { executeFrozenCaptureCell } from "./run-capture.js";
import { executeFrozenDeterministicGradingCell } from "./run-grade.js";
import { executeFrozenJudgmentBatch } from "./run-judgment.js";
import { reportFrozenRun } from "./run-report.js";
import { processAlive } from "./process-owner.js";
import { reconcileOperationBilling } from "./reconcile.js";
import { runStartProgress, updateRunStart } from "./run-request.js";
import { freezeRegisteredEvalRun } from "./run-plan.js";
import { freezeRegisteredExperiment } from "./experiment-run.js";
import { advanceExperimentController } from "./experiment-controller.js";
import { createProtocolReviewBatch } from "./review-batches.js";
import {
  advanceEvaluationWorkflow,
  workflowRecord,
  updateWorkflow,
  readLaunchPreview,
  pinnedWorkflowAdapters,
} from "./workflow.js";

interface DriverOwner {
  token: string;
  pid: number;
  active: boolean;
  error: string | null;
  waiting: "review" | "studio" | null;
}

/** Owns one local process; repeated starts return the existing owner. No timer-based takeover. */
export async function startOperationDriver(
  root: string,
  operationId: string,
  workerModule = "dist/packages/operator/src/worker.js",
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  if (
    !/^dist\/packages\/[a-zA-Z0-9_./-]+\.js$/u.test(workerModule) ||
    workerModule.split("/").includes("..")
  )
    throw new Error("Worker must belong to the frozen executable build");
  await new RepositoryFiles(root).bytes(workerModule);
  const assessment =
    (await assessmentProgress(root, operationId)) ??
    (await exemplarComparisonProgress(root, operationId));
  const authoring = await authoringProgress(root, operationId);
  const workflow = await workflowRecord(root, operationId);
  const authoringActive =
    authoring &&
    (["queued", "running"].includes(authoring.state) ||
      (workflow?.state === "active" && ["readiness", "preparation"].includes(workflow.phase)));
  const runStart = await runStartProgress(root, operationId);
  const freezing = runStart && runStart.state !== "running";
  const status =
    assessment || authoringActive || freezing ? null : await frozenRunStatus(root, operationId);
  if (assessment)
    await assertExecutionImplementation(
      root,
      (await assessmentProgress(root, operationId))
        ? await assessmentPlan(root, operationId)
        : await exemplarComparisonPlan(root, operationId),
    );
  else if (authoringActive)
    await bindOperationImplementation(
      root,
      operationId,
      hashJson({
        inputHash: await operationInputHash(root, operationId, authoring.action.draftId),
      }),
    );
  else if (freezing)
    await bindOperationImplementation(
      root,
      operationId,
      hashJson({ inputHash: runStart.inputHash }),
    );
  else await assertExecutionImplementation(root, status!.manifest);
  if (
    assessment?.stopped ||
    assessment?.finished ||
    (authoring?.stopped && authoringActive) ||
    (freezing && runStart.stopped) ||
    status?.finished ||
    status?.stopped
  )
    throw new Error("This run is stopped or complete. Basalt cannot start it.");
  const owners = await OperationJournal.open(root);
  try {
    const prior = owners.read<DriverOwner>("drivers", operationId);
    if (prior?.active && processAlive(prior.pid)) return { operationId, running: true };
  } finally {
    owners.close();
  }
  if (status?.pendingBilling) {
    await reconcileOperationBilling(root, operationId, adapters);
    if ((await frozenRunStatus(root, operationId, false)).pendingBilling)
      throw new ModelRequestPendingError(
        "A saved request has a pending charge. Basalt cannot send it again.",
      );
  }
  const journal = await OperationJournal.open(root);
  const token = randomUUID();
  let owner: DriverOwner;
  try {
    owner = journal.transaction(() => {
      const prior = journal.read<DriverOwner>("drivers", operationId);
      if (prior?.active && processAlive(prior.pid)) return prior;
      if (runArchived(journal, operationId))
        throw new Error("This run is archived. Restore the run before you continue it.");
      const owner = { token, pid: process.pid, active: true, error: null, waiting: null };
      journal.put("drivers", operationId, owner);
      projectRun(journal, operationId);
      return owner;
    });
  } finally {
    journal.close();
  }
  if (owner.token !== token) return { operationId, running: true };
  let log: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const directory = await new RepositoryFiles(root).directory(
      `.basalt-evals/eval-operations/${operationId}`,
    );
    log = await open(resolve(directory, "driver.log"), "a", 0o600);
    const child = spawn(process.execPath, [resolve(root, workerModule), root, operationId, token], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise<void>((done, fail) => {
      child.once("spawn", done);
      child.once("error", fail);
    });
    if (child.pid) await updateOwner(root, operationId, token, { pid: child.pid });
    child.unref();
  } catch (error) {
    await updateOwner(root, operationId, token, { active: false, error: String(error) });
    throw error;
  } finally {
    await log?.close();
  }
  return { operationId, running: true };
}

async function updateOwner(
  root: string,
  operationId: string,
  token: string,
  changes: Partial<DriverOwner>,
) {
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const owner = journal.read<DriverOwner>("drivers", operationId);
      if (!owner || owner.token !== token)
        throw new Error("Operation process no longer owns this action");
      journal.put("drivers", operationId, { ...owner, ...changes });
      projectRun(journal, operationId);
    });
  } finally {
    journal.close();
  }
}

export async function driveOperation(
  root: string,
  operationId: string,
  token: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<void> {
  await updateOwner(root, operationId, token, { pid: process.pid });
  const workflow = await workflowRecord(root, operationId);
  const controller = new AbortController();
  // A failed lifecycle read also stops the units. The driver then reports that failure.
  let pollFailure: unknown = null;
  const poll = setInterval(() => {
    void savedLifecycle(root, operationId)
      .then((lifecycle) => {
        if (["stopping", "stopped"].includes(lifecycle.state)) controller.abort();
      })
      .catch((error: unknown) => {
        pollFailure ??= error;
        controller.abort(error);
      });
  }, 500);
  let error: string | null = null;
  let waiting: DriverOwner["waiting"] = null;
  try {
    if (await assessmentProgress(root, operationId)) {
      await executeAssessment(root, operationId, token, controller.signal, adapters);
      return;
    }
    if (await exemplarComparisonProgress(root, operationId)) {
      await executeExemplarComparison(root, operationId, token, controller.signal, adapters);
      return;
    }
    if (workflow)
      adapters = pinnedWorkflowAdapters(
        await readLaunchPreview(root, workflow.previewId),
        adapters,
      );
    if (!workflow) {
      const records = await OperationJournal.open(root);
      let referencePreviewId: string | null;
      try {
        const context = records.read<{ kind: string; previewId: string }>(
          "operation_context",
          operationId,
        );
        referencePreviewId = context?.previewId ?? null;
      } finally {
        records.close();
      }
      if (referencePreviewId) {
        const { readOperationLaunch } = await import("./launch.js");
        const preview = await readOperationLaunch(root, referencePreviewId);
        if (preview.studio)
          adapters = pinnedWorkflowAdapters(
            { models: preview.quote!.models, studio: preview.studio },
            adapters,
          );
      }
    }
    const phase = workflow?.phase;
    // Explain failures reads saved evidence and sends one model request, so it needs no Studio.
    const needsStudio =
      !!workflow || (await authoringProgress(root, operationId))?.action.stage !== "explanation";
    if (needsStudio) {
      if (workflow) await updateWorkflow(root, operationId, { phase: "readiness" });
      const readinessProjection = async (state: "running" | "ready" | "failed") => {
        const journal = await OperationJournal.open(root);
        try {
          journal.transaction(() => {
            journal.put("readiness_progress", operationId, {
              state,
              at: new Date().toISOString(),
            });
            if (state === "ready")
              resolveExecutionFailures(journal, operationId, "readiness", operationId);
            projectRun(journal, operationId);
          });
        } finally {
          journal.close();
        }
      };
      await readinessProjection("running");
      try {
        await ensureStudioReadiness({
          root,
          operationId,
          studio: adapters.studio,
          signal: controller.signal,
        });
      } catch (error) {
        await readinessProjection("failed");
        throw error;
      }
      await readinessProjection("ready");
    }
    if (workflow)
      await updateWorkflow(root, operationId, {
        phase:
          phase === "readiness"
            ? Object.keys(workflow.revisions).length === workflow.selection.sources.length
              ? "execution"
              : "preparation"
            : phase!,
      });
    for (;;) {
      const authoring = await authoringProgress(root, operationId);
      const currentWorkflow = await workflowRecord(root, operationId);
      if (!authoring || currentWorkflow?.phase === "execution") break;
      if (!["queued", "running"].includes(authoring.state)) {
        if (authoring.state === "completed" && currentWorkflow?.state === "active") {
          if (!(await advanceEvaluationWorkflow(root, operationId, token, adapters))) return;
          continue;
        }
        break;
      }
      await executeAuthoringAction(root, operationId, controller.signal, adapters);
      if (
        controller.signal.aborted ||
        !(await advanceEvaluationWorkflow(root, operationId, token, adapters))
      )
        return;
    }
    const start = await runStartProgress(root, operationId);
    if (start && start.state !== "running") {
      if (start.stopped) return;
      await updateRunStart(root, operationId, { state: "freezing", error: null });
      const journal = await OperationJournal.open(root);
      let existing: RunOperationStatus | null;
      try {
        existing = journal.read<RunOperationStatus>("operations", operationId);
      } finally {
        journal.close();
      }
      if (existing) {
        if (
          existing.manifest.quoteSelectionId !== start.request.quoteId ||
          existing.manifest.ceilingUsd !== start.request.ceilingUsd
        )
          throw new Error("Recovered run manifest differs from the authorized start request");
        await frozenRunStatus(root, operationId);
        await assertExecutionImplementation(root, existing.manifest);
      } else {
        const quote = await new RepositoryFiles(root).json<{ kind: string }>(
          `.basalt-evals/eval-run-quotes/${start.request.quoteId}.json`,
        );
        const freeze =
          quote.kind === "experiment"
            ? freezeRegisteredExperiment
            : quote.kind === "selection"
              ? freezeSelectionRun
              : quote.kind === "stages"
                ? freezeStageRun
                : freezeRegisteredEvalRun;
        await freeze({
          root,
          operationId,
          quoteId: start.request.quoteId,
          ceilingUsd: start.request.ceilingUsd,
          adapters,
        });
      }
      if ((await runStartProgress(root, operationId))?.stopped) {
        const { stopFrozenRun } = await import("./run-report.js");
        await stopFrozenRun(root, operationId, "The run stopped before its preparation completed.");
        await updateRunStart(root, operationId, { state: "running" });
        return;
      }
      await updateRunStart(root, operationId, { state: "running" });
    }
    const frozen = await frozenRunStatus(root, operationId, false);
    const store = new RunOperationStore(
      root,
      operationId,
      manifestHash(frozen.manifest),
      frozen.manifest.inputHash,
    );
    const unownedPending = async () => (await store.ledger.unownedPending()).length > 0;
    // Studio jobs of builds and observations go through one queue: one Studio job for each lane.
    const queue = new StudioQueue((await adapters.studio.lanes?.(root)) ?? 1);
    const drain = new AbortController();
    drain.signal.addEventListener(
      "abort",
      () =>
        queue.close(
          new Error(
            "Basalt started no new Studio work, because another unit of the run failed. Resume the run to continue.",
          ),
        ),
      { once: true },
    );
    const runAdapters: ExecutionAdapters = {
      ...adapters,
      studio: queuedStudioAdapter(adapters.studio, queue),
    };
    // Builds and judgments of one model share its frozen number of requests at once.
    const permits = new ModelPermits(frozen.manifest.modelConcurrency);
    // The driver shows "Waiting for Studio" while a unit waits for a lane that another run holds.
    let studioWaits = 0;
    const laneObserver = () => {
      let waitingNow = false;
      const admitted = async () => {
        if (!waitingNow) return;
        waitingNow = false;
        studioWaits -= 1;
        if (!studioWaits && waiting === "studio") {
          waiting = null;
          await updateOwner(root, operationId, token, { waiting });
        }
      };
      return {
        onWaiting: async () => {
          if (waitingNow) return;
          waitingNow = true;
          studioWaits += 1;
          if (waiting === null) {
            waiting = "studio";
            await updateOwner(root, operationId, token, { waiting });
          }
        },
        onAdmitted: admitted,
        settle: admitted,
      };
    };
    const execute = async (unit: RunUnit) => {
      const status = await frozenRunStatus(root, operationId, false);
      await assertExecutionImplementation(root, status.manifest);
      const lane = laneObserver();
      try {
        if (
          unit.stage === "builder" &&
          !status.inFlightUnits.some((item) => unitKey(item) === unitKey(unit))
        ) {
          // The run did not reach the stage of this build. Record it, and start no model work.
          if (await recordNotReached(store, status, operationSubject(status.manifest, unit.unitId)))
            return;
        }
        if (unit.stage === "builder") {
          // A build that an earlier process left in flight is reconciled before it continues.
          if (status.inFlightUnits.some((item) => unitKey(item) === unitKey(unit))) {
            const recovered = await recoverEvalBuilderUnit({
              root,
              operation: store,
              unitId: unit.unitId,
            });
            if (recovered === "uncertain_billing")
              throw new ModelRequestPendingError(
                "The build stopped with a pending charge. Basalt cannot send its saved request again.",
              );
            if (recovered !== "resumable") return;
          }
          await executeFrozenBuilderCell({
            root,
            operationId,
            unitId: unit.unitId,
            signal: controller.signal,
            dispatch: drain.signal,
            adapters: runAdapters,
            lane,
            permits,
          });
        } else if (unit.stage === "seal") {
          await sealRegisteredSubject(root, operationId, unit.unitId);
        } else if (unit.stage === "final_capture") {
          await executeFrozenCaptureCell({
            root,
            operationId,
            cellId: unit.unitId,
            signal: controller.signal,
            studioAdapter: runAdapters.studio,
            onWaiting: lane.onWaiting,
            onAdmitted: lane.onAdmitted,
          });
        } else if (unit.stage === "judgment") {
          await executeFrozenJudgmentBatch({
            root,
            operationId,
            batchId: unit.unitId,
            signal: controller.signal,
            dispatch: drain.signal,
            adapters: runAdapters,
            permits,
          });
        } else if (unit.stage === "grading") {
          await executeFrozenDeterministicGradingCell({ root, operationId, cellId: unit.unitId });
        } else if (unit.stage === "review" || unit.stage === "selection") {
          if (!(await advanceExperimentController(root, operationId)))
            throw new Error("Pending experiment gate needs its declared evidence");
        } else if (unit.stage === "report") {
          if (status.manifest.protocol) await createProtocolReviewBatch(root, operationId);
          await reportFrozenRun(root, operationId);
          await updateWorkflow(root, operationId, {
            phase: "complete",
            state: "complete",
            blocker: null,
          });
        } else throw new Error("Pending stage requires explicit reconciliation");
      } finally {
        await lane.settle();
      }
    };
    await runConcurrentUnits({
      status: () => frozenRunStatus(root, operationId, false),
      unownedPending,
      execute,
      // A retained failed unit stays in the denominator, and other units continue. Each
      // other failure stops new work: an observation failure, an infrastructure fault, a
      // unit that stays in flight, an unknown charge or a unit that recorded no outcome.
      async fatal(unit, cause, before) {
        const after = await frozenRunStatus(root, operationId, false);
        // A Stop from the console: end all units now. The stop is not a failure of the run.
        if (after.stopped) {
          controller.abort();
          return false;
        }
        const key = unitKey(unit);
        const recorded = after.events
          .slice(before.events.length)
          .some((event) => `${event.stage}:${event.unitId}` === key && event.kind !== "started");
        return (
          unit.stage === "final_capture" ||
          (cause instanceof ExecutionFault &&
            ["startup", "acquisition", "integrity"].includes(cause.failure.category)) ||
          after.inFlightUnits.some((item) => unitKey(item) === key) ||
          (await unownedPending()) ||
          !recorded
        );
      },
      async idle(status, unowned) {
        if (status.finished || status.stopped) return false;
        if (unowned)
          throw new ModelRequestPendingError(
            "A saved request has a pending charge. Basalt cannot send it again.",
          );
        const providerPauses = providerPausedUnits(status);
        // Only Resume continues a provider pause, so a run with only provider pauses says so.
        if (providerPauses.length && !pausedUnits(status).length)
          throw new Error(providerPauseSentence(providerPauses.map((pause) => pause.record))!);
        if (pausedUnits(status).length)
          throw new Error(
            "The run paused at the spending limit. Increase the spending limit to continue. Basalt saved the completed work.",
          );
        if (status.manifest.protocol && !status.inFlightUnits.length) {
          if (await advanceExperimentController(root, operationId)) return true;
          await createProtocolReviewBatch(root, operationId);
          waiting = "review";
        }
        return false;
      },
      signal: controller.signal,
      drain,
    });
    if (pollFailure) throw pollFailure;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    const journal = await OperationJournal.open(root);
    const known = journal.read<Record<string, unknown>>("failure_heads", operationId);
    journal.close();
    if (cause instanceof ExecutionFault || !known || !Object.keys(known).length) {
      const failure =
        cause instanceof ExecutionFault
          ? cause.failure
          : { ...unknownFailure("driver", operationId, error), category: "recovery" as const };
      // An unknown or recovery failure keeps its redacted stack for diagnosis.
      const stack =
        failure.category === "unknown" || failure.category === "recovery"
          ? await recordFailureStack(root, operationId, cause)
          : null;
      await recordExecutionFailure(
        root,
        operationId,
        stack ? { ...failure, evidenceRefs: [...failure.evidenceRefs, stack] } : failure,
      );
    }
    if (await assessmentProgress(root, operationId))
      await updateAssessment(root, operationId, { error });
    if (await exemplarComparisonProgress(root, operationId))
      await updateExemplarComparison(root, operationId, { error });
    await updateWorkflow(root, operationId, { state: "attention", blocker: error });
    const start = await runStartProgress(root, operationId);
    if (start && start.state !== "running")
      await updateRunStart(root, operationId, { state: "incomplete", error });
  } finally {
    clearInterval(poll);
    await updateOwner(root, operationId, token, { active: false, error, waiting });
  }
}
