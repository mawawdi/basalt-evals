import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import { nativeStudioAdapter } from "../packages/studio-runner/src/adapter.js";
import {
  admitsAnotherLane,
  laneFootprint,
  laneHeadroom,
  parseJobFootprint,
  recordJobFootprint,
  RECENT_FOOTPRINTS,
  stepFootprintSampler,
  type JobFootprint,
  type MachineLoad,
} from "../packages/studio-runner/src/lane-headroom.js";
import * as lane from "../packages/studio-runner/src/native-lane.js";
import {
  acquireStudioStartLock,
  processStartTime,
  STUDIO_START_LOCK,
} from "../packages/studio-runner/src/studio-start-lock.js";

const GiB = 1024 ** 3;
/** A Mac with 16 GiB and 8 cores. */
const machine = (availableGiB: number, idleCores: number): MachineLoad => ({
  availableBytes: availableGiB * GiB,
  physicalBytes: 16 * GiB,
  idleCores,
  cpuCount: 8,
});
const slots = (...lanes: number[]) => lanes.map((index) => ({ lane: index, worker: "evals" }));
const job = (index: number, peakGiB: number, meanCores: number): JobFootprint => ({
  schema: "basalt-evals/studio-footprint",
  jobId: index.toString(16).padStart(32, "0"),
  steps: [{ stepId: "presentation/attempt-01", peakResidentBytes: peakGiB * GiB, meanCores }],
});

async function workspace(name: string) {
  return mkdtemp(resolve(tmpdir(), `basalt-headroom-${name}-`));
}

test("another lane starts only with a measured footprint, enough free memory and spare CPU", () => {
  const footprint = { peakResidentBytes: 4 * GiB, cores: 2 };
  assert.equal(admitsAnotherLane(machine(12, 6), null), false, "no measured job, no second lane");
  assert.equal(admitsAnotherLane(machine(12, 6), footprint), true);
  // The free memory must hold the footprint and a reserve of one tenth of the memory.
  assert.equal(admitsAnotherLane(machine(5.6, 6), footprint), true);
  assert.equal(admitsAnotherLane(machine(5.5, 6), footprint), false);
  // The idle CPU must hold the CPU use of a job and a reserve of one tenth of the cores.
  assert.equal(admitsAnotherLane(machine(12, 2.9), footprint), true);
  assert.equal(admitsAnotherLane(machine(12, 2.7), footprint), false);
});

test("a step footprint keeps the peak memory and the mean CPU of its scans", () => {
  const sampler = stepFootprintSampler("scenario/attempt-01");
  assert.deepEqual(sampler.result(), {
    stepId: "scenario/attempt-01",
    peakResidentBytes: 0,
    meanCores: 0,
  });
  sampler.sample(2 * GiB, 1);
  sampler.sample(3 * GiB, 2);
  sampler.sample(NaN, 9);
  assert.deepEqual(sampler.result(), {
    stepId: "scenario/attempt-01",
    peakResidentBytes: 3 * GiB,
    meanCores: 1.5,
  });
});

test("the controller keeps the footprints of the recent jobs and ignores a bad file", async () => {
  const root = await workspace("footprints");
  try {
    assert.equal(await laneFootprint(root), null);
    const text = JSON.stringify(job(1, 3, 1));
    assert.deepEqual(parseJobFootprint(text, job(1, 3, 1).jobId), job(1, 3, 1));
    assert.equal(parseJobFootprint(text, job(2, 3, 1).jobId), null, "another job");
    assert.equal(parseJobFootprint("{", job(1, 3, 1).jobId), null);
    assert.equal(
      parseJobFootprint(
        JSON.stringify({ ...job(1, 3, 1), steps: [{ stepId: "a", peakResidentBytes: -1 }] }),
        job(1, 3, 1).jobId,
      ),
      null,
    );
    // The oldest job has the largest footprint. It leaves the record after ten newer jobs.
    for (let index = 1; index <= RECENT_FOOTPRINTS + 1; index++) {
      // Each record has its own time, so the order of the records is clear.
      await new Promise((done) => setTimeout(done, 2));
      await recordJobFootprint(
        root,
        index === 1 ? job(1, 9, 5) : job(index, index === 5 ? 6 : 3, index === 7 ? 3 : 1),
      );
    }
    assert.equal(
      (await readdir(resolve(root, "native-worker/footprints"))).length,
      RECENT_FOOTPRINTS,
    );
    assert.deepEqual(await laneFootprint(root), { peakResidentBytes: 6 * GiB, cores: 3 });
    // A damaged record counts as no measurement.
    await writeFile(resolve(root, "native-worker/footprints", `${"f".repeat(32)}.json`), "{");
    assert.deepEqual(await laneFootprint(root), { peakResidentBytes: 6 * GiB, cores: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the headroom check reads the machine only with a footprint, and a failed reading admits no lane", async () => {
  const root = await workspace("check");
  try {
    let reads = 0;
    const read = async () => {
      reads++;
      return machine(12, 6);
    };
    // A real reading of this Mac must not decide a test.
    const noStudioMcp = async () => false;
    assert.equal(await laneHeadroom(root, read, noStudioMcp)(), false);
    assert.equal(reads, 0, "without a footprint, the check does not read the machine");
    await recordJobFootprint(root, job(1, 4, 2));
    assert.equal(await laneHeadroom(root, read, noStudioMcp)(), true);
    assert.equal(
      await laneHeadroom(
        root,
        async () => {
          throw new Error("sysctl failed");
        },
        noStudioMcp,
      )(),
      false,
    );
    // A StudioMCP of this account, or a failed process check, admits no second lane.
    assert.equal(await laneHeadroom(root, read, async () => true)(), false);
    assert.equal(
      await laneHeadroom(root, read, async () => {
        throw new Error("pgrep failed");
      })(),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lane beside a held lane needs headroom, and the first lane needs none", async () => {
  const root = await workspace("claim");
  const stateRoot = resolve(root, ".basalt-evals");
  const session = (name: string) => resolve(stateRoot, `operations/${name}/studio`);
  try {
    let checks = 0;
    const refuse = async () => {
      checks++;
      return false;
    };
    // No lane is held, so the claim takes lane 0 without a check.
    assert.equal(await lane.claimNativeLane(stateRoot, session("first"), slots(0, 1), refuse), 0);
    assert.equal(checks, 0);
    await assert.rejects(
      lane.claimNativeLane(stateRoot, session("second"), slots(0, 1), refuse),
      (error) => error instanceof lane.NativeLaneBusy,
    );
    assert.equal(checks, 1);
    // A claim of the same session in this process keeps its lane with no check.
    assert.equal(await lane.claimNativeLane(stateRoot, session("first"), slots(0, 1), refuse), 0);
    assert.equal(checks, 1);
    assert.equal(
      await lane.claimNativeLane(stateRoot, session("second"), slots(0, 1), async () => true),
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a job that has no headroom for lane 1 takes lane 0 as soon as lane 0 is free", async () => {
  const root = await workspace("wait");
  const stateRoot = resolve(root, ".basalt-evals");
  const first = resolve(stateRoot, "operations/first/studio"),
    second = resolve(stateRoot, "operations/second/studio");
  try {
    await lane.claimNativeLane(stateRoot, first, slots(0));
    let markWaiting!: () => void;
    const waiting = new Promise<void>((done) => (markWaiting = done));
    const pending = lane.waitForNativeLane({
      stateRoot,
      sessionDirectory: second,
      slots: slots(0, 1),
      headroom: async () => false,
      // Only a stall reaches this bound. The release below ends the wait.
      timeoutMs: 60_000,
      pollMs: 10,
      onWaiting: async () => markWaiting(),
    });
    await waiting;
    assert.equal(await lane.nativeLaneOf(stateRoot, second), null, "lane 1 is free but refused");
    await lane.releaseNativeLane(stateRoot, first);
    assert.equal((await pending).lane, 0);
    assert.equal(await lane.releaseNativeLane(stateRoot, second), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the native adapter admits no second lane before a measured job", async () => {
  const root = await workspace("adapter");
  const stateRoot = resolve(root, ".basalt-evals");
  const directory = (name: string) => resolve(stateRoot, `studio-readiness/${name}/studio`);
  try {
    const workers = resolve(stateRoot, "native-worker");
    await mkdir(workers, { recursive: true });
    await writeFile(resolve(workers, "test-ssh-key"), "test key");
    await writeFile(
      resolve(workers, "workers.json"),
      JSON.stringify({
        schema: "basalt-evals/studio-workers",
        workers: [
          {
            id: "evals",
            user: "basalt-lane-test",
            sshKeyFile: resolve(workers, "test-ssh-key"),
            nodeExecutable: process.execPath,
            lanes: [0, 1],
            maxClients: 2,
            screenRecording: false,
          },
        ],
      }),
    );
    await lane.claimNativeLane(stateRoot, resolve(stateRoot, "other/studio"), slots(0));
    await mkdir(directory("second"), { recursive: true });
    const busy = new lane.NativeLaneBusy(stateRoot);
    await assert.rejects(
      nativeStudioAdapter.admit!({
        root,
        directory: directory("second"),
        purpose: "readiness",
        onWaiting: async () => {
          throw busy;
        },
      }),
      (error) => error === busy,
    );
    assert.ok(busy instanceof ExecutionFault);
    assert.match(
      busy.failure.explanation,
      /enough free memory and CPU, and no Studio MCP open in your account/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Studio start lock lets one holder at a time start Studio", async () => {
  const directory = await workspace("lock");
  try {
    const first = await acquireStudioStartLock({ directory });
    // Both holders are this process. The first read is the own start time of the second holder,
    // and each later read checks the first holder.
    let reads = 0;
    let markPolled!: () => void;
    const polled = new Promise<void>((done) => (markPolled = done));
    let acquired = false;
    const second = acquireStudioStartLock({
      directory,
      // Only a stall reaches this bound. The release below ends the wait.
      waitMs: 60_000,
      pollMs: 5,
      startTime: async (pid) => {
        if (++reads === 4) markPolled();
        return processStartTime(pid);
      },
    }).then((lock) => {
      acquired = true;
      return lock;
    });
    await polled;
    assert.equal(acquired, false, "the second holder waits for the first");
    await first.release();
    await (await second).release();
    assert.deepEqual(await readdir(directory), [], "a release leaves no lock");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a gone or reused holder process loses the start lock, and a live holder keeps it", async () => {
  const directory = await workspace("stale");
  try {
    const own = await processStartTime(process.pid);
    const holder = (pid: number, processStartedAt: string) =>
      mkdir(resolve(directory, STUDIO_START_LOCK)).then(() =>
        writeFile(
          resolve(directory, STUDIO_START_LOCK, "owner.json"),
          JSON.stringify({ token: `holder-${pid}`, pid, processStartedAt }),
        ),
      );
    const startTime = (holders: Record<number, string | null>) => async (pid: number) =>
      pid === process.pid ? own : (holders[pid] ?? null);
    // The holder process is gone.
    await holder(41, "Sun Oct  4 10:00:00 2026");
    await (await acquireStudioStartLock({ directory, startTime: startTime({}) })).release();
    // A newer process has the ID of the holder.
    await holder(42, "Sun Oct  4 10:00:00 2026");
    await (
      await acquireStudioStartLock({
        directory,
        startTime: startTime({ 42: "Sun Oct  4 11:00:00 2026" }),
      })
    ).release();
    assert.deepEqual(await readdir(directory), []);
    // A live holder keeps the lock, also after a long time. The waiter stops at its bound.
    await holder(43, "Sun Oct  4 10:00:00 2026");
    await assert.rejects(
      acquireStudioStartLock({
        directory,
        waitMs: 30,
        pollMs: 5,
        startTime: startTime({ 43: "Sun Oct  4 10:00:00 2026" }),
      }),
      /did not finish in time/u,
    );
    assert.deepEqual(await readdir(directory), [STUDIO_START_LOCK]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
