/** Above this count of lines on both sides together, a change is too large to show. */
export const MAX_DIFF_LINES = 20_000;
/** The unchanged lines that a hunk shows before and after each changed line. */
const CONTEXT_LINES = 3;

interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}
interface DiffHunk {
  /** The first line of the hunk in the earlier text, from 1. */
  beforeStart: number;
  /** The first line of the hunk in the later text, from 1. */
  afterStart: number;
  lines: DiffLine[];
}
type LineDiff =
  | { tooLarge: false; added: number; removed: number; hunks: DiffHunk[] }
  | { tooLarge: true; added: null; removed: null; hunks: null };

type Edit = { kind: DiffLine["kind"]; before: number; after: number };

function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  // A final line break does not make an empty last line.
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * The line changes from one text to another, with the Myers algorithm in linear space. The
 * result groups the changes into hunks with three lines of context. A pair of texts with more
 * than MAX_DIFF_LINES lines together is too large to show.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const left = lines(before),
    right = lines(after);
  if (left.length + right.length > MAX_DIFF_LINES)
    return { tooLarge: true, added: null, removed: null, hunks: null };
  // Compare small integers instead of strings: equal lines get equal numbers.
  const numbers = new Map<string, number>();
  const encode = (line: string) => {
    let value = numbers.get(line);
    if (value === undefined) numbers.set(line, (value = numbers.size));
    return value;
  };
  const a = Int32Array.from(left, encode),
    b = Int32Array.from(right, encode);
  const edits: Edit[] = [];
  diffRange(a, 0, a.length, b, 0, b.length, edits);
  return {
    tooLarge: false,
    added: edits.filter((edit) => edit.kind === "added").length,
    removed: edits.filter((edit) => edit.kind === "removed").length,
    hunks: hunks(edits, left, right),
  };
}

function diffRange(
  a: Int32Array,
  aStart: number,
  aEnd: number,
  b: Int32Array,
  bStart: number,
  bEnd: number,
  edits: Edit[],
): void {
  let prefix = 0;
  while (
    aStart + prefix < aEnd &&
    bStart + prefix < bEnd &&
    a[aStart + prefix] === b[bStart + prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    aEnd - suffix > aStart + prefix &&
    bEnd - suffix > bStart + prefix &&
    a[aEnd - suffix - 1] === b[bEnd - suffix - 1]
  )
    suffix++;
  for (let index = 0; index < prefix; index++)
    edits.push({ kind: "context", before: aStart + index, after: bStart + index });
  const from = aStart + prefix,
    to = aEnd - suffix,
    otherFrom = bStart + prefix,
    otherTo = bEnd - suffix;
  if (from === to)
    for (let index = otherFrom; index < otherTo; index++)
      edits.push({ kind: "added", before: from, after: index });
  else if (otherFrom === otherTo)
    for (let index = from; index < to; index++)
      edits.push({ kind: "removed", before: index, after: otherFrom });
  else {
    const split = middleSnake(a, from, to, b, otherFrom, otherTo);
    if (split) {
      diffRange(a, from, split[0], b, otherFrom, split[1], edits);
      diffRange(a, split[0], to, b, split[1], otherTo, edits);
    } else {
      for (let index = from; index < to; index++)
        edits.push({ kind: "removed", before: index, after: otherFrom });
      for (let index = otherFrom; index < otherTo; index++)
        edits.push({ kind: "added", before: to, after: index });
    }
  }
  for (let index = suffix; index > 0; index--)
    edits.push({ kind: "context", before: aEnd - index, after: bEnd - index });
}

/**
 * The point where the forward and the reverse search of a shortest edit path meet. The two
 * ranges have no common first or last line. Null when the ranges have no common line.
 */
function middleSnake(
  a: Int32Array,
  aStart: number,
  aEnd: number,
  b: Int32Array,
  bStart: number,
  bEnd: number,
): [number, number] | null {
  const n = aEnd - aStart,
    m = bEnd - bStart;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD,
    size = 2 * maxD + 2;
  const forward = new Int32Array(size).fill(-1),
    reverse = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = n - m;
  // With an odd delta the forward search finds the overlap; with an even delta the reverse.
  const front = delta % 2 !== 0;
  let forwardStart = 0,
    forwardEnd = 0,
    reverseStart = 0,
    reverseEnd = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && forward[index - 1]! < forward[index + 1]!)
          ? forward[index + 1]!
          : forward[index - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      forward[index] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (front) {
        const other = offset + delta - k;
        if (other >= 0 && other < size && reverse[other] !== -1 && x >= n - reverse[other]!)
          return [aStart + x, bStart + y];
      }
    }
    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && reverse[index - 1]! < reverse[index + 1]!)
          ? reverse[index + 1]!
          : reverse[index - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aEnd - x - 1] === b[bEnd - y - 1]) {
        x++;
        y++;
      }
      reverse[index] = x;
      if (x > n) reverseEnd += 2;
      else if (y > m) reverseStart += 2;
      else if (!front) {
        const other = offset + delta - k;
        if (other >= 0 && other < size && forward[other] !== -1) {
          const forwardX = forward[other]!;
          const forwardY = forwardX - (other - offset);
          if (forwardX >= n - x) return [aStart + forwardX, bStart + forwardY];
        }
      }
    }
  }
  return null;
}

function hunks(edits: Edit[], left: string[], right: string[]): DiffHunk[] {
  const changed = edits.flatMap((edit, index) => (edit.kind === "context" ? [] : [index]));
  const result: DiffHunk[] = [];
  let position = 0;
  while (position < changed.length) {
    const first = changed[position]!;
    let last = first;
    // Changes with no more than two context ranges between them share one hunk.
    while (position + 1 < changed.length && changed[position + 1]! - last <= 2 * CONTEXT_LINES + 1)
      last = changed[++position]!;
    position++;
    const start = Math.max(0, first - CONTEXT_LINES),
      end = Math.min(edits.length, last + CONTEXT_LINES + 1);
    const slice = edits.slice(start, end);
    result.push({
      beforeStart: slice[0]!.before + 1,
      afterStart: slice[0]!.after + 1,
      lines: slice.map((edit) => ({
        kind: edit.kind,
        text: edit.kind === "added" ? right[edit.after]! : left[edit.before]!,
      })),
    });
  }
  return result;
}
