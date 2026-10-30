import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash, MAX_SEQUENCE_BYTES, MAX_SEQUENCE_FRAMES } from "../../contracts/src/index.js";
import { decodeCaptureImage, type CaptureMediaType } from "./images.js";
import type { SequenceFrame } from "./studio-mcp.js";

function captureDimensions(bytes: Buffer, mediaType: CaptureMediaType) {
  const decoded = decodeCaptureImage(bytes, mediaType);
  let magenta = true;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    if (
      decoded.data[offset]! < 250 ||
      decoded.data[offset + 1]! > 5 ||
      decoded.data[offset + 2]! < 250
    ) {
      magenta = false;
      break;
    }
  }
  if (magenta)
    throw new Error(
      "Studio returned a solid-magenta image. In Studio Settings > Rendering, set Graphics Mode to OpenGL. Then restart Studio.",
    );
  // Do not retain decoded pixel buffers while asynchronous disk writes are pending.
  return { width: decoded.width, height: decoded.height };
}

/** Persist each original frame as it arrives; recording duration must not accumulate image RAM. */
export class SequenceFrameStore {
  private issued = 0;
  private totalBytes = 0;
  private pendingBytes = 0;
  private readonly saved: SequenceFrame[] = [];

  constructor(private readonly directory: string) {}

  get frames(): SequenceFrame[] {
    return [...this.saved].sort(
      (a, b) =>
        Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.playerUserId - b.playerUserId,
    );
  }

  /** Remove each frame that started after a time, and its file. These frames lie outside the recording. */
  async removeStartedAfter(time: number): Promise<void> {
    for (let index = this.saved.length - 1; index >= 0; index--) {
      const frame = this.saved[index]!;
      if (Date.parse(frame.startedAt) <= time) continue;
      await unlink(resolve(this.directory, frame.file));
      this.saved.splice(index, 1);
      this.totalBytes -= frame.bytes;
    }
  }

  async append(frame: {
    bytes: Buffer;
    mediaType: CaptureMediaType;
    playerUserId: number;
    studioId: string;
    startedAt: string;
    endedAt: string;
  }): Promise<void> {
    if (this.issued >= MAX_SEQUENCE_FRAMES) throw new Error("Sequence frame capacity exceeded");
    if (this.totalBytes + frame.bytes.length > MAX_SEQUENCE_BYTES)
      throw new Error("Sequence disk allowance exceeded; retained frames remain available");
    if (this.pendingBytes + frame.bytes.length > 128 * 1024 * 1024)
      throw new Error("Sequence pending writes exceeded their memory allowance");
    const ordinal = ++this.issued;
    this.totalBytes += frame.bytes.length;
    this.pendingBytes += frame.bytes.length;
    try {
      const dimensions = captureDimensions(frame.bytes, frame.mediaType);
      const file = `frame-${String(ordinal).padStart(4, "0")}.${frame.mediaType === "image/png" ? "png" : "jpg"}`;
      await writeFile(resolve(this.directory, file), frame.bytes, { flag: "wx", mode: 0o600 });
      this.saved.push({
        file,
        hash: contentHash(frame.bytes),
        bytes: frame.bytes.length,
        mediaType: frame.mediaType,
        ...dimensions,
        playerUserId: frame.playerUserId,
        studioId: frame.studioId,
        startedAt: frame.startedAt,
        endedAt: frame.endedAt,
      });
    } finally {
      this.pendingBytes -= frame.bytes.length;
    }
  }
}
