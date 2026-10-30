import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  requestNativeCancellation,
  watchNativeCancellation,
} from "../packages/studio-runner/src/cancellation.js";
import { runNativeProcess } from "../packages/studio-runner/src/native-worker.js";

test("a durable session-specific cancellation stops only its owned subprocess and survives watcher restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-native-cancellation-"));
  const other = join(root, "other"),
    logs = join(root, "logs");
  await mkdir(other);
  await mkdir(logs);
  await writeFile(join(root, "session.json"), '{"frozen":"one"}');
  await writeFile(join(other, "session.json"), '{"frozen":"two"}');
  const watch = await watchNativeCancellation(root),
    untouched = await watchNativeCancellation(other);
  try {
    const running = runNativeProcess({
      command: process.execPath,
      args: ["-e", "console.log('started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      directory: logs,
      // The cancellation below ends the process. This bound must outlast the start wait.
      timeoutMs: 60_000,
      signal: watch.signal,
    });
    // Node can take seconds to start on a loaded machine, so only a stall of 30 s fails.
    const deadline = performance.now() + 30_000;
    while (
      !(await readFile(join(logs, "process.log"), "utf8").catch(() => "")).includes("started")
    ) {
      assert.ok(performance.now() < deadline, "The owned process did not start within 30 s");
      await delay(20);
    }
    await requestNativeCancellation(root);
    const first = await readFile(join(root, "cancel.json"));
    await requestNativeCancellation(root);
    assert.deepEqual(await readFile(join(root, "cancel.json")), first);
    const result = await running;
    assert.equal(result.reason, "aborted");
    assert.ok(result.pid);
    assert.throws(() => process.kill(result.pid!, 0), /ESRCH/);
    assert.equal(untouched.signal.aborted, false);
    const restored = await watchNativeCancellation(root);
    try {
      assert.equal(restored.signal.aborted, true);
      const never = join(root, "never");
      await mkdir(never);
      assert.equal(
        (
          await runNativeProcess({
            command: process.execPath,
            args: ["-e", "throw new Error('must not dispatch')"],
            directory: never,
            timeoutMs: 10000,
            signal: restored.signal,
          })
        ).pid,
        null,
      );
    } finally {
      restored.close();
    }
    await writeFile(join(root, "session.json"), '{"frozen":"changed"}');
    await assert.rejects(requestNativeCancellation(root), /different prepared session/);
    assert.deepEqual(await readFile(join(root, "cancel.json")), first);
  } finally {
    watch.close();
    untouched.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe or misbound cancellation fails closed without replacing existing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-native-cancel-binding-"));
  try {
    await writeFile(join(root, "session.json"), "{}");
    await writeFile(join(root, "foreign.json"), "{}");
    await symlink(join(root, "foreign.json"), join(root, "cancel.json"));
    await assert.rejects(requestNativeCancellation(root));
    const unsafe = await watchNativeCancellation(root);
    assert.equal(unsafe.signal.aborted, true);
    unsafe.close();
    assert.equal(await readFile(join(root, "foreign.json"), "utf8"), "{}");
    await rm(join(root, "cancel.json"));
    await writeFile(join(root, "cancel.json"), "{}");
    const mismatched = await watchNativeCancellation(root);
    assert.equal(mismatched.signal.aborted, true);
    assert.match(String(mismatched.signal.reason), /different prepared session/);
    mismatched.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
