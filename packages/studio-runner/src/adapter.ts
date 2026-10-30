import { homedir } from "node:os";
import { appendFile, lstat, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { compareCodeUnits, contentHash, hashJson } from "../../contracts/src/index.js";
import { hashDirectoryTree } from "../../task-registry/src/index.js";
import { installedStudioVersion } from "./version.js";
import { runIsolatedStudio, reconcileIsolatedStudio } from "./isolated-user.js";
import type { SignedWorkerManifest } from "./native-worker.js";
import { loadStudioSession } from "./index.js";
import { holdNativeLane, releaseNativeLane, waitForNativeLane } from "./native-lane.js";
import { laneHeadroom } from "./lane-headroom.js";
import {
  studioLaneConnectorUrl,
  studioLaneOfConnectorUrl,
  type StudioSlot,
} from "./studio-lanes.js";
import {
  hostFacts,
  preflightStudioWorkers,
  probeRemoteJob,
  readStudioWorkers,
  sshWorkerCommand,
  studioCapabilities,
  studioSlots,
  workerOfLane,
  type StudioCapabilities,
} from "./workers.js";

/** Lane admissions of one Studio session, one JSON line each, beside its session directory. */
export const STUDIO_ADMISSIONS_FILE = "admissions.jsonl";

/** Reports when owned work waits for, then holds, a native lane. */
export interface NativeLaneObserver {
  onWaiting?: () => Promise<void>;
  onAdmitted?: () => Promise<void>;
}

/** The reason for a Studio job. A builder waits for a development run, so it goes first. */
type StudioPurpose = "development" | "final_capture" | "control" | "readiness";

/**
 * One admitted Studio turn. A job prepares its session with the connector URL of its lane, so
 * the place reaches the connector of that lane. `release` ends the turn.
 */
interface StudioAdmission {
  lane: number;
  connectorUrl: string;
  release(): Promise<void>;
}

export interface StudioAdapter {
  /** The number of Studio jobs that can run at the same time. Without it, the count is 1. */
  lanes?(root: string): Promise<number>;
  /** The host and the workers. The environment hash of `identity` binds them. */
  capabilities(root: string): Promise<StudioCapabilities>;
  /**
   * Read-only checks of the Studio setup, with one sentence for each failed check. An empty list
   * means that the setup is ready. It never starts Studio.
   */
  preflight(root: string): Promise<string[]>;
  admit?(input: {
    root: string;
    directory: string;
    purpose: StudioPurpose;
    /** The time when the job asked for a Studio turn. Without a run queue, it is the call time. */
    queuedAt?: string;
    signal?: AbortSignal;
    onWaiting?: () => Promise<void>;
  }): Promise<StudioAdmission>;
  identity(root: string): Promise<{
    studioVersion: string;
    connectorSourceHash: string;
    connectorArtifactHash: string;
    environmentHash: string;
  }>;
  run(input: {
    root: string;
    directory: string;
    signal?: AbortSignal;
  }): Promise<SignedWorkerManifest>;
  reconcile(input: { root: string; directory: string }): Promise<SignedWorkerManifest>;
}

/**
 * Waits for a native lane when Studio is busy. Then it prepares the session for that lane, runs
 * the job and releases admission.
 */
export async function runAdmitted(
  adapter: StudioAdapter,
  input: {
    root: string;
    directory: string;
    purpose: StudioPurpose;
    signal?: AbortSignal;
    /** Prepare the session with the connector URL of the admitted lane. */
    prepare(connectorUrl: string | undefined): Promise<void>;
  },
): Promise<SignedWorkerManifest> {
  const admission = await adapter.admit?.(input);
  try {
    await input.prepare(admission?.connectorUrl);
    return await adapter.run({
      root: input.root,
      directory: input.directory,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await admission?.release();
  }
}

/** Compiled runner artifacts are not candidate Luau sources. Bind every regular file. */
export async function studioRunnerIdentity(root: string): Promise<string> {
  const files: Array<{ path: string; hash: string }> = [];
  let totalBytes = 0;
  async function add(path: string) {
    const bytes = await readBoundedRegularFile(resolve(root, path), 2 * 1024 * 1024, "runner file");
    totalBytes += bytes.length;
    if (files.length >= 1024 || totalBytes > 32 * 1024 * 1024)
      throw new Error("Compiled Studio runner exceeds its inventory bounds");
    files.push({ path, hash: contentHash(bytes) });
  }
  async function visit(path: string): Promise<void> {
    await assertSafeAbsoluteDirectory(resolve(root, path));
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Studio runner contains a symbolic link");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) await add(child);
      else throw new Error("Studio runner contains a non-regular file");
    }
  }
  await visit("dist/packages/studio-runner");
  for (const file of ["native-entry.luau", "native-focus.swift", "native-recorder.swift"])
    await add(`packages/studio-runner/${file}`);
  return hashJson(files.sort((a, b) => compareCodeUnits(a.path, b.path)));
}

/** A prepared session can use only the slot of its connector port. A new job can use each slot. */
async function admissibleSlots(root: string, directory: string): Promise<StudioSlot[]> {
  const prepared = await lstat(resolve(directory, "session.json")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const workers = await readStudioWorkers(root);
  if (!prepared) return studioSlots(workers);
  const lane = studioLaneOfConnectorUrl((await loadStudioSession(directory)).connectorUrl);
  return [{ lane, worker: workerOfLane(workers, lane).id }];
}

async function nativeInput(input: { root: string; directory: string; signal?: AbortSignal }) {
  const lane = studioLaneOfConnectorUrl((await loadStudioSession(input.directory)).connectorUrl);
  return {
    repositoryRoot: input.root,
    stateRoot: resolve(input.root, ".basalt-evals"),
    sessionDirectory: input.directory,
    worker: workerOfLane(await readStudioWorkers(input.root), lane),
    pinnedPublicKeyFile: resolve(input.root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

const installedConnector = () =>
  readBoundedRegularFile(
    resolve(homedir(), "Documents/Roblox/Plugins/BasaltEvalStudioPlugin.rbxmx"),
    2 * 1024 * 1024,
    "installed connector",
  );

/**
 * The Studio workers of this Mac. `headroom` gives the check of a lane beside a held lane; tests
 * give a fixed answer in place of the state of this Mac. Test composition supplies a distinct
 * signed synthetic adapter.
 */
export function nativeStudioAdapterOf(
  headroom: (stateRoot: string) => () => Promise<boolean> = laneHeadroom,
): StudioAdapter {
  return {
    async lanes(root) {
      return studioSlots(await readStudioWorkers(root)).length;
    },
    async capabilities(root) {
      return studioCapabilities(root, await readStudioWorkers(root), await hostFacts(root));
    },
    async preflight(root) {
      return preflightStudioWorkers(root, {
        remote: sshWorkerCommand,
        studioVersion: installedStudioVersion,
        connectorHash: async () => contentHash(await installedConnector()),
      });
    },
    async admit(input) {
      const queuedAt = input.queuedAt ?? new Date().toISOString();
      const stateRoot = resolve(input.root, ".basalt-evals");
      const admission = await waitForNativeLane({
        stateRoot,
        sessionDirectory: input.directory,
        slots: await admissibleSlots(input.root, input.directory),
        probe: (owner) => probeRemoteJob(input.root, owner),
        headroom: headroom(stateRoot),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onWaiting ? { onWaiting: input.onWaiting } : {}),
      });
      // The holder renews the lease of its lane until the release of the admission.
      const lease = holdNativeLane(stateRoot, input.directory);
      const release = async () => {
        await lease.stop();
        try {
          await lstat(resolve(input.directory, "native/remote-job.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // Signed settlement releases dispatched jobs inside the native runner.
          await releaseNativeLane(stateRoot, input.directory);
        }
      };
      // Queue time is operational timing beside, never inside, the signed Studio session. The
      // wait starts when the job asked for a turn, so it includes the run queue and the lane.
      try {
        await appendFile(
          resolve(dirname(input.directory), STUDIO_ADMISSIONS_FILE),
          JSON.stringify({
            purpose: input.purpose,
            lane: admission.lane,
            queuedAt,
            laneRequestedAt: admission.requestedAt,
            admittedAt: admission.admittedAt,
            waitedMs: Math.max(0, Date.parse(admission.admittedAt) - Date.parse(queuedAt)),
          }) + "\n",
          { mode: 0o600 },
        );
      } catch (error) {
        // The caller gets no admission, so it cannot release the lane. A failure of the release
        // does not hide the failure of the record.
        await release().catch(() => undefined);
        throw error;
      }
      return {
        lane: admission.lane,
        connectorUrl: studioLaneConnectorUrl(admission.lane),
        release,
      };
    },
    async identity(root) {
      const [studioVersion, connectorSourceHash, connector] = await Promise.all([
        installedStudioVersion(),
        hashDirectoryTree(resolve(root, "plugin")),
        installedConnector(),
      ]);
      const workers = await readStudioWorkers(root);
      // The capabilities hold the template hash of each worker, never a value of one job.
      const environmentHash = hashJson({
        workers,
        capabilities: await studioCapabilities(root, workers, await hostFacts(root)),
        runnerHash: await studioRunnerIdentity(root),
        publicKey: contentHash(
          await readBoundedRegularFile(
            resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
            16_384,
            "isolated worker public key",
          ),
        ),
      });
      return {
        studioVersion,
        connectorSourceHash,
        connectorArtifactHash: contentHash(connector),
        environmentHash,
      };
    },
    async run(input) {
      return runIsolatedStudio(await nativeInput(input));
    },
    async reconcile(input) {
      return reconcileIsolatedStudio(await nativeInput(input));
    },
  };
}

export const nativeStudioAdapter = nativeStudioAdapterOf();
