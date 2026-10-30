import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  type CriterionResult,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { evaluateDeterministicCriteria } from "../../graders/src/index.js";
import { ensureSourceAnalysis, readsSourceAnalysis } from "../../graders/src/source-analysis.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import { releasedCapture } from "./assessment-evidence.js";
import { capturePlan } from "./run-manifest.js";
import { operationSource } from "./sources.js";

/** The code checks of a revision on one saved observation, or the reason that they cannot run. */
type SavedCodeChecks =
  | {
      status: "checked";
      /** The partition of the observation. A caller records a holdout look for `withheld`. */
      partition: "development" | "withheld";
      candidateHash: string;
      evidenceHash: string;
      results: CriterionResult[];
    }
  | {
      /** Studio observed the build with another plan, so a code check needs a new observation. */
      status: "plan_changed";
      savedPlanHash: string;
      targetPlanHash: string;
    };

/**
 * Run the code checks of a revision again on the signed evidence of one saved observation. A
 * code check reads only fixed rules and saved evidence, so it makes no model request and has no
 * cost. The check verifies the signed worker artifacts first. A changed Studio plan returns
 * `plan_changed` before any check, because a check binds its evidence to one plan.
 */
export async function savedCodeChecks(input: {
  root: string;
  operationId: string;
  captureCellId: string;
  revision: EvalRevision;
}): Promise<SavedCodeChecks> {
  const root = resolve(input.root);
  const { status, capture, receipt } = await releasedCapture(
    root,
    input.operationId,
    input.captureCellId,
  );
  const manifest = status.manifest;
  const studio = `.basalt-evals/eval-operations/${manifest.id}/capture/${capture.id}/studio`;
  const receiptBytes = await readFile(resolve(root, studio, "native/manifest.json"));
  if (contentHash(receiptBytes) !== receipt.artifactHashes[0])
    throw new Error("The signed receipt of the observation differs from its completion record");
  const signed = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
  await verifyWorkerArtifacts(
    resolve(root, studio),
    signed,
    await readFile(resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"), "utf8"),
  );
  const evidence = await new RepositoryFiles(root).json<StudioEvidence>(`${studio}/evidence.json`);
  const savedPlanHash = hashJson(capturePlan(manifest, capture.id));
  if (
    hashJson(evidence) !== receipt.artifactHashes[1] ||
    signed.manifest.status !== "complete" ||
    signed.manifest.candidateHash !== evidence.candidateHash ||
    signed.manifest.collectionPlanHash !== savedPlanHash ||
    evidence.collectionPlanHash !== savedPlanHash
  )
    throw new Error("The saved evidence differs from its signed receipt or its frozen plan");
  const targetPlanHash = hashJson(input.revision.privateEvaluator.studio);
  if (savedPlanHash !== targetPlanHash)
    return { status: "plan_changed", savedPlanHash, targetPlanHash };
  const source = await operationSource(root, manifest, capture.treatmentId);
  const results = await evaluateDeterministicCriteria({
    workspaceRoot: source.workspaceRoot,
    evaluator: input.revision.privateEvaluator,
    candidate: source.candidate,
    treatmentId: capture.treatmentId,
    evidence,
    analysis: readsSourceAnalysis(input.revision.privateEvaluator.deterministic)
      ? await ensureSourceAnalysis(root, source.workspaceRoot, source.candidate)
      : undefined,
    evidenceDirectory: resolve(root, studio),
  });
  return {
    status: "checked",
    partition: capture.partition,
    candidateHash: source.candidate.rootHash,
    evidenceHash: receipt.artifactHashes[1]!,
    results,
  };
}
