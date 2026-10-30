import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import {
  planDetectorCalibration,
  planHarnessComparison,
  planMatchedRepair,
  plannedCounts,
  selectPresentation,
  selectRepairAttempt,
  PRESENTATIONS,
  type StudySource,
} from "../packages/experiments/src/protocols.js";

/** The bounds of the two registered harnesses that a protocol plan binds. */
const PLANNED_HARNESSES = {
  baseline: { id: "thin", maxTurns: 32, developmentRuns: 0 },
  treatment: { id: "production", maxTurns: 32, developmentRuns: 3 },
};

const views = [
  { id: "standard", partition: "development" as const },
  { id: "distant", partition: "development" as const },
  { id: "side", partition: "withheld" as const },
  { id: "compact", partition: "withheld" as const },
];
const sources: StudySource[] = ["gate", "shutter"].flatMap((evalId) =>
  (["generated", "generated", "generated", "working", "negative", "negative"] as const).map(
    (kind, index) => ({
      id: evalId + "-" + index,
      evalId,
      kind,
      sourceHash: hashJson([evalId, index]),
      targetCriterionIds: kind === "negative" ? ["requirement"] : [],
    }),
  ),
);

const baselines = {
  measurement: { changeThreshold: 16, onsetPixels: 1, regions: [], excluded: [], timing: [] },
  reference: null,
  rules: [],
  judgeControls: [],
  secondJudgeFamily: null,
};

test("detector plan freezes 144 captures, 504 batches, 672 calls and 48 three-pass review groups", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  assert.deepEqual(plannedCounts(plan), {
    builderTrials: 0,
    captureCells: 144,
    judgmentBatches: 504,
    graderCalls: 672,
    exemplarComparisonCalls: 0,
    expertItems: 48,
    publicDevelopmentRuns: 0,
  });
  assert.equal(plan.reviewGroups.filter((item) => item.partition === "development").length, 24);
  assert.ok(plan.reviewGroups.every((item) => item.captureIds.length === 3));
  assert.ok(
    plan.captures
      .filter((unit) => unit.partition === "withheld")
      .every((unit) => unit.requires.includes("presentation-selection")),
  );
  const synthetic = plan.judgments.filter((unit) => unit.substitution);
  assert.equal(synthetic.length, 72);
  for (const unit of synthetic) {
    const original = plan.captures.find((capture) => capture.id === unit.captureId)!;
    assert.equal(original.partition, "development");
    assert.equal(sources.find((source) => source.id === original.subjectId)?.kind, "working");
    if (unit.substitution!.kind === "unrelated") {
      const donor = plan.captures.find(
        (capture) => capture.id === unit.substitution!.donorCaptureId,
      )!;
      assert.notEqual(donor.evalId, original.evalId);
      assert.equal(donor.pass, original.pass);
    }
  }
  assert.equal(
    plan.id,
    planDetectorCalibration({ sources, views, baselines, exemplarComparison: null }).id,
  );
});

test("harness comparison pairs generation seeds and preserves repetition blocks and bounds", () => {
  const input = {
    harnesses: PLANNED_HARNESSES,
    builderModelIds: ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"],
    evalIds: ["checkpoint", "xp", "shutter", "gate"],
    orderSeed: 37,
    presentation: "sequence" as const,
    presentationSelectionHash: hashJson("development-selection"),
  };
  const plan = planHarnessComparison(input);
  assert.deepEqual(plannedCounts(plan), {
    builderTrials: 48,
    captureCells: 144,
    judgmentBatches: 144,
    graderCalls: 144,
    exemplarComparisonCalls: 0,
    expertItems: 48,
    publicDevelopmentRuns: 72,
  });
  assert.deepEqual(
    plan.builders.map((item) => item.repetition),
    [1, 2, 3].flatMap((value) => Array(16).fill(value)),
  );
  for (const builder of plan.builders) {
    assert.equal(builder.bounds.turns, 32);
    assert.equal("timeoutMs" in builder.bounds, false);
    const pair = plan.builders.find(
      (other) =>
        other.evalId === builder.evalId &&
        other.modelId === builder.modelId &&
        other.repetition === builder.repetition &&
        other.harness !== builder.harness,
    )!;
    assert.equal(pair.seed, builder.seed);
  }
  assert.equal(plan.id, planHarnessComparison(input).id);
  assert.notEqual(plan.id, planHarnessComparison({ ...input, orderSeed: 38 }).id);
});

test("matched repair freezes all six attempts per parent before any withheld captures", () => {
  const parents = sources.filter((source) => source.id.endsWith("-0"));
  const plan = planMatchedRepair({
    harness: PLANNED_HARNESSES.treatment,
    builderModelId: "openai/gpt-6-luna",
    parents,
    views,
    presentation: "sequence",
    seed: 55,
    presentationSelectionHash: hashJson("selection"),
    selectionAuthority: "expert",
  });
  assert.equal(plan.builders.length, 12);
  assert.equal(plan.captures.filter((unit) => unit.partition === "development").length, 72);
  assert.equal(plan.captures.filter((unit) => unit.partition === "withheld").length, 84);
  assert.ok(
    plan.captures
      .filter((unit) => unit.partition === "withheld")
      .every((unit) => unit.requires.includes("repair-selection")),
  );
  for (let i = 0; i < plan.builders.length; i += 2) {
    const left = plan.builders[i]!,
      right = plan.builders[i + 1]!;
    assert.equal(left.parentSourceId, right.parentSourceId);
    assert.equal(left.seed, right.seed);
    assert.equal(left.harness, "production");
    assert.deepEqual(left.bounds, right.bounds);
    assert.notEqual(left.assistance, right.assistance);
  }
  assert.throws(
    () =>
      planMatchedRepair({
        harness: PLANNED_HARNESSES.treatment,
        builderModelId: "openai/gpt-6-luna",
        parents: [{ ...parents[0]!, kind: "negative" }],
        views,
        presentation: "sequence",
        seed: 55,
        presentationSelectionHash: hashJson("selection"),
        selectionAuthority: "expert",
      }),
    /generated parent/,
  );
});

test("presentation selection enforces complete development controls before correctness and cost", () => {
  const candidates = PRESENTATIONS.map((id) => ({
    id,
    controlDecisions: [{ correct: true, complete: true }],
    missingEvidenceDecisions: [{ abstained: true, complete: true }],
    developmentCorrect: 10,
    knownCostUsd: 0.2,
  }));
  candidates[0]!.developmentCorrect = 100;
  candidates[0]!.controlDecisions[0]!.correct = false;
  candidates[1]!.knownCostUsd = 0.1;
  assert.deepEqual(selectPresentation(candidates), { id: "sequence", calibration: "eligible" });
  for (const candidate of candidates) candidate.missingEvidenceDecisions[0]!.complete = false;
  assert.deepEqual(selectPresentation(candidates), { id: "sequence", calibration: "provisional" });
});

test("repair selection retains unrunnable attempts and prioritizes violations, uncertainty, cost and identity", () => {
  const attempts = [
    {
      id: "unrunnable",
      runnable: false,
      requiredViolations: 0,
      insufficientJudgments: 0,
      knownCostUsd: 0,
    },
    { id: "a", runnable: true, requiredViolations: 1, insufficientJudgments: 0, knownCostUsd: 0.1 },
    {
      id: "b",
      runnable: true,
      requiredViolations: 0,
      insufficientJudgments: 1,
      knownCostUsd: null,
    },
    { id: "c", runnable: true, requiredViolations: 0, insufficientJudgments: 1, knownCostUsd: 0.2 },
  ];
  assert.equal(selectRepairAttempt(attempts), "c");
  assert.equal(attempts.length, 4);
  assert.equal(selectRepairAttempt(attempts.filter((item) => !item.runnable)), null);
});
