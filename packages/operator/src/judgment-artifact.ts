import type { RunJudgmentBatch, RunOperationManifest } from "../../contracts/src/execution.js";
import { runJudgmentBatch } from "../../agent-runtime/src/batch-grading.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { retainedResponseClient } from "../../model-client/src/recovery.js";
import type { DurableSpendLedger } from "../../model-client/src/ledger.js";

import { judgmentMaterial } from "./judgment-material.js";
import { manifestHash } from "./run-manifest.js";

export interface RunJudgmentArtifact {
  operationId: string;
  batchId: string;
  manifestHash: string;
  candidateHash: string;
  rubricHash: string;
  provenance: Awaited<ReturnType<typeof judgmentMaterial>>["provenance"];
  decisions: Awaited<ReturnType<typeof runJudgmentBatch>>["decisions"];
  decisionAuthorities: Awaited<ReturnType<typeof runJudgmentBatch>>["decisionAuthorities"];
  observation: Awaited<ReturnType<typeof runJudgmentBatch>>["observation"];
  /** The report of the guard. Null when no model read the build output. */
  addressedToEvaluator: Awaited<ReturnType<typeof runJudgmentBatch>>["addressedToEvaluator"];
  responseHashes: string[];
  costUsd: number | null;
}
export function assembleJudgmentArtifact(
  manifest: RunOperationManifest,
  batch: RunJudgmentBatch,
  material: Awaited<ReturnType<typeof judgmentMaterial>>,
  result: Awaited<ReturnType<typeof runJudgmentBatch>>,
): RunJudgmentArtifact {
  return {
    operationId: manifest.id,
    batchId: batch.id,
    manifestHash: manifestHash(manifest),
    candidateHash: material.candidateHash,
    rubricHash: material.rubricHash,
    provenance: material.provenance,
    decisions: result.decisions,
    decisionAuthorities: result.decisionAuthorities,
    observation: result.observation,
    addressedToEvaluator: result.addressedToEvaluator,
    responseHashes: result.responseHashes,
    costUsd: result.responses.some((response) => response.usage.costUsd === null)
      ? null
      : result.responses.reduce((sum, response) => sum + response.usage.costUsd!, 0),
  };
}
export async function verifyJudgmentArtifact(
  root: string,
  manifest: RunOperationManifest,
  batchId: string,
  artifactHash: string,
  ledger: DurableSpendLedger,
  /** The ordinals of the saved failures that paused the batch before a resume. */
  acknowledged: number[] = [],
) {
  const batch = manifest.judgmentBatches.find((item) => item.id === batchId);
  if (!batch) throw new Error("Judgment is absent from the frozen manifest");
  const files = new RepositoryFiles(root);
  const saved = await files.json<RunJudgmentArtifact>(
    `.basalt-evals/eval-operations/${manifest.id}/judgments/${batch.id}.json`,
  );
  if (hashJson(saved) !== artifactHash) throw new Error("Judgment artifact changed");
  const material = await judgmentMaterial(root, manifest, batch);
  const snapshot = manifest.modelSnapshots.find(
    (model) => model.id === batch.configuration.modelId,
  )!;
  const client = retainedResponseClient(manifest.modelSnapshots);
  const result = await runJudgmentBatch({
    ...material,
    configuration: batch.configuration,
    presentation: batch.presentation,
    stage: `judgment:${batch.id}`,
    client,
    ledger,
    snapshot,
    replayOnly: true,
    acknowledged,
  });
  if (hashJson(assembleJudgmentArtifact(manifest, batch, material, result)) !== artifactHash)
    throw new Error(
      "Judgment differs from its exact evidence, rubric or retained billed responses",
    );
  return saved;
}
