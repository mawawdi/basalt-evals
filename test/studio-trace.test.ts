import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createStudioTrace, MAX_TRACE_BYTES } from "../packages/studio-runner/src/trace.js";
import { readLatestStudioTrace } from "./studio-trace-reader.js";

const context = {
  id: "studio-test",
  token: "f".repeat(64),
  treatmentId: "treatment-test",
  candidateHash: "a".repeat(64),
  collectionPlanHash: "b".repeat(64),
  connectorSourceHash: "c".repeat(64),
  connectorArtifactHash: "d".repeat(64),
  expectedStudioVersion: "test",
  place: { file: "BasaltEval-0123456789abcdef0123.rbxlx", hash: "a".repeat(64) },
};
const clientId = "e".repeat(32);
const event = (sequence: number, trialId: string) => ({
  sequence,
  at: "2026-09-18T00:00:00.000Z",
  stage: "trial.failed",
  trialId,
  data: {
    error: `Argument 1 missing or nil\nstack: ExecutePlayModeAsync\nBearer ${context.token}`,
    key: "sk-test-1234567890123456",
  },
});

test("trial traces link Edit to Play, preserve stacks, redact secrets and deduplicate delivery", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-trace-"));
  const trace = await createStudioTrace(directory, context);
  try {
    const launch = trace.begin({ clientId, mode: "launch" });
    assert.equal(trace.begin({ clientId, mode: "capture" }), launch);
    const next = trace.begin({ clientId, mode: "capture" });
    assert.notEqual(next, launch, "A fresh Play trial cannot reuse a claimed launch");
    trace.plugin({ clientId, events: [event(1, launch)] });
    trace.plugin({ clientId, events: [event(1, launch), event(2, next)] });
    const failedLaunch = trace.begin({ clientId, mode: "launch" });
    trace.plugin({ clientId, events: [event(3, failedLaunch)] });
    assert.notEqual(
      trace.begin({ clientId, mode: "capture" }),
      failedLaunch,
      "Failed launches must not bind later F5 trials",
    );
    const stale = trace.begin({ clientId, mode: "launch" });
    t.mock.method(Date, "now", () => new Date("2099-01-01T00:00:00Z").valueOf());
    assert.notEqual(
      trace.begin({ clientId, mode: "capture" }),
      stale,
      "Expired launches must not bind unrelated Play clients",
    );
    t.mock.restoreAll();
    trace.close();
    const saved = await readLatestStudioTrace(directory);
    assert.equal(saved.file, trace.file);
    assert.ok(
      !saved.text.includes(context.token) && !saved.text.includes("sk-test-1234567890123456"),
    );
    const lines = saved.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.sequence),
      lines.map((_, index) => index + 1),
    );
    const plugin = lines.filter((line) => line.source === "plugin");
    assert.deepEqual(
      plugin.map((line) => line.client.sequence),
      [1, 2, 3],
    );
    assert.match(plugin[0].data.error, /Argument 1 missing or nil\nstack: ExecutePlayModeAsync/);
    assert.equal(lines[0].data.connectorArtifactHash, context.connectorArtifactHash);
    assert.equal(lines.at(-1).stage, "server.stopped");
    assert.equal((await stat(trace.file)).mode & 0o777, 0o600);
    const restarted = await createStudioTrace(directory, context);
    restarted.close();
    assert.notEqual(restarted.file, trace.file);
    assert.equal((await readLatestStudioTrace(directory)).file, restarted.file);
    assert.equal((await readdir(resolve(directory, "traces"))).length, 2);
    assert.equal(
      await readFile(trace.file, "utf8"),
      saved.text,
      "Restart cannot overwrite a previous trial log",
    );
  } finally {
    trace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trace ingestion rejects malformed batches atomically and cannot follow unsafe paths", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-trace-bounds-"));
  const trace = await createStudioTrace(directory, context);
  try {
    const trialId = trace.begin({ clientId, mode: "capture" });
    for (const bad of [
      { clientId, events: [event(1, trialId), { ...event(2, trialId), extra: "unknown" }] },
      { clientId, events: [event(1, "../escape")] },
      { clientId, events: [event(1, trialId), event(1, trialId)] },
      { clientId, events: [{ ...event(1, trialId), data: { value: { nested: true } } }] },
      { clientId, events: [{ ...event(1, trialId), data: { error: "x".repeat(4097) } }] },
      { clientId: "invalid", events: [event(1, trialId)] },
      { clientId, events: Array.from({ length: 17 }, (_, i) => event(i + 1, trialId)) },
    ])
      assert.throws(() => trace.plugin(bad), /Invalid/);
    assert.throws(() => trace.begin({ clientId, mode: "arbitrary", path: "../escape" }), /Invalid/);
    assert.ok(!(await readFile(trace.file, "utf8")).includes('"source":"plugin"'));
    const escaped = resolve(directory, "escaped");
    await mkdir(escaped);
    const session = resolve(directory, "symlink-session");
    await mkdir(session);
    await symlink(escaped, resolve(session, "traces"));
    await assert.rejects(createStudioTrace(session, context), /directory|symlink/);
    assert.deepEqual(await readdir(escaped), []);
  } finally {
    trace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trace output is bounded and failures do not throw into evidence operations", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-trace-limit-"));
  const trace = await createStudioTrace(directory, context);
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => {
    warnings.push(text);
    return true;
  });
  try {
    for (let index = 0; index * 4096 < MAX_TRACE_BYTES + 4 * 4096; index++)
      trace.host("test.event", { detail: "x".repeat(4096) });
    assert.equal(trace.host("after.limit"), false);
    trace.close();
    assert.ok((await stat(trace.file)).size <= MAX_TRACE_BYTES);
    assert.match(await readFile(trace.file, "utf8"), /trace.limit_reached/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /reached its size limit of 32 MiB/);
  } finally {
    trace.close();
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
