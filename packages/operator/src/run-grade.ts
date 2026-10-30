import type { RunCriterionArtifact } from "../../contracts/src/execution.js";
import { operationSource } from "./sources.js";
import { capturePlan, subjectEval, manifestHash } from "./run-manifest.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, type StudioEvidence } from "../../contracts/src/index.js";
import { evaluateDeterministicCriteria } from "../../graders/src/index.js";
import { ensureSourceAnalysis, readsSourceAnalysis } from "../../graders/src/source-analysis.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import { RunOperationStore } from "./operation.js";
import { frozenRunStageStatus } from "./run-builder.js";
import { assertExecutionImplementation } from "./execution-guard.js";

const opaque = /^[a-z0-9][a-z0-9-]{0,100}$/u;

/** Execute one fixed criterion from signed final evidence; no model call is involved. */
export async function executeFrozenDeterministicGradingCell(input: {
  root: string;
  operationId: string;
  cellId: string;
}): Promise<RunCriterionArtifact> {
  if (!opaque.test(input.operationId) || !opaque.test(input.cellId))
    throw new Error("Grading needs opaque frozen operation and criterion cell IDs");
  const root = resolve(input.root);
  const status = await frozenRunStageStatus(root, input.operationId, "grading", input.cellId);
  const manifest = status.manifest;
  const cell = manifest.gradingCells.find((item) => item.id === input.cellId);
  if (!cell || cell.method !== "deterministic")
    throw new Error("This cell is not a frozen deterministic grading method");
  const operation = new RunOperationStore(
    root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const files = new RepositoryFiles(root);
  const artifactFile = `.basalt-evals/eval-operations/${manifest.id}/grading/${cell.id}/result.json`;
  if (status.completedUnits.includes(`grading:${cell.id}`))
    return files.json<RunCriterionArtifact>(artifactFile);
  await assertExecutionImplementation(root, manifest);
  const captureCell = manifest.captureCells.find((item) => item.id === cell.captureCellId)!;
  const capture = status.events.find(
    (event) =>
      event.stage === "final_capture" &&
      event.unitId === captureCell.id &&
      event.kind === "completed",
  );
  if (!capture) throw new Error("Grading needs its exact signed final capture");
  const inFlight = status.inFlightUnits.some(
    (unit) => unit.stage === "grading" && unit.unitId === cell.id,
  );
  const task = await loadRegisteredTask(
    root,
    `.basalt-evals/eval-revisions/${subjectEval(manifest, captureCell.treatmentId).id}`,
  );
  const source = await operationSource(root, manifest, captureCell.treatmentId);
  const evidenceDirectory = `.basalt-evals/eval-operations/${manifest.id}/capture/${captureCell.id}/studio`;
  const evidence = await files.json<StudioEvidence>(`${evidenceDirectory}/evidence.json`);
  const cellCriterion = task.evaluator.deterministic.filter((item) => item.id === cell.criterionId);
  const results = await evaluateDeterministicCriteria({
    workspaceRoot: source.workspaceRoot,
    evaluator: { ...task.evaluator, studio: capturePlan(manifest, captureCell.id) },
    candidate: source.candidate,
    treatmentId: captureCell.treatmentId,
    evidence,
    analysis: readsSourceAnalysis(cellCriterion)
      ? await ensureSourceAnalysis(root, source.workspaceRoot, source.candidate)
      : undefined,
    evidenceDirectory: files.path(evidenceDirectory),
  });
  const criterion = results.find((item) => item.criterionId === cell.criterionId);
  if (!criterion) throw new Error("Frozen deterministic criterion is absent from the evaluator");
  const artifact: RunCriterionArtifact = {
    schema: "basalt-evals/run-criterion-artifact",
    operationId: manifest.id,
    cellId: cell.id,
    treatmentId: captureCell.treatmentId,
    candidateHash: source.candidate.rootHash,
    captureEvidenceHash: capture.artifactHashes[1]!,
    criterion,
    decisionAuthority: "deterministic",
    judgment: null,
    modelResponseHash: null,
  };
  if (!inFlight)
    await operation.append({
      kind: "started",
      stage: "grading",
      unitId: cell.id,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  try {
    await files.writeJson(artifactFile, artifact);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(artifactFile)) !== hashJson(artifact))
      throw new Error("Saved deterministic grading differs from the fixed evaluator result");
  }
  await operation.append({
    kind: "completed",
    stage: "grading",
    unitId: cell.id,
    artifactHashes: [hashJson(artifact)],
    reason: criterion.outcome === "incomplete" ? criterion.explanation.slice(0, 500) : null,
    at: new Date().toISOString(),
  });
  return artifact;
}
