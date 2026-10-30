import { recordExecutionFailure } from "../../artifact-store/src/failures.js";
import { ExecutionFault, unknownFailure } from "../../contracts/src/failure.js";
import { nativeStudioAdapter, type StudioAdapter } from "../../studio-runner/src/adapter.js";
import { capturePlan, frozenSequencePlan, manifestHash } from "./run-manifest.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import {
  assertStudioEvidence,
  contentHash,
  hashJson,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import {
  finalizeStudioEvidence,
  loadStudioSession,
  prepareBoundStudioSession,
} from "../../studio-runner/src/index.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import { RunOperationStore } from "./operation.js";
import { frozenRunStageStatus } from "./run-builder.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { sealedEvalCandidate } from "./sealed-candidate.js";

const opaque = /^[a-z0-9][a-z0-9-]{0,100}$/u;

/** One frozen native acquisition cell. An interrupted attempt is reconciled, never rerun. */
export async function executeFrozenCaptureCell(input: {
  root: string;
  operationId: string;
  cellId: string;
  signal?: AbortSignal;
  studioAdapter?: StudioAdapter;
  onWaiting?: () => Promise<void>;
  onAdmitted?: () => Promise<void>;
}): Promise<StudioEvidence> {
  if (!opaque.test(input.operationId) || !opaque.test(input.cellId))
    throw new Error("Capture needs opaque frozen operation and cell IDs");
  const root = resolve(input.root);
  const adapter = input.studioAdapter ?? nativeStudioAdapter;
  const status = await frozenRunStageStatus(root, input.operationId, "final_capture", input.cellId);
  const manifest = status.manifest;
  const cell = manifest.captureCells.find((item) => item.id === input.cellId);
  if (!cell) throw new Error("Capture cell is absent from the frozen operation");
  const operation = new RunOperationStore(
    root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const studioRelative = `.basalt-evals/eval-operations/${manifest.id}/capture/${cell.id}/studio`;
  const studio = resolve(root, studioRelative);
  const files = new RepositoryFiles(root);
  if (status.completedUnits.includes(`final_capture:${cell.id}`))
    return files.json<StudioEvidence>(`${studioRelative}/evidence.json`);
  const inFlight = (current: RunOperationStatus) =>
    current.inFlightUnits.some((unit) => unit.stage === "final_capture" && unit.unitId === cell.id);
  // Other units can be in flight. Only an interrupted attempt of this cell needs recovery.
  if (inFlight(status)) {
    if (
      (await files.exists(`${studioRelative}/native/remote-job.json`)) ||
      (await files.exists(`${studioRelative}/native/manifest.json`))
    )
      return recoverFrozenCaptureCell(root, operation, cell.id, adapter);
    await operation.append({
      kind: "not_dispatched",
      stage: "final_capture",
      unitId: cell.id,
      artifactHashes: [],
      reason:
        "Basalt did not send the observation to Studio before the stop. Resume the run to record it.",
      at: new Date().toISOString(),
    });
  }
  const { subject, task, candidate, workspaceRoot } = await sealedEvalCandidate(
    root,
    manifest.id,
    cell.treatmentId,
  );
  await assertExecutionImplementation(root, manifest);
  const identity = await adapter.identity(root);
  if (identity.connectorArtifactHash !== manifest.connectorArtifactHash)
    throw new Error(
      "The installed Basalt connector changed after this run started. Start a new run.",
    );
  // Admission records its queue time beside the session, so the cell directory comes first.
  await files.directory(`.basalt-evals/eval-operations/${manifest.id}/capture/${cell.id}`);
  const admission = await adapter.admit?.({
    root,
    directory: studio,
    purpose: "final_capture",
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onWaiting ? { onWaiting: input.onWaiting } : {}),
  });
  try {
    input.signal?.throwIfAborted();
    await input.onAdmitted?.();
    await operation.append({
      kind: "started",
      stage: "final_capture",
      unitId: cell.id,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
    try {
      const plan = capturePlan(manifest, cell.id);
      if (await files.exists(`${studioRelative}/session.json`)) {
        const retained = await loadStudioSession(studio);
        if (
          retained.candidateHash !== candidate.rootHash ||
          retained.collectionPlanHash !== hashJson(plan) ||
          retained.treatmentId !== subject.id ||
          retained.connectorSourceHash !== identity.connectorSourceHash ||
          retained.connectorArtifactHash !== manifest.connectorArtifactHash ||
          retained.expectedStudioVersion !== identity.studioVersion
        )
          throw new Error(
            "The prepared observation does not match this build, the Studio version or the Basalt connector. Start a new run.",
          );
        // Admission gives a prepared session only the lane of its connector port.
        if (admission && retained.connectorUrl !== admission.connectorUrl)
          throw new Error("The prepared observation and its Studio lane use different ports");
      } else
        await prepareBoundStudioSession({
          workspaceRoot,
          outputDirectory: studio,
          publicTask: task.publicTask,
          collectionPlan: plan,
          collectionPlanHash: hashJson(plan),
          treatmentId: subject.id,
          studioVersion: identity.studioVersion,
          candidate,
          connectorSourceHash: identity.connectorSourceHash,
          connectorArtifactHash: manifest.connectorArtifactHash,
          // The place reaches the connector of the admitted lane.
          ...(admission ? { connectorUrl: admission.connectorUrl } : {}),
        });
      const sequence = frozenSequencePlan(manifest, cell.id, candidate.rootHash);
      if (sequence) await files.writeJsonOnce(`${studioRelative}/sequence.json`, sequence);
      await adapter.run({
        root,
        directory: studio,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return await recoverFrozenCaptureCell(root, operation, cell.id, adapter);
    } catch (error) {
      await recordExecutionFailure(root, manifest.id, {
        ...(error instanceof ExecutionFault
          ? error.failure
          : unknownFailure(
              "final_capture",
              cell.id,
              error instanceof Error ? error.message : String(error),
            )),
        unit: { stage: "final_capture", id: cell.id },
      });
      const current = await operation.read();
      if (inFlight(current)) {
        try {
          return await recoverFrozenCaptureCell(root, operation, cell.id, adapter);
        } catch {
          // The original failure remains the cell's attribution when no complete signed receipt exists.
        }
        const dispatched = await readFile(resolve(studio, "native/remote-job.json")).then(
          () => true,
          (readError: NodeJS.ErrnoException) => {
            if (readError.code === "ENOENT") return false;
            throw readError;
          },
        );
        // Once a remote job was dispatched, absence of its local receipt is
        // uncertain execution. Leave the cell in flight and block another trial.
        const signed = await files.exists(`${studioRelative}/native/manifest.json`);
        if (!dispatched && !signed)
          await operation.append({
            kind: "not_dispatched",
            stage: "final_capture",
            unitId: cell.id,
            artifactHashes: [],
            reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            at: new Date().toISOString(),
          });
      }
      throw error;
    }
  } finally {
    await admission?.release();
  }
}

async function recoverFrozenCaptureCell(
  root: string,
  operation: RunOperationStore,
  cellId: string,
  adapter: StudioAdapter,
): Promise<StudioEvidence> {
  const studioRelative = `.basalt-evals/eval-operations/${operation.operationId}/capture/${cellId}/studio`;
  const studio = resolve(root, studioRelative);
  // Also reconcile a locally published receipt: a crash may have preceded native-lane release.
  try {
    await adapter.reconcile({ root, directory: studio });
  } catch (error) {
    // A lost job has no evidence and cannot send any. The observation is incomplete, not failed.
    if (!(error instanceof ExecutionFault) || error.failure.causeCode !== "studio_job_lost")
      throw error;
    const failure = { ...error.failure, unit: { stage: "final_capture", id: cellId } };
    await recordExecutionFailure(root, operation.operationId, failure);
    await operation.append({
      kind: "incomplete",
      stage: "final_capture",
      unitId: cellId,
      artifactHashes: [],
      reason: failure.explanation.slice(0, 500),
      at: new Date().toISOString(),
    });
    throw new ExecutionFault(failure);
  }
  const receiptBytes = await readFile(resolve(studio, "native/manifest.json"));
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
  try {
    const session = await loadStudioSession(studio);
    if (
      receipt.manifest.sessionId !== session.id ||
      receipt.manifest.candidateHash !== session.candidateHash ||
      receipt.manifest.collectionPlanHash !== session.collectionPlanHash
    )
      throw new Error("Native receipt belongs to a different frozen session");
    await verifyWorkerArtifacts(
      studio,
      receipt,
      await readFile(resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"), "utf8"),
    );
  } catch (_cause) {
    const failure = {
      ...unknownFailure(
        "final_capture",
        cellId,
        "Basalt cannot verify the signed evidence from Studio. Check the evidence signing key in Settings.",
      ),
      causeCode: "native_evidence_integrity",
      category: "integrity" as const,
      dependency: contentHash(receiptBytes),
      evidenceRefs: [contentHash(receiptBytes)],
    };
    await recordExecutionFailure(root, operation.operationId, failure);
    throw new ExecutionFault(failure);
  }
  if (receipt.manifest.status !== "complete") {
    const failure = {
      ...(receipt.manifest.failureRecord ??
        unknownFailure("final_capture", cellId, "Studio did not finish the observation.")),
      unit: { stage: "final_capture", id: cellId },
      evidenceRefs: [
        contentHash(receiptBytes),
        ...(receipt.manifest.failureRecord?.evidenceRefs ?? []),
      ],
    };
    await recordExecutionFailure(root, operation.operationId, failure);
    const reason =
      "Studio did not finish the observation. Cause: " + String(receipt.manifest.failure);
    await operation.append({
      kind: "incomplete",
      stage: "final_capture",
      unitId: cellId,
      artifactHashes: [contentHash(receiptBytes)],
      reason: reason.slice(0, 500),
      at: new Date().toISOString(),
    });
    throw new ExecutionFault(failure);
  }
  const evidence = await finalizeStudioEvidence({ sessionDirectory: studio });
  assertStudioEvidence(evidence);
  await operation.append({
    kind: "completed",
    stage: "final_capture",
    unitId: cellId,
    artifactHashes: [contentHash(receiptBytes), hashJson(evidence)],
    reason: null,
    at: new Date().toISOString(),
  });
  return evidence;
}
