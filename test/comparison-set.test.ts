import assert from "node:assert/strict";
import test from "node:test";
import {
  comparisonGrid,
  comparisonSet,
  pairedAnswerTransitions,
  sharedEvidenceScope,
} from "../packages/experiments/src/comparisons.js";
import type {
  ComparisonCell,
  ComparisonPopulation,
  RunComparison,
} from "../packages/contracts/src/comparisons.js";

const recorded = {
  environment: { studioVersion: "studio", camera: "fixed" },
  transport: "transport",
};

function cell(candidateId: string, pass: number, criterionId: string, order: number) {
  return {
    evaluationId: "evaluation",
    rubricHash: "rubric",
    candidateId,
    criterionId,
    criterionOrder: order,
    statement: `Statement of ${criterionId}`,
    scale: null,
    captureId: `${candidateId}-capture-${pass}`,
    pass,
    evidenceCellId: `${candidateId}-${criterionId}-${pass}`,
    acquisitionHash: "view",
    graderIdentity: "judge",
    generatorIdentity: "builder",
    method: "qualitative",
    outcome: "met",
    score: null,
    scaleHash: null,
  } satisfies ComparisonCell;
}

function run(operationId: string, candidateId = `${operationId}-build`): ComparisonPopulation {
  return {
    operationId,
    manifestHash: `${operationId}-manifest`,
    kind: "execution",
    sourceOperationId: null,
    title: "Beacon",
    evaluations: [{ evaluationId: "evaluation", title: "Beacon" }],
    recordedAt: null,
    conditions: {
      implementation: "commit",
      build: "build",
      connector: "connector",
      builders: [recorded],
    },
    // The second criterion comes first in the authored order.
    cells: [1, 2].flatMap((pass) => [
      cell(candidateId, pass, "beacon-blue", 1),
      cell(candidateId, pass, "beacon-exists", 0),
    ]),
    independentBuilds: 1,
    captures: 2,
    billedUsd: 0,
    reservedUsd: 0,
    toolCalls: 3,
    elapsedMs: 10,
  };
}

test("three independent runs form three unpaired pairs", () => {
  // Each run made build number 1 with observations 1 and 2. Equal ordinals never pair them.
  const runs = [run("first", "build"), run("second", "build"), run("third", "build")];
  const set = comparisonSet(runs);
  assert.deepEqual(
    set.pairs.map((pair) => [pair.left, pair.right, pair.pairing]),
    [
      ["first", "second", "unpaired"],
      ["first", "third", "unpaired"],
      ["second", "third", "unpaired"],
    ],
  );
  assert.equal(set.compatibility, "direct");
  const comparison: RunComparison = {
    id: "set",
    createdAt: "",
    populations: runs,
    scope: runs.map((item) => ({ operationId: item.operationId, decisionsExcluded: 0 })),
    ...set,
  };
  assert.equal(pairedAnswerTransitions(comparison, "first", "second"), null);
  const grid = comparisonGrid(comparison);
  assert.deepEqual(
    grid.evaluations[0]!.rows.map((row) => row.criterionId),
    ["beacon-exists", "beacon-blue"],
    "Criteria keep their authored order",
  );
  assert.deepEqual(
    grid.evaluations[0]!.rows[0]!.cells.map((item) => [item.operationId, item.met, item.planned]),
    [
      ["first", 2, 2],
      ["second", 2, 2],
      ["third", 2, 2],
    ],
  );
  assert.throws(() => comparisonSet(runs.slice(0, 1)), /two to six/);
  assert.throws(() => comparisonSet([runs[0]!, runs[0]!]), /one time/);
});

test("one differing connector makes the set differ and names its pair", () => {
  const changed = run("third");
  changed.conditions = { ...changed.conditions, connector: "another-connector" };
  const set = comparisonSet([run("first"), run("second"), changed]);
  assert.equal(set.compatibility, "descriptive");
  const differing = set.pairs.filter((pair) => pair.compatibility !== "direct");
  assert.deepEqual(
    differing.map((pair) => [pair.left, pair.right]),
    [
      ["first", "third"],
      ["second", "third"],
    ],
  );
  assert.ok(differing.every((pair) => pair.reasons.some((reason) => /connector/u.test(reason))));
  assert.equal(
    set.pairs.find((pair) => pair.left === "first" && pair.right === "second")!.compatibility,
    "direct",
  );
});

test("an assessment and its source share the intersection of their scope", () => {
  const source = run("source");
  // The reassessment checked one criterion of the first observation again.
  const assessment: ComparisonPopulation = {
    ...source,
    operationId: "assessment",
    kind: "assessment",
    sourceOperationId: "source",
    independentBuilds: 0,
    captures: 0,
    cells: source.cells
      .filter((item) => item.pass === 1 && item.criterionId === "beacon-blue")
      .map((item) => ({ ...item, graderIdentity: "new-judge", evidenceCellId: null })),
  };
  const other = run("other");
  const scoped = sharedEvidenceScope([source, assessment, other]);
  assert.deepEqual(scoped.scope, [
    { operationId: "source", decisionsExcluded: 3 },
    { operationId: "assessment", decisionsExcluded: 0 },
    { operationId: "other", decisionsExcluded: 2 },
  ]);
  assert.deepEqual(
    scoped.populations[0]!.cells.map((item) => [item.criterionId, item.pass]),
    [["beacon-blue", 1]],
  );
  assert.deepEqual(
    scoped.populations[2]!.cells.map((item) => [item.criterionId, item.pass]),
    [
      ["beacon-blue", 1],
      ["beacon-blue", 2],
    ],
    "Another run keeps every answer of the criteria that the reassessment checked",
  );
  const set = comparisonSet(scoped.populations);
  const pair = set.pairs.find((item) => item.left === "source" && item.right === "assessment")!;
  assert.equal(pair.pairing, "same_retained_evidence");
  assert.notEqual(
    set.pairs.find((item) => item.left === "source" && item.right === "other")!.compatibility,
    "incompatible",
    "A run outside the reassessment compares on the same criteria",
  );
  const transitions = pairedAnswerTransitions(
    { id: "scoped", createdAt: "", ...scoped, ...set },
    "source",
    "assessment",
  )!;
  assert.equal(transitions.unchanged, 1);
});
