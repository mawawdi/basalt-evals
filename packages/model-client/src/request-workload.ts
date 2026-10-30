import { stableJson } from "../../contracts/src/index.js";
import type { ModelImage, ModelTurnRequest } from "./contracts.js";
import { validateModelImages } from "./contracts.js";
import type { ModelSnapshot } from "./catalog.js";
import { modelLimits } from "./model-limits.js";
import { assertImageRequestLimits } from "./image-limits.js";
import { imageTokenRule, imageTokenWork } from "./image-tokens.js";
import { assertRequestReasoning } from "./reasoning.js";
import { assertRequestSampling } from "./sampling.js";

/** UTF-8 is an upper admission estimate; encoded media bytes are never ordinary text. */
export function requestTextBound(
  request: Pick<ModelTurnRequest, "system" | "messages" | "tools">,
): number {
  const messages = request.messages.map((message) =>
    message.role === "user" && message.images
      ? {
          ...message,
          images: message.images.map(({ mediaType, hash, label }) => ({ mediaType, hash, label })),
        }
      : message,
  );
  return (
    Buffer.byteLength(
      stableJson({ system: request.system, messages, tools: request.tools }),
      "utf8",
    ) +
    1024 +
    messages.length * 32 +
    request.tools.length * 64
  );
}

export function imageDimensions(image: ModelImage): { width: number; height: number } {
  validateModelImages([image]);
  const bytes = Buffer.from(image.dataBase64, "base64");
  let width = 0,
    height = 0;
  if (image.mediaType === "image/png") {
    if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR")
      throw new Error("Image lacks a PNG dimension header");
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG marker");
      const marker = bytes[offset + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) throw new Error("Invalid JPEG segment");
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (size < 8) throw new Error("Invalid JPEG dimension header");
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += 2 + size;
    }
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 65535 ||
    height > 65535
  )
    throw new Error("Image dimensions are unavailable or exceed supported bounds");
  return { width, height };
}

/** Compact image identity of one request. Receipts keep it beside the billed prompt tokens. */
export function requestImageInputs(
  request: ModelTurnRequest,
): Array<{ hash: string; width: number; height: number }> {
  return request.messages.flatMap((message) =>
    message.role === "user"
      ? (message.images ?? []).map((image) => ({ hash: image.hash, ...imageDimensions(image) }))
      : [],
  );
}

export function promptCapacity(snapshot: ModelSnapshot, outputTokens: number): number {
  const limits = modelLimits(snapshot);
  if (
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 1 ||
    outputTokens > limits.maxOutputTokens
  )
    throw new Error("Request exceeds the output limit of its frozen endpoint set");
  return Math.min(limits.maxPromptTokens ?? Infinity, limits.contextLength - outputTokens);
}

/**
 * The output allowance of one request: the output limit of the frozen endpoint set, or the
 * context that remains after the input bound if that is smaller. Without an image token rule,
 * the images use the remaining context, so the allowance stays at the output limit.
 */
export function requestOutputTokens(
  snapshot: ModelSnapshot,
  request: Omit<ModelTurnRequest, "maxOutputTokens">,
): number {
  const limits = modelLimits(snapshot);
  const dimensions = request.messages
    .flatMap((message) => (message.role === "user" ? (message.images ?? []) : []))
    .map(imageDimensions);
  if (dimensions.length && !imageTokenRule(snapshot)) return limits.maxOutputTokens;
  const room = limits.contextLength - requestTextBound(request);
  const images = dimensions.length ? imageTokenWork(snapshot, dimensions, room).upper : 0;
  // If no room remains, the admission check refuses the request with the context error.
  return Math.max(1, Math.min(limits.maxOutputTokens, room - images));
}

export function requestUsage(snapshot: ModelSnapshot, request: ModelTurnRequest) {
  assertRequestReasoning(request.reasoning, snapshot);
  assertRequestSampling(request.sampling, snapshot);
  const inputTokens = requestTextBound(request);
  const capacity = promptCapacity(snapshot, request.maxOutputTokens);
  if (inputTokens > capacity) throw new Error("Request exceeds its frozen endpoint context limit");
  const images = request.messages.flatMap((message) =>
    message.role === "user" ? (message.images ?? []) : [],
  );
  const dimensions = images.map(imageDimensions);
  assertImageRequestLimits(
    snapshot,
    images.map((image, index) => ({
      ...dimensions[index]!,
      encodedBytes: image.dataBase64.length,
    })),
    inputTokens,
  );
  const imageWork = imageTokenWork(snapshot, dimensions, capacity - inputTokens);
  if (inputTokens + imageWork.upper > capacity)
    throw new Error("Request text, images, and output exceed frozen endpoint capacity");
  return {
    upper: {
      inputTokens,
      outputTokens: request.maxOutputTokens,
      images: dimensions.length,
      imageInputTokens: imageWork.upper,
    },
    expectedImageTokens: imageWork.expected,
    imageBasis: imageWork.basis,
  };
}
