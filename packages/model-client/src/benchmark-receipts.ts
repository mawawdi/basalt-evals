import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { contentHash, hashJson, stableJson } from "../../contracts/src/index.js";
import {
  benchmarkRequestRole,
  type BenchmarkRequestTelemetry,
} from "../../contracts/src/benchmarks.js";
import type { SpendLedgerState } from "../../contracts/src/execution.js";
import {
  MAX_MODEL_RESPONSE_BYTES,
  isProviderErrorType,
  type ModelTurnResult,
  type ModelUsage,
} from "./contracts.js";
import { DurableSpendLedger } from "./ledger.js";
import { knownChargeUsd, validImageInputs } from "./bounded-client.js";
import { outputLimitCut } from "./output-limit.js";

const STOP_REASONS = ["end_turn", "tool_calls", "max_tokens", "refusal", "other"] as const;

const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;

/** Read-only receipt projection: never reconciles, releases, dispatches or substitutes an artifact. */
export async function readBenchmarkReceipts(root: string, operationId: string) {
  if (!operationPattern.test(operationId)) throw new Error("Invalid benchmark operation identity");
  const journal = await OperationJournal.open(root);
  let recorded: SpendLedgerState | null;
  try {
    recorded = journal.read<SpendLedgerState>("spending", operationId);
  } finally {
    journal.close();
  }
  return benchmarkReceipts(root, operationId, recorded);
}

/** The receipt projection from the saved spending record of a run, which the caller read. */
export async function benchmarkReceipts(
  root: string,
  operationId: string,
  recorded: SpendLedgerState | null,
) {
  if (!operationPattern.test(operationId)) throw new Error("Invalid benchmark operation identity");
  if (!recorded) return { ledgerHash: null, requests: [] as BenchmarkRequestTelemetry[] };
  const ledger = new DurableSpendLedger(root, operationId, recorded.contextHash);
  const state = ledger.validate(recorded);
  const names = new Map<string, Promise<string[]>>();
  async function stageFiles(stage: string) {
    const directory = resolve(ledger.directory, "model-receipts", hashJson(stage));
    await assertSafeAbsoluteDirectory(directory);
    const entries = await readdir(directory);
    if (entries.length > 10_000)
      throw new Error("Basalt cannot read more than 10,000 saved response files for one stage.");
    return entries;
  }
  /** One saved record, with the exact bytes that the bounded read returned. */
  async function read(stage: string, name: string, small = false) {
    const bytes = await readBoundedRegularFile(
      resolve(ledger.directory, "model-receipts", hashJson(stage), name),
      small ? 64 * 1024 : MAX_MODEL_RESPONSE_BYTES,
      "benchmark receipt",
    );
    const record = JSON.parse(bytes.toString("utf8")) as {
      requestId: string;
      requestHash: string;
      result?: ModelTurnResult;
      resultHash?: string;
      imageInputs?: unknown;
      costUsd?: number;
    };
    return { bytes, record };
  }
  const requests: BenchmarkRequestTelemetry[] = [];
  for (const entry of state.entries) {
    const row: BenchmarkRequestTelemetry = {
      operationId,
      requestId: entry.requestId,
      stage: entry.stage,
      role: benchmarkRequestRole(entry.stage),
      status: entry.status,
      billedUsd: entry.billedUsd,
      reservedUsd: entry.reservedUsd,
      dispatched: null,
      receiptHash: null,
      usage: null,
      imageInputs: null,
      latencyMs: null,
      resultKind: null,
      stopReason: null,
      cut: null,
      requestedModel: null,
      resolvedModel: null,
      servingProvider: null,
      issue: null,
    };
    try {
      if (!names.has(entry.stage)) names.set(entry.stage, stageFiles(entry.stage));
      const files = await names.get(entry.stage)!;
      const ordinals = [
        ...new Set(
          files.flatMap((name) => {
            const m =
              /^([1-9][0-9]{0,5})(?:\.(?:request|dispatch|response|identity|local-failure|billing))?\.json$/u.exec(
                name,
              );
            return m ? [Number(m[1])] : [];
          }),
        ),
      ];
      const ordinal = ordinals.find(
        (number) =>
          DurableSpendLedger.requestId(`${entry.stage}:${number}`, entry.requestHash) ===
          entry.requestId,
      );
      if (ordinal === undefined)
        throw new Error("Basalt has no saved record that it sent this request.");
      function bound(record: { requestId: string; requestHash: string }) {
        if (record.requestId !== entry.requestId || record.requestHash !== entry.requestHash)
          throw new Error("A saved record does not match this request.");
      }
      if (files.includes(`${ordinal}.local-failure.json`)) {
        const local = (await read(entry.stage, `${ordinal}.local-failure.json`, true)).record;
        bound(local);
        if (local.costUsd !== 0)
          throw new Error("The record of this unsent request has a charge that is not zero.");
        row.dispatched = false;
        requests.push(row);
        continue;
      }
      if (files.includes(`${ordinal}.dispatch.json`)) {
        bound((await read(entry.stage, `${ordinal}.dispatch.json`, true)).record);
        row.dispatched = true;
      }
      const name = files.includes(`${ordinal}.json`)
        ? `${ordinal}.json`
        : files.includes(`${ordinal}.response.json`)
          ? `${ordinal}.response.json`
          : null;
      if (!name) throw new Error("Basalt has no saved response for this request.");
      const { bytes, record: receipt } = await read(entry.stage, name);
      bound(receipt);
      const result = receipt.result;
      if (
        !result ||
        receipt.resultHash !== hashJson(result) ||
        result.requestHash !== entry.requestHash
      )
        throw new Error("The saved response does not match its hash or its request.");
      if (!["assistant", "provider_error", "invalid_model_response"].includes(result.kind))
        throw new Error("The saved response has a result type that Basalt does not know.");
      if (
        result.kind === "assistant" &&
        !(STOP_REASONS as readonly string[]).includes(result.stopReason)
      )
        throw new Error("The saved response has a stop reason that Basalt does not know.");
      if (
        result.kind === "provider_error" &&
        result.providerErrorType !== null &&
        !isProviderErrorType(result.providerErrorType)
      )
        throw new Error("The saved provider failure has an error type that Basalt does not know.");
      if (!validImageInputs(receipt.imageInputs))
        throw new Error("The saved record does not list the images of this request.");
      if (
        result.responseFactsHash &&
        result.responseFactsHash !==
          contentHash(stableJson({ facts: result.responseFacts, usage: result.usage }))
      )
        throw new Error("The saved response details do not match their hash.");
      if (entry.status === "billed" && knownChargeUsd(result) !== entry.billedUsd)
        throw new Error("The cost in the saved response differs from the confirmed charge.");
      const usage = {} as ModelUsage;
      for (const key of [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costUsd",
      ] as const) {
        const value = result.usage?.[key] ?? null;
        if (
          value !== null &&
          (!Number.isFinite(value) ||
            value < 0 ||
            (key !== "costUsd" && !Number.isSafeInteger(value)))
        )
          throw new Error("A saved token count or cost from the provider is not valid.");
        usage[key] = value;
      }
      const elapsed = result.responseFacts?.latencyMs ?? null;
      if (elapsed !== null && (!Number.isFinite(elapsed) || elapsed < 0))
        throw new Error("The saved response time is not valid.");
      row.dispatched = true;
      // The hash of the saved file as Basalt read it.
      row.receiptHash = contentHash(bytes);
      row.usage = usage;
      row.imageInputs = receipt.imageInputs;
      row.latencyMs = elapsed;
      row.resultKind = result.kind;
      row.stopReason = result.kind === "assistant" ? result.stopReason : null;
      row.cut = outputLimitCut(result);
      row.requestedModel = result.responseFacts?.requestedModel ?? null;
      row.resolvedModel = result.responseFacts?.resolvedModel ?? null;
      row.servingProvider = result.responseFacts?.servingProvider ?? null;
    } catch (error) {
      row.issue =
        error instanceof Error
          ? error.message
          : "Basalt cannot read the saved details of this request.";
    }
    requests.push(row);
  }
  return { ledgerHash: hashJson(state), requests };
}
