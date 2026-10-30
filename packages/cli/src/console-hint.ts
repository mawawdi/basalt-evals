import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The port of `npm run console`. `scripts/console.mjs` has the same value, and
 * `test/console-hint.test.ts` makes sure that the two values agree.
 */
export const DEFAULT_CONSOLE_PORT = 43127;

/** A result that a person can open: a page of the console, or the report of an export. */
export type ConsoleHintTarget =
  { kind: "run" | "comparison" | "review"; id: string } | { kind: "export"; folder: string };

interface HintStream {
  isTTY?: boolean;
  write(text: string): unknown;
}

const pages = { run: "runs", comparison: "comparisons", review: "reviews" } as const;

/** The URL of the target. An export opens as the `index.html` file of its folder. */
export function consoleHintUrl(target: ConsoleHintTarget): string {
  if (target.kind === "export") return pathToFileURL(resolve(target.folder, "index.html")).href;
  return `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}/${pages[target.kind]}/${encodeURIComponent(target.id)}`;
}

function consoleHintLine(target: ConsoleHintTarget): string {
  return target.kind === "export"
    ? `Open the export in a browser: ${consoleHintUrl(target)}`
    : `Open the ${target.kind} in the console: ${consoleHintUrl(target)}`;
}

/**
 * Writes the result as JSON, and then one line with its URL on stderr. Only a person at a
 * terminal gets the line, so the output of a script stays the same. If the command fails,
 * the error stops it before the output, so a failure writes no line.
 */
export async function outputWithHint<T>(
  result: Promise<T>,
  output: (value: T) => void,
  target: (value: T) => ConsoleHintTarget,
  stream: HintStream = process.stderr,
): Promise<void> {
  const value = await result;
  output(value);
  if (stream.isTTY) stream.write(`${consoleHintLine(target(value))}\n`);
}
