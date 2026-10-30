import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { judgmentGroups } from "../packages/eval-authoring/src/rendered-selection.js";
import { qualitativeCriteria } from "../packages/eval-authoring/src/scoring.js";
import { operationReviewTreatments } from "../packages/operator/src/review-treatments.js";
import { operatorEvidence } from "../packages/operator/src/evidence-view.js";
import {
  freezeRegisteredEvalRun,
  prepareFrozenEvalRun,
} from "../packages/operator/src/run-plan.js";
import { savedBuild } from "./judge-fixture.js";

test("One criterion per request gives one request for each criterion and observation.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-judge-grouping-"));
  try {
    const { adapters, quote, revision } = await savedBuild(root, [
      "The Beacon code names the part.",
      "The Beacon code has no unused variables.",
    ]);
    const criteria = qualitativeCriteria(revision);
    assert.equal(criteria.length, 3);
    assert.deepEqual(
      judgmentGroups(criteria, "shared").map((group) => group.criteria.length),
      [1, 2],
      "Shared requests put the two criteria without images in one request",
    );
    assert.deepEqual(
      judgmentGroups(criteria, "per_criterion").map((group) => [
        group.images,
        group.criteria.map((item) => item.id),
      ]),
      [
        [true, ["beacon-blue"]],
        [false, ["source-1"]],
        [false, ["source-2"]],
      ],
    );
    const shared = await quote({ samples: 1, grouping: "shared" });
    const separate = await quote({ samples: 1, grouping: "per_criterion" });
    assert.equal(shared.quote.workload.judgmentBatches, 2);
    assert.equal(separate.quote.workload.judgmentBatches, 3);
    assert.equal(
      separate.quote.workload.criterionOutcomes,
      shared.quote.workload.criterionOutcomes,
      "Each criterion keeps one answer for each observation",
    );
    const freeze = (quoteId: string, operationId: string) =>
      prepareFrozenEvalRun({ root, quoteId, operationId, ceilingUsd: 1, adapters });
    const manifest = await freeze(separate.id, "run-per-criterion");
    assert.deepEqual(
      manifest.judgmentBatches.map((batch) => [batch.grouping, batch.criterionIds]),
      criteria.map((criterion) => ["per_criterion", [criterion.id]]),
    );
    assert.equal(manifest.captureCells.length, 1);
    // The grouping is part of the identity and the label of the judge.
    const [treatment] = operationReviewTreatments(manifest).treatments;
    assert.match(treatment!.label, / · one criterion per request$/u);
    assert.deepEqual(treatment!.judgeSettings, { samples: 1, grouping: "per_criterion" });
    const [sharedTreatment] = operationReviewTreatments(
      await freeze(shared.id, "run-shared"),
    ).treatments;
    assert.notEqual(sharedTreatment!.id, treatment!.id);
    assert.doesNotMatch(sharedTreatment!.label, /per request/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("The evidence view lists the criteria in the authored order, with the class of each judge check.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-evidence-order-"));
  try {
    const { adapters, quote } = await savedBuild(
      root,
      ["The Beacon code names the part.", "The Beacon code has no unused variables."],
      { sourcesFirst: true },
    );
    const saved = await quote({ samples: 1, grouping: "per_criterion" });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-evidence-order",
      ceilingUsd: 1,
      adapters,
    });
    assert.deepEqual(
      manifest.judgmentBatches.map((batch) => batch.criterionIds[0]),
      ["source-1", "source-2", "beacon-blue"],
      "The plan puts the criteria without images first",
    );
    const evidence = await operatorEvidence(root, manifest.id);
    // The plan order would put the criteria without images first. A code check has no class.
    assert.deepEqual(
      evidence.candidates[0]!.cells.map((cell) => [
        cell.criterionId,
        cell.method,
        cell.evidenceClass,
      ]),
      [
        ["beacon-exists", "deterministic", null],
        ["beacon-blue", "visual", "appearance"],
        ["source-1", "visual", null],
        ["source-2", "visual", null],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
