import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, type CriterionResult } from "../../contracts/src/index.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { scoringConfiguration } from "../../eval-authoring/src/scoring.js";
import {
  controlJudgmentInput,
  criterionResult,
  type ControlJudgment,
} from "../../eval-authoring/src/control-judgment.js";
import { BoundedModelClient } from "../../model-client/src/bounded-client.js";
import { completeWithinRetries } from "./retries.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import type { ModelClient } from "../../model-client/src/contracts.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";

/** Reference judging batches compatible questions against the same captured evidence. */
export async function judgeControlSource(input: {
  root: string;
  base: string;
  revision: EvalRevision;
  client: ModelClient;
  ledger: DurableSpendLedger;
  snapshot: ModelSnapshot;
  beforeRequest?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<CriterionResult[]> {
  const files = new RepositoryFiles(input.root);
  const results: CriterionResult[] = [];
  for (const criterion of [
    ...input.revision.privateEvaluator.codeQuality,
    ...input.revision.privateEvaluator.visual,
    ...input.revision.privateEvaluator.unscaled,
  ]) {
    const { request, hashes, candidateHash, evidenceHash } = await controlJudgmentInput(
      {
        ...input,
        configuration: scoringConfiguration(input.revision, input.snapshot),
        imagesSupported: input.snapshot.inputModalities.includes("image"),
      },
      criterion,
    );
    // One stage per criterion: each owns its request ordinals and bounded retries.
    const stage = `control-judge:${hashJson(input.base)}:${criterion.id}`;
    const {
      response,
      value: result,
      ordinal,
    } = await completeWithinRetries(
      new BoundedModelClient(
        input.client,
        input.ledger,
        [input.snapshot],
        stage,
        false,
        input.beforeRequest,
      ),
      request,
      (response) => criterionResult(input.revision, criterion.id, response, hashes),
      input.signal,
    );
    const record: ControlJudgment = {
      operationId: input.ledger.operationId,
      ledgerContextHash: input.ledger.contextHash,
      candidateHash,
      evidenceHash,
      stage,
      ordinal,
      request,
      transport: input.client.descriptor,
      response,
      criterion: result,
    };
    const target = `${input.base}/judgments/${criterion.id}.json`;
    try {
      await files.writeJson(target, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashJson(await files.json(target)) !== hashJson(record))
        throw new Error("Control judgment changed during resume");
    }
    results.push(result);
  }
  return results;
}
