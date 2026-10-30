import type { ExposureMeasure } from "../../contracts/src/capabilities.js";
import type { GuiRect, JsonPrimitive } from "../../contracts/src/index.js";
import type { SceneTextObservation } from "../../contracts/src/scene-text.js";
import type { GuiLayoutObservation } from "./gui-layout.js";

/*
 * Pure pixel measures of one captured frame, and the fixed checks that use them. A function
 * reads no file, clock or model. A measure reads luminance only. It does not judge appearance.
 *
 * Relative luminance is the WCAG 2 value: the Rec. 709 weighted sum of linear sRGB values,
 * from 0 for black to 1 for white. The measures ignore the alpha byte.
 */

/** Decoded RGBA bytes in row order. A decoded capture has this shape. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A whole-pixel rectangle of a frame. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameVerdict {
  outcome: "verified" | "rejected" | "incomplete";
  reason: string;
  observed: JsonPrimitive[] | null;
}

/** If the smaller luminance cluster has less of the pixels than this share, the ratio is 1. */
export const MINORITY_SHARE = 0.02;
/** A pixel with a luminance below this value is dark clipped. */
export const DARK_CLIP = 0.02;
/** A pixel with a luminance above this value is bright clipped. */
export const BRIGHT_CLIP = 0.98;
/** The Otsu split uses a histogram with this count of luminance bins. */
const BINS = 256;
/** A reason names at most this many elements. */
const EXAMPLE_LIMIT = 5;

const LINEAR = Float64Array.from({ length: 256 }, (_, code) => {
  const value = code / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

/** The relative luminance of the pixel at this index. */
export function pixelLuminance(raster: Raster, pixel: number): number {
  const offset = pixel * 4;
  return (
    0.2126 * LINEAR[raster.data[offset]!]! +
    0.7152 * LINEAR[raster.data[offset + 1]!]! +
    0.0722 * LINEAR[raster.data[offset + 2]!]!
  );
}

/** The WCAG contrast ratio of two relative luminances, from 1 to 21. */
export function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export interface TextContrast {
  /** The WCAG ratio of the medians of the two luminance clusters. */
  ratio: number;
  /** The count of pixels in the rectangle. */
  pixels: number;
  /** The share of the pixels in the smaller cluster, from 0 to 0.5. */
  minorityShare: number;
}

/**
 * The contrast of the text in one rectangle. An Otsu split divides the pixels into a dark and a
 * bright cluster. The ratio compares the median luminance of the two clusters. If the smaller
 * cluster has less than MINORITY_SHARE of the pixels, there is no second tone and the ratio is 1.
 */
export function textContrast(raster: Raster, rect: PixelRect): TextContrast {
  assertRaster(raster);
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x + rect.width > raster.width ||
    rect.y + rect.height > raster.height
  )
    throw new Error("A text rectangle must be a whole-pixel rectangle inside the frame");
  const values = new Float64Array(rect.width * rect.height);
  const counts = new Float64Array(BINS);
  const sums = new Float64Array(BINS);
  let total = 0;
  for (let y = 0, index = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++, index++) {
      const value = pixelLuminance(raster, (rect.y + y) * raster.width + rect.x + x);
      values[index] = value;
      const bin = binOf(value);
      counts[bin]! += 1;
      sums[bin]! += value;
      total += value;
    }
  const split = otsuSplit(counts, sums, values.length, total);
  if (split === null) return { ratio: 1, pixels: values.length, minorityShare: 0 };
  const dark = values.filter((value) => binOf(value) <= split);
  const bright = values.filter((value) => binOf(value) > split);
  const minorityShare = Math.min(dark.length, bright.length) / values.length;
  if (minorityShare < MINORITY_SHARE) return { ratio: 1, pixels: values.length, minorityShare };
  return {
    ratio: contrastRatio(median(bright), median(dark)),
    pixels: values.length,
    minorityShare,
  };
}

export interface Exposure {
  /** The mean relative luminance, from 0 to 1. */
  meanLuminance: number;
  /** The share of pixels with a luminance below DARK_CLIP, from 0 to 1. */
  darkShare: number;
  /** The share of pixels with a luminance above BRIGHT_CLIP, from 0 to 1. */
  brightShare: number;
}

/** The exposure of all pixels of a frame. */
export function exposure(raster: Raster): Exposure {
  assertRaster(raster);
  const pixels = raster.width * raster.height;
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const value = pixelLuminance(raster, pixel);
    sum += value;
    if (value < DARK_CLIP) dark++;
    if (value > BRIGHT_CLIP) bright++;
  }
  return { meanLuminance: sum / pixels, darkShare: dark / pixels, brightShare: bright / pixels };
}

/**
 * The capture pixels of a GUI rectangle: pixel = (GUI px + GUI inset) × capture width /
 * viewport width, on both axes. Open question S3 of the connector spike checks this formula
 * against captured frames. If the spike finds another formula, change only this function.
 */
export function guiRectInCapture(
  rect: GuiRect,
  layout: Pick<GuiLayoutObservation, "guiInset" | "viewport">,
  captureWidth: number,
): GuiRect {
  const scale = captureWidth / layout.viewport.w;
  return {
    x: (rect.x + layout.guiInset.left) * scale,
    y: (rect.y + layout.guiInset.top) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  };
}

/**
 * The whole pixels of a capture rectangle inside the frame. Each edge goes to the nearest pixel
 * edge. The result is null when no pixel of the rectangle is in the frame.
 */
export function framePixels(rect: GuiRect, width: number, height: number): PixelRect | null {
  const left = Math.max(0, Math.round(rect.x));
  const top = Math.max(0, Math.round(rect.y));
  const right = Math.min(width, Math.round(rect.x + rect.w));
  const bottom = Math.min(height, Math.round(rect.y + rect.h));
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** The reason that a layout gives no text to measure, or null when it does. */
export function layoutIssue(layout: GuiLayoutObservation | null): string | null {
  if (!layout) return "The bound gui_layout fact is absent";
  if (!layout.exists)
    return "No ScreenGui exists at the bound path, so there is no text to measure";
  return null;
}

/**
 * Each text element of the layout that shows an area has a contrast ratio of at least the
 * minimum in the frame. The element must also be visible with the same path in the scene text
 * of the capture. A known offender rejects. Without an offender, a layout that left out elements
 * or an element that the check cannot measure makes the check incomplete. The observed values
 * are the count of checked elements, of offenders and of undecided elements, and the lowest
 * measured ratio.
 */
export function checkTextContrast(
  layout: GuiLayoutObservation | null,
  sceneText: SceneTextObservation,
  raster: Raster,
  minimum: number,
): FrameVerdict {
  if (!layout?.exists)
    return { outcome: "incomplete", reason: layoutIssue(layout)!, observed: null };
  const texts = layout.elements.filter(
    (element) => element.hasText && element.clippedRect && shows(element.clippedRect),
  );
  const offenders: string[] = [];
  const undecided: string[] = [];
  let lowest: number | null = null;
  for (const element of texts) {
    if (!sceneText.entries.some((entry) => entry.path === element.path && entry.visible)) {
      undecided.push(`${element.path} (not visible in the scene text of the capture)`);
      continue;
    }
    const pixels = framePixels(
      guiRectInCapture(element.clippedRect!, layout, raster.width),
      raster.width,
      raster.height,
    );
    if (!pixels) {
      undecided.push(`${element.path} (outside the frame)`);
      continue;
    }
    const measured = textContrast(raster, pixels);
    lowest = lowest === null ? measured.ratio : Math.min(lowest, measured.ratio);
    if (measured.ratio < minimum)
      offenders.push(
        measured.minorityShare < MINORITY_SHARE
          ? `${element.path} (1:1, because no second tone has ${MINORITY_SHARE * 100}% of its pixels)`
          : `${element.path} (${ratioText(measured.ratio)})`,
      );
  }
  const observed = [
    texts.length,
    offenders.length,
    undecided.length,
    lowest === null ? null : Number(lowest.toFixed(2)),
  ];
  if (offenders.length)
    return {
      outcome: "rejected",
      reason: `${count(offenders.length, "text element")} ${offenders.length === 1 ? "has" : "have"} a contrast below ${ratioText(minimum)}: ${examples(offenders)}`,
      observed,
    };
  if (!layout.complete)
    return {
      outcome: "incomplete",
      reason:
        "The layout left out visible elements over its limit, so the check cannot cover all of them",
      observed,
    };
  if (undecided.length)
    return {
      outcome: "incomplete",
      reason: `The check cannot measure ${count(undecided.length, "text element")}: ${examples(undecided)}`,
      observed,
    };
  return {
    outcome: "verified",
    reason: `Each text element has a contrast of at least ${ratioText(minimum)} (${count(texts.length, "text element")} checked${lowest === null ? "" : `, lowest ${ratioText(lowest)}`})`,
    observed,
  };
}

/** The value of one exposure measure as a percent: of white luminance, or of the pixels. */
export function exposurePercent(raster: Raster, measure: ExposureMeasure): number {
  const measured = exposure(raster);
  const share =
    measure === "mean_luminance"
      ? measured.meanLuminance
      : measure === "dark_share"
        ? measured.darkShare
        : measured.brightShare;
  return share * 100;
}

const EXPOSURE_NAMES: Record<ExposureMeasure, string> = {
  mean_luminance: "The mean luminance of the frame",
  dark_share: "The share of dark clipped pixels",
  bright_share: "The share of bright clipped pixels",
};

/** One exposure measure of the frame is in the authored bounds, which are percents. */
export function checkExposure(
  raster: Raster,
  measure: ExposureMeasure,
  minimum: number | null,
  maximum: number | null,
): FrameVerdict {
  if (minimum === null && maximum === null) throw new Error("An exposure check needs a bound");
  const value = exposurePercent(raster, measure);
  const bounds = [
    minimum === null ? null : `at least ${formatted(minimum)}%`,
    maximum === null ? null : `at most ${formatted(maximum)}%`,
  ]
    .filter((item) => item !== null)
    .join(" and ");
  const passed = (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
  return {
    outcome: passed ? "verified" : "rejected",
    reason: `${EXPOSURE_NAMES[measure]} is ${formatted(value)}%, ${passed ? "inside" : "outside"} the authored bounds (${bounds})`,
    observed: [Number(value.toFixed(4))],
  };
}

/** The split bin of the largest variance between the two clusters, or null for one tone. */
function otsuSplit(
  counts: Float64Array,
  sums: Float64Array,
  pixels: number,
  total: number,
): number | null {
  let best: number | null = null;
  let bestVariance = 0;
  let darkCount = 0;
  let darkSum = 0;
  for (let bin = 0; bin < BINS - 1; bin++) {
    darkCount += counts[bin]!;
    darkSum += sums[bin]!;
    const brightCount = pixels - darkCount;
    if (darkCount === 0 || brightCount === 0) continue;
    const difference = darkSum / darkCount - (total - darkSum) / brightCount;
    const variance = darkCount * brightCount * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = bin;
    }
  }
  return best;
}

function binOf(value: number): number {
  return Math.min(BINS - 1, Math.floor(value * BINS));
}

/** The median of the values. For an even count, the mean of the two middle values. */
function median(values: Float64Array): number {
  const sorted = values.slice().sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function assertRaster(raster: Raster): void {
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1 ||
    raster.data.length !== raster.width * raster.height * 4
  )
    throw new Error("A raster must have four bytes for each pixel");
}

/** True when the rectangle has an area. */
function shows(rect: GuiRect): boolean {
  return rect.w > 0 && rect.h > 0;
}

function ratioText(value: number): string {
  return `${formatted(value)}:1`;
}

/** A number with at most two decimals and without a negative zero. */
function formatted(value: number): string {
  return String(Number(value.toFixed(2)) + 0);
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function examples(items: readonly string[]): string {
  return (
    items.slice(0, EXAMPLE_LIMIT).join("; ") +
    (items.length > EXAMPLE_LIMIT ? `; and ${items.length - EXAMPLE_LIMIT} more` : "")
  );
}
