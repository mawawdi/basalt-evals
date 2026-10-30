import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { MAX_STUDIO_LANES, type StudioSlot } from "./studio-lanes.js";
import {
  configuredStudioPluginFile,
  GOLDEN_DIRECTORY,
  STUDIO_DEFAULTS_DOMAIN,
  STUDIO_PLUGINS_DIRECTORY,
  STUDIO_SETTINGS_FILE,
} from "./studio-preferences.js";
import type { NativeLaneOwner, RemoteJobProbe } from "./native-lane.js";

const execFile = promisify(execFileCallback);

/** The host file that names the Studio workers, relative to the repository root. */
const STUDIO_WORKERS_FILE = ".basalt-evals/native-worker/workers.json";
/** The preferences template that each worker captured, relative to the repository root. */
const TEMPLATE_RECORDS = ".basalt-evals/native-worker/templates";
/** The GPU list of this Mac for one boot, relative to the repository root. */
const HOST_GPU_CACHE = ".basalt-evals/native-worker/host-gpus.json";
/** A Studio job starts at most this number of clients. */
const MAX_STUDIO_CLIENTS = 8;
/** Every capture of the worker is a screenshot through the Studio MCP server. */
const STUDIO_CAPTURE_METHOD = "studio_mcp_screenshot";

/** One macOS account that runs Studio jobs in its own GUI login session. */
export interface StudioWorker {
  id: string;
  user: string;
  sshKeyFile: string;
  nodeExecutable: string;
  /** Global lane numbers from 0 to 3. The lanes of two workers never overlap. */
  lanes: number[];
  /** The largest number of clients that one job of this worker can start. */
  maxClients: number;
  screenRecording: boolean;
}

/** The capabilities that bind the evidence of a Studio job. They change only with setup. */
export interface StudioCapabilities {
  host: { osVersion: string; osBuild: string; hardwareModel: string; gpus: string[] };
  workers: Array<{
    id: string;
    lanes: number[];
    maxClients: number;
    captureMethod: typeof STUDIO_CAPTURE_METHOD;
    screenRecording: boolean;
    /** The golden preferences template of the worker, or null before its capture. */
    templateHash: string | null;
  }>;
}

/** The record of one template capture on the controller. */
export interface PreferencesTemplateRecord {
  schema: "basalt-evals/studio-preferences-template-record";
  worker: string;
  user: string;
  templateHash: string;
  capturedAt: string;
}

/** The bytes of a file, or null when the file or one of its folders does not exist. */
async function optionalFile(file: string, maximumBytes: number, label: string) {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return readBoundedRegularFile(file, maximumBytes, label);
}

const WORKER_KEYS = "id,lanes,maxClients,nodeExecutable,screenRecording,sshKeyFile,user";
const SETUP = "Correct it with the steps in docs/DEVELOPMENT.md.";

function invalid(reason: string): Error {
  return new Error(`The Studio workers file is not valid. ${reason} ${SETUP}`);
}

/** The Studio workers of this Mac. The file is a host file that Git ignores. */
export async function readStudioWorkers(root: string): Promise<StudioWorker[]> {
  const file = resolve(root, STUDIO_WORKERS_FILE);
  // An absent folder is also an absent configuration. The bounded read names only the folder.
  const found = await lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!found)
    throw new Error(
      `Basalt cannot find the Studio workers file at ${file}. Basalt does not start Studio in this macOS account. Create the file with the steps in docs/DEVELOPMENT.md.`,
    );
  const bytes = await readBoundedRegularFile(file, 16_384, "Studio workers file");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("It is not JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "schema,workers" ||
    (value as { schema: unknown }).schema !== "basalt-evals/studio-workers"
  )
    throw invalid('It needs exactly "schema": "basalt-evals/studio-workers" and "workers".');
  const entries = (value as { workers: unknown }).workers;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_STUDIO_LANES)
    throw invalid(`It needs from 1 to ${MAX_STUDIO_LANES} workers.`);
  const ids = new Set<string>(),
    users = new Set<string>(),
    lanes = new Set<number>();
  const workers: StudioWorker[] = [];
  for (const entry of entries as unknown[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== WORKER_KEYS
    )
      throw invalid(
        `Each worker needs exactly these fields: ${WORKER_KEYS.replaceAll(",", ", ")}.`,
      );
    const worker = entry as Record<string, unknown>;
    if (typeof worker.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(worker.id))
      throw invalid("A worker id must be lowercase letters, digits and hyphens.");
    if (ids.has(worker.id)) throw invalid(`The worker id ${worker.id} is used two times.`);
    if (typeof worker.user !== "string" || !/^[a-z_][a-z0-9_-]*$/u.test(worker.user))
      throw invalid(`The worker ${worker.id} needs a valid macOS account name.`);
    if (users.has(worker.user))
      throw invalid(`The account ${worker.user} belongs to more than one worker.`);
    if (worker.user === userInfo().username)
      throw new Error(
        `The Studio worker ${worker.id} uses this macOS account. Basalt does not start Studio in this macOS account. Select a different macOS account with the steps in docs/DEVELOPMENT.md.`,
      );
    if (typeof worker.sshKeyFile !== "string" || !isAbsolute(worker.sshKeyFile))
      throw invalid(`The worker ${worker.id} needs an absolute sshKeyFile.`);
    if (typeof worker.nodeExecutable !== "string" || !isAbsolute(worker.nodeExecutable))
      throw invalid(`The worker ${worker.id} needs an absolute nodeExecutable.`);
    if (
      !Array.isArray(worker.lanes) ||
      !worker.lanes.length ||
      worker.lanes.some(
        (lane) => !Number.isSafeInteger(lane) || lane < 0 || lane >= MAX_STUDIO_LANES,
      )
    )
      throw invalid(
        `The worker ${worker.id} needs one or more lanes from 0 to ${MAX_STUDIO_LANES - 1}.`,
      );
    for (const lane of worker.lanes as number[]) {
      if (lanes.has(lane)) throw invalid(`Lane ${lane} belongs to more than one worker.`);
      lanes.add(lane);
    }
    if (
      !Number.isSafeInteger(worker.maxClients) ||
      (worker.maxClients as number) < 1 ||
      (worker.maxClients as number) > MAX_STUDIO_CLIENTS
    )
      throw invalid(`The maxClients of ${worker.id} must be from 1 to ${MAX_STUDIO_CLIENTS}.`);
    if (typeof worker.screenRecording !== "boolean")
      throw invalid(`The screenRecording of ${worker.id} must be true or false.`);
    ids.add(worker.id);
    users.add(worker.user);
    await readBoundedRegularFile(worker.sshKeyFile, 16_384, "Studio worker SSH key");
    workers.push(worker as unknown as StudioWorker);
  }
  return workers;
}

/** Every slot of the workers, in lane order. A new job claims the first free slot. */
export function studioSlots(workers: readonly StudioWorker[]): StudioSlot[] {
  return workers
    .flatMap((worker) => worker.lanes.map((lane) => ({ lane, worker: worker.id })))
    .sort((a, b) => a.lane - b.lane);
}

/** The worker that owns a lane. */
export function workerOfLane(workers: readonly StudioWorker[], lane: number): StudioWorker {
  const worker = workers.find((entry) => entry.lanes.includes(lane));
  if (!worker)
    throw new Error(
      `Studio lane ${lane} has no worker in the Studio workers file. Correct the file with the steps in docs/DEVELOPMENT.md.`,
    );
  return worker;
}

/** A job can take any slot, so a plan can have at most the smallest maxClients of the workers. */
export function studioMaxClients(capabilities: StudioCapabilities): number {
  return Math.min(...capabilities.workers.map((worker) => worker.maxClients));
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function workerSshOptions(worker: Pick<StudioWorker, "sshKeyFile">): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=yes",
    "-i",
    worker.sshKeyFile,
  ];
}

export async function workerSsh(
  worker: StudioWorker,
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFile(
    "/usr/bin/ssh",
    [...workerSshOptions(worker), `${worker.user}@127.0.0.1`, command],
    {
      maxBuffer: 8 * 1024 * 1024,
      signal,
    },
  );
}

export async function workerScp(
  worker: StudioWorker,
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await execFile("/usr/bin/scp", ["-q", ...workerSshOptions(worker), source, destination], {
    maxBuffer: 1024 * 1024,
    signal,
  });
}

/** Runs one read-only command as the worker account and returns its standard output. */
type WorkerCommand = (worker: StudioWorker, command: string) => Promise<string>;

export const sshWorkerCommand: WorkerCommand = async (worker, command) =>
  (await workerSsh(worker, command)).stdout;

/** The home folder of a worker account. Remote job paths use the same rule. */
const workerHome = (worker: Pick<StudioWorker, "user">) => `/Users/${worker.user}`;

/** The template that the worker captured last, or null. */
async function readTemplateRecord(
  root: string,
  worker: string,
): Promise<PreferencesTemplateRecord | null> {
  const bytes = await optionalFile(
    resolve(root, TEMPLATE_RECORDS, `${worker}.json`),
    4096,
    "Studio preferences template record",
  );
  if (!bytes) return null;
  const record = JSON.parse(bytes.toString("utf8")) as PreferencesTemplateRecord;
  if (
    record.schema !== "basalt-evals/studio-preferences-template-record" ||
    record.worker !== worker ||
    !/^[a-f0-9]{64}$/u.test(record.templateHash)
  )
    throw new Error(`The template record of the Studio worker ${worker} is not valid.`);
  return record;
}

/** Replace the template record of one worker atomically. */
export async function writeTemplateRecord(
  root: string,
  record: PreferencesTemplateRecord,
): Promise<void> {
  const directory = resolve(root, TEMPLATE_RECORDS);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeAbsoluteDirectory(directory);
  await replaceFile(resolve(directory, `${record.worker}.json`), JSON.stringify(record) + "\n");
}

async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = resolve(dirname(file), `.${randomUUID()}.pending`);
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Runs one local read-only program and returns its standard output. */
type HostCommand = (file: string, args: string[]) => Promise<string>;

const hostCommand: HostCommand = async (file, args) =>
  (await execFile(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

/**
 * The facts of this Mac. The workers use SSH to 127.0.0.1, so they run on this Mac. The GPU
 * list is slow to read, so Basalt keeps it for one boot.
 */
export async function hostFacts(
  root: string,
  run: HostCommand = hostCommand,
): Promise<StudioCapabilities["host"]> {
  const [osVersion, osBuild, hardwareModel, boot] = await Promise.all([
    run("/usr/bin/sw_vers", ["-productVersion"]),
    run("/usr/bin/sw_vers", ["-buildVersion"]),
    run("/usr/sbin/sysctl", ["-n", "hw.model"]),
    run("/usr/sbin/sysctl", ["-n", "kern.boottime"]),
  ]);
  const bootTime = /sec = (\d+)/u.exec(boot)?.[1];
  if (!bootTime) throw new Error("Basalt cannot read the boot time of this Mac.");
  const cacheFile = resolve(root, HOST_GPU_CACHE);
  let gpus: string[] | null = null;
  const cachedBytes = await optionalFile(cacheFile, 16_384, "GPU cache");
  if (cachedBytes) {
    const cached = JSON.parse(cachedBytes.toString("utf8")) as { bootTime: string; gpus: string[] };
    if (cached.bootTime === bootTime && Array.isArray(cached.gpus)) gpus = cached.gpus;
  }
  if (!gpus) {
    const displays = JSON.parse(
      await run("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"]),
    ) as { SPDisplaysDataType?: Array<{ sppci_model?: string; sppci_cores?: string }> };
    gpus = (displays.SPDisplaysDataType ?? [])
      .map((gpu) =>
        [gpu.sppci_model, gpu.sppci_cores ? `${gpu.sppci_cores} cores` : null]
          .filter(Boolean)
          .join(", "),
      )
      .filter(Boolean)
      .sort();
    await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
    await replaceFile(cacheFile, JSON.stringify({ bootTime, gpus }) + "\n");
  }
  return {
    osVersion: osVersion.trim(),
    osBuild: osBuild.trim(),
    hardwareModel: hardwareModel.trim(),
    gpus,
  };
}

/** The capabilities of the workers. Each worker gives its captured template, never a job value. */
export async function studioCapabilities(
  root: string,
  workers: readonly StudioWorker[],
  host: StudioCapabilities["host"],
): Promise<StudioCapabilities> {
  return {
    host,
    workers: await Promise.all(
      workers.map(async (worker) => ({
        id: worker.id,
        lanes: [...worker.lanes].sort((a, b) => a - b),
        maxClients: worker.maxClients,
        captureMethod: STUDIO_CAPTURE_METHOD,
        screenRecording: worker.screenRecording,
        templateHash: (await readTemplateRecord(root, worker.id))?.templateHash ?? null,
      })),
    ),
  };
}

/** The tools of the read-only setup checks. Tests supply fakes. */
interface PreflightTools {
  remote: WorkerCommand;
  studioVersion(): Promise<string>;
  /** The hash of the connector bytes that the controller installed. */
  connectorHash(): Promise<string>;
}

const detail = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).trim().split("\n")[0]!.slice(0, 300);

/**
 * Read-only checks of the Studio setup. It returns one sentence for each failed check. It never
 * starts Studio and it never changes a file of a worker account.
 */
export async function preflightStudioWorkers(
  root: string,
  tools: PreflightTools,
): Promise<string[]> {
  let workers: StudioWorker[];
  try {
    workers = await readStudioWorkers(root);
  } catch (error) {
    return [detail(error)];
  }
  const problems: string[] = [];
  const [version, connector] = await Promise.allSettled([
    tools.studioVersion(),
    tools.connectorHash(),
  ]);
  if (version.status === "rejected")
    problems.push(
      `Basalt cannot read the version of Studio on this Mac. ${detail(version.reason)}`,
    );
  if (connector.status === "rejected")
    problems.push(
      "Basalt cannot read the installed Basalt connector. To install it, run npm run plugin:build.",
    );
  problems.push(...(await laneFolderProblems(root, workers)));
  const perWorker = await Promise.all(
    workers.map((worker) =>
      workerProblems(
        root,
        worker,
        tools,
        connector.status === "fulfilled" ? connector.value : null,
      ),
    ),
  );
  return [...problems, ...perWorker.flat()];
}

async function laneFolderProblems(root: string, workers: readonly StudioWorker[]) {
  const lanes = resolve(root, ".basalt-evals/native-worker/lanes");
  try {
    await lstat(lanes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    await assertSafeAbsoluteDirectory(lanes);
    for (const name of await readdir(lanes)) {
      if (!workers.some((worker) => worker.lanes.includes(Number(name)))) continue;
      const info = await lstat(resolve(lanes, name));
      if (info.isSymbolicLink() || !info.isDirectory())
        return [
          `The folder of Studio slot ${Number(name) + 1} at ${lanes}/${name} is not a folder.`,
        ];
    }
    return [];
  } catch (error) {
    return [`The Studio slot folders at ${lanes} are not safe. ${detail(error)}`];
  }
}

async function workerProblems(
  root: string,
  worker: StudioWorker,
  tools: PreflightTools,
  connectorHash: string | null,
): Promise<string[]> {
  let account: string[];
  try {
    account = (await tools.remote(worker, "id -un && id -u")).trim().split("\n");
  } catch (error) {
    return [
      `Basalt cannot connect to the Studio worker ${worker.id} with SSH as ${worker.user}. ${detail(error)}`,
    ];
  }
  if (account[0] !== worker.user || !/^\d+$/u.test(account[1] ?? ""))
    return [
      `SSH for the Studio worker ${worker.id} reached the account ${account[0]}, not ${worker.user}. Correct the Studio workers file with the steps in docs/DEVELOPMENT.md.`,
    ];
  const home = workerHome(worker);
  const checks: Array<() => Promise<string | null>> = [
    async () => {
      const version = await tools.remote(worker, `${shellQuote(worker.nodeExecutable)} --version`);
      return /^v\d+\./u.test(version.trim())
        ? null
        : `The Studio worker ${worker.id} cannot run Node at ${worker.nodeExecutable}.`;
    },
    async () => {
      const settings = await tools.remote(
        worker,
        `/bin/cat ${shellQuote(`${home}/${STUDIO_SETTINGS_FILE}`)}`,
      );
      const plugin = configuredStudioPluginFile(settings, home);
      const expected = `${home}/${STUDIO_PLUGINS_DIRECTORY}`;
      if (dirname(plugin) !== expected)
        return `Studio of the worker ${worker.id} loads plugins from ${dirname(plugin)}, not from ${expected}. Set Studio.PluginsDir with the steps in docs/DEVELOPMENT.md.`;
      if (connectorHash === null) return null;
      const hash = (
        await tools.remote(worker, `/usr/bin/shasum -a 256 ${shellQuote(plugin)}`)
      ).split(/\s/u)[0];
      return hash === connectorHash
        ? null
        : `The Basalt connector of the worker ${worker.id} at ${plugin} is not the current version. Copy the current connector there with the steps in docs/DEVELOPMENT.md.`;
    },
    async () => {
      const value = await tools.remote(
        worker,
        `/usr/bin/defaults read ${STUDIO_DEFAULTS_DOMAIN} ApplePersistenceIgnoreState`,
      );
      return value.trim() === "1"
        ? null
        : `Window restoration of Studio is on for the worker ${worker.id}. Set ApplePersistenceIgnoreState to YES with the steps in docs/DEVELOPMENT.md.`;
    },
    async () => {
      const record = await readTemplateRecord(root, worker.id);
      if (!record)
        return `The Studio worker ${worker.id} has no preferences template. Run studio template capture ${worker.id}.`;
      const remote = JSON.parse(
        await tools.remote(
          worker,
          `/bin/cat ${shellQuote(`${home}/${GOLDEN_DIRECTORY}/template.json`)}`,
        ),
      ) as { templateHash?: unknown };
      return remote.templateHash === record.templateHash
        ? null
        : `The preferences template of the worker ${worker.id} differs from the one that Basalt recorded. Run studio template capture ${worker.id} again.`;
    },
    async () => {
      const session = await tools.remote(
        worker,
        `/bin/launchctl print gui/${account[1]} >/dev/null 2>&1 && echo present || echo absent`,
      );
      return session.trim() === "present"
        ? null
        : `The account ${worker.user} of the Studio worker ${worker.id} has no GUI login session. Log in to that account on this Mac, then switch back.`;
    },
  ];
  const results = await Promise.all(
    checks.map((check, index) =>
      check().catch(
        (error: unknown) =>
          [
            `The Studio worker ${worker.id} cannot run Node at ${worker.nodeExecutable}. ${detail(error)}`,
            `Basalt cannot read the Studio settings of the worker ${worker.id}. ${detail(error)}`,
            `Basalt cannot read the window restoration setting of Studio for the worker ${worker.id}. ${detail(error)}`,
            `Basalt cannot read the preferences template of the worker ${worker.id}. Run studio template capture ${worker.id}. ${detail(error)}`,
            `Basalt cannot check the GUI login session of the worker ${worker.id}. ${detail(error)}`,
          ][index]!,
      ),
    ),
  );
  return results.filter((problem): problem is string => problem !== null);
}

/** The remote facts of a job lease. The worker writes it every 10 s. */
interface RemoteJobLease {
  workerPid: number;
  workerPgid: number;
  studioPids: number[];
  placeArgument: string;
  renewedAt: string;
}

/**
 * Read the facts of a dispatched job whose controller is gone. It uses two read-only SSH commands.
 * The process list runs alone, so its own command line never names the job folder.
 */
export async function probeRemoteJob(
  root: string,
  owner: NativeLaneOwner,
  remote: WorkerCommand = sshWorkerCommand,
): Promise<RemoteJobProbe> {
  const worker = workerOfLane(await readStudioWorkers(root), owner.lane);
  if (worker.id !== owner.worker)
    throw new Error("The lane belongs to a different worker than its claim");
  const job = JSON.parse(
    (
      await readBoundedRegularFile(
        resolve(owner.sessionDirectory, "native/remote-job.json"),
        4096,
        "retained isolated Studio job",
      )
    ).toString("utf8"),
  ) as { user?: unknown; remote?: unknown };
  if (
    job.user !== worker.user ||
    typeof job.remote !== "string" ||
    !new RegExp(`^/Users/${worker.user}/BasaltTrials/job-[a-f0-9]{32}/studio$`, "u").test(
      job.remote,
    )
  )
    throw new Error("The retained Studio job does not belong to this worker");
  const folder = dirname(job.remote);
  const facts = (
    await remote(
      worker,
      `id -un && id -u && (test -f ${shellQuote(`${job.remote}/native/manifest.json`)} && echo receipt || echo none) && (test -f ${shellQuote(`${folder}/lease.json`)} && /bin/cat ${shellQuote(`${folder}/lease.json`)} || echo none)`,
    )
  )
    .trim()
    .split("\n");
  const uid = Number(facts[1]);
  if (
    facts[0] !== worker.user ||
    !/^\d+$/u.test(facts[1] ?? "") ||
    !["receipt", "none"].includes(facts[2] ?? "")
  )
    throw new Error("The probe reached a different account");
  let lease: RemoteJobLease | null = null;
  if (facts[3] !== "none") {
    lease = JSON.parse(facts.slice(3).join("\n")) as RemoteJobLease;
    if (!Number.isSafeInteger(lease.workerPgid) || !Number.isFinite(Date.parse(lease.renewedAt)))
      throw new Error("The remote job lease is not valid");
  }
  const processes = (await remote(worker, "/bin/ps -axww -o uid=,pgid=,command="))
    .split("\n")
    .some((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      if (!match || Number(match[1]) !== uid) return false;
      return (
        (lease !== null && Number(match[2]) === lease.workerPgid) ||
        match[3]!.includes(`${folder}/`) ||
        match[3]!.endsWith(folder)
      );
    });
  return { leaseRenewedAt: lease?.renewedAt ?? null, processes, receipt: facts[2] === "receipt" };
}
