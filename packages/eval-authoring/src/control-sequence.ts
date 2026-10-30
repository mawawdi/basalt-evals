import { hashJson } from "../../contracts/src/index.js";
import type { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { assertSequencePlan, type SequencePlan } from "../../studio-runner/src/sequence.js";
import type { EvalRevision } from "./compiler.js";

export function controlSequencePlan(
  revision: EvalRevision,
  candidateHash: string,
  implementationCommit: string,
): SequencePlan | null {
  return revision.privateEvaluator.sequence
    ? {
        schema: "basalt-evals/sequence-plan",
        suiteHash: revision.id,
        sourceHash: candidateHash,
        implementationCommit,
        viewId: "control",
        ...revision.privateEvaluator.sequence,
      }
    : null;
}

export async function readControlSequencePlan(
  files: RepositoryFiles,
  base: string,
  revision: EvalRevision,
  candidateHash: string,
) {
  if (!revision.privateEvaluator.sequence) return null;
  const plan = await files.json<SequencePlan>(`${base}/studio/sequence.json`);
  assertSequencePlan(plan);
  if (
    hashJson(plan) !==
    hashJson(controlSequencePlan(revision, candidateHash, plan.implementationCommit))
  )
    throw new Error("Control sequence differs from its frozen eval or source");
  return plan;
}
