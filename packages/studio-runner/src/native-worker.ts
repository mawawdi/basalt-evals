import {
  ExecutionFault,
  unknownFailure,
  type ExecutionFailure,
} from "../../contracts/src/failure.js";
import { execFile, spawn } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import {
  confirmFileContents,
  readBoundedRegularFile,
} from "../../artifact-store/src/regular-file.js";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import {
  contentHash,
  hashJson,
  isSafeRelativePath,
  stableJson,
  MAX_NATIVE_ARTIFACTS,
  MAX_NATIVE_TOTAL_BYTES,
  type StudioCollectionPlan,
  studioFactWindowMs,
} from "../../contracts/src/index.js";
import { finalizeStudioEvidence, loadStudioSession, serveStudioSession } from "./index.js";
import {
  STUDIO_MCP_REQUEST_TIMEOUT_MS,
  recordStudioSequence,
  studioViewportCapture,
  type SequenceAcquisition,
} from "./studio-mcp.js";
import {
  assertSequencePlan,
  assessSequence,
  parseSequenceSample,
  parseSequenceStateChange,
  reportActionTransitions,
  type SequencePlan,
} from "./sequence.js";
import { probeClock } from "./sequence-timing.js";
import { MAX_TRACE_BYTES } from "./trace.js";
import { collectStudioStartup } from "./studio-startup.js";
import { NATIVE_CANCELLATION_FILE } from "./cancellation.js";
import { cachedSwiftHelper } from "./swift-cache.js";
import { NATIVE_STARTUP_ATTEMPTS } from "./workload.js";
import {
  accountStudioRunning,
  configuredStudioPluginFile,
  resetStudioPreferences,
  type PreferencesReset,
} from "./studio-preferences.js";
import { JOB_FOOTPRINT_FILE, stepFootprintSampler, type JobFootprint } from "./lane-headroom.js";
import { acquireStudioStartLock } from "./studio-start-lock.js";
import { holdStudioMcpAnchor } from "./studio-mcp-anchor.js";
import {
  SCREEN_RECORDING_OFF,
  startScreenRecording,
  type ScreenRecorder,
  type ScreenRecordingResult,
} from "./screen-recording.js";

const STUDIO_EXECUTABLE = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio";
const MAX_LOG = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function verifyConfiguredStudioConnector(
  accountHome: string,
  expectedHash: string,
): Promise<string> {
  const settings = (
    await readRegular(resolve(accountHome, "Library/Roblox/GlobalSettings_13.xml"), 4 * 1024 * 1024)
  ).toString("utf8");
  const file = configuredStudioPluginFile(settings, accountHome);
  await assertSafeAbsoluteDirectory(dirname(file));
  const actualHash = contentHash(await readRegular(file, 2 * 1024 * 1024));
  if (actualHash !== expectedHash)
    throw new Error(
      `The Basalt connector that Studio loads in the isolated Studio account is not the current version. File: ${file}. Install the current Basalt connector at that path with the steps in docs/DEVELOPMENT.md.`,
    );
  return file;
}

function studioEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["HOME", "PATH", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  );
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** The resident memory, in KiB. */
  rss: number;
  /** The recent CPU use, in percent of one core. */
  cpu: number;
  command: string;
}

/** A busy host can take seconds to list every process, so the limit only stops a hung `ps`. */
const PS_TIMEOUT_MS = 10_000;

async function processRows(env: NodeJS.ProcessEnv): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,rss=,%cpu=,command="],
    // One fixed locale gives one decimal mark for the CPU use.
    { env: { ...env, LC_ALL: "C" }, timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            rss: Number(match[4]),
            cpu: Number(match[5]),
            command: match[6]!,
          },
        ]
      : [];
  });
}

/** Observe only this trial's Studio activations; no per-tick AppleScript calls. */
async function startFocusGuard(input: {
  source: string;
  job: string;
  place: string;
  onUnexpectedExit: () => void;
}): Promise<{ stop: () => Promise<void> }> {
  const cacheRoot = resolve(await prepareWorkerKeyDirectory(homedir()), "swift-cache");
  const { executable } = await cachedSwiftHelper({
    name: "focus-guard",
    source: await readRegular(input.source, 64 * 1024),
    compiler: "/usr/bin/swiftc",
    cacheDirectory: cacheRoot,
    environment: studioEnvironment(),
  });
  const ready = resolve(input.job, "focus-guard.ready");
  const log = await open(resolve(input.job, "focus-guard.log"), "wx", 0o600);
  const child = spawn(executable, [STUDIO_EXECUTABLE, input.place, ready], {
    cwd: input.job,
    env: studioEnvironment(),
    stdio: ["ignore", log.fd, log.fd],
  });
  let expectedStop = false;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((done) => {
    child.once("close", () => {
      if (!expectedStop) input.onUnexpectedExit();
      done();
    });
  });
  const started = performance.now();
  try {
    while (true) {
      try {
        await readRegular(ready, 1024);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "Native focus guard exited before readiness; inspect native/focus-guard.log",
        );
      if (performance.now() - started > 10_000)
        throw new Error("Native focus guard did not become ready within 10 seconds");
      await delay(25);
    }
  } catch (error) {
    expectedStop = true;
    child.kill("SIGTERM");
    await closed;
    await log.close();
    throw error;
  }
  return {
    stop: async () => {
      expectedStop = true;
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
        await log.close();
      }
    },
  };
}

/** Host-only identity storage, deliberately outside the controller's checkout mount. */
export async function prepareWorkerKeyDirectory(home: string): Promise<string> {
  let directory = resolve(home);
  await assertSafeAbsoluteDirectory(directory);
  for (const part of [".local", "share", "basalt-evals", "native-worker"]) {
    directory = resolve(directory, part);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafeAbsoluteDirectory(directory);
  }
  return directory;
}

/** Read local control/artifact files without accepting symlinks or unbounded files. */
async function readRegular(file: string, maximum: number): Promise<Buffer> {
  return readBoundedRegularFile(file, maximum, "worker file");
}

interface NativeProcessResult {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  reason: "exit" | "timeout" | "aborted" | "log_limit" | "spawn_error";
  durationMs: number;
}

/** Own one native trial and its observed descendants; never kill by app name. */
export async function runNativeProcess(input: {
  command: string;
  args: string[];
  directory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  launchedApp?: {
    executable: string;
    uniqueArgument: string;
  };
  /** Gets the owned process IDs that are alive after each process scan. */
  onProcesses?: (pids: number[]) => void;
  /** Gets the summed resident bytes and CPU cores of the owned live processes of each scan. */
  onUsage?: (residentBytes: number, cores: number) => void;
  /** Called one time, when the process of the launched app is first visible. */
  onLaunched?: () => void;
}): Promise<NativeProcessResult> {
  // Node clamps larger timers to 1ms. Otherwise the validated acquisition plan
  // determines this watchdog; an arbitrary duration cap can reject valid work.
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 2_147_483_647
  )
    throw new Error("Native watchdog must be a positive integer within the Node timer range");
  await assertSafeAbsoluteDirectory(input.directory);
  const log = await open(resolve(input.directory, "process.log"), "wx", 0o600);
  const started = performance.now();
  try {
    if (input.signal?.aborted)
      return { pid: null, exitCode: null, signal: null, reason: "aborted", durationMs: 0 };
    return await new Promise<NativeProcessResult>((accept, reject) => {
      const env = studioEnvironment();
      const child = spawn(input.command, input.args, {
        cwd: input.directory,
        env,
        // Studio may place server/client descendants in separate process groups.
        // Isolate the entry group and track descendant groups before they reparent.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let reason: NativeProcessResult["reason"] = "exit";
      let bytes = 0;
      let failure: unknown;
      let writes = Promise.resolve();
      const owned = new Map<number, number>();
      if (child.pid !== undefined) owned.set(child.pid, child.pid);
      let entryGroupGone = false;
      let launchedPid: number | null = null;
      let scanning: Promise<void> | undefined;
      let cleanup = Promise.resolve();
      const discover = async (): Promise<ProcessRow[]> => {
        const rows = await processRows(env);
        if (!input.launchedApp && child.pid !== undefined && !entryGroupGone) {
          // The detached entry group belongs to this trial even if its leader
          // exits before our first scan and leaves children with inherited pipes.
          // Once the group disappears, never reacquire a potentially reused ID.
          const members = rows.filter((row) => row.pgid === child.pid);
          if (!members.length) entryGroupGone = true;
          for (const row of members) owned.set(row.pid, row.pgid);
        }
        if (input.launchedApp) {
          for (const row of rows) {
            if (
              row.command.startsWith(`${input.launchedApp.executable} `) &&
              row.command.includes(input.launchedApp.uniqueArgument)
            ) {
              owned.set(row.pid, row.pgid);
              if (launchedPid === null) {
                launchedPid = row.pid;
                input.onLaunched?.();
              }
            }
          }
        }
        const current = new Map(rows.map((row) => [row.pid, row.pgid]));
        const parents = new Set(
          [...owned].flatMap(([pid, pgid]) => (current.get(pid) === pgid ? [pid] : [])),
        );
        let added = true;
        while (added) {
          added = false;
          for (const row of rows) {
            if (!parents.has(row.ppid) || parents.has(row.pid)) continue;
            owned.set(row.pid, row.pgid);
            parents.add(row.pid);
            added = true;
          }
        }
        input.onProcesses?.([...parents]);
        const live = rows.filter((row) => parents.has(row.pid));
        input.onUsage?.(
          live.reduce((sum, row) => sum + row.rss * 1024, 0),
          live.reduce((sum, row) => sum + row.cpu / 100, 0),
        );
        return rows;
      };
      const monitor = setInterval(() => {
        if (scanning || child.pid === undefined) return;
        scanning = discover()
          .then(() => {})
          .catch((error: unknown) => {
            append(
              Buffer.from(
                `${new Date().toISOString()} Process discovery failed: ${String(error)}\n`,
              ),
            );
          })
          .finally(() => {
            scanning = undefined;
          });
      }, 500);
      const signalOwned = async (signal: NodeJS.Signals) => {
        let rows: ProcessRow[];
        try {
          rows = await discover();
        } catch {
          // Still stop the isolated entry group if process inspection fails.
          rows = [];
          if (child.pid !== undefined && !entryGroupGone)
            rows.push({
              pid: child.pid,
              ppid: 0,
              pgid: child.pid,
              rss: 0,
              cpu: 0,
              command: input.command,
            });
        }
        const live = new Map(rows.map((row) => [row.pid, row.pgid]));
        if (input.launchedApp) {
          // LaunchServices, rather than this worker, assigns application process
          // groups. Never signal a whole group that may contain unrelated apps.
          for (const [pid, expected] of [...owned].reverse()) {
            if (live.get(pid) !== expected) continue;
            try {
              process.kill(pid, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
          return;
        }
        for (const pgid of new Set(
          [...owned].flatMap(([pid, expected]) => (live.get(pid) === expected ? [expected] : [])),
        )) {
          try {
            process.kill(-pgid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      };
      const stop = (why: NativeProcessResult["reason"]) => {
        if (reason !== "exit") return;
        reason = why;
        cleanup = (async () => {
          try {
            if (scanning) await scanning;
            await signalOwned("SIGTERM");
            await delay(2000);
            await signalOwned("SIGKILL");
          } finally {
            // A descendant can retain an inherited pipe after the entry process
            // exits; close our read ends so the incomplete receipt can be sealed.
            child.stdout.destroy();
            child.stderr.destroy();
          }
        })();
      };
      const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
      const abort = () => stop("aborted");
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      const append = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_LOG) {
          stop("log_limit");
          return;
        }
        writes = writes
          .then(async () => {
            await log.write(chunk);
          })
          .catch((error: unknown) => {
            failure = error;
            stop("log_limit");
          });
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", () => {
        reason = "spawn_error";
      });
      let exitCleanup: NodeJS.Timeout | undefined;
      child.once("exit", () => {
        // Roblox can return from EndTest while a separately grouped server is
        // still alive. Give it a short grace period, then close the trial tree.
        exitCleanup = setTimeout(() => {
          if (reason !== "exit") return;
          cleanup = (async () => {
            try {
              if (scanning) await scanning;
              await signalOwned("SIGTERM");
              await delay(250);
              await signalOwned("SIGKILL");
            } finally {
              child.stdout.destroy();
              child.stderr.destroy();
            }
          })();
        }, 2000);
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (exitCleanup) clearTimeout(exitCleanup);
        clearInterval(monitor);
        input.signal?.removeEventListener("abort", abort);
        void (async () => {
          await cleanup;
          if (scanning) await scanning;
          // EndTest may release the entry process before its Studio server or
          // clients. Bound their cleanup before starting another native step.
          await signalOwned("SIGTERM");
          await delay(250);
          await signalOwned("SIGKILL");
          // Signal delivery is asynchronous. Do not release the native lane or
          // seal successful cleanup while an owned server/client is still alive.
          const cleanupDeadline = performance.now() + 5000;
          for (;;) {
            const remaining = (await discover()).filter((row) => owned.get(row.pid) === row.pgid);
            if (!remaining.length) break;
            if (performance.now() >= cleanupDeadline)
              throw new Error(
                `Native cleanup could not confirm exit for owned processes: ${remaining.map((row) => row.pid).join(", ")}`,
              );
            await delay(25);
          }
          await writes;
          if (failure) {
            throw failure;
          }
          return {
            pid: launchedPid ?? child.pid ?? null,
            exitCode,
            signal,
            reason,
            durationMs: Math.round(performance.now() - started),
          };
        })().then(accept, reject);
      });
    });
  } finally {
    await log.close();
  }
}

interface WorkerManifest {
  schema: "basalt-evals/native-worker";
  jobId: string;
  sessionId: string;
  candidateHash: string;
  collectionPlanHash: string;
  runnerHash: string;
  startedAt: string;
  completedAt: string;
  status: "complete" | "incomplete";
  failure: string | null;
  failureRecord: ExecutionFailure | null;
  processes: Array<{ stepId: string; result: NativeProcessResult }>;
  completion: { trialId: string; submissionHash: string } | null;
  artifacts: Array<{ file: string; hash: string; bytes: number }>;
  /** The preference reset before Studio started, or null if the job stopped before it. */
  preferences: PreferencesReset | null;
  /** The diagnostic screen recording. It is outside `artifacts` and never changes `status`. */
  screenRecording: ScreenRecordingResult;
}

export interface SignedWorkerManifest {
  manifest: WorkerManifest;
  publicKey: string;
  signature: string;
}

/** Attribute a missing player to a recorded Studio crash when one occurred. */
export function nativeCaptureFailure(
  stepId: string,
  failure: string,
  studioStderr: string,
): string {
  if (
    failure.includes("Scenario players did not join") &&
    /User callback reports event : clientcrash\b/u.test(studioStderr)
  )
    return `A Studio client stopped unexpectedly before it joined step ${stepId}. Read the signed studio-stderr.log file.`;
  return `Studio could not record step ${stepId}. Cause: ${failure}`;
}

/** A step fault quotes at most this many characters of the crash line of Studio. */
const CRASH_LINE_LIMIT = 300;

/**
 * Read the behavior record of one scenario step. Studio writes it while the step runs, so a
 * Studio that stopped during the step leaves none. Then the fault quotes the first crash line
 * of the Studio log of the last start of the step.
 */
export async function readStepBehavior(input: {
  sessionDirectory: string;
  stepId: string;
  /** The folder of the last start of the step, with its studio-stdout.log file. */
  stepDirectory: string;
  dependency: string;
}): Promise<Buffer> {
  const file = resolve(input.sessionDirectory, "runtime", input.stepId, "evidence.json");
  const present = await lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (present) return readRegular(file, MAX_LOG);
  const log = await readRegular(resolve(input.stepDirectory, "studio-stdout.log"), MAX_LOG).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return Buffer.from("");
      throw error;
    },
  );
  const crash = log
    .toString("utf8")
    .split(/\r?\n/u)
    .find((line) => line.includes("RBXCRASH"))
    ?.trim();
  throw new ExecutionFault({
    causeCode: "studio_runtime_evidence_missing",
    category: "acquisition",
    dependency: input.dependency,
    unit: { stage: "final_capture", id: input.stepId },
    evidenceRefs: [contentHash(log)],
    recoveryActions: ["inspect"],
    explanation:
      `Studio stopped during step ${input.stepId} before it recorded the behavior. ` +
      (crash
        ? `Studio reported: ${Array.from(crash).slice(0, CRASH_LINE_LIMIT).join("")}`
        : "Read the signed studio-stdout.log file."),
  });
}

/** A liveness watchdog derived from the frozen acquisition plan, never a grading deadline. */
export function nativeStepWatchdogMs(plan: StudioCollectionPlan, stepId: string): number {
  const scenario = plan.scenarios.find((entry) => entry.id === stepId);
  if (scenario) {
    // A step can start at the end of the budget. Its observations and the
    // published-schedule slack of the runner follow it.
    const longestWindow = Math.max(
      0,
      ...scenario.steps.flatMap((step) =>
        step.observations.map((request) => studioFactWindowMs(request.fact)),
      ),
    );
    return Math.max(180_000, scenario.durationMs + longestWindow + 5_000 + 120_000);
  }
  if (stepId !== "presentation") throw new Error("Unknown native Studio step");
  const phaseWork = plan.phases.reduce((total, phase) => {
    const readiness = phase.driver.kind === "manual" ? 0 : phase.driver.timeoutMs;
    const sampling = phase.facts.reduce(
      (elapsed, fact) =>
        elapsed +
        ("durationMs" in fact
          ? fact.durationMs
          : "sampleCount" in fact && "intervalMs" in fact
            ? (fact.sampleCount - 1) * fact.intervalMs
            : 0),
      0,
    );
    return total + readiness + sampling + phase.captures.length * 60_000 + 15_000;
  }, 0);
  return Math.max(180_000, phaseWork + 120_000);
}

/** The controller pins this key separately. A signature is provenance, not an expert verdict. */
export function verifyWorkerSignature(
  receipt: SignedWorkerManifest,
  pinnedPublicKey: string,
): boolean {
  const key = createPublicKey(pinnedPublicKey);
  return (
    key.asymmetricKeyType === "ed25519" &&
    receipt.publicKey === pinnedPublicKey &&
    verify(
      null,
      Buffer.from(stableJson(receipt.manifest)),
      key,
      Buffer.from(receipt.signature, "base64"),
    )
  );
}

/** Pin the worker key outside the returned bundle, then verify each exact file. */
export async function verifyWorkerArtifacts(
  directory: string,
  receipt: SignedWorkerManifest,
  pinnedPublicKey: string,
): Promise<void> {
  if (!verifyWorkerSignature(receipt, pinnedPublicKey))
    throw new Error("Invalid or untrusted worker signature");
  const files = new Set<string>();
  if (
    receipt.manifest.schema !== "basalt-evals/native-worker" ||
    !Object.hasOwn(receipt.manifest, "failureRecord") ||
    !Object.hasOwn(receipt.manifest, "preferences") ||
    !Object.hasOwn(receipt.manifest, "screenRecording") ||
    !Array.isArray(receipt.manifest.artifacts) ||
    receipt.manifest.artifacts.length > MAX_NATIVE_ARTIFACTS
  )
    throw new Error("Invalid native worker manifest");
  let totalBytes = 0;
  for (const artifact of receipt.manifest.artifacts) {
    if (
      !isSafeRelativePath(artifact.file) ||
      files.has(artifact.file) ||
      !/^[a-f0-9]{64}$/.test(artifact.hash) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > MAX_LOG
    )
      throw new Error("Invalid worker artifact identity");
    totalBytes += artifact.bytes;
    if (totalBytes > MAX_NATIVE_TOTAL_BYTES)
      throw new Error("Native evidence exceeds its total byte allowance");
    files.add(artifact.file);
  }
  await confirmFileContents(
    receipt.manifest.artifacts.map((artifact) => ({
      file: resolve(directory, artifact.file),
      hash: artifact.hash,
      bytes: artifact.bytes,
      check: async () => {
        const bytes = await readRegular(resolve(directory, artifact.file), artifact.bytes);
        if (bytes.length !== artifact.bytes || contentHash(bytes) !== artifact.hash)
          throw new Error(`Worker artifact hash mismatch: ${artifact.file}`);
      },
    })),
  );
}

async function signingKey(file: string) {
  await assertSafeAbsoluteDirectory(dirname(file));
  const generated = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  try {
    await writeFile(file, generated, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = createPrivateKey(await readRegular(file, 16_384));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Worker signing key must be Ed25519");
  return key;
}

/** The job lease beside the signed `studio` folder. The worker renews it every 10 s. */
export const JOB_LEASE_FILE = "lease.json";

/**
 * Renew the lease of one job until `stop`. A controller that lost its process reads the lease,
 * with the process list, before it takes back the Studio slot. A failed write waits for the next
 * renewal: the process list still shows the worker.
 */
export async function startJobLease(input: {
  jobDirectory: string;
  placeArgument: string;
  studioPids: () => readonly number[];
  intervalMs?: number;
}): Promise<{ stop(): Promise<void> }> {
  const { stdout } = await execFileAsync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 1024,
  });
  const workerPgid = Number(stdout.trim());
  if (!Number.isSafeInteger(workerPgid) || workerPgid < 1)
    throw new Error("The worker cannot read its process group");
  const file = resolve(input.jobDirectory, JOB_LEASE_FILE);
  const write = async () => {
    const temporary = resolve(input.jobDirectory, `.lease-${randomBytes(8).toString("hex")}`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          workerPid: process.pid,
          workerPgid,
          studioPids: [...input.studioPids()],
          placeArgument: input.placeArgument,
          renewedAt: new Date().toISOString(),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };
  // The first lease exists before any Studio start of the job.
  await write();
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(write);
  }, input.intervalMs ?? 10_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
}

/** One prepared, create-only native trial. No polling queue, retries, UI clicks, or provider calls. */
export async function runNativeStudio(input: {
  sessionDirectory: string;
  entryFile: string;
  keyFile: string;
  /** The controller saw no claim on the other slots of this worker. */
  resetPreferences: boolean;
  /** The worker records the windows of its Studio processes as a diagnostic. */
  screenRecording: boolean;
  /** The command that starts a detached keeper of the Studio MCP anchor. */
  mcpAnchorKeeper: { command: string; args: string[] };
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SignedWorkerManifest> {
  if (process.platform !== "darwin")
    throw new Error("Basalt can start Studio only on macOS. Use a Mac for this run.");
  const directory = resolve(input.sessionDirectory);
  const workerRoot = resolve(homedir(), "BasaltTrials");
  const jobDirectory = dirname(directory);
  if (
    directory !== resolve(jobDirectory, "studio") ||
    dirname(jobDirectory) !== workerRoot ||
    !/^job-[a-f0-9]{32}$/u.test(basename(jobDirectory))
  )
    throw new Error("Native Studio may launch only from an isolated BasaltTrials job");
  const session = await loadStudioSession(directory);
  const sequenceBytes = await readRegular(resolve(directory, "sequence.json"), 8192).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    },
  );
  const sequencePlan: SequencePlan | null = sequenceBytes
    ? (JSON.parse(sequenceBytes.toString("utf8")) as SequencePlan)
    : null;
  if (sequencePlan) {
    assertSequencePlan(sequencePlan, session.plan);
    if (sequencePlan.sourceHash !== session.candidateHash)
      throw new Error("Sequence plan is not bound to this candidate and scenario");
  }
  if (session.plan.phases.some((phase) => phase.driver.kind === "manual"))
    throw new Error("Unattended trials require a driven plan; manual phases are not supported");
  // Refuse to reuse evidence or a failed job. Each attempt needs a freshly prepared place.
  for (const file of ["submission.json", "evidence.json"]) {
    try {
      await readRegular(resolve(directory, file), MAX_LOG);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Native worker requires a fresh session with no prior submission/evidence");
  }
  const entry = (await readRegular(input.entryFile, 64 * 1024)).toString("utf8");
  const focusSource = resolve(dirname(input.entryFile), "native-focus.swift");
  const focusBytes = await readRegular(focusSource, 64 * 1024);
  const recorderBytes = await readRegular(
    resolve(dirname(input.entryFile), "native-recorder.swift"),
    64 * 1024,
  );
  if (
    entry.split("__BASALT_JOB_ID__").length !== 2 ||
    entry.split("__BASALT_STEP_ID__").length !== 2
  )
    throw new Error("Invalid fixed native entry point");
  const key = await signingKey(resolve(input.keyFile));
  const workerDirectory = await prepareWorkerKeyDirectory(homedir());
  const job = resolve(directory, "native");
  await mkdir(job, { mode: 0o700 });
  const jobId = randomBytes(16).toString("hex");
  const steps = [...session.plan.scenarios.map((scenario) => scenario.id), "presentation"];
  if (new Set(steps).size !== steps.length || steps.some((step) => !/^[a-z][a-z0-9-]*$/.test(step)))
    throw new Error("Native worker steps must have unique safe identifiers");
  const stepArtifacts: string[] = [];
  const sequenceArtifacts: string[] = [];
  const manifest: WorkerManifest = {
    schema: "basalt-evals/native-worker",
    jobId,
    sessionId: session.id,
    candidateHash: session.candidateHash,
    collectionPlanHash: session.collectionPlanHash,
    runnerHash: hashJson({
      entry: contentHash(entry),
      focusGuard: contentHash(focusBytes),
      recorder: contentHash(recorderBytes),
    }),
    startedAt: new Date().toISOString(),
    completedAt: "",
    status: "incomplete",
    failure: null,
    failureRecord: null,
    processes: [],
    completion: null,
    artifacts: [],
    preferences: null,
    screenRecording: SCREEN_RECORDING_OFF,
  };
  // The use of each Studio start, beside the signed tree. It is an operational measurement.
  const footprint: JobFootprint = { schema: "basalt-evals/studio-footprint", jobId, steps: [] };
  const backend = studioViewportCapture(session.place.file);
  let captureFailure: string | undefined;
  let fatalFailure: string | undefined;
  let activeAttempt: AbortController | undefined;
  let activeSequence:
    { scenarioId: string; generation: number; completion: AbortController } | undefined;
  let served: Awaited<ReturnType<typeof serveStudioSession>> | undefined;
  let focusGuard: Awaited<ReturnType<typeof startFocusGuard>> | undefined;
  let recorder: ScreenRecorder | undefined;
  let studioPids: readonly number[] = [];
  const ownedProcesses = (pids: number[]) => {
    studioPids = pids;
    recorder?.update(pids);
  };
  // Without a lease, the process list still shows this worker to a probe, so the job continues.
  const lease = await startJobLease({
    jobDirectory,
    placeArgument: resolve(directory, session.place.file),
    studioPids: () => studioPids,
  }).catch(() => ({ stop: async () => {} }));
  let mcpAnchor: { release(): Promise<void> } | undefined;
  try {
    // Each capture of this job relays through the Studio MCP anchor of the account, so the end
    // of a capture in another lane does not break a capture of this job.
    mcpAnchor = await holdStudioMcpAnchor({
      directory: workerDirectory,
      holderId: jobId,
      // A keeper that cannot start fails the job when its start time ends.
      startKeeper: () =>
        spawn(input.mcpAnchorKeeper.command, input.mcpAnchorKeeper.args, {
          detached: true,
          stdio: "ignore",
        })
          .on("error", () => undefined)
          .unref(),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // The preferences go back to the golden template only when no other job of this account
    // runs. The reset happens before any Studio start of this job. It holds the start lock, so
    // no Studio of another lane starts during the reset.
    const resetLock = input.resetPreferences
      ? await acquireStudioStartLock({
          directory: workerDirectory,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : null;
    try {
      manifest.preferences = await resetStudioPreferences({
        home: homedir(),
        requested: input.resetPreferences,
        studioRunning: () => accountStudioRunning(userInfo().uid),
      });
    } finally {
      await resetLock?.release();
    }
    // A connector mismatch is a signed, zero-launch outcome. The controller can
    // release its lane after importing the receipt instead of retaining an
    // ambiguous remote job with no manifest.
    await verifyConfiguredStudioConnector(homedir(), session.connectorArtifactHash);
    focusGuard = await startFocusGuard({
      source: focusSource,
      job,
      place: resolve(directory, session.place.file),
      onUnexpectedExit: () => {
        fatalFailure = "Native focus guard exited during the trial";
        activeAttempt?.abort();
      },
    });
    if (input.screenRecording)
      recorder = await startScreenRecording({
        jobDirectory,
        environment: studioEnvironment(),
        executable: async () =>
          (
            await cachedSwiftHelper({
              name: "screen-recorder",
              source: recorderBytes,
              compiler: "/usr/bin/swiftc",
              cacheDirectory: resolve(await prepareWorkerKeyDirectory(homedir()), "swift-cache"),
              environment: studioEnvironment(),
            })
          ).executable,
      });
    served = await serveStudioSession(directory, backend, {
      jobId,
      complete: (completion) => {
        manifest.completion = completion;
      },
      failed: (error) => {
        captureFailure = error;
        activeAttempt?.abort();
      },
      scenarioComplete: (receipt) => {
        if (
          activeSequence?.scenarioId === receipt.scenarioId &&
          activeSequence.generation === receipt.generation &&
          !activeAttempt?.signal.aborted
        )
          activeSequence.completion.abort(receipt);
      },
    });
    for (const [index, stepId] of steps.entries()) {
      // The folder of the last start of the step. Its Studio log can explain an absent record.
      let lastStepDirectory = "";
      for (let attempt = 1; attempt <= NATIVE_STARTUP_ATTEMPTS; attempt++) {
        const attemptId = `${stepId}/attempt-${String(attempt).padStart(2, "0")}`;
        const stepDirectory = resolve(
          job,
          `step-${String(index + 1).padStart(2, "0")}-${stepId}-attempt-${String(attempt).padStart(2, "0")}`,
        );
        lastStepDirectory = stepDirectory;
        await mkdir(stepDirectory, { mode: 0o700 });
        const source = entry
          .replace("__BASALT_JOB_ID__", jobId)
          .replace("__BASALT_STEP_ID__", stepId);
        const scriptFile = resolve(stepDirectory, "entry.luau");
        await writeFile(scriptFile, source, { flag: "wx", mode: 0o600 });
        for (const file of [
          "entry.luau",
          "process.log",
          "studio-stdout.log",
          "studio-stderr.log",
          "script.log",
          "startup.json",
        ])
          stepArtifacts.push(`native/${stepDirectory.slice(job.length + 1)}/${file}`);
        const generation = served.resetWorkerReady(stepId);
        captureFailure = undefined;
        const attemptAbort = new AbortController();
        activeAttempt = attemptAbort;
        const signal = input.signal
          ? AbortSignal.any([input.signal, attemptAbort.signal])
          : attemptAbort.signal;
        const processStartedAtMs = Date.now();
        let watching = true;
        let startupFault: "server_opened_as_edit" | "client_opened_as_edit" | null = null;
        // Studio occasionally receives a valid Play command but opens its
        // source file as Edit. Stop that owned process as soon as its log says
        // so; otherwise the server waits a full minute for absent players.
        const watch = (async () => {
          let playSessionGuid: string | undefined;
          while (watching && !signal.aborted) {
            try {
              const output = await readRegular(
                resolve(stepDirectory, "studio-stdout.log"),
                MAX_LOG,
              );
              playSessionGuid ??= /-playTestSessionGuid ([a-f0-9-]+)/.exec(
                output.toString("utf8"),
              )?.[1];
              if (playSessionGuid) {
                const observed = await collectStudioStartup({
                  place: resolve(directory, session.place.file),
                  startedAtMs: processStartedAtMs,
                  finishedAtMs: Date.now(),
                  playSessionGuid,
                  expectChildren: false,
                });
                if (observed.classification) {
                  startupFault = observed.classification;
                  attemptAbort.abort();
                  break;
                }
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                fatalFailure = `Studio startup monitor failed: ${String(error)}`;
                attemptAbort.abort();
                break;
              }
            }
            await delay(500);
          }
        })();
        let result: NativeProcessResult;
        let sequenceResult: SequenceAcquisition | undefined;
        let sequenceFailure: string | null = null;
        const sequenceDirectory = resolve(
          job,
          "sequence",
          `${stepId}-attempt-${String(attempt).padStart(2, "0")}`,
        );
        // Each Studio start of the account holds the start lock until its process is visible. The
        // wait comes before the sequence recorder starts, so a failed wait leaves nothing running.
        const startLock = await acquireStudioStartLock({ directory: workerDirectory, signal });
        let released: Promise<void> | undefined;
        const releaseStart = () => (released ??= startLock.release());
        const usage = stepFootprintSampler(attemptId);
        const sequenceAbort = new AbortController();
        const sequenceCompletion = new AbortController();
        const studioExit = new AbortController();
        activeSequence = { scenarioId: stepId, generation, completion: sequenceCompletion };
        const sequencePromise =
          sequencePlan?.scenarioId === stepId
            ? recordStudioSequence({
                placeFile: session.place.file,
                sessionId: session.id,
                directory: sequenceDirectory,
                expectedClients: session.plan.clients,
                signal: AbortSignal.any([signal, sequenceAbort.signal]),
                completion: { scenarioId: stepId, signal: sequenceCompletion.signal },
                studioExited: studioExit.signal,
                onReady: () => served!.markSequenceReady(stepId, generation),
                onFailure: (reason) => {
                  sequenceFailure = reason;
                  attemptAbort.abort();
                },
                ...(sequencePlan.camera ? { camera: sequencePlan.camera } : {}),
              }).then(
                (value) => {
                  sequenceResult = value;
                  if (value.status !== "complete") {
                    sequenceFailure ??= value.reason ?? "Incomplete rendered acquisition";
                    attemptAbort.abort();
                  }
                },
                (error: unknown) => {
                  sequenceFailure ??= String(error);
                  attemptAbort.abort();
                },
              )
            : Promise.resolve();
        try {
          result = await runNativeProcess({
            command: "/usr/bin/open",
            args: [
              "-g",
              "-n",
              "-W",
              "-a",
              "/Applications/RobloxStudio.app",
              "--stdout",
              resolve(stepDirectory, "studio-stdout.log"),
              "--stderr",
              resolve(stepDirectory, "studio-stderr.log"),
              "--args",
              "--task",
              "RunScript",
              "--localPlaceFile",
              resolve(directory, session.place.file),
              "--runScriptFile",
              scriptFile,
              "--outputFile",
              resolve(stepDirectory, "script.log"),
              "--quitAfterExecution",
            ],
            directory: stepDirectory,
            timeoutMs: input.timeoutMs ?? nativeStepWatchdogMs(session.plan, stepId),
            signal,
            launchedApp: {
              executable: STUDIO_EXECUTABLE,
              uniqueArgument: scriptFile,
            },
            onProcesses: ownedProcesses,
            onUsage: usage.sample,
            onLaunched: () => void releaseStart(),
          });
        } finally {
          await releaseStart();
          footprint.steps.push(usage.result());
          // A bound completion already stopped new screenshots. Studio has exited, so an issued
          // request has no answer: the recorder closes it at once. The request bound stays a
          // limit before process exit counts as an abort. Stop and failures skip this step.
          if (sequenceCompletion.signal.aborted && !signal.aborted) {
            studioExit.abort();
            const drainLimit = new AbortController();
            await Promise.race([
              sequencePromise,
              delay(STUDIO_MCP_REQUEST_TIMEOUT_MS, undefined, { signal: drainLimit.signal }).catch(
                () => undefined,
              ),
            ]);
            drainLimit.abort();
          }
          sequenceAbort.abort();
          await sequencePromise;
          activeSequence = undefined;
          if (sequenceResult) {
            const prefix = `native/sequence/${stepId}-attempt-${String(attempt).padStart(2, "0")}`;
            sequenceArtifacts.push(
              `${prefix}/index.json`,
              `${prefix}/mcp.json`,
              ...sequenceResult.frames.map((frame) => `${prefix}/${frame.file}`),
            );
          }
          watching = false;
          await watch;
          activeAttempt = undefined;
        }
        // Studio writes no log if it does not start. Any other read error stops the step,
        // because the update check and the Edit check below read this log.
        const studioOutput = await readRegular(
          resolve(stepDirectory, "studio-stdout.log"),
          MAX_LOG,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Buffer.from("");
          throw error;
        });
        const playSessionGuid = /-playTestSessionGuid ([a-f0-9-]+)/.exec(
          studioOutput.toString("utf8"),
        )?.[1];
        const startup = await collectStudioStartup({
          place: resolve(directory, session.place.file),
          startedAtMs: processStartedAtMs,
          finishedAtMs: Date.now(),
          expectChildren: stepId !== "presentation",
          scriptFile,
          ...(playSessionGuid ? { playSessionGuid } : {}),
        });
        await writeFile(resolve(stepDirectory, "startup.json"), `${stableJson(startup)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        manifest.processes.push({ stepId: attemptId, result });
        if (fatalFailure) throw new Error(fatalFailure);
        if (input.signal?.aborted)
          throw new Error(`The run stopped during step ${stepId} in Studio.`);
        if (
          startup.applicationUpdate ||
          studioOutput.includes("About to exit application due to update") ||
          studioOutput.includes("interruptWithApplicationUpdateIfAvailable began update true")
        )
          throw new ExecutionFault({
            causeCode: "studio_update_required",
            category: "startup",
            dependency: hashJson({ studio: session.expectedStudioVersion }),
            unit: { stage: "final_capture", id: stepId },
            evidenceRefs: [hashJson(startup)],
            recoveryActions: ["inspect"],
            explanation:
              "Studio must install an update. Basalt did not run a script in Studio. Install the update in the isolated Studio account. Then start a new run with the new Studio version.",
          });
        const fault = startupFault ?? startup.classification;
        if (fault) {
          const reports = await readdir(resolve(directory, "runtime", stepId)).catch(
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            },
          );
          if (reports.length)
            throw new Error(
              `Studio opened the place in Edit mode after step ${stepId} recorded behavior. Basalt cannot safely start the step again.`,
            );
          if (attempt === NATIVE_STARTUP_ATTEMPTS)
            throw new ExecutionFault({
              causeCode: fault,
              category: "startup",
              dependency: hashJson({
                studio: session.expectedStudioVersion,
                runner: manifest.runnerHash,
              }),
              unit: { stage: "final_capture", id: stepId },
              evidenceRefs: [hashJson(startup)],
              recoveryActions: ["inspect"],
              explanation: `Studio opened the place in Edit mode, not Play mode, in all ${attempt} starts of step ${stepId}. Details: ${fault}. Read the signed startup.json files.`,
            });
          continue;
        }
        if (captureFailure) {
          const studioStderr = await readRegular(
            resolve(stepDirectory, "studio-stderr.log"),
            MAX_LOG,
          );
          throw new ExecutionFault({
            ...unknownFailure(
              "final_capture",
              stepId,
              nativeCaptureFailure(stepId, captureFailure, studioStderr.toString("utf8")),
            ),
            category: "acquisition",
            evidenceRefs: [contentHash(studioStderr)],
          });
        }
        if (sequenceFailure)
          throw new ExecutionFault({
            causeCode: "studio_sequence_acquisition_failed",
            category: "acquisition",
            dependency: hashJson({
              studio: session.expectedStudioVersion,
              runner: manifest.runnerHash,
            }),
            unit: { stage: "final_capture", id: stepId },
            evidenceRefs: sequenceResult ? [hashJson(sequenceResult)] : [],
            recoveryActions: ["inspect"],
            explanation: `Basalt could not record the image sequence of step ${stepId}. Cause: ${sequenceFailure}`,
          });
        if (result.reason !== "exit" || result.exitCode !== 0 || result.signal)
          throw new Error(
            `Studio did not finish step ${stepId}. Details: reason=${result.reason}, exit=${result.exitCode}, signal=${result.signal}`,
          );
        break;
      }
      if (stepId !== "presentation") {
        const bytes = await readStepBehavior({
          sessionDirectory: directory,
          stepId,
          stepDirectory: lastStepDirectory,
          dependency: hashJson({
            studio: session.expectedStudioVersion,
            runner: manifest.runnerHash,
          }),
        });
        const evidence = JSON.parse(bytes.toString("utf8")) as {
          scenarioId?: string;
          reports?: unknown[];
        };
        const expected = session.plan.scenarios[index]!;
        if (
          evidence.scenarioId !== stepId ||
          evidence.reports?.length !== expected.reportContexts.length
        )
          throw new Error(`Studio did not record all of the behavior of step ${stepId}.`);
        if (sequencePlan?.scenarioId === stepId) {
          const completed = manifest.processes.filter((entry) =>
            entry.stepId.startsWith(`${stepId}/`),
          ).length;
          const sequenceDirectory = resolve(
            job,
            "sequence",
            `${stepId}-attempt-${String(completed).padStart(2, "0")}`,
          );
          const acquisition = JSON.parse(
            (await readRegular(resolve(sequenceDirectory, "index.json"), MAX_LOG)).toString("utf8"),
          ) as SequenceAcquisition;
          const trace = (await readRegular(served.traceFile, MAX_TRACE_BYTES))
            .toString("utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  stage?: string;
                  data?: Record<string, unknown>;
                },
            );
          const reports =
            evidence.reports as import("../../contracts/src/index.js").StudioScenarioReport[];
          const assessment = assessSequence({
            plan: sequencePlan,
            acquisition,
            reports,
            // The signed reports, not the unsigned trace, give each actedAt.
            transitions: reportActionTransitions(reports),
            samples: trace
              .filter(
                (entry) => entry.stage === "scenario.sample" && entry.data?.scenarioId === stepId,
              )
              .map((entry) => parseSequenceSample(entry.data))
              .filter((sample) => sample !== null),
            stateChanges: trace
              .filter(
                (entry) => entry.stage === "scenario.state" && entry.data?.scenarioId === stepId,
              )
              .map((entry) => parseSequenceStateChange(entry.data))
              .filter((state) => state !== null),
            traceComplete: !trace.some((entry) => entry.stage === "trace.limit_reached"),
            expectedClients: session.plan.clients,
            // The recorder probes align the Studio clock with the frames.
            clock: probeClock(acquisition.clockProbes),
          });
          await writeFile(
            resolve(sequenceDirectory, "assessment.json"),
            `${stableJson(assessment)}\n`,
            {
              flag: "wx",
              mode: 0o600,
            },
          );
          sequenceArtifacts.push(
            `native/sequence/${stepId}-attempt-${String(completed).padStart(2, "0")}/assessment.json`,
          );
        }
      }
    }
    // Studio may exit zero on a Luau error. Only the authenticated post-EndTest receipt completes a job.
    if (!manifest.completion)
      throw new Error(
        "Studio stopped before it confirmed the end of the observation. Read native/script.log and the trace files.",
      );
    const evidence = await finalizeStudioEvidence({ sessionDirectory: directory });
    for (const file of [
      "evidence.json",
      "submission.json",
      ...(sequencePlan ? ["sequence.json"] : []),
      ...session.plan.scenarios.flatMap((scenario) => [
        `runtime/${scenario.id}/evidence.json`,
        ...scenario.reportContexts.map((context) => `runtime/${scenario.id}/${context}.json`),
      ]),
      ...evidence.phases.flatMap((phase) => phase.captures.map((capture) => capture.file)),
    ]) {
      const bytes = await readRegular(resolve(directory, file), MAX_LOG);
      manifest.artifacts.push({ file, hash: contentHash(bytes), bytes: bytes.length });
    }
    manifest.status = "complete";
  } catch (error) {
    manifest.failure = String(error).replaceAll(session.token, "[REDACTED]").slice(0, 4096);
    manifest.failureRecord =
      error instanceof ExecutionFault
        ? error.failure
        : unknownFailure("final_capture", manifest.jobId, manifest.failure);
  } finally {
    backend.close();
    if (served) {
      served.server.closeAllConnections();
      await new Promise<void>((done) => served!.server.close(() => done()));
    }
    await focusGuard?.stop();
    // A recording failure never fails the job. The recording stays outside the signed artifacts.
    if (recorder) manifest.screenRecording = await recorder.stop();
    await mcpAnchor?.release();
  }
  for (const file of [
    ...stepArtifacts,
    ...sequenceArtifacts,
    "native/focus-guard.log",
    "native/focus-guard.ready",
    NATIVE_CANCELLATION_FILE,
    ...(served ? [served.traceFile.slice(directory.length + 1)] : []),
  ]) {
    try {
      const bytes = await readRegular(resolve(directory, file), MAX_LOG);
      manifest.artifacts.push({ file, hash: contentHash(bytes), bytes: bytes.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        manifest.status = "incomplete";
        manifest.failure = "A worker diagnostic artifact is unsafe or oversized";
        manifest.failureRecord = {
          ...unknownFailure("final_capture", manifest.jobId, manifest.failure),
          causeCode: "unsafe_diagnostic_artifact",
          category: "integrity",
          dependency: contentHash(file),
        };
      }
    }
  }
  manifest.completedAt = new Date().toISOString();
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const receipt: SignedWorkerManifest = {
    manifest,
    publicKey,
    signature: sign(null, Buffer.from(stableJson(manifest)), key).toString("base64"),
  };
  await writeFile(
    resolve(job, "report.md"),
    `# Native Studio trial\n\nStatus: **${manifest.status}**\n\nSession: ${manifest.sessionId}\n\nCompleted steps: ${manifest.processes.map((entry) => entry.stepId).join(", ") || "none"}\n\nStudio process time: ${manifest.processes.reduce((sum, entry) => sum + entry.result.durationMs, 0)} ms\n\n${manifest.failure ?? "Complete bound evidence; no expert approval or qualitative verdict is implied."}\n\nReceipt SHA-256: ${hashJson(receipt)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  // The footprint exists before the receipt, so the controller can read it with the receipt. A
  // failed write leaves the job without a measured footprint.
  await writeFile(resolve(jobDirectory, JOB_FOOTPRINT_FILE), JSON.stringify(footprint) + "\n", {
    flag: "wx",
    mode: 0o600,
  }).catch(() => undefined);
  // The receipt is the terminal publication marker: its report and all artifacts already exist.
  await publishImmutable(resolve(job, "manifest.json"), `${stableJson(receipt)}\n`);
  await lease.stop();
  return receipt;
}
