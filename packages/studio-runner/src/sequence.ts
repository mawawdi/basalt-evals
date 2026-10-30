import {
  contentHash,
  hashJson,
  assertStudioSequenceView,
  studioSequenceView,
  MAX_SEQUENCE_FRAMES,
  MAX_CAPTURE_BYTES,
  type SequenceTransitionBinding,
  type StudioSequenceView,
  type StudioScenarioReport,
  type StudioCollectionPlan,
} from "../../contracts/src/index.js";
import type { SequenceAcquisition, SequenceFrame } from "./studio-mcp.js";
import { isRecord } from "../../contracts/src/validation.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MIN_EPOCH_SECONDS = 1_500_000_000;
const MAX_EPOCH_SECONDS = 4_102_444_800;

/** A frozen request for one scenario/view. Three passes use three fresh sessions. */
export interface SequencePlan extends StudioSequenceView {
  schema: "basalt-evals/sequence-plan";
  suiteHash: string;
  sourceHash: string;
  implementationCommit: string;
  viewId: string;
}

/**
 * Transition and sample times use the Studio server clock. Frame intervals use the host wall
 * clock. Host time is Studio time plus offsetMs, within plus or minus uncertaintyMs. The
 * host-bracketed clock probes of the recorder set it (see sequence-timing.ts).
 */
export interface ClockAlignment {
  offsetMs: number;
  uncertaintyMs: number;
}

export interface SequenceAssessment {
  schema: "basalt-evals/sequence-assessment";
  planHash: string;
  status: "sufficient" | "insufficient";
  reasons: string[];
  /**
   * The alignment that every frame and transition comparison used. It is null when no clock
   * probe exists; then the assessment is insufficient.
   */
  clock: ClockAlignment | null;
  actorFrames: Array<{
    actor: string;
    userId: number;
    frameCount: number;
    dimensions: string[];
    cameraSamples: number;
    avatarSamples: number;
    gameViewports: string[];
  }>;
  /**
   * `at` is the measured anchor on the Studio clock. It is "" when no anchor was measured. A
   * covered state transition with no anchor is an effect that the recording never observed.
   */
  transitions: Array<{ transitionId: string; at: string; covered: boolean; gapMs: number | null }>;
  stateChanges: Array<{
    context: string;
    path: string;
    attribute: string;
    at: string;
    value: string | number | boolean | null;
  }>;
}

function vector(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (number) =>
        typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 100_000,
    )
  );
}

export function assertSequencePlan(
  value: unknown,
  studio?: StudioCollectionPlan,
): asserts value is SequencePlan {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "camera,frameBudget,implementationCommit,maximumGapMs,requiredTransitions,scenarioId,schema,sourceHash,suiteHash,viewId,viewport" ||
    value.schema !== "basalt-evals/sequence-plan" ||
    typeof value.suiteHash !== "string" ||
    !HASH.test(value.suiteHash) ||
    typeof value.sourceHash !== "string" ||
    !HASH.test(value.sourceHash) ||
    typeof value.implementationCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.implementationCommit) ||
    typeof value.viewId !== "string" ||
    !ID.test(value.viewId)
  )
    throw new Error("Invalid frozen sequence plan");
  assertStudioSequenceView(studioSequenceView(value as unknown as StudioSequenceView), studio);
}

function sequencePlanHash(plan: SequencePlan): string {
  assertSequencePlan(plan);
  return hashJson(plan);
}

interface SequenceTransition {
  stepId: string;
  /** The actor context whose signed report records the action. */
  context: string;
  /** actedAt: epoch seconds on the Studio clock at the start of the action. */
  at: number;
}

/** The action transitions that the signed scenario reports record. */
export function reportActionTransitions(reports: StudioScenarioReport[]): SequenceTransition[] {
  return reports.flatMap((report) =>
    report.steps.flatMap((step) =>
      step.actedAt === undefined
        ? []
        : [{ stepId: step.stepId, context: report.context, at: step.actedAt }],
    ),
  );
}

/** Covers one frame acquisition after the hold, and the clock uncertainty. */
export const SEQUENCE_SETTLE_MARGIN_MS = 2_000;

/**
 * The recorder needs a frame after the hold of each required transition, so the scenario
 * stays in Play until this host time. Host and Studio share the clock of one machine. The
 * reports do not record the time of a state change, so its window starts at completion.
 */
export function sequenceSettleAtMs(
  plan: Pick<SequencePlan, "requiredTransitions">,
  reports: StudioScenarioReport[],
  completedAtMs: number,
): number {
  const actions = reportActionTransitions(reports);
  let settleAt = completedAtMs;
  for (const binding of plan.requiredTransitions) {
    const source = binding.source;
    const anchors =
      source.kind === "action"
        ? actions.filter((entry) => entry.stepId === source.stepId).map((entry) => entry.at * 1000)
        : [completedAtMs];
    for (const anchor of anchors)
      settleAt = Math.max(
        settleAt,
        anchor + binding.effectWindowMs + binding.holdMs + SEQUENCE_SETTLE_MARGIN_MS,
      );
  }
  return settleAt;
}

export interface SequenceSample {
  context: string;
  userId: number;
  at: number;
  avatar: [number, number, number] | null;
  camera: {
    position: [number, number, number];
    look: [number, number, number];
    viewport: [number, number];
  } | null;
}

export interface SequenceStateChange {
  context: string;
  path: string;
  attribute: string;
  at: number;
  value: string | number | boolean | null;
}

export function parseSequenceStateChange(value: unknown): SequenceStateChange | null {
  if (
    !isRecord(value) ||
    typeof value.context !== "string" ||
    typeof value.path !== "string" ||
    typeof value.attribute !== "string" ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    value.at < MIN_EPOCH_SECONDS ||
    value.at > MAX_EPOCH_SECONDS ||
    !["string", "number", "boolean", "undefined"].includes(typeof value.value) ||
    (typeof value.value === "number" && !Number.isFinite(value.value))
  )
    return null;
  return {
    context: value.context,
    path: value.path,
    attribute: value.attribute,
    at: value.at,
    value: value.value === undefined ? null : (value.value as SequenceStateChange["value"]),
  };
}

export function parseSequenceSample(value: unknown): SequenceSample | null {
  if (
    !isRecord(value) ||
    "avatar" in value ||
    "camera" in value ||
    typeof value.context !== "string" ||
    !Number.isSafeInteger(value.userId) ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    value.at < MIN_EPOCH_SECONDS ||
    value.at > MAX_EPOCH_SECONDS
  )
    return null;
  const avatarParts = [value.avatarX, value.avatarY, value.avatarZ];
  const cameraParts = [
    value.cameraX,
    value.cameraY,
    value.cameraZ,
    value.lookX,
    value.lookY,
    value.lookZ,
    value.viewportWidth,
    value.viewportHeight,
  ];
  const avatar = avatarParts.every((part) => part === undefined)
    ? null
    : (avatarParts as [number, number, number]);
  const camera = cameraParts.every((part) => part === undefined)
    ? null
    : {
        position: cameraParts.slice(0, 3) as [number, number, number],
        look: cameraParts.slice(3, 6) as [number, number, number],
        viewport: cameraParts.slice(6, 8) as [number, number],
      };
  if (avatar !== null && !vector(avatar)) return null;
  if (
    camera !== null &&
    (!vector(camera.position) ||
      !vector(camera.look) ||
      camera.viewport.some((part) => !Number.isSafeInteger(part) || part < 1 || part > 4096))
  )
    return null;
  return {
    context: value.context,
    userId: value.userId as number,
    at: value.at,
    avatar,
    camera,
  };
}

function interval(frame: SequenceFrame): [number, number] | null {
  const start = Date.parse(frame.startedAt);
  const end = Date.parse(frame.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 5000
    ? [start, end]
    : null;
}

export function isClockAlignment(value: unknown): value is ClockAlignment {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === "offsetMs,uncertaintyMs" &&
    typeof value.offsetMs === "number" &&
    Number.isFinite(value.offsetMs) &&
    Math.abs(value.offsetMs) <= 60_000 &&
    typeof value.uncertaintyMs === "number" &&
    Number.isFinite(value.uncertaintyMs) &&
    value.uncertaintyMs >= 0 &&
    value.uncertaintyMs <= 60_000
  );
}

interface TransitionCoverage {
  /** The last frame that ends before the anchor, after the clock uncertainty. */
  before: SequenceFrame | null;
  /**
   * Every frame that can overlap the effect window: it is not wholly before the anchor after
   * the clock uncertainty, and it starts before the effect window ends.
   */
  effect: SequenceFrame[];
  /** For a state anchor, the first frame that starts after the observed effect. */
  afterEffect: SequenceFrame | null;
  /** The first frame that starts after the effect window and the declared hold. */
  afterHold: SequenceFrame | null;
  /** The largest unrecorded interval from the before frame to the after-hold frame. */
  gapMs: number | null;
  reasons: string[];
}

/**
 * The one frame sufficiency rule for a transition. The anchor uses the Studio clock and
 * frames use the host clock, so every comparison applies the explicit clock alignment.
 */
export function transitionCoverage(input: {
  actor: string;
  frames: SequenceFrame[];
  anchorMs: number;
  binding: SequenceTransitionBinding;
  maximumGapMs: number;
  clock: ClockAlignment;
}): TransitionCoverage {
  const { binding, clock } = input;
  const uncertainty = clock.uncertaintyMs;
  const anchor = input.anchorMs + clock.offsetMs;
  const effectEnd = anchor + binding.effectWindowMs;
  const holdEnd = effectEnd + binding.holdMs;
  const timed = input.frames
    .map((frame) => ({ frame, span: interval(frame) }))
    .filter((item): item is { frame: SequenceFrame; span: [number, number] } => item.span !== null)
    .sort((left, right) => left.span[0] - right.span[0]);
  let beforeIndex = -1;
  for (const [index, item] of timed.entries())
    if (item.span[1] + uncertainty <= anchor) beforeIndex = index;
  const afterHoldIndex = timed.findIndex((item) => item.span[0] - uncertainty >= holdEnd);
  const afterEffect =
    binding.source.kind === "state"
      ? (timed.find((item) => item.span[0] - uncertainty >= anchor)?.frame ?? null)
      : null;
  const reasons: string[] = [];
  if (beforeIndex < 0)
    reasons.push(`Actor ${input.actor} has no frame that ends before ${binding.id} starts`);
  if (binding.source.kind === "state" && !afterEffect)
    reasons.push(`Actor ${input.actor} has no frame after the observed effect of ${binding.id}`);
  if (afterHoldIndex < 0)
    reasons.push(`Actor ${input.actor} has no frame after the declared hold of ${binding.id}`);
  let gapMs: number | null = null;
  if (beforeIndex >= 0 && afterHoldIndex > beforeIndex) {
    let recordedUntil = timed[beforeIndex]!.span[1];
    gapMs = 0;
    for (const item of timed.slice(beforeIndex + 1, afterHoldIndex + 1)) {
      gapMs = Math.max(gapMs, item.span[0] - recordedUntil);
      recordedUntil = Math.max(recordedUntil, item.span[1]);
    }
    if (gapMs > input.maximumGapMs)
      reasons.push(
        `Actor ${input.actor} has a ${gapMs} ms frame gap in ${binding.id}; the view permits ${input.maximumGapMs} ms`,
      );
  }
  return {
    before: beforeIndex < 0 ? null : timed[beforeIndex]!.frame,
    effect: timed
      .filter((item) => item.span[1] + uncertainty > anchor && item.span[0] <= effectEnd)
      .map((item) => item.frame),
    afterEffect,
    afterHold: afterHoldIndex < 0 ? null : timed[afterHoldIndex]!.frame,
    gapMs,
    reasons,
  };
}

/**
 * A transition needs a frame that ends before its anchor, frames across its effect window and
 * a frame after its declared hold, with no gap above the view maximum. Sparse stills never
 * become video merely because a model describes motion.
 */
export function assessSequence(input: {
  plan: SequencePlan;
  acquisition: SequenceAcquisition;
  reports: StudioScenarioReport[];
  transitions: SequenceTransition[];
  samples: SequenceSample[];
  stateChanges: SequenceStateChange[];
  /** False when the trace stopped at its size limit, so later samples and changes are unknown. */
  traceComplete: boolean;
  expectedClients: number;
  /** The probe alignment, or null when the recording has no clock probe. */
  clock: ClockAlignment | null;
}): SequenceAssessment {
  const { plan, acquisition, clock } = input;
  assertSequencePlan(plan);
  const reasons: string[] = [];
  const actorFrames: SequenceAssessment["actorFrames"] = [];
  const transitions: SequenceAssessment["transitions"] = [];
  const aligned = isClockAlignment(clock);
  if (!input.traceComplete)
    reasons.push(
      "The Studio trace reached its size limit, so the samples and state changes after that point are unknown",
    );
  if (clock === null) reasons.push("No clock probe aligns the Studio clock with the frames");
  else if (!aligned) reasons.push("Clock alignment between Studio and frames is invalid");
  if (
    acquisition.schema !== "basalt-evals/sequence-acquisition" ||
    acquisition.status !== "complete" ||
    acquisition.expectedClients !== input.expectedClients
  )
    reasons.push("Sequence acquisition did not complete for the declared clients");
  if (
    acquisition.frames.length < (plan.requiredTransitions.length === 0 ? 1 : 2) ||
    acquisition.frames.length > MAX_SEQUENCE_FRAMES
  )
    reasons.push("Sequence has no bounded frame series");
  const actorIds = new Map<string, number>();
  for (const report of input.reports) {
    for (const actor of report.actors) {
      const previous = actorIds.get(actor.actor);
      if (previous !== undefined && previous !== actor.userId)
        reasons.push(`Actor ${actor.actor} has conflicting runtime identities`);
      actorIds.set(actor.actor, actor.userId);
    }
  }
  if (
    actorIds.size !== input.expectedClients ||
    new Set(actorIds.values()).size !== input.expectedClients
  )
    reasons.push("Runtime report lacks unambiguous player identities");
  const byUser = new Map<number, SequenceFrame[]>();
  for (const frame of acquisition.frames) {
    if (
      !HASH.test(frame.hash) ||
      !/^frame-\d{4,5}\.(png|jpg)$/.test(frame.file) ||
      !Number.isSafeInteger(frame.bytes) ||
      frame.bytes < 1 ||
      frame.bytes > MAX_CAPTURE_BYTES ||
      !interval(frame)
    )
      reasons.push(`Invalid frame identity or acquisition interval: ${frame.file}`);
    if (!byUser.has(frame.playerUserId)) byUser.set(frame.playerUserId, []);
    byUser.get(frame.playerUserId)!.push(frame);
  }
  for (const [actor, userId] of actorIds) {
    const frames = byUser.get(userId) ?? [];
    const dimensions = [...new Set(frames.map((frame) => `${frame.width}×${frame.height}`))];
    const samples = input.samples.filter(
      (sample) => sample.context === actor && sample.userId === userId,
    );
    const cameraSamples = samples.filter((sample) => sample.camera !== null);
    const avatarSamples = samples.filter((sample) => sample.avatar !== null);
    const gameViewports = [
      ...new Set(
        cameraSamples.map(
          (sample) => `${sample.camera!.viewport[0]}×${sample.camera!.viewport[1]}`,
        ),
      ),
    ];
    actorFrames.push({
      actor,
      userId,
      frameCount: frames.length,
      dimensions,
      cameraSamples: cameraSamples.length,
      avatarSamples: avatarSamples.length,
      gameViewports,
    });
    if (!frames.length) reasons.push(`No captured frames for actor ${actor}`);
    if (
      cameraSamples.length < 2 ||
      avatarSamples.length < 2 ||
      samples.some(
        (sample) =>
          !Number.isFinite(sample.at) ||
          (sample.avatar !== null && !vector(sample.avatar)) ||
          (sample.camera !== null &&
            (!vector(sample.camera.position) ||
              !vector(sample.camera.look) ||
              sample.camera.viewport.length !== 2 ||
              sample.camera.viewport.some(
                (value) => !Number.isSafeInteger(value) || value < 1 || value > 4096,
              ))),
      )
    )
      reasons.push(`Actor ${actor} lacks trustworthy concurrent camera/avatar samples`);
    if (
      plan.viewport &&
      cameraSamples.some(
        (sample) =>
          sample.camera!.viewport[0] !== plan.viewport!.width ||
          sample.camera!.viewport[1] !== plan.viewport!.height,
      )
    )
      reasons.push(`Actor ${actor} did not use declared native game viewport`);
    const ids = new Set(frames.map((frame) => frame.studioId));
    if (ids.size !== 1) reasons.push(`Actor ${actor} changed Studio capture target`);
    const ordered = frames
      .map(interval)
      .filter((value): value is [number, number] => value !== null);
    if (ordered.some(([start], index) => index > 0 && start < ordered[index - 1]![0]))
      reasons.push(`Actor ${actor} has reordered frames`);
  }
  for (const userId of byUser.keys())
    if (![...actorIds.values()].includes(userId)) reasons.push(`Unbound captured player ${userId}`);
  for (const binding of plan.requiredTransitions) {
    const transitionId = binding.id;
    const source = binding.source;
    const matches =
      source.kind === "action"
        ? input.transitions.filter((entry) => entry.stepId === source.stepId)
        : input.stateChanges
            .filter(
              (entry) =>
                entry.context === source.context &&
                entry.path === source.path &&
                entry.attribute === source.attribute,
            )
            .sort((left, right) => left.at - right.at)
            .flatMap((entry, index, entries) =>
              index > 0 &&
              Object.is(entries[index - 1]!.value, source.from) &&
              Object.is(entry.value, source.to)
                ? [{ at: entry.at }]
                : [],
            );
    const measured = matches.filter(
      (entry) =>
        Number.isFinite(entry.at) && entry.at >= MIN_EPOCH_SECONDS && entry.at <= MAX_EPOCH_SECONDS,
    );
    // A watched probe without the change is evidence that the effect did not occur. Frame
    // selection labels the end of the observation horizon. A probe with no record is missing.
    const watched =
      source.kind === "state" &&
      input.stateChanges.some(
        (entry) =>
          entry.context === source.context &&
          entry.path === source.path &&
          entry.attribute === source.attribute,
      );
    if (watched && matches.length === 0) {
      transitions.push({ transitionId, at: "", covered: true, gapMs: null });
      continue;
    }
    if (measured.length !== 1) {
      reasons.push(`Transition ${transitionId} lacks one measured action or state change`);
      transitions.push({ transitionId, at: "", covered: false, gapMs: null });
      continue;
    }
    const atMs = measured[0]!.at * 1000;
    let covered = aligned;
    let worstGap: number | null = null;
    // The rule compares host times: the anchor plus the probe offset, against frame intervals.
    for (const [actor, userId] of aligned ? actorIds : []) {
      const coverage = transitionCoverage({
        actor,
        frames: byUser.get(userId) ?? [],
        anchorMs: atMs,
        binding,
        maximumGapMs: plan.maximumGapMs,
        clock: clock as ClockAlignment,
      });
      if (coverage.reasons.length) {
        covered = false;
        reasons.push(...coverage.reasons);
      }
      // Samples and anchors share the Studio clock, so this check needs no alignment.
      const samples = input.samples.filter(
        (sample) => sample.context === actor && sample.userId === userId,
      );
      const near = (sample: SequenceSample, after: boolean) => {
        const distance = (sample.at * 1000 - atMs) * (after ? 1 : -1);
        return distance >= 0 && distance <= plan.maximumGapMs;
      };
      if (!samples.some((sample) => near(sample, false)) || !samples.some((s) => near(s, true))) {
        covered = false;
        reasons.push(`Actor ${actor} lacks concurrent state samples around ${transitionId}`);
      }
      if (coverage.gapMs !== null) worstGap = Math.max(worstGap ?? 0, coverage.gapMs);
    }
    transitions.push({ transitionId, at: new Date(atMs).toISOString(), covered, gapMs: worstGap });
  }
  if (input.stateChanges.length > 256)
    reasons.push("State transition trace exceeds the fixed limit");
  const stateChanges = input.stateChanges.slice(0, 256).map((entry) => ({
    context: entry.context,
    path: entry.path,
    attribute: entry.attribute,
    at: new Date(entry.at * 1000).toISOString(),
    value: entry.value,
  }));
  return {
    schema: "basalt-evals/sequence-assessment",
    planHash: sequencePlanHash(plan),
    status: reasons.length ? "insufficient" : "sufficient",
    reasons: [...new Set(reasons)],
    clock,
    actorFrames,
    transitions,
    stateChanges,
  };
}

/** Verify bytes before any image enters a prompt or review packet. */
export function assertSequenceBytes(frame: SequenceFrame, bytes: Buffer): void {
  if (bytes.length !== frame.bytes || contentHash(bytes) !== frame.hash)
    throw new Error(`Sequence image hash mismatch: ${frame.file}`);
}
