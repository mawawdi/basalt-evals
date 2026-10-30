import { resolve } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import type { BoundedAgentCheckpoint } from "../../agent-runtime/src/checkpoint.js";
import { toolDefinitions } from "../../agent-runtime/src/tools.js";
import { assertAgentRun, contentHash, hashJson, type AgentRun } from "../../contracts/src/index.js";
import { identity } from "../../contracts/src/validation.js";
import type { BuildHistory } from "../../contracts/src/build-history.js";
import type { SpendLedgerState } from "../../contracts/src/execution.js";
import {
  MAX_MODEL_RESPONSE_BYTES,
  type ModelTurnResult,
} from "../../model-client/src/contracts.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import {
  buildHistory,
  buildHistoryPage,
  developmentFrames,
  type BuilderLedgerRequest,
  type BuilderMessage,
} from "../../reporting/src/build-history.js";
import type { AtifOptions } from "../../reporting/src/atif.js";
import { frozenRunStatus } from "./run-builder.js";
import { operationSubject, subjectEval } from "./run-manifest.js";
import { readRegisteredSource } from "./sources.js";
import { sealedParentBuild } from "./builder-stage.js";

/** A checkpoint holds a conversation of at most 16 MiB with its trace and its source list. */
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const SOURCE_EXTENSION = /\.(?:lua|luau)$/u;

async function json<T>(file: string, maximumBytes: number, label: string): Promise<T> {
  return JSON.parse(
    (await readBoundedRegularFile(file, maximumBytes, label)).toString("utf8"),
  ) as T;
}

/** The files that the build started from, with the text of each Luau source. */
async function startFiles(files: Array<{ path: string; hash: string }>, directory: string) {
  const sources: Record<string, string> = {};
  for (const file of files)
    if (SOURCE_EXTENSION.test(file.path))
      sources[file.path] = (
        await readBoundedRegularFile(
          resolve(directory, file.path),
          MAX_SOURCE_BYTES,
          "start source",
        )
      ).toString("utf8");
  return { files: files.map(({ path, hash }) => ({ path, hash })), sources };
}

/**
 * The ledger requests of one builder stage with their ordinals and saved response facts. Each
 * response file must bind its request and its result hash.
 */
async function builderRequests(
  root: string,
  operationId: string,
  stage: string,
): Promise<BuilderLedgerRequest[]> {
  const journal = await OperationJournal.open(root);
  let recorded: SpendLedgerState | null;
  try {
    recorded = journal.read<SpendLedgerState>("spending", operationId);
  } finally {
    journal.close();
  }
  if (!recorded) return [];
  const ledger = new DurableSpendLedger(root, operationId, recorded.contextHash);
  const entries = (await ledger.read()).entries.filter((entry) => entry.stage === stage);
  const directory = resolve(ledger.directory, "model-receipts", hashJson(stage));
  const requests: BuilderLedgerRequest[] = [];
  for (const entry of entries) {
    // Rate limit tries can follow a spending stop, so look a little past the entry count.
    let ordinal = 0;
    for (let candidate = 1; candidate <= entries.length + 8 && !ordinal; candidate++)
      if (
        DurableSpendLedger.requestId(`${stage}:${candidate}`, entry.requestHash) === entry.requestId
      )
        ordinal = candidate;
    if (!ordinal) continue;
    let result: ModelTurnResult | null = null;
    for (const name of [`${ordinal}.json`, `${ordinal}.response.json`]) {
      const receipt = await json<{
        requestId: string;
        requestHash: string;
        result?: ModelTurnResult;
        resultHash?: string;
      }>(resolve(directory, name), MAX_MODEL_RESPONSE_BYTES, "builder receipt").catch(() => null);
      if (
        receipt?.result &&
        receipt.requestId === entry.requestId &&
        receipt.requestHash === entry.requestHash &&
        receipt.resultHash === hashJson(receipt.result)
      ) {
        result = receipt.result;
        break;
      }
    }
    requests.push({
      requestId: entry.requestId,
      ordinal,
      requestHash: entry.requestHash,
      status: entry.status,
      billedUsd: entry.billedUsd,
      latencyMs: result?.responseFacts?.latencyMs ?? null,
      inputTokens: result?.usage?.inputTokens ?? null,
      outputTokens: result?.usage?.outputTokens ?? null,
      resultKind: result?.kind ?? null,
    });
  }
  return requests;
}

/** The latest checkpoint of one build, checked against its journal hash and its treatment. */
async function builderCheckpoint(root: string, operationId: string, subjectId: string) {
  identity(operationId);
  const status = await frozenRunStatus(root, operationId, false);
  const subject = operationSubject(status.manifest, subjectId);
  const treatment = subject.builder;
  if (!treatment) throw new Error("This build has saved code and no model turns.");
  const base = `.basalt-evals/eval-operations/${status.manifest.id}/builder/${subject.id}`;
  const journal = await OperationJournal.open(root);
  let ref: { file: string; hash: string } | null;
  try {
    ref = journal.read("agent_checkpoints", `${status.manifest.id}:${subject.id}`);
  } finally {
    journal.close();
  }
  if (!ref) throw new Error("This build has no saved turns yet.");
  if (ref.file !== `${base}/checkpoints/${ref.hash}.json`)
    throw new Error("The saved turns of this build are outside its folder.");
  const checkpoint = await json<BoundedAgentCheckpoint>(
    resolve(root, ref.file),
    MAX_CHECKPOINT_BYTES,
    "builder checkpoint",
  );
  if (
    hashJson(checkpoint) !== ref.hash ||
    checkpoint.treatmentId !== treatment.id ||
    checkpoint.publicTaskHash !== treatment.task.publicTaskHash ||
    checkpoint.transportConfigurationHash !== treatment.transportConfigurationHash
  )
    throw new Error("The saved turns of this build changed after the build.");
  return { status, subject, treatment, base, checkpoint };
}

/**
 * Read how one build was built from its latest checkpoint. The reader checks the checkpoint
 * against its journal hash, the saved result against the terminal event of the build, and
 * each change against its traced hashes and the hash chain from the start files.
 */
export async function readBuildHistory(
  root: string,
  operationId: string,
  subjectId: string,
): Promise<{ history: BuildHistory; atif: AtifOptions }> {
  const { status, subject, treatment, base, checkpoint } = await builderCheckpoint(
    root,
    operationId,
    subjectId,
  );
  let run: AgentRun | null = null;
  const terminal = [...status.events]
    .reverse()
    .find(
      (event) =>
        event.stage === "builder" &&
        event.unitId === subject.id &&
        ["completed", "failed", "incomplete"].includes(event.kind) &&
        event.artifactHashes.length > 0,
    );
  if (checkpoint.point === "finished" && checkpoint.completedRun && terminal) {
    const saved = await json<AgentRun>(
      resolve(root, base, "agent-run.json"),
      MAX_CHECKPOINT_BYTES,
      "builder result",
    );
    assertAgentRun(saved);
    if (
      !terminal.artifactHashes.includes(hashJson(saved)) ||
      hashJson(checkpoint.completedRun) !== hashJson(saved)
    )
      throw new Error("The saved result of this build doesn't match its run record.");
    run = saved;
  }
  let start;
  if (subject.parentSubjectId) {
    // A later stage started from the sealed build of the stage before it.
    const parent = await sealedParentBuild(root, status, subject.parentSubjectId);
    start = await startFiles(parent.run.candidate.files, parent.candidate);
  } else if (subject.parentSourceId) {
    const parent = await readRegisteredSource(root, subject.parentSourceId);
    start = await startFiles(parent.source.candidate.files, parent.workspaceRoot);
  } else {
    const evaluation = subjectEval(status.manifest, subject.id);
    const task = await loadRegisteredTask(root, `.basalt-evals/eval-revisions/${evaluation.id}`);
    const seed = resolve(root, task.directory, "seed");
    const inventory = await inventoryTree(seed);
    if (task.seedHash !== treatment.task.seedHash || hashJson(inventory) !== task.seedHash)
      throw new Error("The seed of this build changed after the build.");
    start = await startFiles(inventory, seed);
  }
  const history = buildHistory({
    operationId,
    subjectId: subject.id,
    model: treatment.model.id,
    harness: treatment.harness.id,
    systemPrompt: treatment.harness.systemPrompt,
    checkpoint: {
      conversation: checkpoint.conversation as BuilderMessage[],
      trace: checkpoint.trace,
    },
    run: run
      ? { status: run.status, stopReason: run.stopReason, files: run.candidate.files }
      : null,
    start,
    requests: await builderRequests(root, operationId, `builder:${subject.id}`),
  });
  return {
    history,
    atif: {
      agentVersion: status.manifest.implementationCommit,
      tools: toolDefinitions(treatment.harness),
    },
  };
}

/**
 * The bytes of one development frame that the builder of this build saw. Only the frames of
 * its own development observations are served: never a context image, withheld evidence or
 * another build's image.
 */
export async function buildImage(
  root: string,
  operationId: string,
  subjectId: string,
  hash: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid image hash");
  const { checkpoint } = await builderCheckpoint(root, operationId, subjectId);
  const frame = developmentFrames(checkpoint.conversation as BuilderMessage[]).get(hash);
  if (!frame) throw new Error("This build saw no development frame with this hash.");
  const bytes = Buffer.from(frame.dataBase64, "base64");
  if (
    contentHash(bytes) !== hash ||
    bytes.toString("base64") !== frame.dataBase64 ||
    !["image/png", "image/jpeg"].includes(frame.mediaType)
  )
    throw new Error("The saved development frame does not match its hash.");
  return { bytes, mediaType: frame.mediaType };
}

/** One page of turns of a build history for the console. */
export async function buildHistoryView(
  root: string,
  operationId: string,
  subjectId: string,
  page: number,
) {
  return buildHistoryPage((await readBuildHistory(root, operationId, subjectId)).history, page);
}
