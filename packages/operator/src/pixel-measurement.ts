import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { RunOperationEvent, RunOperationManifest } from "../../contracts/src/execution.js";
import {
  compareCodeUnits,
  contentHash,
  hashJson,
  MAX_CAPTURE_BYTES,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { authoredRegion, type CaptureMeasurement } from "../../experiments/src/baselines.js";
import {
  PIXEL_MEASURES,
  measureCapture,
  type EffectRegion,
  type PixelMeasure,
  type PixelRegion,
  type RecordedFrame,
} from "../../experiments/src/pixel-metrics.js";
import type { ExperimentPlan, MeasurementTiming } from "../../experiments/src/protocols.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import { decodeCaptureImage } from "../../studio-runner/src/images.js";
import type { SignedWorkerManifest } from "../../studio-runner/src/native-worker.js";
import { assertSequenceBytes, transitionCoverage } from "../../studio-runner/src/sequence.js";
import { frozenSequencePlan } from "./run-manifest.js";

/*
 * Read the retained frames of the calibration evidence and give each frame its phase and its
 * recorded time from the action. Then calculate the pixel measures of each criterion that has
 * a pixel rule. This module makes no model call and no Studio call.
 */

type MeasuredFrames = { frames: RecordedFrame[]; issue: null } | { frames: null; issue: string };

/** Phase stills: each bound capture gets the recorded time of its time fact. */
async function stillFrames(
  files: RepositoryFiles,
  base: string,
  evidence: StudioEvidence,
  captures: Array<{ captureId: string; factId: string }>,
): Promise<MeasuredFrames> {
  const frames: RecordedFrame[] = [];
  for (const binding of captures) {
    const phase = evidence.phases.find((item) =>
      item.captures.some((capture) => capture.captureId === binding.captureId),
    );
    const capture = phase?.captures.find((item) => item.captureId === binding.captureId);
    if (!phase || !capture) return { frames: null, issue: "missing_frame" };
    const fact = phase.observations.find((item) => item.factId === binding.factId);
    if (
      fact?.kind !== "replication_probe" ||
      !fact.exists ||
      typeof fact.value !== "number" ||
      !Number.isFinite(fact.value)
    )
      return { frames: null, issue: "missing_time_fact" };
    const bytes = await files.bytes(`${base}/${capture.file}`, MAX_CAPTURE_BYTES);
    if (contentHash(bytes) !== capture.hash)
      throw new Error("A measured frame differs from its signed evidence");
    frames.push({
      id: capture.captureId,
      phaseId: phase.phaseId,
      recordedMs: fact.value,
      raster: decodeCaptureImage(bytes, capture.mediaType),
    });
  }
  return { frames, issue: null };
}

/**
 * Sequence frames of one actor around one transition. The frames are the frames that the
 * fixed selection rule gives roles: the last frame before the anchor, each frame that can
 * overlap the effect window, the first frame after an observed state change and the first
 * frame after the hold. Frame intervals use the host clock and the anchor uses the Studio
 * clock, so the recorded time applies the probe clock alignment of the assessment. The anchor
 * of an action is its signed actedAt time. The recorded time is the acquisition start from the
 * anchor. A frame after the before frame that starts before the anchor can show the effect, so
 * its recorded time is 0. The judge gets no frames of an insufficient sequence, so the pixel
 * measures do not use them either.
 */
export async function sequenceFrames(
  files: RepositoryFiles,
  base: string,
  bound: Awaited<ReturnType<typeof readBoundSequence>>,
  timing: { transitionId: string; actor: string },
): Promise<MeasuredFrames> {
  const index = bound.plan.requiredTransitions.findIndex((item) => item.id === timing.transitionId);
  if (index < 0) throw new Error("The timing transition is not in the frozen sequence view");
  const { clock } = bound.assessment;
  if (!clock) return { frames: null, issue: "no_clock_alignment" };
  if (bound.assessment.status !== "sufficient" || bound.acquisition.status !== "complete")
    return { frames: null, issue: "insufficient_sequence" };
  const measured = bound.assessment.transitions[index];
  if (!measured?.at) return { frames: null, issue: "no_transition_anchor" };
  const actor = bound.assessment.actorFrames.find((item) => item.actor === timing.actor);
  if (!actor) return { frames: null, issue: "no_actor_frames" };
  const anchorMs = Date.parse(measured.at);
  const coverage = transitionCoverage({
    actor: actor.actor,
    frames: bound.acquisition.frames.filter((frame) => frame.playerUserId === actor.userId),
    anchorMs,
    binding: bound.plan.requiredTransitions[index]!,
    maximumGapMs: bound.plan.maximumGapMs,
    clock,
  });
  const selected = [
    ...new Set(
      [coverage.before, ...coverage.effect, coverage.afterEffect, coverage.afterHold].filter(
        (frame) => frame !== null,
      ),
    ),
  ];
  const frames: RecordedFrame[] = [];
  for (const frame of selected) {
    const bytes = await files.bytes(`${base}/${bound.prefix}${frame.file}`, MAX_CAPTURE_BYTES);
    assertSequenceBytes(frame, bytes);
    const startMs = Date.parse(frame.startedAt) - clock.offsetMs - anchorMs;
    frames.push({
      id: frame.file,
      phaseId: timing.transitionId,
      recordedMs: frame === coverage.before ? startMs : Math.max(0, startMs),
      raster: decodeCaptureImage(bytes, frame.mediaType),
    });
  }
  return frames.length ? { frames, issue: null } : { frames: null, issue: "no_actor_frames" };
}

function inside(region: PixelRegion, width: number, height: number) {
  return region.x + region.width <= width && region.y + region.height <= height;
}
/** An authored rectangle or grid that does not fit the recorded frames gives an issue. */
function fitIssue(
  frames: RecordedFrame[],
  region: EffectRegion | null,
  excluded: PixelRegion[],
  grid: { width: number; height: number } | null,
): string | null {
  const { width, height } = frames[0]!.raster;
  if (frames.some((frame) => frame.raster.width !== width || frame.raster.height !== height))
    return "frame_size_differs";
  if (
    (region && !inside(region.rectangle, width, height)) ||
    excluded.some((item) => !inside(item, width, height))
  )
    return "region_outside_frame";
  const area = region?.rectangle ?? { width, height };
  if (grid && (grid.width > area.width || grid.height > area.height))
    return "reference_grid_too_large";
  return null;
}
const emptyValues = () =>
  Object.fromEntries(PIXEL_MEASURES.map((measure) => [measure, null])) as Record<
    PixelMeasure,
    number | null
  >;

/**
 * Measure each completed capture for each criterion that has a pixel rule. Call this only
 * after the operation read verified each capture receipt. A capture without a completed
 * receipt has no record, so the analysis counts it in `missing`.
 */
export async function measureProtocolCaptures(input: {
  root: string;
  manifest: RunOperationManifest;
  plan: ExperimentPlan;
  events: RunOperationEvent[];
}): Promise<CaptureMeasurement[]> {
  const { manifest, plan } = input;
  const ladder = plan.baselines;
  if (!ladder?.rules.length) return [];
  const files = new RepositoryFiles(input.root);
  const receipts = new Map(
    input.events
      .filter((event) => event.stage === "final_capture" && event.kind === "completed")
      .map((event) => [event.unitId!, event]),
  );
  const timingOf = (evalId: string, viewId: string): MeasurementTiming => {
    const timing = ladder.measurement.timing.find(
      (item) => item.evalId === evalId && item.viewId === viewId,
    );
    if (!timing) throw new Error("A measured view has no timing entry");
    return timing;
  };
  const read = async (captureId: string): Promise<MeasuredFrames | null> => {
    const receipt = receipts.get(captureId);
    if (!receipt) return null;
    const capture = plan.captures.find((item) => item.id === captureId)!;
    const base = `.basalt-evals/eval-operations/${manifest.id}/capture/${captureId}/studio`;
    const evidence = await files.json<StudioEvidence>(`${base}/evidence.json`);
    if (hashJson(evidence) !== receipt.artifactHashes[1])
      throw new Error("Measured evidence differs from its capture receipt");
    const timing = timingOf(capture.evalId, capture.viewId);
    if (timing.kind === "stills") return stillFrames(files, base, evidence, timing.captures);
    const sequence = frozenSequencePlan(manifest, captureId, evidence.candidateHash);
    if (!sequence) throw new Error("A sequence timing entry names a view without a sequence");
    const signed = await files.json<SignedWorkerManifest>(`${base}/native/manifest.json`);
    return sequenceFrames(
      files,
      base,
      await readBoundSequence(files.path(base), signed, sequence),
      timing,
    );
  };
  const records: CaptureMeasurement[] = [];
  const ruled = (evalId: string) =>
    [
      ...new Set(
        ladder.rules.filter((rule) => rule.evalId === evalId).map((rule) => rule.criterionId),
      ),
    ].sort(compareCodeUnits);
  // One view at a time, so that only the exemplar frames of that view stay in memory.
  const groups = [
    ...new Set(plan.captures.map((capture) => JSON.stringify([capture.evalId, capture.viewId]))),
  ].sort(compareCodeUnits);
  for (const group of groups) {
    const [evalId, viewId] = JSON.parse(group) as [string, string];
    const criteria = ruled(evalId);
    if (!criteria.length) continue;
    const exemplarId = ladder.reference?.exemplars.find((item) => item.evalId === evalId)?.sourceId;
    const exemplars = new Map<string, RecordedFrame[]>();
    for (const capture of plan.captures.filter(
      (item) => item.subjectId === exemplarId && item.viewId === viewId,
    )) {
      const result = await read(capture.id);
      if (result?.frames) exemplars.set(capture.id, result.frames);
    }
    const excluded = ladder.measurement.excluded
      .filter((item) => item.evalId === evalId && item.viewId === viewId)
      .map((item) => item.rectangle);
    for (const capture of plan.captures
      .filter((item) => item.evalId === evalId && item.viewId === viewId)
      .sort((a, b) => compareCodeUnits(a.id, b.id))) {
      const result = exemplars.has(capture.id)
        ? { frames: exemplars.get(capture.id)!, issue: null }
        : await read(capture.id);
      if (!result) continue;
      const others = [...exemplars.entries()]
        .filter(([id]) => id !== capture.id)
        .map(([, frames]) => frames);
      const reference =
        ladder.reference && exemplarId
          ? {
              exemplars: others,
              grid: ladder.reference.grid,
              toleranceMs: ladder.reference.toleranceMs,
            }
          : null;
      for (const criterionId of criteria) {
        const region = authoredRegion(ladder, evalId, viewId, criterionId);
        const unmeasured = (issue: string) =>
          records.push({
            captureId: capture.id,
            criterionId,
            scope: region ? "authored_region" : "whole_frame",
            issue,
            values: emptyValues(),
          });
        if (!result.frames) {
          unmeasured(result.issue);
          continue;
        }
        const issue = fitIssue(result.frames, region, excluded, reference?.grid ?? null);
        if (issue) {
          unmeasured(issue);
          continue;
        }
        const measured = measureCapture({
          frames: result.frames,
          region,
          excluded,
          changeThreshold: ladder.measurement.changeThreshold,
          onsetPixels: ladder.measurement.onsetPixels,
          reference,
        });
        records.push({
          captureId: capture.id,
          criterionId,
          scope: measured.scope,
          issue: measured.issue,
          values: measured.values,
        });
      }
    }
  }
  return records;
}
