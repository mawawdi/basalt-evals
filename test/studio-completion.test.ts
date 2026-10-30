import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PNG } from "pngjs";
import {
  recordStudioSequence,
  STUDIO_MCP_DISCOVERY_WAITS,
  StudioMcpRequestTimeout,
  type StudioMcpClient,
} from "../packages/studio-runner/src/studio-mcp.js";

const sessionId = "studio-0123456789abcdef0123";
const scenarioId = "observed-scenario";
const disconnected =
  "No Roblox Studio instances are connected. Ask the user to confirm that Studio is running with a place open and the MCP server enabled in Assistant settings.";
const image = PNG.sync.write(new PNG({ width: 32, height: 24 }));
function receipt(overrides = {}) {
  return {
    sessionId,
    scenarioId,
    trialId: "trial-" + "a".repeat(24),
    runtimeHash: "b".repeat(64),
    completedAt: new Date().toISOString(),
    generation: 1,
    ...overrides,
  };
}
class CaptureFixture {
  readonly discoveryWaits = STUDIO_MCP_DISCOVERY_WAITS;
  transcript: unknown[] = [];
  calls = 0;
  closed = false;
  stamp = "";
  constructor(
    readonly completion: AbortController,
    readonly mode:
      | "after"
      | "drain"
      | "short"
      | "unanswered"
      | "exited"
      | "early-answer"
      | "stamped"
      | "stamped-frame"
      | "before"
      | "stalled"
      | "invalid",
  ) {}
  async connect() {}
  private rejectClosing: (error: Error) => void = () => undefined;
  readonly closing = new Promise<never>((_resolve, reject) => {
    this.rejectClosing = reject;
  });
  close() {
    this.closed = true;
    // Only the "exited" request waits on this promise. Other modes ignore the rejection.
    this.closing.catch(() => undefined);
    this.rejectClosing(new Error("Studio MCP closed"));
  }
  async request(method: string, parameters: unknown): Promise<unknown> {
    const params = parameters as Record<string, unknown>;
    this.transcript.push({ method, name: params.name });
    if (method === "tools/list")
      return {
        tools: ["list_roblox_studios", "get_studio_state", "execute_luau", "screen_capture"].map(
          (name) => ({
            name,
            inputSchema: {
              type: "object",
              properties: {
                studio_id: { type: "string" },
                capture_id: { type: "string" },
                code: { type: "string" },
                datamodel_type: { type: "string", enum: ["Edit", "Client", "Server"] },
              },
              required:
                name === "list_roblox_studios"
                  ? []
                  : [
                      "studio_id",
                      ...(name === "screen_capture" ? ["capture_id"] : []),
                      ...(name === "execute_luau" ? ["code", "datamodel_type"] : []),
                    ],
            },
          }),
        ),
      };
    assert.equal(method, "tools/call");
    if (params.name === "list_roblox_studios")
      return {
        content: [{ type: "text", text: JSON.stringify([{ id: "owned-client", name: null }]) }],
      };
    if (params.name === "get_studio_state")
      return {
        content: [
          { type: "text", text: "Current Studio Mode: Play\nAvailable DataModels: Client" },
        ],
      };
    const args = params.arguments as Record<string, unknown>;
    if (params.name === "execute_luau") {
      assert.equal(typeof args.code, "string");
      const nonce = /BASALT_ACTOR_([a-f0-9]{24})=/.exec(args.code as string)![1];
      const clocks = `:${(Date.now() / 1000).toFixed(6)}:${(Date.now() / 1000).toFixed(3)}`;
      return {
        content: [{ type: "text", text: "BASALT_ACTOR_" + nonce + "=-1:" + sessionId + clocks }],
      };
    }
    assert.equal(params.name, "screen_capture");
    const call = ++this.calls;
    if (this.mode === "short" && call > 1) {
      // Only the first frame exists. A loaded host can issue more requests before the completion
      // arrives. Each one ends unanswered at the Play teardown, so no actor gets a second frame.
      if (!this.completion.signal.aborted)
        await new Promise((done) =>
          this.completion.signal.addEventListener("abort", done, { once: true }),
        );
      throw new StudioMcpRequestTimeout("tools/call", 100);
    }
    if (this.mode === "early-answer") {
      // The host stamps completion after the third frame. The fourth request starts later, and
      // its answer arrives before the completion reaches the recorder.
      if (this.calls === 3) this.stamp = new Date().toISOString();
      if (this.calls === 4)
        setTimeout(() => this.completion.abort(receipt({ completedAt: this.stamp })), 50);
      return {
        content: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
      };
    }
    if (this.calls === 4) {
      if (this.mode === "stamped" || this.mode === "stamped-frame") {
        // The host stamps completion just before this request but delivers it afterwards.
        const stamped = new Date(Date.now() - 5).toISOString();
        await delay(50);
        this.completion.abort(receipt({ completedAt: stamped }));
        await delay(100);
        if (this.mode === "stamped") throw new StudioMcpRequestTimeout("tools/call", 100);
        return {
          content: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
        };
      }
      if (
        this.mode === "after" ||
        this.mode === "drain" ||
        this.mode === "unanswered" ||
        this.mode === "exited"
      ) {
        await delay(50);
        this.completion.abort(receipt());
        await delay(100);
        if (this.mode === "drain")
          return {
            content: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
          };
        if (this.mode === "unanswered") throw new StudioMcpRequestTimeout("tools/call", 100);
        // Studio quit after its completion. Only a closed client ends this request.
        if (this.mode === "exited") return this.closing;
      } else if (this.mode === "stalled") throw new StudioMcpRequestTimeout("tools/call", 100);
      else if (this.mode === "invalid")
        this.completion.abort(receipt({ scenarioId: "different-scenario" }));
      return { isError: true, content: [{ type: "text", text: disconnected }] };
    }
    return { content: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] };
  }
}

test("bound scenario completion stops admission and drains a pending teardown capture", async () => {
  for (const mode of ["after", "drain", "unanswered", "stamped", "stamped-frame"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-completion-drain-"));
    const completion = new AbortController();
    const fixture = new CaptureFixture(completion, mode);
    const failures: string[] = [];
    try {
      const input = {
        placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
        sessionId,
        directory: resolve(root, "sequence"),
        expectedClients: 1,
        signal: new AbortController().signal,
        completion: { scenarioId, signal: completion.signal },
        createClient: () => fixture as unknown as StudioMcpClient,
        onFailure: (reason: string) => failures.push(reason),
      };
      const result = await recordStudioSequence(input);
      assert.equal(result.status, "complete", result.reason ?? "");
      assert.equal(
        result.frames.length,
        mode === "drain" ? 4 : 3,
        "A frame requested after the bound completion time is outside the recording",
      );
      assert.equal(fixture.calls, 4, "No screenshot may be issued after bound completion");
      assert.deepEqual(failures, []);
      assert.ok(fixture.closed);
      for (const frame of result.frames)
        assert.ok((await readFile(resolve(root, "sequence", frame.file))).length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a frame that started after the bound completion stays out, even if it arrived first", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-completion-early-"));
  const completion = new AbortController();
  const fixture = new CaptureFixture(completion, "early-answer");
  try {
    const result = await recordStudioSequence({
      placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      signal: new AbortController().signal,
      completion: { scenarioId, signal: completion.signal },
      createClient: () => fixture as unknown as StudioMcpClient,
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.equal(fixture.calls, 4);
    assert.equal(result.frames.length, 3, "The fourth frame lies outside the recording");
    for (const frame of result.frames)
      assert.ok(Date.parse(frame.startedAt) <= Date.parse(fixture.stamp));
    // The removed frame leaves no file beside the recorded frames.
    const files = (await readdir(resolve(root, "sequence"))).filter((file) =>
      file.startsWith("frame-"),
    );
    assert.deepEqual(files.sort(), result.frames.map((frame) => frame.file).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after a bound completion, a Studio exit ends an unanswered request at once", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-completion-exit-"));
  const completion = new AbortController();
  const studioExit = new AbortController();
  const fixture = new CaptureFixture(completion, "exited");
  try {
    const recording = recordStudioSequence({
      placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      signal: new AbortController().signal,
      completion: { scenarioId, signal: completion.signal },
      studioExited: studioExit.signal,
      createClient: () => fixture as unknown as StudioMcpClient,
    });
    while (!completion.signal.aborted) await delay(10);
    const exitedAt = performance.now();
    studioExit.abort();
    const result = await recording;
    assert.ok(performance.now() - exitedAt < 1_000, "The recorder does not wait for the bound");
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.equal(result.frames.length, 3);
    assert.ok(fixture.closed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bound completion cannot turn insufficient actor coverage or a hard Stop into success", async () => {
  for (const stop of [false, true]) {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-completion-short-"));
    const completion = new AbortController(),
      abort = new AbortController();
    const fixture = new CaptureFixture(completion, "short");
    let readyCount = 0;
    try {
      const result = await recordStudioSequence({
        placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
        sessionId,
        directory: resolve(root, "sequence"),
        expectedClients: 1,
        signal: abort.signal,
        completion: { scenarioId, signal: completion.signal },
        createClient: () => fixture as unknown as StudioMcpClient,
        onReady: () => {
          readyCount++;
          completion.abort(receipt());
          if (stop) abort.abort();
        },
      });
      assert.equal(result.status, "incomplete");
      assert.equal(
        result.reason,
        stop ? "This operation was aborted" : "Sequence ended before every actor had two frames",
      );
      assert.equal(readyCount, 1);
      assert.equal(result.frames.length, 1);
      assert.ok(fixture.closed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("disconnect or timeout before completion and a wrong-scenario completion stay incomplete", async () => {
  for (const mode of ["before", "stalled", "invalid"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-completion-reject-"));
    const completion = new AbortController();
    const abort = new AbortController();
    const failures: string[] = [];
    const fixture = new CaptureFixture(completion, mode);
    try {
      const input = {
        placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
        sessionId,
        directory: resolve(root, "sequence"),
        expectedClients: 1,
        signal: abort.signal,
        completion: { scenarioId, signal: completion.signal },
        createClient: () => fixture as unknown as StudioMcpClient,
        onFailure: (reason: string) => {
          failures.push(reason);
          abort.abort();
        },
      };
      const result = await recordStudioSequence(input);
      completion.abort(receipt());
      assert.equal(result.status, "incomplete");
      assert.equal(result.frames.length, 3);
      assert.equal(failures.length, 1);
      assert.ok(fixture.closed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
