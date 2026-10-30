import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  assertEvidenceSubstitution,
  type AuthoredRegion,
  type EvidenceSubstitution,
} from "../packages/contracts/src/execution.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import {
  assessmentConditions,
  sensitivityConditions,
} from "../packages/operator/src/assessment.js";
import { applyEvidenceControl } from "../packages/operator/src/evidence-controls.js";
import { framePhases } from "../packages/operator/src/judgment-material.js";
import {
  assessmentUnits,
  controlSubstitution,
  sensitivityPlan,
} from "../packages/operator/src/sensitivity-plan.js";
import type { RunOperationManifest } from "../packages/contracts/src/execution.js";
import type { EvidenceCondition, SensitivityPlan } from "../packages/contracts/src/assessments.js";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";

/** Frames of two actors: three of `alice`, then one phase capture. */
function material(actors = ["alice", "alice", "alice", "presentation:spawn"]) {
  return {
    context: {
      actors: [...new Set(actors)],
      intervals: actors.map((actor, index) => ({
        frameId: `frame-${index + 1}`,
        actor,
        startMs: index * 500,
        endMs: index * 500 + 100,
      })),
      acquisition: [{ captureId: "spawn" }],
      samplingIntervalMs: 500 as number | null,
      publicSeed: "seed",
    },
    images: actors.map((actor, index) => ({
      mediaType: "image/png" as const,
      hash: `frame-${index}`,
      dataBase64: Buffer.from(`frame-${index}`).toString("base64"),
      label: `Image ${index + 1}: frame-${index + 1}; ${actor}.`,
    })),
    criterionEvidence: [
      {
        ...pendingCriterionMaterial("required"),
        sealedSources: [{ path: "src/server/a.luau", hash: "a".repeat(64), text: "return 1" }],
      },
    ],
  };
}
const none = { donor: null, phases: null, fill: null };
const control = (
  kind: EvidenceSubstitution["kind"],
  extra: Partial<EvidenceSubstitution> = {},
): EvidenceSubstitution => ({
  kind,
  donorCaptureCellId: null,
  region: null,
  labelRule: null,
  ...extra,
});
const hashes = (value: { images: Array<{ hash: string }> }) =>
  value.images.map((item) => item.hash);
const labels = (value: { images: Array<{ label: string }> }) =>
  value.images.map((item) => item.label);
const keep = { labelRule: "labels_keep_slots" as const };
const follow = { labelRule: "labels_follow_images" as const };

test("dependence controls remove frames, then facts and source, in steps", () => {
  const primary = material();
  const blank = applyEvidenceControl(primary, control("blank"), none, "unit");
  assert.equal(blank.images.length, 4);
  assert.equal(new Set(hashes(blank)).size, 1);
  assert.ok(!hashes(primary).includes(blank.images[0]!.hash));
  assert.deepEqual(blank.context, primary.context, "Blank frames keep their timestamped slots");
  assert.deepEqual(labels(blank), labels(primary), "Only the pixels change");
  assert.equal(blank.criterionEvidence, primary.criterionEvidence);

  const factsAndSource = applyEvidenceControl(primary, control("facts_and_source"), none, "unit");
  assert.deepEqual(factsAndSource.images, []);
  assert.deepEqual(factsAndSource.context, {
    actors: [],
    intervals: [],
    acquisition: [],
    samplingIntervalMs: null,
    publicSeed: "seed",
  });
  assert.equal(factsAndSource.criterionEvidence, primary.criterionEvidence);

  const textOnly = applyEvidenceControl(primary, control("text_only"), none, "unit");
  assert.deepEqual(textOnly.images, []);
  assert.deepEqual(textOnly.criterionEvidence, [pendingCriterionMaterial("required")]);
  assert.ok(primary.criterionEvidence[0]!.sealedSources.length, "The source stays unchanged");
  // The evidence class gate stays, so the same criteria reach the judge.
  const gate = "An appearance criterion has no rendered frames to judge";
  const gated = applyEvidenceControl(
    {
      ...primary,
      criterionEvidence: [{ ...primary.criterionEvidence[0]!, unavailable: [gate] }],
    },
    control("text_only"),
    none,
    "unit",
  );
  assert.deepEqual(gated.criterionEvidence, [
    { ...pendingCriterionMaterial("required"), unavailable: [gate] },
  ]);
});

test("donor controls show the donor frames, and only the note control shows its source", () => {
  const primary = material();
  const donor = {
    ...material(["bob", "bob", "bob", "presentation:spawn"]),
    images: material().images.map((image, index) => ({
      ...image,
      hash: `donor-${index}`,
      label: `Image ${index + 1}: donor-${index + 1}.`,
    })),
    criterionEvidence: [pendingCriterionMaterial("required")],
  };
  const followed = applyEvidenceControl(
    primary,
    control("donor_swap", { donorCaptureCellId: "donor", ...follow }),
    { ...none, donor },
    "unit",
  );
  assert.deepEqual(hashes(followed), hashes(donor));
  assert.deepEqual(labels(followed), labels(donor), "The donor labels move with the donor images");
  assert.equal(followed.context, donor.context);
  assert.equal(followed.criterionEvidence, primary.criterionEvidence);
  const kept = applyEvidenceControl(
    primary,
    control("donor_swap", { donorCaptureCellId: "donor", ...keep }),
    { ...none, donor },
    "unit",
  );
  assert.deepEqual(hashes(kept), hashes(donor));
  assert.deepEqual(labels(kept), labels(primary), "The target labels stay in their slots");
  assert.equal(kept.context, primary.context);
  assert.throws(
    () =>
      applyEvidenceControl(
        primary,
        control("donor_swap", { donorCaptureCellId: "donor", ...keep }),
        { ...none, donor: { ...donor, images: donor.images.slice(1) } },
        "unit",
      ),
    /another count of frames/,
  );
  const unrelated = applyEvidenceControl(
    primary,
    control("unrelated", { donorCaptureCellId: "donor" }),
    { ...none, donor },
    "unit",
  );
  assert.deepEqual(labels(unrelated), labels(donor));
  const twin = applyEvidenceControl(
    primary,
    control("canary", { donorCaptureCellId: "twin" }),
    { ...none, donor },
    "unit",
  );
  assert.equal(twin, donor, "The twin build is judged as recorded");
  assert.throws(
    () => applyEvidenceControl(primary, control("donor_swap", keep), none, "unit"),
    /donor capture/,
  );
});

test("one label rule governs every order and content control", () => {
  const primary = material();
  for (const kind of ["shuffled", "reversed", "repeated_frame", "donor_swap"] as const)
    assert.throws(
      () => applyEvidenceControl(primary, control(kind), none, "unit"),
      /label rule/,
      `${kind} needs a preregistered rule`,
    );
  const shuffled = applyEvidenceControl(primary, control("shuffled", keep), none, "unit");
  assert.deepEqual(hashes(shuffled).sort(), hashes(primary).sort());
  assert.ok(shuffled.images.every((image, index) => image.hash !== primary.images[index]!.hash));
  assert.deepEqual(shuffled.context, primary.context, "Intervals stay in their slots");
  assert.deepEqual(labels(shuffled), labels(primary), "Labels stay in their slots");
  assert.deepEqual(
    applyEvidenceControl(primary, control("shuffled", keep), none, "unit"),
    shuffled,
    "A seed gives the same order",
  );
  const moved = applyEvidenceControl(primary, control("shuffled", follow), none, "unit");
  assert.deepEqual(hashes(moved), hashes(shuffled), "The rule changes labels, not the order");
  moved.images.forEach((image, slot) => {
    const source = primary.images.find((item) => item.hash === image.hash)!;
    assert.equal(image.label, `Image ${slot + 1}: ${source.label.split(": ").slice(1).join(": ")}`);
  });

  const reversed = applyEvidenceControl(primary, control("reversed", follow), none, "unit");
  assert.deepEqual(hashes(reversed), [...hashes(primary)].reverse());
  assert.deepEqual(labels(reversed), [
    "Image 1: frame-4; presentation:spawn.",
    "Image 2: frame-3; alice.",
    "Image 3: frame-2; alice.",
    "Image 4: frame-1; alice.",
  ]);
  assert.deepEqual(
    reversed.context.intervals,
    [...primary.context.intervals].reverse(),
    "The whole interval moves with its image",
  );
  const reversedInPlace = applyEvidenceControl(primary, control("reversed", keep), none, "unit");
  assert.deepEqual(labels(reversedInPlace), labels(primary));

  const repeated = applyEvidenceControl(primary, control("repeated_frame", keep), none, "unit");
  assert.deepEqual(hashes(repeated), ["frame-2", "frame-2", "frame-2", "frame-3"]);
  assert.deepEqual(repeated.context, primary.context);
  assert.deepEqual(labels(repeated), labels(primary));
  const repeatedLabels = applyEvidenceControl(
    primary,
    control("repeated_frame", follow),
    none,
    "unit",
  );
  assert.deepEqual(labels(repeatedLabels), [
    "Image 1: frame-3; alice.",
    "Image 2: frame-3; alice.",
    "Image 3: frame-3; alice.",
    "Image 4: frame-4; presentation:spawn.",
  ]);
  assert.throws(
    () =>
      applyEvidenceControl(
        material(["presentation:a", "presentation:b"]),
        control("repeated_frame", keep),
        none,
        "unit",
      ),
    /No view has two/,
  );
  assert.throws(
    () =>
      applyEvidenceControl(
        {
          ...primary,
          images: primary.images.map((image) => ({ ...image, label: "no position" })),
        },
        control("reversed", follow),
        none,
        "unit",
      ),
    /state its position/,
  );
});

test("a shuffle within phases keeps each frame between the same two actions", () => {
  const primary = material(["alice", "alice", "alice", "alice", "presentation:spawn"]);
  const phases = framePhases(primary.context.intervals, {
    acquisition: { startedAt: "2026-01-01T00:00:00.000Z" },
    anchors: [Date.parse("2026-01-01T00:00:00.900Z")],
  });
  assert.deepEqual(phases, ["alice#0", "alice#0", "alice#1", "alice#1", "presentation:spawn"]);
  const shuffled = applyEvidenceControl(
    primary,
    control("phase_shuffled", { labelRule: "labels_keep_slots" }),
    { ...none, phases },
    "unit",
  );
  assert.deepEqual(hashes(shuffled), ["frame-1", "frame-0", "frame-3", "frame-2", "frame-4"]);
  assert.throws(
    () =>
      applyEvidenceControl(
        primary,
        control("phase_shuffled", { labelRule: "labels_keep_slots" }),
        { ...none, phases: ["a", "b", "c", "d", "e"] },
        "unit",
      ),
    /No phase has two/,
  );
  assert.throws(() => framePhases(primary.context.intervals, null), /recorded sequence/);
});

// The control requests depend on these phases. The anchors keep the fraction of the clock
// offset: Studio time plus the offset, as the control material computes them.
test("phases compare each frame with anchors that keep the fraction of the clock offset", () => {
  const anchors = ["2026-01-01T00:00:00.488Z", "2026-01-01T00:00:00.988Z"].map(
    (at) => Date.parse(at) + 12.345,
  );
  const phases = framePhases(material().context.intervals, {
    acquisition: { startedAt: "2026-01-01T00:00:00.000Z" },
    anchors,
  });
  // The anchors are at 500.345 ms and 1000.345 ms. The frames at 500 ms and 1000 ms start
  // before them. With whole-ms anchors, each of these frames would move to the next phase.
  assert.deepEqual(phases, ["alice#0", "alice#0", "alice#1", "presentation:spawn"]);
});

function png(width: number, height: number, value: number) {
  const image = new PNG({ width, height });
  image.data.fill(value);
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
  const bytes = PNG.sync.write(image);
  return {
    mediaType: "image/png" as const,
    hash: contentHash(bytes),
    dataBase64: bytes.toString("base64"),
  };
}
const pixel = (image: { dataBase64: string }, x: number, y: number) => {
  const decoded = PNG.sync.read(Buffer.from(image.dataBase64, "base64"));
  return [...decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)];
};

test("region controls change only the authored rectangle of the authored view", () => {
  const primary = {
    ...material(["alice", "presentation:spawn"]),
    images: [
      { ...png(8, 6, 200), label: "Image 1: frame-1; alice." },
      { ...png(8, 6, 120), label: "Image 2: frame-2; presentation:spawn." },
    ],
  };
  const region: AuthoredRegion = {
    criterionId: "required",
    view: { kind: "actor", actor: "alice" },
    decisive: { x: 1, y: 1, width: 2, height: 2 },
    sham: { x: 5, y: 3, width: 2, height: 2 },
    fillCaptureId: null,
  };
  const fill = png(8, 6, 40);
  const removed = applyEvidenceControl(
    primary,
    control("region_removed", { region }),
    { ...none, fill },
    "unit",
  );
  assert.deepEqual(pixel(removed.images[0]!, 1, 1), [40, 40, 40, 255], "Pre-action pixels fill it");
  assert.deepEqual(pixel(removed.images[0]!, 5, 3), [200, 200, 200, 255]);
  assert.equal(removed.images[1], primary.images[1], "Another view stays the same");
  const sham = applyEvidenceControl(
    primary,
    control("region_sham", { region }),
    { ...none, fill },
    "unit",
  );
  assert.deepEqual(pixel(sham.images[0]!, 1, 1), [200, 200, 200, 255]);
  assert.deepEqual(pixel(sham.images[0]!, 6, 4), [40, 40, 40, 255]);
  const black = applyEvidenceControl(primary, control("region_black", { region }), none, "unit");
  assert.deepEqual(pixel(black.images[0]!, 2, 2), [0, 0, 0, 255]);
  assert.throws(
    () => applyEvidenceControl(primary, control("region_removed", { region }), none, "unit"),
    /before the action/,
  );
  assert.throws(
    () =>
      applyEvidenceControl(
        primary,
        control("region_removed", { region: { ...region, view: { kind: "actor", actor: "bob" } } }),
        { ...none, fill },
        "unit",
      ),
    /no rendered frame/,
  );
});

test("each control kind carries exactly its own fields", () => {
  const region: AuthoredRegion = {
    criterionId: "required",
    view: { kind: "capture", captureId: "impact" },
    decisive: { x: 0, y: 0, width: 4, height: 4 },
    sham: { x: 4, y: 0, width: 4, height: 4 },
    fillCaptureId: "before",
  };
  for (const valid of [
    control("blank"),
    control("donor_swap", { donorCaptureCellId: "donor", ...keep }),
    control("unrelated", { donorCaptureCellId: "donor" }),
    control("region_sham", { region }),
    control("phase_shuffled", { labelRule: "labels_follow_images" }),
  ])
    assertEvidenceSubstitution(valid);
  for (const invalid of [
    control("donor_swap", keep),
    control("donor_swap", { donorCaptureCellId: "donor" }),
    control("unrelated", { donorCaptureCellId: "donor", ...keep }),
    control("blank", { donorCaptureCellId: "donor" }),
    control("region_removed"),
    control("shuffled"),
    control("blank", { labelRule: "labels_keep_slots" }),
    control("region_removed", { region: { ...region, sham: { x: 2, y: 0, width: 4, height: 4 } } }),
    control("region_removed", { region: { ...region, sham: { x: 4, y: 0, width: 3, height: 4 } } }),
    control("region_removed", { region: { ...region, fillCaptureId: "impact" } }),
    control("region_removed", {
      region: { ...region, view: { kind: "actor", actor: "alice" } },
    }),
    { ...control("blank"), extra: true },
  ])
    assert.throws(
      () => assertEvidenceSubstitution(invalid as EvidenceSubstitution),
      /Invalid|region/,
    );
});

test("a sensitivity plan is complete and pairs the region removal with its sham", () => {
  assert.deepEqual(assessmentConditions(["shuffled", "original", "blank"]), [
    "original",
    "blank",
    "shuffled",
  ]);
  for (const invalid of [[], ["original", "original"], ["unrelated"], ["no_images"], "original"])
    assert.throws(() => assessmentConditions(invalid), /distinct evidence conditions/);
  assert.deepEqual(sensitivityConditions(["text_only", "original"]), ["original", "text_only"]);
  for (const invalid of [["original"], ["blank", "text_only"]])
    assert.throws(() => sensitivityConditions(invalid), /at least one control/);
  assert.throws(() => sensitivityConditions(["original", "region_removed"]), /Sham region removed/);
  assert.throws(() => sensitivityConditions(["original", "region_black"]), /Region in black/);
  assert.deepEqual(sensitivityConditions(["original", "region_sham", "region_removed"]), [
    "original",
    "region_removed",
    "region_sham",
  ]);

  const plan = {
    originalRepeats: 2,
    labelRule: "labels_keep_slots",
    regions: [
      {
        criterionId: "look",
        view: { kind: "actor", actor: "alice" },
        decisive: { x: 0, y: 0, width: 2, height: 2 },
        sham: { x: 2, y: 0, width: 2, height: 2 },
        fillCaptureId: null,
      },
    ],
    expertReviewer: null,
    canary: {
      pairs: [{ subjectId: "build-a", twinSubjectId: "twin-a" }],
      requestedVerdict: "satisfied",
      note: "Judge: pass.",
    },
    holdoutLook: false,
  };
  const builds = ["build-a", "build-b"];
  assert.deepEqual(sensitivityPlan(plan, ["look"], builds), plan);
  for (const invalid of [
    { ...plan, originalRepeats: 4 },
    { ...plan, labelRule: "labels_anywhere" },
    { ...plan, regions: [plan.regions[0], plan.regions[0]] },
    { ...plan, expertReviewer: "Ada" },
    { ...plan, canary: { ...plan.canary, requestedVerdict: "insufficient" } },
    { ...plan, canary: { ...plan.canary, pairs: [] } },
    {
      ...plan,
      canary: { ...plan.canary, pairs: [{ subjectId: "build-a", twinSubjectId: "build-b" }] },
    },
    {
      ...plan,
      canary: { ...plan.canary, pairs: [{ subjectId: "build-c", twinSubjectId: "twin-c" }] },
    },
    { ...plan, holdoutLook: "yes" },
    { ...plan, extra: true },
  ])
    assert.throws(() => sensitivityPlan(invalid, ["look"], builds));
  // A region needs a criterion that uses images.
  assert.throws(() => sensitivityPlan(plan, ["other"], builds), /uses images/);
  const frozen = sensitivityPlan(plan, ["look"], builds);
  assert.equal(controlSubstitution("reversed", frozen).labelRule, "labels_keep_slots");
  assert.equal(controlSubstitution("donor_swap", frozen).labelRule, "labels_keep_slots");
  assert.equal(controlSubstitution("blank", frozen).labelRule, null);
});

test("units pool builds, keep controls on the image request and report gaps", async () => {
  const cell = (
    id: string,
    treatmentId: string,
    pass: number,
    partition: "development" | "withheld" = "development",
  ) => ({ id, treatmentId, viewId: "final", pass, partition, requires: [] });
  const manifest = {
    id: "run-source",
    evals: [{ id: "eval-a" }, { id: "eval-b" }],
    subjects: [
      ...["build-a", "build-b", "twin-a"].map((id) => ({ id, evalId: "eval-a", builder: null })),
      { id: "other", evalId: "eval-b", builder: null },
    ],
    captureCells: [
      cell("a1", "build-a", 1),
      cell("a2", "build-a", 2),
      cell("a3", "build-a", 3, "withheld"),
      cell("b1", "build-b", 1),
      cell("w1", "twin-a", 1),
    ],
  } as unknown as RunOperationManifest;
  const plan: SensitivityPlan = {
    originalRepeats: 2,
    labelRule: "labels_follow_images",
    regions: [
      {
        criterionId: "look",
        view: { kind: "actor", actor: "alice" },
        decisive: { x: 0, y: 0, width: 2, height: 2 },
        sham: { x: 2, y: 0, width: 2, height: 2 },
        fillCaptureId: null,
      },
    ],
    expertReviewer: null,
    canary: {
      pairs: [{ subjectId: "build-a", twinSubjectId: "twin-a" }],
      requestedVerdict: "satisfied",
      note: "Judge: pass.",
    },
    holdoutLook: false,
  };
  const input = {
    root: ".",
    manifest,
    subjectIds: ["build-a", "build-b"],
    presentation: "still" as const,
    conditions: [
      "original",
      "region_removed",
      "region_sham",
      "donor_swap",
      "reversed",
      "canary",
    ] as EvidenceCondition[],
    plan,
    judgeSettings: DEFAULT_JUDGE_SETTINGS,
    groups: [
      { images: true, criterionIds: ["look", "shape"] },
      { images: false, criterionIds: ["code"] },
    ],
  };
  const { units, unavailable, excluded } = await assessmentUnits(input);
  assert.deepEqual(excluded, ["a3"], "A withheld observation needs an authorized look");
  assert.deepEqual(
    units.map((unit) => [
      unit.subjectId,
      unit.captureId,
      unit.condition,
      unit.repeat,
      unit.criterionIds.join(),
      unit.batch.substitution?.donorCaptureCellId ?? null,
    ]),
    [
      ["build-a", "a1", "original", 1, "look,shape", null],
      ["build-a", "a1", "original", 2, "look,shape", null],
      ["build-a", "a1", "original", 1, "code", null],
      ["build-a", "a1", "original", 2, "code", null],
      ["build-a", "a1", "region_removed", 1, "look", null],
      ["build-a", "a1", "region_sham", 1, "look", null],
      ["build-a", "a1", "reversed", 1, "look,shape", null],
      ["build-a", "a1", "canary", 1, "look,shape", "w1"],
      ["build-a", "a2", "original", 1, "look,shape", null],
      ["build-a", "a2", "original", 2, "look,shape", null],
      ["build-a", "a2", "original", 1, "code", null],
      ["build-a", "a2", "original", 2, "code", null],
      ["build-a", "a2", "region_removed", 1, "look", null],
      ["build-a", "a2", "region_sham", 1, "look", null],
      ["build-a", "a2", "reversed", 1, "look,shape", null],
      ["build-b", "b1", "original", 1, "look,shape", null],
      ["build-b", "b1", "original", 2, "look,shape", null],
      ["build-b", "b1", "original", 1, "code", null],
      ["build-b", "b1", "original", 2, "code", null],
      ["build-b", "b1", "region_removed", 1, "look", null],
      ["build-b", "b1", "region_sham", 1, "look", null],
      ["build-b", "b1", "reversed", 1, "look,shape", null],
    ],
  );
  assert.equal(new Set(units.map((unit) => unit.id)).size, units.length);
  // The repeats of one request are the samples of one sample group.
  const repeats = units.filter(
    (unit) => unit.captureId === "a1" && unit.condition === "original" && unit.repeat <= 2,
  );
  assert.deepEqual(
    repeats.map((unit) => [unit.criterionIds.join(), unit.batch.sample]),
    [
      ["look,shape", 1],
      ["look,shape", 2],
      ["code", 1],
      ["code", 2],
    ],
  );
  assert.equal(new Set(repeats.map((unit) => unit.batch.sampleGroupId)).size, 2);
  // A reassessment judges each request one time for each judge sample of its settings.
  const sampled = await assessmentUnits({
    ...input,
    conditions: ["original"],
    plan: null,
    judgeSettings: { samples: 3, grouping: "per_criterion" },
    groups: [
      { images: true, criterionIds: ["look"] },
      { images: true, criterionIds: ["shape"] },
    ],
  });
  assert.deepEqual(
    sampled.units
      .filter((unit) => unit.captureId === "a1")
      .map((unit) => [unit.criterionIds.join(), unit.batch.sample, unit.batch.grouping]),
    [
      ["look", 1, "per_criterion"],
      ["look", 2, "per_criterion"],
      ["look", 3, "per_criterion"],
      ["shape", 1, "per_criterion"],
      ["shape", 2, "per_criterion"],
      ["shape", 3, "per_criterion"],
    ],
  );
  assert.equal(
    units.find((unit) => unit.condition === "reversed")!.batch.substitution!.labelRule,
    "labels_follow_images",
  );
  const noImages = "This criterion uses no images. A control runs only on the request with images.";
  assert.deepEqual(
    unavailable.map((item) => [
      item.condition,
      item.captureId,
      item.criterionIds.join(),
      item.reason,
    ]),
    [
      ["region_removed", null, "code", noImages],
      ["region_removed", null, "shape", "No authored region for this criterion."],
      ["region_sham", null, "code", noImages],
      ["region_sham", null, "shape", "No authored region for this criterion."],
      ["donor_swap", null, "code", noImages],
      ["donor_swap", null, "look,shape", "The plan names no expert reviewer."],
      ["reversed", null, "code", noImages],
      ["canary", null, "code", noImages],
      ["canary", "a2", "look,shape", "The twin build has no observation of this view and pass."],
      ["canary", "b1", "look,shape", "This build has no twin build with a note."],
    ],
  );
  // With no criterion that uses images, the test judges only the original evidence.
  const textOnly = await assessmentUnits({
    ...input,
    groups: [{ images: false, criterionIds: ["code"] }],
  });
  assert.ok(textOnly.units.every((unit) => unit.condition === "original"));
  const authorized = await assessmentUnits({
    ...input,
    conditions: ["original", "blank"],
    plan: { ...plan, holdoutLook: true },
  });
  assert.deepEqual(authorized.excluded, []);
  assert.ok(authorized.units.some((unit) => unit.captureId === "a3"));
  await assert.rejects(
    assessmentUnits({ ...input, subjectIds: ["build-a", "other"] }),
    /one evaluation/,
  );
  await assert.rejects(
    assessmentUnits({
      ...input,
      plan: {
        ...plan,
        canary: { ...plan.canary!, pairs: [{ subjectId: "build-a", twinSubjectId: "other" }] },
      },
    }),
    /same evaluation/,
  );
});
