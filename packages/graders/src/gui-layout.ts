import type { GuiLayoutCheck } from "../../contracts/src/capabilities.js";
import type { GuiLayoutElement, GuiRect, StudioObservation } from "../../contracts/src/index.js";

/*
 * The fixed checks of one gui_layout observation. They read geometry and text fit as Studio
 * reports them, in GUI pixels. They do not read the rendered appearance.
 */

export type GuiLayoutObservation = Extract<StudioObservation, { kind: "gui_layout" }>;

export interface GuiLayoutVerdict {
  outcome: "verified" | "rejected" | "incomplete";
  reason: string;
  /**
   * The count of checked elements, of offenders and of undecided elements, or null when there
   * is no layout to read. An offender of no_text_overlap is a pair of elements.
   */
  counts: [checked: number, offending: number, undecided: number] | null;
}

/**
 * Basalt ignores a difference of 0.01 GUI px or less. Studio rounds its numbers, so such a
 * difference does not come from the layout. The plan validator uses the same tolerance.
 */
const ROUNDING_PX = 0.01;
/** A reason names at most this many elements. */
const EXAMPLE_LIMIT = 5;

/** The result of one check before the shared rules for an incomplete layout. */
interface Findings {
  checked: number;
  offenders: string[];
  /** The elements that the check cannot decide, as paths. */
  undecided: string[];
  /** The reason when nothing fails and nothing is undecided. */
  verified: string;
  /** The start of the reason for a rejection, before the examples. */
  rejected: (total: number) => string;
  /** The start of the reason for undecided elements, before the examples. */
  undecidedReason: (total: number) => string;
}

/**
 * Grade one check of one gui_layout observation. A known offender rejects, also in a layout
 * that left out elements. Without an offender, a left-out or undecided element makes the check
 * incomplete.
 */
export function checkGuiLayout(
  observation: GuiLayoutObservation | null,
  check: GuiLayoutCheck,
  minimumPx: number | null,
): GuiLayoutVerdict {
  if ((check === "min_text_px") !== (minimumPx !== null))
    throw new Error("Only the check min_text_px has a minimum");
  if (!observation)
    return { outcome: "incomplete", reason: "The bound gui_layout fact is absent", counts: null };
  if (!observation.exists)
    return {
      outcome: "incomplete",
      reason: "No ScreenGui exists at the bound path, so there is no layout to check",
      counts: null,
    };
  const findings =
    check === "on_screen"
      ? onScreen(observation)
      : check === "no_text_overlap"
        ? noTextOverlap(observation.elements)
        : check === "text_fits"
          ? textFits(observation.elements)
          : minTextPx(observation.elements, minimumPx!);
  const counts: [number, number, number] = [
    findings.checked,
    findings.offenders.length,
    findings.undecided.length,
  ];
  if (findings.offenders.length > 0)
    return {
      outcome: "rejected",
      reason: `${findings.rejected(findings.offenders.length)}: ${examples(findings.offenders)}`,
      counts,
    };
  if (!observation.complete)
    return {
      outcome: "incomplete",
      reason:
        "The layout left out visible elements over its limit, so the check cannot cover all of them",
      counts,
    };
  if (findings.undecided.length > 0)
    return {
      outcome: "incomplete",
      reason: `${findings.undecidedReason(findings.undecided.length)}: ${examples(findings.undecided)}`,
      counts,
    };
  return { outcome: "verified", reason: findings.verified, counts };
}

/**
 * The viewport in GUI pixels. A viewport pixel is a GUI pixel plus the GUI inset, for both
 * values of IgnoreGuiInset. The connector spike checks this formula against captured frames.
 */
export function viewportInGuiPixels(observation: GuiLayoutObservation): GuiRect {
  return {
    x: -observation.guiInset.left,
    y: -observation.guiInset.top,
    w: observation.viewport.w,
    h: observation.viewport.h,
  };
}

/** Each element that shows a part of itself lies inside the viewport. */
function onScreen(observation: GuiLayoutObservation): Findings {
  const view = viewportInGuiPixels(observation);
  const shown = observation.elements.filter((element) => shows(element.clippedRect));
  return {
    checked: shown.length,
    offenders: shown
      .filter((element) => !inside(element.clippedRect!, view))
      .map((element) => `${element.path} at ${rectText(element.clippedRect!)}`),
    undecided: [],
    verified: `No visible element extends outside the viewport ${rectText(view)} (${count(shown.length, "element")} checked)`,
    rejected: (total) =>
      `${count(total, "visible element")} ${total === 1 ? "extends" : "extend"} outside the viewport ${rectText(view)}`,
    undecidedReason: () => "",
  };
}

/**
 * No two text elements that show a part of themselves have a common area. A pair of an element
 * and its ancestor does not count. A name can contain a period, so a path prefix can also skip a
 * pair that is not related.
 */
function noTextOverlap(elements: readonly GuiLayoutElement[]): Findings {
  const texts = elements.filter((element) => element.hasText && shows(element.clippedRect));
  const offenders: string[] = [];
  for (const [index, first] of texts.entries())
    for (const second of texts.slice(index + 1)) {
      if (related(first.path, second.path)) continue;
      const common = intersection(first.clippedRect!, second.clippedRect!);
      if (common)
        offenders.push(
          `${first.path} and ${second.path} share ${formatted(common.w)} × ${formatted(common.h)} px`,
        );
    }
  return {
    checked: texts.length,
    offenders,
    undecided: [],
    verified: `No two shown text elements overlap (${count(texts.length, "text element")} checked)`,
    rejected: (total) => `${count(total, "pair")} of text elements overlap`,
    undecidedReason: () => "",
  };
}

/** Studio reports TextFits true for each text element. TextScaled does not change this. */
function textFits(elements: readonly GuiLayoutElement[]): Findings {
  const texts = elements.filter((element) => element.hasText);
  return {
    checked: texts.length,
    offenders: texts
      .filter((element) => element.textFits !== true)
      .map(
        (element) =>
          `${element.path} (text ${formatted(element.textBounds!.w)} × ${formatted(element.textBounds!.h)} px in ${formatted(element.rect.w)} × ${formatted(element.rect.h)} px${element.textScaled ? ", TextScaled" : ""})`,
      ),
    undecided: [],
    verified: `The text of each text element fits (${count(texts.length, "text element")} checked)`,
    rejected: (total) =>
      `${count(total, "text element")} ${total === 1 ? "does" : "do"} not fit ${total === 1 ? "its" : "their"} text`,
    undecidedReason: () => "",
  };
}

/**
 * Each text element has a TextSize of at least the minimum. TextSize does not give the rendered
 * size of a TextScaled element, so that element is undecided.
 */
function minTextPx(elements: readonly GuiLayoutElement[], minimum: number): Findings {
  const texts = elements.filter((element) => element.hasText);
  return {
    checked: texts.length,
    offenders: texts
      .filter((element) => element.textScaled !== true && element.textSize! < minimum)
      .map((element) => `${element.path} (TextSize ${formatted(element.textSize!)})`),
    undecided: texts
      .filter((element) => element.textScaled === true)
      .map((element) => element.path),
    verified: `Each text element has a TextSize of at least ${formatted(minimum)} px (${count(texts.length, "text element")} checked)`,
    rejected: (total) =>
      `${count(total, "text element")} ${total === 1 ? "has" : "have"} a TextSize below ${formatted(minimum)} px`,
    undecidedReason: (total) =>
      `${count(total, "text element")} ${total === 1 ? "uses" : "use"} TextScaled, so TextSize does not give the rendered size`,
  };
}

/** True when a part of the element shows: it has a clipped rectangle with an area. */
function shows(rect: GuiRect | undefined): boolean {
  return rect !== undefined && rect.w > 0 && rect.h > 0;
}

function inside(rect: GuiRect, frame: GuiRect): boolean {
  return (
    rect.x >= frame.x - ROUNDING_PX &&
    rect.y >= frame.y - ROUNDING_PX &&
    rect.x + rect.w <= frame.x + frame.w + ROUNDING_PX &&
    rect.y + rect.h <= frame.y + frame.h + ROUNDING_PX
  );
}

/** The common area of two rectangles, or null when a side is not more than ROUNDING_PX. */
function intersection(a: GuiRect, b: GuiRect): { w: number; h: number } | null {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > ROUNDING_PX && h > ROUNDING_PX ? { w, h } : null;
}

/** True when one path is an ancestor of the other. GetFullName joins names with periods. */
function related(first: string, second: string): boolean {
  return second.startsWith(`${first}.`) || first.startsWith(`${second}.`);
}

function examples(items: readonly string[]): string {
  return (
    items.slice(0, EXAMPLE_LIMIT).join("; ") +
    (items.length > EXAMPLE_LIMIT ? `; and ${items.length - EXAMPLE_LIMIT} more` : "")
  );
}

/** A number with at most two decimals and without a negative zero. */
function formatted(value: number): string {
  return String(Number(value.toFixed(2)) + 0);
}

function rectText(rect: GuiRect): string {
  return `(x ${formatted(rect.x)}, y ${formatted(rect.y)}, ${formatted(rect.w)} × ${formatted(rect.h)} px)`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
