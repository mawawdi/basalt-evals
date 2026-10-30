import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  EvaluatorSpec,
  StudioSequenceView,
  UnscaledCriterion,
} from "../packages/contracts/src/index.js";
import {
  evidenceClassGaps,
  pendingCriterionMaterial,
} from "../packages/eval-authoring/src/criterion-material.js";
import {
  batchJudgmentRequest,
  judgedCriteria,
  type BatchCriterion,
} from "../packages/eval-authoring/src/batch-judgment.js";
import { scoringCriteria, transitionComparisons } from "../packages/eval-authoring/src/scoring.js";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { stableJson } from "../packages/contracts/src/index.js";
import { fixtureInput, fixturePrivate, fixturePublic } from "./shared-api-fixture.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";
import { judgmentGroups } from "../packages/eval-authoring/src/rendered-selection.js";

function unscaled(
  evidenceClass: UnscaledCriterion["evidenceClass"],
  evidence: Partial<UnscaledCriterion["evidence"]>,
): UnscaledCriterion {
  return {
    id: "claim",
    statement: "The door opens.",
    required: true,
    evidenceClass,
    polarity: "presence",
    evidence: {
      sourceSelection: null,
      facts: [],
      actions: [],
      captureIds: [],
      sequence: false,
      ...evidence,
    },
  };
}

test("the pre-call gate gives rendered frames only to appearance and runtime facts to other classes", async () => {
  const impact = JSON.parse(
    await readFile("studies/impact-vfx/task/evaluator.json", "utf8"),
  ) as EvaluatorSpec;
  const visual = (id: string) => impact.visual.find((criterion) => criterion.id === id)!;
  // A timing claim from four stills never reaches a model.
  assert.match(
    evidenceClassGaps(visual("timing")).join(" "),
    /A timing criterion needs a runtime-fact requirement/,
  );
  assert.match(evidenceClassGaps(visual("intent-coherence")).join(" "), /no evidence class/);
  assert.deepEqual(evidenceClassGaps(visual("readability")), []);
  const fact = { phaseId: "scene", factId: "door" };
  assert.deepEqual(evidenceClassGaps(unscaled("motion", { facts: [fact] })), []);
  assert.match(
    evidenceClassGaps(unscaled("motion", { facts: [fact], sequence: true })).join(" "),
    /frames at two per second cannot establish it/,
  );
  assert.match(
    evidenceClassGaps(unscaled("causality", {})).join(" "),
    /no signed runtime fact to judge/,
  );
  assert.match(
    evidenceClassGaps(unscaled("appearance", { facts: [fact] })).join(" "),
    /no rendered frames to judge/,
  );
  assert.deepEqual(evidenceClassGaps(unscaled("appearance", { captureIds: ["scene"] })), []);
  assert.deepEqual(
    evidenceClassGaps(
      unscaled(null, { sourceSelection: { kind: "all_luau_in_roots", roots: ["src"] } }),
    ),
    [],
  );
});

test("a gated criterion never enters the model request", () => {
  const criterion = (id: string, statement: string): BatchCriterion => ({
    id,
    statement,
    authoredPassages: [statement],
    required: true,
    evidenceClass: null,
    polarity: "presence" as const,
    comparisons: [],
    anchors: null,
    scoreRange: null,
    minimumPassingScore: null,
  });
  const criteria = [criterion("judged", "Judged claim."), criterion("gated", "Gated claim.")];
  const criterionEvidence = criteria.map((item) => pendingCriterionMaterial(item.id));
  criterionEvidence[1]!.unavailable = ["A timing criterion has no signed runtime fact to judge"];
  assert.deepEqual(
    judgedCriteria(criteria, criterionEvidence).map((item) => item.id),
    ["judged"],
  );
  const input = {
    configuration: {
      modelId: "synthetic",
      seed: 1,
      maxOutputTokens: 32768,
      sampling: catalogRecommendedSampling(null),
    },
    publicTask: "Build a door.",
    criteria,
    criterionEvidence,
    context: { actors: [], intervals: [] },
    images: [],
    observation: null,
  };
  const request = batchJudgmentRequest(input);
  assert.equal(request.messages[0]!.content.includes("Gated claim."), false);
  assert.equal(request.messages[0]!.content.includes("Judged claim."), true);
  assert.match(request.system, /Use images only for an appearance criterion/);
  const schema = JSON.stringify(request.tools[0]!.parameters);
  assert.equal(schema.includes('"gated"'), false);
  criterionEvidence[0]!.unavailable = ["Required observation was not acquired"];
  assert.throws(() => batchJudgmentRequest(input), /record insufficient without a call/);
  // Only an appearance criterion can carry before/after questions.
  const timed = { ...criterion("timed", "Timed claim."), evidenceClass: "timing" as const };
  assert.throws(
    () =>
      batchJudgmentRequest({
        ...input,
        criteria: [{ ...timed, comparisons: ["Transition open: what changed?"] }],
        criterionEvidence: [pendingCriterionMaterial("timed")],
      }),
    /preserve authored scales/,
  );
});

test("an appearance criterion tied to transitions asks the before/after comparison directly", () => {
  const view: StudioSequenceView = {
    scenarioId: "operate",
    camera: null,
    viewport: null,
    maximumGapMs: 1000,
    frameBudget: 64,
    requiredTransitions: [
      { id: "open", source: { kind: "action", stepId: "press" }, effectWindowMs: 1000, holdMs: 0 },
    ],
  };
  const [question] = transitionComparisons(view);
  for (const label of ["before:open", "effect:open", "after-hold:open", "horizon-end:open"])
    assert.ok(question!.includes(label), label);
  const rubric = "- The door visibly opens.";
  const revision = {
    authored: {
      rubric,
      builderPrompt: "Build a door.",
      criteria: [{ id: "criterion-1", contextNodeIds: [] }],
      document: [],
    },
    criterionMappings: ["door", "door-motion"].map((id) => ({
      authoredCriterionId: "criterion-1",
      authority: { source: "human_rubric", start: 0, end: rubric.length },
      executableCriterionId: id,
    })),
    privateEvaluator: {
      sequence: view,
      deterministic: [],
      codeQuality: [],
      visual: [],
      unscaled: [
        { ...unscaled("appearance", { sequence: true }), id: "door" },
        {
          ...unscaled("motion", { facts: [{ phaseId: "scene", factId: "door" }] }),
          id: "door-motion",
        },
      ],
    },
  } as unknown as EvalRevision;
  const [appearance, motion] = scoringCriteria(revision, ["door", "door-motion"]);
  assert.deepEqual(appearance!.comparisons, [question]);
  assert.equal(appearance!.evidenceClass, "appearance");
  assert.deepEqual(motion!.comparisons, []);
  assert.equal(motion!.evidenceClass, "motion");
});

test("criteria without rendered evidence get their own request with no images", () => {
  const fact = { phaseId: "scene", factId: "door" };
  const appearance = { ...unscaled("appearance", { captureIds: ["scene"] }), id: "looks" };
  const timing = { ...unscaled("timing", { facts: [fact] }), id: "timing" };
  const source = {
    ...unscaled(null, { sourceSelection: { kind: "all_luau_in_roots", roots: ["src"] } }),
    id: "source",
  };
  assert.deepEqual(
    judgmentGroups([timing, appearance, source], "shared").map((group) => [
      group.images,
      group.criteria.map((item) => item.id),
    ]),
    [
      [true, ["looks"]],
      [false, ["timing", "source"]],
    ],
  );
  assert.deepEqual(
    judgmentGroups([timing], "shared").map((group) => group.images),
    [false],
  );
});

test("The compiler refuses a changed polarity.", () => {
  const absent = createEvalDraft({
    ...fixtureInput,
    stages: [
      {
        ...fixtureInput.stages[0]!,
        rubric: fixtureInput.stages[0]!.rubric + "\n  - Polarity: absence",
      },
    ],
  });
  assert.equal(absent.stages[0]!.criteria[1]!.polarity, "absence");
  const { publicScene, ...publicProposal } = fixturePublic;
  const candidate = {
    ...publicProposal,
    ...structuredClone(fixturePrivate),
    seed: neutralRojoSeed(absent.title, publicScene),
  };
  const refused = compileEvalProposal(absent, 1, candidate);
  assert.equal(refused.revision, null);
  assert.match(
    stableJson(refused.validation.diagnostics),
    /Criterion beacon-blue must use the polarity that the rubric author set: absence\. A model cannot set or change it/,
  );
  // The submission resolver copies the polarity of the authored passage, and then it compiles.
  candidate.privateEvaluator.unscaled[0]!.polarity = "absence";
  assert.ok(compileEvalProposal(absent, 1, candidate).revision);
  // A score cannot measure a thing that must be absent, so the person clarifies the criterion.
  const scaled = createEvalDraft({
    ...fixtureInput,
    stages: [
      {
        ...fixtureInput.stages[0]!,
        rubric: fixtureInput.stages[0]!.rubric + "\n  - Polarity: absence\n  - Scale: 0 to 10",
      },
    ],
  });
  const clarification = compileEvalProposal(scaled, 1, candidate);
  assert.equal(clarification.validation.status, "needs_clarification");
  assert.match(
    stableJson(clarification.validation.diagnostics),
    /has the polarity absence and a score scale/,
  );
});
