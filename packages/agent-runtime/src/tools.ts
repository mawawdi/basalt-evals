import {
  stableJson,
  type BuilderToolName,
  type CandidateManifest,
  type HarnessDefinition,
  type JsonValue,
  type PublicTask,
} from "../../contracts/src/index.js";
import type { SourceLintCode } from "../../contracts/src/capabilities.js";
import type { SourceAnalysis } from "../../contracts/src/source-analysis.js";
import { isRecord } from "../../contracts/src/validation.js";
// Import transport-neutral contracts directly; the package barrel would load the provider SDK.
import type { ModelToolCall, ModelToolDefinition } from "../../model-client/src/contracts.js";
import type { NotesPackReader } from "./notes.js";
import type { CandidateWorkspace } from "./workspace.js";

export const MAX_TOOL_RESULT_BYTES = 512 * 1024;
const MAX_FINISH_SUMMARY_BYTES = 16 * 1024;

export interface LocalVerification {
  gate: "eligible" | "rejected" | "incomplete";
  reasons: string[];
  checks: Array<{ name: string; outcome: "pass" | "fail" | "unavailable" }>;
}

export type CandidateVerifier = (
  workspaceRoot: string,
  task: PublicTask,
) => Promise<LocalVerification>;

/** Analyze the files of a manifest with the pinned luau-lsp. It stores no record. */
export type SourceAnalyzer = (
  workspaceRoot: string,
  candidate: CandidateManifest,
) => Promise<SourceAnalysis>;

/** The lint feedback of `workspace.verify`: the fixed codes of the harness and the analyzer. */
export interface VerifyLint {
  codes: readonly SourceLintCode[];
  analyze: SourceAnalyzer;
}

/** The lint findings that one `workspace.verify` result shows. A count line follows them. */
export const MAX_LINT_FINDING_LINES = 20;
const MAX_LINT_LINE_CHARS = 400;

export type ParsedToolCall =
  | { id: string; name: "workspace.list"; arguments: Record<string, never> }
  | { id: string; name: "workspace.read"; arguments: { path: string } }
  | { id: string; name: "workspace.search"; arguments: { text: string } }
  | {
      id: string;
      name: "workspace.patch";
      arguments: { path: string; expectedHash: string; before: string; after: string };
    }
  | {
      id: string;
      name: "workspace.write";
      arguments: { path: string; content: string; expectedHash: string | null };
    }
  | { id: string; name: "workspace.verify"; arguments: Record<string, never> }
  | { id: string; name: "development.run"; arguments: { scenarioId: string } }
  | {
      id: string;
      name: "development.inspect";
      arguments: { evidenceId: string; frameIds: string[] };
    }
  | { id: string; name: "workspace.finish"; arguments: { summary: string } }
  | { id: string; name: "notes.list"; arguments: Record<string, never> }
  | { id: string; name: "notes.read"; arguments: { path: string } };

export function parseToolCall(call: ModelToolCall): ParsedToolCall {
  if (typeof call.id !== "string" || call.id.length === 0 || call.id.length > 256)
    throw new Error("Tool call ID must be a non-empty bounded string");
  if (!isRecord(call.arguments)) throw new Error(`Tool ${call.name} arguments must be an object`);
  if (
    call.name === "workspace.list" ||
    call.name === "workspace.verify" ||
    call.name === "notes.list"
  ) {
    assertExactKeys(call.name, call.arguments, []);
    return { id: call.id, name: call.name, arguments: {} };
  }
  if (call.name === "workspace.read" || call.name === "notes.read") {
    assertExactKeys(call.name, call.arguments, ["path"]);
    if (typeof call.arguments.path !== "string" || call.arguments.path.length > 1_024)
      throw new Error(`${call.name} path is required and must be bounded`);
    return { id: call.id, name: call.name, arguments: { path: call.arguments.path } };
  }
  if (call.name === "workspace.search") {
    assertExactKeys(call.name, call.arguments, ["text"]);
    if (
      typeof call.arguments.text !== "string" ||
      !call.arguments.text.trim() ||
      call.arguments.text.length > 200
    )
      throw new Error("workspace.search requires bounded text");
    return { id: call.id, name: call.name, arguments: { text: call.arguments.text } };
  }
  if (call.name === "workspace.patch") {
    assertExactKeys(call.name, call.arguments, ["path", "expectedHash", "before", "after"]);
    const { path, expectedHash, before, after } = call.arguments;
    if (typeof path !== "string") throw new Error("workspace.patch path must be a string");
    if (typeof before !== "string") throw new Error("workspace.patch before must be a string");
    if (typeof after !== "string") throw new Error("workspace.patch after must be a string");
    if (!isHash(expectedHash)) throw new Error(hashError("workspace.patch", expectedHash));
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path,
        expectedHash,
        before,
        after,
      },
    };
  }
  if (call.name === "development.run") {
    assertExactKeys(call.name, call.arguments, ["scenarioId"]);
    if (
      typeof call.arguments.scenarioId !== "string" ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(call.arguments.scenarioId)
    )
      throw new Error("development.run requires a public scenario ID");
    return { id: call.id, name: call.name, arguments: { scenarioId: call.arguments.scenarioId } };
  }
  if (call.name === "development.inspect") {
    assertExactKeys(call.name, call.arguments, ["evidenceId", "frameIds"]);
    if (
      typeof call.arguments.evidenceId !== "string" ||
      !/^[a-z][a-z0-9-]{0,119}$/.test(call.arguments.evidenceId) ||
      !Array.isArray(call.arguments.frameIds) ||
      call.arguments.frameIds.length < 1 ||
      call.arguments.frameIds.length > 4 ||
      call.arguments.frameIds.some(
        (id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,119}$/.test(id),
      )
    )
      throw new Error("development.inspect requires one to four verified frame IDs");
    return {
      id: call.id,
      name: call.name,
      arguments: {
        evidenceId: call.arguments.evidenceId,
        frameIds: call.arguments.frameIds as string[],
      },
    };
  }
  if (call.name === "workspace.write") {
    assertExactKeys(call.name, call.arguments, ["path", "content", "expectedHash"]);
    if (
      typeof call.arguments.path !== "string" ||
      call.arguments.path.length > 1_024 ||
      typeof call.arguments.content !== "string"
    )
      throw new Error("workspace.write requires path and content strings");
    if (call.arguments.expectedHash !== null && !isHash(call.arguments.expectedHash))
      throw new Error(
        `${hashError("workspace.write", call.arguments.expectedHash)} Use null only to create an absent file.`,
      );
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path: call.arguments.path,
        content: call.arguments.content,
        expectedHash: call.arguments.expectedHash,
      },
    };
  }
  if (call.name === "workspace.finish") {
    assertExactKeys(call.name, call.arguments, ["summary"]);
    if (
      typeof call.arguments.summary !== "string" ||
      call.arguments.summary.trim() === "" ||
      Buffer.byteLength(call.arguments.summary, "utf8") > MAX_FINISH_SUMMARY_BYTES
    )
      throw new Error("workspace.finish summary is required and must be bounded");
    return { id: call.id, name: call.name, arguments: { summary: call.arguments.summary } };
  }
  throw new Error(`Unknown tool: ${call.name}`);
}

export async function executeTool(
  call: ParsedToolCall,
  workspace: CandidateWorkspace,
  verify: CandidateVerifier,
  task: PublicTask,
  notes: NotesPackReader | null = null,
  lint: VerifyLint | null = null,
): Promise<Record<string, JsonValue>> {
  try {
    if (call.name === "notes.list" || call.name === "notes.read") {
      if (!notes) throw new Error("This harness has no API notes");
      return call.name === "notes.list"
        ? { ok: true, ...notes.list() }
        : { ok: true, ...(await notes.read(call.arguments.path)) };
    }
    if (call.name === "workspace.list") return { ok: true, ...(await workspace.describe()) };
    if (call.name === "workspace.read")
      return { ok: true, ...(await workspace.read(call.arguments.path)) };
    if (call.name === "workspace.search")
      return { ok: true, matches: await workspace.search(call.arguments.text) };
    if (call.name === "workspace.patch")
      return {
        ok: true,
        ...(await workspace.patch(
          call.arguments.path,
          call.arguments.expectedHash,
          call.arguments.before,
          call.arguments.after,
        )),
      };
    if (call.name === "workspace.write")
      return {
        ok: true,
        ...(await workspace.write(
          call.arguments.path,
          call.arguments.content,
          call.arguments.expectedHash,
        )),
      };
    if (call.name === "workspace.verify") {
      const verification = await runVerification(verify, workspace.root, task);
      // The lint lines are advice. They do not change the gate of the verification.
      return {
        ok: true,
        ...verification,
        ...(lint ? { lint: await lintLines(lint, workspace, task) } : {}),
      };
    }
    if (call.name === "workspace.finish")
      return { ok: true, finished: true, summary: call.arguments.summary };
    throw new Error("Unknown executable tool");
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function runVerification(
  verify: CandidateVerifier,
  workspaceRoot: string,
  task: PublicTask,
): Promise<LocalVerification> {
  const value = structuredClone(await verify(workspaceRoot, structuredClone(task)));
  if (!new Set(["eligible", "rejected", "incomplete"]).has(value.gate))
    throw new Error("Local verifier returned an invalid gate");
  if (
    !Array.isArray(value.reasons) ||
    value.reasons.length > 100 ||
    value.reasons.some(
      (reason) => typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > 2_000,
    )
  )
    throw new Error("Local verifier returned invalid reasons");
  if (
    !Array.isArray(value.checks) ||
    value.checks.length > 100 ||
    value.checks.some(
      (check) =>
        !isRecord(check) ||
        typeof check.name !== "string" ||
        check.name.trim() === "" ||
        check.name.length > 200 ||
        !new Set(["pass", "fail", "unavailable"]).has(String(check.outcome)),
    )
  )
    throw new Error("Local verifier returned invalid checks");
  return value;
}

/**
 * Analyze the current workspace and give one line for each finding of the harness codes, at most
 * `MAX_LINT_FINDING_LINES`, then a count line. An analyzer failure gives one line.
 */
async function lintLines(
  lint: VerifyLint,
  workspace: CandidateWorkspace,
  task: PublicTask,
): Promise<string[]> {
  let analysis: SourceAnalysis;
  try {
    analysis = await lint.analyze(workspace.root, await workspace.manifest(task.seed.projectFile));
  } catch (error) {
    return [lintUnavailable(errorMessage(error))];
  }
  if (analysis.status !== "complete") return [lintUnavailable(analysis.reason ?? "no reason")];
  const codes = new Set<string>(lint.codes);
  const total = lint.codes.reduce((sum, code) => sum + (analysis.counts[code] ?? 0), 0);
  const lines = analysis.findings
    .filter((finding) => codes.has(finding.code))
    .slice(0, MAX_LINT_FINDING_LINES)
    .map((finding) =>
      oneLine(`${finding.file}:${finding.line}: ${finding.code}: ${finding.message}`),
    );
  const shown = lines.length < total ? ` The first ${lines.length} are listed.` : "";
  return [
    ...lines,
    `Lint: ${total} ${total === 1 ? "finding" : "findings"} for ${lint.codes.join(", ")}.${shown} Lint findings are advice and do not change the gate.`,
  ];
}

function lintUnavailable(reason: string): string {
  return oneLine(`Lint is unavailable, and the gate does not use it: ${reason}`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, MAX_LINT_LINE_CHARS);
}

export function boundedToolResult(value: Record<string, JsonValue>): string {
  const serialized = stableJson(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES)
    return stableJson({ ok: false, error: "Tool result exceeded byte limit" });
  return serialized;
}

function assertExactKeys(tool: string, value: Record<string, unknown>, expected: string[]): void {
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (!missing.length && !unknown.length) return;
  const problems = [
    ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
    ...(unknown.length ? [`unknown ${unknown.map((key) => key.slice(0, 64)).join(", ")}`] : []),
  ];
  throw new Error(
    `${tool} arguments must contain exactly: ${expected.join(", ") || "no fields"} (${problems.join("; ")})`,
  );
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Names what is wrong with a guard hash, so that the builder can correct it. */
function hashError(tool: string, value: unknown): string {
  const sent =
    typeof value !== "string"
      ? `a ${value === null ? "null" : typeof value} value`
      : value.length !== 64
        ? `${value.length} characters`
        : "characters other than 0-9 and a-f";
  return `${tool} expectedHash must be the exact 64-character lowercase SHA-256 that workspace.read, workspace.list or your last edit returned for this file. You sent ${sent}. Copy the hash again without changes.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
}

/** Every builder tool, in the canonical order of `BUILDER_TOOL_NAMES`. */
export const BUILDER_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: "workspace.list",
    description:
      "Inspect the immutable public Rojo seed scene with exact hierarchy, declared classes, literal properties, source mappings and project SHA-256; list editable Luau source files with their hashes. The scene is read-only setup data.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workspace.read",
    description: "Read one editable Luau source file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.search",
    description: "Search editable Luau source for exact text; return up to 100 matching lines.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.patch",
    description:
      "Replace exactly one occurrence of before in a source file, guarded by its current SHA-256.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        before: { type: "string" },
        after: { type: "string" },
      },
      required: ["path", "expectedHash", "before", "after"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.write",
    description: "Replace source using its current hash, or create an absent source with null.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedHash: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
      },
      required: ["path", "content", "expectedHash"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace.verify",
    description: "Run the fixed local candidate gate.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workspace.finish",
    description: "Stop editing and submit the exact workspace candidate.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "development.run",
    description:
      "Snapshot the current candidate, run a registered public Studio scenario in the isolated Evals login, and return bound runtime observations and rendered frames. This consumes one development run.",
    parameters: {
      type: "object",
      properties: { scenarioId: { type: "string" } },
      required: ["scenarioId"],
      additionalProperties: false,
    },
  },
  {
    name: "development.inspect",
    description:
      "Read one to four original rendered frames from a previous verified public development result.",
    parameters: {
      type: "object",
      properties: {
        evidenceId: { type: "string" },
        frameIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
      },
      required: ["evidenceId", "frameIds"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.list",
    description:
      "List the frozen API notes: general public Roblox and Luau reference files, with the title, size and SHA-256 of each file.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notes.read",
    description: "Read one API notes file by its listed path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

/**
 * The definitions of a tool set, in the canonical order. Each harness sends only its own tools.
 * Only a harness with lint feedback changes the description of `workspace.verify`.
 */
export function toolDefinitions(
  harness: Pick<HarnessDefinition, "tools" | "verifyLint">,
): ModelToolDefinition[] {
  return BUILDER_TOOL_DEFINITIONS.filter((definition) =>
    harness.tools.includes(definition.name as BuilderToolName),
  ).map((definition) => {
    const copy = structuredClone(definition);
    if (definition.name === "workspace.verify" && harness.verifyLint)
      copy.description = `${definition.description} The result also has lint lines from luau-lsp for these codes: ${harness.verifyLint.codes.join(", ")}. It lists at most ${MAX_LINT_FINDING_LINES} findings as file:line: Code: message, then a count line. Lint findings are advice and do not change the gate.`;
    return copy;
  });
}
