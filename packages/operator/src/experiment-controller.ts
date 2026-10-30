import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { nextProtocolDecision } from "../../experiments/src/controller.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { RunOperationStore } from "./operation.js";
import { protocolEvidence, verifyProtocolGate } from "./protocol-evidence.js";
import { frozenRunStatus } from "./run-builder.js";
import { manifestHash } from "./run-manifest.js";

/** A label write only wakes the worker when a complete prerequisite can advance. */
export async function experimentReviewReady(root: string, operationId: string) {
  const status = await frozenRunStatus(root, operationId, false);
  if (!status.manifest.protocol || status.finished || status.stopped || status.inFlightUnits.length)
    return false;
  const operation = new RunOperationStore(
    root,
    operationId,
    manifestHash(status.manifest),
    status.manifest.inputHash,
  );
  const state = await protocolEvidence({
    root,
    manifest: status.manifest,
    events: status.events,
    spending: await operation.ledger.read(),
  });
  return nextProtocolDecision(state.plan, state.evidence) !== null;
}

/** Controllers propose decisions; the operator verifies, journals and seals their receipts. */
export async function advanceExperimentController(root: string, operationId: string) {
  const status = await frozenRunStatus(root, operationId);
  if (
    !status.manifest.protocol ||
    status.stopped ||
    status.finished ||
    status.inFlightUnits.some((unit) => !["review", "selection"].includes(unit.stage))
  )
    return false;
  const manifest = status.manifest,
    operation = new RunOperationStore(
      root,
      operationId,
      manifestHash(manifest),
      manifest.inputHash,
    );
  const files = new RepositoryFiles(root);
  // A gate runs alone, so at most one gate is in flight.
  const gate = status.inFlightUnits[0] ?? null;
  if (gate) {
    const path = `.basalt-evals/eval-operations/${operationId}/gates/${gate.unitId}.json`;
    const retained = await files.optional(path);
    if (retained) {
      const receipt = {
        kind: "completed" as const,
        stage: gate.stage,
        unitId: gate.unitId,
        artifactHashes: [hashJson(retained)],
        reason: null,
        at: new Date().toISOString(),
      };
      await assertExecutionImplementation(root, manifest);
      await verifyProtocolGate({
        root,
        manifest,
        event: {
          ...receipt,
          schema: "basalt-evals/run-operation-event",
          id: "",
          sequence: status.events.length + 1,
          previousHash: status.events.at(-1)!.id,
        },
        events: status.events,
        spending: await operation.ledger.read(),
      });
      await operation.append(receipt);
      return true;
    }
  }
  const state = await protocolEvidence({
    root,
    manifest,
    events: status.events,
    spending: await operation.ledger.read(),
  });
  const decision = nextProtocolDecision(state.plan, state.evidence);
  if (!decision) return false;
  await assertExecutionImplementation(root, manifest);
  if (gate && (gate.stage !== decision.kind || gate.unitId !== decision.gateId))
    throw new Error("Pending selection differs from its frozen gate");
  if (!gate)
    await operation.append({
      kind: "started",
      stage: decision.kind,
      unitId: decision.gateId,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  const receipt = {
    manifestHash: manifestHash(manifest),
    ...decision,
    evidence: state.evidence,
    reviewRecordIds: state.reviewRecordIds,
  };
  const path = `.basalt-evals/eval-operations/${operationId}/gates/${decision.gateId}.json`;
  try {
    await files.writeJson(path, receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(receipt))
      throw new Error("Sealed protocol selection changed");
  }
  await operation.append({
    kind: "completed",
    stage: decision.kind,
    unitId: decision.gateId,
    artifactHashes: [hashJson(receipt)],
    reason: null,
    at: new Date().toISOString(),
  });
  return true;
}
