import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  compileCuratedRevision,
  CURATED_DRAFT_MARKER,
  readCuratedTaskFiles,
  type CuratedTaskFiles,
} from "../packages/eval-authoring/src/curated-revision.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import {
  preparationParity,
  type ParityRow,
} from "../packages/experiments/src/preparation-parity.js";
import { fixtureInput, fixturePrivate, fixturePublic } from "./shared-api-fixture.js";

/** The fixture task as curated task files, with a rubric and a map that the test wrote. */
function curatedFixture(): CuratedTaskFiles {
  const seed = neutralRojoSeed(fixturePublic.publicTask.title, fixturePublic.publicScene);
  const evaluator = structuredClone(fixturePrivate.privateEvaluator);
  // The task files keep their own statements. The compile binds them to the rubric.
  evaluator.deterministic[0]!.statement = "The pilot statement of the Beacon check.";
  evaluator.unscaled[0]!.statement = "The pilot statement of the colour check.";
  return {
    task: structuredClone(fixturePublic.publicTask),
    evaluator,
    development: structuredClone(fixturePublic.publicDevelopment),
    seed,
    rubric: fixtureInput.stages[0]!.rubric,
    criteriaMap: {
      schema: "basalt-evals/curated-criteria-map",
      status: "approved",
      note: "Written for the offline test.",
      criteria: [
        {
          authoredCriterionId: "criterion-1",
          text: "A Beacon object exists.",
          executableCriterionId: "beacon-exists",
          rationale: "The Studio name fact shows the Beacon.",
        },
        {
          authoredCriterionId: "criterion-2",
          text: "The Beacon looks blue.",
          executableCriterionId: "beacon-blue",
          rationale: "The judge reads the scene image.",
        },
      ],
      requiredCapabilities: ["state_observation", "static_capture"],
    },
  };
}

test("A curated plan compiles from task files, a person-written rubric and a map.", async () => {
  const curated = compileCuratedRevision(curatedFixture());
  assert.ok(curated.revision, JSON.stringify(curated.validation));
  const revision = curated.revision;
  assert.equal(revision.authored.rubric, fixtureInput.stages[0]!.rubric);
  assert.equal(revision.publicTask.prompt, fixtureInput.stages[0]!.prompt);
  // Each mapped criterion reads the exact rubric text, never the statement of the task files.
  assert.deepEqual(
    [
      revision.privateEvaluator.deterministic[0]!.statement,
      revision.privateEvaluator.unscaled[0]!.statement,
    ],
    revision.authored.criteria.map((criterion) => criterion.text),
  );
  assert.deepEqual(
    revision.criterionMappings.map((mapping) => [
      mapping.authoredCriterionId,
      mapping.method,
      mapping.executableCriterionId,
    ]),
    [
      ["criterion-1", "deterministic", "beacon-exists"],
      ["criterion-2", "unscaled", "beacon-blue"],
    ],
  );
  // The curated public part lets each preparation model write only the private stages.
  assert.deepEqual(curated.publicProposal, {
    publicScene: { parts: [] },
    stages: [
      {
        publicTask: fixturePublic.publicTask,
        publicDevelopment: fixturePublic.publicDevelopment,
      },
    ],
  });
  // The compile refuses a template that a person has not written or approved.
  assert.throws(
    () =>
      compileCuratedRevision({
        ...curatedFixture(),
        rubric: `${CURATED_DRAFT_MARKER}\n${fixtureInput.stages[0]!.rubric}`,
      }),
    /A person must write the rubric/u,
  );
  const draftMap = curatedFixture();
  (draftMap.criteriaMap as { status: string }).status = "draft";
  assert.throws(() => compileCuratedRevision(draftMap), /approve the criteria map/u);
  const wrongText = curatedFixture();
  (wrongText.criteriaMap as { criteria: Array<{ text: string }> }).criteria[0]!.text =
    "A Beacon part exists.";
  assert.throws(() => compileCuratedRevision(wrongText), /other text than the rubric/u);
  // Each pilot task has a draft for a person, so no pilot plan compiles before a person writes it.
  const tasks = await readdir(resolve("tasks/pilot"));
  assert.equal(tasks.length, 7);
  for (const task of tasks) {
    const files = await readCuratedTaskFiles(resolve("tasks/pilot", task));
    assert.ok(files.rubric.startsWith(CURATED_DRAFT_MARKER), task);
    assert.deepEqual((files.criteriaMap as { status: string }).status, "draft", task);
    assert.throws(() => compileCuratedRevision(files), /A person must write the rubric/u, task);
  }
});

test("Pairs use authored criteria, not evaluation identity.", () => {
  const row = (
    preparationModelId: string | null,
    revisionId: string,
    authoredCriterionId: string,
    sourceHash: string,
    answer: ParityRow["answer"],
  ): ParityRow => ({ preparationModelId, revisionId, authoredCriterionId, sourceHash, answer });
  // Two observations of each build under each plan. Each plan has its own revision.
  const twice = (...values: Parameters<typeof row>) => [row(...values), row(...values)];
  const curated = "c".repeat(64),
    first = "1".repeat(64),
    second = "2".repeat(64);
  const report = preparationParity([
    ...twice(null, curated, "criterion-1", "build-a", "met"),
    ...twice(null, curated, "criterion-1", "build-b", "not_met"),
    ...twice(null, curated, "criterion-2", "build-a", "met"),
    // The first model agrees on one pair and disagrees on one pair.
    ...twice("model/first", first, "criterion-1", "build-a", "met"),
    ...twice("model/first", first, "criterion-1", "build-b", "met"),
    // The second model has an insufficient answer, unstable observations and a cell that the
    // curated plan does not check.
    ...twice("model/second", second, "criterion-1", "build-a", "insufficient"),
    row("model/second", second, "criterion-1", "build-b", "met"),
    row("model/second", second, "criterion-1", "build-b", "not_met"),
    ...twice("model/second", second, "criterion-2", "build-a", "not_met"),
    ...twice("model/second", second, "criterion-3", "build-a", "met"),
  ]);
  assert.equal(report.curatedRevisionId, curated);
  assert.deepEqual(report.models, [
    {
      preparationModelId: "model/first",
      revisionId: first,
      pairs: 2,
      disagreement: { numerator: 1, denominator: 2 },
      insufficient: 0,
      unstable: 0,
      // The first model does not check criterion-2 of build-a.
      unmatched: 1,
    },
    {
      preparationModelId: "model/second",
      revisionId: second,
      pairs: 3,
      disagreement: { numerator: 1, denominator: 1 },
      insufficient: 1,
      unstable: 1,
      unmatched: 1,
    },
  ]);
  assert.deepEqual(
    report.noise.map((item) => [item.preparationModelId, item.unstable]),
    [
      [null, { numerator: 0, denominator: 3 }],
      ["model/first", { numerator: 0, denominator: 2 }],
      ["model/second", { numerator: 1, denominator: 3 }],
    ],
  );
  assert.throws(
    () => preparationParity([row("model/x", first, "criterion-1", "build-a", "met")]),
    /exactly one curated plan/u,
  );
});
