import { ensureSourceAnalysis } from "../../graders/src/source-analysis.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { frozenRunStatus } from "./run-builder.js";
import { RunOperationStore } from "./operation.js";
import { operationSubject, manifestHash } from "./run-manifest.js";
import { readRegisteredSource } from "./sources.js";

export async function sealRegisteredSubject(
  root: string,
  operationId: string,
  subjectId: string,
): Promise<void> {
  const status = await frozenRunStatus(root, operationId);
  const manifest = status.manifest;
  const subject = operationSubject(manifest, subjectId);
  if (!subject.sourceId) throw new Error("Only registered sources use a source-sealing action");
  if (status.completedUnits.includes(`seal:${subject.id}`)) return;
  await assertExecutionImplementation(root, manifest);
  const operation = new RunOperationStore(
    root,
    operationId,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const inFlight = status.inFlightUnits.some(
    (unit) => unit.stage === "seal" && unit.unitId === subjectId,
  );
  const { source, workspaceRoot } = await readRegisteredSource(root, subject.sourceId);
  if (!inFlight)
    await operation.append({
      kind: "started",
      stage: "seal",
      unitId: subjectId,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  // The code checks read this analysis later. A failure here does not stop the seal, and a code
  // check makes the analysis again.
  await ensureSourceAnalysis(root, workspaceRoot, source.candidate).catch(() => undefined);
  await operation.append({
    kind: "completed",
    stage: "seal",
    unitId: subjectId,
    artifactHashes: [source.id, source.candidate.rootHash],
    reason: null,
    at: new Date().toISOString(),
  });
}
