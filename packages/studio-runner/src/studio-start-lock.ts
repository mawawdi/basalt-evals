import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/*
 * The Studio start lock of one worker account. The lanes of a worker share the Studio
 * preferences of the account. A job holds the lock while it resets the preferences, and while
 * one Studio launch starts, until its process is visible. Thus no reset overlaps a Studio start,
 * and two Studio starts do not happen at the same time.
 */

const execFileAsync = promisify(execFile);

/** The lock folder in the native-worker folder of the account. */
export const STUDIO_START_LOCK = "studio-start.lock";
/** A waiter fails after this time. A holder keeps the lock only for a reset or a launch. */
export const STUDIO_START_WAIT_MS = 5 * 60_000;

interface StartLockOwner {
  token: string;
  pid: number;
  /** The start time of the holder process, so a reused process ID is not the holder. */
  processStartedAt: string;
}

/** The start time of a process, or null if the process does not exist. */
export async function processStartTime(pid: number): Promise<string | null> {
  try {
    // One fixed locale gives one text for one start time in each job.
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      timeout: 10_000,
      maxBuffer: 1024,
    });
    return stdout.trim() || null;
  } catch (error) {
    // ps exits with status 1 when no process has the ID.
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

async function readOwner(directory: string): Promise<StartLockOwner | null> {
  try {
    const owner = JSON.parse(
      await readFile(resolve(directory, "owner.json"), "utf8"),
    ) as StartLockOwner;
    return typeof owner?.token === "string" &&
      Number.isSafeInteger(owner.pid) &&
      typeof owner.processStartedAt === "string"
      ? owner
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Hold the Studio start lock in `directory`. A holder is stale only when its process is gone or
 * its process ID belongs to a newer process. A live holder keeps the lock, and the waiter fails
 * after `waitMs`.
 */
export async function acquireStudioStartLock(input: {
  directory: string;
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
  startTime?: (pid: number) => Promise<string | null>;
}): Promise<{ release(): Promise<void> }> {
  const startTime = input.startTime ?? processStartTime;
  const lock = resolve(input.directory, STUDIO_START_LOCK);
  const own = await startTime(process.pid);
  if (own === null) throw new Error("The worker cannot read its own process start time");
  const owner: StartLockOwner = { token: randomUUID(), pid: process.pid, processStartedAt: own };
  const deadline = performance.now() + (input.waitMs ?? STUDIO_START_WAIT_MS);
  for (;;) {
    input.signal?.throwIfAborted();
    // The lock appears with its owner in one rename, so a lock never exists without an owner.
    const staged = resolve(input.directory, `.${STUDIO_START_LOCK}-${randomUUID()}`);
    await mkdir(staged, { mode: 0o700 });
    await writeFile(resolve(staged, "owner.json"), JSON.stringify(owner) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(staged, lock);
      return {
        async release() {
          if ((await readOwner(lock))?.token === owner.token)
            await rm(lock, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    const holder = await readOwner(lock);
    if (holder && (await startTime(holder.pid)) !== holder.processStartedAt) {
      await removeStale(lock, holder);
      continue;
    }
    if (performance.now() >= deadline)
      throw new Error(
        "Another Studio start in this account did not finish in time. Basalt did not start Studio for this job.",
      );
    await delay(input.pollMs ?? 250, undefined, input.signal ? { signal: input.signal } : {});
  }
}

/**
 * Remove a lock whose holder is gone. Two waiters can see the same stale holder, so the lock
 * moves away first, and a lock of another holder goes back.
 */
async function removeStale(lock: string, stale: StartLockOwner) {
  const moved = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if ((await readOwner(moved))?.token === stale.token) {
    await rm(moved, { recursive: true, force: true });
    return;
  }
  try {
    await rename(moved, lock);
  } catch {
    await rm(moved, { recursive: true, force: true });
    throw new Error(
      "The Studio start lock changed while Basalt removed a stale holder. Basalt did not start Studio for this job.",
    );
  }
}
