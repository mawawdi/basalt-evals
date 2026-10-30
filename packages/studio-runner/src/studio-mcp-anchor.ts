import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StudioMcpClient } from "./studio-mcp.js";
import { acquireStudioStartLock, processStartTime } from "./studio-start-lock.js";

/*
 * The Studio MCP anchor of one worker account. StudioMCP is a relay. The first StudioMCP on this
 * Mac listens on a local port. Each Studio connects to it, and each later StudioMCP relays
 * through it. If the first StudioMCP exits, the Studios and the relays lose their connection.
 * Each capture starts and stops its own StudioMCP. Thus, without an anchor, the end of a capture
 * in one lane can break a capture in another lane.
 *
 * A keeper process holds one StudioMCP open while a job of this account holds the anchor. The
 * captures of the jobs then relay through it, and the end of a capture closes only a relay. The
 * keeper stops its StudioMCP after the last job releases the anchor. The job and the keeper
 * check each other only while they hold the Studio start lock, so a job never relies on a keeper
 * that stops.
 */

export const MCP_ANCHOR_DIRECTORY = "mcp-anchor";
const HOLDERS = "holders";
const KEEPER_FILE = "keeper.json";
/** The keeper stops when no job holds the anchor for this time. */
export const MCP_ANCHOR_IDLE_MS = 30_000;
/** A job fails if its keeper does not start in this time. */
export const MCP_ANCHOR_START_MS = 20_000;
const KEEPER_POLL_MS = 1_000;
const KEEPER_HEALTH_MS = 10_000;

type StartTime = (pid: number) => Promise<string | null>;

interface ProcessIdentity {
  pid: number;
  /** The start time of the process, so a reused process ID does not count as the same process. */
  processStartedAt: string;
}

async function readIdentity(file: string): Promise<ProcessIdentity | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as ProcessIdentity;
    return Number.isSafeInteger(value?.pid) && typeof value.processStartedAt === "string"
      ? value
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

async function writeIdentity(file: string, identity: ProcessIdentity): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

async function alive(identity: ProcessIdentity | null, startTime: StartTime): Promise<boolean> {
  return identity !== null && (await startTime(identity.pid)) === identity.processStartedAt;
}

async function ownIdentity(startTime: StartTime): Promise<ProcessIdentity> {
  const processStartedAt = await startTime(process.pid);
  if (processStartedAt === null)
    throw new Error("The worker cannot read its own process start time");
  return { pid: process.pid, processStartedAt };
}

/** The number of jobs that hold the anchor. The file of a job whose process is gone is removed. */
async function liveHolders(anchor: string, startTime: StartTime): Promise<number> {
  let count = 0;
  for (const name of await readdir(resolve(anchor, HOLDERS))) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/u.test(name)) continue;
    const file = resolve(anchor, HOLDERS, name);
    if (await alive(await readIdentity(file), startTime)) count += 1;
    else await rm(file, { force: true });
  }
  return count;
}

/**
 * Hold the Studio MCP anchor of the account in `directory` for one job. The job starts a keeper
 * if no keeper runs. Hold the anchor before the first Studio start of the job, and release it
 * after the last capture.
 */
export async function holdStudioMcpAnchor(input: {
  directory: string;
  holderId: string;
  /** Start a detached keeper process, which calls `runStudioMcpKeeper`. */
  startKeeper: () => void;
  signal?: AbortSignal;
  startTime?: StartTime;
  startWaitMs?: number;
  pollMs?: number;
}): Promise<{ release(): Promise<void> }> {
  const startTime = input.startTime ?? processStartTime;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.holderId))
    throw new Error("Invalid Studio MCP anchor holder");
  const anchor = resolve(input.directory, MCP_ANCHOR_DIRECTORY);
  await mkdir(resolve(anchor, HOLDERS), { recursive: true, mode: 0o700 });
  const holder = resolve(anchor, HOLDERS, `${input.holderId}.json`);
  // The holder exists before the check, so a keeper that checks later sees this job.
  await writeIdentity(holder, await ownIdentity(startTime));
  const release = async () => {
    await rm(holder, { force: true });
  };
  try {
    const lock = await acquireStudioStartLock({
      directory: input.directory,
      startTime,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      const keeper = resolve(anchor, KEEPER_FILE);
      if (!(await alive(await readIdentity(keeper), startTime))) {
        await rm(keeper, { force: true });
        input.startKeeper();
        const deadline = performance.now() + (input.startWaitMs ?? MCP_ANCHOR_START_MS);
        while (!(await alive(await readIdentity(keeper), startTime))) {
          if (performance.now() >= deadline)
            throw new Error(
              "Basalt could not start its Studio MCP anchor in this account. Basalt did not start Studio for this job.",
            );
          await delay(input.pollMs ?? 250, undefined, input.signal ? { signal: input.signal } : {});
        }
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    await release();
    throw error;
  }
  return { release };
}

/**
 * Keep one StudioMCP open while a job holds the anchor in `directory`. Return after the last job
 * released the anchor and the StudioMCP exited, or after the StudioMCP stopped. Return at once if
 * another keeper runs.
 */
export async function runStudioMcpKeeper(input: {
  directory: string;
  createClient?: () => StudioMcpClient;
  signal?: AbortSignal;
  startTime?: StartTime;
  idleMs?: number;
  pollMs?: number;
  healthMs?: number;
}): Promise<void> {
  const startTime = input.startTime ?? processStartTime;
  const anchor = resolve(input.directory, MCP_ANCHOR_DIRECTORY);
  await mkdir(resolve(anchor, HOLDERS), { recursive: true, mode: 0o700 });
  const keeper = resolve(anchor, KEEPER_FILE);
  const own = await ownIdentity(startTime);
  // This keeper has no record yet, so a live record belongs to another keeper.
  if (await alive(await readIdentity(keeper), startTime)) return;
  const client = (input.createClient ?? (() => new StudioMcpClient()))();
  try {
    await client.connect();
    await writeIdentity(keeper, own);
    let idleSince = performance.now();
    let checkedAt = performance.now();
    while (!input.signal?.aborted) {
      if ((await liveHolders(anchor, startTime)) > 0) idleSince = performance.now();
      else if (performance.now() - idleSince >= (input.idleMs ?? MCP_ANCHOR_IDLE_MS)) {
        const lock = await acquireStudioStartLock({ directory: input.directory, startTime });
        try {
          if ((await liveHolders(anchor, startTime)) === 0) {
            // The StudioMCP exits before a new keeper can start, so no new anchor relays
            // through a StudioMCP that stops.
            await client.closeAndWait();
            await rm(keeper, { force: true });
            return;
          }
        } finally {
          await lock.release();
        }
        idleSince = performance.now();
      }
      if (performance.now() - checkedAt >= (input.healthMs ?? KEEPER_HEALTH_MS)) {
        checkedAt = performance.now();
        // A StudioMCP that does not answer ends the keeper. The next job starts a new one.
        await client.request("tools/list", {});
      }
      await delay(
        input.pollMs ?? KEEPER_POLL_MS,
        undefined,
        input.signal ? { signal: input.signal } : {},
      ).catch(() => undefined);
    }
  } finally {
    await client.closeAndWait();
    if ((await readIdentity(keeper))?.pid === own.pid) await rm(keeper, { force: true });
  }
}
