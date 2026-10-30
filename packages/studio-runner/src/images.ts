import { crc32 } from "node:zlib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { MAX_CAPTURE_BYTES, MAX_CAPTURE_PIXELS } from "../../contracts/src/index.js";

export type CaptureMediaType = "image/png" | "image/jpeg";

export function captureMediaType(bytes: Buffer): CaptureMediaType {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) return "image/jpeg";
  throw new Error("Capture bytes are neither PNG nor JPEG");
}

/** Dimensions are observations, not a guessed relationship to desktop/GUI pixels. */
export function inspectCaptureImage(
  bytes: Buffer,
  mediaType: CaptureMediaType,
): { width: number; height: number } {
  const decoded = decodeCaptureImage(bytes, mediaType);
  return { width: decoded.width, height: decoded.height };
}

export function decodeCaptureImage(bytes: Buffer, mediaType: CaptureMediaType): PNG {
  if (mediaType === "image/png") {
    if (bytes.length < 33) throw new Error("Capture PNG is truncated");
    return decodeCapture(bytes, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
  if (
    mediaType !== "image/jpeg" ||
    bytes.length < 4 ||
    bytes.length > MAX_CAPTURE_BYTES ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    throw new Error("Capture is not a complete bounded JPEG");
  assertJpegScan(bytes);
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    tolerantDecoding: false,
    maxResolutionInMP: Math.ceil(MAX_CAPTURE_PIXELS / 1_000_000),
    maxMemoryUsageInMB: 256,
  });
  assertViewport(decoded);
  const image = new PNG({ width: decoded.width, height: decoded.height });
  image.data = Buffer.from(decoded.data);
  return image;
}

function assertViewport(viewport: { width: number; height: number }): void {
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width < 1 ||
    viewport.height < 1 ||
    viewport.width > 8192 ||
    viewport.height > 8192 ||
    viewport.width * viewport.height > MAX_CAPTURE_PIXELS
  )
    throw new Error("Capture viewport exceeds the pixel limit");
}

/** Decode pixels and CRCs after bounding dimensions; a header is not rendered evidence. */
export function decodeCapture(bytes: Buffer, viewport: { width: number; height: number }): PNG {
  assertViewport(viewport);
  if (
    bytes.length < 33 ||
    bytes.length > MAX_CAPTURE_BYTES ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
    bytes.readUInt32BE(16) !== viewport.width ||
    bytes.readUInt32BE(20) !== viewport.height ||
    bytes.subarray(-12).toString("hex") !== "0000000049454e44ae426082"
  )
    throw new Error(
      "Capture PNG dimensions do not match its recorded dimensions, or PNG is incomplete",
    );
  assertPngChunks(bytes);
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch (error) {
    throw new Error("Capture PNG cannot decode complete pixels and CRCs", { cause: error });
  }
}

/**
 * pngjs skips an unknown ancillary chunk without a CRC check. Without an IDAT chunk, it fills
 * the pixels from uninitialized memory. Thus check each chunk before pngjs reads the bytes.
 */
function assertPngChunks(bytes: Buffer): void {
  let image = false;
  for (let offset = 8, index = 0; ; index++) {
    if (offset + 12 > bytes.length) throw new Error("Capture PNG has no IEND chunk");
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) throw new Error("Capture PNG has a chunk longer than the file");
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error(`Capture PNG chunk ${index} has a wrong CRC`);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if ((index === 0) !== (type === "IHDR"))
      throw new Error("Capture PNG must start with one IHDR");
    if (type === "IDAT") image = true;
    if (type === "IEND") {
      if (end !== bytes.length) throw new Error("Capture PNG has bytes after IEND");
      if (!image) throw new Error("Capture PNG has no image data");
      return;
    }
    offset = end;
  }
}

/** jpeg-js decodes a JPEG without a scan to a uniform image. A header is not rendered evidence. */
function assertJpegScan(bytes: Buffer): void {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("Capture JPEG has a malformed segment");
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) return;
    if (marker === 0xd9) break;
    // A fill byte, then the markers without a length: TEM and RST0 to RST7.
    if (marker === 0xff) offset += 1;
    else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) offset += 2;
    else offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("Capture JPEG has no scan data");
}
