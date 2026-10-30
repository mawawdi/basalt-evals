import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { BenchmarkMark, BenchmarkReport } from "../packages/contracts/src/benchmarks.js";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import type { AgentRun, StudioEvidence } from "../packages/contracts/src/index.js";
import {
  SOURCE_ANALYSIS_SCHEMA,
  type SourceAnalysis,
  type SourceScript,
} from "../packages/contracts/src/source-analysis.js";
import {
  BUILD_STOPS,
  MODEL_SIDE_STOPS,
  patternTable,
  rowPairs,
  type BuildFacts,
  type BuildStop,
  type CriterionOutcomeCounts,
  type ModelReport,
} from "../packages/contracts/src/model-report.js";
import { DIAGNOSTIC_CHANNEL_LIMIT } from "../packages/contracts/src/capabilities.js";
import {
  CRITERION_OUTCOME_RULE,
  CRITERION_OUTCOME_RULE_HASH,
  conservativeFisher,
  criterionOutcome,
  modelReport,
} from "../packages/experiments/src/model-report.js";
import {
  clusterBootstrap,
  fisherExact,
  fisherMinimumP,
  holmAdjust,
  permutationSize,
  stratifiedPermutationTest,
} from "../packages/experiments/src/statistics.js";
import { buildCodeFacts, reportSourceAnalyses } from "../packages/operator/src/build-code-facts.js";
import { buildStopOf, runFacts } from "../packages/operator/src/model-report.js";
import { runExportFiles, type RunExportInput } from "../packages/reporting/src/export.js";
import { hashJson } from "../packages/contracts/src/index.js";

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `${actual} is not ${expected}`);

test("Fisher's exact test gives the known two-sided p values", () => {
  // Exact rational values of each table, from the hypergeometric sums.
  const tables: Array<[[number, number, number, number], number]> = [
    [[3, 1, 1, 3], 17 / 35],
    [[1, 9, 11, 3], 41 / 14858],
    [[5, 0, 0, 5], 1 / 126],
    [[3, 0, 0, 3], 1 / 10],
    [[6, 0, 1, 5], 1 / 66],
    [[2, 3, 5, 1], 8 / 33],
    [[7, 2, 2, 7], 53 / 935],
    [[0, 0, 2, 3], 1],
  ];
  for (const [table, expected] of tables) close(fisherExact(...table).twoSidedP, expected);
  close(fisherExact(3, 1, 1, 3).greaterP, 17 / 70);
  // Three builds of each model cannot give p below 0.1, so no criterion can decide.
  close(fisherMinimumP(3, 3), 1 / 10);
  close(fisherMinimumP(4, 4), 1 / 35);
  close(fisherMinimumP(6, 6), 1 / 462);
  assert.throws(() => fisherExact(-1, 0, 0, 0), /nonnegative integer/u);
});

test("an exact stratified permutation test enumerates each relabelling inside its stratum", () => {
  const options = { seed: 7, draws: 100 };
  const separated = stratifiedPermutationTest([{ first: [1, 1, 1], second: [0, 0, 0] }], options);
  assert.equal(separated.method, "exact");
  assert.equal(separated.relabellings, 20);
  close(separated.twoSidedP, 2 / 20, "the labelling and its mirror are the extremes");
  close(separated.minimumP, 2 / 20);
  // By hand: stratum sums {0.5, 0.5, -1} and {1, -0.5, -0.5}; 4 of 9 sums reach |1.5|.
  const unequal = stratifiedPermutationTest(
    [
      { first: [1, 0], second: [0] },
      { first: [1], second: [0, 0] },
    ],
    options,
  );
  assert.equal(unequal.relabellings, 9);
  close(unequal.statistic, 1.5);
  close(unequal.twoSidedP, 4 / 9);
  close(unequal.minimumP, 1 / 9, "groups of unequal size have no mirror labelling");
  // A brute force over every assignment of labels inside each stratum gives the same p.
  const strata = [
    { first: [0.5, 1, 0.25], second: [0, 0.5] },
    { first: [1, 0], second: [0.75, 0.25, 0] },
  ];
  const statistic = (groups: typeof strata) =>
    groups.reduce(
      (sum, { first, second }) =>
        sum +
        first.reduce((a, b) => a + b, 0) / first.length -
        second.reduce((a, b) => a + b, 0) / second.length,
      0,
    );
  const relabel = (values: number[], size: number) => {
    const result: Array<{ first: number[]; second: number[] }> = [];
    for (let mask = 0; mask < 1 << values.length; mask++) {
      const first = values.filter((_, index) => mask & (1 << index));
      if (first.length === size)
        result.push({ first, second: values.filter((_, index) => !(mask & (1 << index))) });
    }
    return result;
  };
  const observed = Math.abs(statistic(strata));
  let extreme = 0,
    all = 0;
  for (const left of relabel([...strata[0]!.first, ...strata[0]!.second], 3))
    for (const right of relabel([...strata[1]!.first, ...strata[1]!.second], 2)) {
      all++;
      if (Math.abs(statistic([left, right])) >= observed - 1e-9) extreme++;
    }
  const exact = stratifiedPermutationTest(strata, options);
  assert.equal(exact.relabellings, all);
  close(exact.twoSidedP, extreme / all);
});

test("a large permutation test draws seeded relabellings, so the same seed gives the same p", () => {
  const first = Array.from({ length: 12 }, (_, index) => (index % 4 ? 1 : 0)),
    second = Array.from({ length: 12 }, (_, index) => (index % 3 ? 0 : 1));
  const run = (seed: number) =>
    stratifiedPermutationTest([{ first, second }], { seed, draws: 2_000 });
  const once = run(11);
  assert.equal(once.method, "monte_carlo");
  assert.equal(once.relabellings, null, "C(24, 12) is more than 100,000");
  assert.equal(once.draws, 2_000);
  close(once.minimumP, 1 / 2_001);
  assert.deepEqual(run(11), once);
  assert.ok(once.twoSidedP > 0 && once.twoSidedP <= 1);
  assert.deepEqual(permutationSize([{ first: 3, second: 3 }], 10), {
    method: "exact",
    relabellings: 20,
    draws: null,
    minimumP: 0.1,
  });
});

test("a stratified bootstrap keeps the clusters of each stratum in each resample", () => {
  const items = ["a1", "a2", "a3", "b1", "b2"].map((id) => ({ id, stratum: id[0]! }));
  const countA = (sample: typeof items) => [sample.filter((item) => item.stratum === "a").length];
  const options = { seed: 3, resamples: 200, confidence: 0.95 };
  const stratified = clusterBootstrap(items, (item) => item.id, countA, {
    ...options,
    stratum: (item) => item.stratum,
  });
  assert.deepEqual(stratified.intervals, [{ lower: 3, upper: 3 }]);
  const pooled = clusterBootstrap(items, (item) => item.id, countA, options);
  assert.notDeepEqual(pooled.intervals, [{ lower: 3, upper: 3 }]);
  assert.deepEqual(
    clusterBootstrap(items, (item) => item.id, countA, {
      ...options,
      stratum: (item) => item.stratum,
    }),
    stratified,
    "the same seed gives the same interval",
  );
});

test("Holm adjusts each p value by its rank and keeps the order", () => {
  const adjusted = holmAdjust([0.01, 0.04, 0.03]);
  [0.03, 0.06, 0.06].forEach((value, index) => close(adjusted[index]!, value));
});

const mark = (outcome: BenchmarkMark["outcome"], pass = 1): BenchmarkMark => ({
  subjectId: "build",
  pass,
  criterionId: "criterion",
  method: "deterministic",
  evidenceCellId: `cell-${pass}`,
  outcome,
  score: null,
  samples: null,
  observed: null,
});

test("the observations of a delivered build combine into one outcome", () => {
  const outcome = (...outcomes: Array<BenchmarkMark["outcome"]>) =>
    criterionOutcome(
      "delivered",
      outcomes.map((value, index) => mark(value, index + 1)),
    );
  assert.equal(outcome("met", "met"), "met");
  assert.equal(outcome("met", "rejected"), "not_met");
  assert.equal(outcome("rejected", "insufficient"), "not_met", "one observation not met decides");
  for (const open of ["insufficient", "split", "scored", "missing"] as const)
    assert.equal(outcome("met", open), "unresolved", open);
  assert.equal(outcome(), "unresolved", "a build without a planned check is unresolved");
  assert.equal(CRITERION_OUTCOME_RULE_HASH, hashJson(CRITERION_OUTCOME_RULE));
});

test("a stop of the model is not met, and a stop outside the model is unresolved", () => {
  const met = [mark("met")];
  for (const stop of BUILD_STOPS.filter((value) => value !== "delivered"))
    assert.equal(
      criterionOutcome(stop, met),
      MODEL_SIDE_STOPS.includes(stop) ? "not_met" : "unresolved",
      stop,
    );
  assert.deepEqual([...MODEL_SIDE_STOPS].sort(), [
    "context_limit",
    "invalid_tool_call",
    "local_gate_rejected",
    "output_limit",
    "refusal",
    "turn_limit",
  ]);
  const stop = (status: AgentRun["status"], stopReason: AgentRun["stopReason"]) =>
    buildStopOf({ status, stopReason });
  assert.equal(stop("locally_eligible", "finished"), "delivered");
  assert.equal(stop("rejected", "finished"), "local_gate_rejected");
  assert.equal(stop("incomplete", "finished"), "environment");
  assert.equal(stop("incomplete", "turn_limit"), "turn_limit");
  assert.equal(stop("rejected", "invalid_tool_call"), "invalid_tool_call");
  assert.equal(
    stop("rejected", "provider_error"),
    "provider_error",
    "a gate that rejects the code of a build that the provider stopped does not count",
  );
  const trace = (
    kind: AgentRun["trace"][number]["kind"],
    data: AgentRun["trace"][number]["data"],
  ) => ({
    sequence: 0,
    at: "2026-10-07T00:00:00.000Z",
    kind,
    data,
  });
  assert.deepEqual(
    runFacts({
      trace: [
        trace("tool_rejection", { proposed: 3, reason: "invalid_tool_batch" }),
        trace("tool_result", { id: "1", name: "workspace.write", ok: false }),
        trace("tool_result", { id: "2", name: "workspace.write", ok: false }),
        trace("tool_result", { id: "3", name: "workspace.verify", ok: true }),
        // A stop records a result without `ok`. It is not a failed tool call.
        trace("tool_result", { id: "4", name: "development.run", result: { ok: false } }),
        trace("gate", {
          gate: "rejected",
          checks: [
            { name: "luau_parse", outcome: "fail" },
            { name: "rojo_build", outcome: "pass" },
          ],
        }),
      ],
    }),
    {
      gateFailures: ["luau_parse"],
      failedToolCalls: [{ tool: "workspace.write", calls: 2 }],
      refusedBatches: 1,
    },
  );
});

test("an unresolved build counts against the direction under test", () => {
  const counts = (met: number, notMet: number, unresolved = 0): CriterionOutcomeCounts => ({
    met,
    notMet,
    unresolved,
  });
  const clear = conservativeFisher(counts(5, 0), counts(0, 5));
  assert.equal(clear.direction, "more");
  close(clear.p, 1 / 126);
  // The two unresolved builds of the other model count as met: the table is 5/0 against 2/3.
  const open = conservativeFisher(counts(5, 0), counts(0, 3, 2));
  assert.equal(open.direction, "more");
  close(open.p, fisherExact(5, 0, 2, 3).twoSidedP);
  assert.ok(open.p > clear.p);
  // 2 met and 3 unresolved can be 2 of 5, which ties with the other model, so no direction.
  assert.deepEqual(conservativeFisher(counts(2, 0, 3), counts(2, 3)), { direction: null, p: 1 });
  assert.equal(conservativeFisher(counts(0, 0, 4), counts(4, 0)).direction, null);
  assert.equal(conservativeFisher(counts(0, 2), counts(3, 0)).direction, "less");
  // The least favourable completion gives the largest p of all completions in the direction.
  for (let first = 1; first <= 4; first++)
    for (let second = 1; second <= 4; second++)
      for (let met = 0; met <= first; met++)
        for (let open = 0; met + open <= first; open++)
          for (let otherMet = 0; otherMet <= second; otherMet++)
            for (let otherOpen = 0; otherMet + otherOpen <= second; otherOpen++) {
              const model = counts(met, first - met - open, open),
                other = counts(otherMet, second - otherMet - otherOpen, otherOpen);
              const result = conservativeFisher(model, other);
              if (!result.direction) continue;
              let largest = 0;
              for (let a = met; a <= met + open; a++)
                for (let c = otherMet; c <= otherMet + otherOpen; c++)
                  largest = Math.max(largest, fisherExact(a, first - a, c, second - c).twoSidedP);
              close(result.p, largest);
            }
});

/** A synthetic report: models × one evaluation, with one code and one judge criterion. */
function syntheticReport(input: {
  builds: number;
  /** For each model, whether build `index` meets the code criterion. */
  code: Array<(index: number) => BenchmarkMark["outcome"]>;
}) {
  const models = input.code.map((_, index) => `vendor-${index}/model-${index}`);
  const facts: BuildFacts[] = [];
  const rows = models.map((modelId, row) => ({
    id: `row-${row}`,
    modelId,
    modelName: `Model ${row}`,
    harnessId: "tools",
    harnessTitle: "Tools",
    causes:
      row === 0
        ? [
            {
              cause: "provider_or_transport_failure",
              units: [{ stage: "judgment", unitId: "j", subjectId: `${row}-0` }],
            },
          ]
        : [],
    cases: [
      {
        evaluationId: "evaluation",
        builds: Array.from({ length: input.builds }, (_, index) => {
          const subjectId = `${row}-${index}`;
          facts.push({
            subjectId,
            stop: "delivered",
            run: { gateFailures: [], failedToolCalls: [], refusedBatches: 0 },
            lint: null,
            scriptErrors: null,
          });
          return {
            subjectId,
            notReached: false,
            marks: [1, 2].flatMap((pass) => [
              {
                ...mark(input.code[row]!(index), pass),
                subjectId,
                criterionId: "code-criterion",
              },
              {
                ...mark("met", pass),
                subjectId,
                criterionId: "judge-criterion",
                method: "model" as const,
              },
            ]),
          };
        }),
      },
    ],
  }));
  const report = {
    operationId: "run",
    manifestHash: "manifest",
    title: "Synthetic run",
    finished: true,
    stopped: false,
    evaluations: [
      {
        evaluationId: "evaluation",
        title: "Coin pickup",
        stage: { index: 1, count: 1, firstEvaluationId: "evaluation" },
      },
    ],
    criteria: [
      {
        evaluationId: "evaluation",
        criterionId: "code-criterion",
        statement: "SECRET the score increases by one",
        required: true,
        evidenceClass: null,
        scaleHash: null,
        scale: null,
      },
      {
        evaluationId: "evaluation",
        criterionId: "judge-criterion",
        statement: "SECRET the coin glows",
        required: true,
        evidenceClass: "appearance",
        scaleHash: null,
        scale: null,
      },
      {
        evaluationId: "evaluation",
        criterionId: "unplanned",
        statement: "SECRET no planned check",
        required: false,
        evidenceClass: "timing",
        scaleHash: null,
        scale: null,
      },
    ],
    rows,
  } as unknown as BenchmarkReport;
  return { report, facts };
}

test("each pair of models gets one exact test for each criterion with Holm over the criteria", () => {
  const { report, facts } = syntheticReport({
    builds: 5,
    code: [() => "met", () => "rejected"],
  });
  const result = modelReport({ report, builds: facts, judgeModelIds: ["vendor-1/judge"] });
  assert.deepEqual(
    result.evaluations[0]!.criteria.map((item) => [item.criterionId, item.number, item.group]),
    [
      ["code-criterion", 1, "code"],
      ["judge-criterion", 2, "appearance"],
    ],
    "a criterion without a planned check is not measured",
  );
  assert.deepEqual(
    result.models.map((model) => model.judgeFamily),
    [false, true],
  );
  assert.equal(result.modelPairs.length, 2, "one pair, read from each model");
  assert.deepEqual(result.toolSetPairs, [], "one tool set gives no tool-set pair");
  const [forward, backward] = result.modelPairs;
  assert.deepEqual([forward!.rowId, forward!.otherRowId], ["row-0", "row-1"]);
  const [code, judge] = forward!.criteria;
  assert.deepEqual(code!.model, { met: 5, notMet: 0, unresolved: 0 });
  close(code!.p, 1 / 126);
  close(code!.adjustedP, 2 / 126, "Holm doubles the smallest of two p values");
  assert.equal(code!.verdict, "meets_more_often");
  assert.deepEqual([judge!.direction, judge!.p, judge!.verdict], [null, 1, "not_enough_builds"]);
  assert.equal(backward!.criteria[0]!.verdict, "meets_less_often");
  assert.deepEqual(backward!.criteria[0]!.model, code!.other);
  assert.equal(forward!.decisionPossible, true);
  // The pooled code checks: every build of one model meets them and no build of the other.
  const pooled = forward!.classes.find((item) => item.group === "code")!;
  assert.equal(pooled.test.method, "exact");
  assert.equal(pooled.test.relabellings, 252);
  close(pooled.p, 2 / 252);
  assert.deepEqual(pooled.difference, { lower: 1, upper: 1 });
  assert.equal(pooled.verdict, "meets_more_often");
  assert.equal(pooled.interval, null, "no bootstrap interval at 40 builds or fewer");
  assert.equal(forward!.classes.find((item) => item.group === "appearance")!.direction, null);
  // Patterns count each build one time with an exact interval.
  const patterns = result.models[0]!.patterns;
  assert.deepEqual(
    patterns.stops.map((item) => [item.key, item.builds, item.of]),
    [["delivered", 5, 5]],
  );
  assert.deepEqual(
    patterns.causes.map((item) => [item.key, item.builds]),
    [["provider_or_transport_failure", 1]],
  );
  // No data is invented for an absent analysis.
  assert.deepEqual(patterns.lint, { codes: [], analyzed: 0, unanalyzed: 5 });
  assert.deepEqual([patterns.scriptErrors.measured, patterns.scriptErrors.unmeasured], [0, 5]);
  assert.deepEqual([patterns.scriptErrors.build.of, patterns.scriptErrors.unknown.of], [0, 0]);
});

test("lint codes and script errors count only the builds with an analysis", () => {
  const { report, facts } = syntheticReport({ builds: 5, code: [() => "met", () => "met"] });
  const own = facts.filter((fact) => fact.subjectId.startsWith("0-"));
  // Build 0 has two findings of one code and one of another. Build 1 has a clean analysis.
  // Build 2 has an error from a build script and an external error. Build 3 has an error of
  // unknown origin. Build 4 has no analysis, so it is neither clean nor counted.
  const analyzed: Array<Pick<BuildFacts, "lint" | "scriptErrors">> = [
    {
      lint: { LocalUnused: 2, DeprecatedApi: 1 },
      scriptErrors: { build: 0, unknown: 0, external: 0, truncated: false },
    },
    { lint: {}, scriptErrors: null },
    {
      lint: { LocalUnused: 1 },
      scriptErrors: { build: 3, unknown: 0, external: 1, truncated: false },
    },
    { lint: {}, scriptErrors: { build: 0, unknown: 2, external: 0, truncated: false } },
    { lint: null, scriptErrors: null },
  ];
  const builds = facts.map((fact) => {
    const index = own.indexOf(fact);
    return index < 0 ? fact : { ...fact, ...analyzed[index]! };
  });
  const patterns = modelReport({ report, builds, judgeModelIds: [] }).models[0]!.patterns;
  assert.deepEqual(
    patterns.lint.codes.map((item) => [item.key, item.builds, item.of, item.events]),
    [
      ["DeprecatedApi", 1, 4, 1],
      ["LocalUnused", 2, 4, 3],
    ],
  );
  assert.deepEqual([patterns.lint.analyzed, patterns.lint.unanalyzed], [4, 1]);
  const { build, unknown, measured, unmeasured } = patterns.scriptErrors;
  assert.deepEqual(
    [build.builds, build.of, build.events, unknown.builds, unknown.of],
    [1, 3, null, 1, 3],
    "unknown origins stay apart from the build scripts",
  );
  assert.deepEqual([measured, unmeasured], [3, 2]);
  assert.ok(build.interval.lower < 1 / 3 && build.interval.upper > 1 / 3);
});

test("three builds of each model are not enough builds to tell", () => {
  const { report, facts } = syntheticReport({
    builds: 3,
    code: [() => "met", () => "rejected"],
  });
  const [pair] = modelReport({ report, builds: facts, judgeModelIds: [] }).modelPairs;
  const code = pair!.criteria[0]!;
  assert.equal(code.direction, "more");
  close(code.minimumAchievableP, 0.1);
  assert.equal(code.verdict, "not_enough_builds");
  assert.equal(pair!.decisionPossible, false);
});

test("model-side stops are not met and outside stops leave the comparison open", () => {
  const { report, facts } = syntheticReport({
    builds: 5,
    code: [() => "met", () => "met"],
  });
  // The second model fails its local gate in every build, so it meets no criterion.
  const failed = facts.map((fact) =>
    fact.subjectId.startsWith("1-") ? { ...fact, stop: "local_gate_rejected" as BuildStop } : fact,
  );
  const rejected = modelReport({ report, builds: failed, judgeModelIds: [] }).modelPairs[0]!;
  assert.deepEqual(rejected.criteria[1]!.other, { met: 0, notMet: 5, unresolved: 0 });
  assert.equal(rejected.criteria[1]!.verdict, "meets_more_often");
  // A provider error leaves the builds unresolved, so the test has no direction.
  const outside = facts.map((fact) =>
    fact.subjectId.startsWith("1-") ? { ...fact, stop: "provider_error" as BuildStop } : fact,
  );
  const open = modelReport({ report, builds: outside, judgeModelIds: [] }).modelPairs[0]!;
  assert.deepEqual(open.criteria[1]!.other, { met: 0, notMet: 0, unresolved: 5 });
  assert.equal(open.criteria[1]!.direction, null);
  assert.equal(open.criteria[1]!.verdict, "not_enough_builds");
});

test("a pooled test with more than 40 builds of each model has a bootstrap interval", () => {
  const { report, facts } = syntheticReport({
    builds: 41,
    code: [
      (index) => (index % 5 ? "met" : "rejected"),
      (index) => (index % 2 ? "met" : "rejected"),
    ],
  });
  const pooled = modelReport({
    report,
    builds: facts,
    judgeModelIds: [],
  }).modelPairs[0]!.classes.find((item) => item.group === "code")!;
  assert.equal(pooled.test.method, "monte_carlo");
  assert.ok(pooled.interval);
  assert.ok(pooled.interval.lower <= pooled.difference.lower);
  assert.ok(pooled.interval.upper >= pooled.difference.upper);
});

/** The run export input of a synthetic report with its model report. */
function exportInput(report: BenchmarkReport, models: ModelReport): RunExportInput {
  return {
    runId: "run",
    title: "Synthetic run",
    exportedAt: "2026-10-07T00:00:00.000Z",
    chargedUsd: 0,
    pendingUsd: 0,
    evaluations: report.evaluations.map((evaluation) => ({
      evaluationId: evaluation.evaluationId,
      title: evaluation.title,
      stage: { index: 1, count: 1 },
      criteria: report.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        scale: null,
        required: criterion.required,
      })),
    })),
    columns: [],
    histories: [],
    models,
  };
}
const exportText = (input: RunExportInput, scope: "public" | "private") =>
  runExportFiles(input, scope)
    .map((file) => new TextDecoder().decode(file.bytes))
    .join("\n");
const exportReport = (input: RunExportInput) =>
  JSON.parse(
    new TextDecoder().decode(
      runExportFiles(input, "public").find((file) => file.path === "report.json")!.bytes,
    ),
  );

test("a public export names the criteria of the model report by number only", () => {
  const { report, facts } = syntheticReport({
    builds: 5,
    code: [() => "met", () => "rejected"],
  });
  const models = modelReport({
    report,
    builds: facts.map((fact) => ({
      ...fact,
      lint: { LocalUnused: 2 },
      scriptErrors: { build: 1, unknown: 0, external: 2, truncated: false },
    })),
    judgeModelIds: [],
  });
  const input = exportInput(report, models);
  const text = (scope: "public" | "private") => exportText(input, scope);
  const shared = text("public");
  for (const secret of ["SECRET", "code-criterion", "judge-criterion"])
    assert.equal(shared.includes(secret), false, secret);
  const exported = exportReport(input);
  assert.deepEqual(
    exported.models.modelPairs[0].criteria.map(
      (item: { evaluation: number; criterion: number; verdict: string }) => [
        item.evaluation,
        item.criterion,
        item.verdict,
      ],
    ),
    [
      [1, 1, "meets_more_often"],
      [1, 2, "not_enough_builds"],
    ],
  );
  // Both scopes keep the lint codes and the counts of the patterns, and nothing else of them.
  const patterns = exported.models.models[0].patterns;
  assert.deepEqual(
    patterns.lint.codes.map((item: { key: string; events: number }) => [item.key, item.events]),
    [["LocalUnused", 10]],
  );
  assert.deepEqual([patterns.scriptErrors.build.builds, patterns.scriptErrors.measured], [5, 5]);
  assert.match(shared, /Meets more often/u);
  const kept = text("private");
  assert.ok(kept.includes("SECRET the coin glows"));
});

/**
 * A synthetic run with one model and two tool sets, and a second model of the first tool set.
 * Each row has 8 builds. Row 0 meets the code criterion and row 1 does not. Every build of row 0
 * has a DeprecatedApi finding and builds 0 to 2 have an error from a build script. Row 1 has a
 * clean analysis in builds 0 to 5 and none in builds 6 and 7. Row 2 has no analysis.
 */
function toolSetRun() {
  const { report, facts } = syntheticReport({
    builds: 8,
    code: [() => "met", () => "rejected", () => "met"],
  });
  const tools = { harnessId: "production", harnessTitle: "Studio tools" },
    lintTools = { harnessId: "production-lint", harnessTitle: "Studio tools + code analysis" };
  Object.assign(report.rows[0]!, tools);
  Object.assign(report.rows[1]!, lintTools, {
    modelId: report.rows[0]!.modelId,
    modelName: report.rows[0]!.modelName,
  });
  Object.assign(report.rows[2]!, tools);
  const builds = facts.map((fact): BuildFacts => {
    const [row, build] = fact.subjectId.split("-").map(Number) as [number, number];
    if (row === 0)
      return {
        ...fact,
        lint: { DeprecatedApi: 2 },
        scriptErrors: { build: build < 3 ? 1 : 0, unknown: 0, external: 0, truncated: false },
      };
    if (row === 1 && build < 6)
      return {
        ...fact,
        lint: {},
        scriptErrors: { build: 0, unknown: 0, external: 0, truncated: false },
      };
    return fact;
  });
  return { report, models: modelReport({ report, builds, judgeModelIds: [] }) };
}

test("tool-set pairs pair only the rows of one model, with their own Holm families", () => {
  const { models } = toolSetRun();
  const ids = (pairs: ModelReport["modelPairs"]) =>
    pairs.map((pair) => [pair.rowId, pair.otherRowId]);
  assert.deepEqual(ids(models.modelPairs), [
    ["row-0", "row-2"],
    ["row-2", "row-0"],
  ]);
  assert.deepEqual(ids(models.toolSetPairs), [
    ["row-0", "row-1"],
    ["row-1", "row-0"],
  ]);
  const [forward, backward] = models.toolSetPairs;
  // The same outcome rule and the same exact test as a model pair.
  const code = forward!.criteria[0]!;
  assert.deepEqual([code.model.met, code.other.met], [8, 0]);
  close(code.p, fisherExact(8, 0, 0, 8).twoSidedP);
  close(code.minimumAchievableP, fisherMinimumP(8, 8));
  // Holm covers the 2 criteria of this pair only, not the criteria of the model pair.
  close(code.adjustedP, 2 * code.p);
  assert.equal(code.verdict, "meets_more_often");
  assert.equal(backward!.criteria[0]!.verdict, "meets_less_often");
  assert.equal(models.modelPairs[0]!.criteria[0]!.direction, null);
  // Each pair also has its own pooled tests.
  assert.equal(forward!.classes.find((item) => item.group === "code")!.verdict, "meets_more_often");
});

test("a pattern test compares the builds that can show the pattern, with Holm over the patterns", () => {
  const { models } = toolSetRun();
  const [forward, backward] = models.toolSetPairs;
  const patterns = forward!.patterns;
  assert.deepEqual(
    patterns.map((item) => [item.family, item.key, item.model.builds, item.other.builds]),
    [
      ["stops", "delivered", 8, 8],
      ["causes", "provider_or_transport_failure", 1, 0],
      ["lint", "DeprecatedApi", 8, 0],
      ["scriptErrors", "build", 3, 0],
    ],
    "a pattern that no build of either row shows has no test",
  );
  const lint = patterns.find((item) => item.family === "lint")!;
  // Builds 6 and 7 of the second row have no analysis, so they are not builds without findings.
  assert.deepEqual(lint.model, { builds: 8, of: 8, excluded: 0 });
  assert.deepEqual(lint.other, { builds: 0, of: 6, excluded: 2 });
  assert.equal(lint.direction, "more");
  close(lint.p, fisherExact(8, 0, 0, 6).twoSidedP);
  close(lint.minimumAchievableP, fisherMinimumP(8, 6));
  const errors = patterns.find((item) => item.family === "scriptErrors")!;
  assert.deepEqual([errors.other.of, errors.other.excluded], [6, 2]);
  close(errors.p, fisherExact(3, 5, 0, 6).twoSidedP);
  const delivered = patterns[0]!;
  assert.deepEqual([delivered.direction, delivered.p], [null, 1]);
  const adjusted = holmAdjust(patterns.map((item) => item.p));
  patterns.forEach((item, index) => close(item.adjustedP, adjusted[index]!));
  assert.equal(lint.verdict, "happens_more_often");
  assert.equal(delivered.verdict, "not_enough_builds");
  // The mirror reads the same test from the other row.
  const mirror = backward!.patterns.find((item) => item.family === "lint")!;
  assert.deepEqual([mirror.model, mirror.other], [lint.other, lint.model]);
  assert.deepEqual([mirror.direction, mirror.verdict], ["less", "happens_less_often"]);
  // A family that one row cannot measure has no test: the second model has no analysis.
  assert.deepEqual(
    models.modelPairs[0]!.patterns.map((item) => item.family),
    ["stops", "causes"],
  );
});

test("the Models view projects the pairs of one family and a row for each compared pattern", () => {
  const { models } = toolSetRun();
  assert.deepEqual(rowPairs(models, "row-2", "toolSets"), []);
  assert.deepEqual(
    rowPairs(models, "row-2", "models").map((pair) => pair.otherRowId),
    ["row-0"],
  );
  const row = (id: string) => models.models.find((model) => model.rowId === id)!;
  const lintRows = patternTable(row("row-1").patterns, rowPairs(models, "row-1", "toolSets"));
  assert.deepEqual(
    lintRows.map((item) => [
      item.family,
      item.key,
      item.own?.builds ?? null,
      item.of,
      item.comparisons.map((comparison) => comparison?.verdict ?? null),
    ]),
    [
      ["stops", "delivered", 8, 8, ["not_enough_builds"]],
      ["causes", "provider_or_transport_failure", null, 8, ["not_enough_builds"]],
      ["lint", "DeprecatedApi", null, 6, ["happens_less_often"]],
      ["scriptErrors", "build", null, 6, ["not_enough_builds"]],
    ],
    "a pattern that only the other tool set shows has a row with 0 builds",
  );
  // The second model has no analysis, so the lint row of the model pair has no test.
  const modelRows = patternTable(row("row-0").patterns, rowPairs(models, "row-0", "models"));
  assert.deepEqual(modelRows.find((item) => item.family === "lint")!.comparisons, [null]);
  // Without a pair, the table has the patterns of the row only.
  assert.deepEqual(
    patternTable(row("row-0").patterns, []).map((item) => [item.family, item.key]),
    [
      ["stops", "delivered"],
      ["causes", "provider_or_transport_failure"],
      ["lint", "DeprecatedApi"],
      ["scriptErrors", "build"],
    ],
  );
});

test("a public export keeps the tool-set pairs with codes and counts only", () => {
  const { report, models } = toolSetRun();
  const input = exportInput(report, models);
  const shared = exportText(input, "public");
  for (const secret of ["SECRET", "code-criterion", "judge-criterion", "row-0"])
    assert.equal(shared.includes(secret), false, secret);
  const exported = exportReport(input);
  assert.equal(exported.models.modelPairs.length, 2);
  const [pair] = exported.models.toolSetPairs;
  assert.deepEqual(
    [pair.model, pair.toolSet, pair.otherModel, pair.otherToolSet],
    ["Model 0", "Studio tools", "Model 0", "Studio tools + code analysis"],
  );
  assert.deepEqual(
    pair.criteria.map((item: { criterion: number; verdict: string }) => [
      item.criterion,
      item.verdict,
    ]),
    [
      [1, "meets_more_often"],
      [2, "not_enough_builds"],
    ],
  );
  const lint = pair.patterns.find((item: { family: string }) => item.family === "lint");
  assert.deepEqual(Object.keys(lint).sort(), [
    "adjustedP",
    "direction",
    "family",
    "key",
    "minimumAchievableP",
    "model",
    "other",
    "p",
    "verdict",
  ]);
  assert.deepEqual(
    [lint.key, lint.model, lint.other, lint.verdict],
    [
      "DeprecatedApi",
      { builds: 8, of: 8, excluded: 0 },
      { builds: 0, of: 6, excluded: 2 },
      "happens_more_often",
    ],
  );
  // The page shows each pair one time, with the answers of its patterns.
  assert.match(shared, /<h2>Tool sets<\/h2>/u);
  assert.match(shared, /Model 0: Studio tools compared with Studio tools \+ code analysis/u);
  assert.match(shared, /Happens more often/u);
  assert.equal(shared.match(/Model 0: Studio tools \+ code analysis compared with/gu), null);
});

test("the code facts of a build read only stored records that its run binds", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-code-facts-"));
  try {
    const candidate = { rootHash: "a".repeat(64), projectFile: "default.project.json", files: [] };
    const scripts: SourceScript[] = [
      {
        file: "src/Mechanic.server.luau",
        className: "Script",
        dataModelPath: "ServerScriptService.Mechanic",
      },
    ];
    const error = (path: string, inDataModel = true) => ({
      message: `${path}:3: attempt to index nil`,
      stackTrace: `${path}:3`,
      source: { kind: "script" as const, path, className: "Script", inDataModel },
    });
    const evidence = (cell: string, observations: object[]) =>
      ({
        candidateHash: candidate.rootHash,
        scenarios: [
          {
            scenarioId: "window",
            reports: [
              {
                context: "client-1",
                actors: [{ actor: "primary", userId: 1, name: "Player1" }],
                steps: [{ stepId: "after", observations: observations.slice(1) }],
              },
            ],
          },
        ],
        phases: [{ phaseId: cell, observations: observations.slice(0, 1), captures: [] }],
      }) as unknown as StudioEvidence;
    const records: Record<string, StudioEvidence> = {
      // A server fact and a client fact of one observation.
      "cell-1": evidence("cell-1", [
        {
          factId: "server",
          kind: "diagnostics",
          messages: [],
          scriptErrors: [error("ServerScriptService.Mechanic")],
        },
        {
          factId: "client",
          kind: "diagnostics",
          messages: [],
          scriptErrors: [error("Plugin.Settings", false), error("Workspace.Clone")],
        },
      ]),
      "cell-2": evidence("cell-2", [
        {
          factId: "server",
          kind: "diagnostics",
          messages: [],
          scriptErrors: [error("ServerScriptService.Mechanic")],
        },
      ]),
      // The capture event binds another hash, so this record does not count.
      "cell-3": evidence("cell-3", [
        {
          factId: "server",
          kind: "diagnostics",
          messages: [],
          scriptErrors: [error("ServerScriptService.Mechanic")],
        },
      ]),
      // An observation without a diagnostics fact.
      "cell-4": evidence("cell-4", [
        { factId: "platform", kind: "instance", exists: true, className: "Part" },
      ]),
      // The server list grows from one error to two, so the later fact repeats the first error.
      // The client list reached its limit, so Studio kept no later error of that context.
      "cell-5": {
        candidateHash: candidate.rootHash,
        scenarios: [
          {
            scenarioId: "window",
            reports: [
              {
                context: "server",
                actors: [],
                steps: [
                  {
                    stepId: "before",
                    observations: [
                      {
                        factId: "early",
                        kind: "diagnostics",
                        messages: [],
                        scriptErrors: [error("ServerScriptService.Mechanic")],
                      },
                    ],
                  },
                  {
                    stepId: "after",
                    observations: [
                      {
                        factId: "late",
                        kind: "diagnostics",
                        messages: [],
                        scriptErrors: [
                          error("ServerScriptService.Mechanic"),
                          error("Workspace.Clone"),
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                context: "client-1",
                actors: [{ actor: "primary", userId: 1, name: "Player1" }],
                steps: [
                  {
                    stepId: "after",
                    observations: [
                      {
                        factId: "client",
                        kind: "diagnostics",
                        messages: [],
                        scriptErrors: Array(DIAGNOSTIC_CHANNEL_LIMIT).fill(
                          error("Plugin.Settings", false),
                        ),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        phases: [],
      } as unknown as StudioEvidence,
    };
    for (const [cell, record] of Object.entries(records)) {
      const folder = resolve(root, `.basalt-evals/eval-operations/run/capture/${cell}/studio`);
      await mkdir(folder, { recursive: true });
      await writeFile(resolve(folder, "evidence.json"), JSON.stringify(record));
    }
    const captured = (cell: string, hash: string) => ({
      stage: "final_capture",
      unitId: cell,
      kind: "completed",
      artifactHashes: ["b".repeat(64), hash],
    });
    const status = (cells: string[]) =>
      ({
        manifest: {
          id: "run",
          captureCells: cells.map((id) => ({ id, treatmentId: "build" })),
        },
        events: [
          captured("cell-1", hashJson(records["cell-1"])),
          captured("cell-2", hashJson(records["cell-2"])),
          captured("cell-3", "c".repeat(64)),
          captured("cell-4", hashJson(records["cell-4"])),
          captured("cell-5", hashJson(records["cell-5"])),
        ],
      }) as unknown as RunOperationStatus;
    const analysis = (patch: Partial<SourceAnalysis>): SourceAnalysis => ({
      schema: SOURCE_ANALYSIS_SCHEMA,
      candidateHash: candidate.rootHash,
      toolchain: {
        luauLsp: "1.63.0",
        rojo: "7.7.0",
        definitionsSha256: "d".repeat(64),
        flags: [],
        luaurc: "{}",
      },
      status: "complete",
      reason: null,
      scripts,
      findings: [],
      counts: { LocalUnused: 2 },
      suppressions: [],
      ...patch,
    });
    const facts = (cells: string[], stored: SourceAnalysis | null) =>
      buildCodeFacts(root, status(cells), "build", candidate, async () => stored);
    assert.deepEqual(await facts(["cell-1", "cell-2", "cell-3", "cell-4"], analysis({})), {
      analysis: "complete",
      lint: { LocalUnused: 2 },
      scriptErrors: { build: 2, unknown: 1, external: 1, truncated: false },
    });
    // Each context counts its fact with the most records, so each error counts one time.
    assert.deepEqual((await facts(["cell-5"], analysis({}))).scriptErrors, {
      build: 1,
      unknown: 1,
      external: DIAGNOSTIC_CHANNEL_LIMIT,
      truncated: true,
    });
    assert.deepEqual((await facts(["cell-2", "cell-5"], analysis({}))).scriptErrors, {
      build: 2,
      unknown: 1,
      external: DIAGNOSTIC_CHANNEL_LIMIT,
      truncated: true,
    });
    assert.deepEqual(await facts(["cell-4"], analysis({})), {
      analysis: "complete",
      lint: { LocalUnused: 2 },
      scriptErrors: null,
    });
    assert.deepEqual(
      await facts(
        ["cell-1"],
        analysis({ status: "unavailable", reason: "Rojo failed", scripts: [], counts: {} }),
      ),
      { analysis: "unavailable", lint: null, scriptErrors: null },
      "an unavailable analysis is not a clean build",
    );
    assert.deepEqual(await facts(["cell-1"], null), {
      analysis: "absent",
      lint: null,
      scriptErrors: null,
    });
    // A report never makes an analysis. Without the pins, every build has none.
    assert.equal(await (await reportSourceAnalyses(root))(candidate), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
