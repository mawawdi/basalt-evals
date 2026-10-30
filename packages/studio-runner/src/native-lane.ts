import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { contentHash, hashJson } from "../../contracts/src/index.js";
import { MAX_STUDIO_LANES, studioLaneConnectorUrl, type StudioSlot } from "./studio-lanes.js";

const lanesDirectory = (stateRoot: string) => resolve(stateRoot, "native-worker/lanes");

/** The holder of a lane renews its lease in this interval. */
export const LANE_RENEW_MS = 20_000;
/** A lane lease expires after three missed renewals. */
export const LANE_LEASE_MS = 3 * LANE_RENEW_MS;
/** The remote worker renews its job lease every 10 s, so it expires after three missed renewals. */
const REMOTE_LEASE_MS = 30_000;
/** The release record of a lost dispatched job. It is beside the session, outside the signed tree. */
export const LANE_RELEASE_FILE = "lane-release.json";

/** The claim of one lane. The holder renews `renewedAt` while it holds the lane. */
export interface NativeLaneOwner {
  worker: string;
  pid: number;
  sessionDirectory: string;
  lane: number;
  claimedAt: string;
  renewedAt: string;
  leaseMs: number;
}

/** The read-only facts of a dispatched job in the worker account. */
export interface RemoteJobProbe {
  /** The `renewedAt` of the remote job lease, or null when the job wrote no lease. */
  leaseRenewedAt: string | null;
  /** True if an account process has the worker process group or names the job folder. */
  processes: boolean;
  /** True if the worker published its signed receipt. */
  receipt: boolean;
}

/** Reads the facts of a dispatched job. Any error keeps the lane. */
type RemoteJobProber = (owner: NativeLaneOwner) => Promise<RemoteJobProbe>;

export class NativeLaneBusy extends ExecutionFault {
  constructor(stateRoot: string) {
    super({
      causeCode: "studio_lane_busy",
      category: "recovery",
      dependency: hashJson({ lanes: lanesDirectory(stateRoot) }),
      unit: { stage: "studio_admission", id: "native" },
      evidenceRefs: [],
      recoveryActions: ["resume"],
      explanation:
        "Studio is busy with another run, or this Mac can't run another Studio slot now: it needs enough free memory and CPU, and no Studio MCP open in your account. Basalt did not start this observation. When Studio is available, resume the run.",
    });
  }
}

interface NativeLaneAdmission {
  lane: number;
  requestedAt: string;
  admittedAt: string;
  waitedMs: number;
}

/** Admission is cancellable and bounded; an uncertain dispatched owner is never displaced. */
export async function waitForNativeLane(input: {
  stateRoot: string;
  sessionDirectory: string;
  /** The slots that this job can use. A prepared session can use only the lane of its port. */
  slots: readonly StudioSlot[];
  /** Reads a dispatched job whose controller is gone. Without it, no dispatched lane comes back. */
  probe?: RemoteJobProber;
  /** The headroom check of a lane beside a held lane. Without it, each free lane is admitted. */
  headroom?: () => Promise<boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  onWaiting?: () => Promise<void>;
}): Promise<NativeLaneAdmission> {
  const requestedAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs ?? 15 * 60_000;
  const pollMs = input.pollMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0)
    throw new Error("Studio admission needs a positive wait bound");
  const started = performance.now();
  let notified = false;
  // A probe uses SSH, so one wait probes the lost lanes at most one time in 10 s.
  let nextProbe = 0;
  const failure = (cancelled: boolean) =>
    new ExecutionFault({
      causeCode: cancelled ? "studio_lane_wait_cancelled" : "studio_lane_wait_timeout",
      category: "recovery",
      dependency: hashJson({ lanes: lanesDirectory(input.stateRoot) }),
      unit: { stage: "studio_admission", id: "native" },
      evidenceRefs: [],
      recoveryActions: ["resume"],
      explanation: cancelled
        ? "The run stopped while it waited for Studio. Basalt did not start this observation. To continue, resume the run."
        : "Studio was still busy at the end of the wait, or this Mac still couldn't run another Studio slot: it needs enough free memory and CPU, and no Studio MCP open in your account. Basalt did not start this observation. To wait again, resume the run.",
    });
  for (;;) {
    if (input.signal?.aborted) throw failure(true);
    try {
      const lane = await claimNativeLane(
        input.stateRoot,
        input.sessionDirectory,
        input.slots,
        input.headroom,
      );
      return {
        lane,
        requestedAt,
        admittedAt: new Date().toISOString(),
        waitedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (!(error instanceof NativeLaneBusy)) throw error;
    }
    if (input.probe && performance.now() >= nextProbe) {
      nextProbe = performance.now() + 10_000;
      const released = await reclaimLostLanes(
        input.stateRoot,
        input.slots.map((slot) => slot.lane),
        input.probe,
      );
      if (released.length) continue;
    }
    if (!notified) {
      notified = true;
      await input.onWaiting?.();
    }
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) throw failure(false);
    await delay(Math.min(pollMs, remaining), undefined, { signal: input.signal }).catch((error) => {
      if (!input.signal?.aborted) throw error;
    });
  }
}

const OWNER_KEYS = "claimedAt,lane,leaseMs,pid,renewedAt,sessionDirectory,worker";

function readLaneOwner(lane: string): NativeLaneOwner {
  if (!lstatSync(lane).isDirectory()) throw new Error("Unsafe Studio lane directory");
  const fd = openSync(
    resolve(lane, "owner.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 4096) throw new Error("Unsafe Studio lane owner");
    const owner = JSON.parse(readFileSync(fd, "utf8")) as NativeLaneOwner;
    if (
      !owner ||
      typeof owner !== "object" ||
      Object.keys(owner).sort().join(",") !== OWNER_KEYS ||
      typeof owner.worker !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.sessionDirectory !== "string" ||
      !Number.isSafeInteger(owner.lane) ||
      !Number.isFinite(Date.parse(owner.claimedAt)) ||
      !Number.isFinite(Date.parse(owner.renewedAt)) ||
      !Number.isSafeInteger(owner.leaseMs) ||
      owner.leaseMs < 1
    )
      throw new Error("Invalid Studio lane owner");
    return owner;
  } finally {
    closeSync(fd);
  }
}

/** The owner of each lane directory that exists. A lane without an owner file has none yet. */
function laneOwners(stateRoot: string): Array<{ lane: number; owner: NativeLaneOwner }> {
  const directory = lanesDirectory(stateRoot);
  const owners: Array<{ lane: number; owner: NativeLaneOwner }> = [];
  for (const name of readdirSync(directory)) {
    const lane = Number(name);
    // Only a lane number names a lane. Other entries, for example Finder metadata, own nothing.
    if (String(lane) !== name || lane < 0 || lane >= MAX_STUDIO_LANES) continue;
    try {
      owners.push({ lane, owner: readLaneOwner(resolve(directory, name)) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return owners;
}

/** Serialize short filesystem ownership changes across all console/driver processes. */
async function laneTransaction<T>(stateRoot: string, change: () => T): Promise<T> {
  const directory = lanesDirectory(stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeAbsoluteDirectory(directory);
  const journal = await OperationJournal.open(dirname(stateRoot));
  try {
    return journal.transaction(change);
  } finally {
    journal.close();
  }
}

function processDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    return true;
  }
}

/** A session of the state root is the only session that a claim can change. */
function ownedSession(stateRoot: string, owner: NativeLaneOwner): boolean {
  return (
    owner.sessionDirectory.startsWith(resolve(stateRoot) + "/") &&
    resolve(owner.sessionDirectory) === owner.sessionDirectory
  );
}

function dispatched(owner: NativeLaneOwner): boolean {
  try {
    lstatSync(resolve(owner.sessionDirectory, "native/remote-job.json"));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * True if the owner of a lane can lose its claim at once: the owner process is dead and its job
 * did not reach Studio. The dispatch marker is persisted before SSH, so a dead, undispatched owner
 * has no remote process. A dispatched owner is uncertain.
 */
function reclaimable(stateRoot: string, owner: NativeLaneOwner) {
  return processDead(owner.pid) && ownedSession(stateRoot, owner) && !dispatched(owner);
}

/** A dispatched owner whose controller process is dead and whose lease expired. */
function lostCandidate(stateRoot: string, owner: NativeLaneOwner, now: number) {
  return (
    ownedSession(stateRoot, owner) &&
    now - Date.parse(owner.renewedAt) > owner.leaseMs &&
    processDead(owner.pid) &&
    dispatched(owner)
  );
}

/** True only if the remote facts prove that the job stopped without a signed receipt. */
export function remoteJobLost(probe: RemoteJobProbe, now: number): boolean {
  if (probe.processes || probe.receipt) return false;
  if (probe.leaseRenewedAt === null) return true;
  const renewed = Date.parse(probe.leaseRenewedAt);
  return Number.isFinite(renewed) && now - renewed > REMOTE_LEASE_MS;
}

function writeOwner(path: string, owner: NativeLaneOwner, flag: "wx" | "replace") {
  const text = JSON.stringify(owner) + "\n";
  if (flag === "wx") {
    writeFileSync(resolve(path, "owner.json"), text, { flag: "wx", mode: 0o600 });
    return;
  }
  // The new owner record appears complete or not at all.
  const temporary = resolve(path, `.owner-${randomUUID()}.json`);
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, resolve(path, "owner.json"));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** True if a lane has a claim of another session that cannot lose it at once. */
function heldByOthers(stateRoot: string, sessionDirectory: string): boolean {
  return laneOwners(stateRoot).some(
    ({ owner }) => owner.sessionDirectory !== sessionDirectory && !reclaimable(stateRoot, owner),
  );
}

/**
 * Claim the first available slot of `slots` for one session, and return its lane. A session that
 * this process already admitted keeps its lane. A session holds at most one lane: a dead,
 * undispatched claim of the same session goes first. No claim displaces a dispatched owner.
 * With `headroom`, a lane beside a held lane needs headroom on this Mac. The first lane needs
 * none, so a busy Mac still runs one lane.
 */
export async function claimNativeLane(
  stateRoot: string,
  sessionDirectory: string,
  slots: readonly StudioSlot[],
  headroom?: () => Promise<boolean>,
): Promise<number> {
  if (!slots.length) throw new Error("A Studio claim needs at least one lane");
  for (const slot of slots) studioLaneConnectorUrl(slot.lane);
  const lanes = slots.map((slot) => slot.lane);
  // The check reads the machine, so it runs before the short transaction. The transaction then
  // decides again with the lanes that it sees.
  let held = false;
  try {
    held = heldByOthers(stateRoot, sessionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const admitted = headroom && held ? await headroom() : null;
  return laneTransaction(stateRoot, () => {
    for (const { lane, owner } of laneOwners(stateRoot)) {
      if (owner.sessionDirectory !== sessionDirectory) continue;
      if (owner.pid === process.pid) {
        if (!lanes.includes(lane))
          throw new Error("The Studio session holds a lane that differs from its connector port");
        return lane;
      }
      // Another live process or an uncertain dispatched job holds this session.
      if (!reclaimable(stateRoot, owner)) throw new NativeLaneBusy(stateRoot);
      rmSync(resolve(lanesDirectory(stateRoot), String(lane)), { recursive: true });
    }
    if (headroom && admitted !== true && heldByOthers(stateRoot, sessionDirectory))
      throw new NativeLaneBusy(stateRoot);
    for (const slot of slots) {
      const path = resolve(lanesDirectory(stateRoot), String(slot.lane));
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!reclaimable(stateRoot, readLaneOwner(path))) continue;
        rmSync(path, { recursive: true });
        mkdirSync(path, { mode: 0o700 });
      }
      const at = new Date().toISOString();
      try {
        writeOwner(
          path,
          {
            worker: slot.worker,
            pid: process.pid,
            sessionDirectory,
            lane: slot.lane,
            claimedAt: at,
            renewedAt: at,
            leaseMs: LANE_LEASE_MS,
          },
          "wx",
        );
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      return slot.lane;
    }
    throw new NativeLaneBusy(stateRoot);
  });
}

/** Renew the lease of the lane that this process holds for one session. False if it holds none. */
export async function renewNativeLane(
  stateRoot: string,
  sessionDirectory: string,
): Promise<boolean> {
  return laneTransaction(stateRoot, () => {
    for (const { lane, owner } of laneOwners(stateRoot)) {
      if (owner.sessionDirectory !== sessionDirectory || owner.pid !== process.pid) continue;
      writeOwner(
        resolve(lanesDirectory(stateRoot), String(lane)),
        { ...owner, renewedAt: new Date().toISOString() },
        "replace",
      );
      return true;
    }
    return false;
  });
}

/** Renew the lease of a held lane until `stop`. A failed renewal waits for the next interval. */
export function holdNativeLane(
  stateRoot: string,
  sessionDirectory: string,
  intervalMs = LANE_RENEW_MS,
): { stop(): Promise<void> } {
  let renewal: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(() =>
      renewNativeLane(stateRoot, sessionDirectory).catch(() => undefined),
    );
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
}

/**
 * Take back each lane of `lanes` whose dispatched job is lost. A job is lost only if its
 * controller process is dead, its local lease expired, the remote probe succeeds, the remote
 * lease expired, no account process belongs to the job and no signed receipt exists. The probe
 * runs outside the journal transaction. The removal then checks that the claim did not change.
 * Basalt writes the release record beside the session. It never stops a process.
 */
export async function reclaimLostLanes(
  stateRoot: string,
  lanes: readonly number[],
  probe: RemoteJobProber,
): Promise<number[]> {
  const candidates = await laneTransaction(stateRoot, () =>
    laneOwners(stateRoot).filter(
      ({ lane, owner }) => lanes.includes(lane) && lostCandidate(stateRoot, owner, Date.now()),
    ),
  );
  const released: number[] = [];
  for (const { lane, owner } of candidates) {
    let facts: RemoteJobProbe;
    try {
      facts = await probe(owner);
    } catch {
      continue;
    }
    if (!remoteJobLost(facts, Date.now())) continue;
    const removed = await laneTransaction(stateRoot, () => {
      const current = laneOwners(stateRoot).find((entry) => entry.lane === lane)?.owner;
      if (
        !current ||
        hashJson(current) !== hashJson(owner) ||
        !lostCandidate(stateRoot, current, Date.now())
      )
        return false;
      const marker = readFileSync(resolve(owner.sessionDirectory, "native/remote-job.json"));
      const record = {
        schema: "basalt-evals/studio-lane-release",
        lane,
        worker: owner.worker,
        sessionDirectory: owner.sessionDirectory,
        remoteJobHash: contentHash(marker),
        claim: owner,
        probe: facts,
        releasedAt: new Date().toISOString(),
      };
      const file = resolve(dirname(owner.sessionDirectory), LANE_RELEASE_FILE);
      try {
        writeFileSync(file, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A crash after the record and before the removal leaves the record of this claim.
        const saved = JSON.parse(readFileSync(file, "utf8")) as typeof record;
        if (saved.remoteJobHash !== record.remoteJobHash || saved.lane !== lane) return false;
      }
      rmSync(resolve(lanesDirectory(stateRoot), String(lane)), { recursive: true, force: true });
      return true;
    });
    if (removed) released.push(lane);
  }
  return released;
}

/** True if the session holds a lane of `lanes` and no other lane of `lanes` has a claim. */
export async function onlyClaimOf(
  stateRoot: string,
  sessionDirectory: string,
  lanes: readonly number[],
): Promise<boolean> {
  return laneTransaction(stateRoot, () => {
    const claims = laneOwners(stateRoot).filter(({ lane }) => lanes.includes(lane));
    return claims.length === 1 && claims[0]!.owner.sessionDirectory === sessionDirectory;
  });
}

/** Release the lane of one session. It is false when the session holds no lane. */
export async function releaseNativeLane(
  stateRoot: string,
  sessionDirectory: string,
): Promise<boolean> {
  return laneTransaction(stateRoot, () => {
    const owned = laneOwners(stateRoot).filter(
      ({ owner }) => owner.sessionDirectory === sessionDirectory,
    );
    // The journal excludes other processes, and no await separates the owner check from the removal.
    for (const { lane } of owned)
      rmSync(resolve(lanesDirectory(stateRoot), String(lane)), { recursive: true, force: true });
    return owned.length > 0;
  });
}

/** The lane that a session holds now, or null. */
export async function nativeLaneOf(
  stateRoot: string,
  sessionDirectory: string,
): Promise<number | null> {
  return laneTransaction(
    stateRoot,
    () =>
      laneOwners(stateRoot).find(({ owner }) => owner.sessionDirectory === sessionDirectory)
        ?.lane ?? null,
  );
}
