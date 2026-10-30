import assert from "node:assert/strict";
import test from "node:test";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import {
  cellAction,
  cellHashes,
  revisionHashes,
} from "../packages/eval-authoring/src/revision-delta.js";
import { fixtureInput, fixturePrivate, fixturePublic } from "./shared-api-fixture.js";

const draft = createEvalDraft(fixtureInput);
const { publicScene, ...publicProposal } = fixturePublic;
const compiled = compileEvalProposal(draft, 1, {
  ...publicProposal,
  ...fixturePrivate,
  seed: neutralRojoSeed(draft.title, publicScene),
});
assert.ok(compiled.revision, JSON.stringify(compiled.validation));
const base: EvalRevision = compiled.revision;

/** A copy of the fixture revision with one change. The hashes read only the content. */
function changed(change: (revision: EvalRevision) => void): EvalRevision {
  // A stored revision is JSON, so no part of it shares an object with another part.
  const revision = JSON.parse(JSON.stringify(base)) as EvalRevision;
  change(revision);
  return revision;
}

function decide(target: EvalRevision, criterionId: string, judgeChanged = false) {
  return cellAction(
    cellHashes(revisionHashes(base), criterionId),
    cellHashes(revisionHashes(target), criterionId),
    judgeChanged,
  );
}

test("Each cell gets its action from the hash that changed.", () => {
  assert.deepEqual(decide(base, "beacon-exists"), { action: "reuse", reason: "unchanged" });
  assert.deepEqual(decide(base, "beacon-blue"), { action: "reuse", reason: "unchanged" });
  assert.deepEqual(decide(base, "beacon-blue", true), {
    action: "judge_recheck",
    reason: "judge_changed",
  });
  const rule = changed((revision) => {
    const criterion = revision.privateEvaluator.deterministic[0]!;
    if (criterion.rule.kind !== "fact_equals") throw new Error("Unexpected fixture rule");
    criterion.rule.expected = "Lighthouse";
  });
  assert.deepEqual(decide(rule, "beacon-exists"), {
    action: "code_recheck",
    reason: "criterion_changed",
  });
  assert.deepEqual(decide(rule, "beacon-blue"), { action: "reuse", reason: "unchanged" });
  const evidence = changed((revision) => {
    revision.privateEvaluator.unscaled[0]!.evidence.facts = [];
  });
  assert.deepEqual(decide(evidence, "beacon-blue"), {
    action: "judge_recheck",
    reason: "criterion_changed",
  });
  const plan = changed((revision) => {
    revision.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
  });
  assert.deepEqual(decide(plan, "beacon-exists"), {
    action: "new_observation",
    reason: "studio_plan_changed",
  });
  const prompt = changed((revision) => {
    revision.publicTask.acceptance = ["Create a dark blue Beacon part."];
    revision.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
  });
  assert.deepEqual(
    decide(prompt, "beacon-blue"),
    { action: "new_build", reason: "public_content_changed" },
    "A new public contract needs a new build before any other work",
  );
});

test("An added criterion is checked, and a removed criterion has no target answer.", () => {
  const hashes = revisionHashes(base);
  assert.deepEqual(
    cellAction(cellHashes(hashes, null), cellHashes(hashes, "beacon-exists"), false),
    {
      action: "code_recheck",
      reason: "criterion_added",
    },
  );
  assert.deepEqual(cellAction(cellHashes(hashes, null), cellHashes(hashes, "beacon-blue"), false), {
    action: "judge_recheck",
    reason: "criterion_added",
  });
  assert.deepEqual(cellAction(cellHashes(hashes, "beacon-blue"), cellHashes(hashes, null), true), {
    action: "drop",
    reason: "criterion_removed",
  });
});

test("A judge change never checks a code check again.", () => {
  assert.deepEqual(decide(base, "beacon-exists", true), { action: "reuse", reason: "unchanged" });
  const hashes = revisionHashes(base);
  assert.deepEqual(Object.keys(hashes.criteria).sort(), ["beacon-blue", "beacon-exists"]);
  assert.equal(hashes.criteria["beacon-exists"]!.method, "code");
  assert.equal(hashes.criteria["beacon-blue"]!.method, "judge");
  assert.equal(hashes.rubricHash, base.rubricHash);
});
