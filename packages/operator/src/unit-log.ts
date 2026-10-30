import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { RunUnit } from "../../contracts/src/execution.js";
import { stableJson, type JsonValue } from "../../contracts/src/index.js";

/** The byte limit of one unit log, with its limit notice. */
const MAX_UNIT_LOG_BYTES = 8 * 1024 * 1024;

const LIMIT_NOTICE =
  stableJson({
    event: "log_limit",
    note: "The log reached its byte limit. Basalt records no more lines for this unit.",
  }) + "\n";
const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const namePattern =
  /^(?:builder|seal|final_capture|grading|judgment|review|selection|report)-[a-z0-9][a-z0-9-]{0,100}$/u;

// The appends to one log in this process run one at a time, in their arrival sequence.
const appendTurns = new Map<string, Promise<void>>();

/** The name of the log of a unit: its stage and its ID, for example `builder-tr-1`. */
function unitLogName(unit: Pick<RunUnit, "stage" | "unitId">): string {
  const name = `${unit.stage}-${unit.unitId}`;
  if (!namePattern.test(name)) throw new Error("This unit has no log");
  return name;
}

function unitLogPath(operationId: string, name: string): string {
  if (!operationPattern.test(operationId) || !namePattern.test(name))
    throw new Error("Invalid unit log identity");
  return `.basalt-evals/eval-operations/${operationId}/units/${name}.log`;
}

/**
 * Append one JSON line to the append-only log of a unit. The log records the start, the
 * request ordinals, the tool names, the pauses and the failures of the unit. If the next line
 * does not fit in `limit` bytes, the log gets one limit notice and keeps no more lines.
 */
export async function appendUnitLog(
  root: string,
  operationId: string,
  unit: Pick<RunUnit, "stage" | "unitId">,
  entry: Record<string, JsonValue>,
  limit = MAX_UNIT_LOG_BYTES,
): Promise<void> {
  const relative = unitLogPath(operationId, unitLogName(unit));
  const file = resolve(root, relative);
  const previous = appendTurns.get(file) ?? Promise.resolve();
  let done!: () => void;
  const turn = new Promise<void>((resolve) => (done = resolve));
  appendTurns.set(file, turn);
  try {
    await previous;
    await new RepositoryFiles(root).directory(relative.slice(0, relative.lastIndexOf("/")));
    const line = stableJson({ at: new Date().toISOString(), ...entry }) + "\n";
    const handle = await open(
      file,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const size = (await handle.stat()).size;
      if (size + Buffer.byteLength(line) + LIMIT_NOTICE.length <= limit) {
        await handle.appendFile(line);
        return;
      }
      // Read the tail of the log. A log that ends with the notice is already full.
      const tail = Buffer.alloc(Math.min(size, LIMIT_NOTICE.length));
      await handle.read(tail, 0, tail.length, size - tail.length);
      if (tail.toString("utf8") !== LIMIT_NOTICE) await handle.appendFile(LIMIT_NOTICE);
    } finally {
      await handle.close();
    }
  } finally {
    done();
    if (appendTurns.get(file) === turn) appendTurns.delete(file);
  }
}

/** The text of the log of a unit, for example `builder-tr-1`. */
export async function readUnitLog(root: string, operationId: string, name: string) {
  const file = resolve(root, unitLogPath(operationId, name));
  try {
    return (await readBoundedRegularFile(file, MAX_UNIT_LOG_BYTES, "unit log")).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("This unit has no log yet.");
    throw error;
  }
}
