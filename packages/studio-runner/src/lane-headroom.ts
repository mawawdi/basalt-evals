import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";

/*
 * Headroom admission of a Studio lane. The first lane on this Mac always starts. A lane beside a
 * held lane starts only when this Mac has the memory and the CPU for one more job, from the
 * measured footprint of recent jobs. The worker measures each job and writes its footprint beside
 * the signed tree. The footprint is an operational measurement, not evidence.
 */

const execFileAsync = promisify(execFile);

/** The footprint file of a job, beside its signed `studio` folder. */
export const JOB_FOOTPRINT_FILE = "footprint.json";
/** The controller keeps the footprints of this number of recent jobs. */
export const RECENT_FOOTPRINTS = 10;
const MAX_FOOTPRINT_STEPS = 64;

/** The use of one Studio step: the owned Studio processes of one launch. */
export interface StepFootprint {
  stepId: string;
  /** The largest sum of the resident memory of the owned processes in one process scan. */
  peakResidentBytes: number;
  /** The mean sum of the CPU use of the owned processes in a scan, in cores. */
  meanCores: number;
}

export interface JobFootprint {
  schema: "basalt-evals/studio-footprint";
  /** The job ID of the signed worker manifest. */
  jobId: string;
  steps: StepFootprint[];
}

/** The largest use of one lane in the recent jobs. */
export interface LaneFootprint {
  peakResidentBytes: number;
  cores: number;
}

/** The free resources of this Mac now. */
export interface MachineLoad {
  /** The memory that macOS can give without pressure: kern.memorystatus_level of hw.memsize. */
  availableBytes: number;
  physicalBytes: number;
  /** The idle time of all cores in a short sample, in cores. */
  idleCores: number;
  cpuCount: number;
}

/** Collects the process scans of one step. */
export function stepFootprintSampler(stepId: string) {
  let peakResidentBytes = 0,
    coreSum = 0,
    samples = 0;
  return {
    sample(residentBytes: number, cores: number) {
      if (!Number.isFinite(residentBytes) || !Number.isFinite(cores)) return;
      peakResidentBytes = Math.max(peakResidentBytes, residentBytes);
      coreSum += cores;
      samples += 1;
    },
    result(): StepFootprint {
      return {
        stepId,
        peakResidentBytes,
        meanCores: samples ? Math.round((coreSum / samples) * 100) / 100 : 0,
      };
    },
  };
}

/** A footprint file of a job, or null if it is absent or not valid. */
export function parseJobFootprint(text: string, jobId: string): JobFootprint | null {
  try {
    const value = JSON.parse(text) as JobFootprint;
    if (
      value?.schema !== "basalt-evals/studio-footprint" ||
      value.jobId !== jobId ||
      !Array.isArray(value.steps) ||
      value.steps.length > MAX_FOOTPRINT_STEPS ||
      value.steps.some(
        (step) =>
          typeof step?.stepId !== "string" ||
          !Number.isSafeInteger(step.peakResidentBytes) ||
          step.peakResidentBytes < 0 ||
          !Number.isFinite(step.meanCores) ||
          step.meanCores < 0,
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

const footprintDirectory = (stateRoot: string) => resolve(stateRoot, "native-worker/footprints");

/** Keep the footprint of one job, and only the most recent jobs. */
export async function recordJobFootprint(stateRoot: string, footprint: JobFootprint) {
  if (!/^[a-f0-9]{32}$/u.test(footprint.jobId)) throw new Error("Invalid Studio job ID");
  const directory = footprintDirectory(stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeAbsoluteDirectory(directory);
  const record = { ...footprint, recordedAt: new Date().toISOString() };
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, resolve(directory, `${footprint.jobId}.json`));
  const recent = await readRecent(stateRoot);
  for (const old of recent.slice(RECENT_FOOTPRINTS))
    await rm(resolve(directory, `${old.jobId}.json`), { force: true });
}

async function readRecent(stateRoot: string) {
  const directory = footprintDirectory(stateRoot);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const records: Array<JobFootprint & { recordedAt: number }> = [];
  for (const name of names) {
    const match = /^([a-f0-9]{32})\.json$/u.exec(name);
    if (!match) continue;
    // A record that another write removes or a damaged record counts as no measurement.
    const text = await readFile(resolve(directory, name), "utf8").catch(() => "");
    const footprint = parseJobFootprint(text, match[1]!);
    const recordedAt = footprint
      ? Date.parse((JSON.parse(text) as { recordedAt?: string }).recordedAt ?? "")
      : NaN;
    if (footprint && Number.isFinite(recordedAt)) records.push({ ...footprint, recordedAt });
  }
  return records.sort((a, b) => b.recordedAt - a.recordedAt);
}

/** The largest use of one lane in the recent jobs, or null before the first measured job. */
export async function laneFootprint(stateRoot: string): Promise<LaneFootprint | null> {
  const steps = (await readRecent(stateRoot))
    .slice(0, RECENT_FOOTPRINTS)
    .flatMap((job) => job.steps);
  if (!steps.length) return null;
  return {
    peakResidentBytes: Math.max(...steps.map((step) => step.peakResidentBytes)),
    cores: Math.max(...steps.map((step) => step.meanCores)),
  };
}

/** The CPU sample of a headroom check. */
const CPU_SAMPLE_MS = 2_000;

/** The sum of the idle time and of the total time of all cores since the start of this Mac. */
function cpuTimes() {
  let idle = 0,
    total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/**
 * The free memory and the idle CPU of this Mac. The idle CPU comes from a sample of the core
 * times. The load average of macOS also counts threads that use no CPU, so it does not show
 * the spare CPU.
 */
export async function machineLoad(sampleMs = CPU_SAMPLE_MS): Promise<MachineLoad> {
  const before = cpuTimes();
  const { stdout } = await execFileAsync(
    "/usr/sbin/sysctl",
    ["-n", "kern.memorystatus_level", "hw.memsize"],
    { timeout: 5_000, maxBuffer: 1024 },
  );
  const [level, memsize] = stdout.trim().split(/\s+/u).map(Number);
  if (!Number.isFinite(level) || !Number.isFinite(memsize) || level! < 0 || level! > 100)
    throw new Error("This Mac did not report its free memory");
  await delay(sampleMs);
  const after = cpuTimes();
  const total = after.total - before.total;
  if (!(total > 0)) throw new Error("This Mac did not report its CPU use");
  const cpuCount = cpus().length;
  return {
    availableBytes: Math.round((level! / 100) * memsize!),
    physicalBytes: memsize!,
    idleCores: ((after.idle - before.idle) / total) * cpuCount,
    cpuCount,
  };
}

/**
 * True if this Mac can run one more lane: the free memory holds the footprint and a reserve of
 * one tenth of the memory, and the idle CPU holds the CPU use of a job and a reserve of one tenth
 * of the cores. Without a footprint, no second lane starts.
 */
export function admitsAnotherLane(load: MachineLoad, footprint: LaneFootprint | null): boolean {
  return (
    footprint !== null &&
    load.availableBytes >= footprint.peakResidentBytes + load.physicalBytes / 10 &&
    load.idleCores >= footprint.cores + load.cpuCount / 10
  );
}

/**
 * True if a StudioMCP of this account runs, for example for a Studio session of the person. All
 * Studio MCP connections on this Mac then relay through a process that Basalt does not control,
 * so its end could break both lanes at the same time.
 */
export async function accountStudioMcpRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-u", String(process.getuid!()), "-x", "StudioMCP"], {
      timeout: 5_000,
      maxBuffer: 4096,
    });
    return true;
  } catch (error) {
    // pgrep exits with status 1 when no process matches.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * The headroom check of a claim beside a held lane. A second lane needs a measured footprint,
 * enough free resources and no StudioMCP of this account. A failed reading admits no second lane.
 */
export function laneHeadroom(
  stateRoot: string,
  read: () => Promise<MachineLoad> = machineLoad,
  studioMcpRunning: () => Promise<boolean> = accountStudioMcpRunning,
): () => Promise<boolean> {
  return async () => {
    try {
      const footprint = await laneFootprint(stateRoot);
      return (
        footprint !== null &&
        !(await studioMcpRunning()) &&
        admitsAnotherLane(await read(), footprint)
      );
    } catch {
      return false;
    }
  };
}
