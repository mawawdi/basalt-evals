import { PNG } from "pngjs";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, hashJson, stableJson } from "../packages/contracts/src/index.js";
import {
  BoundedModelClient,
  maximumRequestCost,
} from "../packages/model-client/src/bounded-client.js";
import {
  completeWithinRetries,
  ProviderPauseError,
} from "../packages/agent-runtime/src/retries.js";
import { isReferenceJudgmentOrdinal } from "../packages/eval-authoring/src/control-judgment.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import {
  modelTurnRequestHash,
  ModelRequestAdmissionError,
  ModelRequestPendingError,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { lookupOpenRouterGenerationBilling } from "../packages/model-client/src/generation-billing.js";
import { reconcileSavedModelBilling } from "../packages/model-client/src/recovery.js";
import {
  OpenRouterModelClient,
  openRouterModelClientDescriptor,
} from "../packages/model-client/src/openrouter-ai-sdk.js";
import { chunk, endlessStream, generationRecord, sseResponse } from "./openrouter-stream.js";

test("local request rejection creates no paid liability and never calls fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-local-preflight-"));
  try {
    const ledger = new DurableSpendLedger(root, "local-preflight", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    let calls = 0;
    const transport = new OpenRouterModelClient({
      apiKey: "offline-test",
      allowedModels: [model.id],
      fetchImpl: async () => {
        calls += 1;
        throw new Error("Unexpected network");
      },
    });
    const guardFailure = new Error("Frozen implementation changed");
    await assert.rejects(
      new BoundedModelClient(transport, ledger, [model], "builder:guard", false, async () => {
        throw guardFailure;
      }).complete(request),
      (error: unknown) =>
        error instanceof ModelRequestAdmissionError && error.cause === guardFailure,
    );
    assert.equal(calls, 0);
    assert.equal((await ledger.read()).entries.length, 0);
    await assert.rejects(
      new BoundedModelClient(transport, ledger, [model], "judgment:unsupported-reasoning").complete(
        {
          ...request,
          tools: [
            {
              name: "submit",
              description: "Submit a judgment",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          reasoning: { kind: "effort", effort: "high" },
        },
      ),
      /does not advertise the selected reasoning effort/,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await ledger.read()).entries.length,
      0,
      "Unsupported reasoning cannot reserve spending",
    );
    await assert.rejects(
      new BoundedModelClient(transport, ledger, [model], "builder:invalid").complete({
        ...request,
        seed: 0.5,
      }),
      /seed/,
    );
    assert.equal(calls, 0);
    assert.equal((await ledger.read()).entries.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withdrawn dispatch permission after reservation releases the entire unused allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-dispatch-permission-"));
  try {
    const ledger = new DurableSpendLedger(root, "dispatch-permission", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    let admissionChecks = 0;
    let networkDispatches = 0;
    const client: ModelClient = {
      observesDispatch: true,
      descriptor: openRouterModelClientDescriptor([model.id]),
      async complete(_request, _signal, observer) {
        await observer!.beforeDispatch();
        networkDispatches++;
        throw new Error("Unexpected network dispatch");
      },
    };
    const bounded = new BoundedModelClient(
      client,
      ledger,
      [model],
      "judgment:permission",
      false,
      async () => {
        admissionChecks++;
        if (admissionChecks > 1) throw new Error("Operation stopped while reserving its request");
      },
    );
    await assert.rejects(bounded.complete(request), /before network dispatch/);
    assert.equal(admissionChecks, 2);
    assert.equal(networkDispatches, 0);
    const state = await ledger.read();
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]!.status, "billed");
    assert.equal(state.entries[0]!.billedUsd, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop while the dispatch marker is flushing revokes the hook before releasing its allowance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-dispatch-flush-"));
  let releaseWrite!: () => void;
  const waiting = new Promise<void>((done) => {
    releaseWrite = done;
  });
  let writeStarted!: () => void;
  const writing = new Promise<void>((done) => {
    writeStarted = done;
  });
  try {
    const ledger = new DurableSpendLedger(root, "dispatch-flush", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const stage = "judgment:flush";
    const descriptor = openRouterModelClientDescriptor([model.id]);
    const requestHash = modelTurnRequestHash(request, descriptor);
    const requestId = DurableSpendLedger.requestId(`${stage}:1`, requestHash);
    const marker = `${stableJson({ requestId, requestHash })}\n`;
    const probe = await open(join(root, "file-handle-probe"), "wx");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const original = prototype.writeFile;
    await probe.close();
    t.mock.method(
      prototype,
      "writeFile",
      async function (this: FileHandle, ...args: Parameters<FileHandle["writeFile"]>) {
        if (args[0] === marker) {
          writeStarted();
          await waiting;
        }
        return original.apply(this, args);
      },
    );
    let transportStopped!: () => void;
    const stopped = new Promise<void>((done) => {
      transportStopped = done;
    });
    let networkDispatches = 0;
    const client: ModelClient = {
      observesDispatch: true,
      descriptor,
      async complete(_request, _signal, observer) {
        try {
          await observer!.beforeDispatch();
          networkDispatches++;
          throw new Error("Unexpected network dispatch");
        } finally {
          transportStopped();
        }
      },
    };
    const controller = new AbortController();
    const result = new BoundedModelClient(client, ledger, [model], stage).complete(
      request,
      controller.signal,
    );
    const rejected = assert.rejects(result, /before network dispatch/);
    await writing;
    controller.abort(new Error("Operator stopped during dispatch publication"));
    await rejected;
    const entry = (await ledger.read()).entries[0]!;
    assert.equal(entry.status, "billed");
    assert.equal(entry.billedUsd, 0);
    releaseWrite();
    await stopped;
    assert.equal(networkDispatches, 0, "A released reservation can never dispatch later");
  } finally {
    releaseWrite();
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

const model: ModelSnapshot = {
  id: "openai/gpt-6-luna",
  name: "GPT-6 Luna",
  revision: "openai/gpt-6-luna-test",
  capturedAt: "2026-09-23T00:00:00.000Z",
  inputModalities: ["text", "image"],
  reasoning: null,
  recommendedSampling: {
    temperature: null,
    top_p: null,
    top_k: null,
    frequency_penalty: null,
    presence_penalty: null,
    repetition_penalty: null,
  },
  endpoints: [
    {
      tag: "openai",
      provider: "OpenAI",
      quantization: "unknown",
      contextLength: 16_384,
      maxPromptTokens: null,
      rawPricing: {},
      maxOutputTokens: 1_024,
      supportedParameters: ["tools"],
      tiers: [
        {
          minPromptTokens: 0,
          temporal: null,
          inputPerTokenUsd: 0.000001,
          outputPerTokenUsd: 0.000002,
          imagePerImageUsd: 0.001,
          requestUsd: 0,
          cacheReadPerTokenUsd: null,
          cacheWritePerTokenUsd: null,
        },
      ],
    },
  ],
  hash: hashJson("model"),
};

const request: ModelTurnRequest = {
  model: model.id,
  seed: 1,
  system: "Build the task",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  maxOutputTokens: 100,
};

test("elapsed time does not cancel a request; explicit Stop retains its entire liability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-cancel-request-"));
  try {
    const ledger = new DurableSpendLedger(root, "cancel-request", hashJson("cancel-request"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    let calls = 0;
    let dispatched!: () => void;
    const started = new Promise<void>((done) => {
      dispatched = done;
    });
    const client: ModelClient = {
      descriptor: openRouterModelClientDescriptor([model.id]),
      complete: async (_request, signal) => {
        calls++;
        assert.ok(signal);
        dispatched();
        return new Promise(() => {});
      },
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const pending = new BoundedModelClient(client, ledger, [model], "prepare_public").complete(
      request,
      controller.signal,
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(pending, /Paid call uncertain/);
    await started;
    t.mock.timers.tick(3_600_000);
    await Promise.resolve();
    assert.equal(settled, false);
    controller.abort(new Error("Operator stopped the run"));
    await rejected;
    const state = await ledger.read();
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]!.status, "pending");
    assert.ok(state.entries[0]!.reservedUsd > 0);
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "prepare_public").complete(request),
      /uncertain|pending|reserved/,
    );
    assert.equal(calls, 1);
    assert.equal((await ledger.read()).entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a billed stage replays its saved response without another provider call", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-client-"));
  try {
    const ledger = new DurableSpendLedger(root, "operation-one", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    let calls = 0;
    const descriptor = openRouterModelClientDescriptor([model.id]);
    const client: ModelClient = {
      descriptor,
      async complete(input) {
        calls += 1;
        return {
          kind: "assistant",
          requestHash: modelTurnRequestHash(input, descriptor),
          message: { role: "assistant", content: "done", toolCalls: [] },
          stopReason: "end_turn",
          responseHash: hashJson("done"),
          responseFacts: {
            requestedModel: model.id,
            resolvedModel: model.id,
            servingProvider: "OpenAI",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "generation-one",
            latencyMs: 1,
            retryCount: 0,
            finishReason: "stop",
            continuationHash: null,
            continuationBytes: null,
          },
          usage: {
            inputTokens: 20,
            outputTokens: 1,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.0001,
          },
        };
      },
    };
    const first = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "builder:trial-one",
    ).complete(request);
    const replay = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "builder:trial-one",
    ).complete(request);
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    assert.equal((await ledger.read()).entries[0]?.status, "billed");
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "builder:missing", true).complete(request),
      /cannot send a new paid request while it checks saved work/u,
    );
    assert.equal(calls, 1);
    assert.equal((await ledger.read()).entries.length, 1);
    const nextRequest = {
      ...request,
      messages: [{ role: "user" as const, content: "Next bounded turn" }],
    };
    const next = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "builder:trial-one",
      false,
      undefined,
      1,
    ).complete(nextRequest);
    assert.equal(calls, 2);
    const recovered = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "builder:trial-one",
      false,
      undefined,
      1,
    ).complete(nextRequest);
    assert.deepEqual(recovered, next);
    assert.equal(calls, 2);
    assert.equal((await ledger.read()).entries.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown billing retains the reservation and prevents a paid retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-unknown-"));
  try {
    const ledger = new DurableSpendLedger(root, "operation-unknown", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    let calls = 0;
    const descriptor = openRouterModelClientDescriptor([model.id]);
    const client: ModelClient = {
      descriptor,
      async complete(input) {
        calls += 1;
        return {
          kind: "provider_error",
          requestHash: modelTurnRequestHash(input, descriptor),
          errorClass: "transport",
          providerErrorType: null,
          message: "connection lost",
          retryable: false,
          responseFacts: {
            requestedModel: model.id,
            resolvedModel: null,
            servingProvider: null,
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "generation-reconcilable",
            latencyMs: 1,
            retryCount: 0,
            finishReason: null,
            continuationHash: null,
            continuationBytes: null,
          },
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            costUsd: null,
          },
        };
      },
    };
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "builder:trial-one").complete(request),
      /Paid call uncertain\. Basalt cannot confirm the charge of the response/,
    );
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "builder:trial-one").complete(request),
      /A saved request has a pending charge/,
    );
    assert.equal(calls, 1);
    assert.equal((await ledger.read()).entries[0]?.status, "pending");
    const response = await readFile(
      join(ledger.directory, "model-receipts", hashJson("builder:trial-one"), "1.response.json"),
      "utf8",
    );
    assert.match(response, /generation-reconcilable/);
    let lookups = 0;
    const recovery = await reconcileSavedModelBilling(ledger, async (generationId) => {
      lookups += 1;
      return { generationId, costUsd: 0.002 };
    });
    assert.equal(recovery[0]?.outcome, "reconciled");
    assert.equal(lookups, 1);
    assert.equal((await ledger.read()).entries[0]?.status, "billed");
    const replay = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "builder:trial-one",
    ).complete(request);
    assert.equal(replay.usage.costUsd, 0.002);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK-invalid responses retain provider identity and known billing before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-sdk-invalid-"));
  try {
    const ledger = new DurableSpendLedger(root, "sdk-invalid", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    let calls = 0;
    const client = new OpenRouterModelClient({
      apiKey: "offline-test",
      allowedModels: [model.id],
      fetchImpl: async () => {
        calls += 1;
        return sseResponse([
          {
            id: "gen-invalid-envelope",
            model: model.id,
            provider: "OpenAI",
            choices: "malformed",
            usage: { cost: 0.002 },
          },
        ]);
      },
    });
    const result = await new BoundedModelClient(
      client,
      ledger,
      [model],
      "grading:invalid",
    ).complete({
      ...request,
      tools: [
        {
          name: "submit",
          description: "Submit a judgment",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    assert.equal(result.kind, "provider_error");
    assert.equal(result.responseFacts.responseId, "gen-invalid-envelope");
    assert.equal(result.usage.costUsd, 0.002);
    assert.equal((await ledger.read()).entries[0]?.billedUsd, 0.002);
    const retained = JSON.parse(
      await readFile(
        join(ledger.directory, "model-receipts", hashJson("grading:invalid"), "1.identity.json"),
        "utf8",
      ),
    );
    assert.equal(retained.generationId, "gen-invalid-envelope");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an observed pre-dispatch SDK failure releases the reservation with zero charge", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-dispatch-boundary-"));
  try {
    const ledger = new DurableSpendLedger(root, "before-dispatch", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    const client: ModelClient = {
      descriptor: openRouterModelClientDescriptor([model.id]),
      observesDispatch: true,
      async complete() {
        throw new Error("SDK local serialization failure");
      },
    };
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "grading:local").complete(request),
      /before network dispatch/,
    );
    const entry = (await ledger.read()).entries[0]!;
    assert.equal(entry.status, "billed");
    assert.equal(entry.billedUsd, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a transport result before dispatch names its local cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-dispatch-cause-"));
  try {
    const ledger = new DurableSpendLedger(root, "before-dispatch", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    const client: ModelClient = {
      descriptor: openRouterModelClientDescriptor([model.id]),
      observesDispatch: true,
      async complete() {
        return {
          kind: "provider_error",
          errorClass: "transport_ai_missing_tool_results_error",
          providerErrorType: null,
          message:
            "The connection to OpenRouter failed before Basalt received a complete response.",
          retryable: false,
          requestHash: "0".repeat(64),
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
        } as unknown as ModelTurnResult;
      },
    };
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "builder:local").complete(request),
      /before network dispatch \(transport_ai_missing_tool_results_error\); no charge/,
    );
    assert.equal((await ledger.read()).entries[0]!.billedUsd, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a response identity survives interruption before an SDK result without inventing an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-early-identity-"));
  try {
    const ledger = new DurableSpendLedger(root, "early-identity", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    let calls = 0;
    const client: ModelClient = {
      descriptor: openRouterModelClientDescriptor([model.id]),
      observesDispatch: true,
      async complete(_request, _signal, observer) {
        await observer!.beforeDispatch();
        calls += 1;
        await observer!.response({
          generationId: "gen-before-interruption",
          resolvedModel: model.id,
          servingProvider: "OpenAI",
          costUsd: null,
          servingServiceTier: null,
        });
        throw new Error("Interrupted before SDK normalization");
      },
    };
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "grading:interrupted").complete(request),
      /Paid call uncertain/,
    );
    const recovered = await reconcileSavedModelBilling(ledger, async (generationId) => ({
      generationId,
      costUsd: 0.003,
    }));
    assert.equal(recovered[0]?.outcome, "reconciled");
    assert.match(recovered[0]!.reason, /no assistant response/);
    assert.equal((await ledger.read()).entries[0]!.billedUsd, 0.003);
    await assert.rejects(
      new BoundedModelClient(client, ledger, [model], "grading:interrupted").complete(request),
      /A saved request has no complete response/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function providerError(
  requestHash: string,
  errorClass: string,
  responseId: string | null,
  message = "OpenRouter request failed with HTTP 429.",
): ModelTurnResult {
  return {
    kind: "provider_error",
    requestHash,
    errorClass,
    providerErrorType: null,
    message,
    retryable: true,
    responseFacts: {
      requestedModel: model.id,
      resolvedModel: null,
      servingProvider: null,
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId,
      latencyMs: 1,
      retryCount: 0,
      finishReason: null,
      continuationHash: null,
      continuationBytes: null,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    },
  };
}

function rateLimit(requestHash: string, message?: string): ModelTurnResult {
  return providerError(requestHash, "http_429", null, message);
}

function answer(requestHash: string, generationId: string, content = "done"): ModelTurnResult {
  return {
    kind: "assistant",
    requestHash,
    message: { role: "assistant", content, toolCalls: [] },
    stopReason: "end_turn",
    responseHash: hashJson(content),
    responseFacts: {
      requestedModel: model.id,
      resolvedModel: model.id,
      servingProvider: "OpenAI",
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId: generationId,
      latencyMs: 1,
      retryCount: 0,
      finishReason: "stop",
      continuationHash: null,
      continuationBytes: null,
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.00001,
    },
  };
}

/** A transport that returns the next scripted result for each dispatch. */
function scriptedClient(results: Array<(requestHash: string) => ModelTurnResult>) {
  const descriptor = openRouterModelClientDescriptor([model.id]);
  const state = { calls: 0 };
  const client: ModelClient = {
    descriptor,
    async complete(input) {
      const next = results[state.calls++];
      if (!next) throw new Error("Unexpected model dispatch");
      return next(modelTurnRequestHash(input, descriptor));
    },
  };
  return { client, state };
}

async function failureFiles(ledger: DurableSpendLedger): Promise<string[]> {
  return readdir(join(ledger.directory, "failures")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function recordWaits(client: BoundedModelClient, waits: number[]): BoundedModelClient {
  client.pause = async (milliseconds) => {
    waits.push(milliseconds);
  };
  return client;
}

test("a rate limit settles at zero, releases its reservation and is tried again as a new ordinal", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-rate-limit-"));
  try {
    const maximum = maximumRequestCost(model, request);
    const ledger = new DurableSpendLedger(root, "operation-rate-limit", hashJson("context"));
    // One maximum is sufficient only because each rejection releases its reservation.
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: maximum });
    const { client, state } = scriptedClient([
      (hash) => rateLimit(hash),
      (hash) => rateLimit(hash),
      (hash) => answer(hash, "gen-third"),
    ]);
    const waits: number[] = [];
    const stage = "judgment:retry";
    const bounded = recordWaits(new BoundedModelClient(client, ledger, [model], stage), waits);
    const result = await bounded.complete(request);
    assert.equal(result.kind, "assistant");
    assert.equal(state.calls, 3);
    assert.deepEqual(waits, [20_000, 60_000]);
    assert.equal(bounded.completedCalls, 3);
    const settled = await ledger.read();
    assert.deepEqual(
      settled.entries.map((entry) => [entry.status, entry.billedUsd]),
      [
        ["billed", 0],
        ["billed", 0],
        ["billed", 0.00001],
      ],
    );
    assert.equal(new Set(settled.entries.map((entry) => entry.requestId)).size, 3);
    assert.deepEqual(
      await failureFiles(ledger),
      [],
      "A rate limit that is tried again is no failure",
    );

    // A resume replays the saved tries. It does not wait, and it sends no request.
    const resumed = recordWaits(new BoundedModelClient(client, ledger, [model], stage), waits);
    assert.deepEqual(await resumed.complete(request), result);
    assert.equal(resumed.completedCalls, 3);
    const checked = new BoundedModelClient(client, ledger, [model], stage, true);
    assert.deepEqual(await checked.complete(request), result);
    assert.equal(state.calls, 3);
    assert.deepEqual(waits, [20_000, 60_000]);
    assert.deepEqual(await ledger.read(), settled);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rate limit stops after three retries with the scheduled and Retry-After waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-rate-limit-exhausted-"));
  try {
    const maximum = maximumRequestCost(model, request);
    const ledger = new DurableSpendLedger(root, "operation-exhausted", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: maximum });
    const messages = [45, 30, 400, 10].map(
      (seconds) =>
        `OpenRouter request failed with HTTP 429. Provider error type: rate_limit_exceeded. Retry-After: ${seconds} seconds.`,
    );
    const { client, state } = scriptedClient(
      messages.map((message) => (hash: string) => rateLimit(hash, message)),
    );
    const waits: number[] = [];
    const stage = "judgment:exhausted";
    const bounded = recordWaits(new BoundedModelClient(client, ledger, [model], stage), waits);
    const result = await bounded.complete(request);
    assert.ok(result.kind === "provider_error");
    assert.equal(result.message, messages[3]);
    assert.equal(state.calls, 4);
    // 45 s is longer than 20 s, 30 s is shorter than 60 s, and 400 s stops at 300 s.
    assert.deepEqual(waits, [45_000, 60_000, 300_000]);
    assert.equal(bounded.completedCalls, 4);
    const settled = await ledger.read();
    assert.deepEqual(
      settled.entries.map((entry) => [entry.status, entry.billedUsd]),
      [
        ["billed", 0],
        ["billed", 0],
        ["billed", 0],
        ["billed", 0],
      ],
    );
    const failures = await failureFiles(ledger);
    assert.equal(failures.length, 1, "Only the final rejection records a failure");
    const failure = JSON.parse(
      await readFile(join(ledger.directory, "failures", failures[0]!), "utf8"),
    ) as { causeCode: string; recoveryActions: string[]; explanation: string };
    assert.equal(failure.causeCode, "http_429");
    assert.deepEqual(failure.recoveryActions, ["inspect"]);
    assert.match(failure.explanation, /Basalt recorded no charge\./u);

    const checked = new BoundedModelClient(client, ledger, [model], stage, true);
    assert.deepEqual(await checked.complete(request), result);
    assert.equal(state.calls, 4, "A replay follows the same four ordinals without a dispatch");
    assert.deepEqual(await ledger.read(), settled);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a 5xx result or a rejection with a generation ID keeps its pending charge", async () => {
  for (const [errorClass, generationId] of [
    ["http_503", null],
    ["http_429", "gen-rate-limit"],
    ["provider_response_error_429", "gen-envelope"],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "basalt-bounded-pending-error-"));
    try {
      const maximum = maximumRequestCost(model, request);
      const ledger = new DurableSpendLedger(root, "operation-pending", hashJson("context"));
      await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: maximum * 2 });
      const { client, state } = scriptedClient([
        (hash) => providerError(hash, errorClass, generationId),
        (hash) => answer(hash, "gen-unexpected"),
      ]);
      const waits: number[] = [];
      const bounded = recordWaits(
        new BoundedModelClient(client, ledger, [model], "judgment:pending"),
        waits,
      );
      await assert.rejects(bounded.complete(request), ModelRequestPendingError);
      assert.equal(state.calls, 1, errorClass);
      assert.deepEqual(waits, []);
      assert.deepEqual(
        (await ledger.read()).entries.map((entry) => [
          entry.status,
          entry.billedUsd,
          entry.reservedUsd,
        ]),
        [["pending", null, maximum]],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Stop during a rate-limit wait ends the wait at once, and a resume waits again", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-rate-limit-stop-"));
  try {
    const ledger = new DurableSpendLedger(root, "operation-stop-wait", hashJson("context"));
    await ledger.initialize({
      quoteHash: hashJson("quote"),
      ceilingUsd: maximumRequestCost(model, request),
    });
    const { client, state } = scriptedClient([
      (hash) => rateLimit(hash),
      (hash) => answer(hash, "gen-after-stop"),
    ]);
    const stage = "builder:stop";
    const controller = new AbortController();
    const stopped = new BoundedModelClient(client, ledger, [model], stage);
    const realPause = stopped.pause;
    stopped.pause = (milliseconds, signal) => {
      setImmediate(() => controller.abort(new Error("The operator stopped the run")));
      return realPause(milliseconds, signal);
    };
    const started = Date.now();
    await assert.rejects(
      stopped.complete(request, controller.signal),
      (error: unknown) =>
        error instanceof ModelRequestAdmissionError &&
        error.message === "The operator stopped the run",
    );
    assert.ok(Date.now() - started < 5_000, "Stop does not wait for the scheduled 20 s");
    assert.equal(state.calls, 1);
    assert.equal(stopped.completedCalls, 0, "A call that throws does not count");
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => [entry.status, entry.billedUsd]),
      [["billed", 0]],
    );

    // The next try did not start, so the resume replays the rejection and waits again.
    const waits: number[] = [];
    const resumed = recordWaits(
      new BoundedModelClient(client, ledger, [model], stage, false, undefined, 0),
      waits,
    );
    const result = await resumed.complete(request);
    assert.equal(result.kind, "assistant");
    assert.equal(state.calls, 2);
    assert.deepEqual(waits, [20_000]);
    assert.equal(resumed.completedCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the largest ordinal of an accepted judgment fits the reference judgment bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-judgment-ordinal-"));
  try {
    const ledger = new DurableSpendLedger(root, "operation-ordinal", hashJson("context"));
    await ledger.initialize({
      quoteHash: hashJson("quote"),
      ceilingUsd: maximumRequestCost(model, request) * 3,
    });
    // Each judgment try gets three rate limits before its answer. Two answers are malformed.
    const tries = (content: string) => [
      (hash: string) => rateLimit(hash),
      (hash: string) => rateLimit(hash),
      (hash: string) => rateLimit(hash),
      (hash: string) => answer(hash, `gen-${content}`, content),
    ];
    const { client, state } = scriptedClient([
      ...tries("broken"),
      ...tries("broken-again"),
      ...tries("accepted"),
    ]);
    const waits: number[] = [];
    const bounded = recordWaits(
      new BoundedModelClient(client, ledger, [model], "control-judge:ordinal"),
      waits,
    );
    const parse = (response: ModelTurnResult) => {
      if (response.kind !== "assistant" || response.message.content !== "accepted")
        throw new Error("The answer breaks the requested structure");
      return response.message.content;
    };
    const accepted = await completeWithinRetries(bounded, request, parse);
    assert.equal(accepted.value, "accepted");
    assert.equal(accepted.ordinal, 12);
    assert.equal(state.calls, 12);
    assert.equal(waits.length, 9);
    assert.equal(isReferenceJudgmentOrdinal(accepted.ordinal), true);
    assert.equal(isReferenceJudgmentOrdinal(13), false);
    assert.equal(isReferenceJudgmentOrdinal(0), false);

    const limited = recordWaits(
      new BoundedModelClient(
        scriptedClient([0, 1, 2, 3].map(() => (hash: string) => rateLimit(hash))).client,
        ledger,
        [model],
        "control-judge:limited",
      ),
      [],
    );
    // A rate limit after the final try is a persistent failure with a known zero charge.
    await assert.rejects(
      completeWithinRetries(limited, request, parse),
      (error: unknown) =>
        error instanceof ProviderPauseError &&
        error.scope === "persistent" &&
        error.ordinal === 4 &&
        /http_429 paused this work\. Basalt recorded its known charge\./u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe OpenRouter diagnostics reach saved failures; a rejection settles at zero and a 5xx stays pending", async () => {
  for (const example of [
    { status: 429, code: 429, errorType: "rate_limit_exceeded", errorClass: "http_429" },
    {
      status: 200,
      code: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "provider_response_error_429",
    },
    { status: 503, code: 503, errorType: "provider_overloaded", errorClass: "http_503" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "basalt-bounded-provider-diagnostics-"));
    try {
      const input: ModelTurnRequest = {
        ...request,
        tools: [
          {
            name: "submit",
            description: "Submit a judgment",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      };
      const maximum = maximumRequestCost(model, input);
      const ledger = new DurableSpendLedger(root, "provider-diagnostics", hashJson("context"));
      await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: maximum * 2 });
      let calls = 0;
      const transport = new OpenRouterModelClient({
        apiKey: "private-test-api-key",
        allowedModels: [model.id],
        fetchImpl: async () => {
          calls++;
          const envelope = {
            error: {
              code: example.code,
              message: "private-provider-message",
              metadata: {
                error_type: example.errorType,
                provider_code: "private_provider_token",
                raw: { headers: "private-header-secret", reasoning: "private-reasoning" },
              },
            },
          };
          const headers = { "Retry-After": "120", authorization: "Bearer private-header-secret" };
          // OpenRouter sends an error inside a started stream as an event of that stream.
          if (example.status === 200) return sseResponse([envelope], { headers });
          return new Response(JSON.stringify(envelope), {
            status: example.status,
            headers: { "content-type": "application/json", ...headers },
          });
        },
      });
      const stage = "grading:diagnostics";
      const waits: number[] = [];
      const bounded = () =>
        recordWaits(new BoundedModelClient(transport, ledger, [model], stage), waits);
      const rateLimited = example.code === 429;
      if (rateLimited) {
        const result = await bounded().complete(input);
        assert.equal(result.kind, "provider_error");
      } else
        await assert.rejects(
          bounded().complete(input),
          /Basalt cannot confirm the charge of the response/,
        );
      // The client tries a rate limit three more times. Retry-After makes each wait 120 s.
      const tries = rateLimited ? 4 : 1;
      assert.equal(calls, tries);
      assert.deepEqual(waits, rateLimited ? [120_000, 120_000, 120_000] : []);
      const state = await ledger.read();
      assert.equal(state.entries.length, tries);
      for (const entry of state.entries) {
        assert.equal(entry.status, rateLimited ? "billed" : "pending");
        assert.equal(entry.billedUsd, rateLimited ? 0 : null);
        assert.equal(entry.reservedUsd, maximum);
      }

      const responseFile = join(
        ledger.directory,
        "model-receipts",
        hashJson(stage),
        `${tries}.response.json`,
      );
      const response = await readFile(responseFile, "utf8");
      const saved = JSON.parse(response) as { result: { errorClass: string; message: string } };
      assert.equal(saved.result.errorClass, example.errorClass);
      assert.match(
        saved.result.message,
        new RegExp(`Provider error type: ${example.errorType}\\.`),
      );
      assert.match(saved.result.message, /Retry-After: 120 seconds\./u);
      assert.doesNotMatch(response, /private[-_]/u);

      const failures = await failureFiles(ledger);
      assert.equal(failures.length, 1);
      const failureText = await readFile(join(ledger.directory, "failures", failures[0]!), "utf8");
      const failure = JSON.parse(failureText) as {
        causeCode: string;
        explanation: string;
        recoveryActions: string[];
      };
      assert.equal(failure.causeCode, example.errorClass);
      assert.ok(failure.explanation.includes(saved.result.message));
      assert.deepEqual(
        failure.recoveryActions,
        rateLimited ? ["inspect"] : ["inspect", "reconcile"],
      );
      assert.doesNotMatch(failureText, /private[-_]/u);

      if (rateLimited) assert.deepEqual(await bounded().complete(input), saved.result);
      else await assert.rejects(bounded().complete(input), /A saved request has a pending charge/);
      assert.equal(calls, tries, "A replay sends no request");
      assert.equal(waits.length, rateLimited ? 3 : 0, "A replay does not wait");
      assert.deepEqual(await ledger.read(), state);
      assert.equal(await readFile(responseFile, "utf8"), response);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a saved provider rejection left pending by an interruption settles at zero before distinct dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-bounded-recover-rate-limit-"));
  try {
    const descriptor = openRouterModelClientDescriptor([model.id]);
    const ledger = new DurableSpendLedger(
      root,
      "operation-recover-rate-limit",
      hashJson("context"),
    );
    const maximum = maximumRequestCost(model, request);
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: maximum * 2 });
    const requestHash = modelTurnRequestHash(request, descriptor);
    const stage = "control_first";
    const requestId = DurableSpendLedger.requestId(`${stage}:2`, requestHash);
    await ledger.reserve({ requestId, requestHash, stage, maximumUsd: maximum });
    const result = rateLimit(requestHash);
    const receiptDirectory = join(ledger.directory, "model-receipts", hashJson(stage));
    await mkdir(receiptDirectory, { recursive: true });
    await writeFile(
      join(receiptDirectory, "1.response.json"),
      JSON.stringify({
        requestId: "earlier-response",
        result: { message: { content: "x".repeat(5 * 1024 * 1024) } },
      }),
    );
    await writeFile(
      join(receiptDirectory, "2.response.json"),
      JSON.stringify({
        requestId,
        requestHash,
        imageInputs: [],
        result,
        resultHash: hashJson(result),
        generationId: null,
      }),
    );
    const { client, state } = scriptedClient([
      (hash) => answer(hash, "gen-second"),
      (hash) => answer(hash, "gen-third"),
    ]);
    await new BoundedModelClient(client, ledger, [model], "control_second").complete(request);
    assert.equal(state.calls, 1);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => [entry.status, entry.billedUsd]),
      [
        ["billed", 0],
        ["billed", 0.00001],
      ],
    );
    assert.equal((await ledger.read()).entries[0]?.reservedUsd, maximum);
    // The stage replays its saved rejection without a dispatch. Then it waits and tries again.
    const waits: number[] = [];
    const resumed = recordWaits(
      new BoundedModelClient(client, ledger, [model], stage, false, undefined, 1),
      waits,
    );
    const retried = await resumed.complete(request);
    assert.equal(retried.kind, "assistant");
    assert.equal(state.calls, 2);
    assert.deepEqual(waits, [20_000]);
    assert.equal(resumed.completedCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runaway stop reconciles a reported charge and keeps an unknown charge pending", async () => {
  for (const reported of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "basalt-runaway-"));
    try {
      const ledger = new DurableSpendLedger(root, "runaway", hashJson("context"));
      await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
      let streams = 0;
      let lookups = 0;
      const transport = new OpenRouterModelClient({
        apiKey: "offline-test",
        allowedModels: [model.id],
        pause: async () => {},
        fetchImpl: async (url, init) => {
          if (String(url).startsWith("https://openrouter.ai/api/v1/generation")) {
            lookups++;
            return reported
              ? generationRecord("gen-runaway", 0.004)
              : new Response("{}", { status: 404 });
          }
          streams++;
          return endlessStream(init?.signal, [], () =>
            chunk("gen-runaway", { content: " ".repeat(512) }),
          );
        },
      });
      const stage = "builder:runaway";
      const input: ModelTurnRequest = {
        ...request,
        tools: [
          {
            name: "workspace.list",
            description: "List files.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      };
      const bounded = new BoundedModelClient(transport, ledger, [model], stage);
      if (reported) {
        const result = await bounded.complete(input);
        assert.equal(result.kind, "provider_error");
        if (result.kind === "provider_error") assert.equal(result.errorClass, "runaway_output");
        assert.equal(result.usage.costUsd, 0.004);
        const entry = (await ledger.read()).entries[0]!;
        assert.equal(entry.status, "billed");
        assert.equal(entry.billedUsd, 0.004);
        assert.equal(lookups, 1);
      } else {
        await assert.rejects(bounded.complete(input), ModelRequestPendingError);
        const entry = (await ledger.read()).entries[0]!;
        assert.equal(entry.status, "pending");
        assert.equal(entry.billedUsd, null);
        assert.equal(lookups, 10);
        const saved = JSON.parse(
          await readFile(
            join(ledger.directory, "model-receipts", hashJson(stage), "1.response.json"),
            "utf8",
          ),
        ) as { generationId: string; result: ModelTurnResult };
        assert.equal(saved.generationId, "gen-runaway");
        // Check payment status reads the charge later. It sends no model request.
        const recovered = await reconcileSavedModelBilling(ledger, async (generationId) => ({
          generationId,
          costUsd: 0.005,
        }));
        assert.deepEqual(
          recovered.map((item) => item.outcome),
          ["reconciled"],
        );
        const settled = (await ledger.read()).entries[0]!;
        assert.equal(settled.status, "billed");
        assert.equal(settled.billedUsd, 0.005);
      }
      assert.equal(streams, 1, "Basalt does not send a runaway request again");
      const failures = await failureFiles(ledger);
      assert.equal(failures.length, 1);
      const failure = JSON.parse(
        await readFile(join(ledger.directory, "failures", failures[0]!), "utf8"),
      ) as { causeCode: string; recoveryActions: string[] };
      assert.equal(failure.causeCode, "runaway_output");
      assert.deepEqual(failure.recoveryActions, reported ? ["inspect"] : ["inspect", "reconcile"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("read-only generation lookup accepts only the exact billed generation", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
    return new Response(
      JSON.stringify({
        data: {
          id: "gen-valid",
          total_cost: 0.003,
          created_at: "2026-09-23T00:00:00.000Z",
          model: "openai/gpt-6-luna-test",
          provider_name: "OpenAI",
          cancelled: false,
          request_id: "req-valid",
        },
      }),
      {
        status: 200,
      },
    );
  };
  assert.deepEqual(await lookupOpenRouterGenerationBilling("gen-valid", "secret", fetcher), {
    generationId: "gen-valid",
    costUsd: 0.003,
    createdAt: "2026-09-23T00:00:00.000Z",
    model: "openai/gpt-6-luna-test",
    providerName: "OpenAI",
    cancelled: false,
    requestId: "req-valid",
  });
  assert.equal(calls[0], "https://openrouter.ai/api/v1/generation?id=gen-valid");
  await assert.rejects(
    lookupOpenRouterGenerationBilling("gen-other", "secret", fetcher),
    /matching known USD charge/,
  );
});

test("image dimensions, not base64 bytes, determine media accounting", () => {
  const encoded = (filterType: number) => {
    const png = new PNG({ width: 64, height: 64 });
    png.data.fill(255);
    return PNG.sync.write(png, { filterType });
  };
  const requestWithImage = (bytes: Buffer): ModelTurnRequest => ({
    ...request,
    messages: [
      {
        role: "user",
        content: "Inspect this image",
        images: [
          {
            mediaType: "image/png",
            hash: contentHash(bytes),
            dataBase64: bytes.toString("base64"),
            label: "Image 1: frame-1.",
          },
        ],
      },
    ],
  });
  const first = encoded(0),
    second = encoded(4);
  assert.notEqual(first.length, second.length);
  assert.equal(
    maximumRequestCost(model, requestWithImage(first)),
    maximumRequestCost(model, requestWithImage(second)),
  );
  const invalid = requestWithImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.throws(() => maximumRequestCost(model, invalid), /dimension header/);
});

test("reservation checks the costly side of a falling context price tier", () => {
  const falling: ModelSnapshot = {
    ...model,
    endpoints: [
      {
        ...model.endpoints[0]!,
        tiers: [
          { ...model.endpoints[0]!.tiers[0]!, inputPerTokenUsd: 0.01 },
          { ...model.endpoints[0]!.tiers[0]!, minPromptTokens: 1000, inputPerTokenUsd: 0.000001 },
        ],
      },
    ],
  };
  const upper = maximumRequestCost(falling, request);
  assert.ok(upper >= 999 * 0.01);
});
