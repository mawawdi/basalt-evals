import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as lane from "../packages/studio-runner/src/native-lane.js";
import { studioLaneOfConnectorUrl } from "../packages/studio-runner/src/studio-lanes.js";
import {
  nativeStudioAdapter,
  nativeStudioAdapterOf,
  STUDIO_ADMISSIONS_FILE,
} from "../packages/studio-runner/src/adapter.js";
import { ExecutionFault } from "../packages/contracts/src/failure.js";

type WaitInput = {
  stateRoot: string;
  sessionDirectory: string;
  slots?: ReturnType<typeof slots>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  onWaiting?: () => Promise<void>;
};
/** An adapter for which this Mac always has headroom for another lane. */
const roomy = nativeStudioAdapterOf(() => async () => true);
/** The slots of one test worker. */
const slots = (...lanes: number[]) => lanes.map((index) => ({ lane: index, worker: "evals" }));
const wait = (input: WaitInput) => lane.waitForNativeLane({ slots: slots(0), ...input });
/** A claim of a process that no longer exists. */
const deadOwner = (sessionDirectory: string, index = 0, renewedAt = new Date().toISOString()) =>
  JSON.stringify({
    worker: "evals",
    pid: 2147483647,
    sessionDirectory,
    lane: index,
    claimedAt: renewedAt,
    renewedAt,
    leaseMs: lane.LANE_LEASE_MS,
  });
const ownerOf = async (stateRoot: string, index: number) =>
  JSON.parse(await readFile(resolve(stateRoot, `native-worker/lanes/${index}/owner.json`), "utf8"))
    .sessionDirectory;
test("two native operations wait for admission and release exactly one lane", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-wait-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const first = resolve(stateRoot, "operations/first/studio"),
    second = resolve(stateRoot, "operations/second/studio");
  try {
    await lane.claimNativeLane(stateRoot, first, slots(0));
    let admitted = false,
      waiting = 0;
    let markBlocked!: () => void;
    const blocked = new Promise<void>((done) => (markBlocked = done));
    const pending = wait({
      stateRoot,
      sessionDirectory: second,
      // Only a stall reaches this bound. The release below ends the wait.
      timeoutMs: 60_000,
      pollMs: 10,
      onWaiting: async () => {
        waiting++;
        markBlocked();
      },
    }).then((admission) => {
      admitted = true;
      return admission;
    });
    // Wait for the busy lane to block the second operation. Then keep it blocked for 50 ms.
    await blocked;
    await delay(50);
    assert.equal(admitted, false);
    assert.equal(waiting, 1);
    assert.equal(await ownerOf(stateRoot, 0), first);
    await lane.releaseNativeLane(stateRoot, first);
    const admission = await pending;
    assert.equal(admitted, true);
    assert.ok(admission.waitedMs >= 50, "the recorded queue wait covers the time spent blocked");
    assert.ok(Date.parse(admission.admittedAt) >= Date.parse(admission.requestedAt));
    assert.equal(admission.lane, 0);
    assert.equal(await ownerOf(stateRoot, 0), second);
    assert.equal(await lane.releaseNativeLane(stateRoot, first), false);
    assert.equal(await lane.releaseNativeLane(stateRoot, second), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("waiting cancellation and timeout preserve the current owner's uncertain dispatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-wait-stop-"));
  const stateRoot = resolve(root, ".basalt-evals"),
    first = resolve(stateRoot, "first/studio"),
    second = resolve(stateRoot, "second/studio");
  try {
    await lane.claimNativeLane(stateRoot, first, slots(0));
    const abort = new AbortController();
    const pending = wait({
      stateRoot,
      sessionDirectory: second,
      signal: abort.signal,
      timeoutMs: 1000,
      pollMs: 10,
    });
    await delay(20);
    abort.abort();
    await assert.rejects(
      pending,
      (error) =>
        error instanceof ExecutionFault && error.failure.causeCode === "studio_lane_wait_cancelled",
    );
    await mkdir(resolve(first, "native"), { recursive: true });
    await writeFile(resolve(first, "native/remote-job.json"), "{}");
    await writeFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), deadOwner(first));
    await assert.rejects(
      wait({ stateRoot, sessionDirectory: second, timeoutMs: 40, pollMs: 10 }),
      (error) =>
        error instanceof ExecutionFault && error.failure.causeCode === "studio_lane_wait_timeout",
    );
    assert.equal(await ownerOf(stateRoot, 0), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function studioWorkers(root: string, lanes: number[]) {
  const directory = resolve(root, ".basalt-evals/native-worker");
  await mkdir(directory, { recursive: true });
  const key = resolve(directory, "test-ssh-key");
  await writeFile(key, "test key");
  await writeFile(
    resolve(directory, "workers.json"),
    JSON.stringify({
      schema: "basalt-evals/studio-workers",
      workers: [
        {
          id: "evals",
          user: "basalt-lane-test",
          sshKeyFile: key,
          nodeExecutable: process.execPath,
          lanes,
          maxClients: 2,
          screenRecording: false,
        },
      ],
    }),
  );
}

test("the admission record holds the purpose, the lane and the full wait from the request for a turn", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-admission-"));
  const directory = resolve(root, ".basalt-evals/capture/cell/studio");
  try {
    await mkdir(directory, { recursive: true });
    await studioWorkers(root, [0]);
    const queuedAt = new Date(Date.now() - 60_000).toISOString();
    const admission = await nativeStudioAdapter.admit!({
      root,
      directory,
      purpose: "final_capture",
      queuedAt,
    });
    assert.equal(admission.lane, 0);
    assert.equal(admission.connectorUrl, "http://127.0.0.1:43123");
    await admission.release();
    const record = JSON.parse(
      await readFile(resolve(directory, "..", STUDIO_ADMISSIONS_FILE), "utf8"),
    );
    assert.equal(record.purpose, "final_capture");
    assert.equal(record.lane, 0);
    assert.equal(record.queuedAt, queuedAt);
    // The run queue wait counts, not only the wait for the native lane.
    assert.ok(record.waitedMs >= 60_000);
    assert.ok(Date.parse(record.admittedAt) >= Date.parse(record.laneRequestedAt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an admission that Basalt cannot record releases its lane", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-admission-record-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const directory = resolve(stateRoot, "capture/cell/studio");
  try {
    await mkdir(directory, { recursive: true });
    await studioWorkers(root, [0]);
    // A folder in place of the record file makes the append fail after the claim.
    await mkdir(resolve(directory, "..", STUDIO_ADMISSIONS_FILE));
    await assert.rejects(
      nativeStudioAdapter.admit!({ root, directory, purpose: "final_capture" }),
      (error) => (error as NodeJS.ErrnoException).code === "EISDIR",
    );
    assert.equal(await lane.nativeLaneOf(stateRoot, directory), null);
    assert.equal(
      await lane.claimNativeLane(stateRoot, resolve(stateRoot, "other/studio"), slots(0)),
      0,
      "The lane is free for the next job",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two jobs hold two lanes with two connector ports, and a third job waits", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-lanes-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const session = (name: string) => resolve(stateRoot, `operations/${name}/studio`);
  try {
    await studioWorkers(root, [0, 1]);
    assert.equal(await roomy.lanes!(root), 2);
    const admit = (name: string) =>
      roomy.admit!({ root, directory: session(name), purpose: "final_capture" });
    for (const name of ["first", "second", "third"])
      await mkdir(session(name), { recursive: true });
    const first = await admit("first");
    const second = await admit("second");
    assert.deepEqual(
      [first.lane, second.lane, first.connectorUrl, second.connectorUrl],
      [0, 1, "http://127.0.0.1:43123", "http://127.0.0.1:43124"],
    );
    assert.equal(await lane.nativeLaneOf(stateRoot, session("second")), 1);
    let admitted = false;
    const third = lane
      .waitForNativeLane({
        stateRoot,
        sessionDirectory: session("third"),
        slots: slots(0, 1),
        timeoutMs: 1000,
        pollMs: 10,
      })
      .then((admission) => {
        admitted = true;
        return admission;
      });
    await delay(40);
    assert.equal(admitted, false, "Both lanes are in use");
    await second.release();
    assert.equal((await third).lane, 1, "The third job takes the lane that became free");
    assert.equal(await ownerOf(stateRoot, 0), session("first"));
    await first.release();
    assert.equal(await lane.releaseNativeLane(stateRoot, session("third")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a prepared session uses only the lane of its connector port", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-port-lane-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const other = resolve(stateRoot, "other/studio"),
    prepared = resolve(stateRoot, "prepared/studio");
  try {
    assert.equal(studioLaneOfConnectorUrl("http://127.0.0.1:43124"), 1);
    assert.throws(() => studioLaneOfConnectorUrl("http://127.0.0.1:50000"), /Studio lane/);
    await lane.claimNativeLane(stateRoot, other, slots(1));
    // Lane 0 is free, but the place of this session reaches only the connector of lane 1.
    await assert.rejects(
      wait({ stateRoot, sessionDirectory: prepared, slots: slots(1), timeoutMs: 40, pollMs: 10 }),
      (error) =>
        error instanceof ExecutionFault && error.failure.causeCode === "studio_lane_wait_timeout",
    );
    await lane.releaseNativeLane(stateRoot, other);
    assert.equal(await lane.claimNativeLane(stateRoot, prepared, slots(1)), 1);
    // A second claim of the same session in this process keeps its lane.
    assert.equal(await lane.claimNativeLane(stateRoot, prepared, slots(1)), 1);
    await assert.rejects(
      lane.claimNativeLane(stateRoot, prepared, slots(0)),
      /differs from its connector port/,
    );
    await lane.releaseNativeLane(stateRoot, prepared);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dispatched owner of one lane is never displaced, and other lanes stay usable", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-uncertain-lane-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const dispatched = resolve(stateRoot, "dispatched/studio"),
    next = resolve(stateRoot, "next/studio");
  try {
    await mkdir(resolve(dispatched, "native"), { recursive: true });
    await lane.claimNativeLane(stateRoot, dispatched, slots(0));
    await writeFile(resolve(dispatched, "native/remote-job.json"), "{}");
    // The owner process is gone, but its job reached Studio. The result is uncertain.
    await writeFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), deadOwner(dispatched));
    assert.equal(await lane.claimNativeLane(stateRoot, next, slots(0, 1)), 1);
    assert.equal(await ownerOf(stateRoot, 0), dispatched);
    await lane.releaseNativeLane(stateRoot, next);
    await assert.rejects(
      lane.claimNativeLane(stateRoot, next, slots(0)),
      (error) => error instanceof lane.NativeLaneBusy,
    );
    // Finder metadata in the lane folder owns no lane.
    await writeFile(resolve(stateRoot, "native-worker/lanes/.DS_Store"), "");
    assert.equal(await lane.nativeLaneOf(stateRoot, dispatched), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session holds one lane: a dead, undispatched claim of the same session goes first", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-one-lane-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const session = resolve(stateRoot, "operation/studio");
  try {
    await mkdir(resolve(session, "native"), { recursive: true });
    // Process A claimed lane 1 for the unprepared session and died before preparation.
    await lane.claimNativeLane(stateRoot, session, slots(1));
    await writeFile(resolve(stateRoot, "native-worker/lanes/1/owner.json"), deadOwner(session, 1));
    // Process B resumes the same session and can use each lane.
    assert.equal(await lane.claimNativeLane(stateRoot, session, slots(0, 1)), 0);
    assert.equal(await lane.nativeLaneOf(stateRoot, session), 0);
    await assert.rejects(
      readFile(resolve(stateRoot, "native-worker/lanes/1/owner.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      "The dead claim of lane 1 is gone",
    );
    // A dead claim of the same session that reached Studio is uncertain, so no claim takes it.
    await writeFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), deadOwner(session));
    await writeFile(resolve(session, "native/remote-job.json"), "{}");
    await assert.rejects(
      lane.claimNativeLane(stateRoot, session, slots(0, 1)),
      (error) => error instanceof lane.NativeLaneBusy,
    );
    assert.equal(await lane.nativeLaneOf(stateRoot, session), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness takes a free lane at once and reports a busy Studio without a wait", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-readiness-lane-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const directory = (name: string) => resolve(stateRoot, `studio-readiness/${name}/studio`);
  try {
    await studioWorkers(root, [0, 1]);
    await lane.claimNativeLane(stateRoot, resolve(stateRoot, "other/studio"), slots(0));
    const busy = new lane.NativeLaneBusy(stateRoot);
    let refusals = 0;
    const refuse = async () => {
      refusals++;
      throw busy;
    };
    await mkdir(directory("free"), { recursive: true });
    const admission = await roomy.admit!({
      root,
      directory: directory("free"),
      purpose: "readiness",
      onWaiting: refuse,
    });
    assert.equal(admission.lane, 1, "Readiness is not limited to lane 0");
    assert.equal(refusals, 0, "A free lane admits readiness with no wait");
    await mkdir(directory("busy"), { recursive: true });
    // The wait calls onWaiting before its first sleep. Its refusal ends the wait there, so a
    // busy Studio gives an answer at once.
    await assert.rejects(
      roomy.admit!({
        root,
        directory: directory("busy"),
        purpose: "readiness",
        onWaiting: refuse,
      }),
      (error) => error === busy,
    );
    assert.equal(refusals, 1);
    await admission.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the holder of a lane renews its lease, and a renewal never changes another claim", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-lease-renewal-"));
  const stateRoot = resolve(root, ".basalt-evals");
  const session = resolve(stateRoot, "operations/held/studio"),
    other = resolve(stateRoot, "operations/other/studio");
  const owner = async () =>
    JSON.parse(await readFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), "utf8"));
  try {
    await lane.claimNativeLane(stateRoot, session, slots(0));
    const claimed = await owner();
    assert.equal(claimed.worker, "evals");
    assert.equal(claimed.leaseMs, lane.LANE_LEASE_MS);
    assert.equal(claimed.leaseMs, 3 * lane.LANE_RENEW_MS);
    assert.equal(claimed.renewedAt, claimed.claimedAt);
    await delay(5);
    assert.equal(await lane.renewNativeLane(stateRoot, session), true);
    const renewed = await owner();
    assert.ok(Date.parse(renewed.renewedAt) > Date.parse(claimed.renewedAt));
    assert.equal(renewed.claimedAt, claimed.claimedAt);
    assert.deepEqual(
      await readdir(resolve(stateRoot, "native-worker/lanes/0")),
      ["owner.json"],
      "The atomic replacement leaves no temporary file",
    );
    assert.equal(await lane.renewNativeLane(stateRoot, other), false);
    // The claim of another process stays as it is.
    await writeFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), deadOwner(session));
    const foreign = await owner();
    assert.equal(await lane.renewNativeLane(stateRoot, session), false);
    assert.deepEqual(await owner(), foreign);
    await lane.releaseNativeLane(stateRoot, session);
    await lane.claimNativeLane(stateRoot, session, slots(0));
    const before = await owner();
    const hold = lane.holdNativeLane(stateRoot, session, 20);
    // Wait for the first renewal of the hold. Only a stall of 30 s fails.
    const deadline = performance.now() + 30_000;
    while (Date.parse((await owner()).renewedAt) <= Date.parse(before.renewedAt)) {
      assert.ok(performance.now() < deadline, "The hold did not renew its lease within 30 s");
      await delay(10);
    }
    await hold.stop();
    assert.ok(Date.parse((await owner()).renewedAt) > Date.parse(before.renewedAt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
