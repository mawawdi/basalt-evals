import { runJudgmentBatch } from "../../agent-runtime/src/batch-grading.js";
import { ModelRefusalError, ProviderPauseError } from "../../agent-runtime/src/retries.js";
import { recordExecutionFailure, recordFailureStack } from "../../artifact-store/src/failures.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { providerPauseSentence } from "../../contracts/src/console.js";
import type { PauseRecord, RunOperationStatus } from "../../contracts/src/execution.js";
import { hashJson, MAX_PROVIDER_PAUSES } from "../../contracts/src/index.js";
import { modelDependency, ProviderHoldError } from "../../model-client/src/bounded-client.js";
import {
  ModelRequestAdmissionError,
  ModelRequestPendingError,
} from "../../model-client/src/contracts.js";
import { SpendingCeilingError } from "../../model-client/src/ledger.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { assembleJudgmentArtifact } from "./judgment-artifact.js";
import { judgmentMaterial } from "./judgment-material.js";
import { acknowledgedOrdinals, providerHolds, RunOperationStore, unitHold } from "./operation.js";
import { frozenRunStageStatus } from "./run-builder.js";
import { manifestHash } from "./run-manifest.js";
import { appendUnitLog } from "./unit-log.js";
import type { ModelPermits } from "./model-permits.js";

export async function executeFrozenJudgmentBatch(input: {
  root: string;
  operationId: string;
  batchId: string;
  signal?: AbortSignal;
  /** Aborts when the run sends no new work. The batch then stops before its next request. */
  dispatch?: AbortSignal;
  adapters?: ExecutionAdapters;
  /** The request permits of the run. Each new request of the batch waits for a permit. */
  permits?: ModelPermits;
}) {
  const status = await frozenRunStageStatus(
    input.root,
    input.operationId,
    "judgment",
    input.batchId,
  );
  const manifest = status.manifest;
  const batch = manifest.judgmentBatches.find((batch) => batch.id === input.batchId);
  if (!batch) throw new Error("Judgment needs a frozen batch identity");
  const operation = new RunOperationStore(
    input.root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const files = new RepositoryFiles(input.root),
    path = `.basalt-evals/eval-operations/${manifest.id}/judgments/${batch.id}.json`;
  if (status.completedUnits.includes(`judgment:${batch.id}`)) return files.json(path);
  await assertExecutionImplementation(input.root, manifest);
  const adapters = input.adapters ?? liveExecutionAdapters;
  // The request carries the frozen endpoint set and its price ceiling, so no catalog read is
  // necessary before dispatch.
  const snapshot = manifest.modelSnapshots.find(
    (model) => model.id === batch.configuration.modelId,
  )!;
  const material = await judgmentMaterial(input.root, manifest, batch);
  if (material.images.length && !snapshot.inputModalities.includes("image"))
    throw new Error("The frozen judge model cannot read images. Make a new preview.");
  const inFlight = (current: RunOperationStatus) =>
    current.inFlightUnits.some((unit) => unit.stage === "judgment" && unit.unitId === batch.id);
  const unit = { stage: "judgment" as const, unitId: batch.id };
  const log = (entry: Parameters<typeof appendUnitLog>[3]) =>
    appendUnitLog(input.root, manifest.id, unit, entry);
  // A resumed judgment acknowledges the ordinals of its saved pausing failures, so its client
  // sends the next ordinal instead of a replay of the saved failure.
  const pauses = status.events.filter(
    (event) =>
      event.kind === "provider_paused" && event.stage === "judgment" && event.unitId === batch.id,
  );
  const acknowledged = acknowledgedOrdinals(status, batch.id);
  // An interrupted batch continues from its saved receipts; other units can be in flight.
  if (!inFlight(status))
    await operation.append({
      kind: "started",
      stage: "judgment",
      unitId: batch.id,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  await log({ event: "started", model: batch.configuration.modelId, acknowledged });
  const permits = input.permits;
  try {
    const result = await runJudgmentBatch({
      ...material,
      configuration: batch.configuration,
      presentation: batch.presentation,
      stage: `judgment:${batch.id}`,
      client: adapters.model(manifest.modelSnapshots),
      snapshot,
      ledger: operation.ledger,
      beforeRequest: async (phase) => {
        await assertExecutionImplementation(input.root, manifest);
        const current = await operation.progress();
        if (current.stopped || !inFlight(current) || input.dispatch?.aborted)
          throw new Error(
            "The judge checks stopped before Basalt sent the next request. Resume the run to continue.",
          );
        // A provider pause of another unit holds this judgment before its next reservation.
        const hold = phase === "admission" && unitHold(providerHolds(current), manifest, unit);
        if (hold) throw new ProviderHoldError(hold);
      },
      acknowledged,
      ...(permits
        ? { permit: (signal?: AbortSignal) => permits.acquire(snapshot.id, signal) }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const artifact = assembleJudgmentArtifact(manifest, batch, material, result);
    try {
      await files.writeJson(path, artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashJson(await files.json(path)) !== hashJson(artifact))
        throw new Error("Retained judgment changed during recovery");
    }
    await operation.append({
      kind: "completed",
      stage: "judgment",
      unitId: batch.id,
      artifactHashes: [hashJson(artifact)],
      reason: null,
      at: new Date().toISOString(),
    });
    await log({ event: "completed" });
    return artifact;
  } catch (error) {
    const current = await operation.progress();
    // A stop, a drain or an unknown charge keeps the batch in flight for a later resume.
    if (
      error instanceof ModelRequestPendingError ||
      (await operation.ledger.unownedPending()).length ||
      current.stopped ||
      input.signal?.aborted ||
      input.dispatch?.aborted
    ) {
      await log({ event: "stopped", reason: error instanceof Error ? error.name : "stop" });
      throw error;
    }
    const hold =
      error instanceof ModelRequestAdmissionError && error.cause instanceof ProviderHoldError
        ? error.cause.record
        : null;
    // An account, model or persistent failure pauses the judgment until a person resumes the
    // run. After its limit of pauses, the judgment ends as incomplete.
    if ((error instanceof ProviderPauseError || hold) && pauses.length < MAX_PROVIDER_PAUSES) {
      const scope = hold?.scope ?? (error as ProviderPauseError).scope;
      const errorClass = hold?.errorClass ?? (error as ProviderPauseError).errorClass;
      const dependency =
        hold?.dependency ?? (scope === "account" ? null : modelDependency(snapshot));
      const reason = providerPauseSentence([{ scope, errorClass }])!;
      const failure = await recordExecutionFailure(input.root, manifest.id, {
        causeCode: errorClass,
        category: "provider",
        dependency,
        unit: { stage: "judgment", id: batch.id },
        evidenceRefs: [],
        recoveryActions: ["resume"],
        explanation: reason,
      });
      const record: PauseRecord = {
        scope,
        dependency,
        errorClass,
        failureId: failure.id,
        ordinal: hold ? null : (error as ProviderPauseError).ordinal,
      };
      await operation.appendProviderPause({ ...unit, record, reason });
      await log({ event: "provider_paused", ...record, held: hold !== null });
      throw error;
    }
    // The limit is shared: an unaffordable request pauses this batch until the limit rises.
    if (error instanceof SpendingCeilingError) {
      await operation.append({
        kind: "paused",
        stage: "judgment",
        unitId: batch.id,
        // Only a new authorization changes this hash. Charges of other units do not change it.
        artifactHashes: [hashJson((await operation.ledger.read()).authorizations)],
        reason:
          "The next judge check needs a higher spending limit. Increase the spending limit to continue.",
        at: new Date().toISOString(),
      });
      throw error;
    }
    // A refusal of the judge is an incomplete check, never a failed build. Each other unknown
    // failure keeps its redacted stack.
    const refusal = error instanceof ModelRefusalError;
    const known = refusal || error instanceof ProviderPauseError || hold !== null;
    const stack = known ? null : await recordFailureStack(input.root, manifest.id, error);
    if (stack)
      await recordExecutionFailure(input.root, manifest.id, {
        causeCode: "unclassified",
        category: "unknown",
        dependency: null,
        unit: { stage: "judgment", id: batch.id },
        evidenceRefs: [stack],
        recoveryActions: ["inspect"],
        explanation: String(error).slice(0, 500),
      });
    await operation.append({
      kind: "incomplete",
      stage: "judgment",
      unitId: batch.id,
      artifactHashes: [],
      reason: refusal ? "judge_refusal" : String(error).slice(0, 500),
      at: new Date().toISOString(),
    });
    await log({ event: "incomplete", reason: refusal ? "judge_refusal" : null, stack });
    throw error;
  }
}
