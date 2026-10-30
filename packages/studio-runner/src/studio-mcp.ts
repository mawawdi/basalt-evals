import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  contentHash,
  MAX_CAPTURE_BYTES,
  MAX_SEQUENCE_FRAMES,
  MAX_STUDIO_CLIENTS,
  SEQUENCE_SAMPLE_INTERVAL_MS,
} from "../../contracts/src/index.js";
import { decodeCaptureImage, type CaptureMediaType } from "./images.js";
import { SequenceFrameStore } from "./sequence-frames.js";

const STUDIO_MCP = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const PROTOCOL = "2025-11-25";
const MAX_MESSAGE = 24 * 1024 * 1024;
const MAX_CAPTURE_REQUESTS_PER_ACTOR = 3;
const MAX_ABANDONED_REQUESTS = 64;
type ObjectValue = Record<string, unknown>;
const RUN_IDENTITY_NAME = "BasaltEvalRunIdentity";

// A clock probe reads the identity, the Studio clock of the client
// (workspace:GetServerTimeNow) and the local clock of the client process.
const CLOCK_PROBE_INTERVAL_MS = 5_000;

function identityCode(nonce: string): string {
  return `local p = game:GetService("Players").LocalPlayer; if not p then error("no local player") end; local m = game:GetService("ReplicatedStorage"):FindFirstChild("${RUN_IDENTITY_NAME}"); if not m or not m:IsA("StringValue") then error("no Basalt run marker") end; local s = workspace:GetServerTimeNow(); local c = DateTime.now().UnixTimestampMillis / 1000; return "BASALT_ACTOR_${nonce}=" .. tostring(p.UserId) .. ":" .. m.Value .. ":" .. string.format("%.6f", s) .. ":" .. string.format("%.3f", c)`;
}

interface ViewportImage {
  bytes: Buffer;
  mediaType: CaptureMediaType;
}
export interface ViewportCapture {
  check(directory: string): Promise<void>;
  capture(directory: string): Promise<ViewportImage>;
  close(): void;
}

export interface SequenceFrame {
  file: string;
  hash: string;
  bytes: number;
  mediaType: CaptureMediaType;
  width: number;
  height: number;
  playerUserId: number;
  studioId: string;
  startedAt: string;
  endedAt: string;
}

/**
 * One host-bracketed read of the clocks of one Play client. The host records the times
 * before the request and after the response. The client returns its Studio clock and
 * its local clock, in epoch seconds.
 */
export interface SequenceClockProbe {
  playerUserId: number;
  studioId: string;
  hostSentAt: string;
  hostReceivedAt: string;
  /** workspace:GetServerTimeNow in the client. The scenario runner uses this clock. */
  serverTime: number;
  /** DateTime.now in the client process. */
  clientTime: number;
}

export interface SequenceAcquisition {
  schema: "basalt-evals/sequence-acquisition";
  placeFile: string;
  startedAt: string;
  endedAt: string;
  expectedClients: number;
  status: "complete" | "incomplete";
  reason: string | null;
  frames: SequenceFrame[];
  clockProbes: SequenceClockProbe[];
}

/** Upper bound for one Studio MCP request, including a screenshot already issued. */
export const STUDIO_MCP_REQUEST_TIMEOUT_MS = 15_000;

/** The discovery waits of a Studio MCP client. Studio attaches to a new proxy after the proxy starts. */
interface StudioMcpDiscoveryWaits {
  /** The time for Studio to advertise the capture tools. */
  toolsMs: number;
  /** The time for the prepared place to appear in the Studio list. */
  studiosMs: number;
  /** The time between two discovery requests. */
  pollMs: number;
}

export const STUDIO_MCP_DISCOVERY_WAITS: StudioMcpDiscoveryWaits = {
  toolsMs: 8_000,
  studiosMs: 10_000,
  pollMs: 500,
};

/** A Studio MCP request that received no response within its bound. */
export class StudioMcpRequestTimeout extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`The Studio MCP request ${method} timed out after ${timeoutMs} ms.`);
  }
}

export interface StudioScenarioCompletion {
  sessionId: string;
  trialId: string;
  scenarioId: string;
  runtimeHash: string;
  completedAt: string;
  generation: number;
}

function targetClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(Target is closed \(HOST_INVOKE_ScreenCaptureTool_CaptureScreen_ToRequester, Client\)|Place is not open)/.test(
      error.message,
    )
  );
}

function captureStoppedWithScenario(error: unknown, completed: boolean): boolean {
  // Play teardown may close the target or leave an issued screenshot unanswered.
  return (
    completed &&
    (targetClosed(error) ||
      error instanceof StudioMcpRequestTimeout ||
      (error instanceof Error &&
        (error.message === "Studio MCP closed" ||
          error.message.includes("No Roblox Studio instances are connected."))))
  );
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A bounded stdio transport. No sampling, code execution, shell, or server-request capabilities. */
export class StudioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly transcript: ObjectValue[] = [];
  private stderr = "";
  // The IDs of requests that timed out without a failure of the client. A late response to one
  // of them carries no result, so the client ignores it.
  private readonly abandoned = new Set<number>();
  // The end of the StudioMCP process, also after a failure closed the client.
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly command = STUDIO_MCP,
    private readonly args: string[] = [],
    private readonly timeoutMs = STUDIO_MCP_REQUEST_TIMEOUT_MS,
    readonly discoveryWaits = STUDIO_MCP_DISCOVERY_WAITS,
  ) {}

  async connect(): Promise<void> {
    if (this.child) throw new Error("MCP client is already connected");
    // Do not pass provider keys or the prepared-place capability to the subprocess.
    const env = Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
    const child = spawn(this.command, this.args, { stdio: "pipe", env });
    this.child = child;
    this.exited = new Promise<void>((done) => {
      child.once("exit", () => done());
      child.once("error", () => done());
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => this.fail(new Error(`Studio MCP exited. ${this.stderr}`)));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (this.buffer.length + chunk.length > MAX_MESSAGE)
          throw new Error("Studio MCP message exceeds size limit");
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let end: number;
        while ((end = this.buffer.indexOf(10)) !== -1) {
          const message: unknown = JSON.parse(this.buffer.subarray(0, end).toString("utf8"));
          this.buffer = this.buffer.subarray(end + 1);
          if (!object(message) || message.jsonrpc !== "2.0")
            throw new Error("Invalid Studio MCP response");
          if (typeof message.method === "string") {
            if (message.id !== undefined)
              this.send(
                message.method === "ping"
                  ? { jsonrpc: "2.0", id: message.id, result: {} }
                  : {
                      jsonrpc: "2.0",
                      id: message.id,
                      error: { code: -32601, message: "Client capabilities are disabled" },
                    },
              );
            continue;
          }
          const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
          if (!pending && typeof message.id === "number" && this.abandoned.delete(message.id))
            continue;
          if (!pending) throw new Error("Unexpected Studio MCP response ID");
          this.pending.delete(message.id as number);
          clearTimeout(pending.timer);
          if (object(message.error))
            pending.reject(
              new Error(`Studio MCP: ${String(message.error.message).slice(0, 4096)}`),
            );
          else if ("result" in message) pending.resolve(message.result);
          else pending.reject(new Error("Studio MCP response has no result"));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      const initialized = await this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "basalt-evals-capture", version: "1.0.0" },
      });
      if (
        !object(initialized) ||
        initialized.protocolVersion !== PROTOCOL ||
        !object(initialized.capabilities) ||
        !object(initialized.capabilities.tools)
      )
        throw new Error(
          `Studio MCP must support ${PROTOCOL} and tools; see the saved discovery transcript`,
        );
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async request(
    method: "initialize" | "tools/list" | "tools/call",
    params: ObjectValue,
    // "fail" closes the client on a timeout. "abandon" rejects only this request, for a probe
    // that a Studio which is not ready can leave without an answer.
    onTimeout: "fail" | "abandon" = "fail",
  ): Promise<unknown> {
    if (method === "tools/call") {
      const name = String(params.name);
      if (
        !["list_roblox_studios", "get_studio_state", "screen_capture", "execute_luau"].includes(
          name,
        )
      )
        throw new Error("Tool is outside the fixed capture allowlist");
      if (name === "execute_luau") {
        const args = params.arguments;
        const nonce =
          object(args) && typeof args.code === "string"
            ? /BASALT_ACTOR_([a-f0-9]{24})=/.exec(args.code)?.[1]
            : undefined;
        if (
          !object(args) ||
          Object.keys(args).sort().join(",") !== "code,datamodel_type,studio_id" ||
          args.datamodel_type !== "Client" ||
          typeof args.studio_id !== "string" ||
          typeof args.code !== "string" ||
          !nonce ||
          args.code !== identityCode(nonce)
        )
          throw new Error("Only fixed read-only player identity instrumentation is permitted");
      }
    }
    if (!this.child || this.child.killed) throw new Error("Studio MCP is disconnected");
    const id = ++this.nextId;
    const at = new Date().toISOString();
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const timeout = new StudioMcpRequestTimeout(method, this.timeoutMs);
          if (onTimeout === "fail") return this.fail(timeout);
          this.pending.delete(id);
          this.abandoned.add(id);
          if (this.abandoned.size > MAX_ABANDONED_REQUESTS)
            this.abandoned.delete(this.abandoned.values().next().value!);
          reject(timeout);
        }, this.timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.send({ jsonrpc: "2.0", id, method, params });
      });
      this.record({ at, method, params, result: diagnosticValue(result) });
      return result;
    } catch (error) {
      this.record({ at, method, params, error: String(error) });
      throw error;
    }
  }

  private record(entry: ObjectValue): void {
    this.transcript.push(entry);
    if (this.transcript.length > 40) this.transcript.shift();
  }
  private send(message: ObjectValue): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.close();
  }
  /** Close the client, and wait until its StudioMCP process exited. */
  async closeAndWait(): Promise<void> {
    this.close();
    // close() sends SIGKILL after 1 s, so the exit comes soon.
    await this.exited;
  }
  close(): void {
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Studio MCP closed"));
    }
    this.pending.clear();
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}

// Image data belongs in files, never in a trace. Other tool output is bounded diagnostic data.
function diagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 256).map(diagnosticValue);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 256)
        .map(([key, item]) => [
          key,
          key === "data" && value.type === "image"
            ? `[image data: ${typeof item === "string" ? item.length : 0} characters]`
            : diagnosticValue(item),
        ]),
    );
  return typeof value === "string" ? value.slice(0, 32_768) : value;
}

interface Tool {
  name: string;
  inputSchema: ObjectValue;
}
async function discover(client: StudioMcpClient): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const result = await client.request("tools/list", cursor ? { cursor } : {});
    if (!object(result) || !Array.isArray(result.tools))
      throw new Error("Invalid Studio MCP tools/list result");
    for (const entry of result.tools) {
      if (!object(entry) || typeof entry.name !== "string" || !object(entry.inputSchema))
        throw new Error("Invalid MCP tool schema");
      tools.push({ name: entry.name, inputSchema: entry.inputSchema });
    }
    if (tools.length > 256) throw new Error("Studio MCP tool listing exceeds limit");
    if (result.nextCursor !== undefined && typeof result.nextCursor !== "string")
      throw new Error("Invalid MCP cursor");
    cursor = result.nextCursor as string | undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("Repeated MCP tool cursor");
      cursors.add(cursor);
    }
    if (cursors.size > 16) throw new Error("Too many MCP tool pages");
  } while (cursor !== undefined);
  return tools;
}

/** The Studio bridge can attach after the stdio proxy answers its first tools/list. */
async function waitForCaptureTools(
  client: StudioMcpClient,
  identifyActors = false,
): Promise<Tool[]> {
  const required = [
    "list_roblox_studios",
    "get_studio_state",
    "screen_capture",
    ...(identifyActors ? ["execute_luau"] : []),
  ];
  const waits = client.discoveryWaits;
  const deadline = performance.now() + waits.toolsMs;
  while (true) {
    const tools = await discover(client);
    const counts = required.map((name) => tools.filter((tool) => tool.name === name).length);
    if (counts.some((count) => count > 1))
      throw new Error("Studio MCP advertised a duplicate required capture tool; inspect mcp.json");
    if (counts.every((count) => count === 1)) return tools;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error(
        `Studio MCP has ${tools.length} tools, but not ${required.filter((_, index) => counts[index] === 0).join(", ")}. In the macOS account that runs Studio, open Assistant > Manage MCP Servers. Then enable Studio as MCP server. For details, read mcp.json.`,
      );
    await delay(Math.min(waits.pollMs, remaining));
  }
}

/** Supply the target and a fresh request identity; never override the camera or execute Luau. */
function argumentsFor(
  tools: Tool[],
  name: string,
  studioId?: string,
  captureId?: string,
): ObjectValue {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1)
    throw new Error(`Installed Studio MCP must advertise ${name} exactly once`);
  const schema = matches[0]!.inputSchema;
  const properties = object(schema.properties) ? schema.properties : {};
  const args: ObjectValue = studioId === undefined ? {} : { studio_id: studioId };
  if (name === "screen_capture") args.capture_id = captureId;
  if (
    schema.type !== "object" ||
    (schema.required !== undefined && !Array.isArray(schema.required)) ||
    (Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key !== "string" || !(key in args))) ||
    (studioId !== undefined &&
      (!object(properties.studio_id) || properties.studio_id.type !== "string")) ||
    (name === "screen_capture" &&
      (!captureId || !object(properties.capture_id) || properties.capture_id.type !== "string"))
  )
    throw new Error(
      `Unsupported ${name} input schema; inspect the saved MCP transcript instead of guessing arguments`,
    );
  return args;
}

function identityArguments(tools: Tool[], studioId: string, nonce: string): ObjectValue {
  const matches = tools.filter((tool) => tool.name === "execute_luau");
  if (matches.length !== 1) throw new Error("Studio MCP must advertise execute_luau once");
  const schema = matches[0]!.inputSchema;
  const properties = object(schema.properties) ? schema.properties : {};
  const required = schema.required;
  if (
    schema.type !== "object" ||
    !Array.isArray(required) ||
    required.some((key) => !["code", "datamodel_type", "studio_id"].includes(key)) ||
    !["code", "datamodel_type", "studio_id"].every((key) => required.includes(key)) ||
    !object(properties.code) ||
    properties.code.type !== "string" ||
    !object(properties.studio_id) ||
    properties.studio_id.type !== "string" ||
    !object(properties.datamodel_type) ||
    !Array.isArray(properties.datamodel_type.enum) ||
    !properties.datamodel_type.enum.includes("Client")
  )
    throw new Error("Unsupported execute_luau identity schema");
  return {
    studio_id: studioId,
    datamodel_type: "Client",
    code: identityCode(nonce),
  };
}

async function call(
  client: StudioMcpClient,
  tools: Tool[],
  name: string,
  studioId?: string,
  captureId?: string,
  onTimeout: "fail" | "abandon" = "fail",
): Promise<ObjectValue> {
  const result = await client.request(
    "tools/call",
    { name, arguments: argumentsFor(tools, name, studioId, captureId) },
    onTimeout,
  );
  if (!object(result)) throw new Error(`Invalid ${name} response`);
  return result;
}
function toolSucceeded(result: ObjectValue, name: string): void {
  if (result.isError === true)
    throw new Error(`${name} failed: ${JSON.stringify(diagnosticValue(result)).slice(0, 4096)}`);
}

/** A random, non-secret place name makes discovery independent of window order and human IDs. */
export function studioPlaceName(file: unknown): string {
  if (typeof file !== "string" || !/^BasaltEval-[a-f0-9]{20}\.rbxlx$/.test(file))
    throw new Error("Invalid prepared Studio place filename");
  return file.slice(0, -".rbxlx".length);
}

function studioInstances(result: ObjectValue): Array<{ id: string; name: string | null }> {
  // MCP permits structured output and JSON in a text block. Both carry the same
  // current id/name records; never extract IDs from prose or guess field aliases.
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const content = result.content;
    if (
      !Array.isArray(content) ||
      content.length !== 1 ||
      !object(content[0]) ||
      content[0].type !== "text" ||
      typeof content[0].text !== "string"
    )
      throw new Error("Studio discovery must return JSON instance records; inspect mcp.json");
    try {
      payload = JSON.parse(content[0].text);
    } catch {
      throw new Error("Studio discovery returned non-JSON output; inspect mcp.json");
    }
  }
  const entries: unknown = object(payload) ? payload.studios : payload;
  if (!Array.isArray(entries) || entries.length > 64)
    throw new Error("Invalid Studio instance list; inspect mcp.json");
  const ids = new Set<string>();
  const studios = entries.map((entry) => {
    if (
      !object(entry) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      entry.id.length > 256 ||
      /[\x00-\x1f]/.test(entry.id) ||
      (entry.name !== null &&
        (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 4096)) ||
      ids.has(entry.id)
    )
      throw new Error("Invalid or duplicate Studio instance identity; inspect mcp.json");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name };
  });
  return studios;
}

function matchingStudios(result: ObjectValue, placeFile: string) {
  const name = studioPlaceName(placeFile);
  // Studio's display name can include a path, file extension or surrounding UI
  // text. Match a complete generated name, not a prefix such as a saved '-copy'.
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${name}(?:\\.rbxlx)?($|[^A-Za-z0-9_.-])`);
  const studios = studioInstances(result);
  return {
    studios,
    matches: studios.filter((studio) => studio.name !== null && pattern.test(studio.name)),
  };
}

async function waitForStudios(client: StudioMcpClient, tools: Tool[], placeFile: string) {
  // Studio connects to a newly spawned proxy asynchronously (observed: unavailable,
  // empty list, name:null, then the named instance). Wait on discovery only; never
  // retry an image request or treat an unregistered name as a target.
  const waits = client.discoveryWaits;
  const deadline = performance.now() + waits.studiosMs;
  do {
    const result = await call(client, tools, "list_roblox_studios");
    if (result.isError !== true) {
      const { matches } = matchingStudios(result, placeFile);
      if (matches.length > 1)
        throw new Error(
          `${placeFile} is open in more than one Studio window. Basalt did not record an image. Close the other Studio windows. Then try again.`,
        );
      // An unrelated Studio may remain unnamed for the entire trial. The
      // generated place name uniquely binds the target we actually query.
      if (matches.length === 1) return matches[0]!;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(waits.pollMs, remaining));
  } while (true);
  throw new Error(
    `No Studio window with ${placeFile} connected to Studio MCP in ${waits.studiosMs / 1000} seconds. Open this place in Studio. Then enable Studio as MCP server. For the discovery responses, read mcp.json.`,
  );
}

/** Resolve the prepared place on every attempt; never cache a stale Studio ID or pick the first window. */
export function studioViewportCapture(
  placeFile: string,
  createClient = () => new StudioMcpClient(),
): ViewportCapture {
  studioPlaceName(placeFile);
  const clients = new Set<StudioMcpClient>();
  return {
    async check(directory) {
      const client = createClient();
      clients.add(client);
      const deadline = setTimeout(() => client.close(), 35_000);
      let studioId: string | null = null;
      let error: string | null = null;
      try {
        await client.connect();
        const tools = await waitForCaptureTools(client);
        studioId = (await waitForStudios(client, tools, placeFile)).id;
        argumentsFor(tools, "screen_capture", studioId, "ScreenCapture_preflight");
        toolSucceeded(await call(client, tools, "get_studio_state", studioId), "get_studio_state");
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        clearTimeout(deadline);
        client.close();
        clients.delete(client);
        await writeFile(
          resolve(directory, "mcp.json"),
          JSON.stringify({ placeFile, studioId, error, transcript: client.transcript }, null, 2),
          { flag: "wx", mode: 0o600 },
        );
      }
    },
    async capture(directory) {
      const client = createClient();
      clients.add(client);
      const deadline = setTimeout(() => client.close(), 35_000);
      const startedAt = new Date().toISOString();
      const captureId = `ScreenCapture_${randomBytes(10).toString("hex")}`;
      const files: ObjectValue[] = [];
      let studioId: string | null = null;
      let error: string | null = null;
      try {
        await client.connect();
        const tools = await waitForCaptureTools(client);
        studioId = (await waitForStudios(client, tools, placeFile)).id;
        const state = await call(client, tools, "get_studio_state", studioId);
        toolSucceeded(state, "get_studio_state");
        const result = await call(client, tools, "screen_capture", studioId, captureId);
        const images = Array.isArray(result.content)
          ? result.content.filter((item) => object(item) && item.type === "image")
          : [];
        const saved: ViewportImage[] = [];
        for (const [index, item] of images.entries()) {
          if (
            !object(item) ||
            typeof item.data !== "string" ||
            item.data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4
          )
            throw new Error("MCP image must be bounded canonical base64");
          const bytes = Buffer.from(item.data, "base64");
          if (bytes.length > MAX_CAPTURE_BYTES || bytes.toString("base64") !== item.data)
            throw new Error("MCP image must be bounded canonical base64");
          const mediaType = item.mimeType;
          const file = `raw-${index + 1}.${mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "bin"}`;
          // Save bytes before decoding, including malformed or tool-error images.
          await writeFile(resolve(directory, file), bytes, { flag: "wx", mode: 0o600 });
          files.push({ file, mediaType, hash: contentHash(bytes), bytes: bytes.length });
          if (mediaType !== "image/png" && mediaType !== "image/jpeg")
            throw new Error("Studio MCP returned an unsupported image format");
          saved.push({ bytes, mediaType });
        }
        toolSucceeded(result, "screen_capture");
        if (saved.length !== 1)
          throw new Error("screen_capture must return exactly one inline image; inspect mcp.json");
        const capture = saved[0]!;
        const decoded = decodeCaptureImage(capture.bytes, capture.mediaType);
        Object.assign(files[0]!, { width: decoded.width, height: decoded.height });
        // Studio 0.739 on this Mac returned a successful JPEG containing only
        // magenta in Play under Metal. Preserve that response, but never seal it
        // as usable evidence. The small tolerance includes JPEG quantization.
        let magenta = true;
        for (let offset = 0; offset < decoded.data.length; offset += 4) {
          if (
            decoded.data[offset]! < 250 ||
            decoded.data[offset + 1]! > 5 ||
            decoded.data[offset + 2]! < 250
          ) {
            magenta = false;
            break;
          }
        }
        if (magenta)
          throw new Error(
            "Studio returned a solid-magenta image. Basalt cannot use this image. In Studio Settings > Rendering, set Graphics Mode to OpenGL. Then restart Studio. Basalt kept the image bytes in the folder of the observation.",
          );
        return capture;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        clearTimeout(deadline);
        client.close();
        clients.delete(client);
        await writeFile(
          resolve(directory, "mcp.json"),
          JSON.stringify(
            {
              schema: "basalt-evals/viewport-acquisition",
              backend: "studio-mcp/screen_capture",
              placeFile,
              studioId,
              captureId,
              startedAt,
              endedAt: new Date().toISOString(),
              error,
              files,
              transcript: client.transcript,
            },
            null,
            2,
          ),
          { flag: "wx", mode: 0o600 },
        );
      }
    },
    close() {
      for (const client of clients) client.close();
      clients.clear();
    },
  };
}

/**
 * Capture live client views without pausing scenario actions. Each image has an
 * acquisition interval, not an invented exposure instant. Only a fixed,
 * read-only identity query may execute in the Client DataModel.
 */
export async function recordStudioSequence(input: {
  placeFile: string;
  sessionId: string;
  directory: string;
  expectedClients: number;
  signal: AbortSignal;
  /** Only the host's authenticated, all-context scenario receipt ends recording normally. */
  completion: { scenarioId: string; signal: AbortSignal };
  /**
   * The owned Studio process exited. After a bound completion, no issued request can get an
   * answer, so the recorder closes its client and does not wait for the request bound.
   */
  studioExited?: AbortSignal;
  /** Every bound actor has a decoded, durably retained pre-roll frame. */
  onReady?: () => void;
  /** Interrupt the owned Play attempt as soon as acquisition irrecoverably fails. */
  onFailure?: (reason: string) => void;
  camera?: { position: [number, number, number]; lookAt: [number, number, number] };
  createClient?: () => StudioMcpClient;
}): Promise<SequenceAcquisition> {
  studioPlaceName(input.placeFile);
  if (!/^studio-[a-f0-9]{20}$/.test(input.sessionId))
    throw new Error("Sequence capture requires a prepared session identity");
  if (
    !Number.isSafeInteger(input.expectedClients) ||
    input.expectedClients < 1 ||
    input.expectedClients > MAX_STUDIO_CLIENTS
  )
    throw new Error(`Sequence capture requires one to ${MAX_STUDIO_CLIENTS} declared clients`);
  if (
    input.camera &&
    [...input.camera.position, ...input.camera.lookAt].some(
      (value) => !Number.isFinite(value) || Math.abs(value) > 100_000,
    )
  )
    throw new Error("Camera coordinates must be bounded finite numbers");
  await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
  await mkdir(input.directory, { recursive: false, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const store = new SequenceFrameStore(input.directory);
  const client = input.createClient?.() ?? new StudioMcpClient();
  const stop = () => client.close();
  input.signal.addEventListener("abort", stop, { once: true });
  const exited = () => {
    if (completedAt !== null) client.close();
  };
  input.studioExited?.addEventListener("abort", exited, { once: true });
  let reason: string | null = null;
  let status: SequenceAcquisition["status"] = "incomplete";
  let notified = false;
  let captureFailure: unknown = null;
  let completedAt: number | null = null;
  const failed = (error: unknown) => {
    if (notified) return;
    notified = true;
    input.onFailure?.(error instanceof Error ? error.message : String(error));
  };
  const completed = () => {
    const receipt = input.completion.signal.reason as StudioScenarioCompletion | undefined;
    const at = receipt ? Date.parse(receipt.completedAt) : NaN;
    if (
      !receipt ||
      receipt.sessionId !== input.sessionId ||
      receipt.scenarioId !== input.completion.scenarioId ||
      !/^trial-[a-f0-9]{24}$/.test(receipt.trialId) ||
      !/^[a-f0-9]{64}$/.test(receipt.runtimeHash) ||
      !Number.isSafeInteger(receipt.generation) ||
      receipt.generation < 1 ||
      !Number.isFinite(at) ||
      at < Date.parse(startedAt) ||
      at > Date.now()
    ) {
      captureFailure ??= new Error("Scenario completion does not match this recording");
      failed(captureFailure);
      return;
    }
    completedAt = at;
  };
  input.completion.signal.addEventListener("abort", completed, { once: true });
  if (input.completion.signal.aborted) completed();
  const waitSignal = AbortSignal.any([input.signal, input.completion.signal]);
  const clockProbes: SequenceClockProbe[] = [];
  try {
    input.signal.throwIfAborted();
    if (captureFailure) throw captureFailure;
    await client.connect();
    const tools = await waitForCaptureTools(client, true);
    if (tools.filter((tool) => tool.name === "execute_luau").length !== 1)
      throw new Error("Studio MCP lacks the fixed actor-identity tool");
    // Read the identity and both clocks of one client. A tool error gives null.
    const readClocks = async (
      studioId: string,
      onTimeout: "fail" | "abandon" = "fail",
    ): Promise<{ sessionId: string; probe: SequenceClockProbe } | null> => {
      const nonce = randomBytes(12).toString("hex");
      const hostSentAt = new Date().toISOString();
      const identity = await client.request(
        "tools/call",
        { name: "execute_luau", arguments: identityArguments(tools, studioId, nonce) },
        onTimeout,
      );
      const hostReceivedAt = new Date().toISOString();
      if (!object(identity)) throw new Error("Invalid actor-identity response");
      if (identity.isError === true) return null;
      const printed = Array.isArray(identity.content)
        ? identity.content
            .filter((part) => object(part) && part.type === "text")
            .map((part) => String((part as ObjectValue).text))
            .join("\n")
        : "";
      const ids = [
        ...printed.matchAll(
          new RegExp(
            `BASALT_ACTOR_${nonce}=(-?\\d+):(studio-[a-f0-9]{20}):(\\d+\\.\\d+):(\\d+\\.\\d+)`,
            "g",
          ),
        ),
      ];
      if (ids.length !== 1) throw new Error("Client identity was not returned exactly once");
      const playerUserId = Number(ids[0]![1]);
      if (!Number.isSafeInteger(playerUserId))
        throw new Error("Ambiguous or duplicate client player identity");
      return {
        sessionId: ids[0]![2]!,
        probe: {
          playerUserId,
          studioId,
          hostSentAt,
          hostReceivedAt,
          serverTime: Number(ids[0]![3]),
          clientTime: Number(ids[0]![4]),
        },
      };
    };
    const actors = new Map<number, string>();
    // The Play clients of another run on this Mac, for example of another lane. The search
    // does not probe them again.
    const foreign = new Set<string>();
    // A Play client that is not ready, or that another run closes, can leave a probe without an
    // answer. Such a probe ends only that probe, and the search continues.
    const probed = async <T>(probe: () => Promise<T>): Promise<T | null> => {
      try {
        return await probe();
      } catch (error) {
        if (error instanceof StudioMcpRequestTimeout) return null;
        throw error;
      }
    };
    // Studio's multiplayer child processes may take tens of seconds to become
    // visible to MCP. The scenario clock waits for retained pre-roll frames.
    const deadline = performance.now() + 60_000;
    while (!waitSignal.aborted && captureFailure === null && actors.size < input.expectedClients) {
      const listing = await call(client, tools, "list_roblox_studios");
      if (listing.isError === true) {
        if (performance.now() >= deadline)
          throw new Error("Studio MCP could not list the Studio windows in 60 seconds.");
        await delay(250, undefined, { signal: waitSignal }).catch(() => {});
        continue;
      }
      const found = matchingStudios(listing, input.placeFile);
      // Studio MCP reports live Play clients with name:null. A name is only a
      // discovery hint; the prepared-session marker is the actual binding.
      for (const studio of found.studios.filter(
        (candidate) => candidate.name === null || found.matches.includes(candidate),
      )) {
        if ([...actors.values()].includes(studio.id) || foreign.has(studio.id)) continue;
        const state = await probed(() =>
          call(client, tools, "get_studio_state", studio.id, undefined, "abandon"),
        );
        if (state === null) continue;
        if (state.isError === true || !Array.isArray(state.content)) continue;
        const description = state.content
          .filter((part) => object(part) && part.type === "text")
          .map((part) => String((part as ObjectValue).text))
          .join("\n");
        if (
          !description.includes("Current Studio Mode: Play") ||
          !description.includes("Available DataModels: Client")
        )
          continue;
        const identity = await probed(() => readClocks(studio.id, "abandon"));
        if (identity === null) continue;
        if (identity.sessionId !== input.sessionId) {
          foreign.add(studio.id);
          continue;
        }
        if (actors.has(identity.probe.playerUserId))
          throw new Error("Ambiguous or duplicate client player identity");
        actors.set(identity.probe.playerUserId, studio.id);
        clockProbes.push(identity.probe);
      }
      if (actors.size > input.expectedClients)
        throw new Error("More prepared Play clients than the scenario declares");
      if (actors.size < input.expectedClients) {
        if (performance.now() >= deadline)
          throw new Error("The search for the Play clients in Studio timed out after 60 seconds.");
        await delay(250, undefined, { signal: waitSignal }).catch(() => {});
      }
    }
    if (waitSignal.aborted || captureFailure)
      throw captureFailure ?? new Error("Scenario ended before actor binding");
    const pending = new Set<Promise<void>>();
    const inFlight = new Map<number, number>();
    let issued = 0;
    const capturedActors = new Set<number>();
    let ready = false;
    // The receipt is stamped before its completion reaches this recorder, so a request can
    // be issued after the bound completion time but before the loop stops admitting.
    const capture = async (playerUserId: number, studioId: string): Promise<void> => {
      try {
        const captureId = `ScreenCapture_${randomBytes(10).toString("hex")}`;
        const args = argumentsFor(tools, "screen_capture", studioId, captureId);
        if (input.camera) {
          const properties = tools.find((tool) => tool.name === "screen_capture")!.inputSchema
            .properties;
          if (
            !object(properties) ||
            !object(properties.camera_position) ||
            !object(properties.look_at_position)
          )
            throw new Error("Studio MCP does not support declared camera coordinates");
          args.camera_position = input.camera.position;
          args.look_at_position = input.camera.lookAt;
        }
        const startedAt = new Date().toISOString();
        const result = await client.request("tools/call", {
          name: "screen_capture",
          arguments: args,
        });
        const endedAt = new Date().toISOString();
        // A frame requested after the bound completion lies outside the observation window.
        if (completedAt !== null && Date.parse(startedAt) > completedAt) return;
        if (!object(result)) throw new Error("Invalid screenshot response");
        toolSucceeded(result, "screen_capture");
        const images = Array.isArray(result.content)
          ? result.content.filter((part) => object(part) && part.type === "image")
          : [];
        if (
          images.length !== 1 ||
          !object(images[0]) ||
          typeof images[0].data !== "string" ||
          images[0].data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4
        )
          throw new Error("Sequence capture must return one bounded image");
        const raw = images[0].data;
        const bytes = Buffer.from(raw, "base64");
        if (bytes.length > MAX_CAPTURE_BYTES || bytes.toString("base64") !== raw)
          throw new Error("Sequence image is not canonical bounded base64");
        const mediaType = images[0].mimeType;
        if (mediaType !== "image/png" && mediaType !== "image/jpeg")
          throw new Error("Unsupported sequence image format");
        await store.append({ bytes, mediaType, playerUserId, studioId, startedAt, endedAt });
        capturedActors.add(playerUserId);
        if (
          !ready &&
          !waitSignal.aborted &&
          captureFailure === null &&
          capturedActors.size === input.expectedClients
        ) {
          ready = true;
          input.onReady?.();
        }
      } catch (error) {
        if (
          !input.signal.aborted &&
          completedAt !== null &&
          captureStoppedWithScenario(error, true)
        )
          return;
        captureFailure ??= error;
        failed(error);
      }
    };
    // Probe the clocks of each client again during the recording, so that the
    // record shows drift. A probe never delays a screenshot request.
    const probing = new Set<number>();
    const probedAt = new Map<number, number>(
      [...actors.keys()].map((id) => [id, performance.now()]),
    );
    const probeClocks = async (playerUserId: number, studioId: string): Promise<void> => {
      try {
        const identity = await readClocks(studioId);
        if (identity === null || completedAt !== null) return;
        if (identity.sessionId !== input.sessionId || identity.probe.playerUserId !== playerUserId)
          throw new Error("Client identity changed during the recording");
        clockProbes.push(identity.probe);
      } catch (error) {
        if (
          !input.signal.aborted &&
          completedAt !== null &&
          captureStoppedWithScenario(error, true)
        )
          return;
        captureFailure ??= error;
        failed(error);
      }
    };
    let tick = performance.now();
    while (!waitSignal.aborted && captureFailure === null && issued < MAX_SEQUENCE_FRAMES) {
      for (const [playerUserId, studioId] of actors) {
        if (
          !probing.has(playerUserId) &&
          performance.now() - probedAt.get(playerUserId)! >= CLOCK_PROBE_INTERVAL_MS
        ) {
          probing.add(playerUserId);
          probedAt.set(playerUserId, performance.now());
          const task = probeClocks(playerUserId, studioId).finally(() => {
            probing.delete(playerUserId);
            pending.delete(task);
          });
          pending.add(task);
        }
        // A third pending request absorbs a single slow Studio response while
        // preserving the declared 500 ms request cadence for that actor.
        if (
          (inFlight.get(playerUserId) ?? 0) >= MAX_CAPTURE_REQUESTS_PER_ACTOR ||
          issued >= MAX_SEQUENCE_FRAMES
        )
          continue;
        issued++;
        inFlight.set(playerUserId, (inFlight.get(playerUserId) ?? 0) + 1);
        const task = capture(playerUserId, studioId).finally(() => {
          inFlight.set(playerUserId, (inFlight.get(playerUserId) ?? 1) - 1);
          pending.delete(task);
        });
        pending.add(task);
      }
      // Missed sampling slots cannot be recovered by flooding Studio with a
      // burst of requests. Record actual gaps instead of catching up.
      tick = Math.max(tick, performance.now()) + SEQUENCE_SAMPLE_INTERVAL_MS;
      const remaining = tick - performance.now();
      if (remaining > 0) await delay(remaining, undefined, { signal: waitSignal }).catch(() => {});
    }
    await Promise.all([...pending]);
    input.signal.throwIfAborted();
    // Preserve returned frames even when acquisition reaches its capacity.
    if (issued >= MAX_SEQUENCE_FRAMES) {
      captureFailure ??= new Error("Sequence frame limit reached");
      failed(captureFailure);
    }
    // An answer can arrive before the completion reaches the recorder. If its request started
    // after the bound completion time, the frame lies outside the recording, like a later one.
    if (completedAt !== null) await store.removeStartedAfter(completedAt);
    const completeActors = [...actors.keys()].every(
      (userId) => store.frames.filter((frame) => frame.playerUserId === userId).length >= 2,
    );
    if (!completeActors) throw new Error("Sequence ended before every actor had two frames");
    if (captureFailure !== null) throw captureFailure;
    if (completedAt === null) throw new Error("Sequence ended without bound scenario completion");
    if (
      store.frames.some(
        (frame) =>
          !Number.isFinite(Date.parse(frame.startedAt)) ||
          !Number.isFinite(Date.parse(frame.endedAt)) ||
          Date.parse(frame.startedAt) < Date.parse(startedAt) ||
          Date.parse(frame.endedAt) < Date.parse(frame.startedAt) ||
          Date.parse(frame.startedAt) > completedAt!,
      )
    )
      throw new Error("Sequence frame timestamps do not match the completed recording");
    status = "complete";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    failed(error);
  } finally {
    input.signal.removeEventListener("abort", stop);
    input.studioExited?.removeEventListener("abort", exited);
    input.completion.signal.removeEventListener("abort", completed);
    client.close();
  }
  const result: SequenceAcquisition = {
    schema: "basalt-evals/sequence-acquisition",
    placeFile: input.placeFile,
    startedAt,
    endedAt: new Date().toISOString(),
    expectedClients: input.expectedClients,
    status,
    reason,
    frames: store.frames,
    clockProbes: clockProbes.sort(
      (left, right) =>
        Date.parse(left.hostSentAt) - Date.parse(right.hostSentAt) ||
        left.playerUserId - right.playerUserId,
    ),
  };
  await writeFile(resolve(input.directory, "index.json"), `${JSON.stringify(result)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(resolve(input.directory, "mcp.json"), `${JSON.stringify(client.transcript)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}
