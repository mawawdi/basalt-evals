import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveVisualAcceptance, type VisualCriterion } from "../packages/contracts/src/index.js";
import { loadRegisteredTask } from "../packages/task-registry/src/index.js";

test("required-score aggregation distinguishes unknown from failure and rejects malformed coverage", async () => {
  const task = await loadRegisteredTask(process.cwd(), "studies/impact-vfx/task");
  const rubric: VisualCriterion[] = structuredClone(task.evaluator.visual);
  const decisions = rubric.map((c) => ({ criterionId: c.id, score: 4 as number | null }));
  assert.deepEqual(deriveVisualAcceptance(rubric, decisions), {
    source: "required_criterion_scores",
    outcome: "accept",
  });
  decisions[0]!.score = 0;
  assert.equal(deriveVisualAcceptance(rubric, decisions).outcome, "reject");
  decisions[1]!.score = null;
  assert.equal(deriveVisualAcceptance(rubric, decisions).outcome, "abstain");
  assert.equal(
    deriveVisualAcceptance([...rubric].reverse(), [...decisions].reverse()).outcome,
    "abstain",
  );
  rubric[1]!.required = false;
  assert.equal(deriveVisualAcceptance(rubric, decisions).outcome, "reject");
  decisions[0]!.score = 4;
  assert.equal(deriveVisualAcceptance(rubric, decisions).outcome, "accept");
  assert.throws(() => deriveVisualAcceptance(rubric, decisions.slice(1)), /coverage/);
  assert.throws(() => deriveVisualAcceptance(rubric, [...decisions, decisions[0]!]), /coverage/);
  assert.throws(
    () =>
      deriveVisualAcceptance(
        rubric,
        decisions.map((c) => ({ ...c, score: 8 })),
      ),
    /anchors/,
  );
});

test("saved blank response demonstrates the aggregation fix without rewriting the original result", async () => {
  const task = await loadRegisteredTask(process.cwd(), "studies/impact-vfx/task");
  const fixture = JSON.parse(await readFile("test/fixtures/visual-pilot/blank.json", "utf8"));
  const before = JSON.stringify(fixture);
  assert.equal(fixture.value.acceptance.outcome, "reject");
  assert.ok(fixture.value.criteria.every((c: { score: unknown }) => c.score === null));
  assert.equal(
    deriveVisualAcceptance(task.evaluator.visual, fixture.value.criteria).outcome,
    "abstain",
  );
  assert.equal(JSON.stringify(fixture), before);
});

test("aggregation does not disguise the saved overlay sufficiency failure as a repaired model judgment", async () => {
  const task = await loadRegisteredTask(process.cwd(), "studies/impact-vfx/task");
  const fixture = JSON.parse(
    await readFile("test/fixtures/visual-pilot/overlay-only.json", "utf8"),
  );
  assert.ok(fixture.value.criteria.every((c: { score: unknown }) => c.score === 0));
  assert.equal(
    deriveVisualAcceptance(task.evaluator.visual, fixture.value.criteria).outcome,
    "reject",
  );
  // Only a new, independently recorded inference can show whether the approved
  // evidence-sufficiency clarification changes those criterion decisions.
});
