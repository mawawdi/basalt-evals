import assert from "node:assert/strict";
import test from "node:test";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import type { EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import {
  criterionTextHash,
  pairCriteria,
} from "../packages/eval-authoring/src/criterion-pairing.js";

/** Authored criteria from a rubric, each one checked by the executable IDs that it names. */
function revision(rubric: string, executables: Record<string, string[]>) {
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Create a blue Beacon part.", rubric: rubric }],
  });
  return {
    authored: {
      builderPrompt: draft.stages[0]!.prompt,
      rubric: draft.stages[0]!.rubric,
      criteria: draft.stages[0]!.criteria,
      document: draft.stages[0]!.document,
    },
    criterionMappings: Object.entries(executables).flatMap(([criterionId, ids]) =>
      ids.map((id) => ({
        authoredCriterionId: criterionId,
        authoredClauseIds: [],
        authority: { source: "human_rubric" as const, start: 0, end: 1 },
        method: "deterministic" as const,
        executableCriterionId: id,
        rationale: "Test mapping.",
      })),
    ),
  } satisfies Pick<EvalRevision, "authored" | "criterionMappings">;
}

test("Criteria with equal text pair even when a rubric edit renumbers them.", () => {
  const from = revision("- A Beacon exists.\n- The Beacon is blue.", {
    "criterion-1": ["beacon-exists"],
    "criterion-2": ["beacon-blue"],
  });
  const to = revision("- The Beacon glows.\n- A Beacon exists.\n- The Beacon is blue.", {
    "criterion-1": ["beacon-glows"],
    "criterion-2": ["beacon-exists"],
    "criterion-3": ["beacon-blue"],
  });
  const pairing = pairCriteria(from, to);
  assert.deepEqual(
    pairing.pairs.map((pair) => [pair.from.criterionId, pair.to.criterionId, pair.textChanged]),
    [
      ["criterion-1", "criterion-2", false],
      ["criterion-2", "criterion-3", false],
    ],
  );
  assert.deepEqual(pairing.added, [
    {
      criterionId: "criterion-1",
      textHash: criterionTextHash(to.authored.criteria[0]!),
      executableIds: ["beacon-glows"],
    },
  ]);
  assert.deepEqual(pairing.removed, []);
});

test("A criterion that keeps its ID with new text pairs as changed text.", () => {
  const from = revision("- A Beacon exists.\n- The Beacon is blue.", {
    "criterion-1": ["beacon-exists"],
    "criterion-2": ["beacon-blue"],
  });
  const to = revision("- A Beacon exists.\n- The Beacon is dark blue.", {
    "criterion-1": ["beacon-exists"],
    "criterion-2": ["beacon-blue"],
  });
  const [unchanged, changed] = pairCriteria(from, to).pairs;
  assert.equal(unchanged!.textChanged, false);
  assert.deepEqual(changed!.executables, [{ from: "beacon-blue", to: "beacon-blue" }]);
  assert.equal(changed!.textChanged, true);
  assert.notEqual(changed!.from.textHash, changed!.to.textHash);
});

test("Unpaired criteria are added or removed with the executable criteria of each side.", () => {
  const from = revision("- A Beacon exists.\n- The Beacon is blue.\n- The Beacon spins.", {
    "criterion-1": ["beacon-exists"],
    "criterion-2": ["beacon-blue"],
    "criterion-3": ["beacon-spins", "beacon-speed"],
  });
  const to = revision("- A Beacon exists.", { "criterion-1": ["beacon-exists"] });
  const pairing = pairCriteria(from, to);
  assert.equal(pairing.pairs.length, 1);
  assert.deepEqual(pairing.added, []);
  assert.deepEqual(
    pairing.removed.map((item) => [item.criterionId, item.executableIds]),
    [
      ["criterion-2", ["beacon-blue"]],
      ["criterion-3", ["beacon-spins", "beacon-speed"]],
    ],
  );
});

test("Equal executable IDs pair first, and a renamed check pairs with the check it replaced.", () => {
  const from = revision("- A Beacon exists and is blue.", {
    "criterion-1": ["beacon-exists", "beacon-blue", "beacon-old"],
  });
  const to = revision("- A Beacon exists and is blue.", {
    "criterion-1": ["beacon-color", "beacon-exists"],
  });
  assert.deepEqual(pairCriteria(from, to).pairs[0]!.executables, [
    { from: "beacon-exists", to: "beacon-exists" },
    { from: "beacon-blue", to: "beacon-color" },
    { from: "beacon-old", to: null },
  ]);
});

test("Equal texts prefer the criterion with the same ID.", () => {
  const from = revision("- A Beacon exists.\n- A Beacon exists.", {});
  const to = revision("- A Beacon exists.\n- A Beacon exists.", {});
  assert.deepEqual(
    pairCriteria(from, to).pairs.map((pair) => [pair.from.criterionId, pair.to.criterionId]),
    [
      ["criterion-1", "criterion-1"],
      ["criterion-2", "criterion-2"],
    ],
  );
});
