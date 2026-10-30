import assert from "node:assert/strict";
import test from "node:test";
import type {
  BenchmarkCriterionOutcome,
  BenchmarkRequestTelemetry,
} from "../packages/contracts/src/benchmarks.js";
import type {
  RunOperationEvent,
  RunOperationManifest,
  RunOperationStatus,
} from "../packages/contracts/src/execution.js";
import {
  buildBreakdown,
  caseBuilds,
  type BenchmarkBuildRecords,
} from "../packages/experiments/src/benchmark-builds.js";
import {
  evaluationBuildMarks,
  projectBenchmarkReport,
} from "../packages/experiments/src/benchmark-projection.js";
import { authoredCriterionOrder, criterionNumbers } from "../packages/operator/src/benchmarks.js";
import { analysisCriteria } from "../packages/operator/src/experiment-report.js";

// One evaluation, one model and two repetitions. Each build has two observations, and each
// observation has one code check and one judge batch.
const subjects = ["s-0", "s-1"].map((id) => ({
  id,
  evalId: "e",
  kind: "generated",
  stageIndex: 1,
  parentSubjectId: null,
  builder: {
    model: { id: "model" },
    harness: { id: "production" },
    environment: {},
    transportConfigurationHash: "transport",
  },
}));
const captureCells = subjects.flatMap((subject) =>
  [2, 1].map((pass) => ({ id: `c-${subject.id}-${pass}`, treatmentId: subject.id, pass })),
);
const gradingCells = captureCells.map((capture) => ({
  id: `d-${capture.id}`,
  captureCellId: capture.id,
  criterionId: "behavior",
  method: "deterministic" as const,
}));
const judgmentBatches = captureCells.map((capture) => ({
  id: `j-${capture.id}`,
  sampleGroupId: `g-${capture.id}`,
  sample: 1,
  captureCellId: capture.id,
  criterionIds: ["appearance", "polish"],
  configuration: { modelId: "judge" },
  presentation: "sequence",
}));
const manifest = {
  id: "run",
  evals: [
    {
      id: "e",
      stage: { firstRevisionId: "e", index: 1, count: 1, earlierPrompts: [], gateCriterionIds: [] },
    },
  ],
  selectedModelIds: ["model"],
  selectedHarnessIds: ["production"],
  modelSnapshots: [
    {
      id: "model",
      name: "Model",
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
} as unknown as RunOperationManifest;
const outcomes: BenchmarkCriterionOutcome[] = [
  {
    cellId: "d-c-s-0-1",
    criterionId: "behavior",
    method: "deterministic",
    outcome: "met",
    score: null,
    samples: null,
    observed: null,
  },
  {
    cellId: "j-c-s-0-1",
    criterionId: "appearance",
    method: "model",
    outcome: "rejected",
    score: null,
    samples: null,
    observed: null,
  },
  {
    cellId: "j-c-s-0-1",
    criterionId: "polish",
    method: "model",
    outcome: "scored",
    score: 3,
    samples: null,
    observed: null,
  },
  {
    cellId: "d-c-s-1-2",
    criterionId: "behavior",
    method: "deterministic",
    outcome: "insufficient",
    score: null,
    samples: null,
    observed: null,
  },
];
const records = (patch: Partial<BenchmarkBuildRecords> = {}): BenchmarkBuildRecords => ({
  manifest,
  events: [],
  outcomes,
  requests: [],
  studioSessions: [],
  ...patch,
});
function request(patch: Partial<BenchmarkRequestTelemetry>): BenchmarkRequestTelemetry {
  return {
    operationId: "run",
    requestId: "one",
    stage: "builder:s-0",
    role: "builder",
    dispatched: true,
    receiptHash: "record",
    status: "billed",
    billedUsd: 0.25,
    reservedUsd: 1,
    usage: null,
    imageInputs: [],
    latencyMs: 1_000,
    resultKind: "assistant",
    stopReason: "end_turn",
    cut: null,
    requestedModel: "model",
    resolvedModel: null,
    servingProvider: null,
    issue: null,
    ...patch,
  };
}

test("each repetition keeps its own build and marks", () => {
  const builds = caseBuilds(records(), ["s-1", "s-0"]);
  assert.deepEqual(
    builds.map((build) => [build.subjectId, build.number]),
    [
      ["s-0", 1],
      ["s-1", 2],
    ],
  );
  for (const build of builds) {
    assert.equal(build.marks.length, 6);
    assert.ok(build.marks.every((mark) => mark.subjectId === build.subjectId));
    assert.deepEqual(
      build.marks.map((mark) => mark.pass),
      [1, 1, 1, 2, 2, 2],
      "marks follow the observation order",
    );
  }
  assert.equal(builds[0]!.marks.filter((mark) => mark.outcome === "met").length, 1);
  assert.equal(builds[1]!.marks.filter((mark) => mark.outcome === "met").length, 0);
});

test("a judge mark links to the evidence cell of its sample group and criterion", () => {
  const [build] = caseBuilds(records(), ["s-0"]);
  const judged = build!.marks.find((mark) => mark.pass === 1 && mark.criterionId === "appearance");
  assert.deepEqual(judged, {
    subjectId: "s-0",
    pass: 1,
    criterionId: "appearance",
    method: "model",
    evidenceCellId: "g-c-s-0-1:appearance",
    outcome: "rejected",
    score: null,
    samples: { met: 0, of: 1 },
    observed: null,
  });
  const coded = build!.marks.find((mark) => mark.pass === 1 && mark.criterionId === "behavior");
  assert.equal(coded!.evidenceCellId, "d-c-s-0-1", "a code check links to its grading cell");
  assert.equal(coded!.method, "deterministic");
  const scored = build!.marks.find((mark) => mark.pass === 1 && mark.criterionId === "polish");
  assert.deepEqual([scored!.outcome, scored!.score], ["scored", 3]);
});

test("a planned answer without a record is a missing mark", () => {
  const [, second] = caseBuilds(records(), ["s-0", "s-1"]);
  assert.deepEqual(
    second!.marks.map((mark) => mark.outcome),
    ["missing", "missing", "missing", "insufficient", "missing", "missing"],
  );
  const report = projectBenchmarkReport({
    status: {
      manifest,
      events: [],
      completedUnits: [],
      finished: true,
      stopped: false,
      inFlightUnits: [],
    } as unknown as RunOperationStatus,
    title: "Builds",
    definitions: [],
    outcomes,
    requests: [],
  });
  const [item] = report.rows[0]!.cases;
  assert.equal(item!.builds.flatMap((build) => build.marks).length, item!.answers.planned);
  assert.equal(
    item!.builds.flatMap((build) => build.marks).filter((mark) => mark.outcome === "missing")
      .length,
    item!.answers.missing,
  );
});

test("the plan warnings read the builds of the report without its receipts", () => {
  // A build of a model without a saved record has no report row, so it has no marks either.
  const ghost = {
    ...subjects[0]!,
    id: "s-2",
    builder: { ...subjects[0]!.builder, model: { id: "ghost" } },
  };
  const status = {
    manifest: { ...manifest, selectedModelIds: ["ghost", "model"], subjects: [ghost, ...subjects] },
    events: [],
    completedUnits: [],
    finished: true,
    stopped: false,
    inFlightUnits: [],
  } as unknown as RunOperationStatus;
  const report = projectBenchmarkReport({
    status,
    title: "Builds",
    definitions: [],
    outcomes,
    requests: [request({ stage: "builder:s-1" })],
  });
  const builds = report.rows.flatMap((row) => row.cases.flatMap((item) => item.builds));
  assert.deepEqual(
    builds.map((build) => build.subjectId),
    ["s-0", "s-1"],
  );
  assert.deepEqual(
    evaluationBuildMarks(status, outcomes, "e"),
    builds.map(({ breakdown, ...build }) => build),
  );
  assert.deepEqual(evaluationBuildMarks(status, outcomes, "other"), []);
  assert.throws(
    () => evaluationBuildMarks(status, [...outcomes, outcomes[0]!], "e"),
    /Duplicate original criterion answer identity/,
  );
});

test("criteria keep the authored order", () => {
  const mapping = (
    executableCriterionId: string,
    authoredCriterionId: string | null,
    start = 0,
  ) => ({
    executableCriterionId,
    authoredCriterionId,
    authority: { source: "human_rubric" as const, start, end: start + 1 },
  });
  const revision = {
    authored: { criteria: [{ id: "first" }, { id: "second" }, { id: "third" }] },
    criterionMappings: [
      mapping("rule", "third", 90),
      mapping("visual", "second", 40),
      mapping("code", "first", 10),
      mapping("prompt", null, 0),
    ],
  } as unknown as Parameters<typeof authoredCriterionOrder>[0];
  // The evaluator lists criteria by kind: code rules, code quality, visual, then unscaled.
  assert.deepEqual(authoredCriterionOrder(revision, ["rule", "code", "visual", "prompt"]), [
    "code",
    "visual",
    "rule",
    "prompt",
  ]);
  // "Criterion n" counts all criteria of the revision, so a run that plans fewer keeps the numbers.
  const evaluator = {
    ...revision,
    privateEvaluator: {
      deterministic: [{ id: "rule" }, { id: "code" }],
      codeQuality: [],
      visual: [{ id: "visual" }],
      unscaled: [{ id: "prompt" }],
    },
  } as unknown as Parameters<typeof criterionNumbers>[0];
  assert.deepEqual(
    [...criterionNumbers(evaluator)],
    [
      ["code", 1],
      ["visual", 2],
      ["rule", 3],
      ["prompt", 4],
    ],
  );
  const definitions = ["code", "visual", "rule"].map((criterionId) => ({
    evaluationId: "e",
    criterionId,
    statement: criterionId,
    required: true,
    evidenceClass: null,
    scaleHash: null,
    scale: null,
  }));
  const report = projectBenchmarkReport({
    status: {
      manifest,
      events: [],
      completedUnits: [],
      finished: true,
      stopped: false,
      inFlightUnits: [],
    } as unknown as RunOperationStatus,
    title: "Order",
    definitions,
    outcomes: [],
    requests: [],
  });
  assert.deepEqual(report.criteria, definitions);
});

test("an unknown turn latency leaves the turn time unknown", () => {
  const at = (ms: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + ms).toISOString();
  const event = (stage: "builder" | "judgment", unitId: string, kind: string, ms: number) =>
    ({ stage, unitId, kind, at: at(ms) }) as RunOperationEvent;
  const known = records({
    events: [
      event("builder", "s-0", "started", 0),
      event("builder", "s-0", "paused", 2_000),
      event("builder", "s-0", "started", 10_000),
      event("builder", "s-0", "completed", 13_000),
      event("judgment", "j-c-s-0-1", "started", 20_000),
      event("judgment", "j-c-s-0-1", "completed", 21_500),
      event("judgment", "j-c-s-0-2", "started", 20_000),
      event("judgment", "j-c-s-0-2", "completed", 22_000),
    ],
    requests: [
      request({}),
      request({ requestId: "two", latencyMs: 1_500 }),
      // A request that Basalt never sent has no turn to time.
      request({ requestId: "local", dispatched: false, latencyMs: null, billedUsd: 0 }),
      request({
        requestId: "judge",
        stage: "judgment:j-c-s-0-1",
        role: "grader",
        billedUsd: 0.05,
      }),
      request({
        requestId: "held",
        stage: "judgment:j-c-s-0-2",
        role: "grader",
        status: "pending",
        billedUsd: null,
        reservedUsd: 0.4,
        latencyMs: null,
      }),
    ],
    studioSessions: [
      { stage: "builder", unitId: "s-0", activeMs: 4_000, queueMs: 500 },
      { stage: "final_capture", unitId: "c-s-0-1", activeMs: 30_000, queueMs: 0 },
      { stage: "final_capture", unitId: "c-s-0-2", activeMs: 31_000, queueMs: null },
    ],
  });
  assert.deepEqual(buildBreakdown(known, "s-0"), {
    charge: { builderUsd: 0.5, judgeUsd: 0.05, pendingUsd: 0.4 },
    time: {
      buildMs: 5_000,
      builderTurnsMs: 2_500,
      builderStudioWaitMs: 500,
      builderStudioMs: 4_000,
      observationStudioWaitMs: null,
      observationStudioMs: 61_000,
      judgeMs: 3_500,
    },
  });
  const unknown = records({
    requests: [request({}), request({ requestId: "two", latencyMs: null })],
  });
  assert.equal(buildBreakdown(unknown, "s-0").time.builderTurnsMs, null);
  assert.deepEqual(
    buildBreakdown(records(), "s-1").time,
    {
      buildMs: null,
      builderTurnsMs: null,
      builderStudioWaitMs: null,
      builderStudioMs: null,
      observationStudioWaitMs: null,
      observationStudioMs: null,
      judgeMs: null,
    },
    "a build that has not started has no recorded part",
  );
});

test("judge samples combine into one mark per sample group", () => {
  // Three identical samples of one judge request for each observation of build s-0.
  const sampled = {
    ...manifest,
    judgmentBatches: captureCells.flatMap((capture) =>
      [1, 2, 3].map((sample) => ({
        id: `j-${capture.id}-${sample}`,
        sampleGroupId: `g-${capture.id}`,
        sample,
        captureCellId: capture.id,
        criterionIds: ["appearance"],
        configuration: { modelId: "judge" },
        presentation: "sequence",
      })),
    ),
  } as unknown as RunOperationManifest;
  const answer = (
    capture: string,
    sample: number,
    outcome: BenchmarkCriterionOutcome["outcome"],
  ): BenchmarkCriterionOutcome => ({
    cellId: `j-${capture}-${sample}`,
    criterionId: "appearance",
    method: "model",
    outcome,
    score: null,
    samples: null,
    observed: null,
  });
  const sampledOutcomes = [
    // Observation 1: the samples disagree. Observation 2: every sample is met.
    answer("c-s-0-1", 1, "met"),
    answer("c-s-0-1", 2, "rejected"),
    answer("c-s-0-1", 3, "met"),
    ...[1, 2, 3].map((sample) => answer("c-s-0-2", sample, "met")),
    // Build s-1, observation 1: one sample has no saved answer yet.
    answer("c-s-1-1", 1, "rejected"),
    answer("c-s-1-1", 2, "rejected"),
    // Build s-1, observation 2: one sample has not enough evidence.
    answer("c-s-1-2", 1, "insufficient"),
    answer("c-s-1-2", 2, "met"),
    answer("c-s-1-2", 3, "met"),
  ];
  const [first, second] = caseBuilds(
    { ...records(), manifest: sampled, outcomes: sampledOutcomes },
    ["s-0", "s-1"],
  );
  const judged = (build: typeof first) =>
    build!.marks
      .filter((mark) => mark.criterionId === "appearance")
      .map((mark) => [mark.pass, mark.evidenceCellId, mark.outcome, mark.samples]);
  assert.deepEqual(judged(first), [
    [1, "g-c-s-0-1:appearance", "split", { met: 2, of: 3 }],
    [2, "g-c-s-0-2:appearance", "met", { met: 3, of: 3 }],
  ]);
  assert.deepEqual(
    judged(second),
    [
      [1, "g-c-s-1-1:appearance", "missing", null],
      [2, "g-c-s-1-2:appearance", "insufficient", { met: 2, of: 3 }],
    ],
    "A sample without an answer leaves the group missing; an insufficient sample is an answer",
  );
  const report = projectBenchmarkReport({
    status: {
      manifest: sampled,
      events: [],
      completedUnits: [],
      finished: true,
      stopped: false,
      inFlightUnits: [],
    } as unknown as RunOperationStatus,
    title: "Samples",
    definitions: [],
    outcomes: [...outcomes.filter((row) => row.method === "deterministic"), ...sampledOutcomes],
    requests: [],
  });
  const counted = report.rows[0]!.methods.model.answers;
  assert.deepEqual(
    counted,
    { planned: 4, met: 1, rejected: 0, scored: 0, insufficient: 1, missing: 1, split: 1 },
    "Each sample group counts one time, not each sample",
  );
});

test("the analysis names each criterion by its statement and its authored number", () => {
  const mapping = (executableCriterionId: string, authoredCriterionId: string) => ({
    executableCriterionId,
    authoredCriterionId,
    authority: { source: "human_rubric" as const, start: 0, end: 1 },
  });
  const criterion = (id: string, statement: string) => ({ id, statement });
  const revision = {
    authored: { criteria: [{ id: "first" }, { id: "second" }] },
    criterionMappings: [mapping("rule", "second"), mapping("look", "first")],
    privateEvaluator: {
      deterministic: [criterion("rule", "- The Beacon exists.")],
      codeQuality: [],
      visual: [criterion("look", "The Beacon looks blue.")],
      unscaled: [],
    },
  } as unknown as Parameters<typeof analysisCriteria>[1];
  assert.deepEqual(analysisCriteria("e", revision), [
    { evalId: "e", criterionId: "look", number: 1, statement: "The Beacon looks blue." },
    { evalId: "e", criterionId: "rule", number: 2, statement: "- The Beacon exists." },
  ]);
});
