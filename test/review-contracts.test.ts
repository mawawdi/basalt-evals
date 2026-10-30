import type { RunOperationManifest } from "../packages/contracts/src/execution.js";
import assert from "node:assert/strict";
import test from "node:test";
import { criterionChoices } from "../packages/contracts/src/review-choices.js";

test("review choices embed criterion meaning without reversing quantifier scope", () => {
  assert.deepEqual(criterionChoices("- A Beacon object exists."), {
    satisfied: "A Beacon object exists",
    violated: "A Beacon object does not exist",
  });
  assert.deepEqual(criterionChoices("The Beacon looks blue."), {
    satisfied: "The Beacon looks blue",
    violated: "The Beacon does not look blue",
  });
  assert.equal(criterionChoices("The door is not open.").violated, "The door is open");
  assert.equal(
    criterionChoices("The door is open. A lamp is blue.").violated,
    "Not true: The door is open. A lamp is blue",
  );
  assert.equal(
    criterionChoices("The door is open; a lamp is blue.").violated,
    "Not true: The door is open; a lamp is blue",
  );
  assert.equal(criterionChoices("No Beacon exists.").violated, "Not true: No Beacon exists");
  assert.equal(
    criterionChoices("The door that is red is open.").violated,
    "Not true: The door that is red is open",
  );
  assert.equal(
    criterionChoices("Every player receives a reward.").violated,
    "Not true: Every player receives a reward",
  );
  assert.equal(
    criterionChoices("The door is open and passable.").violated,
    "Not true: The door is open and passable",
  );
});
import { decisionVerdict, reviewEvidenceBinding } from "../packages/operator/src/review-store.js";
import { reviewGateSatisfied } from "../packages/operator/src/evidence.js";
import type { EvidenceItem, ReviewCriterion } from "../packages/contracts/src/review.js";
import { operationReviewTreatments } from "../packages/operator/src/review-treatments.js";

import { fixtureSnapshots } from "./shared-api-fixture.js";
import { recommendedRequestSampling } from "../packages/model-client/src/sampling.js";
import { budgetSummary } from "../packages/operator/src/budget-summary.js";

test("grader treatments bind presentation, evidence condition and provider configuration, while request seeds remain decision-specific", () => {
  const base = {
    captureCellId: "capture",
    criterionIds: ["blue"],
    presentation: "still" as const,
    configuration: {
      modelId: "xiaomi/mimo-v2.6-flash",
      seed: 1,
      maxOutputTokens: 8192,
      sampling: recommendedRequestSampling(
        fixtureSnapshots.find((model) => model.id === "xiaomi/mimo-v2.6-flash")!,
      ),
    },
    substitution: null,
    sample: 1,
    grouping: "shared" as const,
  };
  // Each batch is its own sample group, except the two samples of "sampled".
  const batch = (id: string, change: object = {}) => ({
    ...base,
    id,
    sampleGroupId: id,
    ...change,
  });
  const manifest = {
    modelSnapshots: fixtureSnapshots,
    gradingCells: [{ id: "deterministic", method: "deterministic" }],
    judgmentBatches: [
      batch("first"),
      batch("seed", { configuration: { ...base.configuration, seed: 12 } }),
      batch("sequence", { presentation: "sequence" }),
      batch("output", { configuration: { ...base.configuration, maxOutputTokens: 4096 } }),
      batch("separate", { grouping: "per_criterion" }),
      batch("sampled-1", { sampleGroupId: "sampled" }),
      batch("sampled-2", { sampleGroupId: "sampled", sample: 2 }),
      batch("reasoning", {
        configuration: {
          ...base.configuration,
          reasoning: { kind: "token_budget", maxTokens: 2048 },
        },
      }),
      batch("effort", {
        configuration: { ...base.configuration, reasoning: { kind: "effort", effort: "medium" } },
      }),
      batch("blank", {
        substitution: { kind: "blank", donorCaptureCellId: null, region: null, labelRule: null },
      }),
      batch("sampling", {
        configuration: {
          ...base.configuration,
          sampling: { ...base.configuration.sampling, temperature: 0.5 },
        },
      }),
    ],
  } as unknown as RunOperationManifest;
  const catalog = operationReviewTreatments(manifest);
  assert.equal(catalog.treatments.length, 9);
  // The grouping and the number of judge samples are part of the identity and the label.
  assert.notEqual(catalog.byRecord.get("first")!.id, catalog.byRecord.get("separate")!.id);
  assert.match(catalog.byRecord.get("separate")!.label, /one criterion per request$/u);
  assert.notEqual(catalog.byRecord.get("first")!.id, catalog.byRecord.get("sampled")!.id);
  assert.match(catalog.byRecord.get("sampled")!.label, /2 judge samples$/u);
  assert.equal(catalog.byRecord.get("sampled-1"), undefined, "A review binds the sample group");
  assert.equal(catalog.byRecord.get("first")!.id, catalog.byRecord.get("seed")!.id);
  assert.notEqual(catalog.byRecord.get("first")!.id, catalog.byRecord.get("sequence")!.id);
  assert.notEqual(catalog.byRecord.get("first")!.id, catalog.byRecord.get("reasoning")!.id);
  assert.notEqual(catalog.byRecord.get("reasoning")!.id, catalog.byRecord.get("effort")!.id);
  assert.notEqual(
    catalog.byRecord.get("first")!.id,
    catalog.byRecord.get("sampling")!.id,
    "The sampling identity is part of the grader treatment",
  );
  assert.equal(catalog.byRecord.get("blank")!.evidenceCondition, "blank");
  assert.equal(catalog.byRecord.get("deterministic"), null);
  const changed = operationReviewTreatments({
    ...manifest,
    modelSnapshots: fixtureSnapshots.map((model) => ({
      ...model,
      revision: model.revision + "-changed",
    })),
  });
  assert.notEqual(catalog.byRecord.get("first")!.id, changed.byRecord.get("first")!.id);
});

test("unmeasured work does not manufacture a launch forecast", () => {
  assert.equal(budgetSummary().history, null);
  assert.match(budgetSummary().note, /no measured cost/);
});

const categorical: ReviewCriterion = {
  id: "blue",
  statement: "The object is blue.",
  required: true,
  anchors: null,
  scoreRange: null,
  minimumPassingScore: null,
};
test("categorical answers and abstentions remain distinct from authored numerical scores", () => {
  assert.equal(
    decisionVerdict(categorical, { kind: "categorical", value: "satisfied" }),
    "satisfied",
  );
  assert.equal(
    decisionVerdict(categorical, { kind: "categorical", value: "violated" }),
    "violated",
  );
  assert.equal(decisionVerdict(categorical, { kind: "abstain" }), "insufficient");
  assert.throws(
    () => decisionVerdict(categorical, { kind: "abstain", reason: "Unknown shape" } as never),
    /Invalid answer fields/,
  );
  assert.throws(() => decisionVerdict(categorical, { kind: "score", value: 1 }), /two answers/);
  const scaled = {
    ...categorical,
    anchors: [
      { score: 1, label: "Poor", description: "Poor" },
      { score: 3, label: "Clear", description: "Clear" },
    ],
  };
  assert.equal(decisionVerdict(scaled, { kind: "score", value: 3 }), "scored");
  assert.throws(
    () => decisionVerdict(scaled, { kind: "score", value: 2 }),
    /scale of this criterion/,
  );
  assert.equal(
    decisionVerdict({ ...scaled, minimumPassingScore: 3 }, { kind: "score", value: 1 }),
    "violated",
  );
  assert.equal(
    decisionVerdict({ ...scaled, minimumPassingScore: 3 }, { kind: "score", value: 3 }),
    "satisfied",
  );
  assert.equal(
    decisionVerdict(
      { ...scaled, scoreRange: { minimum: 1, maximum: 3, step: 0.5 } },
      { kind: "score", value: 2.5 },
    ),
    "scored",
  );
  assert.throws(
    () =>
      decisionVerdict(
        { ...scaled, scoreRange: { minimum: 1, maximum: 3, step: 0.5 } },
        { kind: "score", value: 5 },
      ),
    /scale of this criterion/,
  );
});
test("withheld review evidence requires the exact registered gate kind", () => {
  const item: EvidenceItem = {
    id: "item",
    subjectId: "subject",
    viewId: "view",
    partition: "withheld",
    releaseGateIds: ["selection"],
    plannedPasses: 3,
    rubricHash: "rubric",
    rubric: "Blue.",
    sources: [],
    criteria: [categorical],
    passes: [],
  };
  const gates = [{ id: "selection", kind: "selection" as const }];
  assert.equal(reviewGateSatisfied(item, gates, []), false);
  assert.equal(reviewGateSatisfied(item, gates, ["review:selection"]), false);
  assert.equal(reviewGateSatisfied(item, gates, ["selection:selection"]), true);
  assert.equal(reviewGateSatisfied(item, [], ["selection:selection"]), false);
  const pass = {
    id: "pass",
    number: 1,
    evidenceHash: "signed-runtime",
    observations: {},
    reviewRoute: null,
    images: [
      {
        id: "frame",
        file: "frame.png",
        hash: "original-frame",
        mediaType: "image/png",
        context: "after input",
        label: "After input",
        actor: "p1",
        startedAt: "2026-09-26T12:00:00.000Z",
        endedAt: "2026-09-26T12:00:00.100Z",
      },
    ],
  };
  const binding = reviewEvidenceBinding(item, pass, categorical);
  assert.equal(reviewEvidenceBinding(item, structuredClone(pass), categorical), binding);
  assert.equal(
    reviewEvidenceBinding(
      item,
      { ...pass, images: [{ ...pass.images[0]!, label: "Other words", actor: null }] },
      categorical,
    ),
    binding,
    "the words that the console shows for an image do not change the evidence binding",
  );
  assert.notEqual(
    reviewEvidenceBinding(
      item,
      { ...pass, images: [{ ...pass.images[0]!, hash: "changed-frame" }] },
      categorical,
    ),
    binding,
    "a new rendered sequence cannot reuse a label from unchanged runtime observations",
  );
  assert.notEqual(
    reviewEvidenceBinding(
      item,
      { ...pass, images: [{ ...pass.images[0]!, endedAt: "2026-09-26T12:00:03.000Z" }] },
      categorical,
    ),
    binding,
    "a changed acquisition interval changes the evidence binding",
  );
});
