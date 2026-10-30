import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { RunOperationStore, operationUnitSummary, providerPausedUnits } from "./operation.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { assertOperationOwnerStopped } from "./process-owner.js";
import { reconcileOperationBilling } from "./reconcile.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { manifestHash } from "./run-manifest.js";
import { operationAttributions, runCauses } from "./outcome-causes.js";

const opaque = /^[a-z0-9][a-z0-9-]{0,80}$/u;

async function openOperation(root: string, operationId: string): Promise<RunOperationStore> {
  if (!opaque.test(operationId)) throw new Error("Invalid frozen run operation ID");
  const manifest = await new RepositoryFiles(root).json<RunOperationManifest>(
    `.basalt-evals/eval-operations/${operationId}/manifest.json`,
  );
  return new RunOperationStore(root, operationId, manifestHash(manifest), manifest.inputHash);
}

export async function stopFrozenRun(root: string, operationId: string, reason: string) {
  const operation = await openOperation(root, operationId);
  const status = await operation.progress();
  if (status.finished || status.stopped)
    throw new Error("This run is not active. Basalt can stop only an active run.");
  if (!reason.trim() || reason.length > 500) throw new Error("Run stop needs a bounded reason");
  await operation.append({
    kind: "stop_requested",
    stage: null,
    unitId: null,
    artifactHashes: [],
    reason,
    at: new Date().toISOString(),
  });
  return operation.progress();
}

/** Explicit inspection verifies saved evidence once; routine progress polls stay bounded. */
export async function inspectOperationOutcomes(root: string, operationId: string) {
  const status = await (await openOperation(root, operationId)).read();
  const causes = new Map(
    (await operationAttributions(root, status)).map((unit) => [
      `${unit.stage}:${unit.unitId}`,
      unit,
    ]),
  );
  return {
    operationId,
    planned: status.manifest.planned,
    gradingMode: status.manifest.gradingMode,
    outcomes: status.criterionOutcomes,
    unreviewedClaims: status.manifest.unreviewedClaims,
    units: operationUnitSummary(status),
    issues: status.events
      .filter((event) => event.kind === "failed" || event.kind === "incomplete")
      .map(({ id, stage, unitId, kind, reason, at }) => {
        // Only the last terminal event of a unit has a cause.
        const unit = causes.get(`${stage}:${unitId}`);
        const last = unit?.at === at && unit.kind === kind;
        return {
          id,
          stage,
          unitId,
          kind,
          reason,
          at,
          cause: last ? unit.cause : null,
          causeSource: last ? unit.source : null,
        };
      }),
  };
}

/**
 * Why the units of a run did not finish, by cause. The causes come from the events and the
 * failure records, so the read replays the events and verifies no receipt.
 */
export async function runOutcomeCauses(root: string, operationId: string) {
  return runCauses(root, await (await openOperation(root, operationId)).eventStatus());
}

export async function resumeFrozenRun(
  root: string,
  operationId: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const operation = await openOperation(root, operationId);
  const status = await operation.read();
  if (!status.stopped || status.finished)
    throw new Error("Basalt can resume only a stopped run that did not complete.");
  await assertOperationOwnerStopped(root, operationId);
  await assertExecutionImplementation(root, status.manifest);
  if (status.pendingBilling) await reconcileOperationBilling(root, operationId, adapters);
  await operation.append({
    kind: "resumed",
    stage: null,
    unitId: null,
    artifactHashes: [],
    reason: status.inFlightUnits.length
      ? "Basalt resumed the run. It examines the stopped units and does not send a request with a pending charge again."
      : providerPausedUnits(status).length
        ? "Basalt resumed the run. It continues the work that a provider failure paused."
        : "Basalt resumed the run.",
    at: new Date().toISOString(),
  });
  return operation.read();
}

export async function reportFrozenRun(root: string, operationId: string) {
  const operation = await openOperation(root, operationId);
  const status = await operation.read();
  if (status.finished)
    return new RepositoryFiles(root).json(
      `.basalt-evals/eval-operations/${operationId}/report.json`,
    );
  await assertExecutionImplementation(root, status.manifest);
  const reporting = status.inFlightUnits.some(
    (unit) => unit.stage === "report" && unit.unitId === "final",
  );
  if (!reporting && status.inFlightUnits.length)
    throw new Error("Each unit in flight must be reconciled before reporting");
  if (!reporting)
    await operation.append({
      kind: "started",
      stage: "report",
      unitId: "final",
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  return operation.completeReport();
}
