import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  assertEvaluatorSpec,
  assertStudioEvidence,
  hashJson,
  statedQuantities,
  type CandidateManifest,
  type DeterministicCriterion,
  type EvaluatorSpec,
  type PerformanceSample,
  type StudioEvidence,
  type StudioScenarioStepReport,
} from "../packages/contracts/src/index.js";
import {
  compileCuratedRevision,
  readCuratedTaskFiles,
} from "../packages/eval-authoring/src/curated-revision.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import {
  aggregateValues,
  checkPerformance,
  nearestRank,
  type PerformanceTraceObservation,
} from "../packages/graders/src/performance.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";

const repository = resolve(process.cwd());
/** The connector spike traces the server for 120 samples, one each 250 ms. */
const traceBinding = {
  scenarioId: "performance",
  stepId: "trace",
  context: "server",
  factId: "server-performance",
};
const performanceRule = (
  metric: string,
  aggregate: string,
  maximum: unknown,
  binding: object = traceBinding,
) =>
  ({
    kind: "performance_within",
    ...binding,
    metric,
    aggregate,
    maximum,
  }) as unknown as DeterministicCriterion["rule"];
const frameBound = { value: 33, quote: "a frame time of at most 33 ms" };

/** Samples of 250 ms each. The functions give each field from the sample index. */
function samples(
  count: number,
  fields: {
    meanFrameMs?: (index: number) => number;
    maxFrameMs?: (index: number) => number;
    instanceCount?: ((index: number) => number) | null;
    memoryMb?: ((index: number) => number) | null;
  } = {},
): PerformanceSample[] {
  return Array.from({ length: count }, (_, index) => {
    const mean = fields.meanFrameMs?.(index) ?? 16.7;
    const sample: PerformanceSample = {
      elapsedMs: (index + 1) * 250,
      frames: 15,
      meanFrameMs: mean,
      maxFrameMs: Math.max(mean, fields.maxFrameMs?.(index) ?? 20),
    };
    if (fields.instanceCount !== null)
      sample.instanceCount = fields.instanceCount?.(index) ?? 84588;
    if (fields.memoryMb !== null) sample.memoryMb = fields.memoryMb?.(index) ?? 2634.3;
    return sample;
  });
}
const trace = (values: PerformanceSample[]): PerformanceTraceObservation => ({
  factId: "server-performance",
  kind: "performance_trace",
  samples: values,
});

test("the aggregates use the nearest rank, the largest value and the last minus the first", () => {
  const values = Array.from({ length: 20 }, (_, index) => 20 - index);
  assert.equal(nearestRank(values, 95), 19);
  assert.equal(nearestRank(values, 50), 10);
  assert.equal(nearestRank([7], 95), 7);
  assert.equal(nearestRank([3, 1, 2], 0), 1);
  // 120 samples: the rank is ceil(0.95 × 120) = 114.
  assert.equal(
    nearestRank(
      Array.from({ length: 120 }, (_, index) => index + 1),
      95,
    ),
    114,
  );
  assert.equal(aggregateValues([4, 9, 2], "max"), 9);
  assert.equal(aggregateValues([4, 9, 2], "growth"), -2);
  // A float subtraction gives 24.799999999999955. The growth is 24.8.
  assert.equal(aggregateValues([2634.3, 2700, 2659.1], "growth"), 24.8);
  assert.throws(() => aggregateValues([], "max"), /at least one value/u);
});

test("a performance check compares one aggregate with the authored maximum", () => {
  const heavy = trace(samples(120, { maxFrameMs: (index) => (index % 20 === 0 ? 45 : 22) }));
  // 6 of the 120 samples have a maximum frame of 45 ms, so the p95 is 22 ms and the max 45 ms.
  const p95 = checkPerformance(heavy, 120, "max_frame_ms", "p95", 33);
  assert.equal(p95.outcome, "verified");
  assert.deepEqual(p95.observed, [22, 120]);
  assert.match(p95.reason, /p95 of maxFrameMs over 120 samples is 22 ms, at most .* 33 ms/u);
  const max = checkPerformance(heavy, 120, "max_frame_ms", "max", 33);
  assert.equal(max.outcome, "rejected");
  assert.deepEqual(max.observed, [45, 120]);
  assert.match(max.reason, /45 ms, above the authored maximum of 33 ms/u);
  // The bound is inclusive.
  assert.equal(checkPerformance(heavy, 120, "max_frame_ms", "max", 45).outcome, "verified");
  const busy = trace(samples(120, { meanFrameMs: () => 21 }));
  assert.equal(checkPerformance(busy, 120, "mean_frame_ms", "p95", 20).outcome, "rejected");
  const growing = trace(
    samples(4, { memoryMb: (index) => [2634.3, 2650, 2641, 2659.1][index]!, instanceCount: null }),
  );
  const memory = checkPerformance(growing, 4, "memory_mb", "growth", 24.8);
  assert.equal(memory.outcome, "verified");
  assert.deepEqual(memory.observed, [24.8, 4]);
  assert.match(memory.reason, /growth of memoryMb over 4 samples is 24\.8 MB/u);
  const parts = trace(samples(4, { instanceCount: (index) => 84588 + index * 2000 }));
  assert.deepEqual(
    checkPerformance(parts, 4, "instance_count", "growth", 5000).observed,
    [6000, 4],
  );
  assert.equal(checkPerformance(parts, 4, "instance_count", "max", 90588).outcome, "verified");
});

test("an absent trace, a short trace or an unreadable value makes the check incomplete", () => {
  const absent = checkPerformance(null, 120, "max_frame_ms", "max", 33);
  assert.equal(absent.outcome, "incomplete");
  assert.equal(absent.observed, null);
  const short = checkPerformance(trace(samples(119)), 120, "max_frame_ms", "max", 33);
  assert.equal(short.outcome, "incomplete");
  assert.match(short.reason, /119 of the 120 samples/u);
  const unreadable = trace(samples(120, { instanceCount: null, memoryMb: null }));
  for (const metric of ["instance_count", "memory_mb"] as const) {
    const verdict = checkPerformance(unreadable, 120, metric, "growth", 100);
    assert.equal(verdict.outcome, "incomplete");
    assert.match(verdict.reason, /did not let the runner read/u);
  }
  assert.equal(checkPerformance(unreadable, 120, "mean_frame_ms", "max", 33).outcome, "verified");
});

async function spikeTask(root: string) {
  const task = await loadRegisteredTask(repository, "studies/connector-spike/task");
  const workspace = resolve(root, "workspace");
  await materializeTaskSeed(repository, task, workspace);
  const files = await inventoryTree(workspace);
  const candidate: CandidateManifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  const evaluator: EvaluatorSpec = structuredClone(task.evaluator);
  evaluator.deterministic.push({
    id: "frame-time",
    layer: "engine",
    statement: "The server keeps a frame time of at most 33 ms.",
    required: true,
    rule: performanceRule("max_frame_ms", "p95", frameBound),
  });
  assertEvaluatorSpec(evaluator);
  return { workspace, candidate, evaluator };
}

function evidenceWith(
  candidate: CandidateManifest,
  evaluator: EvaluatorSpec,
  step: StudioScenarioStepReport,
): StudioEvidence {
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: "tr-performance",
    candidateHash: candidate.rootHash,
    collectionPlanHash: hashJson(evaluator.studio),
    connectorSourceHash: "a".repeat(64),
    connectorArtifactHash: "d".repeat(64),
    place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
    studio: { version: "test", sessionId: "studio-fixture" },
    startedAt: "2026-10-07T00:00:02.000Z",
    endedAt: "2026-10-07T00:00:40.000Z",
    scenarios: [
      {
        scenarioId: "performance",
        startedAt: "2026-10-07T00:00:02.000Z",
        endedAt: "2026-10-07T00:00:40.000Z",
        reports: [
          {
            context: "server",
            startAt: 10,
            actors: [{ actor: "primary", userId: 101, name: "Player1" }],
            steps: [step],
          },
        ],
      },
    ],
    phases: [{ phaseId: "hud", observations: [], captures: [] }],
  };
  const evidence: StudioEvidence = {
    schema: "basalt-evals/studio-evidence",
    id: `evidence-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
  assertStudioEvidence(evidence);
  return evidence;
}

test("a performance rule grades the bound scenario trace of the plan", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-performance-"));
  try {
    const { workspace, candidate, evaluator } = await spikeTask(root);
    const grade = async (step: StudioScenarioStepReport) =>
      (
        await evaluateDeterministicCriteria({
          workspaceRoot: workspace,
          evaluator,
          candidate,
          treatmentId: "tr-performance",
          evidence: evidenceWith(candidate, evaluator, step),
        })
      ).find((item) => item.criterionId === "frame-time")!;
    const observed = (values: PerformanceSample[]): StudioScenarioStepReport => ({
      stepId: "trace",
      outcome: "observed",
      dueAt: 10,
      anchorObservedAt: 10,
      scheduledAt: 10,
      capturedAt: 40,
      observations: [trace(values)],
    });
    const smooth = observed(samples(120));
    const verified = await grade(smooth);
    assert.equal(verified.outcome, "verified");
    assert.deepEqual(verified.observed, [20, 120]);
    assert.deepEqual(verified.evidence, [hashJson(smooth.observations[0])]);
    const slow = await grade(observed(samples(120, { maxFrameMs: () => 40 })));
    assert.equal(slow.outcome, "rejected");
    assert.deepEqual(slow.observed, [40, 120]);
    // The plan asks for 120 samples.
    const short = await grade(observed(samples(60)));
    assert.equal(short.outcome, "incomplete");
    assert.match(short.explanation, /60 of the 120 samples/u);
    const expired = await grade({
      stepId: "trace",
      outcome: "not_observed_within_horizon",
      dueAt: 10,
      observations: [],
    });
    assert.equal(expired.outcome, "incomplete");
    assert.match(expired.explanation, /not_observed_within_horizon/u);
    const withoutEvidence = (
      await evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator,
        candidate,
        treatmentId: "tr-performance",
      })
    ).find((item) => item.criterionId === "frame-time")!;
    assert.equal(withoutEvidence.outcome, "incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a performance rule binds one trace and a quoted maximum in the unit of its metric", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-performance-contract-"));
  try {
    const { evaluator } = await spikeTask(root);
    const variant = (rule: DeterministicCriterion["rule"]) => {
      const copy = structuredClone(evaluator);
      copy.deterministic.find((item) => item.id === "frame-time")!.rule = rule;
      return copy;
    };
    const accepts = (rule: DeterministicCriterion["rule"]) => assertEvaluatorSpec(variant(rule));
    const refuses = (rule: DeterministicCriterion["rule"], pattern: RegExp) =>
      assert.throws(() => assertEvaluatorSpec(variant(rule)), pattern);
    accepts(performanceRule("mean_frame_ms", "max", { value: 50, quote: "within 0.05 s" }));
    // A bound keeps a fraction of a millisecond. A step requirement uses whole milliseconds.
    assert.deepEqual(statedQuantities("at most 16.7 ms, or 0.0167 s", "ms"), [16.7, 16.7]);
    accepts(performanceRule("mean_frame_ms", "p95", { value: 16.7, quote: "at most 16.7 ms" }));
    refuses(
      performanceRule("mean_frame_ms", "p95", { value: 17, quote: "at most 16.7 ms" }),
      /states the value 17 in ms/u,
    );
    accepts(performanceRule("instance_count", "growth", { value: 5000, quote: "at most 5000" }));
    accepts(performanceRule("memory_mb", "growth", { value: 50, quote: "grow by 50 MB or less" }));
    refuses(
      performanceRule("memory_mb", "max", { value: 3000, quote: "under 3000 MB" }),
      /memory_mb is the memory of the whole Studio process, so use only the aggregate growth/u,
    );
    refuses(
      performanceRule("memory_mb", "p95", { value: 3000, quote: "under 3000 MB" }),
      /only the aggregate growth/u,
    );
    refuses(
      performanceRule("max_frame_ms", "max", { value: 33, quote: "at most 33 MB" }),
      /states the value 33 in ms/u,
    );
    refuses(
      performanceRule("instance_count", "max", { value: 5000, quote: "5000 ms" }),
      /in count/u,
    );
    refuses(performanceRule("max_frame_ms", "max", null), /performance maximum/u);
    refuses(performanceRule("frame_ms", "max", frameBound), /performance metric/u);
    refuses(performanceRule("max_frame_ms", "median", frameBound), /performance aggregate/u);
    refuses(
      performanceRule("max_frame_ms", "max", frameBound, { ...traceBinding, factId: "players" }),
      /bind a performance_trace fact/u,
    );
    refuses(
      performanceRule("max_frame_ms", "max", frameBound, { ...traceBinding, context: "primary" }),
      /bind a performance_trace fact/u,
    );
    refuses(
      performanceRule("max_frame_ms", "max", frameBound, {
        scenarioId: "performance",
        context: "server",
        factId: "server-performance",
      }),
      /performance rule fields: missing \[stepId\]/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the compiler needs the quote of a performance maximum in the text of its criterion", async () => {
  const files = await readCuratedTaskFiles(resolve("studies/connector-spike/task"));
  const compile = (rubricLine: string) => {
    const evaluator = structuredClone(files.evaluator);
    evaluator.deterministic.push({
      id: "frame-time",
      layer: "engine",
      statement: "A statement that the compile replaces.",
      required: true,
      rule: performanceRule("max_frame_ms", "p95", frameBound),
    });
    const map = structuredClone(files.criteriaMap) as { criteria: object[] };
    map.criteria.push({
      authoredCriterionId: "criterion-2",
      text: rubricLine,
      executableCriterionId: "frame-time",
      rationale: "The server performance trace gives the frame times.",
    });
    return compileCuratedRevision({
      ...files,
      evaluator,
      rubric: `${files.rubric.trimEnd()}\n- ${rubricLine}\n`,
      criteriaMap: map,
    });
  };
  const quoted = compile("The server keeps a frame time of at most 33 ms.");
  assert.equal(quoted.validation.status, "ready", JSON.stringify(quoted.validation.diagnostics));
  const invented = compile("The server stays smooth.");
  assert.equal(invented.validation.status, "needs_clarification");
  assert.deepEqual(
    invented.validation.diagnostics.map((item) => [item.code, item.authoredCriterionId]),
    [["authority_conflict", "criterion-2"]],
  );
  assert.match(invented.validation.diagnostics[0]!.message, /bound 33 from/u);
});
