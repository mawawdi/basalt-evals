import {
  hashJson,
  MAXIMUM_PRESENTED_FRAMES,
  type StudioSequenceView,
} from "../../contracts/src/index.js";
import type { SequenceAcquisition } from "./studio-mcp.js";
import type { SequenceAssessment } from "./sequence.js";
import { presentSequenceFrames, type PresentationTreatment } from "./presentation.js";

/** Content identity freezes semantics, without an ordinal schema or model-dependent policy. */
const EVIDENCE_PACKET_POLICY = {
  selection: "one-fixed-transition-rule-for-dispatch-and-manifest",
  required: "before-after-effect-after-hold-or-horizon-end",
  effectWindows: "all-frames-or-even-spread-within-the-view-maximum-gap",
  fill: "even-spread-per-actor-after-effect-windows-up-to-the-frame-budget",
  budget: "authored-view-frame-budget-within-the-request-room-after-phase-captures",
  maximumImagesPerRequest: MAXIMUM_PRESENTED_FRAMES,
  deduplication: "none",
  transformations: "none",
};
export const EVIDENCE_PACKET_POLICY_HASH = hashJson(EVIDENCE_PACKET_POLICY);
export type EvidencePacketManifest = ReturnType<typeof selectEvidencePacket>["manifest"];

/** Describe the dispatched frame selection with its sources, reasons and omissions. */
export function selectEvidencePacket(input: {
  plan: StudioSequenceView;
  acquisition: SequenceAcquisition;
  assessment: SequenceAssessment;
  treatment: PresentationTreatment;
  criterionIds: string[];
  phaseCaptureCount?: number;
}) {
  if (new Set(input.criterionIds).size !== input.criterionIds.length)
    throw new Error("Duplicate packet criterion identity");
  const presentation = presentSequenceFrames(input);
  const warnings = [
    "A sampled packet cannot establish absence of brief, occluded or uncaptured events. Inspect full originals when evidence is ambiguous.",
    ...(input.treatment === "still"
      ? ["Still presentation cannot establish continuous motion or carriage."]
      : []),
    ...presentation.reasons,
  ];
  const chosen = new Set(presentation.frames.map((frame) => frame.file));
  const omittedIntervals: Array<{
    actor: string;
    startedAt: string;
    endedAt: string;
    frames: number;
  }> = [];
  for (const actor of input.assessment.actorFrames) {
    let omitted: (typeof omittedIntervals)[number] | null = null;
    for (const frame of input.acquisition.frames.filter(
      (frame) => frame.playerUserId === actor.userId,
    )) {
      if (chosen.has(frame.file)) {
        if (omitted) omittedIntervals.push(omitted);
        omitted = null;
        continue;
      }
      if (!omitted)
        omitted = {
          actor: actor.actor,
          startedAt: frame.startedAt,
          endedAt: frame.endedAt,
          frames: 0,
        };
      omitted.endedAt = frame.endedAt;
      omitted.frames++;
    }
    if (omitted) omittedIntervals.push(omitted);
  }
  const body = {
    policyHash: EVIDENCE_PACKET_POLICY_HASH,
    criterionIds: [...input.criterionIds].sort(),
    sourceAcquisitionHash: hashJson(input.acquisition),
    sourceAssessmentHash: hashJson(input.assessment),
    sourcePlanHash: input.assessment.planHash,
    sourceFrameCount: input.acquisition.frames.length,
    frameBudget: presentation.frameBudget,
    requiredFrameCount: presentation.requiredFrameCount,
    selectedFrameCount: presentation.frames.length,
    status:
      presentation.status === "sufficient"
        ? ("sufficient" as const)
        : ("insufficient_evidence" as const),
    omittedIntervals,
    warnings,
    frames: presentation.frames.map((frame) => {
      const source = input.acquisition.frames.find((source) => source.file === frame.file)!;
      return {
        frameId: frame.id,
        sourceFrameId: hashJson(source),
        sourceIndex: input.acquisition.frames.indexOf(source),
        file: source.file,
        hash: source.hash,
        actor: frame.actor,
        playerUserId: source.playerUserId,
        startedAt: source.startedAt,
        endedAt: source.endedAt,
        width: source.width,
        height: source.height,
        transformations: [] as string[],
        reasons: frame.roles,
      };
    }),
  };
  return { presentation, manifest: { ...body, id: hashJson(body) } };
}
