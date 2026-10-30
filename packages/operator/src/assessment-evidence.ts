import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { hash } from "../../contracts/src/validation.js";
import type { EvidenceSet } from "../../contracts/src/assessments.js";
import type { RunJudgmentBatch } from "../../contracts/src/execution.js";
import { judgmentMaterial } from "./judgment-material.js";
import { frozenRunStageStatus } from "./run-builder.js";
import { readOperationEvidence, releasedEvidenceItems } from "./evidence.js";
import { manifestHash } from "./run-manifest.js";

/**
 * One verified, released capture: its stage status, its frozen cell and its completion
 * receipt. Each judgment of retained evidence reads its captures through this check.
 */
export async function releasedCapture(root: string, operationId: string, cellId: string) {
  const status = await frozenRunStageStatus(root, operationId, "final_capture", cellId);
  const capture = status.manifest.captureCells.find((cell) => cell.id === cellId);
  if (!capture) throw new Error("The observation is not in the frozen run");
  const receipt = status.events.find(
    (event) =>
      event.kind === "completed" && event.stage === "final_capture" && event.unitId === capture.id,
  );
  if (!receipt)
    throw new Error(
      "The planned observation of this build did not finish. Choose a build with complete evidence.",
    );
  const evidence = await readOperationEvidence(root, operationId, {
    subjectId: capture.treatmentId,
  });
  const item = evidence.items.find(
    (item) => item.viewId === capture.viewId && item.partition === capture.partition,
  );
  if (!item || !(await releasedEvidenceItems(root, { ...evidence, items: [item] }, item.id)).length)
    throw new Error("The selected evidence is hidden or not available. Choose another build.");
  return { status, capture, receipt };
}

export async function resolveAssessmentEvidence(
  root: string,
  operationId: string,
  batch: Omit<RunJudgmentBatch, "configuration">,
) {
  if (batch.substitution?.kind === "unrelated")
    throw new Error("Retained-evidence assessment cannot borrow another evaluation's images");
  // A donor or twin capture must pass the same capture and release checks as the target.
  const released = (cellId: string) => releasedCapture(root, operationId, cellId);
  const { status, capture, receipt } = await released(batch.captureCellId);
  const donorId = batch.substitution?.donorCaptureCellId ?? null;
  const donorReceipt = donorId ? (await released(donorId)).receipt : null;
  const material = await judgmentMaterial(root, status.manifest, batch);
  const body = {
    operationId,
    manifestHash: manifestHash(status.manifest),
    revisionId: batch.revisionId,
    subjectId: capture.treatmentId,
    captureId: capture.id,
    captureReceiptHash: hashJson(receipt),
    donorReceiptHash: donorReceipt ? hashJson(donorReceipt) : null,
    evidenceHash: receipt.artifactHashes[1]!,
    sourceHash: material.candidateHash,
    rubricHash: material.rubricHash,
    criterionIds: batch.criterionIds,
    materialHash: hashJson(material),
    presentation: batch.presentation,
    condition: batch.substitution?.kind ?? ("original" as const),
  };
  const set: EvidenceSet = { ...body, id: hashJson(body) };
  return { set, material };
}

export async function saveEvidenceSet(root: string, set: EvidenceSet) {
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/evidence-sets/${set.id}.json`;
  await files.writeJsonOnce(path, set);
}

export async function readAssessmentEvidence(root: string, id: string, batch: RunJudgmentBatch) {
  hash(id);
  const retained = await new RepositoryFiles(root).json<EvidenceSet>(
    `.basalt-evals/evidence-sets/${id}.json`,
  );
  const { id: savedId, ...body } = retained;
  if (id !== savedId || hashJson(body) !== id) throw new Error("Retained evidence set changed");
  const current = await resolveAssessmentEvidence(root, retained.operationId, batch);
  if (current.set.id !== id)
    throw new Error("The evidence changed after the preview. Make a new preview.");
  return current;
}
