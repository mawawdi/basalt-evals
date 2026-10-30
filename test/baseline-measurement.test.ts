import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import type {
  RunOperationEvent,
  RunOperationManifest,
  RunView,
} from "../packages/contracts/src/execution.js";
import { contentHash, hashJson, type StudioEvidence } from "../packages/contracts/src/index.js";
import type { EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { analyzeExperiment } from "../packages/experiments/src/analysis.js";
import { measureCapture } from "../packages/experiments/src/pixel-metrics.js";
import {
  planDetectorCalibration,
  type BaselinePlan,
  type StudySource,
} from "../packages/experiments/src/protocols.js";
import { assertBaselineAuthority } from "../packages/operator/src/experiment-plan.js";
import {
  measureProtocolCaptures,
  sequenceFrames,
} from "../packages/operator/src/pixel-measurement.js";
import type { readBoundSequence } from "../packages/studio-runner/src/bound-sequence.js";

const GRAY = 128;
/** A 40 x 30 gray PNG with one white square, or no square. */
function png(square: { x: number; y: number; size: number } | null): Buffer {
  const image = new PNG({ width: 40, height: 30 });
  for (let pixel = 0; pixel < 40 * 30; pixel++) {
    const x = pixel % 40,
      y = Math.floor(pixel / 40);
    const white =
      square !== null &&
      x >= square.x &&
      x < square.x + square.size &&
      y >= square.y &&
      y < square.y + square.size;
    image.data.set([white ? 255 : GRAY, white ? 255 : GRAY, white ? 255 : GRAY, 255], pixel * 4);
  }
  return PNG.sync.write(image);
}
async function put(root: string, file: string, bytes: Buffer) {
  await mkdir(dirname(resolve(root, file)), { recursive: true });
  await writeFile(resolve(root, file), bytes);
}

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
const stills = [
  { captureId: "frame-before", factId: "before-time" },
  { captureId: "frame-peak", factId: "peak-time" },
];

test("phase stills take their recorded time from time facts and reach the sealed analysis", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-pixel-measurement-"));
  try {
    const plan = planDetectorCalibration({
      sources,
      views,
      baselines: {
        measurement: {
          changeThreshold: 16,
          onsetPixels: 1,
          regions: [],
          excluded: [],
          timing: views.map((view) => ({
            evalId: "gate",
            viewId: view.id,
            kind: "stills" as const,
            captures: stills,
          })),
        },
        reference: {
          exemplars: [{ evalId: "gate", sourceId: "gate-3" }],
          grid: { width: 4, height: 3 },
          toleranceMs: 20,
        },
        rules: [
          {
            id: "gate-coverage",
            evalId: "gate",
            criterionId: "required",
            measure: "screen_coverage",
            direction: "at_least",
            authoredThreshold: null,
          },
        ],
        judgeControls: [],
        secondJudgeFamily: null,
      },
      exemplarComparison: null,
    });
    const capture = (subjectId: string, pass: number) =>
      plan.captures.find(
        (item) =>
          item.subjectId === subjectId && item.viewId === "development-1" && item.pass === pass,
      )!;
    const events: RunOperationEvent[] = [];
    const retain = async (id: string, peakTime: boolean) => {
      const base = `.basalt-evals/eval-operations/op-1/capture/${id}/studio`;
      const before = png(null),
        peak = png({ x: 8, y: 8, size: 8 });
      await put(root, `${base}/before.png`, before);
      await put(root, `${base}/peak.png`, peak);
      const image = (captureId: string, file: string, bytes: Buffer) => ({
        captureId,
        file,
        hash: contentHash(bytes),
        bytes: bytes.length,
        mediaType: "image/png",
        width: 40,
        height: 30,
      });
      const probe = (factId: string, value: number) => ({
        factId,
        kind: "replication_probe",
        exists: true,
        value,
        observedFrom: "studio",
      });
      const evidence = {
        phases: [
          {
            phaseId: "before",
            observations: [probe("before-time", -100)],
            captures: [image("frame-before", "before.png", before)],
          },
          {
            phaseId: "peak",
            observations: peakTime ? [probe("peak-time", 180)] : [],
            captures: [image("frame-peak", "peak.png", peak)],
          },
        ],
      } as unknown as StudioEvidence;
      await new RepositoryFiles(root).writeJson(`${base}/evidence.json`, evidence);
      events.push({
        stage: "final_capture",
        kind: "completed",
        unitId: id,
        artifactHashes: [hashJson(["receipt", id]), hashJson(evidence)],
      } as RunOperationEvent);
    };
    const build = capture("gate-0", 1).id,
      unclear = capture("gate-0", 2).id,
      exemplar = [capture("gate-3", 1).id, capture("gate-3", 2).id];
    await retain(build, true);
    await retain(unclear, false);
    for (const id of exemplar) await retain(id, true);
    const manifest = { id: "op-1" } as RunOperationManifest;
    const records = await measureProtocolCaptures({ root, manifest, plan, events });
    assert.deepEqual(
      records.map((record) => record.captureId).sort(),
      [build, unclear, ...exemplar].sort(),
    );
    const measured = records.find((record) => record.captureId === build)!;
    assert.equal(measured.scope, "whole_frame");
    assert.equal(measured.issue, null);
    assert.equal(measured.values.changed_pixels, 64);
    assert.deepEqual([measured.values.onset_ms, measured.values.peak_ms], [180, 180]);
    assert.equal(measured.values.reference_distance, 0);
    const missing = records.find((record) => record.captureId === unclear)!;
    assert.equal(missing.issue, "missing_time_fact");
    assert.ok(Object.values(missing.values).every((value) => value === null));

    const report = analyzeExperiment(
      plan,
      {
        requiredCriteria: { gate: ["required"], shutter: ["required"] },
        requiredPresentationCriteria: { gate: ["required"], shutter: ["required"] },
        captures: [],
        judgments: [],
        reviews: [],
        builders: [],
        completedGates: [],
      },
      records,
      [],
    );
    assert.ok("baselines" in report);
    assert.deepEqual(
      [
        report.baselines.measurements.recorded,
        report.baselines.measurements.withIssue,
        report.baselines.measurements.missing,
      ],
      [4, 1, 68],
    );

    await put(
      root,
      `.basalt-evals/eval-operations/op-1/capture/${build}/studio/peak.png`,
      png({ x: 0, y: 0, size: 2 }),
    );
    await assert.rejects(
      measureProtocolCaptures({ root, manifest, plan, events }),
      /differs from its signed evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sequence frames use the fixed frame roles and the clock alignment", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-measurement-"));
  try {
    const anchor = Date.parse("2026-10-02T00:00:10.000Z");
    const offsetMs = 200;
    const prefix = "native/sequence/press-attempt-01/";
    // Each frame states its Studio-clock start from the anchor. Frames use the host clock.
    const plan: Array<{ file: string; start: number; user: number; image: Buffer | null }> = [
      { file: "frame-0001.png", start: -1500, user: 7, image: null },
      { file: "frame-0002.png", start: -400, user: 7, image: png(null) },
      { file: "frame-0003.png", start: -30, user: 7, image: png({ x: 10, y: 10, size: 4 }) },
      { file: "frame-0004.png", start: 400, user: 7, image: png({ x: 8, y: 8, size: 8 }) },
      { file: "frame-0005.png", start: 1600, user: 7, image: png(null) },
      { file: "frame-0006.png", start: 2500, user: 7, image: null },
      { file: "frame-0007.png", start: 400, user: 8, image: null },
    ];
    const frames = [];
    for (const item of plan) {
      const bytes = item.image ?? png(null);
      if (item.image) await put(root, `seq/${prefix}${item.file}`, item.image);
      const host = anchor + offsetMs + item.start;
      frames.push({
        file: item.file,
        hash: contentHash(bytes),
        bytes: bytes.length,
        mediaType: "image/png" as const,
        width: 40,
        height: 30,
        playerUserId: item.user,
        studioId: "studio",
        startedAt: new Date(host).toISOString(),
        endedAt: new Date(host + 100).toISOString(),
      });
    }
    const bound = {
      plan: {
        maximumGapMs: 1000,
        requiredTransitions: [
          {
            id: "press",
            source: { kind: "action", stepId: "press" },
            effectWindowMs: 1000,
            holdMs: 500,
          },
        ],
      },
      assessment: {
        status: "sufficient",
        clock: { offsetMs, uncertaintyMs: 50 },
        transitions: [
          { transitionId: "press", at: new Date(anchor).toISOString(), covered: true, gapMs: 0 },
        ],
        actorFrames: [{ actor: "primary", userId: 7 }],
      },
      acquisition: { status: "complete", frames },
      prefix,
    } as unknown as Awaited<ReturnType<typeof readBoundSequence>>;
    const files = new RepositoryFiles(root);
    const read = await sequenceFrames(files, "seq", bound, {
      transitionId: "press",
      actor: "primary",
    });
    assert.equal(read.issue, null);
    assert.deepEqual(
      read.frames!.map((frame) => [frame.id, frame.phaseId, frame.recordedMs]),
      [
        ["frame-0002.png", "press", -400],
        ["frame-0003.png", "press", 0],
        ["frame-0004.png", "press", 400],
        ["frame-0005.png", "press", 1600],
      ],
    );
    const measured = measureCapture({
      frames: read.frames!,
      region: null,
      excluded: [],
      changeThreshold: 16,
      onsetPixels: 1,
      reference: null,
    });
    assert.deepEqual(
      [measured.preActionFrameId, measured.values.onset_ms, measured.values.peak_ms],
      ["frame-0002.png", 0, 400],
    );
    const unanchored = {
      ...bound,
      assessment: {
        ...bound.assessment,
        transitions: [{ transitionId: "press", at: "", covered: false, gapMs: null }],
      },
    };
    assert.equal(
      (await sequenceFrames(files, "seq", unanchored, { transitionId: "press", actor: "primary" }))
        .issue,
      "no_transition_anchor",
    );
    assert.equal(
      (await sequenceFrames(files, "seq", bound, { transitionId: "press", actor: "other" })).issue,
      "no_actor_frames",
    );
    const press = { transitionId: "press", actor: "primary" };
    const unaligned = { ...bound, assessment: { ...bound.assessment, clock: null } };
    assert.equal(
      (await sequenceFrames(files, "seq", unaligned, press)).issue,
      "no_clock_alignment",
    );
    const insufficient = {
      ...bound,
      assessment: { ...bound.assessment, status: "insufficient" as const },
    };
    assert.equal(
      (await sequenceFrames(files, "seq", insufficient, press)).issue,
      "insufficient_sequence",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const RUBRIC = [
  "# Impact rubric",
  "",
  "- The flash starts within 100 ms of the hit.",
  "- The flash fades within 1 s.",
  "",
].join("\n");
const governing = "- The flash starts within 100 ms of the hit.";
const revision = {
  privateEvaluator: {
    deterministic: [],
    codeQuality: [],
    unscaled: [],
    visual: [
      { id: "flash", required: true },
      { id: "style", required: false },
    ],
  },
  criterionMappings: [
    {
      authoredCriterionId: "c1",
      authoredClauseIds: [],
      authority: {
        source: "human_rubric",
        start: RUBRIC.indexOf(governing),
        end: RUBRIC.indexOf(governing) + governing.length,
      },
      method: "visual",
      executableCriterionId: "flash",
      rationale: "",
    },
  ],
  authored: {
    builderPrompt: "Build a flash.",
    rubric: RUBRIC,
    criteria: [{ id: "c1", contextNodeIds: [] }],
    document: [],
  },
} as unknown as EvalRevision;
const view = {
  id: "side",
  partition: "withheld",
  plan: {
    actors: ["primary"],
    phases: [
      {
        id: "peak",
        captures: [{ id: "frame-peak" }],
        facts: [{ id: "peak-time", kind: "replication_probe" }],
      },
    ],
  },
  sequence: { requiredTransitions: [{ id: "press" }] },
} as unknown as RunView;
function authority(change: {
  passage?: string;
  criterionId?: string;
  timing?: BaselinePlan["measurement"]["timing"];
}) {
  const ladder: BaselinePlan = {
    trivial: ["always_pass", "always_fail"],
    measurement: {
      changeThreshold: 16,
      onsetPixels: 1,
      regions: [],
      excluded: [],
      timing: change.timing ?? [
        {
          evalId: "impact",
          viewId: "side",
          kind: "stills",
          captures: [{ captureId: "frame-peak", factId: "peak-time" }],
        },
      ],
    },
    reference: null,
    rules: [
      {
        id: "flash-onset",
        evalId: "impact",
        criterionId: change.criterionId ?? "flash",
        measure: "onset_ms",
        direction: "at_most",
        authoredThreshold: {
          value: 100,
          passage: change.passage ?? "starts within 100 ms of the hit",
        },
      },
    ],
    judgeControls: [],
    secondJudgeFamily: null,
    comparison: {
      calibration: "development",
      holdout: "withheld",
      test: "exact_mcnemar",
      adjustment: "holm",
      cluster: "build",
    },
  };
  return () => assertBaselineAuthority(ladder, { id: "impact", views: [view] }, revision);
}

test("registration accepts only authored thresholds that quote the governing rubric passage", () => {
  authority({})();
  assert.throws(
    authority({ passage: "The flash fades within 1 s." }),
    /does not quote the frozen rubric/,
  );
  assert.throws(authority({ passage: "starts within 50 ms" }), /does not quote the frozen rubric/);
  assert.throws(authority({ criterionId: "style" }), /not a required criterion/);
  assert.throws(
    authority({
      timing: [
        {
          evalId: "impact",
          viewId: "side",
          kind: "stills",
          captures: [{ captureId: "frame-peak", factId: "onset-time" }],
        },
      ],
    }),
    /replication probe onset-time in one phase/,
  );
  assert.throws(
    authority({
      timing: [
        {
          evalId: "impact",
          viewId: "side",
          kind: "sequence",
          transitionId: "release",
          actor: "primary",
        },
      ],
    }),
    /transition release/,
  );
  authority({
    timing: [
      {
        evalId: "impact",
        viewId: "side",
        kind: "sequence",
        transitionId: "press",
        actor: "primary",
      },
    ],
  })();
});
