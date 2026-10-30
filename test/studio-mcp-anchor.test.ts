import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { StudioMcpClient } from "../packages/studio-runner/src/studio-mcp.js";
import {
  holdStudioMcpAnchor,
  MCP_ANCHOR_DIRECTORY,
  runStudioMcpKeeper,
} from "../packages/studio-runner/src/studio-mcp-anchor.js";

/** Only the test process is alive. Each other process ID is gone. */
const startTime = async (pid: number) => (pid === process.pid ? "test process" : null);
const self = { pid: process.pid, processStartedAt: "test process" };

async function workspace(name: string) {
  return mkdtemp(resolve(tmpdir(), `basalt-mcp-anchor-${name}-`));
}

/** Wait for a condition. The bound only catches a stall. */
async function until(condition: () => Promise<boolean>, what: string) {
  const deadline = performance.now() + 30_000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`Stalled: ${what}`);
    await delay(20);
  }
}

const exists = (file: string) =>
  readFile(file).then(
    () => true,
    () => false,
  );

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * An offline StudioMCP. It writes its process ID to `pidFile`. After `answers` tools/list
 * requests it stops answering. No Roblox executable runs.
 */
function fakeStudioMcp(
  pidFile: string,
  answers = Infinity,
  made?: (client: StudioMcpClient) => void,
) {
  const source = `
    import readline from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    let listed = 0;
    const write = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') write(m.id, {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'offline',version:'test'}});
      else if (m.method === 'tools/list' && ++listed <= ${Number.isFinite(answers) ? answers : "Infinity"}) write(m.id, {tools:[]});
    });
  `;
  return () => {
    // A loaded host can start the fake process slowly, so the time limit is only a stall bound.
    const client = new StudioMcpClient(
      process.execPath,
      ["--input-type=module", "-e", source],
      30_000,
      {
        toolsMs: 1_000,
        studiosMs: 1_000,
        pollMs: 20,
      },
    );
    made?.(client);
    return client;
  };
}

/** A job holds the anchor before its keeper starts, as in the worker. */
async function holdBeforeKeeper(root: string) {
  const holder = resolve(root, MCP_ANCHOR_DIRECTORY, "holders", "job-a.json");
  await mkdir(resolve(root, MCP_ANCHOR_DIRECTORY, "holders"), { recursive: true });
  await writeFile(holder, JSON.stringify(self));
  return holder;
}

test("the first job starts the keeper, and a second job uses the same keeper", async () => {
  const root = await workspace("hold");
  try {
    let starts = 0;
    const keeperFile = resolve(root, MCP_ANCHOR_DIRECTORY, "keeper.json");
    const startKeeper = () => {
      starts += 1;
      void writeFile(keeperFile, JSON.stringify(self));
    };
    const first = await holdStudioMcpAnchor({
      directory: root,
      holderId: "job-a",
      startKeeper,
      startTime,
    });
    const second = await holdStudioMcpAnchor({
      directory: root,
      holderId: "job-b",
      startKeeper,
      startTime,
    });
    assert.equal(starts, 1);
    const holders = resolve(root, MCP_ANCHOR_DIRECTORY, "holders");
    assert.deepEqual((await readdir(holders)).sort(), ["job-a.json", "job-b.json"]);
    await first.release();
    await second.release();
    assert.deepEqual(await readdir(holders), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a job replaces a keeper whose process is gone, and fails if no keeper starts", async () => {
  const root = await workspace("stale");
  try {
    const keeperFile = resolve(root, MCP_ANCHOR_DIRECTORY, "keeper.json");
    await holdStudioMcpAnchor({
      directory: root,
      holderId: "job-a",
      startKeeper: () => void writeFile(keeperFile, JSON.stringify(self)),
      startTime,
    });
    // The keeper process is gone.
    await writeFile(keeperFile, JSON.stringify({ pid: 999_999, processStartedAt: "gone" }));
    let starts = 0;
    await holdStudioMcpAnchor({
      directory: root,
      holderId: "job-b",
      startKeeper: () => {
        starts += 1;
        void writeFile(keeperFile, JSON.stringify(self));
      },
      startTime,
    });
    assert.equal(starts, 1);
    await writeFile(keeperFile, JSON.stringify({ pid: 999_999, processStartedAt: "gone" }));
    await assert.rejects(
      holdStudioMcpAnchor({
        directory: root,
        holderId: "job-c",
        startKeeper: () => {},
        startTime,
        startWaitMs: 200,
      }),
      /could not start its Studio MCP anchor/,
    );
    const holders = await readdir(resolve(root, MCP_ANCHOR_DIRECTORY, "holders"));
    assert.ok(!holders.includes("job-c.json"), "A failed job does not hold the anchor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "the keeper holds its StudioMCP while a job holds the anchor, and stops it after the last release",
  { timeout: 60_000 },
  async () => {
    const root = await workspace("keeper");
    try {
      const pidFile = resolve(root, "studio-mcp.pid");
      const keeperFile = resolve(root, MCP_ANCHOR_DIRECTORY, "keeper.json");
      const holder = await holdBeforeKeeper(root);
      const keeper = runStudioMcpKeeper({
        directory: root,
        createClient: fakeStudioMcp(pidFile),
        startTime,
        idleMs: 300,
        pollMs: 20,
        healthMs: 50,
      });
      await until(() => exists(keeperFile), "the keeper record");
      const pid = Number(await readFile(pidFile, "utf8"));
      // The holder keeps the StudioMCP open for longer than the idle time.
      await delay(900);
      assert.ok(alive(pid), "The StudioMCP stays open while a job holds the anchor");
      assert.equal(
        await runStudioMcpKeeper({
          directory: root,
          createClient: fakeStudioMcp(pidFile),
          startTime,
        }),
        undefined,
        "A second keeper returns at once",
      );
      assert.equal(Number(await readFile(pidFile, "utf8")), pid, "No second StudioMCP started");
      await rm(holder);
      await keeper;
      assert.ok(!alive(pid), "The keeper stops its StudioMCP after the last release");
      assert.equal(await exists(keeperFile), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the keeper ends when its StudioMCP stops answering", { timeout: 60_000 }, async () => {
  const root = await workspace("health");
  try {
    const pidFile = resolve(root, "studio-mcp.pid");
    await holdBeforeKeeper(root);
    let client: StudioMcpClient | undefined;
    const keeper = runStudioMcpKeeper({
      directory: root,
      // The fake answers one health check, and then no request.
      createClient: fakeStudioMcp(pidFile, 1, (made) => (client = made)),
      startTime,
      idleMs: 60_000,
      pollMs: 20,
      healthMs: 50,
    });
    await until(() => exists(resolve(root, MCP_ANCHOR_DIRECTORY, "keeper.json")), "the keeper");
    // After the start, a short time limit shows the end of an unanswered health check.
    (client as unknown as { timeoutMs: number }).timeoutMs = 200;
    await assert.rejects(keeper, /timed out/);
    assert.equal(await exists(resolve(root, MCP_ANCHOR_DIRECTORY, "keeper.json")), false);
    assert.ok(!alive(Number(await readFile(pidFile, "utf8"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
