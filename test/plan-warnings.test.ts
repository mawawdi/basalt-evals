import assert from "node:assert/strict";
import test from "node:test";
import type {
  RunOperationManifest,
  RunOperationStatus,
} from "../packages/contracts/src/execution.js";
import { projectBenchmarkReport } from "../packages/experiments/src/benchmark-projection.js";
import {
  authoredWarningOrder,
  criterionWarnings,
  type PlanWarningRow,
} from "../packages/experiments/src/plan-warnings.js";

/** One generated build answer: build `b`, observation `o`, for criterion `c` of evaluation `e`. */
function row(
  buildId: string,
  answer: PlanWarningRow["answer"],
  observed: PlanWarningRow["observed"] = null,
  patch: Partial<PlanWarningRow> = {},
): PlanWarningRow {
  return {
    evaluationId: "e",
    criterionId: "c",
    origin: "generated",
    buildId,
    answer,
    observed,
    expectation: null,
    ...patch,
  };
}

test("Every build that fails with the same observed value gives one warning with the value.", () => {
  const rows = [row("b1", "rejected", [0]), row("b1", "rejected", [0]), row("b2", "rejected", [0])];
  assert.deepEqual(criterionWarnings(rows), [
    {
      evaluationId: "e",
      criterionId: "c",
      kind: "same_observed_failure",
      builds: 2,
      observed: [0],
      knownBuildIds: [],
    },
  ]);
});

test("Every build that fails with different values gives the warning that every build fails.", () => {
  for (const rows of [
    [row("b1", "rejected", [0]), row("b2", "rejected", [1])],
    // A judge check reads no value, so it never has the same observed value.
    [row("b1", "rejected"), row("b2", "rejected")],
  ])
    assert.deepEqual(
      criterionWarnings(rows).map((warning) => [warning.kind, warning.builds, warning.observed]),
      [["every_build_fails", 2, null]],
    );
});

test("Every build that meets the criterion gives a warning.", () => {
  assert.deepEqual(
    criterionWarnings([row("b1", "met"), row("b2", "met"), row("b3", "met")]).map((warning) => [
      warning.kind,
      warning.builds,
    ]),
    [["every_build_meets", 3]],
  );
});

test("A pass on the empty build gives a warning with the value of the empty build.", () => {
  const empty = row("empty-build/e", "met", [true], { origin: "empty_build" });
  assert.deepEqual(criterionWarnings([empty]), [
    {
      evaluationId: "e",
      criterionId: "c",
      kind: "passes_empty_build",
      builds: 0,
      observed: [true],
      knownBuildIds: [],
    },
  ]);
  // The empty build never counts as a generated build.
  assert.deepEqual(
    criterionWarnings([empty, row("b1", "met")], 2).map((warning) => warning.kind),
    ["passes_empty_build"],
  );
});

test("A known build whose answer differs from its expected answer gives a warning.", () => {
  const known = (buildId: string, answer: PlanWarningRow["answer"], expectation: "met") =>
    row(buildId, answer, null, { origin: "known_build", expectation });
  assert.deepEqual(
    criterionWarnings([
      known("good-1", "rejected", "met"),
      known("good-2", "met", "met"),
      known("good-1", "rejected", "met"),
    ]).map((warning) => [warning.kind, warning.knownBuildIds]),
    [["known_build_disagrees", ["good-1"]]],
  );
  assert.deepEqual(criterionWarnings([]), [], "No known build gives no warning");
});

test("An insufficient or missing answer gives no warning.", () => {
  for (const blocked of ["insufficient", "missing", "split", "scored"] as const) {
    assert.deepEqual(
      criterionWarnings([
        row("b1", "rejected", [0]),
        row("b2", "rejected", [0]),
        row("b2", blocked),
      ]),
      [],
      `${blocked} blocks the warning that every build fails`,
    );
    assert.deepEqual(criterionWarnings([row("b1", "met"), row("b2", blocked)]), []);
    assert.deepEqual(
      criterionWarnings([
        row("good", blocked, null, { origin: "known_build", expectation: "met" }),
      ]),
      [],
      `${blocked} on a known build is not a disagreement`,
    );
  }
  assert.deepEqual(
    criterionWarnings([row("b1", "rejected", [0]), row("b1", "rejected", [0])]),
    [],
    "One build is fewer than the minimum of two builds",
  );
  assert.deepEqual(
    criterionWarnings([row("b1", "rejected", [0])], 1).map((warning) => warning.kind),
    ["same_observed_failure"],
  );
});

test("Warnings follow the authored criteria, and each criterion keeps its own warnings.", () => {
  const other = { criterionId: "first" };
  const warnings = criterionWarnings([
    row("b1", "met"),
    row("b2", "met"),
    row("b1", "rejected", null, other),
    row("b2", "met", null, other),
    row("empty-build/e", "met", null, { ...other, origin: "empty_build" }),
  ]);
  assert.deepEqual(
    authoredWarningOrder(warnings, [
      { evaluationId: "e", criterionId: "first" },
      { evaluationId: "e", criterionId: "c" },
    ]).map((warning) => [warning.criterionId, warning.kind]),
    [
      ["first", "passes_empty_build"],
      ["c", "every_build_meets"],
    ],
  );
});

test("The benchmark projection reports the plan warnings of its builds after its issues.", () => {
  const subjects = ["s-0", "s-1"].map((id) => ({
    id,
    evalId: "e",
    kind: "generated",
    builder: {
      model: { id: "model" },
      harness: { id: "production" },
      environment: {},
      transportConfigurationHash: "transport",
    },
  }));
  const manifest = {
    id: "run",
    evals: [
      {
        id: "e",
        stage: {
          firstRevisionId: "e",
          index: 1,
          count: 1,
          earlierPrompts: [],
          gateCriterionIds: [],
        },
      },
    ],
    selectedModelIds: ["model"],
    selectedHarnessIds: ["production"],
    modelSnapshots: [
      {
        id: "model",
        name: "Model",
        revision: "r",
        endpoints: [{ provider: "p", quantization: "q" }],
      },
    ],
    subjects,
    captureCells: subjects.map((subject) => ({
      id: `c-${subject.id}`,
      treatmentId: subject.id,
      pass: 1,
    })),
    gradingCells: subjects.map((subject) => ({
      id: `d-${subject.id}`,
      captureCellId: `c-${subject.id}`,
      criterionId: "door-opens",
      method: "deterministic",
    })),
    judgmentBatches: [],
    planned: { independentBuilderTrials: 2 },
    gradingMode: "code",
  } as unknown as RunOperationManifest;
  const report = projectBenchmarkReport({
    status: {
      manifest,
      events: [],
      completedUnits: [],
      finished: true,
      stopped: false,
      inFlightUnits: [],
    } as unknown as RunOperationStatus,
    title: "Warnings",
    definitions: [],
    outcomes: subjects.map((subject) => ({
      cellId: `d-${subject.id}`,
      criterionId: "door-opens",
      method: "deterministic",
      outcome: "rejected",
      score: null,
      samples: null,
      observed: ["Closed"],
    })),
    requests: [],
    planRows: [
      row("empty-build/e", "met", [true], { criterionId: "beacon", origin: "empty_build" }),
    ],
  });
  assert.deepEqual(Object.keys(report).slice(-2), ["issues", "planWarnings"]);
  assert.deepEqual(
    report.planWarnings.map((warning) => [warning.criterionId, warning.kind, warning.observed]),
    [
      ["door-opens", "same_observed_failure", ["Closed"]],
      ["beacon", "passes_empty_build", [true]],
    ],
  );
});
