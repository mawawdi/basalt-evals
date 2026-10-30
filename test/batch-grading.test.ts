import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runJudgmentBatch } from "../packages/agent-runtime/src/batch-grading.js";
import { ProviderPauseError } from "../packages/agent-runtime/src/retries.js";
import { contentHash, hashJson } from "../packages/contracts/src/index.js";
import {
  batchJudgmentRequest,
  parseBatchJudgment,
  type BatchCriterion,
} from "../packages/eval-authoring/src/batch-judgment.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import type { ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { fixtureAdapters, fixtureSnapshots } from "./shared-api-fixture.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import { OpenRouterModelClient } from "../packages/model-client/src/openrouter-ai-sdk.js";
import { streamedCompletion } from "./openrouter-stream.js";
import { modelRoute } from "../packages/model-client/src/catalog.js";
import { gradingConfiguration } from "../packages/eval-authoring/src/scoring.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";

test("recorded MiMo output starvation stays incomplete, billed and replayable without redispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-grading-output-limit-"));
  try {
    const snapshot = structuredClone(
      fixtureSnapshots.find((model) => model.id === "xiaomi/mimo-v2.6-flash")!,
    );
    snapshot.reasoning = {
      defaultEffort: null,
      defaultEnabled: null,
      effortSelection: "unavailable",
      mandatory: false,
      supportedEfforts: [],
      supportsTokenBudget: null,
    };
    snapshot.endpoints[0]!.supportedParameters.push("reasoning", "include_reasoning");
    snapshot.endpoints[0]!.maxOutputTokens = 943718;
    snapshot.endpoints[0]!.tiers[0]!.outputPerTokenUsd = 0.00001;
    const ledger = new DurableSpendLedger(root, "grading-output-limit", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    let calls = 0;
    const client = new OpenRouterModelClient({
      apiKey: "offline-test",
      allowedModels: [snapshot.id],
      routes: { [snapshot.id]: modelRoute(snapshot) },
      fetchImpl: async () => {
        calls++;
        // Recorded 2026-09-30 response facts and usage, without private model reasoning.
        return streamedCompletion({
          id: "gen-synthetic-recorded-output-limit",
          model: snapshot.id,
          provider: "DeepInfra",
          choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }],
          usage: {
            prompt_tokens: 203785,
            completion_tokens: 8192,
            total_tokens: 211977,
            completion_tokens_details: { reasoning_tokens: 8190 },
            cost: 0.03082366,
          },
        });
      },
    });
    const input = {
      client,
      ledger,
      snapshot,
      stage: "judgment:recorded-output-limit",
      configuration: {
        modelId: snapshot.id,
        seed: 1,
        maxOutputTokens: 8192,
        sampling: catalogRecommendedSampling(null),
      },
      presentation: "still" as const,
      publicTask: "Build a beacon.",
      criteria: [
        {
          id: "presence",
          statement: "A Beacon object exists.",
          authoredPassages: ["A Beacon object exists."],
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          comparisons: [],
          anchors: null,
          scoreRange: null,
          minimumPassingScore: null,
        },
      ],
      criterionEvidence: [pendingCriterionMaterial("presence")],
      context: { actors: [], intervals: [] },
      images: [],
    };
    await assert.rejects(runJudgmentBatch(input), /reasoning_exhausted/);
    const before = await ledger.read();
    assert.equal(before.entries.length, 1);
    assert.equal(before.entries[0]!.status, "billed");
    assert.equal(before.entries[0]!.billedUsd, 0.03082366);
    const receipt = JSON.parse(
      await readFile(
        join(ledger.directory, "model-receipts", hashJson(input.stage), "1.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.result.stopReason, "max_tokens");
    assert.equal(receipt.result.responseFacts.finishReason, "length");
    assert.equal(receipt.result.usage.reasoningTokens, 8190);
    assert.equal(receipt.result.usage.outputTokens, 8192);
    await assert.rejects(runJudgmentBatch({ ...input, replayOnly: true }), /reasoning_exhausted/);
    await assert.rejects(
      runJudgmentBatch({
        ...input,
        configuration: gradingConfiguration(snapshot, 1),
        replayOnly: true,
      }),
      /does not match its saved request/,
    );
    assert.deepEqual((await ledger.read()).entries, before.entries);
    assert.equal(
      calls,
      1,
      "A new grading policy cannot replay or silently replace the paid request",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a grading rate limit settles at zero, and the client tries it again as a distinct request", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-grading-rate-limit-"));
  try {
    await mkdir(join(root, ".basalt-evals"));
    await writeFile(
      join(root, ".basalt-evals/synthetic-failure.json"),
      JSON.stringify({ kind: "rate_limit" }),
    );
    const snapshot = fixtureSnapshots.find((model) => model.id === "xiaomi/mimo-v2.6-flash")!;
    const ledger = new DurableSpendLedger(root, "grading-rate-limit", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const pauses: number[] = [];
    // Each pause re-arms the synthetic 429 while `persistent` is set.
    let persistent = false;
    const input = {
      client: fixtureAdapters(root).model([snapshot]),
      ledger,
      snapshot,
      stage: "judgment:rate-limit",
      configuration: {
        modelId: snapshot.id,
        seed: 1,
        maxOutputTokens: 8192,
        sampling: catalogRecommendedSampling(null),
      },
      presentation: "still" as const,
      publicTask: "Build a beacon.",
      criteria: [
        {
          id: "presence",
          statement: "A Beacon object exists.",
          authoredPassages: ["A Beacon object exists."],
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          comparisons: [],
          anchors: null,
          scoreRange: null,
          minimumPassingScore: null,
        },
      ],
      criterionEvidence: [pendingCriterionMaterial("presence")],
      context: { actors: [], intervals: [] },
      images: [],
      rateLimitPause: async (milliseconds: number) => {
        pauses.push(milliseconds);
        if (persistent) await rm(join(root, ".basalt-evals/synthetic-failure-applied"));
      },
    };
    const calls = async () =>
      (await readFile(join(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")).trim().split("\n")
        .length;
    const result = await runJudgmentBatch(input);
    assert.equal(result.decisions[0]?.criterionId, "presence");
    assert.equal(result.responses.length, 1, "the artifact binds only the accepted response");
    assert.deepEqual(pauses, [20_000]);
    assert.equal(await calls(), 2);
    const settled = await ledger.read();
    assert.deepEqual(
      settled.entries.map((entry) => entry.status),
      ["billed", "billed"],
    );
    assert.notEqual(settled.entries[0]!.requestId, settled.entries[1]!.requestId);
    assert.equal(settled.entries[0]!.billedUsd, 0, "the provider rejection has no charge");
    const replay = await runJudgmentBatch({ ...input, replayOnly: true });
    assert.deepEqual(replay.decisions, result.decisions);
    assert.deepEqual(replay.responseHashes, result.responseHashes);
    assert.deepEqual((await ledger.read()).entries, settled.entries);
    assert.equal(await calls(), 2, "replay never dispatches or waits");
    assert.deepEqual(pauses, [20_000]);

    persistent = true;
    await rm(join(root, ".basalt-evals/synthetic-failure-applied"));
    // A rate limit after the final try is a persistent failure, so it pauses the judgment.
    await assert.rejects(
      runJudgmentBatch({ ...input, stage: "judgment:exhausted" }),
      (error: unknown) =>
        error instanceof ProviderPauseError &&
        error.scope === "persistent" &&
        error.errorClass === "http_429" &&
        error.ordinal === 4,
    );
    assert.deepEqual(pauses, [20_000, 20_000, 60_000, 120_000]);
    assert.equal(await calls(), 6);
    const exhausted = (await ledger.read()).entries.slice(2);
    assert.deepEqual(
      exhausted.map((entry) => [entry.status, entry.billedUsd]),
      [
        ["billed", 0],
        ["billed", 0],
        ["billed", 0],
        ["billed", 0],
      ],
    );
    await assert.rejects(
      runJudgmentBatch({ ...input, stage: "judgment:exhausted", replayOnly: true }),
      /http_429/,
    );
    assert.equal(await calls(), 6);
    assert.equal(pauses.length, 4, "replay never waits");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed grading answer keeps its charge and is followed by a distinct quoted retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-grading-malformed-"));
  try {
    await mkdir(join(root, ".basalt-evals"));
    const snapshot = fixtureSnapshots.find((model) => model.id === "xiaomi/mimo-v2.6-flash")!;
    const ledger = new DurableSpendLedger(root, "grading-malformed", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const pauses: number[] = [];
    const input = {
      client: fixtureAdapters(root).model([snapshot]),
      ledger,
      snapshot,
      stage: "judgment:malformed",
      configuration: {
        modelId: snapshot.id,
        seed: 1,
        maxOutputTokens: 8192,
        sampling: catalogRecommendedSampling(null),
      },
      presentation: "still" as const,
      publicTask: "Build a beacon.",
      criteria: [
        {
          id: "presence",
          statement: "A Beacon object exists.",
          authoredPassages: ["A Beacon object exists."],
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          comparisons: [],
          anchors: null,
          scoreRange: null,
          minimumPassingScore: null,
        },
      ],
      criterionEvidence: [pendingCriterionMaterial("presence")],
      context: { actors: [], intervals: [] },
      images: [],
      rateLimitPause: async (milliseconds: number) => {
        pauses.push(milliseconds);
      },
    };
    const failure = async (attempts?: number) => {
      await rm(join(root, ".basalt-evals/synthetic-failure-applied"), { force: true });
      await rm(join(root, ".basalt-evals/synthetic-failure-attempts"), { force: true });
      await writeFile(
        join(root, ".basalt-evals/synthetic-failure.json"),
        JSON.stringify({ kind: "malformed_batch", ...(attempts ? { attempts } : {}) }),
      );
    };
    const calls = async () =>
      (await readFile(join(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")).trim().split("\n")
        .length;
    const request = batchJudgmentRequest({ ...input, observation: null });
    const schema = request.tools[0]!.parameters as {
      properties: { decisions: { items: { properties: { score: unknown } } } };
    };
    assert.deepEqual(
      schema.properties.decisions.items.properties.score,
      { type: "null" },
      "an unscaled batch offers no numeric score",
    );

    await failure(1);
    const result = await runJudgmentBatch(input);
    assert.equal(result.decisions[0]?.criterionId, "presence");
    assert.equal(result.responses.length, 1, "the artifact binds only the accepted response");
    assert.equal(await calls(), 2);
    assert.deepEqual(pauses, [], "only a rate limit waits before retrying");
    const settled = await ledger.read();
    assert.deepEqual(
      settled.entries.map((entry) => entry.status),
      ["billed", "billed"],
    );
    assert.notEqual(settled.entries[0]!.requestId, settled.entries[1]!.requestId);
    const replay = await runJudgmentBatch({ ...input, replayOnly: true });
    assert.deepEqual(replay.decisions, result.decisions);
    assert.deepEqual(replay.responseHashes, result.responseHashes);
    assert.equal(await calls(), 2, "replay follows the retained sequence without dispatching");

    await failure();
    await assert.rejects(
      runJudgmentBatch({ ...input, stage: "judgment:exhausted" }),
      /The judge did not give exactly one answer for each criterion/,
    );
    assert.equal(await calls(), 5);
    await assert.rejects(
      runJudgmentBatch({ ...input, stage: "judgment:exhausted", replayOnly: true }),
      /The judge did not give exactly one answer for each criterion/,
    );
    assert.equal(await calls(), 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grounded grading separates perception, preserves independent decisions and consumes retained calls once", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-grounded-"));
  try {
    await mkdir(join(root, ".basalt-evals"));
    const snapshot = fixtureSnapshots.find((model) => model.id === "xiaomi/mimo-v2.6-flash")!;
    const ledger = new DurableSpendLedger(root, "grounded", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    const png = new PNG({ width: 32, height: 32 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png);
    const image = {
      hash: contentHash(bytes),
      mediaType: "image/png" as const,
      dataBase64: bytes.toString("base64"),
    };
    const criteria: BatchCriterion[] = [
      {
        id: "color",
        statement: "Secret-only private blue criterion.",
        authoredPassages: ["Secret-only private blue criterion."],
        required: true,
        evidenceClass: null,
        polarity: "presence" as const,
        comparisons: [],
        scoreRange: null,
        anchors: null,
        minimumPassingScore: null,
      },
      {
        id: "presence",
        statement: "An object is visible.",
        authoredPassages: ["An object is visible."],
        required: true,
        evidenceClass: null,
        polarity: "presence" as const,
        comparisons: [],
        scoreRange: null,
        anchors: null,
        minimumPassingScore: null,
      },
    ];
    const input = {
      client: fixtureAdapters(root).model([snapshot]),
      ledger,
      snapshot,
      stage: "judgment:grounded",
      configuration: gradingConfiguration(snapshot, 1),
      presentation: "grounded-sequence" as const,
      publicTask: "Build a blue beacon.",
      criteria,
      criterionEvidence: criteria.map((criterion) => pendingCriterionMaterial(criterion.id)),
      context: {
        actors: ["viewer"],
        intervals: Array.from({ length: 20 }, (_, index) => ({
          frameId: `frame-${index}`,
          actor: "viewer",
          startMs: index * 500,
          endMs: index * 500 + 50,
          anchors: ["uniform"],
        })),
      },
      images: Array.from({ length: 20 }, (_, index) => ({
        ...image,
        label: `Image ${index + 1}: frame-${index}.`,
      })),
    };
    input.criterionEvidence[0]!.signedObservations = [
      {
        binding: { phaseId: "scene", factId: "actual-name" },
        observation: {
          kind: "instance_name",
          factId: "actual-name",
          exists: true,
          name: "ObservedName",
        },
        hash: hashJson("signed-observation"),
      },
    ];
    input.criterionEvidence[1]!.unavailable = ["Required observation was not acquired: presence"];
    const result = await runJudgmentBatch(input);
    assert.equal(result.responses.length, 2);
    const log = (await readFile(join(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(log.length, 2);
    for (const call of log) {
      assert.deepEqual(call.request.reasoning, input.configuration.reasoning);
      assert.equal(call.request.maxOutputTokens, input.configuration.maxOutputTokens);
    }
    assert.equal(JSON.stringify(log[0].request).includes("Secret-only"), false);
    assert.equal(JSON.stringify(log[0].request).includes("ObservedName"), false);
    assert.equal(log[1].request.messages[0].images, undefined);
    assert.equal(JSON.stringify(log[1].request).includes("ObservedName"), true);
    // The pre-call gate keeps the criterion without acquired evidence out of the request.
    assert.equal(JSON.stringify(log[1].request).includes("An object is visible."), false);
    assert.equal(result.decisions.length, 2);
    assert.equal(result.decisions[0]!.verdict, "satisfied");
    assert.equal(
      result.decisions[1]!.verdict,
      "insufficient",
      "A model's positive answer cannot fill missing acquisition for its dependent criterion",
    );
    assert.equal(result.decisions[1]!.confidence, 0);
    assert.deepEqual(result.decisionAuthorities, { color: "model", presence: "deterministic" });
    const replay = await runJudgmentBatch({ ...input, replayOnly: true });
    assert.equal(hashJson(replay), hashJson(result));
    assert.equal(
      (await readFile(join(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")).trim().split("\n")
        .length,
      2,
    );
    assert.equal((await ledger.read()).entries.length, 2);
    const missing = await runJudgmentBatch({
      ...input,
      stage: "judgment:missing",
      images: [],
      context: { actors: [], intervals: [] },
      criterionEvidence: input.criterionEvidence.map((item) => ({
        ...item,
        unavailable: ["Required rendered acquisition is incomplete"],
      })),
    });
    assert.equal(missing.responses.length, 0);
    assert.deepEqual(missing.decisionAuthorities, {
      color: "deterministic",
      presence: "deterministic",
    });
    assert.ok(missing.decisions.every((decision) => decision.verdict === "insufficient"));
    assert.equal(
      (await ledger.read()).entries.length,
      2,
      "Missing acquisition must not dispatch a paid judgment",
    );
    const runtimeOnly = await runJudgmentBatch({
      ...input,
      stage: "judgment:runtime-only",
      images: [],
      context: { actors: [], intervals: [] },
      criteria: [criteria[0]!],
      criterionEvidence: [input.criterionEvidence[0]!],
    });
    assert.equal(
      runtimeOnly.responses.length,
      1,
      "Signed runtime facts can be judged without an image or a perception call",
    );
    assert.equal(runtimeOnly.decisionAuthorities.color, "model");
    assert.equal(runtimeOnly.decisions.length, 1);
    assert.equal((await ledger.read()).entries.length, 3);
    function response(decisions: unknown): ModelTurnResult {
      const response = structuredClone(result.responses[1]!);
      assert.equal(response.kind, "assistant");
      if (response.kind === "assistant")
        response.message.toolCalls[0]!.arguments = {
          addressedToEvaluator: { found: false, quote: null },
          // The judge writes the answer word in the verdict field.
          decisions: (decisions as Array<Record<string, unknown>>).map(
            ({ answer: _answer, ...decision }) => decision,
          ),
        };
      return response;
    }
    assert.throws(
      () => parseBatchJudgment(response([result.decisions[0]]), criteria),
      /exactly one answer for each criterion/,
    );
    assert.throws(
      () => parseBatchJudgment(response([result.decisions[0], result.decisions[0]]), criteria),
      /repeats a criterion or has a value that is not valid/,
    );
    assert.throws(
      () =>
        parseBatchJudgment(
          response([{ ...result.decisions[0]!, rationale: "x".repeat(801) }, result.decisions[1]]),
          criteria,
        ),
      /repeats a criterion or has a value that is not valid/,
    );
    const independentlyUnresolved = [
      result.decisions[0],
      { ...result.decisions[1]!, verdict: "insufficient" },
    ];
    assert.equal(
      parseBatchJudgment(response(independentlyUnresolved), criteria).decisions[0]!.verdict,
      "satisfied",
    );
    assert.throws(
      () =>
        parseBatchJudgment(
          response([{ ...result.decisions[0]!, score: 1 }, result.decisions[1]]),
          criteria,
        ),
      /score for a criterion that has no score scale/,
    );
    const scaled = [
      {
        ...criteria[0]!,
        scoreRange: null,
        anchors: [
          { score: 0, label: "No color", description: "No blue color is visible." },
          { score: 1, label: "Blue", description: "Blue color is visible." },
        ],
        minimumPassingScore: null,
      },
      criteria[1]!,
    ];
    const scored = [
      { ...result.decisions[0]!, score: 1, verdict: "insufficient" },
      result.decisions[1],
    ];
    assert.equal(parseBatchJudgment(response(scored), scaled).decisions[0]!.score, 1);
    assert.throws(
      () =>
        parseBatchJudgment(response([{ ...scored[0], verdict: "satisfied" }, scored[1]]), scaled),
      /minimum score for Met/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
