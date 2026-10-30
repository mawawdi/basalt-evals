import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { criterionMaterial } from "./criterion-material.js";
import { renderedEvidence } from "../../studio-runner/src/rendered-evidence.js";
import { renderedSelection } from "./rendered-selection.js";
import { readControlSequencePlan } from "./control-sequence.js";
import {
  hashJson,
  unscaledEvidenceLayer,
  type CriterionResult,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { JUDGMENT_RETRIES } from "../../model-client/src/quote.js";
import { RATE_LIMIT_WAITS_MS } from "../../model-client/src/bounded-client.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import {
  modelTurnRequestHash,
  type ModelTurnResult,
  type ModelTurnRequest,
  type ModelClientDescriptor,
} from "../../model-client/src/contracts.js";
import type { EvalRevision } from "./compiler.js";
import {
  batchJudgmentRequest,
  parseBatchJudgment,
  type BatchRequestConfiguration,
} from "./batch-judgment.js";
import { qualitativeCriteria, scoringCriteria, scoringPresentation } from "./scoring.js";

/**
 * True for an ordinal that an accepted reference judgment can have. Each answer with a broken
 * structure can get one more request, and the client tries each request again after a rate
 * limit. Thus the largest ordinal is the product of the two numbers of tries.
 */
export function isReferenceJudgmentOrdinal(ordinal: number): boolean {
  return (
    Number.isSafeInteger(ordinal) &&
    ordinal >= 1 &&
    ordinal <= (1 + JUDGMENT_RETRIES) * (1 + RATE_LIMIT_WAITS_MS.length)
  );
}

export interface ControlJudgment {
  operationId: string;
  ledgerContextHash: string;
  candidateHash: string;
  evidenceHash: string;
  stage: string;
  /** Ordinal of the accepted request; earlier ordinals were rate-limited or malformed attempts. */
  ordinal: number;
  request: ModelTurnRequest;
  transport: ModelClientDescriptor;
  response: ModelTurnResult;
  criterion: CriterionResult;
}

/** Reference expectations remain hypotheses; this is the same scorer as ordinary results. */
export function criterionResult(
  revision: EvalRevision,
  criterionId: string,
  response: ModelTurnResult,
  evidenceHashes: string[],
): CriterionResult {
  const criterion = qualitativeCriteria(revision).find((item) => item.id === criterionId);
  if (!criterion) throw new Error("Unknown reference-test criterion");
  const layer = revision.privateEvaluator.codeQuality.some((item) => item.id === criterionId)
    ? "code"
    : "evidence" in criterion
      ? unscaledEvidenceLayer(criterion.evidence)
      : "visual";
  const decision = parseBatchJudgment(
    response,
    scoringCriteria(
      revision,
      qualitativeCriteria(revision).map((item) => item.id),
    ),
  ).decisions.find((item) => item.criterionId === criterionId)!;
  return {
    criterionId,
    layer,
    outcome:
      decision.verdict === "insufficient"
        ? "incomplete"
        : "anchors" in criterion
          ? decision.score === null || criterion.minimumPassingScore === null
            ? "incomplete"
            : decision.score >= criterion.minimumPassingScore
              ? "verified"
              : "rejected"
          : decision.verdict === "satisfied"
            ? "verified"
            : "rejected",
    ...(decision.score === null ? {} : { score: decision.score }),
    explanation: decision.rationale,
    evidence: evidenceHashes,
    observed: null,
  };
}

export async function controlJudgmentInput(
  input: {
    root: string;
    base: string;
    revision: EvalRevision;
    configuration: BatchRequestConfiguration;
    imagesSupported: boolean;
  },
  criterion: ReturnType<typeof qualitativeCriteria>[number],
) {
  const files = new RepositoryFiles(input.root);
  const evidence = await files.json<StudioEvidence>(`${input.base}/studio/evidence.json`);
  const candidate = await inventoryTree(resolve(input.root, input.base, "workspace"));
  const candidateHash = hashJson(candidate);
  const all = qualitativeCriteria(input.revision);
  const criteria = scoringCriteria(
    input.revision,
    all.map((item) => item.id),
  );
  const criterionEvidence = await Promise.all(
    all.map((item) =>
      criterionMaterial({
        files,
        sourceRoot: `${input.base}/workspace`,
        sourceFiles: candidate,
        evidence,
        plan: input.revision.privateEvaluator.studio,
        criterion: item,
      }),
    ),
  );
  const selections = all.map(renderedSelection);
  const rendered = await renderedEvidence({
    files,
    base: `${input.base}/studio`,
    evidence,
    plan: input.revision.privateEvaluator.studio,
    captureIds: [...new Set(selections.flatMap((selection) => selection.captureIds))],
    sequence: selections.some((selection) => selection.sequence)
      ? await readControlSequencePlan(files, input.base, input.revision, candidateHash)
      : null,
    presentation: scoringPresentation(input.revision),
  });
  if (rendered.images.length && !input.imagesSupported)
    throw new Error("Frozen scorer lacks image input");
  if (rendered.unavailable.length || criterionEvidence.some((item) => item.unavailable.length))
    throw new Error("Reference evidence is incomplete; missing observations cannot be judged");
  const request = batchJudgmentRequest({
    configuration: input.configuration,
    criteria,
    criterionEvidence,
    publicTask: input.revision.publicTask.prompt,
    context: { ...rendered.context, publicSeed: input.revision.seed.project },
    images: rendered.images,
    observation: null,
  });
  const selected = criterionEvidence.find((item) => item.criterionId === criterion.id)!;
  const hashes = [
    ...selected.sealedSources.map((item) => item.hash),
    ...selected.signedObservations.flatMap((item) => (item.hash ? [item.hash] : [])),
    ...selected.signedActions.flatMap((item) => (item.hash ? [item.hash] : [])),
    ...rendered.images.map((item) => item.hash),
  ];
  return { request, hashes, candidateHash, evidenceHash: hashJson(evidence) };
}

export async function readControlJudgments(
  root: string,
  base: string,
  revision: EvalRevision,
  candidateHash: string,
  evidenceHash: string,
): Promise<CriterionResult[]> {
  const files = new RepositoryFiles(root),
    results: CriterionResult[] = [];
  for (const criterion of qualitativeCriteria(revision)) {
    const record = await files.optional<ControlJudgment>(`${base}/judgments/${criterion.id}.json`);
    if (!record) continue;
    if (!record.request.sampling)
      throw new Error("Reference judgment does not record its sampling identity");
    const expected = await controlJudgmentInput(
      {
        root,
        base,
        revision,
        configuration: {
          modelId: record.request.model,
          seed: record.request.seed,
          maxOutputTokens: record.request.maxOutputTokens,
          ...(record.request.reasoning ? { reasoning: record.request.reasoning } : {}),
          sampling: record.request.sampling,
        },
        imagesSupported: true,
      },
      criterion,
    );
    if (
      hashJson(expected.request) !== hashJson(record.request) ||
      expected.candidateHash !== candidateHash ||
      expected.evidenceHash !== evidenceHash ||
      hashJson(expected.hashes) !== hashJson(record.criterion.evidence)
    )
      throw new Error("Reference judgment differs from the frozen scorer and bound evidence");
    const requestHash = modelTurnRequestHash(record.request, record.transport);
    if (!isReferenceJudgmentOrdinal(record.ordinal))
      throw new Error("Reference judgment has no bounded request ordinal");
    const requestId = DurableSpendLedger.requestId(
      `${record.stage}:${record.ordinal}`,
      requestHash,
    );
    const receipt = await files.json<{
      requestId: string;
      requestHash: string;
      result: ModelTurnResult;
      resultHash: string;
    }>(
      `.basalt-evals/eval-operations/${record.operationId}/model-receipts/${hashJson(record.stage)}/${record.ordinal}.json`,
    );
    if (
      record.stage !== `control-judge:${hashJson(base)}:${criterion.id}` ||
      receipt.requestId !== requestId ||
      receipt.requestHash !== requestHash ||
      receipt.resultHash !== hashJson(record.response) ||
      hashJson(receipt.result) !== receipt.resultHash
    )
      throw new Error("Reference judgment differs from its retained model receipt");
    const implementation = await files.json<{ contextHash: string }>(
      `.basalt-evals/eval-operations/${record.operationId}/implementation.json`,
    );
    if (implementation.contextHash !== record.ledgerContextHash)
      throw new Error("Reference judgment spending context changed");
    const ledger = await new DurableSpendLedger(
      root,
      record.operationId,
      record.ledgerContextHash,
    ).read();
    const billed = ledger.entries.find((item) => item.requestId === requestId);
    if (
      record.candidateHash !== candidateHash ||
      record.evidenceHash !== evidenceHash ||
      record.response.requestHash !== requestHash ||
      billed?.status !== "billed" ||
      billed.billedUsd !== record.response.usage.costUsd ||
      hashJson(record.criterion) !==
        hashJson(
          criterionResult(revision, criterion.id, record.response, record.criterion.evidence),
        )
    )
      throw new Error(
        "Reference judgment is not bound to source, evidence, response and paid receipt",
      );
    results.push(record.criterion);
  }
  return results;
}
