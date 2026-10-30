import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  contentHash,
  MAX_CAPTURE_BYTES,
  SEQUENCE_SAMPLE_INTERVAL_MS,
  type StudioCollectionPlan,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import type { ModelImage } from "../../model-client/src/contracts.js";
import { readBoundSequence } from "./bound-sequence.js";
import { actorCaptureViews } from "./capture-view.js";
import { evidenceImageLabels, type LabelTransition, type LabelledFrame } from "./image-labels.js";
import type { SignedWorkerManifest } from "./native-worker.js";
import { presentSequenceFrames, type PresentationTreatment } from "./presentation.js";
import type { SequencePlan } from "./sequence.js";
import { selectEvidencePacket } from "./evidence-packet.js";

/** Consume only after verifying the worker signature, inventory, and source binding. */
export async function renderedEvidence(input: {
  files: RepositoryFiles;
  base: string;
  evidence: StudioEvidence;
  plan: StudioCollectionPlan;
  captureIds: string[];
  sequence: SequencePlan | null;
  presentation: PresentationTreatment;
  dryRunCriterionIds?: string[];
  /** The images of the request that this build can use. A request about two builds halves it. */
  requestRoom?: number;
}) {
  const selected: Array<{ file: string; hash: string; mediaType: "image/png" | "image/jpeg" }> = [];
  const intervals: Array<{ frameId: string; actor: string; startMs: number; endMs: number }> = [];
  const actors = new Set<string>();
  const labelled: LabelledFrame[] = [];
  let transitions: LabelTransition[] = [];
  let samplingIntervalMs: number | null = null;
  let packetManifest: ReturnType<typeof selectEvidencePacket>["manifest"] | null = null;
  const unavailable: Array<{ channel: string; reason: string }> = [];
  if (input.sequence) {
    const receipt = await input.files.json<SignedWorkerManifest>(
      `${input.base}/native/manifest.json`,
    );
    const bound = await readBoundSequence(input.files.path(input.base), receipt, input.sequence);
    // Phase captures share one request with the sequence frames.
    const phaseCaptureCount = new Set(input.captureIds).size;
    const request = {
      ...bound,
      treatment: input.presentation,
      phaseCaptureCount,
      ...(input.requestRoom === undefined ? {} : { requestRoom: input.requestRoom }),
    };
    const packet = input.dryRunCriterionIds
      ? selectEvidencePacket({ ...request, criterionIds: input.dryRunCriterionIds })
      : null;
    packetManifest = packet?.manifest ?? null;
    const presentation = packet?.presentation ?? presentSequenceFrames(request);
    if (presentation.status === "insufficient")
      unavailable.push({
        channel: "sequence",
        reason: "Rendered sequence cannot support a judgment: " + presentation.reasons.join("; "),
      });
    else {
      for (const actor of presentation.context.actors) actors.add(actor);
      intervals.push(...presentation.context.intervals);
      // The judge receives the declared recorder cadence: events between samples are not shown.
      samplingIntervalMs = SEQUENCE_SAMPLE_INTERVAL_MS;
      // Anchors use the Studio clock. The recording clock is the host clock of the frames.
      const clock = bound.assessment.clock;
      if (!clock) throw new Error("A sufficient rendered sequence has no clock alignment");
      const origin = Date.parse(bound.acquisition.startedAt) - clock.offsetMs;
      transitions = bound.assessment.transitions.flatMap((transition, index) =>
        transition.at
          ? [
              {
                transitionId: transition.transitionId,
                anchor: bound.plan.requiredTransitions[index]!.source.kind,
                anchorMs: Date.parse(transition.at) - origin,
              },
            ]
          : [],
      );
      labelled.push(
        ...presentation.context.intervals.map((interval, index) => ({
          frameId: interval.frameId,
          player: interval.actor,
          clock: { kind: "scenario" as const, startMs: interval.startMs, endMs: interval.endMs },
          roles: presentation.frames[index]!.roles,
        })),
      );
      selected.push(
        ...presentation.frames.map((frame) => ({
          ...frame,
          file: `${input.base}/${bound.prefix}${frame.file}`,
        })),
      );
    }
  }
  const presentCaptureIds: string[] = [];
  for (const captureId of new Set(input.captureIds)) {
    const captures = input.evidence.phases
      .flatMap((phase) => phase.captures)
      .filter((capture) => capture.captureId === captureId);
    if (captures.length > 1) throw new Error("Ambiguous phase capture identity");
    const capture = captures[0];
    if (!capture) {
      unavailable.push({
        channel: captureId,
        reason: `Required rendered capture was not acquired: ${captureId}`,
      });
      continue;
    }
    presentCaptureIds.push(captureId);
    selected.push({ ...capture, file: `${input.base}/${capture.file}` });
    // Phase files do not claim a precise exposure instant. Keep their separate
    // presentation session explicit instead of merging clocks with a scenario.
    const actor = `presentation:${captureId}`;
    actors.add(actor);
    intervals.push({
      frameId: `frame-${selected.length}`,
      actor,
      startMs: 0,
      endMs: Date.parse(input.evidence.endedAt) - Date.parse(input.evidence.startedAt),
    });
    labelled.push({
      frameId: `frame-${selected.length}`,
      player: null,
      clock: { kind: "presentation", captureId },
      roles: [],
    });
  }
  const labels = evidenceImageLabels(labelled, transitions);
  const acquisition = await actorCaptureViews(
    input.files,
    input.base,
    input.plan,
    presentCaptureIds,
  );
  const images: ModelImage[] = [];
  for (const [index, frame] of selected.entries()) {
    const bytes = await input.files.bytes(frame.file, MAX_CAPTURE_BYTES);
    if (contentHash(bytes) !== frame.hash)
      throw new Error("Rendered frame differs from signed evidence");
    images.push({
      hash: frame.hash,
      mediaType: frame.mediaType,
      dataBase64: bytes.toString("base64"),
      label: labels[index]!,
    });
  }
  return {
    images,
    unavailable,
    packetManifest,
    context: { actors: [...actors], intervals, acquisition, samplingIntervalMs },
    // The label inputs in image order. A request about two builds writes its labels again.
    labelled,
    transitions,
  };
}
