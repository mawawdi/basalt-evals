import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { contentHash, hashJson } from "../packages/contracts/src/index.js";
import type { BenchmarkRequestTelemetry } from "../packages/contracts/src/benchmarks.js";
import type {
  RunOperationEvent,
  RunOperationManifest,
} from "../packages/contracts/src/execution.js";
import {
  benchmarkSuccessBounds,
  benchmarkStageTiming,
  stageActiveMs,
  summarizeBenchmarkTelemetry,
} from "../packages/experiments/src/benchmarks.js";
import { readBenchmarkReceipts } from "../packages/model-client/src/benchmark-receipts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";
import { requestSampling } from "../packages/operator/src/request-sampling.js";

function request(patch: Partial<BenchmarkRequestTelemetry>): BenchmarkRequestTelemetry {
  return {
    operationId: "run",
    requestId: "one",
    stage: "builder:one",
    role: "builder",
    dispatched: true,
    receiptHash: "record",
    status: "billed",
    billedUsd: 0.2,
    reservedUsd: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: null,
      costUsd: 0.2,
    },
    imageInputs: [],
    latencyMs: 200,
    resultKind: "assistant",
    stopReason: "end_turn",
    cut: null,
    requestedModel: "builder",
    resolvedModel: null,
    servingProvider: null,
    issue: null,
    ...patch,
  };
}

test("benchmark role accounting keeps null counters, failed charges and pending charges distinct", () => {
  const rows = [
    request({}),
    request({
      requestId: "two",
      role: "grader",
      stage: "judgment:two",
      billedUsd: 0.1,
      resultKind: "provider_error",
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.1,
      },
      latencyMs: 600,
    }),
    // A provider rejection settles at zero and releases its reservation.
    request({
      requestId: "three",
      role: "grader",
      stage: "judgment:three",
      billedUsd: 0,
      reservedUsd: 0.4,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
      },
      latencyMs: null,
      resultKind: "provider_error",
    }),
    request({
      requestId: "four",
      stage: "builder:four",
      status: "pending",
      billedUsd: null,
      reservedUsd: 0.3,
      usage: null,
      latencyMs: null,
      resultKind: null,
      dispatched: null,
    }),
    request({ requestId: "five", role: "preparation", stage: "prepare_public", billedUsd: 0.05 }),
    request({
      requestId: "six",
      stage: "builder:six",
      dispatched: false,
      billedUsd: 0,
      usage: null,
      latencyMs: null,
      resultKind: null,
    }),
  ];
  const report = summarizeBenchmarkTelemetry(rows);
  assert.equal(report.knownChargeUsd, 0.35000000000000003);
  assert.equal(report.activeReservedUsd, 0.3);
  const builder = report.roles.find((row) => row.role === "builder")!;
  assert.deepEqual(builder.tokens.inputTokens, {
    knownTotal: 100,
    knownRequests: 1,
    eligibleRequests: 2,
  });
  assert.equal(builder.tokens.outputTokens.knownTotal, 20);
  assert.equal(builder.tokens.reasoningTokens.knownTotal, 10); // subset; never added to input/output
  assert.deepEqual(builder.requests, {
    retained: 3,
    dispatched: 1,
    dispatchUnknown: 1,
    notDispatched: 1,
  });
  const grader = report.roles.find((row) => row.role === "grader")!;
  assert.equal(grader.tokens.inputTokens.knownTotal, null);
  assert.equal(grader.modelTurnElapsedMs.median, 600);
  assert.equal(grader.knownFailedRequests, 2);
  assert.equal(grader.charges.knownUsd, 0.1);
  assert.equal(grader.charges.settledRequests, 2);
  assert.equal(grader.charges.activeReservedUsd, 0);
  assert.throws(() => summarizeBenchmarkTelemetry([...rows, rows[0]!]), /Duplicate/);
});

test("full-plan case bounds macro-average cases and keep all-attempt consistency separate", () => {
  const cases = [
    {
      evaluationId: "one",
      successRuleHash: hashJson("one"),
      attempts: [
        { subjectId: "a", outcome: "succeeded" as const },
        { subjectId: "b", outcome: "succeeded" as const },
        { subjectId: "c", outcome: "unknown" as const },
      ],
    },
    {
      evaluationId: "two",
      successRuleHash: hashJson("two"),
      attempts: [{ subjectId: "d", outcome: "failed" as const }],
    },
  ];
  const report = benchmarkSuccessBounds(cases);
  assert.deepEqual(report.macroAttemptSuccess, { lower: 1 / 3, upper: 0.5 });
  assert.deepEqual(report.allAttemptsSuccess, { lower: 0, upper: 0.5 });
  assert.equal(report.plannedAttempts, 4);
  const unknown = benchmarkSuccessBounds([
    {
      evaluationId: "no-rule",
      successRuleHash: null,
      attempts: [{ subjectId: "u", outcome: "unknown" }],
    },
  ]);
  assert.equal(unknown.macroAttemptSuccess, null);
  assert.equal(unknown.casesWithRule, 0);
  assert.throws(
    () =>
      benchmarkSuccessBounds([
        {
          evaluationId: "bad",
          successRuleHash: null,
          attempts: [{ subjectId: "u", outcome: "succeeded" }],
        },
      ]),
    /cannot invent/,
  );
});

test("stage clocks include terminal failures and exclude unresolved or absent boundaries", () => {
  const at = (ms: number) => new Date(Date.parse("2026-09-30T00:00:00Z") + ms).toISOString();
  const event = (id: string, kind: RunOperationEvent["kind"], ms: number) =>
    ({ unitId: id, stage: "builder", kind, at: at(ms) }) as RunOperationEvent;
  const report = benchmarkStageTiming(
    [
      event("a", "started", 0),
      event("a", "completed", 100),
      event("b", "started", 20),
      event("b", "failed", 220),
      event("c", "started", 0),
      event("c", "incomplete", 900),
    ],
    "builder",
    ["a", "b", "c", "d"],
  );
  assert.equal(report.elapsedMs.median, 150);
  assert.equal(report.elapsedMs.count, 2);
  assert.equal(report.elapsedMs.eligible, 4);
  assert.equal(report.failedUnits, 1);
  assert.equal(report.censoredUnits, 1);
  assert.equal(report.missingBoundaries, 1);
});

test("paused intervals do not count as build time", () => {
  const at = (ms: number) => new Date(Date.parse("2026-09-30T00:00:00Z") + ms).toISOString();
  const event = (id: string, kind: RunOperationEvent["kind"], ms: number) =>
    ({ unitId: id, stage: "builder", kind, at: at(ms) }) as RunOperationEvent;
  const events = [
    event("a", "started", 0),
    event("a", "paused", 100),
    event("a", "started", 60_000),
    event("a", "completed", 60_300),
    event("b", "started", 0),
    event("b", "paused", 500),
    // A provider pause also ends an interval. Live step 3 paused one build twice for a 502.
    event("c", "started", 0),
    event("c", "provider_paused", 56_000),
    event("c", "started", 1_035_000),
    event("c", "provider_paused", 1_343_000),
    event("c", "started", 1_756_000),
    event("c", "completed", 1_864_000),
  ];
  assert.equal(stageActiveMs(events, "builder", "a"), 400);
  assert.equal(stageActiveMs(events, "builder", "c"), 56_000 + 308_000 + 108_000);
  assert.equal(stageActiveMs(events, "builder", "b"), null, "a paused build has no build time yet");
  const report = benchmarkStageTiming(events, "builder", ["a", "b", "c"]);
  assert.equal(report.elapsedMs.count, 2, "both resumed builds have a build time");
  assert.equal(report.elapsedMs.maximum, 472_000);
  assert.equal(report.censoredUnits, 1);
});

test("receipt projection binds original identities and preserves billing while rejecting corrupt telemetry", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-benchmark-receipts-"));
  const stage = "builder:subject",
    operationId = "benchmark",
    requestHash = hashJson("request");
  const ledger = new DurableSpendLedger(root, operationId, hashJson("context"));
  try {
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const requestId = DurableSpendLedger.requestId(`${stage}:1`, requestHash);
    await ledger.reserve({ requestId, requestHash, stage, maximumUsd: 0.5 });
    const dir = resolve(ledger.directory, "model-receipts", hashJson(stage));
    await mkdir(dir, { recursive: true });
    const result = {
      kind: "provider_error",
      errorClass: "http_429",
      providerErrorType: null,
      message: "offline fixture",
      retryable: false,
      requestHash,
      usage: {
        inputTokens: 0,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
      },
      responseFacts: {
        requestedModel: "fixture",
        resolvedModel: null,
        servingProvider: null,
        responseId: null,
        latencyMs: 120,
        requestedServiceTier: null,
        servingServiceTier: null,
        retryCount: 0,
        finishReason: null,
        continuationHash: null,
        continuationBytes: null,
      },
    };
    const imageInputs = [{ hash: "a".repeat(64), width: 1280, height: 720 }];
    const receipt = { requestId, requestHash, imageInputs, result, resultHash: hashJson(result) };
    const saved = JSON.stringify(receipt);
    await writeFile(resolve(dir, "1.response.json"), saved);
    const before = await ledger.read();
    const projection = await readBenchmarkReceipts(root, operationId);
    // The receipt hash is the hash of the saved bytes, also when they are not canonical JSON.
    assert.equal(projection.requests[0]!.receiptHash, contentHash(saved));
    assert.notEqual(projection.requests[0]!.receiptHash, hashJson(receipt));
    assert.equal(projection.requests[0]!.usage!.inputTokens, 0);
    // The prompt tokens and the request images stay together for a later comparison.
    assert.deepEqual(projection.requests[0]!.imageInputs, imageInputs);
    assert.equal(projection.requests[0]!.usage!.outputTokens, null);
    assert.equal(projection.requests[0]!.billedUsd, null);
    assert.equal(projection.requests[0]!.latencyMs, 120);
    assert.equal(projection.requests[0]!.dispatched, true);
    assert.equal(projection.requests[0]!.issue, null);
    // A provider failure has no stop reason, and the output limit did not cut it.
    assert.deepEqual(
      [projection.requests[0]!.stopReason, projection.requests[0]!.cut],
      [null, null],
    );
    assert.deepEqual(await ledger.read(), before);
    // A provider rejection without a generation ID settles at zero, and its saved result agrees.
    await ledger.reconcile(requestId, 0);
    const settled = await readBenchmarkReceipts(root, operationId);
    assert.equal(settled.requests[0]!.status, "billed");
    assert.equal(settled.requests[0]!.billedUsd, 0);
    assert.equal(settled.requests[0]!.issue, null);
    const after = await ledger.read();
    await writeFile(
      resolve(dir, "1.response.json"),
      JSON.stringify({ ...receipt, resultHash: hashJson("wrong") }),
    );
    const corrupt = await readBenchmarkReceipts(root, operationId);
    assert.equal(corrupt.requests[0]!.usage, null);
    assert.match(corrupt.requests[0]!.issue!, /hash/);
    assert.deepEqual(await ledger.read(), after);
    // A saved provider failure keeps only a documented error type.
    const untyped = { ...result, providerErrorType: "private_unknown_type" };
    await writeFile(
      resolve(dir, "1.response.json"),
      JSON.stringify({ ...receipt, result: untyped, resultHash: hashJson(untyped) }),
    );
    const unknownType = await readBenchmarkReceipts(root, operationId);
    assert.equal(unknownType.requests[0]!.usage, null);
    assert.match(unknownType.requests[0]!.issue!, /error type/);
    // An answer that the output limit cut keeps its stop reason and the class of the cut.
    const cutResult = {
      kind: "assistant",
      message: { role: "assistant", content: "", toolCalls: [] },
      stopReason: "max_tokens",
      responseHash: hashJson("response"),
      requestHash,
      usage: { ...result.usage, costUsd: 0 },
      responseFacts: { ...result.responseFacts, finishReason: "length" },
    };
    await writeFile(
      resolve(dir, "1.response.json"),
      JSON.stringify({ ...receipt, result: cutResult, resultHash: hashJson(cutResult) }),
    );
    const cut = await readBenchmarkReceipts(root, operationId);
    assert.deepEqual(
      [cut.requests[0]!.stopReason, cut.requests[0]!.cut, cut.requests[0]!.issue],
      ["max_tokens", "reasoning_exhausted", null],
    );
    const unknownStop = { ...cutResult, stopReason: "private_stop" };
    await writeFile(
      resolve(dir, "1.response.json"),
      JSON.stringify({ ...receipt, result: unknownStop, resultHash: hashJson(unknownStop) }),
    );
    assert.match(
      (await readBenchmarkReceipts(root, operationId)).requests[0]!.issue!,
      /stop reason/,
    );
    await writeFile(
      resolve(dir, "1.local-failure.json"),
      JSON.stringify({ requestId, requestHash, costUsd: 0 }),
    );
    const noDispatch = await readBenchmarkReceipts(root, operationId);
    assert.equal(noDispatch.requests[0]!.dispatched, false);
    assert.equal(noDispatch.requests[0]!.usage, null);
    assert.deepEqual(await ledger.read(), after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("100-case three-model two-harness matrix retains every planned build and answer", async () => {
  const { projectBenchmarkReport } =
    await import("../packages/experiments/src/benchmark-projection.js");
  const subjects: unknown[] = [],
    captureCells: unknown[] = [],
    gradingCells: unknown[] = [],
    judgmentBatches: unknown[] = [],
    outcomes: import("../packages/contracts/src/benchmarks.js").BenchmarkCriterionOutcome[] = [];
  const models = ["one", "two", "three"].map((id) => ({
    id,
    name: id,
    revision: "pinned",
    endpoints: [{ provider: "fixture", quantization: "unknown" }],
  }));
  for (let caseIndex = 0; caseIndex < 100; caseIndex++)
    for (const model of models)
      for (const harness of ["production", "thin"])
        for (let repetition = 0; repetition < 3; repetition++) {
          const subjectId = `s-${caseIndex}-${model.id}-${harness}-${repetition}`;
          subjects.push({
            id: subjectId,
            evalId: `e-${caseIndex}`,
            kind: "generated",
            stageIndex: 1,
            parentSubjectId: null,
            builder: {
              model: { id: model.id },
              harness: { id: harness },
              environment: { fixture: true },
              transportConfigurationHash: "transport",
              randomSeed: 1,
            },
          });
          for (let pass = 0; pass < 3; pass++) {
            const captureId = `c-${subjectId}-${pass}`,
              cellId = `d-${captureId}`,
              batchId = `j-${captureId}`;
            captureCells.push({ id: captureId, treatmentId: subjectId, pass: pass + 1 });
            gradingCells.push({ id: cellId, captureCellId: captureId, criterionId: "behavior" });
            judgmentBatches.push({
              id: batchId,
              sampleGroupId: `g-${captureId}`,
              sample: 1,
              captureCellId: captureId,
              criterionIds: ["appearance", "timing"],
              configuration: { modelId: "fixed-grader" },
              presentation: "sequence",
            });
            // Missing and insufficient are different; only this first capture has a known answer.
            if (caseIndex === 0 && repetition === 0 && pass === 0)
              outcomes.push(
                {
                  cellId,
                  criterionId: "behavior",
                  method: "deterministic",
                  outcome: "met",
                  score: null,
                  samples: null,
                  observed: null,
                },
                {
                  cellId: batchId,
                  criterionId: "appearance",
                  method: "model",
                  outcome: "insufficient",
                  score: null,
                  samples: null,
                  observed: null,
                },
                {
                  cellId: batchId,
                  criterionId: "timing",
                  method: "model",
                  outcome: "scored",
                  score: 2,
                  samples: null,
                  observed: null,
                },
              );
          }
        }
  const status = {
    manifest: {
      id: "matrix",
      evals: Array.from({ length: 100 }, (_, i) => ({
        id: `e-${i}`,
        stage: {
          firstRevisionId: `e-${i}`,
          index: 1,
          count: 1,
          earlierPrompts: [],
          gateCriterionIds: [],
        },
      })),
      selectedModelIds: models.map((row) => row.id),
      selectedHarnessIds: ["production", "thin"],
      modelSnapshots: models,
      subjects,
      captureCells,
      gradingCells,
      judgmentBatches,
      planned: { independentBuilderTrials: 1800 },
      implementationCommit: "frozen",
      buildIdentityHash: "build",
      connectorArtifactHash: "connector",
      gradingMode: "all",
    },
    events: [],
    completedUnits: [],
    finished: true,
    stopped: false,
    inFlightUnits: [],
  } as unknown as import("../packages/contracts/src/execution.js").RunOperationStatus;
  const shared = request({
    requestId: "shared",
    stage: "prepare_public",
    role: "preparation",
    billedUsd: 0.1,
  });
  const owned = request({
    requestId: "owned",
    stage: "builder:s-0-one-production-0",
    billedUsd: 0.2,
  });
  const report = projectBenchmarkReport({
    status,
    title: "Offline synthetic matrix",
    outcomes,
    requests: [shared, owned],
    definitions: [
      {
        evaluationId: "e-0",
        criterionId: "timing",
        statement: "Authored timing",
        required: true,
        evidenceClass: "timing",
        scaleHash: "scale-a",
        scale: "0–2",
      },
      {
        evaluationId: "e-1",
        criterionId: "timing",
        statement: "Different scale",
        required: true,
        evidenceClass: "timing",
        scaleHash: "scale-b",
        scale: "0–100",
      },
    ],
  });
  assert.equal(report.rows.length, 6);
  assert.equal(report.plannedBuilds, 1800);
  assert.equal(report.plannedCaptures, 5400);
  assert.equal(report.requiredHumanJudgments, 0);
  assert.equal(report.sharedTelemetry.knownChargeUsd, 0.1);
  assert.equal(report.rows[0]!.telemetry.knownChargeUsd, 0.2);
  assert.equal(report.telemetry.knownChargeUsd, 0.30000000000000004);
  for (const row of report.rows) {
    assert.equal(row.plannedBuilds, 300);
    assert.equal(row.cases.length, 100);
    assert.equal(row.cases[0]!.builds.length, 3);
    assert.ok(
      row.cases.every(
        (item) => item.builds.flatMap((build) => build.marks).length === item.answers.planned,
      ),
      "each planned answer has one mark",
    );
    assert.deepEqual(row.answers, {
      planned: 2700,
      met: 1,
      rejected: 0,
      scored: 1,
      insufficient: 1,
      missing: 2697,
      split: 0,
    });
    assert.equal(row.methods.deterministic.answers.planned, 900);
    assert.equal(row.methods.model.answers.planned, 1800);
    assert.equal(row.success.macroAttemptSuccess, null);
    assert.equal(row.timing[0]!.missingBoundaries, 300);
    assert.equal(row.scores.length, 2);
    assert.deepEqual(row.scores[0]!.values, [2]);
    assert.deepEqual(row.scores[1]!.values, []);
  }
  assert.notEqual(report.rows[0]!.conditionsHash, report.rows[1]!.conditionsHash);
  assert.equal(report.campaignWallMs, null, "No recorded events means no campaign boundary");
  const timed = projectBenchmarkReport({
    status: {
      ...status,
      events: [
        {
          kind: "started",
          stage: "readiness",
          unitId: "readiness",
          at: "2026-10-01T10:00:00.000Z",
        },
        { kind: "completed", stage: "report", unitId: "report", at: "2026-10-01T10:07:30.000Z" },
      ],
    } as unknown as typeof status,
    title: "Offline synthetic matrix",
    outcomes,
    requests: [shared, owned],
    definitions: [],
  });
  assert.equal(timed.campaignWallMs, 450_000);
});

test("one saved rule decides builds from required answers and the local gate only", async () => {
  const { projectBenchmarkReport, BUILD_SUCCESS_RULE } =
    await import("../packages/experiments/src/benchmark-projection.js");
  // Case a: met, rejected, locally rejected, insufficient. Case b: only an optional criterion is rejected.
  const builds = [
    ["a", "met", "met"],
    ["a", "met", "rejected"],
    ["a", null, null],
    ["a", "met", "insufficient"],
    ["b", "met", "met"],
  ] as const;
  const subjects = builds.map(([evalId], index) => ({
    id: `s-${index}`,
    evalId,
    kind: "generated",
    stageIndex: 1,
    parentSubjectId: null,
    builder: {
      model: { id: "one" },
      harness: { id: "production" },
      environment: {},
      transportConfigurationHash: "transport",
    },
  }));
  const captureCells = subjects.map((subject) => ({
    id: `c-${subject.id}`,
    treatmentId: subject.id,
    pass: 1,
  }));
  const gradingCells = subjects.map((subject) => ({
    id: `d-${subject.id}`,
    captureCellId: `c-${subject.id}`,
    criterionId: "behavior",
  }));
  const judgmentBatches = subjects.map((subject) => ({
    id: `j-${subject.id}`,
    sampleGroupId: `g-${subject.id}`,
    sample: 1,
    captureCellId: `c-${subject.id}`,
    criterionIds: ["appearance", "polish"],
    configuration: { modelId: "grader" },
    presentation: "sequence",
  }));
  const outcomes: import("../packages/contracts/src/benchmarks.js").BenchmarkCriterionOutcome[] =
    builds.flatMap(([, behavior, appearance], index) =>
      behavior === null
        ? []
        : [
            {
              cellId: `d-s-${index}`,
              criterionId: "behavior",
              method: "deterministic" as const,
              outcome: behavior,
              score: null,
              samples: null,
              observed: null,
            },
            {
              cellId: `j-s-${index}`,
              criterionId: "appearance",
              method: "model" as const,
              outcome: appearance!,
              score: null,
              samples: null,
              observed: null,
            },
            {
              cellId: `j-s-${index}`,
              criterionId: "polish",
              method: "model" as const,
              outcome: "rejected" as const,
              score: null,
              samples: null,
              observed: null,
            },
          ],
    );
  const definition = (evaluationId: string, criterionId: string, required: boolean) => ({
    evaluationId,
    criterionId,
    statement: criterionId,
    required,
    // The author set a class only for appearance. A code check never has one.
    evidenceClass: criterionId === "appearance" ? ("appearance" as const) : null,
    scaleHash: null,
    scale: null,
  });
  const status = {
    manifest: {
      id: "rule",
      evals: ["a", "b"].map((id) => ({
        id,
        stage: {
          firstRevisionId: id,
          index: 1,
          count: 1,
          earlierPrompts: [],
          gateCriterionIds: [],
        },
      })),
      selectedModelIds: ["one"],
      selectedHarnessIds: ["production"],
      modelSnapshots: [
        {
          id: "one",
          name: "one",
          revision: "r",
          endpoints: [{ provider: "p", quantization: "unknown" }],
        },
      ],
      subjects,
      captureCells,
      gradingCells,
      judgmentBatches,
      planned: { independentBuilderTrials: subjects.length },
      implementationCommit: "frozen",
      buildIdentityHash: "build",
      connectorArtifactHash: "connector",
      gradingMode: "all",
    },
    events: [
      {
        kind: "failed",
        stage: "builder",
        unitId: "s-2",
        reason: "local_gate_rejected",
        at: "2026-10-01T10:00:00.000Z",
      },
    ],
    completedUnits: [],
    finished: true,
    stopped: false,
    inFlightUnits: [],
  } as unknown as import("../packages/contracts/src/execution.js").RunOperationStatus;
  const report = projectBenchmarkReport({
    status,
    title: "Rule",
    outcomes,
    requests: [],
    definitions: ["a", "b"].flatMap((evaluationId) => [
      definition(evaluationId, "behavior", true),
      definition(evaluationId, "appearance", true),
      definition(evaluationId, "polish", false),
    ]),
  });
  const success = report.rows[0]!.success;
  assert.equal(BUILD_SUCCESS_RULE.failed.includes("local gate"), true);
  assert.deepEqual(
    {
      cases: success.cases,
      casesWithRule: success.casesWithRule,
      knownSuccesses: success.knownSuccesses,
      knownFailures: success.knownFailures,
      unknown: success.unknown,
    },
    { cases: 2, casesWithRule: 2, knownSuccesses: 2, knownFailures: 2, unknown: 1 },
  );
  // Case a: 1 of 4 known, up to 2 of 4; case b: 1 of 1.
  assert.deepEqual(success.macroAttemptSuccess, { lower: (0.25 + 1) / 2, upper: (0.5 + 1) / 2 });
  assert.deepEqual(success.allAttemptsSuccess, { lower: 0.5, upper: 0.5 });
  // The judge checks group by evidence class, with the coverage of each evaluation. A judge
  // criterion without a class is null. The code check stays in its own group.
  const answers = (slice: import("../packages/contracts/src/benchmarks.js").BenchmarkSlice) => [
    slice.answers,
    slice.cases.map((item) => [item.evaluationId, item.answers.planned, item.answers.met]),
  ];
  const row = report.rows[0]!;
  const counts = (met: number, rejected: number, insufficient: number, missing: number) => ({
    planned: met + rejected + insufficient + missing,
    met,
    rejected,
    scored: 0,
    insufficient,
    missing,
    split: 0,
  });
  assert.deepEqual(
    row.classes.map((slice) => [slice.evidenceClass, ...answers(slice)]),
    [
      [
        "appearance",
        counts(2, 1, 1, 1),
        [
          ["a", 4, 1],
          ["b", 1, 1],
        ],
      ],
      [
        null,
        counts(0, 4, 0, 1),
        [
          ["a", 4, 0],
          ["b", 1, 0],
        ],
      ],
    ],
  );
  assert.deepEqual(answers(row.methods.deterministic), [
    counts(4, 0, 0, 1),
    [
      ["a", 4, 3],
      ["b", 1, 1],
    ],
  ]);
  assert.equal(
    row.classes.reduce((total, slice) => total + slice.answers.planned, 0),
    row.methods.model.answers.planned,
    "Each judge answer counts in one class, and no code check counts in a class",
  );
  const undefinedCriteria = projectBenchmarkReport({
    status,
    title: "Rule",
    outcomes,
    requests: [],
    definitions: [],
  }).rows[0]!.success;
  assert.equal(undefinedCriteria.casesWithRule, 0, "unknown requirements never decide a build");
  assert.equal(undefinedCriteria.macroAttemptSuccess, null);
  const timed = projectBenchmarkReport({
    status,
    title: "Rule",
    outcomes,
    requests: [],
    definitions: [],
    studioSessions: [
      { stage: "builder", unitId: "s-0", activeMs: 70_000, queueMs: 0 },
      { stage: "builder", unitId: "s-0", activeMs: 80_000, queueMs: 5_000 },
      { stage: "final_capture", unitId: "c-s-0", activeMs: 40_000, queueMs: 1_000 },
      // A capture without admission records has an unknown queue time.
      { stage: "final_capture", unitId: "c-s-1", activeMs: 45_000, queueMs: null },
    ],
  });
  assert.deepEqual(timed.rows[0]!.studio, {
    builderSessions: 2,
    builderActiveMs: 150_000,
    builderQueueMs: 5_000,
    captureSessions: 2,
    captureActiveMs: 85_000,
    captureQueueMs: null,
  });
  assert.equal(timed.queueWaitMs, null);
  assert.equal(report.queueWaitMs, 0, "a run without Studio sessions waited for none");
});

test("the sampling of a request comes from the frozen manifest", () => {
  const sampling = { ...catalogRecommendedSampling(null), temperature: 0.7 };
  const manifest = { judgmentBatches: [{ id: "batch:1", configuration: { sampling } }] } as Pick<
    RunOperationManifest,
    "judgmentBatches"
  >;
  // A judge request sends its frozen values. A build sends none, so the provider defaults apply.
  assert.deepEqual(requestSampling(manifest, "judgment:batch:1"), sampling);
  assert.deepEqual(requestSampling(manifest, "builder:subject"), catalogRecommendedSampling(null));
  assert.deepEqual(requestSampling(manifest, "repair:subject"), catalogRecommendedSampling(null));
  // The manifest holds no values for an unknown batch or another kind of request.
  assert.equal(requestSampling(manifest, "judgment:other"), null);
  assert.equal(requestSampling(manifest, "preparation:public"), null);
});
