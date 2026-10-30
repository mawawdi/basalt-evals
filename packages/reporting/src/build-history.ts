import {
  contentHash,
  stableJson,
  type AgentTraceEvent,
  type JsonValue,
} from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";
import type {
  BuildChange,
  BuildHistory,
  BuildHistoryPage,
  BuildToolCall,
  BuildTurn,
} from "../../contracts/src/build-history.js";
import { lineDiff } from "./text-diff.js";

/** A page shows at most this many characters of one tool result. */
const MAX_PAGE_RESULT_CHARS = 20_000;

/** One message of the saved builder conversation. */
export type BuilderMessage =
  | {
      role: "user";
      content: string;
      images?: Array<{ hash: string; mediaType: string; dataBase64: string }>;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
      continuation?: unknown;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** One ledger request of the builder stage, with its ordinal and its saved response facts. */
export interface BuilderLedgerRequest {
  requestId: string;
  ordinal: number;
  requestHash: string;
  status: "pending" | "billed";
  billedUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  resultKind: string | null;
}

export interface BuildHistoryInput {
  operationId: string;
  subjectId: string;
  model: string;
  harness: string;
  systemPrompt: string;
  /** The latest checkpoint of the build: the final one when the build finished. */
  checkpoint: { conversation: BuilderMessage[]; trace: AgentTraceEvent[] };
  /** The saved result of a finished build, with its sealed files. */
  run: { status: string; stopReason: string; files: Array<{ path: string; hash: string }> } | null;
  /** The files that the build started from: the task seed or the repair parent. */
  start: { files: Array<{ path: string; hash: string }>; sources: Record<string, string> };
  requests: BuilderLedgerRequest[];
}

type Chain = Map<string, { hash: string; content: string | null }>;

/** The user message with the frames of one development observation names that observation. */
const DEVELOPMENT_FRAMES = /^Development frames for ([a-z0-9-]+):/u;

const sentKinds = new Set(["assistant", "provider_error", "invalid_model_response"]);

function parse(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
const number = (value: unknown) => (typeof value === "number" ? value : null);
const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The development frames that the builder saw after its own development tool calls, by hash.
 * These are the images that the history shows. A context image or another image is not here.
 */
export function developmentFrames(
  conversation: BuilderMessage[],
): Map<string, { hash: string; mediaType: string; dataBase64: string }> {
  const frames = new Map<string, { hash: string; mediaType: string; dataBase64: string }>();
  // The frames of an observation follow the result of its tool call, before the next answer.
  let observed = new Set<string>();
  for (const message of conversation) {
    if (message.role === "assistant") observed = new Set();
    else if (message.role === "tool") {
      const evidenceId = message.name.startsWith("development.")
        ? parse(message.content)?.evidenceId
        : null;
      if (typeof evidenceId === "string") observed.add(evidenceId);
    } else {
      const evidenceId = DEVELOPMENT_FRAMES.exec(message.content)?.[1];
      if (evidenceId !== undefined && observed.has(evidenceId))
        for (const image of message.images ?? []) frames.set(image.hash, image);
    }
  }
  return frames;
}

/**
 * How one build was built. The history has only what the builder saw: the prompts, its own
 * messages, its tool calls and the tool results. Each change is checked against its traced
 * hashes and the hash chain from the start files to the saved code of the build.
 */
export function buildHistory(input: BuildHistoryInput): BuildHistory {
  const { conversation, trace } = input.checkpoint;
  const notices: string[] = [];
  const first = conversation[0];
  const prompt = first?.role === "user" ? first.content : "";
  const second = conversation[1];
  const context =
    second?.role === "user"
      ? {
          text: second.content,
          images: (second.images ?? []).map((image) => ({
            hash: image.hash,
            mediaType: image.mediaType,
          })),
        }
      : null;
  const turnEvents = new Map<
    number,
    { request: AgentTraceEvent | null; responses: AgentTraceEvent[] }
  >();
  const calls = new Map<string, AgentTraceEvent>(),
    results = new Map<string, AgentTraceEvent>(),
    rejections = new Set<string>();
  for (const event of trace) {
    if (event.kind === "model_request" || event.kind === "model_response") {
      const turn = Number(event.data.turn);
      const entry = turnEvents.get(turn) ?? { request: null, responses: [] };
      if (event.kind === "model_request") entry.request ??= event;
      else entry.responses.push(event);
      turnEvents.set(turn, entry);
    }
    if (event.kind === "tool_call") calls.set(String(event.data.id), event);
    if (event.kind === "tool_result") results.set(String(event.data.id), event);
    if (event.kind === "tool_rejection") rejections.add(String(event.data.responseHash));
  }
  const assistants = conversation.flatMap((message, index) =>
    message.role === "assistant" ? [index] : [],
  );
  const chain: Chain = new Map(
    input.start.files.map((file) => {
      const source = input.start.sources[file.path];
      return [
        file.path,
        {
          hash: file.hash,
          content: source !== undefined && contentHash(source) === file.hash ? source : null,
        },
      ];
    }),
  );
  let assistant = 0;
  const turns: BuildTurn[] = [...turnEvents.entries()]
    .sort(([left], [right]) => left - right)
    .map(([number_, events]) => {
      const response = events.responses.at(-1) ?? null;
      const data = response?.data ?? {};
      const responseKind = text(data.kind) ?? "no_response";
      const turn: BuildTurn = {
        number: number_,
        at: events.request?.at ?? response?.at ?? null,
        responseKind,
        text: null,
        verified: false,
        stopReason: text(data.stopReason),
        resolvedModel: text(data.resolvedModel),
        rejectedBatch: false,
        toolCalls: [],
        tokens: {
          input: number(data.inputTokens),
          output: number(data.outputTokens),
          reasoning: number(data.reasoningTokens),
          cacheRead: number(data.cacheReadTokens),
        },
        chargeUsd: null,
        latencyMs: number(data.latencyMs),
        requestId: null,
        tries: 0,
      };
      if (responseKind !== "assistant") return turn;
      const index = assistants[assistant++];
      const message = index === undefined ? undefined : conversation[index];
      if (index === undefined || !message || message.role !== "assistant") return turn;
      turn.verified = contentHash(stableJson(message)) === data.responseHash;
      turn.text = turn.verified ? message.content : null;
      turn.rejectedBatch = rejections.has(String(data.responseHash));
      // The tool results and the frame messages of this batch come before the next answer.
      const following: BuilderMessage[] = [];
      for (let next = index + 1; next < conversation.length; next++) {
        if (conversation[next]!.role === "assistant") break;
        following.push(conversation[next]!);
      }
      turn.toolCalls = message.toolCalls.map((call) =>
        toolCall(call, turn.verified, following, calls, results, chain),
      );
      for (const frames of following) {
        if (frames.role !== "user") continue;
        const evidenceId = DEVELOPMENT_FRAMES.exec(frames.content)?.[1];
        const owner = turn.toolCalls.find(
          (call) =>
            call.name.startsWith("development.") &&
            call.result !== null &&
            parse(call.result)?.evidenceId === evidenceId,
        );
        if (!owner) continue;
        owner.images = frames.images?.length
          ? frames.images.map((image) => ({ hash: image.hash, mediaType: image.mediaType }))
          : [...frames.content.matchAll(/sha256=([a-f0-9]{64})/gu)].map((match) => ({
              hash: match[1]!,
              mediaType: null,
            }));
      }
      return turn;
    });
  linkRequests(turns, turnEvents, input.requests);
  if (turns.some((turn) => sentKinds.has(turn.responseKind) && turn.requestId === null))
    notices.push(
      "Some turns have no request link, because the saved turns and the spending records don't agree.",
    );
  let sealedMatch: boolean | null = null;
  if (input.run) {
    const expected = new Map(input.run.files.map((file) => [file.path, file.hash]));
    sealedMatch =
      expected.size === chain.size &&
      [...chain.entries()].every(([path, file]) => expected.get(path) === file.hash);
    if (!sealedMatch) {
      notices.push(
        "The changes don't end at the saved code of this build, so Basalt can't verify them.",
      );
      for (const turn of turns)
        for (const call of turn.toolCalls)
          if (call.change?.verified) {
            call.change = unverified(call.change);
            call.arguments = withoutContent(call.arguments);
          }
    }
  } else notices.push("This build hasn't finished. The history shows the turns so far.");
  if (turns.some((turn) => turn.responseKind === "assistant" && !turn.verified))
    notices.push(
      "Some saved answers of the model don't match their recorded hashes, so Basalt doesn't show them.",
    );
  const changes = turns.flatMap((turn) => turn.toolCalls.flatMap((call) => call.change ?? []));
  return {
    operationId: input.operationId,
    subjectId: input.subjectId,
    model: input.model,
    harness: input.harness,
    systemPrompt: input.systemPrompt,
    prompt,
    context,
    finished: input.run !== null,
    status: input.run?.status ?? null,
    stopReason: input.run?.stopReason ?? null,
    sealedMatch,
    notices,
    turns,
    totals: {
      turns: turns.length,
      toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0),
      changes: changes.length,
      unverifiedChanges: changes.filter((change) => !change.verified).length,
    },
  };
}

function toolCall(
  call: { id: string; name: string; arguments: unknown },
  verified: boolean,
  following: BuilderMessage[],
  calls: Map<string, AgentTraceEvent>,
  results: Map<string, AgentTraceEvent>,
  chain: Chain,
): BuildToolCall {
  const traced = calls.get(call.id)?.data,
    resultEvent = results.get(call.id)?.data;
  const reply = following.find(
    (message): message is Extract<BuilderMessage, { role: "tool" }> =>
      message.role === "tool" && message.toolCallId === call.id,
  );
  // A traced result binds the text that the builder saw. Basalt hides a text that differs.
  const result =
    reply && (!resultEvent || resultEvent.resultHash === contentHash(reply.content))
      ? reply.content
      : null;
  const parsed = result === null ? null : parse(result);
  const ok = parsed ? parsed.ok === true : null;
  const args: JsonValue = verified
    ? ((call.arguments ?? {}) as JsonValue)
    : ((traced?.arguments ?? {}) as JsonValue);
  const luauErrors =
    call.name === "workspace.verify" && parsed?.ok === true && parsed.gate !== "eligible"
      ? (Array.isArray(parsed.reasons) ? parsed.reasons : []).filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [];
  const change =
    (call.name === "workspace.write" || call.name === "workspace.patch") && resultEvent?.ok === true
      ? applyChange(call, verified, traced, resultEvent, chain)
      : null;
  return {
    id: call.id,
    name: call.name,
    arguments: change && !change.verified ? withoutContent(args) : args,
    result,
    ok,
    luauErrors,
    change,
    images: [],
  };
}

/** Apply one successful write or patch to the hash chain and describe it as a change. */
function applyChange(
  call: { name: string; arguments: unknown },
  verified: boolean,
  traced: Record<string, JsonValue> | undefined,
  resultEvent: Record<string, JsonValue>,
  chain: Chain,
): BuildChange {
  const args = isRecord(call.arguments) ? call.arguments : {};
  const tracedArgs = isRecord(traced?.arguments) ? traced.arguments : {};
  const path = String(verified ? args.path : tracedArgs.path);
  const resultHash = isRecord(resultEvent.result) ? text(resultEvent.result.hash) : null;
  const current = chain.get(path);
  const before = current?.content ?? (current ? null : "");
  const expectedHash = verified ? args.expectedHash : tracedArgs.expectedHash;
  let after: string | null = null;
  if (verified && call.name === "workspace.write" && typeof args.content === "string")
    after = args.content;
  if (
    verified &&
    call.name === "workspace.patch" &&
    before !== null &&
    typeof args.before === "string" &&
    typeof args.after === "string"
  ) {
    const start = before.indexOf(args.before);
    if (start >= 0 && before.indexOf(args.before, start + args.before.length) < 0)
      after = before.slice(0, start) + args.after + before.slice(start + args.before.length);
  }
  const afterHash = after === null ? (resultHash ?? "") : contentHash(after);
  const valid =
    after !== null &&
    before !== null &&
    resultHash === afterHash &&
    expectedHash === (current?.hash ?? null) &&
    (call.name !== "workspace.write" || tracedArgs.contentHash === afterHash);
  chain.set(path, { hash: resultHash ?? afterHash, content: valid ? after : null });
  const change: BuildChange = {
    path,
    kind: current ? "replaced" : "created",
    beforeHash: current?.hash ?? null,
    afterHash: resultHash ?? afterHash,
    verified: false,
    added: null,
    removed: null,
    hunks: null,
    tooLarge: false,
  };
  if (!valid) return change;
  const diff = lineDiff(before!, after!);
  return diff.tooLarge
    ? { ...change, verified: true, tooLarge: true }
    : { ...change, verified: true, added: diff.added, removed: diff.removed, hunks: diff.hunks };
}

function unverified(change: BuildChange): BuildChange {
  return { ...change, verified: false, added: null, removed: null, hunks: null, tooLarge: false };
}

/** The arguments of a write or a patch without the source text. */
function withoutContent(value: JsonValue): JsonValue {
  if (!isRecord(value)) return value;
  const { content: _content, before: _before, after: _after, ...rest } = value;
  return rest as JsonValue;
}

/**
 * Link each turn to its ledger request. The requests of the builder stage have consecutive
 * ordinals. A turn takes the requests with its request hash: the tries after a rate limit,
 * then its answer. The saved latency and token counts must agree. After a disagreement no
 * later turn gets a link.
 */
function linkRequests(
  turns: BuildTurn[],
  events: Map<number, { request: AgentTraceEvent | null }>,
  requests: BuilderLedgerRequest[],
) {
  const ordered = [...requests].sort((left, right) => left.ordinal - right.ordinal);
  let aligned = ordered.every((request, index) => request.ordinal === index + 1);
  let cursor = 0;
  for (const turn of turns) {
    const hash = events.get(turn.number)?.request?.data.requestHash;
    const tries: BuilderLedgerRequest[] = [];
    while (cursor < ordered.length && ordered[cursor]!.requestHash === hash)
      tries.push(ordered[cursor++]!);
    turn.tries = tries.length;
    const answer = tries.at(-1);
    const agree =
      aligned &&
      sentKinds.has(turn.responseKind) &&
      answer !== undefined &&
      tries
        .slice(0, -1)
        .every(
          (attempt) =>
            attempt.resultKind === "provider_error" &&
            attempt.status === "billed" &&
            attempt.billedUsd === 0,
        ) &&
      answer.latencyMs === turn.latencyMs &&
      answer.inputTokens === turn.tokens.input &&
      answer.outputTokens === turn.tokens.output;
    if (!agree) {
      if (tries.length || sentKinds.has(turn.responseKind)) aligned = false;
      continue;
    }
    turn.requestId = answer.requestId;
    turn.chargeUsd = tries.every((attempt) => attempt.status === "billed")
      ? tries.reduce((sum, attempt) => sum + (attempt.billedUsd ?? 0), 0)
      : null;
  }
}

/** One page of turns. A page leaves out the source text that its changes already show. */
export function buildHistoryPage(
  history: BuildHistory,
  page: number,
  pageSize = 10,
): BuildHistoryPage {
  const pages = Math.max(1, Math.ceil(history.turns.length / pageSize));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  return {
    ...history,
    page: current,
    pages,
    pageSize,
    turns: history.turns.slice((current - 1) * pageSize, current * pageSize).map((turn) => ({
      ...turn,
      toolCalls: turn.toolCalls.map((call) => ({
        ...call,
        arguments: call.change ? withoutContent(call.arguments) : call.arguments,
        result:
          call.result !== null && call.result.length > MAX_PAGE_RESULT_CHARS
            ? `${call.result.slice(0, MAX_PAGE_RESULT_CHARS)}\n[Basalt shows the first ${MAX_PAGE_RESULT_CHARS.toLocaleString("en-US")} characters of this result.]`
            : call.result,
      })),
    })),
  };
}
