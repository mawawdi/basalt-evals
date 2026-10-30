import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { hashJson } from "../packages/contracts/src/index.js";
import { analyzeExperiment } from "../packages/experiments/src/analysis.js";
import {
  authoredPixelDecision,
  judgeIncrement,
  type CaptureMeasurement,
} from "../packages/experiments/src/baselines.js";
import type { Decision, ProtocolEvidence } from "../packages/experiments/src/controller.js";
import {
  measureCapture,
  referenceDistance,
  type RecordedFrame,
} from "../packages/experiments/src/pixel-metrics.js";
import {
  planDetectorCalibration,
  planHarnessComparison,
  type BaselinePlan,
  type ExperimentPlan,
  type StudySource,
} from "../packages/experiments/src/protocols.js";
import { decodeCaptureImage } from "../packages/studio-runner/src/images.js";

/** The bounds of the two registered harnesses that a protocol plan binds. */
const PLANNED_HARNESSES = {
  baseline: { id: "thin", maxTurns: 32, developmentRuns: 0 },
  treatment: { id: "production", maxTurns: 32, developmentRuns: 3 },
};

const WIDTH = 40,
  HEIGHT = 30,
  GRAY = 128;
type Square = { x: number; y: number; size: number };
/** A gray frame with white squares, encoded as a PNG and decoded by the capture decoder. */
function frame(id: string, phaseId: string, recordedMs: number, squares: Square[]): RecordedFrame {
  const image = new PNG({ width: WIDTH, height: HEIGHT });
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const x = pixel % WIDTH,
      y = Math.floor(pixel / WIDTH);
    const white = squares.some(
      (square) =>
        x >= square.x && x < square.x + square.size && y >= square.y && y < square.y + square.size,
    );
    image.data.set([white ? 255 : GRAY, white ? 255 : GRAY, white ? 255 : GRAY, 255], pixel * 4);
  }
  return {
    id,
    phaseId,
    recordedMs,
    raster: decodeCaptureImage(PNG.sync.write(image), "image/png"),
  };
}
const linear = (code: number) => ((code / 255 + 0.055) / 1.055) ** 2.4;
const close = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
/** A band of harness controls at the bottom of the frame. A button in it turns white at the peak. */
const controls = { x: 0, y: 26, width: 40, height: 4 };
const button = { x: 0, y: 26, size: 4 };
function phaseFrames(prefix: string) {
  return [
    frame(`${prefix}-peak`, "peak", 180, [{ x: 8, y: 8, size: 8 }, button]),
    frame(`${prefix}-before`, "before", -100, []),
    frame(`${prefix}-decay`, "decay", 650, [{ x: 10, y: 10, size: 2 }]),
    frame(`${prefix}-onset`, "onset", 50, [{ x: 10, y: 10, size: 4 }]),
  ];
}

test("pixel measures use the authored region and recorded time order", () => {
  const measured = measureCapture({
    frames: phaseFrames("a"),
    region: {
      rectangle: { x: 8, y: 8, width: 8, height: 8 },
      surroundMargin: 4,
      authority: "view",
    },
    excluded: [],
    changeThreshold: 16,
    onsetPixels: 10,
    reference: null,
  });
  assert.equal(measured.scope, "authored_region");
  assert.equal(measured.note, null);
  assert.equal(measured.issue, null);
  assert.equal(measured.preActionFrameId, "a-before");
  assert.deepEqual(
    measured.frames.map((row) => [row.index, row.id, row.changedPixels]),
    [
      [0, "a-before", 0],
      [1, "a-onset", 16],
      [2, "a-peak", 64],
      [3, "a-decay", 4],
    ],
  );
  assert.deepEqual(measured.onset, { index: 1, id: "a-onset", phaseId: "onset", recordedMs: 50 });
  assert.deepEqual(measured.peak, { index: 2, id: "a-peak", phaseId: "peak", recordedMs: 180 });
  const surround = linear(GRAY);
  close(measured.frames[1]!.weberContrast, 0.25 / surround - 0.25);
  close(measured.values.weber_contrast, 1 / surround - 1);
  assert.equal(measured.values.changed_pixels, 64);
  close(measured.values.screen_coverage, 64 / (WIDTH * HEIGHT));
  assert.deepEqual([measured.values.onset_ms, measured.values.peak_ms], [50, 180]);
  assert.equal(measured.values.reference_distance, null);
});

test("without an authored region the measures use the whole frame and say so", () => {
  const input = {
    frames: phaseFrames("b"),
    region: null,
    changeThreshold: 16,
    onsetPixels: 1,
    reference: null,
  };
  const open = measureCapture({ ...input, excluded: [] });
  const masked = measureCapture({ ...input, excluded: [controls] });
  assert.equal(masked.scope, "whole_frame");
  assert.match(masked.note!, /whole frame/);
  assert.equal(masked.values.weber_contrast, null);
  assert.equal(open.values.changed_pixels, 64 + 4 * 4, "The controls band changes too");
  assert.equal(masked.values.changed_pixels, 64, "An excluded rectangle is not measured");
  const late = measureCapture({ ...input, excluded: [], frames: phaseFrames("c").slice(0, 1) });
  assert.equal(late.issue, "no_pre_action_frame");
  assert.equal(late.values.changed_pixels, null);
  assert.equal(late.onset, null);
});

test("reference distance aligns by phase and recorded time, never by frame index", () => {
  const exemplar = phaseFrames("e").filter((item) => item.phaseId !== "decay");
  const options = { area: null, excluded: [], grid: { width: 4, height: 3 }, toleranceMs: 20 };
  const same = [
    frame("s-early", "before", -300, []),
    frame("s-before", "before", -90, []),
    frame("s-onset", "onset", 60, [{ x: 10, y: 10, size: 4 }]),
    frame("s-peak", "peak", 170, [{ x: 8, y: 8, size: 8 }, button]),
    frame("s-other", "aftermath", 900, []),
  ];
  const aligned = referenceDistance(same, exemplar, options);
  assert.equal(aligned.distance, 0, "Index order would pair s-early with e-peak");
  assert.deepEqual(
    aligned.pairs.map((pair) => [pair.frameId, pair.exemplarFrameId, pair.offsetMs]),
    [
      ["s-before", "e-before", -10],
      ["s-onset", "e-onset", -10],
      ["s-peak", "e-peak", 10],
    ],
  );
  assert.deepEqual(aligned.unaligned, [
    { frameId: "s-early", reason: "outside_tolerance" },
    { frameId: "s-other", reason: "no_phase" },
  ]);
  assert.deepEqual(referenceDistance([...same].reverse(), exemplar, options), aligned);
  const missing = same.map((item) =>
    item.id === "s-peak" ? frame("s-peak", "peak", 170, [button]) : item,
  );
  // The 8 x 8 square covers 64 pixels of four 10 x 10 cells in a 4 x 3 grid.
  const peak = (64 * (255 - GRAY)) / (100 * 12 * 255);
  close(referenceDistance(missing, exemplar, options).distance, peak / 3);
  const measured = measureCapture({
    frames: missing.slice(1, 4),
    region: null,
    excluded: [],
    changeThreshold: 16,
    onsetPixels: 1,
    reference: { exemplars: [exemplar, exemplar], grid: options.grid, toleranceMs: 20 },
  });
  close(measured.values.reference_distance, peak / 3);
});

const views = ["development", "withheld"].flatMap((partition) =>
  [1, 2].map((view) => ({
    id: `${partition}-${view}`,
    partition: partition as "development" | "withheld",
  })),
);
const sources: StudySource[] = ["gate", "shutter"].flatMap((evalId) =>
  (["generated", "generated", "generated", "working", "negative", "negative"] as const).map(
    (kind, index) => ({
      id: `${evalId}-${index}`,
      evalId,
      kind,
      sourceHash: hashJson([evalId, index]),
      targetCriterionIds: kind === "negative" ? ["required"] : [],
    }),
  ),
);
const timing = views.map((view) => ({
  evalId: "gate",
  viewId: view.id,
  kind: "stills" as const,
  captures: [
    { captureId: "frame-before", factId: "before-time" },
    { captureId: "frame-peak", factId: "peak-time" },
  ],
}));
const measurement = { changeThreshold: 16, onsetPixels: 1, regions: [], excluded: [], timing };
const ladder = (
  change: Partial<Omit<BaselinePlan, "trivial" | "comparison">>,
): Omit<BaselinePlan, "trivial" | "comparison"> => ({
  measurement,
  reference: null,
  rules: [],
  judgeControls: ["text_only", "facts_and_source"],
  secondJudgeFamily: "google",
  ...change,
});
const coverageRule = {
  id: "gate-coverage",
  evalId: "gate",
  criterionId: "required",
  measure: "screen_coverage" as const,
  direction: "at_least" as const,
  authoredThreshold: null,
};
const onsetRule = {
  id: "gate-onset",
  evalId: "gate",
  criterionId: "required",
  measure: "onset_ms" as const,
  direction: "at_most" as const,
  authoredThreshold: { value: 100, passage: "The flash starts within 100 ms of the hit." },
};

test("the plan preregisters the ladder and refuses rules without a possible value", () => {
  const plan = planDetectorCalibration({
    sources,
    views,
    baselines: ladder({ rules: [coverageRule, onsetRule] }),
    exemplarComparison: null,
  });
  assert.deepEqual(plan.baselines!.trivial, ["always_pass", "always_fail"]);
  assert.equal(plan.baselines!.comparison.cluster, "build");
  assert.equal(plan.baselines!.secondJudgeFamily, "google");
  assert.notEqual(
    plan.id,
    planDetectorCalibration({
      sources,
      views,
      baselines: ladder({ rules: [coverageRule] }),
      exemplarComparison: null,
    }).id,
  );
  const refused = (change: Partial<Omit<BaselinePlan, "trivial" | "comparison">>, text: RegExp) =>
    assert.throws(
      () =>
        planDetectorCalibration({
          sources,
          views,
          baselines: ladder(change),
          exemplarComparison: null,
        }),
      text,
    );
  refused(
    { rules: [{ ...coverageRule, measure: "weber_contrast" }] },
    /authored region in each view/,
  );
  refused({ rules: [{ ...coverageRule, measure: "reference_distance" }] }, /exemplar/);
  refused(
    { rules: [coverageRule], measurement: { ...measurement, timing: timing.slice(1) } },
    /timing entry in each view/,
  );
  refused(
    {
      measurement: {
        ...measurement,
        timing: [{ ...timing[0]!, captures: [{ captureId: "frame-before", factId: "Before" }] }],
      },
    },
    /time facts/,
  );
  refused({ rules: [coverageRule, coverageRule] }, /unique/);
  refused(
    { rules: [{ ...onsetRule, authoredThreshold: { value: 100, passage: " " } }] },
    /criterion passage/,
  );
  refused(
    {
      reference: {
        exemplars: [{ evalId: "gate", sourceId: "shutter-3" }],
        grid: { width: 4, height: 3 },
        toleranceMs: 20,
      },
    },
    /planned source/,
  );
  const harness = planHarnessComparison({
    harnesses: PLANNED_HARNESSES,
    builderModelIds: ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"],
    evalIds: ["checkpoint", "xp", "shutter", "gate"],
    orderSeed: 37,
    presentation: "sequence",
    presentationSelectionHash: "a".repeat(64),
  });
  assert.equal(harness.baselines, null);
});

test("only the threshold of an authored criterion turns a pixel measure into a verdict", () => {
  assert.throws(() => authoredPixelDecision(coverageRule, 0.5), /cannot give a verdict/);
  assert.equal(authoredPixelDecision(onsetRule, 50), "satisfied");
  assert.equal(authoredPixelDecision(onsetRule, 300), "violated");
  assert.equal(authoredPixelDecision(onsetRule, null), null);
});

test("the judge increment completes unknown cells against the judge and adjusts with Holm", () => {
  const pairs = [
    ...Array.from({ length: 10 }, (_, index) => ({
      member: "strong",
      build: `b${index}`,
      judge: true,
      baseline: false,
    })),
    { member: "weak", build: "b0", judge: null, baseline: false },
    { member: "weak", build: "b1", judge: false, baseline: null },
    { member: "weak", build: "b2", judge: true, baseline: null },
    { member: "weak", build: "b3", judge: true, baseline: false },
  ];
  const result = judgeIncrement(pairs, 0.95);
  const [strong, weak] = result.members;
  assert.deepEqual(
    [strong!.member, strong!.test.firstOnly, strong!.test.secondOnly],
    ["strong", 10, 0],
  );
  close(strong!.test.exactP, 2 / 1024);
  close(strong!.adjustedP, 4 / 1024);
  assert.equal(strong!.judgeAddsInformation, true);
  assert.deepEqual(weak!.observed, {
    both: 0,
    judgeOnly: 1,
    baselineOnly: 0,
    neither: 0,
    unresolved: 3,
  });
  assert.deepEqual([weak!.test.firstOnly, weak!.test.secondOnly], [1, 1]);
  assert.equal(weak!.judgeAddsInformation, false);
  assert.equal(weak!.baselineCorrect.unresolved, 2);
  assert.throws(() => judgeIncrement([pairs[0]!, pairs[0]!], 0.95), /one pair for each build/);
});

function evidenceFor(
  plan: ExperimentPlan,
  accepted: (sourceId: string) => boolean,
): ProtocolEvidence {
  const kind = (sourceId: string) => sources.find((source) => source.id === sourceId)!.kind;
  const expert = (sourceId: string): Decision =>
    kind(sourceId) === "negative" ? "violated" : "satisfied";
  const subject = (captureId: string) =>
    plan.captures.find((capture) => capture.id === captureId)!.subjectId;
  return {
    requiredCriteria: { gate: ["required"], shutter: ["required"] },
    requiredPresentationCriteria: { gate: ["required"], shutter: ["required"] },
    completedGates: ["development-review", "presentation-selection"],
    builders: [],
    captures: plan.captures.map((capture) => ({
      id: capture.id,
      state: "completed",
      proofHash: hashJson(["capture", capture.id]),
    })),
    reviews: plan.captures.map((capture) => ({
      captureId: capture.id,
      proofHash: hashJson(["expert", capture.id]),
      decisions: { required: expert(capture.subjectId) },
      blindingIssue: null,
    })),
    judgments: plan.judgments.map((unit) => ({
      id: unit.id,
      state: "completed",
      proofHash: hashJson(["judgment", unit.id]),
      decisions: {
        required: unit.substitution
          ? "insufficient"
          : accepted(subject(unit.captureId))
            ? "satisfied"
            : "violated",
      },
      integrityIssue: false,
      costUsd: 0.1,
    })),
  };
}

test("pixel thresholds come from development and the judge meets every rung on the holdout", () => {
  const plan = planDetectorCalibration({
    sources,
    views,
    baselines: ladder({ rules: [coverageRule, onsetRule] }),
    exemplarComparison: null,
  });
  const negative = (sourceId: string) =>
    sources.find((source) => source.id === sourceId)!.kind === "negative";
  // The judge accepts one negative build of the gate task. It is right on all other builds.
  const evidence = evidenceFor(plan, (sourceId) => !negative(sourceId) || sourceId === "gate-4");
  const measurements: CaptureMeasurement[] = plan.captures
    .filter((capture) => capture.evalId === "gate")
    .map((capture) => ({
      captureId: capture.id,
      criterionId: "required",
      scope: "whole_frame",
      issue: null,
      values: {
        weber_contrast: null,
        changed_pixels: negative(capture.subjectId) ? 12 : 240,
        screen_coverage: negative(capture.subjectId) ? 0.01 : 0.2,
        onset_ms: negative(capture.subjectId) ? 300 : 50,
        peak_ms: negative(capture.subjectId) ? 650 : 180,
        reference_distance: null,
      },
    }));
  const report = analyzeExperiment(plan, evidence, measurements, []);
  assert.ok("baselines" in report);
  const { baselines } = report;
  assert.deepEqual(
    [
      baselines.measurements.planned,
      baselines.measurements.recorded,
      baselines.measurements.wholeFrame,
    ],
    [72, 72, 72],
  );
  assert.deepEqual(
    baselines.calibration.map((item) => [item.ruleId, item.threshold, item.correct, item.labelled]),
    [
      ["gate-coverage", 0.2, 6, 6],
      ["gate-onset", 50, 6, 6],
    ],
  );
  assert.equal(baselines.holdout.length, 3);
  const family = (name: string) =>
    baselines.holdout
      .find((row) => row.presentation === "sequence")!
      .families.find((item) => item.baseline === name)!;
  const pixel = family("pixel_rules");
  assert.deepEqual(
    pixel.members.map((item) => [item.ruleId, item.observed.both, item.observed.baselineOnly]),
    [
      ["gate-coverage", 5, 1],
      ["gate-onset", 5, 1],
    ],
  );
  assert.ok(pixel.members.every((item) => !item.judgeAddsInformation));
  assert.deepEqual(
    family("authored_rules").members.map((item) => item.ruleId),
    ["gate-onset"],
  );
  const always = family("always_pass").members;
  assert.deepEqual(
    always.map((item) => [item.taskId, item.test.firstOnly, item.test.secondOnly]),
    [
      ["gate", 1, 0],
      ["shutter", 2, 0],
    ],
  );
  close(always[1]!.test.exactP, 0.5);
  assert.deepEqual(
    always.map((item) => item.adjustedP),
    [1, 1],
  );
  const fail = family("always_fail").members.find((item) => item.taskId === "shutter")!;
  assert.deepEqual([fail.test.firstOnly, fail.test.secondOnly], [4, 0]);
  close(fail.test.exactP, 0.125);

  const withheld = plan.captures.find(
    (capture) => capture.subjectId === "gate-0" && capture.partition === "withheld",
  )!;
  const partial = analyzeExperiment(
    plan,
    evidence,
    measurements.filter((record) => record.captureId !== withheld.id),
    [],
  );
  assert.ok("baselines" in partial);
  const coverage = partial.baselines.holdout[0]!.families.find(
    (item) => item.baseline === "pixel_rules",
  )!.members.find((item) => item.ruleId === "gate-coverage")!;
  assert.equal(partial.baselines.measurements.missing, 1);
  assert.equal(coverage.observed.unresolved, 1);
  assert.equal(coverage.baselineCorrect.unresolved, 1);

  const shutter = plan.captures.find((capture) => capture.evalId === "shutter")!;
  assert.throws(
    () => analyzeExperiment(plan, evidence, [{ ...measurements[0]!, captureId: shutter.id }], []),
    /not planned/,
  );
  assert.throws(
    () =>
      analyzeExperiment(plan, evidence, [{ ...measurements[0]!, scope: "authored_region" }], []),
    /scope/,
  );
  assert.throws(
    () => analyzeExperiment(plan, evidence, [measurements[0]!, measurements[0]!], []),
    /more than once/,
  );
});
