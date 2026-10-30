import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import * as lane from "../packages/studio-runner/src/native-lane.js";
import { assertStudioJobNotLost } from "../packages/studio-runner/src/isolated-user.js";
import { probeRemoteJob } from "../packages/studio-runner/src/workers.js";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import { contentHash } from "../packages/contracts/src/index.js";

const slots = (...lanes: number[]) => lanes.map((index) => ({ lane: index, worker: "evals" }));
const old = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString();
const remoteJob = {
  schema: "basalt-evals/remote-studio-job",
  user: "basalt-lease-test",
  remote: `/Users/basalt-lease-test/BasaltTrials/job-${"a".repeat(32)}/studio`,
};

/** A dispatched job on lane 0 whose claim belongs to `pid`, renewed `age` ms ago. */
async function dispatchedClaim(stateRoot: string, name: string, pid: number, age: number) {
  const session = resolve(stateRoot, `eval-operations/${name}/capture/cell/studio`);
  await mkdir(resolve(session, "native"), { recursive: true });
  await writeFile(resolve(session, "native/remote-job.json"), JSON.stringify(remoteJob));
  await mkdir(resolve(stateRoot, "native-worker/lanes/0"), { recursive: true });
  await writeFile(
    resolve(stateRoot, "native-worker/lanes/0/owner.json"),
    JSON.stringify({
      worker: "evals",
      pid,
      sessionDirectory: session,
      lane: 0,
      claimedAt: old(age),
      renewedAt: old(age),
      leaseMs: lane.LANE_LEASE_MS,
    }),
  );
  return session;
}

const owner = async (stateRoot: string) =>
  JSON.parse(await readFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), "utf8"));
const lost: lane.RemoteJobProbe = {
  leaseRenewedAt: old(120_000),
  processes: false,
  receipt: false,
};
const DEAD = 2147483647;

test("a dispatched owner with a live lease keeps its slot", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-lane-lease-live-"));
  const stateRoot = resolve(root, ".basalt-evals");
  try {
    let probes = 0;
    const probe = async () => {
      probes++;
      return lost;
    };
    // The controller process is gone, but it renewed the lease 10 seconds ago.
    const session = await dispatchedClaim(stateRoot, "fresh", DEAD, 10_000);
    assert.deepEqual(await lane.reclaimLostLanes(stateRoot, [0], probe), []);
    // The lease expired, but the controller process is alive.
    await dispatchedClaim(stateRoot, "alive", process.pid, 10 * lane.LANE_LEASE_MS);
    assert.deepEqual(await lane.reclaimLostLanes(stateRoot, [0], probe), []);
    assert.equal(probes, 0, "Basalt probes only a dead controller with an expired lease");
    assert.notEqual((await owner(stateRoot)).sessionDirectory, session);
    await assert.rejects(
      lane.claimNativeLane(stateRoot, resolve(stateRoot, "next/studio"), slots(0)),
      (error) => error instanceof lane.NativeLaneBusy,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed probe keeps the slot", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-lane-lease-probe-"));
  const stateRoot = resolve(root, ".basalt-evals");
  try {
    const session = await dispatchedClaim(stateRoot, "unknown", DEAD, 10 * lane.LANE_LEASE_MS);
    const before = await owner(stateRoot);
    assert.deepEqual(
      await lane.reclaimLostLanes(stateRoot, [0], async () => {
        throw new Error("ssh: connect to host 127.0.0.1 port 22: Connection refused");
      }),
      [],
    );
    assert.deepEqual(await owner(stateRoot), before);
    await assert.rejects(
      readFile(resolve(dirname(session), lane.LANE_RELEASE_FILE)),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    // A wait that probes and fails keeps waiting, and it never takes the slot.
    await assert.rejects(
      lane.waitForNativeLane({
        stateRoot,
        sessionDirectory: resolve(stateRoot, "next/studio"),
        slots: slots(0),
        probe: async () => {
          throw new Error("Probe failure");
        },
        timeoutMs: 40,
        pollMs: 10,
      }),
      (error) =>
        error instanceof ExecutionFault && error.failure.causeCode === "studio_lane_wait_timeout",
    );
    assert.deepEqual(await owner(stateRoot), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reclaim needs an expired lease and no job process", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-lane-lease-reclaim-"));
  const stateRoot = resolve(root, ".basalt-evals");
  try {
    const session = await dispatchedClaim(stateRoot, "lost", DEAD, 10 * lane.LANE_LEASE_MS);
    const before = await owner(stateRoot);
    for (const facts of [
      { ...lost, processes: true },
      { ...lost, receipt: true },
      { ...lost, leaseRenewedAt: old(5_000) },
    ]) {
      assert.deepEqual(await lane.reclaimLostLanes(stateRoot, [0], async () => facts), []);
      assert.deepEqual(await owner(stateRoot), before);
    }
    assert.equal(lane.remoteJobLost({ ...lost, leaseRenewedAt: null }, Date.now()), true);
    // The claim changes while the probe runs: the removal keeps the new claim.
    assert.deepEqual(
      await lane.reclaimLostLanes(stateRoot, [0], async () => {
        await writeFile(
          resolve(stateRoot, "native-worker/lanes/0/owner.json"),
          JSON.stringify({ ...before, renewedAt: new Date().toISOString() }),
        );
        return lost;
      }),
      [],
    );
    await writeFile(resolve(stateRoot, "native-worker/lanes/0/owner.json"), JSON.stringify(before));
    // The next job waits, probes the lost job and takes its slot.
    const next = resolve(stateRoot, "next/studio");
    const admission = await lane.waitForNativeLane({
      stateRoot,
      sessionDirectory: next,
      slots: slots(0),
      probe: async (claim) => {
        assert.equal(claim.sessionDirectory, session);
        return lost;
      },
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(admission.lane, 0);
    assert.equal((await owner(stateRoot)).sessionDirectory, next);
    const release = JSON.parse(
      await readFile(resolve(dirname(session), lane.LANE_RELEASE_FILE), "utf8"),
    );
    assert.equal(release.lane, 0);
    assert.equal(release.worker, "evals");
    assert.equal(
      release.remoteJobHash,
      contentHash(await readFile(resolve(session, "native/remote-job.json"))),
    );
    // Resume then records the lost job, without SSH.
    await assert.rejects(
      assertStudioJobNotLost(session),
      (error) => error instanceof ExecutionFault && error.failure.causeCode === "studio_job_lost",
    );
    await assertStudioJobNotLost(resolve(stateRoot, "other/studio"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the probe reads the remote lease, the receipt and the processes of the job", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-lane-lease-remote-"));
  const stateRoot = resolve(root, ".basalt-evals");
  try {
    const key = resolve(root, "key");
    await writeFile(key, "test key");
    await mkdir(resolve(stateRoot, "native-worker"), { recursive: true });
    await writeFile(
      resolve(stateRoot, "native-worker/workers.json"),
      JSON.stringify({
        schema: "basalt-evals/studio-workers",
        workers: [
          {
            id: "evals",
            user: remoteJob.user,
            sshKeyFile: key,
            nodeExecutable: process.execPath,
            lanes: [0],
            maxClients: 1,
            screenRecording: false,
          },
        ],
      }),
    );
    await dispatchedClaim(stateRoot, "probed", DEAD, 10 * lane.LANE_LEASE_MS);
    const claim = await owner(stateRoot);
    const folder = dirname(remoteJob.remote);
    const lease = JSON.stringify({
      workerPid: 400,
      workerPgid: 400,
      studioPids: [401],
      placeArgument: `${remoteJob.remote}/place.rbxl`,
      renewedAt: old(90_000),
    });
    const commands: string[] = [];
    const remote = (list: string) => async (_worker: unknown, command: string) => {
      commands.push(command);
      return command.startsWith("/bin/ps") ? list : `${remoteJob.user}\n502\nnone\n${lease}\n`;
    };
    const idle = await probeRemoteJob(
      root,
      claim,
      remote(`502 1 /sbin/launchd\n0 400 ${folder}/studio/place.rbxl\n`),
    );
    assert.deepEqual(idle, {
      leaseRenewedAt: JSON.parse(lease).renewedAt,
      processes: false,
      receipt: false,
    });
    assert.ok(
      commands
        .filter((command) => command.startsWith("/bin/ps"))
        .every((command) => !command.includes(folder)),
      "The process list never names the job folder in its own command line",
    );
    for (const list of [
      `502 400 /usr/bin/node worker-entry.mjs\n`,
      `502 77 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio --localPlaceFile ${folder}/studio/place.rbxl\n`,
    ])
      assert.equal((await probeRemoteJob(root, claim, remote(list))).processes, true);
    await assert.rejects(
      probeRemoteJob(root, { ...claim, worker: "other" }, remote("")),
      /different worker/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
