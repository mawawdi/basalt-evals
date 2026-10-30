import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { contentHash } from "../../contracts/src/index.js";
import type { EvidenceSubstitution, LabelRule, RegionView } from "../../contracts/src/execution.js";
import { pendingCriterionMaterial } from "../../eval-authoring/src/criterion-material.js";
import type { CriterionMaterial } from "../../eval-authoring/src/criterion-material.js";
import type { ModelImage } from "../../model-client/src/contracts.js";
import { replaceRegion } from "../../studio-runner/src/image-controls.js";
import { imageLabelPrefix } from "../../studio-runner/src/image-labels.js";

export interface FrameInterval {
  frameId: string;
  actor: string;
  startMs: number;
  endMs: number;
}
/** The rendered part of judgment material. `images[i]` belongs to `context.intervals[i]`. */
interface RenderedMaterial {
  context: {
    actors: string[];
    intervals: FrameInterval[];
    acquisition: unknown[];
    samplingIntervalMs: number | null;
  };
  images: ModelImage[];
  criterionEvidence: CriterionMaterial[];
}
/** A signed frame that a control reads but never sends to the judge. */
export type FillFrame = Pick<ModelImage, "mediaType" | "hash" | "dataBase64">;
/** Data that some controls need in addition to the target material. */
interface ControlAids<T extends RenderedMaterial> {
  /** The material of the donor capture: donor controls only. */
  donor: T | null;
  /** The phase key of each frame: `phase_shuffled` only. */
  phases: string[] | null;
  /** The frame of the region view before the action: region controls only. */
  fill: FillFrame | null;
}

/** Phase captures have the actor `presentation:<captureId>`; sequence frames name their actor. */
function regionViewActor(view: RegionView): string {
  return view.kind === "capture" ? `presentation:${view.captureId}` : view.actor;
}

/** A stable permutation from a seed. Sattolo's algorithm gives one cycle, so no item stays. */
function derangement(count: number, seed: string): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index--) {
    const draw = createHash("sha256").update(`${seed}:${index}`).digest().readUInt32BE(0);
    const other = draw % index;
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return order;
}

const POSITION = /^Image [1-9][0-9]*: /u;
/**
 * The same label at another position. The image number states the position in the request,
 * so only that number changes. Every other part of the label stays with its image.
 */
function labelAtPosition(label: string, slot: number): string {
  const position = POSITION.exec(label);
  if (!position) throw new Error("A rendered image label does not state its position");
  return `${imageLabelPrefix(slot)} ${label.slice(position[0].length)}`;
}

/** Put image `order[slot]` into each slot, with every image in exactly one slot. */
function reorderFrames<T extends RenderedMaterial>(
  material: T,
  order: number[],
  rule: LabelRule,
): T {
  if (new Set(order).size !== order.length)
    throw new Error("A frame order must place every slot once");
  return placeFrames(material, order, rule);
}

/**
 * Put image `sources[slot]` into each slot. A source can fill more than one slot. With
 * `labels_follow_images`, the whole label and the whole frame interval move with the image.
 * With `labels_keep_slots`, the label and the interval stay in the slot.
 */
function placeFrames<T extends RenderedMaterial>(
  material: T,
  sources: number[],
  rule: LabelRule,
): T {
  const { images, context } = material;
  if (
    sources.length !== images.length ||
    sources.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= images.length)
  )
    throw new Error("A frame order must name a frame for every slot");
  const follow = rule === "labels_follow_images";
  return {
    ...material,
    images: sources.map((source, slot) => ({
      ...images[source]!,
      label: follow ? labelAtPosition(images[source]!.label, slot) : images[slot]!.label,
    })),
    context: {
      ...context,
      intervals: follow ? sources.map((source) => context.intervals[source]!) : context.intervals,
    },
  };
}

function blankPixels(): FillFrame {
  const blank = new PNG({ width: 32, height: 32 });
  blank.data.fill(255);
  const bytes = PNG.sync.write(blank);
  return { mediaType: "image/png", hash: contentHash(bytes), dataBase64: bytes.toString("base64") };
}

function encoded(image: FillFrame) {
  return { bytes: Buffer.from(image.dataBase64, "base64"), mediaType: image.mediaType };
}

/** Fail when a control leaves every frame as it was. Such a control measures nothing. */
function changed<T extends RenderedMaterial>(primary: T, presented: T, message: string): T {
  if (
    presented.images.length === primary.images.length &&
    presented.images.every((image, index) => image.hash === primary.images[index]!.hash)
  )
    throw new Error(message);
  return presented;
}

/**
 * Apply one control to judgment material. Each control changes only what its kind names.
 * Source and runtime criterion material stays bound to the evaluated build, except under
 * `text_only` (none) and `canary` (the twin build's own material).
 */
export function applyEvidenceControl<T extends RenderedMaterial>(
  primary: T,
  substitution: EvidenceSubstitution,
  aids: ControlAids<T>,
  seed: string,
): T {
  const noFrames = (material: T): T => ({
    ...material,
    images: [],
    context: {
      ...material.context,
      actors: [],
      intervals: [],
      acquisition: [],
      samplingIntervalMs: null,
    },
  });
  const rule = (): LabelRule => {
    if (!substitution.labelRule)
      throw new Error("An order or content control needs a preregistered label rule");
    return substitution.labelRule;
  };
  switch (substitution.kind) {
    case "unrelated":
      // Registered research shows the other evaluation's frames as recorded.
      if (!aids.donor) throw new Error("This control requires a donor capture");
      return { ...aids.donor, criterionEvidence: primary.criterionEvidence };
    case "donor_swap": {
      const labelRule = rule();
      const donor = aids.donor;
      if (!donor) throw new Error("This control requires a donor capture");
      if (labelRule === "labels_follow_images")
        return { ...donor, criterionEvidence: primary.criterionEvidence };
      // The donor pixels take the target's labels and frame intervals, slot by slot.
      if (donor.images.length !== primary.images.length)
        throw new Error(
          "The donor has another count of frames, so its images cannot keep the labels",
        );
      return {
        ...primary,
        images: donor.images.map((image, slot) => ({
          ...image,
          label: primary.images[slot]!.label,
        })),
      };
    }
    case "canary":
      if (!aids.donor) throw new Error("The note control requires the twin build's capture");
      return aids.donor;
    case "blank": {
      if (!primary.images.length) throw new Error("Blank images need at least one rendered frame");
      // Only the pixels change, so each label stays with its slot.
      const pixels = blankPixels();
      return { ...primary, images: primary.images.map((slot) => ({ ...slot, ...pixels })) };
    }
    case "facts_and_source":
      return noFrames(primary);
    case "text_only":
      // The control removes the evidence, not the gate: each unavailable reason stays, so the
      // same criteria reach the judge as under the original evidence.
      return {
        ...noFrames(primary),
        criterionEvidence: primary.criterionEvidence.map((item) => ({
          ...pendingCriterionMaterial(item.criterionId),
          unavailable: item.unavailable,
        })),
      };
    case "shuffled": {
      const count = primary.images.length;
      if (count < 2) throw new Error("Shuffled evidence needs at least two rendered frames");
      return changed(
        primary,
        reorderFrames(primary, derangement(count, seed), rule()),
        "Shuffled evidence shows the same frames in the same order",
      );
    }
    case "reversed": {
      const count = primary.images.length;
      if (count < 2) throw new Error("Reversed evidence needs at least two rendered frames");
      const order = primary.images.map((_, index) => count - 1 - index);
      return changed(
        primary,
        reorderFrames(primary, order, rule()),
        "Reversed evidence shows the same frames in the same order",
      );
    }
    case "phase_shuffled": {
      const phases = aids.phases;
      if (!phases || phases.length !== primary.images.length)
        throw new Error("A shuffle within phases needs the phase of every frame");
      const order = primary.images.map((_, index) => index);
      const groups = new Map<string, number[]>();
      phases.forEach((phase, index) => groups.set(phase, [...(groups.get(phase) ?? []), index]));
      for (const [phase, slots] of groups) {
        if (slots.length < 2) continue;
        const local = derangement(slots.length, `${seed}:${phase}`);
        slots.forEach((slot, index) => (order[slot] = slots[local[index]!]!));
      }
      return changed(
        primary,
        reorderFrames(primary, order, rule()),
        "No phase has two or more different rendered frames",
      );
    }
    case "repeated_frame": {
      // Each view shows its own last frame in every one of its slots: no motion, same appearance.
      const last = new Map<string, number>();
      primary.context.intervals.forEach((interval, index) => last.set(interval.actor, index));
      const sources = primary.context.intervals.map((interval) => last.get(interval.actor)!);
      return changed(
        primary,
        placeFrames(primary, sources, rule()),
        "No view has two or more different rendered frames",
      );
    }
    case "region_removed":
    case "region_sham":
    case "region_black": {
      const region = substitution.region;
      if (!region) throw new Error("A region control needs an authored region");
      const actor = regionViewActor(region.view);
      const slots = primary.context.intervals.flatMap((interval, index) =>
        interval.actor === actor ? [index] : [],
      );
      if (!slots.length) throw new Error("The authored region view has no rendered frame");
      if (substitution.kind !== "region_black" && !aids.fill)
        throw new Error("The region control needs a frame of the same view before the action");
      const rectangle = substitution.kind === "region_sham" ? region.sham : region.decisive;
      const images = primary.images.map((image, index) => {
        if (!slots.includes(index)) return image;
        const bytes = replaceRegion({
          frame: encoded(image),
          region: rectangle,
          fill:
            substitution.kind === "region_black"
              ? { kind: "black" }
              : { kind: "pixels", frame: encoded(aids.fill!) },
        });
        return {
          ...image,
          mediaType: "image/png" as const,
          hash: contentHash(bytes),
          dataBase64: bytes.toString("base64"),
        };
      });
      return { ...primary, images };
    }
  }
}
