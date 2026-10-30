import { resolve } from "node:path";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import { operationSubject, subjectEval } from "./run-manifest.js";
import { operationSource } from "./sources.js";
import { frozenRunStatus, frozenRunStageStatus } from "./run-builder.js";

/** Resolve one sealed subject by opaque identities, preserving its actual source provenance. */
export async function sealedEvalCandidate(
  rootInput: string,
  operationId: string,
  treatmentId: string,
) {
  const root = resolve(rootInput);
  const manifest = (await frozenRunStatus(root, operationId, false)).manifest;
  const subject = operationSubject(manifest, treatmentId);
  const stage = subject.sourceId ? "seal" : "builder";
  const status = await frozenRunStageStatus(root, operationId, stage, treatmentId);
  if (!status.completedUnits.includes(`${stage}:${subject.id}`))
    throw new Error("Candidate needs an exact completed source receipt");
  const task = await loadRegisteredTask(
    root,
    `.basalt-evals/eval-revisions/${subjectEval(manifest, subject.id).id}`,
  );
  const source = await operationSource(root, manifest, subject.id);
  const treatment = subject.builder;
  if (
    (source.agentRun && source.agentRun.status !== "locally_eligible") ||
    (treatment &&
      (task.id !== treatment.task.id ||
        task.publicTaskHash !== treatment.task.publicTaskHash ||
        task.seedHash !== treatment.task.seedHash)) ||
    source.candidate.projectFile !== task.publicTask.seed.projectFile
  )
    throw new Error("Saved candidate differs from its sealed treatment");
  return { root, status, manifest, subject, treatment, task, ...source };
}
