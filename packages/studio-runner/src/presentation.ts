import {
  compareCodeUnits,
  MAXIMUM_PRESENTED_FRAMES,
  type StudioSequenceView,
} from "../../contracts/src/index.js";
import { transitionCoverage, type SequenceAssessment } from "./sequence.js";
import type { SequenceAcquisition, SequenceFrame } from "./studio-mcp.js";

export type PresentationTreatment = "still" | "sequence" | "grounded-sequence";

/**
 * The sequence frames of one judgment: the authored budget of the view, within the room that
 * the phase captures leave in one request. Dispatch and the quote use this one function. A
 * request about two builds gives each build half of the request, so its room is smaller.
 */
export function sequenceFrameBudget(
  view: StudioSequenceView,
  phaseCaptureCount: number,
  requestRoom: number = MAXIMUM_PRESENTED_FRAMES,
): number {
  if (
    !Number.isSafeInteger(requestRoom) ||
    requestRoom < 1 ||
    requestRoom > MAXIMUM_PRESENTED_FRAMES
  )
    throw new Error("The image room of one build is 1 to 64 images");
  if (
    !Number.isSafeInteger(phaseCaptureCount) ||
    phaseCaptureCount < 0 ||
    phaseCaptureCount >= requestRoom
  )
    throw new Error(
      "The phase images of the criteria fill the image room of the request. The request has no room for the recorded sequence. Use fewer phase images.",
    );
  return Math.min(view.frameBudget, requestRoom - phaseCaptureCount);
}

/**
 * Each selected frame carries the fixed roles that explain why the rule selected it:
 * `before:<id>` is the last frame that ends before the transition starts;
 * `effect:<id>` is a frame that can overlap the authored effect window;
 * `after-effect:<id>` is the first frame that starts after an observed state change;
 * `after-hold:<id>` is the first frame that starts after the effect window and the hold;
 * `horizon-end:<id>` is the last frame, because the recording never observed the effect;
 * `end` is the last frame of an actor in a still presentation;
 * `uniform` is a frame that fills the request evenly after the transition frames.
 */
interface PresentedFrame {
  id: string;
  actor: string;
  file: string;
  hash: string;
  playerUserId: number;
  startedAt: string;
  endedAt: string;
  mediaType: SequenceFrame["mediaType"];
  roles: string[];
}

export interface FramePresentation {
  treatment: PresentationTreatment;
  status: "sufficient" | "insufficient";
  /** Why the frames cannot support a rendered judgment. Empty when sufficient. */
  reasons: string[];
  /** The effective frame budget of this presentation. */
  frameBudget: number;
  /** Frames that the transition rule requires, before effect windows and uniform fill. */
  requiredFrameCount: number;
  frames: PresentedFrame[];
  /**
   * Neutral model context. No source, treatment label, oracle or engine outcome. The image
   * label of each frame states its roles.
   */
  context: {
    actors: string[];
    intervals: Array<{ frameId: string; actor: string; startMs: number; endMs: number }>;
  };
}

function interval(frame: SequenceFrame): [number, number] {
  const start = Date.parse(frame.startedAt);
  const end = Date.parse(frame.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error("Invalid frame acquisition interval");
  return [start, end];
}

/** Evenly spaced indexes. One index selects the first item, or the middle item for a window. */
function spread(count: number, keep: number, single: "first" | "middle"): number[] {
  if (keep >= count) return Array.from({ length: count }, (_, index) => index);
  if (keep <= 0) return [];
  if (keep === 1) return [single === "first" ? 0 : Math.floor((count - 1) / 2)];
  return [
    ...new Set(
      Array.from({ length: keep }, (_, index) => Math.round((index * (count - 1)) / (keep - 1))),
    ),
  ];
}

/**
 * The fewest frames of an effect window that keep each unrecorded interval, from the end of
 * the before frame to the last frame of the window, at or below the maximum gap. From the
 * recorded end, the rule takes the frame that starts within the gap and ends last. Null means
 * that the window has a larger gap even with all of its frames.
 */
function effectCoverage(
  before: SequenceFrame,
  frames: SequenceFrame[],
  maximumGapMs: number,
): SequenceFrame[] | null {
  const spans = frames
    .map((frame) => ({ frame, span: interval(frame) }))
    .sort((left, right) => left.span[0] - right.span[0]);
  const last = spans.at(-1);
  if (!last) return [];
  const chosen: SequenceFrame[] = [];
  let recordedUntil = interval(before)[1];
  let index = 0;
  while (last.span[0] > recordedUntil + maximumGapMs) {
    let best: (typeof spans)[number] | null = null;
    for (; index < spans.length && spans[index]!.span[0] <= recordedUntil + maximumGapMs; index++)
      if (!best || spans[index]!.span[1] > best.span[1]) best = spans[index]!;
    if (!best || best.span[1] <= recordedUntil) return null;
    chosen.push(best.frame);
    recordedUntil = best.span[1];
  }
  chosen.push(last.frame);
  return chosen;
}

/**
 * Select frames with one fixed rule before any judgment. For each transition the rule keeps
 * the last frame before it, the first frame after an observed state change, one frame after
 * the declared hold and the fewest effect-window frames that keep the maximum gap. These
 * required frames must fit in the frame budget, or the evidence is insufficient. The other
 * effect-window frames come next, then an even fill up to the budget. The rule never inspects
 * pixels or judgment output, and the original full-rate frames remain in the signed native
 * receipt.
 */
export function presentSequenceFrames(input: {
  plan: StudioSequenceView;
  acquisition: SequenceAcquisition;
  assessment: SequenceAssessment;
  treatment: PresentationTreatment;
  /** Phase captures in the same request. They reduce the room for sequence frames. */
  phaseCaptureCount?: number;
  /** The images of the request that this build can use. A request about two builds halves it. */
  requestRoom?: number;
}): FramePresentation {
  const { plan, acquisition, assessment, treatment } = input;
  const cap = sequenceFrameBudget(plan, input.phaseCaptureCount ?? 0, input.requestRoom);
  if (!["still", "sequence", "grounded-sequence"].includes(treatment))
    throw new Error("Unknown feedback treatment");
  if (
    acquisition.schema !== "basalt-evals/sequence-acquisition" ||
    assessment.schema !== "basalt-evals/sequence-assessment" ||
    assessment.actorFrames.length === 0 ||
    assessment.transitions.length !== plan.requiredTransitions.length ||
    assessment.transitions.some(
      (transition, index) => transition.transitionId !== plan.requiredTransitions[index]!.id,
    )
  )
    throw new Error("Only an assessed sequence of this view can enter a visual prompt");
  const actors = assessment.actorFrames.map(({ actor }) => actor);
  const insufficient = (reasons: string[]): FramePresentation => ({
    treatment,
    status: "insufficient",
    reasons: [...new Set(reasons)],
    frameBudget: cap,
    requiredFrameCount: 0,
    frames: [],
    context: { actors, intervals: [] },
  });
  const clock = assessment.clock;
  if (acquisition.status !== "complete" || assessment.status !== "sufficient" || clock === null)
    return insufficient(["Rendered sequence acquisition is incomplete", ...assessment.reasons]);
  const ids = new Set<number>();
  const files = new Set<string>();
  for (const frame of acquisition.frames) {
    if (files.has(frame.file)) throw new Error("Duplicate source frame identity");
    files.add(frame.file);
    interval(frame);
  }
  const streams = assessment.actorFrames.map((actor) => {
    if (ids.has(actor.userId)) throw new Error("Ambiguous player identity in feedback evidence");
    ids.add(actor.userId);
    const frames = acquisition.frames.filter((frame) => frame.playerUserId === actor.userId);
    if (frames.length === 0) throw new Error(`Missing frames for ${actor.actor}`);
    if (
      frames.some(
        (frame, index) => index > 0 && interval(frame)[0] < interval(frames[index - 1]!)[0],
      )
    )
      throw new Error(`Reordered source frames for ${actor.actor}`);
    return { actor: actor.actor, frames };
  });
  if (acquisition.frames.some((frame) => !ids.has(frame.playerUserId)))
    throw new Error("Unbound player frame in feedback evidence");

  const roles = new Map<string, Set<string>>();
  const owner = new Map<string, { actor: string; frame: SequenceFrame }>();
  const assign = (actor: string, frame: SequenceFrame, role: string) => {
    owner.set(frame.file, { actor, frame });
    roles.set(frame.file, (roles.get(frame.file) ?? new Set()).add(role));
  };
  const reasons: string[] = [];
  const windows: Array<{
    actor: string;
    transitionId: string;
    before: SequenceFrame;
    frames: SequenceFrame[];
  }> = [];
  for (const { actor, frames } of streams) {
    for (const [index, binding] of plan.requiredTransitions.entries()) {
      const measured = assessment.transitions[index]!;
      if (!measured.at) {
        if (binding.source.kind === "state" && measured.covered)
          assign(actor, frames.at(-1)!, `horizon-end:${binding.id}`);
        else reasons.push(`Transition ${binding.id} has no measured anchor`);
        continue;
      }
      const anchorMs = Date.parse(measured.at);
      if (!Number.isFinite(anchorMs)) throw new Error("Invalid measured transition time");
      const coverage = transitionCoverage({
        actor,
        frames,
        anchorMs,
        binding,
        maximumGapMs: plan.maximumGapMs,
        clock,
      });
      if (coverage.reasons.length) {
        reasons.push(...coverage.reasons);
        continue;
      }
      assign(actor, coverage.afterHold!, `after-hold:${binding.id}`);
      if (treatment === "still") continue;
      assign(actor, coverage.before!, `before:${binding.id}`);
      if (coverage.afterEffect) assign(actor, coverage.afterEffect, `after-effect:${binding.id}`);
      windows.push({
        actor,
        transitionId: binding.id,
        before: coverage.before!,
        frames: coverage.effect,
      });
    }
    if (treatment === "still") assign(actor, frames.at(-1)!, "end");
  }
  if (reasons.length) return insufficient(reasons);

  // The fewest effect frames that keep the maximum gap are required frames too.
  for (const window of windows) {
    const coverage = effectCoverage(window.before, window.frames, plan.maximumGapMs);
    if (!coverage)
      return insufficient([
        `Actor ${window.actor} has a frame gap above ${plan.maximumGapMs} ms in the effect window of ${window.transitionId}`,
      ]);
    for (const frame of coverage) assign(window.actor, frame, `effect:${window.transitionId}`);
  }
  const requiredFrameCount = roles.size;
  if (requiredFrameCount > cap)
    return insufficient([
      `The frame budget of ${cap} cannot hold the ${requiredFrameCount} required frames: the transition frames and the fewest effect-window frames within the ${plan.maximumGapMs} ms maximum gap`,
    ]);

  // The other effect-window frames come before the even fill. If they do not fit, each window
  // receives room in proportion to its size, spread evenly.
  const pending = windows.map((window) => window.frames.filter((frame) => !roles.has(frame.file)));
  const pendingCount = pending.reduce((sum, frames) => sum + frames.length, 0);
  const room = cap - roles.size;
  for (const [index, window] of windows.entries()) {
    const size = pending[index]!.length;
    const keep = pendingCount <= room ? size : Math.floor((room * size) / pendingCount);
    for (const position of spread(size, keep, "middle"))
      assign(window.actor, pending[index]![position]!, `effect:${window.transitionId}`);
    for (const frame of window.frames)
      if (roles.has(frame.file)) assign(window.actor, frame, `effect:${window.transitionId}`);
  }

  if (treatment !== "still") {
    const fill = cap - roles.size;
    const candidates = streams.map(({ frames }) =>
      frames.filter((frame) => !roles.has(frame.file)),
    );
    for (const [index, { actor }] of streams.entries()) {
      const quota = Math.floor(fill / streams.length) + (index < fill % streams.length ? 1 : 0);
      const choices = candidates[index]!;
      for (const position of spread(choices.length, quota, "first"))
        assign(actor, choices[position]!, "uniform");
    }
  }

  const ordered = [...owner.values()].sort(
    (a, b) => interval(a.frame)[0] - interval(b.frame)[0] || compareCodeUnits(a.actor, b.actor),
  );
  if (ordered.length === 0 || ordered.length > cap)
    throw new Error("Feedback prompt has no bounded frame selection");
  const start = Date.parse(acquisition.startedAt);
  if (!Number.isFinite(start)) throw new Error("Invalid sequence acquisition start");
  const frames = ordered.map(({ actor, frame }, index) => ({
    id: `frame-${index + 1}`,
    actor,
    file: frame.file,
    hash: frame.hash,
    playerUserId: frame.playerUserId,
    startedAt: frame.startedAt,
    endedAt: frame.endedAt,
    mediaType: frame.mediaType,
    roles: [...roles.get(frame.file)!].sort(compareCodeUnits),
  }));
  return {
    treatment,
    status: "sufficient",
    reasons: [],
    frameBudget: cap,
    requiredFrameCount,
    frames,
    context: {
      actors,
      intervals: frames.map((frame) => ({
        frameId: frame.id,
        actor: frame.actor,
        startMs: Date.parse(frame.startedAt) - start,
        endMs: Date.parse(frame.endedAt) - start,
      })),
    },
  };
}
