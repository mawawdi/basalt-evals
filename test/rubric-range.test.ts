import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEvaluatorSpec,
  deriveVisualAcceptance,
  validRubricScore,
} from "../packages/contracts/src/index.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import { authoredScoreRange } from "../packages/eval-authoring/src/rubric-grading.js";
import { batchJudgmentRequest } from "../packages/eval-authoring/src/batch-judgment.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";
import { fixturePrivate } from "./shared-api-fixture.js";

test("authored numeric ranges retain continuous or explicitly stepped scores without inventing acceptance", () => {
  const scoreRange = authoredScoreRange("Scoring scale: 0 to 10. Continuous scores are allowed.");
  assert.deepEqual(scoreRange, { minimum: 0, maximum: 10, step: null });
  const criterion = {
    sequence: false,
    id: "appearance",
    statement: "The Beacon looks blue.",
    required: true,
    evidenceClass: "appearance" as const,
    polarity: "presence" as const,
    captureIds: ["scene"],
    anchors: [],
    scoreRange,
    minimumPassingScore: null,
  };
  const evaluator = {
    ...structuredClone(fixturePrivate.privateEvaluator),
    visual: [criterion],
    unscaled: [],
  };
  assertEvaluatorSpec(evaluator);
  assert.equal(validRubricScore(criterion, 7.25), true);
  assert.equal(validRubricScore(criterion, 11), false);
  assert.equal(
    deriveVisualAcceptance([criterion], [{ criterionId: criterion.id, score: 7.25 }]).outcome,
    "abstain",
  );
  const criteria = [{ ...criterion, authoredPassages: ["Scale: 0 to 10"], comparisons: [] }];
  const request = batchJudgmentRequest({
    configuration: {
      modelId: "synthetic",
      seed: 1,
      maxOutputTokens: 8192,
      sampling: catalogRecommendedSampling(null),
    },
    publicTask: "A blue Beacon",
    criteria,
    context: { actors: [], intervals: [] },
    images: [],
    observation: null,
    criterionEvidence: [pendingCriterionMaterial(criterion.id)],
  });
  assert.equal(request.tools[0]!.name, "submit_judgment_batch");
  const stepped = authoredScoreRange("Scale: 0 to 10, increments of 0.5.");
  assert.equal(validRubricScore({ ...criterion, scoreRange: stepped }, 7.25), false);
  assert.equal(validRubricScore({ ...criterion, scoreRange: stepped }, 7.5), true);
  assert.deepEqual(authoredScoreRange("Scale: 0 to 10. Integer scores only."), {
    minimum: 0,
    maximum: 10,
    step: 1,
  });
  assert.throws(() => authoredScoreRange("Scale: 0 to 10. Scale: 0 to 5."), /conflicting scope/);
  assert.equal(authoredScoreRange("Scoring weight: 0.25"), null);
});

test("a visual criterion without an authored scale names itself and the unscaled list", () => {
  const criterion = {
    sequence: false,
    id: "health-bar",
    statement: "The health bar becomes visibly shorter after damage.",
    required: true,
    evidenceClass: "appearance" as const,
    polarity: "presence" as const,
    captureIds: ["scene"],
    anchors: [],
    scoreRange: null,
    minimumPassingScore: null,
  };
  assert.throws(
    () =>
      assertEvaluatorSpec({
        ...structuredClone(fixturePrivate.privateEvaluator),
        visual: [criterion],
        unscaled: [],
      }),
    /criterion "health-bar" needs an authored score range.*put it in privateEvaluator\.unscaled/,
  );
});
