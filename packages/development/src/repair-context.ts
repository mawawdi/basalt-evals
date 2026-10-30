import { contentHash } from "../../contracts/src/index.js";
import { validateModelImages, type ModelImage } from "../../model-client/src/contracts.js";
import type { FramePresentation } from "../../studio-runner/src/presentation.js";
import { evidenceImageLabels } from "../../studio-runner/src/image-labels.js";

export interface PublicRepairFrames {
  presentation: FramePresentation;
  images: Array<{ id: string; mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array }>;
}

export interface PublicRepairContext {
  summary: string;
  images: ModelImage[];
}

/** The repair model receives acquisition facts, never private grader decisions. */
export function publicRepairContext(frames: PublicRepairFrames): PublicRepairContext {
  if (
    frames.images.length !== frames.presentation.frames.length ||
    frames.images.length === 0 ||
    frames.images.length > 4 ||
    frames.images.some(
      (image, index) =>
        image.id !== frames.presentation.frames[index]?.id ||
        image.mediaType !== frames.presentation.frames[index]?.mediaType ||
        contentHash(image.bytes) !== frames.presentation.frames[index]?.hash,
    )
  )
    throw new Error("Public repair frames differ from verified development acquisition");
  const selected = frames.images;
  const labels = evidenceImageLabels(
    frames.presentation.frames.map((frame) => ({
      frameId: frame.id,
      player: frame.actor,
      clock: { kind: "unstated" as const },
      roles: frame.roles,
    })),
  );
  const images = selected.map((image, index) => ({
    mediaType: image.mediaType,
    dataBase64: Buffer.from(image.bytes).toString("base64"),
    hash: contentHash(image.bytes),
    label: labels[index]!,
  }));
  validateModelImages(images);
  return {
    summary: JSON.stringify({
      schema: "basalt-evals/public-repair-context",
      instruction:
        "Inspect these development frames against the public task. They are observations, not a grader verdict.",
      frames: frames.presentation.frames.map((frame) => ({
        id: frame.id,
        actor: frame.actor,
        acquisitionStart: frame.startedAt,
        acquisitionEnd: frame.endedAt,
        hash: frame.hash,
      })),
      uncertainty:
        "Frame intervals do not establish exact event timing or a hidden expected outcome.",
    }),
    images,
  };
}
