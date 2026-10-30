import { rubricDocument } from "./rubric-document.js";
import type { ScoreRange } from "../../contracts/src/index.js";

export function authoredScoreRange(text: string): ScoreRange | null {
  const ranges = [
    ...text.matchAll(
      /\b(?:scoring\s+scale|scale|score|rating|rank)\s*(?:(?:of|from|range|between|is)\s*)?[:=]?\s*(-?\d+(?:\.\d+)?)\s*(?:[-–—]|to|through|out of|and)\s*(-?\d+(?:\.\d+)?)\b/giu,
    ),
  ];
  if (!ranges.length) return null;
  const stepMatch = /\b(?:steps?|increments?)\s+(?:of\s+)?(\d+(?:\.\d+)?)/iu.exec(text);
  const step = stepMatch
    ? Number(stepMatch[1])
    : /\b(?:integer|whole.number)\s+(?:scores?|scale|ratings?)\b/iu.test(text)
      ? 1
      : null;
  const first = ranges[0]!,
    range = { minimum: Number(first[1]), maximum: Number(first[2]), step };
  if (
    ranges.some((match) => Number(match[1]) !== range.minimum || Number(match[2]) !== range.maximum)
  )
    throw new Error("Authored scoring ranges have conflicting scope");
  if (
    range.minimum >= range.maximum ||
    (step !== null && (step <= 0 || step > range.maximum - range.minimum))
  )
    throw new Error(
      "Authored score range needs ordered bounds and a positive step within the range",
    );
  return range;
}

/** Extract declared scoring metadata from retained authored passages, never from a proposal. */
export function authoredScoreAnchors(text: string): Array<{ score: number; label: string }> {
  const metadata = rubricDocument(text).filter((node) => node.role === "grading_metadata");
  const anchors: Array<{ score: number; label: string }> = [];
  const add = (score: string, label: string) => {
    const anchor = { score: Number(score), label: label.trim() };
    if (!anchors.some((item) => item.score === anchor.score && item.label === anchor.label))
      anchors.push(anchor);
  };
  for (const line of text.split(/\r?\n/u)) {
    const list = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(\d+(?:\.\d+)?)\s*:\s*(.+)$/u.exec(line);
    if (list) {
      add(list[1]!, list[2]!);
      continue;
    }
    const row = /^\s*\|?\s*(\d+(?:\.\d+)?)\s*\|\s*([^|]+)\s*\|?\s*$/u.exec(line);
    if (
      row &&
      metadata.some((node) => node.kind === "table_row" && node.text.trim() === line.trim())
    ) {
      add(row[1]!, row[2]!);
      continue;
    }
    // A sentence delimiter before the next Score marker separates anchors;
    // punctuation inside an anchor's label stays part of the authored label.
    const markers = [...line.matchAll(/\bscore\s+(\d+(?:\.\d+)?)\s*[:=]\s*/giu)];
    for (const [index, marker] of markers.entries()) {
      const end = markers[index + 1]?.index ?? line.length;
      const label = line
        .slice(marker.index! + marker[0].length, end)
        .split(/\s+(?:(?:minimum\s+)?passing score|(?:scoring\s+)?weight)\b/iu)[0]!
        .trim()
        .replace(/[.;]\s*$/u, "");
      if (label) add(marker[1]!, label);
    }
  }
  return anchors;
}

export function authoredNumericScale(text: string): boolean {
  if (authoredScoreAnchors(text).length) return true;
  // A scoring weight controls importance; it is not a score range.
  return text
    .split(/\r?\n/u)
    .some(
      (line) =>
        !/^\s*(?:[-*+]\s+)?(?:scoring\s+)?weight\b/iu.test(line) &&
        /\b(?:scoring\s+scale|scale|score|rating|rank)\s*(?:(?:of|from|range|between|is)\s*)?[:=]?\s*-?\d+(?:\.\d+)?\s*(?:[-–—]|to|through|out of|and)\s*-?\d+(?:\.\d+)?\b/iu.test(
          line,
        ),
    );
}
