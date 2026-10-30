import { MAXIMUM_PRESENTED_FRAMES, stableJson } from "../../contracts/src/index.js";
import type { BuildName, ComparisonOrder } from "../../contracts/src/exemplars.js";
import type { ModelImage } from "../../model-client/src/contracts.js";
import { evidenceImageLabels, type LabelledFrame, type LabelTransition } from "./image-labels.js";

/*
 * Rendered evidence of two builds in one request. Code pairs the images of the two builds by
 * recorded phase and time, never by frame index. Each image label names its build with a
 * neutral name: Build A is the first build of the order and Build B is the second.
 */

/** Each build of a paired request uses half of the image room of one request. */
export const PAIRED_BUILD_ROOM = MAXIMUM_PRESENTED_FRAMES / 2;
/** The largest serialized paired context, in UTF-8 bytes. Each paired request obeys it. */
export const MAX_PAIRED_CONTEXT_BYTES = 65_536;

/** The rendered evidence of one build, in the request order of that build alone. */
export interface BuildEvidence {
  frames: LabelledFrame[];
  transitions: LabelTransition[];
  images: ModelImage[];
  /** The declared recorder cadence, or null when the build has no recorded sequence. */
  samplingIntervalMs: number | null;
}

/**
 * The recorded phase of a frame: one transition of one player, one phase capture, or the
 * recording of one player when no anchor was measured. The offset is from the anchor.
 */
interface PhaseMark {
  key: string | null;
  player: string | null;
  phase: { kind: "transition" | "capture"; id: string } | { kind: "recording" } | null;
  offsetMs: number;
}

export interface FrameAlignment {
  toleranceMs: number;
  /** Paired frames, in the order of the build under judgment. Each index is a frame index. */
  pairs: Array<{
    candidate: number;
    exemplar: number;
    player: string | null;
    phase: NonNullable<PhaseMark["phase"]>;
    offsetsMs: { candidate: number; exemplar: number };
  }>;
  candidateOnly: number[];
  exemplarOnly: number[];
}

function assertBuild(build: BuildEvidence, label: string) {
  if (
    !Array.isArray(build.frames) ||
    !Array.isArray(build.images) ||
    build.frames.length !== build.images.length ||
    !build.images.length ||
    build.images.length > PAIRED_BUILD_ROOM ||
    build.frames.some((frame) => frame.build !== undefined) ||
    build.transitions.some((transition) => transition.build !== undefined)
  )
    throw new Error(
      `The ${label} needs 1 to ${PAIRED_BUILD_ROOM} labelled images that name no build yet`,
    );
}

/**
 * The facts that pairing reads: the player, the clock and the selection roles of each frame,
 * and the measured anchors. A request about two builds and a side-by-side view use them.
 */
export interface AlignableFrames {
  frames: Array<Pick<LabelledFrame, "player" | "clock" | "roles">>;
  transitions: Array<Pick<LabelTransition, "transitionId" | "anchorMs">>;
}

function phaseMark(
  frame: AlignableFrames["frames"][number],
  transitions: AlignableFrames["transitions"],
): PhaseMark {
  if (frame.clock.kind === "presentation")
    return {
      key: `capture:${frame.clock.captureId}`,
      player: null,
      phase: { kind: "capture", id: frame.clock.captureId },
      offsetMs: 0,
    };
  if (frame.clock.kind === "unstated")
    return { key: null, player: frame.player, phase: null, offsetMs: 0 };
  const { startMs } = frame.clock;
  const named = frame.roles.map((role) => role.split(":")[1]).filter(Boolean);
  // The first transition that the roles name, else the nearest measured anchor, as the label.
  const anchor =
    transitions.find((transition) => named.includes(transition.transitionId)) ??
    transitions.reduce<AlignableFrames["transitions"][number] | null>(
      (best, transition) =>
        best && Math.abs(startMs - best.anchorMs) <= Math.abs(startMs - transition.anchorMs)
          ? best
          : transition,
      null,
    );
  return anchor
    ? {
        key: stableJson([frame.player, "transition", anchor.transitionId]),
        player: frame.player,
        phase: { kind: "transition", id: anchor.transitionId },
        offsetMs: startMs - anchor.anchorMs,
      }
    : {
        key: stableJson([frame.player, "recording"]),
        player: frame.player,
        phase: { kind: "recording" },
        offsetMs: startMs,
      };
}

/** The player, the recorded phase and the offset from its anchor of one frame with a clock. */
export function framePhase(
  frame: AlignableFrames["frames"][number],
  transitions: AlignableFrames["transitions"],
): Pick<FrameAlignment["pairs"][number], "player" | "phase"> & { offsetMs: number } {
  const { player, phase, offsetMs } = phaseMark(frame, transitions);
  if (!phase) throw new Error("A frame without a stated clock has no recorded phase");
  return { player, phase, offsetMs };
}

/**
 * Pair the frames of the build under judgment with the frames of one exemplar, in one request.
 * Each build has 1 to `PAIRED_BUILD_ROOM` labelled images. `alignFrames` pairs them.
 */
export function alignBuildFrames(
  candidate: BuildEvidence,
  exemplar: BuildEvidence,
  toleranceMs: number,
): FrameAlignment {
  assertBuild(candidate, "build under judgment");
  assertBuild(exemplar, "exemplar");
  return alignFrames(candidate, exemplar, toleranceMs);
}

/**
 * Pair the frames of two builds. Two frames pair only when they have the same player and
 * recorded phase, and their offsets from the anchor differ by the tolerance or less. The
 * closest offsets pair first; earlier frames win a tie. A frame pairs at most once. A frame
 * index never pairs two frames.
 */
export function alignFrames(
  candidate: AlignableFrames,
  exemplar: AlignableFrames,
  toleranceMs: number,
): FrameAlignment {
  if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 60_000)
    throw new Error("A pairing tolerance is 0 to 60000 ms");
  const left = candidate.frames.map((frame) => phaseMark(frame, candidate.transitions));
  const right = exemplar.frames.map((frame) => phaseMark(frame, exemplar.transitions));
  const options: Array<{ candidate: number; exemplar: number; distance: number }> = [];
  left.forEach((mark, i) =>
    right.forEach((other, j) => {
      const distance = Math.abs(mark.offsetMs - other.offsetMs);
      if (mark.key !== null && mark.key === other.key && distance <= toleranceMs)
        options.push({ candidate: i, exemplar: j, distance });
    }),
  );
  options.sort(
    (a, b) => a.distance - b.distance || a.candidate - b.candidate || a.exemplar - b.exemplar,
  );
  const usedLeft = new Set<number>(),
    usedRight = new Set<number>();
  const pairs: FrameAlignment["pairs"] = [];
  for (const option of options) {
    if (usedLeft.has(option.candidate) || usedRight.has(option.exemplar)) continue;
    usedLeft.add(option.candidate);
    usedRight.add(option.exemplar);
    const mark = left[option.candidate]!;
    pairs.push({
      candidate: option.candidate,
      exemplar: option.exemplar,
      player: mark.player,
      phase: mark.phase!,
      offsetsMs: { candidate: mark.offsetMs, exemplar: right[option.exemplar]!.offsetMs },
    });
  }
  pairs.sort((a, b) => a.candidate - b.candidate);
  return {
    toleranceMs,
    pairs,
    candidateOnly: left.flatMap((_, index) => (usedLeft.has(index) ? [] : [index])),
    exemplarOnly: right.flatMap((_, index) => (usedRight.has(index) ? [] : [index])),
  };
}

/** The neutral model context of one paired request. Image numbers start at 1. */
export interface PairedFrameContext {
  builds: ["A", "B"];
  toleranceMs: number;
  samplingIntervalMs: { A: number | null; B: number | null };
  /** Images of the two builds at the same recorded phase and time, Build A first. */
  pairs: Array<{
    images: [number, number];
    player: string | null;
    phase: FrameAlignment["pairs"][number]["phase"];
    offsetsMs: { A: number; B: number };
  }>;
  /** Images with no image of the other build at the same recorded phase and time. */
  unpaired: Array<{ image: number; build: BuildName }>;
}

/**
 * The images and the context of one order. Both orders use one alignment, so they show the
 * same pairs; only the build names and the position in each pair change.
 */
export function pairedPresentation(
  candidate: BuildEvidence,
  exemplar: BuildEvidence,
  alignment: FrameAlignment,
  order: ComparisonOrder,
): { images: ModelImage[]; context: PairedFrameContext } {
  assertBuild(candidate, "build under judgment");
  assertBuild(exemplar, "exemplar");
  const indexes = [
    ...alignment.pairs.flatMap((pair) => [pair.candidate, pair.exemplar]),
    ...alignment.candidateOnly,
    ...alignment.exemplarOnly,
  ];
  if (
    alignment.pairs.length * 2 + alignment.candidateOnly.length + alignment.exemplarOnly.length !==
      candidate.frames.length + exemplar.frames.length ||
    new Set([...alignment.pairs.map((pair) => pair.candidate), ...alignment.candidateOnly]).size !==
      candidate.frames.length ||
    new Set([...alignment.pairs.map((pair) => pair.exemplar), ...alignment.exemplarOnly]).size !==
      exemplar.frames.length ||
    indexes.some((index) => !Number.isSafeInteger(index) || index < 0)
  )
    throw new Error("The alignment does not cover each frame of both builds exactly once");
  const candidateFirst = order === "candidate_first";
  if (!candidateFirst && order !== "exemplar_first") throw new Error("Unknown comparison order");
  const names = {
    candidate: candidateFirst ? "A" : "B",
    exemplar: candidateFirst ? "B" : "A",
  } as const;
  const sides = { candidate, exemplar };
  type Side = keyof typeof sides;
  const slots: Array<{ side: Side; index: number }> = [];
  const pairs: PairedFrameContext["pairs"] = [];
  for (const pair of alignment.pairs) {
    const first: Side = candidateFirst ? "candidate" : "exemplar";
    const second: Side = candidateFirst ? "exemplar" : "candidate";
    slots.push({ side: first, index: pair[first] }, { side: second, index: pair[second] });
    pairs.push({
      images: [slots.length - 1, slots.length],
      player: pair.player,
      phase: pair.phase,
      offsetsMs: { A: pair.offsetsMs[first], B: pair.offsetsMs[second] },
    });
  }
  const unpaired: PairedFrameContext["unpaired"] = [];
  const only = { candidate: alignment.candidateOnly, exemplar: alignment.exemplarOnly };
  // The unpaired frames of Build A come first, then those of Build B.
  for (const side of (candidateFirst
    ? ["candidate", "exemplar"]
    : ["exemplar", "candidate"]) as Side[])
    for (const index of only[side]) {
      slots.push({ side, index });
      unpaired.push({ image: slots.length, build: names[side] });
    }
  const labels = evidenceImageLabels(
    slots.map(({ side, index }) => ({ ...sides[side].frames[index]!, build: names[side] })),
    (["candidate", "exemplar"] as const).flatMap((side) =>
      sides[side].transitions.map((transition) => ({ ...transition, build: names[side] })),
    ),
  );
  const images = slots.map(({ side, index }, position) => ({
    ...sides[side].images[index]!,
    label: labels[position]!,
  }));
  if (images.length > MAXIMUM_PRESENTED_FRAMES)
    throw new Error("A paired request exceeds the fixed 64-image request bound");
  const context: PairedFrameContext = {
    builds: ["A", "B"],
    toleranceMs: alignment.toleranceMs,
    samplingIntervalMs: {
      A: sides[candidateFirst ? "candidate" : "exemplar"].samplingIntervalMs,
      B: sides[candidateFirst ? "exemplar" : "candidate"].samplingIntervalMs,
    },
    pairs,
    unpaired,
  };
  if (Buffer.byteLength(stableJson(context), "utf8") > MAX_PAIRED_CONTEXT_BYTES)
    throw new Error("The paired context exceeds its byte bound");
  return { images, context };
}
