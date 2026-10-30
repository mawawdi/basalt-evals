import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  isolatedWorkerArtifactPaths,
  importSignedWorkerArtifact,
  isolatedArtifactBatches,
  isolatedBatchScript,
  awaitNativeCancellation,
} from "../packages/studio-runner/src/isolated-user.js";
import {
  readStudioWorkers,
  studioMaxClients,
  studioSlots,
  workerOfLane,
} from "../packages/studio-runner/src/workers.js";
import {
  claimNativeLane,
  NativeLaneBusy,
  releaseNativeLane,
} from "../packages/studio-runner/src/native-lane.js";
import { localReadiness } from "../packages/operator/src/workbench.js";
import { contentHash } from "../packages/contracts/src/index.js";
import type { SignedWorkerManifest } from "../packages/studio-runner/src/native-worker.js";

test("the Studio workers file is explicit, bounded, and rejects shell-unsafe users", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-workers-"));
  try {
    await assert.rejects(readStudioWorkers(root), /cannot find the Studio workers file/);
    const directory = resolve(root, ".basalt-evals/native-worker");
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, "workers.json");
    const key = resolve(root, "id_ed25519");
    await writeFile(key, "test key");
    const worker = {
      id: "evals",
      user: "evals",
      sshKeyFile: key,
      nodeExecutable: process.execPath,
      lanes: [0],
      maxClients: 2,
      screenRecording: false,
    };
    const save = (workers: unknown[]) =>
      writeFile(file, JSON.stringify({ schema: "basalt-evals/studio-workers", workers }));
    await save([worker]);
    assert.deepEqual(await readStudioWorkers(root), [worker]);
    await save([worker, { ...worker, id: "second", user: "evals2", lanes: [3, 1] }]);
    const workers = await readStudioWorkers(root);
    assert.deepEqual(studioSlots(workers), [
      { lane: 0, worker: "evals" },
      { lane: 1, worker: "second" },
      { lane: 3, worker: "second" },
    ]);
    assert.equal(workerOfLane(workers, 3).id, "second");
    assert.throws(() => workerOfLane(workers, 2), /lane 2 has no worker/);
    const invalid: Array<[unknown[], RegExp]> = [
      [[worker, { ...worker, id: "second", user: "evals2" }], /Lane 0 belongs to more than one/],
      [[worker, { ...worker, id: "second", lanes: [1] }], /evals belongs to more than one worker/],
      [[worker, { ...worker, lanes: [1] }], /id evals is used two times/],
      [[{ ...worker, lanes: [] }], /one or more lanes/],
      [[{ ...worker, lanes: [4] }], /one or more lanes/],
      [[{ ...worker, lanes: [1.5] }], /one or more lanes/],
      [[{ ...worker, maxClients: 0 }], /maxClients of evals must be from 1 to 8/],
      [[{ ...worker, maxClients: 9 }], /maxClients of evals must be from 1 to 8/],
      [[{ ...worker, maxClients: "2" }], /maxClients of evals must be from 1 to 8/],
      [[{ ...worker, screenRecording: "yes" }], /screenRecording of evals/],
      [[{ ...worker, user: "evals;rm -rf /" }], /valid macOS account name/],
      [[{ ...worker, nodeExecutable: "node" }], /absolute nodeExecutable/],
      [[{ ...worker, extra: true }], /needs exactly these fields/],
      [[], /from 1 to 4 workers/],
    ];
    for (const [workers, pattern] of invalid) {
      await save(workers);
      await assert.rejects(readStudioWorkers(root), pattern);
    }
    await save([{ ...worker, user: userInfo().username }]);
    await assert.rejects(readStudioWorkers(root), /uses this macOS account/);
    await writeFile(file, JSON.stringify({ schema: "basalt-evals/isolated-studio-user" }));
    await assert.rejects(readStudioWorkers(root), /Studio workers file is not valid/);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readStudioWorkers(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan can have at most the smallest maxClients of the workers", () => {
  const worker = (id: string, maxClients: number) => ({
    id,
    lanes: [0],
    maxClients,
    captureMethod: "studio_mcp_screenshot" as const,
    screenRecording: false,
    templateHash: null,
  });
  const host = { osVersion: "26.0", osBuild: "test", hardwareModel: "test", gpus: [] };
  assert.equal(studioMaxClients({ host, workers: [worker("a", 8)] }), 8);
  assert.equal(studioMaxClients({ host, workers: [worker("a", 8), worker("b", 3)] }), 3);
});

test("setup readiness names the cause of an isolated account problem", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-readiness-"));
  const check = async (name: string) => {
    const item = (await localReadiness(root)).find((entry) => entry.name === name)!;
    assert.equal(item.ready, false);
    return item.help;
  };
  try {
    assert.match(await check("Isolated Studio account"), /cannot find the Studio workers file/);
    assert.match(
      await check("Evidence signing key"),
      /cannot find the public key of the isolated Studio account at .*isolated-public-key\.pem\. Follow the native execution setup/,
    );
    const directory = resolve(root, ".basalt-evals/native-worker");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "workers.json"), JSON.stringify({ user: "evals" }));
    assert.match(await check("Isolated Studio account"), /Studio workers file is not valid/);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writeFile(
      resolve(directory, "isolated-public-key.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
    );
    assert.match(await check("Evidence signing key"), /is not an Ed25519 key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated transfer accepts only bounded signed artifact paths", () => {
  const receipt = {
    manifest: {
      schema: "basalt-evals/native-worker",
      artifacts: [{ file: "captures/abc.image", bytes: 3, hash: "a".repeat(64) }],
    },
  } as SignedWorkerManifest;
  assert.deepEqual(isolatedWorkerArtifactPaths(receipt), ["captures/abc.image"]);
  receipt.manifest.artifacts[0]!.file = "../outside";
  assert.throws(() => isolatedWorkerArtifactPaths(receipt), /Invalid isolated worker artifact/);
  receipt.manifest.artifacts[0]!.file = "native/$(touch x)";
  assert.throws(() => isolatedWorkerArtifactPaths(receipt), /Invalid isolated worker artifact/);
  receipt.manifest.artifacts[0]!.file = "captures/abc.image";
  receipt.manifest.artifacts.push({ ...receipt.manifest.artifacts[0]! });
  assert.throws(() => isolatedWorkerArtifactPaths(receipt), /Invalid isolated worker artifact/);
});

test("signed worker import preserves matching prepared input and rejects changed bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-worker-import-"));
  const staging = resolve(root, "staging");
  const session = resolve(root, "session");
  const artifact = { file: "sequence.json", bytes: 6, hash: contentHash("frozen") };
  try {
    await mkdir(staging);
    await mkdir(session);
    await writeFile(resolve(staging, artifact.file), "frozen");
    await importSignedWorkerArtifact(staging, session, artifact);
    await importSignedWorkerArtifact(staging, session, artifact);
    assert.equal(await readFile(resolve(session, artifact.file), "utf8"), "frozen");
    await writeFile(resolve(session, artifact.file), "edited");
    await assert.rejects(
      importSignedWorkerArtifact(staging, session, artifact),
      /differs from signed worker output/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long recordings transfer exact signed membership in bounded directory batches", () => {
  const paths = Array.from(
    { length: 1180 },
    (_, i) => `native/sequence/play/frame-${String(i + 1).padStart(4, "0")}.png`,
  );
  paths.push("native/sequence/other/frame-0001.png", "session.json");
  const receipt = {
    manifest: {
      schema: "basalt-evals/native-worker",
      artifacts: paths.map((file) => ({ file, bytes: 100, hash: "a".repeat(64) })),
    },
  } as SignedWorkerManifest;
  const batches = isolatedArtifactBatches(receipt);
  assert.equal(batches.length, 21);
  assert.deepEqual(
    batches.flatMap((batch) => batch.files),
    paths,
  );
  assert.ok(batches.every((batch) => batch.files.length <= 64));
  assert.equal(batches.at(-2)!.directory, "native/sequence/other");
  const script = isolatedBatchScript(
    batches[0]!.files,
    "/Users/evals/job/studio",
    '/Users/local/a "quoted" workspace',
  );
  assert.equal(script.trim().split("\n").length, 64);
  assert.ok(
    script.startsWith(
      'get "/Users/evals/job/studio/native/sequence/play/frame-0001.png" "/Users/local/a \\"quoted\\" workspace/native/sequence/play/frame-0001.png"',
    ),
  );
  assert.throws(() => isolatedBatchScript(["../escape"], "/remote", "/local"), /Invalid signed/);
  assert.throws(
    () => isolatedBatchScript(["frame.png"], "/remote", "/local\nquit"),
    /Invalid SFTP/,
  );
});

test("Stop recovers a delayed receipt with a fresh signal and preserves uncertainty on failure", async () => {
  const original = AbortSignal.abort();
  let reads = 0,
    checks = 0;
  assert.equal(
    await awaitNativeCancellation({
      cancel: async (signal) => {
        assert.notEqual(signal, original);
        assert.equal(signal.aborted, false);
      },
      ready: async () => ++checks > 1,
      read: async (signal) => {
        assert.equal(signal.aborted, false);
        reads++;
        return "signed terminal receipt";
      },
    }),
    "signed terminal receipt",
  );
  assert.equal(reads, 1);
  const controller = new AbortController();
  await assert.rejects(
    awaitNativeCancellation({
      cancel: async () => {},
      ready: async () => {
        controller.abort();
        return false;
      },
      read: async () => {
        reads++;
      },
      recoverySignal: controller.signal,
    }),
    /cannot confirm that Studio stopped/,
  );
  assert.equal(reads, 1);
});

test("repeated native reconciliation cannot remove a newer trial's lane", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-lane-"));
  const state = resolve(root, ".basalt-evals");
  try {
    await claimNativeLane(state, "first", [{ lane: 0, worker: "evals" }]);
    await assert.rejects(
      claimNativeLane(state, "second", [{ lane: 0, worker: "evals" }]),
      (error) => error instanceof NativeLaneBusy && error.failure.causeCode === "studio_lane_busy",
    );
    assert.equal(await releaseNativeLane(state, "other"), false);
    assert.equal(await releaseNativeLane(state, "first"), true);
    await claimNativeLane(state, "second", [{ lane: 0, worker: "evals" }]);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => releaseNativeLane(state, "first")),
    );
    assert.ok(results.every((released) => !released));
    assert.equal(
      JSON.parse(await readFile(resolve(state, "native-worker/lanes/0/owner.json"), "utf8"))
        .sessionDirectory,
      "second",
    );
    assert.equal(await releaseNativeLane(state, "second"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead native owner is reclaimable only before remote dispatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-undispatched-lane-"));
  const state = resolve(root, ".basalt-evals"),
    session = resolve(state, "session");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((done, fail) => {
    child.once("exit", () => done());
    child.once("error", fail);
  });
  try {
    await mkdir(resolve(session, "native"), { recursive: true });
    await claimNativeLane(state, session, [{ lane: 0, worker: "evals" }]);
    const ownerFile = resolve(state, "native-worker/lanes/0/owner.json");
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    await writeFile(ownerFile, JSON.stringify({ ...owner, pid: child.pid }));
    await writeFile(resolve(session, "native/remote-job.json"), "{}");
    await assert.rejects(
      claimNativeLane(state, session, [{ lane: 0, worker: "evals" }]),
      (error) => error instanceof NativeLaneBusy && error.failure.causeCode === "studio_lane_busy",
    );
    await rm(resolve(session, "native/remote-job.json"));
    assert.equal(await claimNativeLane(state, session, [{ lane: 0, worker: "evals" }]), 0);
    assert.equal(JSON.parse(await readFile(ownerFile, "utf8")).pid, process.pid);
    await releaseNativeLane(state, session);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
