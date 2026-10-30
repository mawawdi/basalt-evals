import type { RunOperationManifest, RunStage } from "../../contracts/src/execution.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { operationTreatments, manifestHash } from "./run-manifest.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { type ModelSnapshot } from "../../model-client/src/catalog.js";
import type { ModelClient } from "../../model-client/src/contracts.js";
import { runEvalBuilderUnit } from "./builder-stage.js";
import { RunOperationStore } from "./operation.js";
import type { NativeLaneObserver } from "../../studio-runner/src/adapter.js";
import type { ModelPermits } from "./model-permits.js";

const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const unitPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;

/** Shared CLI/console entry point for one exact planned builder treatment. */
export async function executeFrozenBuilderCell(input: {
  root: string;
  operationId: string;
  unitId: string;
  modelClient?: ModelClient;
  snapshot?: ModelSnapshot;
  signal?: AbortSignal;
  /** Aborts when the run sends no new work. The build then stops before its next request. */
  dispatch?: AbortSignal;
  adapters?: ExecutionAdapters;
  lane?: NativeLaneObserver;
  /** The request permits of the run. */
  permits?: ModelPermits;
}) {
  if (!operationPattern.test(input.operationId) || !unitPattern.test(input.unitId))
    throw new Error("Builder execution needs opaque frozen operation and trial IDs");
  if ((input.modelClient === undefined) !== (input.snapshot === undefined))
    throw new Error("Injected builder transport and model snapshot must be supplied together");
  const manifest = await new RepositoryFiles(input.root).json<RunOperationManifest>(
    `.basalt-evals/eval-operations/${input.operationId}/manifest.json`,
  );
  const operation = new RunOperationStore(
    input.root,
    input.operationId,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const status = await operation.readForStage("builder", input.unitId);
  const treatment = operationTreatments(status.manifest).find((item) => item.id === input.unitId);
  if (!treatment) throw new Error("Builder trial is absent from the frozen operation");
  const frozen = status.manifest.modelSnapshots.find((item) => item.id === treatment.model.id);
  if (!frozen) throw new Error("Builder model is absent from the frozen operation");
  // The request carries the frozen endpoint set and its price ceiling, so no catalog read is
  // necessary before dispatch.
  const snapshot = input.snapshot ?? frozen;
  const client =
    input.modelClient ??
    (input.adapters ?? liveExecutionAdapters).model(status.manifest.modelSnapshots);
  if (
    snapshot.id !== frozen.id ||
    modelTreatmentIdentity(snapshot) !== modelTreatmentIdentity(frozen)
  )
    throw new Error("Builder model differs from its frozen endpoint and prices");
  return runEvalBuilderUnit({
    root: input.root,
    operation,
    unitId: input.unitId,
    treatment,
    modelClient: client,
    studio: (input.adapters ?? liveExecutionAdapters).studio,
    snapshot,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.dispatch ? { dispatch: input.dispatch } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.permits ? { permits: input.permits } : {}),
  });
}

/** The store of a frozen run, bound to the hash of its saved manifest. */
export async function frozenRunStore(root: string, operationId: string) {
  if (!operationPattern.test(operationId)) throw new Error("Invalid run operation ID");
  const manifest = await new RepositoryFiles(root).json<RunOperationManifest>(
    `.basalt-evals/eval-operations/${operationId}/manifest.json`,
  );
  return new RunOperationStore(root, operationId, manifestHash(manifest), manifest.inputHash);
}

export async function frozenRunStatus(root: string, operationId: string, verify = true) {
  const operation = await frozenRunStore(root, operationId);
  return verify ? operation.read() : operation.progress();
}

export async function frozenRunStageStatus(
  root: string,
  operationId: string,
  stage: RunStage,
  unitId: string,
) {
  return (await frozenRunStore(root, operationId)).readForStage(stage, unitId);
}
