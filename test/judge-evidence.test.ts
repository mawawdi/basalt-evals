import assert from "node:assert/strict";
import test from "node:test";
import { hashJson, type StudioObservation } from "../packages/contracts/src/index.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import {
  judgeEvidence,
  sampleTable,
  shortestFloat32,
} from "../packages/eval-authoring/src/judge-evidence.js";

const float32 = (value: number) => Math.fround(value);

test("a sample table keeps every 32-bit value and the time of every change", () => {
  const rest = float32(3.4999005794525146);
  const settled = float32(3.499999761581421);
  const samples = [
    { elapsedMs: 0, y: rest, sizeX: 10, x: 0 },
    { elapsedMs: 116, y: settled, sizeX: 10, x: 0 },
    { elapsedMs: 233, y: settled, sizeX: 10, x: 0 },
    { elapsedMs: 350, y: settled, sizeX: 10, x: 0 },
    { elapsedMs: 900, y: float32(9.25), sizeX: 10, x: float32(0.1) },
  ];
  const table = sampleTable(samples);
  assert.deepEqual(table.constant, { sizeX: 10 });
  assert.deepEqual(table.columns, ["elapsedMs", "x", "y"]);
  assert.equal(table.maxGapMs, 550);
  assert.deepEqual(table.rows, [
    [0, 0, 3.4999006],
    [[116, 350, 3], 0, 3.4999998],
    [900, 0.1, 9.25],
  ]);
  assert.deepEqual(table.summary.y, {
    first: 3.4999006,
    last: 9.25,
    min: 3.4999006,
    max: 9.25,
    firstChangeMs: 116,
    lastChangeMs: 900,
    // A difference of two 32-bit values is not always a 32-bit value. It keeps its full form.
    largestStep: 9.25 - settled,
    largestStepAtMs: 900,
  });
  // Expand the table again. Each sample gets its exact signed value back.
  const expanded = table.rows.flatMap(([time, ...values]) =>
    Array.from({ length: Array.isArray(time) ? time[2] : 1 }, () =>
      Object.fromEntries([
        ...Object.entries(table.constant),
        ...table.columns.slice(1).map((key, index) => [key, float32(values[index] as number)]),
      ]),
    ),
  );
  assert.deepEqual(
    expanded,
    samples.map((sample) =>
      Object.fromEntries(Object.entries(sample).filter(([key]) => key !== "elapsedMs")),
    ),
  );
});

test("a value that is not a 32-bit float keeps its full form", () => {
  assert.equal(shortestFloat32(0.1), 0.1);
  assert.equal(shortestFloat32(float32(0.1)), 0.1);
  assert.equal(shortestFloat32(1234), 1234);
  assert.equal(shortestFloat32(1 / 3), 1 / 3);
  assert.equal(sampleTable([]).count, 0);
  assert.throws(
    () =>
      sampleTable([
        { elapsedMs: 0, x: 1 },
        { elapsedMs: 1, y: 1 },
      ]),
    /do not have one shape/,
  );
});

test("the judge sees a trace and a source file one time when two criteria use them", () => {
  const binding = {
    scenarioId: "carry",
    stepId: "trace",
    context: "player1",
    factId: "rider_platform_motion",
  };
  const observation = {
    factId: "rider_platform_motion",
    kind: "part_motion",
    samples: Array.from({ length: 320 }, (_, index) => ({
      elapsedMs: index * 116,
      x: 0,
      y: 0,
      z: 0,
    })),
    delta: 0,
  } satisfies StudioObservation;
  const source = { path: "src/server/Main.server.luau", hash: "a".repeat(64), text: "return 1" };
  const material = ["carry", "smooth"].map((id) => ({
    ...pendingCriterionMaterial(id),
    signedObservations: [{ binding, observation, hash: hashJson(observation) }],
    sealedSources: [source],
  }));
  const presented = judgeEvidence(material);
  assert.deepEqual(
    presented.criterionEvidence.map((item) => [item.criterionId, item.observations, item.sources]),
    [
      ["carry", ["O1"], [source.path]],
      ["smooth", ["O1"], [source.path]],
    ],
  );
  assert.equal(presented.signedObservations.length, 1);
  assert.deepEqual(presented.sealedSources, [source]);
  assert.deepEqual(presented.signedObservations[0]!.observation, {
    factId: "rider_platform_motion",
    kind: "part_motion",
    delta: 0,
    samples: {
      count: 320,
      firstMs: 0,
      lastMs: 319 * 116,
      maxGapMs: 116,
      constant: { x: 0, y: 0, z: 0 },
      columns: ["elapsedMs"],
      rows: [[[0, 319 * 116, 320]]],
      summary: {},
    },
  });
  const changed = structuredClone(material);
  changed[1]!.signedObservations[0]!.hash = "b".repeat(64);
  assert.throws(() => judgeEvidence(changed), /different observations for one binding/);
});

test("the judge sees an instance value exactly as Studio signed it", () => {
  const binding = { scenarioId: "win", stepId: "after", context: "player1", factId: "wins" };
  const observation = {
    factId: "wins",
    kind: "instance_value",
    exists: true,
    className: "IntValue",
    value: 1,
  } satisfies StudioObservation;
  const presented = judgeEvidence([
    {
      ...pendingCriterionMaterial("wins-rise"),
      signedObservations: [{ binding, observation, hash: hashJson(observation) }],
    },
  ]);
  assert.deepEqual(presented.signedObservations[0]!.observation, observation);
});
