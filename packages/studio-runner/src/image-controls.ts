import { PNG } from "pngjs";
import { validRectangle, type PixelRectangle } from "../../contracts/src/execution.js";
import { decodeCaptureImage, type CaptureMediaType } from "./images.js";

/** One encoded frame. The caller binds its bytes to signed evidence before this call. */
interface ControlFrame {
  bytes: Buffer;
  mediaType: CaptureMediaType;
}

/**
 * Replace one rectangle of a frame and encode the result as PNG. The `pixels` fill copies the
 * same rectangle from another frame of the same view, for example a frame before the action.
 * The `black` fill is out of distribution; use it only as a check of the fill artifact.
 * The frame keeps its native dimensions. A fill frame with other dimensions is refused.
 */
export function replaceRegion(input: {
  frame: ControlFrame;
  region: PixelRectangle;
  fill: { kind: "pixels"; frame: ControlFrame } | { kind: "black" };
}): Buffer {
  const target = decodeCaptureImage(input.frame.bytes, input.frame.mediaType);
  if (!validRectangle(input.region, target))
    throw new Error("The authored region is outside the frame");
  const { x, y, width, height } = input.region;
  if (input.fill.kind === "pixels") {
    const source = decodeCaptureImage(input.fill.frame.bytes, input.fill.frame.mediaType);
    if (source.width !== target.width || source.height !== target.height)
      throw new Error("The fill frame has other dimensions than the frame");
    PNG.bitblt(source, target, x, y, width, height, x, y);
  } else {
    const row = Buffer.alloc(width * 4, Buffer.from([0, 0, 0, 255]));
    for (let line = y; line < y + height; line++)
      row.copy(target.data, (line * target.width + x) * 4);
  }
  return PNG.sync.write(target);
}
