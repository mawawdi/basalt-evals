import { compareCodeUnits } from "../../contracts/src/index.js";

/*
 * Deterministic pixel measures on recorded frames. Each function is pure: it reads no
 * file, clock or model. A measure is a number. It is never a verdict.
 *
 * The measures use two pixel scales. Luma is the Rec. 709 weighted sum of the 8-bit code
 * values, from 0 to 255. Change and reference distance use luma. Relative luminance is
 * the same weighted sum of linear sRGB values, from 0 to 1. Weber contrast uses it.
 */

export const PIXEL_MEASURES = [
  "weber_contrast",
  "changed_pixels",
  "screen_coverage",
  "onset_ms",
  "peak_ms",
  "reference_distance",
] as const;
export type PixelMeasure = (typeof PIXEL_MEASURES)[number];

/** Decoded RGBA bytes in row order. A decoded capture PNG has this shape. */
interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** One recorded frame. The recorded time starts at the action, so a negative time is before it. */
export interface RecordedFrame {
  id: string;
  phaseId: string;
  recordedMs: number;
  raster: Raster;
}
/** An authored effect region. The surround is the band of this width around the rectangle. */
export interface EffectRegion {
  rectangle: PixelRegion;
  surroundMargin: number;
  authority: "criterion" | "view";
}
/** A frame position: the index in recorded-time order and the recorded time. */
interface FrameMark {
  index: number;
  id: string;
  phaseId: string;
  recordedMs: number;
}

export function assertPixelRegion(
  region: unknown,
  bounds?: { width: number; height: number },
): asserts region is PixelRegion {
  const value = region as PixelRegion;
  if (
    typeof region !== "object" ||
    region === null ||
    Array.isArray(region) ||
    Object.keys(region).sort().join() !== "height,width,x,y" ||
    ![value.x, value.y, value.width, value.height].every(Number.isSafeInteger) ||
    value.x < 0 ||
    value.y < 0 ||
    value.width < 1 ||
    value.height < 1 ||
    (bounds !== undefined &&
      (value.x + value.width > bounds.width || value.y + value.height > bounds.height))
  )
    throw new Error("A pixel region must be a whole-pixel rectangle inside the frame");
}
function assertRaster(raster: Raster) {
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1 ||
    raster.data.length !== raster.width * raster.height * 4
  )
    throw new Error("A raster must have four bytes for each pixel");
}
function assertMargin(margin: number) {
  if (!Number.isSafeInteger(margin) || margin < 1 || margin > 4096)
    throw new Error("A surround margin must be a whole number of pixels from 1 to 4096");
}
function assertFrames(frames: RecordedFrame[]) {
  if (!frames.length) throw new Error("A measurement needs recorded frames");
  if (new Set(frames.map((frame) => frame.id)).size !== frames.length)
    throw new Error("Recorded frame identities must be unique");
  for (const frame of frames) {
    if (typeof frame.id !== "string" || !frame.id || typeof frame.phaseId !== "string")
      throw new Error("A recorded frame needs an identity and a phase");
    if (!Number.isFinite(frame.recordedMs))
      throw new Error("A recorded frame needs a finite recorded time");
    assertRaster(frame.raster);
  }
}
/** Recorded-time order. Equal times keep a stable order by frame identity. */
function timeOrder(frames: RecordedFrame[]) {
  return [...frames].sort((a, b) => a.recordedMs - b.recordedMs || compareCodeUnits(a.id, b.id));
}

const LINEAR = Float64Array.from({ length: 256 }, (_, code) => {
  const value = code / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
function luma(raster: Raster): Float64Array {
  const result = new Float64Array(raster.width * raster.height);
  for (let pixel = 0, offset = 0; pixel < result.length; pixel++, offset += 4)
    result[pixel] =
      0.2126 * raster.data[offset]! +
      0.7152 * raster.data[offset + 1]! +
      0.0722 * raster.data[offset + 2]!;
  return result;
}
function luminance(raster: Raster, pixel: number) {
  const offset = pixel * 4;
  return (
    0.2126 * LINEAR[raster.data[offset]!]! +
    0.7152 * LINEAR[raster.data[offset + 1]!]! +
    0.0722 * LINEAR[raster.data[offset + 2]!]!
  );
}
/** 1 marks a measured pixel: inside the area and outside each excluded rectangle. */
function measuredMask(
  width: number,
  height: number,
  area: PixelRegion | null,
  excluded: PixelRegion[],
): Uint8Array {
  const bounds = { width, height };
  const result = new Uint8Array(width * height);
  const kept = area ?? { x: 0, y: 0, width, height };
  assertPixelRegion(kept, bounds);
  for (let y = kept.y; y < kept.y + kept.height; y++)
    result.fill(1, y * width + kept.x, y * width + kept.x + kept.width);
  for (const region of excluded) {
    assertPixelRegion(region, bounds);
    for (let y = region.y; y < region.y + region.height; y++)
      result.fill(0, y * width + region.x, y * width + region.x + region.width);
  }
  return result;
}

/**
 * Weber contrast of an authored effect region against its surround, over the pixels that the
 * mask keeps: (effect luminance - surround luminance) / surround luminance. The result is null
 * when the region or the surround has no measured pixel, or when the surround is black. The
 * caller checks the inputs.
 */
function contrastOf(
  raster: Raster,
  region: Pick<EffectRegion, "rectangle" | "surroundMargin">,
  measured: Uint8Array,
) {
  const rectangle = region.rectangle;
  const margin = region.surroundMargin;
  const left = Math.max(0, rectangle.x - margin),
    top = Math.max(0, rectangle.y - margin),
    right = Math.min(raster.width, rectangle.x + rectangle.width + margin),
    bottom = Math.min(raster.height, rectangle.y + rectangle.height + margin);
  let effectSum = 0,
    effectPixels = 0,
    surroundSum = 0,
    surroundPixels = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const pixel = y * raster.width + x;
      if (!measured[pixel]) continue;
      const value = luminance(raster, pixel);
      if (
        x >= rectangle.x &&
        x < rectangle.x + rectangle.width &&
        y >= rectangle.y &&
        y < rectangle.y + rectangle.height
      ) {
        effectSum += value;
        effectPixels++;
      } else {
        surroundSum += value;
        surroundPixels++;
      }
    }
  const effect = effectPixels ? effectSum / effectPixels : null;
  const surround = surroundPixels ? surroundSum / surroundPixels : null;
  return {
    effectLuminance: effect,
    surroundLuminance: surround,
    contrast:
      effect !== null && surround !== null && surround > 0 ? (effect - surround) / surround : null,
  };
}

/** Mean luma of each grid cell. A cell without a measured pixel is NaN. */
function lumaGrid(
  values: Float64Array,
  width: number,
  measured: Uint8Array,
  area: PixelRegion,
  grid: { width: number; height: number },
) {
  const cells = new Float64Array(grid.width * grid.height);
  for (let gy = 0; gy < grid.height; gy++) {
    const y0 = area.y + Math.floor((gy * area.height) / grid.height),
      y1 = area.y + Math.floor(((gy + 1) * area.height) / grid.height);
    for (let gx = 0; gx < grid.width; gx++) {
      const x0 = area.x + Math.floor((gx * area.width) / grid.width),
        x1 = area.x + Math.floor(((gx + 1) * area.width) / grid.width);
      let sum = 0,
        count = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const pixel = y * width + x;
          if (!measured[pixel]) continue;
          sum += values[pixel]!;
          count++;
        }
      cells[gy * grid.width + gx] = count ? sum / count : Number.NaN;
    }
  }
  return cells;
}

/**
 * Distance between the frames of one build and the frames of a human-chosen exemplar.
 * Each build frame aligns with the exemplar frame of the same phase that has the nearest
 * recorded time inside the tolerance. A frame index never aligns frames. Both frames
 * become a grid of mean luma cells over the measured area. The pair distance is the
 * mean absolute cell difference divided by 255, from 0 (equal) to 1. The result is the
 * mean over aligned pairs. It is a baseline number, not a verdict: a different valid
 * design can have a large distance.
 */
export function referenceDistance(
  frames: RecordedFrame[],
  exemplar: RecordedFrame[],
  options: {
    area: PixelRegion | null;
    excluded: PixelRegion[];
    grid: { width: number; height: number };
    toleranceMs: number;
  },
) {
  assertFrames(frames);
  assertFrames(exemplar);
  const { grid, toleranceMs } = options;
  if (
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width < 1 ||
    grid.height < 1 ||
    !Number.isSafeInteger(toleranceMs) ||
    toleranceMs < 0
  )
    throw new Error(
      "A reference distance needs a whole-cell grid and a whole-millisecond tolerance",
    );
  const grids = new Map<RecordedFrame, Float64Array>();
  const cells = (frame: RecordedFrame) => {
    let result = grids.get(frame);
    if (!result) {
      const { width, height } = frame.raster;
      const area = options.area ?? { x: 0, y: 0, width, height };
      const measured = measuredMask(width, height, area, options.excluded);
      if (grid.width > area.width || grid.height > area.height)
        throw new Error("The reference grid must not be larger than the measured area");
      result = lumaGrid(luma(frame.raster), width, measured, area, grid);
      grids.set(frame, result);
    }
    return result;
  };
  const pairs: Array<{
    frameId: string;
    exemplarFrameId: string;
    phaseId: string;
    offsetMs: number;
    distance: number;
  }> = [];
  const unaligned: Array<{
    frameId: string;
    reason: "no_phase" | "outside_tolerance" | "size_differs" | "no_measured_cell";
  }> = [];
  for (const frame of timeOrder(frames)) {
    const match = timeOrder(exemplar.filter((other) => other.phaseId === frame.phaseId)).sort(
      (a, b) =>
        Math.abs(a.recordedMs - frame.recordedMs) - Math.abs(b.recordedMs - frame.recordedMs),
    )[0];
    if (!match) {
      unaligned.push({ frameId: frame.id, reason: "no_phase" });
      continue;
    }
    if (Math.abs(match.recordedMs - frame.recordedMs) > toleranceMs) {
      unaligned.push({ frameId: frame.id, reason: "outside_tolerance" });
      continue;
    }
    if (match.raster.width !== frame.raster.width || match.raster.height !== frame.raster.height) {
      unaligned.push({ frameId: frame.id, reason: "size_differs" });
      continue;
    }
    const a = cells(frame),
      b = cells(match);
    let sum = 0,
      count = 0;
    for (let cell = 0; cell < a.length; cell++) {
      if (Number.isNaN(a[cell]!) || Number.isNaN(b[cell]!)) continue;
      sum += Math.abs(a[cell]! - b[cell]!);
      count++;
    }
    if (!count) {
      unaligned.push({ frameId: frame.id, reason: "no_measured_cell" });
      continue;
    }
    pairs.push({
      frameId: frame.id,
      exemplarFrameId: match.id,
      phaseId: frame.phaseId,
      offsetMs: match.recordedMs - frame.recordedMs,
      distance: sum / count / 255,
    });
  }
  return {
    distance: pairs.length
      ? pairs.reduce((total, pair) => total + pair.distance, 0) / pairs.length
      : null,
    pairs,
    unaligned,
  };
}

interface CaptureMeasureInput {
  frames: RecordedFrame[];
  /** The authored effect region, or null. Without it, the measures use the whole frame. */
  region: EffectRegion | null;
  /** Authored rectangles that no measure reads, for example harness controls. */
  excluded: PixelRegion[];
  /** The smallest luma difference, in 8-bit code values, that changes a pixel. */
  changeThreshold: number;
  /** The smallest count of changed pixels that starts the change. */
  onsetPixels: number;
  /**
   * The frame sets of the human-chosen exemplar for the same view, one set for each
   * capture, or null. Do not include the measured capture.
   */
  reference: null | {
    exemplars: RecordedFrame[][];
    grid: { width: number; height: number };
    toleranceMs: number;
  };
}

/**
 * All pixel measures of one recorded capture. The pre-action frame is the last frame
 * before the action. Change is the count of measured pixels whose luma differs from the
 * pre-action frame by the change threshold or more. Screen coverage divides that count
 * by all pixels of the frame. Onset is the first frame after the action with at least
 * the onset count of changed pixels. Peak is the frame after the action with the most
 * changed pixels; the earlier frame wins a tie. A frame index is its position in
 * recorded-time order.
 */
export function measureCapture(input: CaptureMeasureInput) {
  assertFrames(input.frames);
  const first = input.frames[0]!.raster;
  const { width, height } = first;
  if (input.frames.some((frame) => frame.raster.width !== width || frame.raster.height !== height))
    throw new Error("The frames of one capture must have one size");
  if (
    !Number.isSafeInteger(input.changeThreshold) ||
    input.changeThreshold < 1 ||
    input.changeThreshold > 255 ||
    !Number.isSafeInteger(input.onsetPixels) ||
    input.onsetPixels < 1
  )
    throw new Error("A change threshold is 1 to 255 and an onset count is a positive whole number");
  const region = input.region;
  if (region) {
    if (region.authority !== "criterion" && region.authority !== "view")
      throw new Error("An effect region comes from a criterion or a view");
    assertPixelRegion(region.rectangle, first);
    assertMargin(region.surroundMargin);
  }
  const measured = measuredMask(width, height, region?.rectangle ?? null, input.excluded);
  const open = measuredMask(width, height, null, input.excluded);
  const ordered = timeOrder(input.frames);
  const before = ordered.filter((frame) => frame.recordedMs < 0).at(-1) ?? null;
  const after = ordered.filter((frame) => frame.recordedMs >= 0);
  const reference = before ? luma(before.raster) : null;
  const rows = ordered.map((frame, index) => {
    let changedPixels: number | null = null;
    if (reference) {
      const values = luma(frame.raster);
      changedPixels = 0;
      for (let pixel = 0; pixel < values.length; pixel++)
        if (
          measured[pixel] &&
          Math.abs(values[pixel]! - reference[pixel]!) >= input.changeThreshold
        )
          changedPixels++;
    }
    return {
      index,
      id: frame.id,
      phaseId: frame.phaseId,
      recordedMs: frame.recordedMs,
      changedPixels,
      screenCoverage: changedPixels === null ? null : changedPixels / (width * height),
      weberContrast: region ? contrastOf(frame.raster, region, open).contrast : null,
    };
  });
  const mark = (row: (typeof rows)[number]): FrameMark => ({
    index: row.index,
    id: row.id,
    phaseId: row.phaseId,
    recordedMs: row.recordedMs,
  });
  const later = rows.filter((row) => row.recordedMs >= 0);
  const onsetRow = later.find((row) => (row.changedPixels ?? 0) >= input.onsetPixels);
  let peakRow: (typeof rows)[number] | undefined;
  for (const row of later)
    if ((row.changedPixels ?? 0) > (peakRow?.changedPixels ?? input.onsetPixels - 1)) peakRow = row;
  let contrastRow: (typeof rows)[number] | undefined;
  for (const row of later)
    if (
      row.weberContrast !== null &&
      (contrastRow === undefined ||
        Math.abs(row.weberContrast) > Math.abs(contrastRow.weberContrast!))
    )
      contrastRow = row;
  const peakChange =
    before && later.length
      ? later.reduce((most, row) => Math.max(most, row.changedPixels!), 0)
      : null;
  const references = input.reference
    ? input.reference.exemplars.map((exemplar) =>
        referenceDistance(input.frames, exemplar, {
          area: region?.rectangle ?? null,
          excluded: input.excluded,
          grid: input.reference!.grid,
          toleranceMs: input.reference!.toleranceMs,
        }),
      )
    : null;
  const distances = (references ?? []).flatMap((item) =>
    item.distance === null ? [] : [item.distance],
  );
  return {
    scope: region ? ("authored_region" as const) : ("whole_frame" as const),
    regionAuthority: region?.authority ?? null,
    note: region ? null : "No authored region exists. The measures use the whole frame.",
    issue: !before
      ? ("no_pre_action_frame" as const)
      : !after.length
        ? ("no_post_action_frame" as const)
        : null,
    preActionFrameId: before?.id ?? null,
    frames: rows,
    onset: onsetRow ? mark(onsetRow) : null,
    peak: peakRow ? mark(peakRow) : null,
    references,
    values: {
      weber_contrast: contrastRow?.weberContrast ?? null,
      changed_pixels: peakChange,
      screen_coverage: peakChange === null ? null : peakChange / (width * height),
      onset_ms: onsetRow?.recordedMs ?? null,
      peak_ms: peakRow?.recordedMs ?? null,
      reference_distance: distances.length
        ? distances.reduce((total, value) => total + value, 0) / distances.length
        : null,
    } satisfies Record<PixelMeasure, number | null>,
  };
}
