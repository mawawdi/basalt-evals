import type { JsonValue } from "./index.js";

/** One line of a change: unchanged context, an added line or a removed line. */
interface BuildChangeLine {
  kind: "context" | "added" | "removed";
  text: string;
}

interface BuildChangeHunk {
  beforeStart: number;
  afterStart: number;
  lines: BuildChangeLine[];
}

/** The change that one tool call made to one source file of the build. */
export interface BuildChange {
  path: string;
  kind: "created" | "replaced";
  beforeHash: string | null;
  afterHash: string;
  /**
   * True only when the written content matches its traced hash, the earlier content matches
   * the hash chain from the seed or the repair parent, and the chain ends at the saved code.
   */
  verified: boolean;
  /** Null when the change is not verified or is too large to show. */
  added: number | null;
  removed: number | null;
  hunks: BuildChangeHunk[] | null;
  tooLarge: boolean;
}

/**
 * An image that the builder saw. Basalt keeps the bytes only of the latest inspection. The build
 * image route serves the bytes of a development frame by its hash.
 */
interface BuildImage {
  hash: string;
  /** Null for an image whose bytes Basalt no longer keeps. */
  mediaType: string | null;
}

export interface BuildToolCall {
  id: string;
  name: string;
  /** The arguments that the builder sent. An unverified change has no content arguments. */
  arguments: JsonValue;
  /** The result text that the builder saw; null when the builder got no result. */
  result: string | null;
  ok: boolean | null;
  /** The reasons of a local check that did not pass, for example Luau type errors. */
  luauErrors: string[];
  change: BuildChange | null;
  /** The development frames that the builder saw after this tool call. */
  images: BuildImage[];
}

export interface BuildTurn {
  number: number;
  /** The time of the model request. */
  at: string | null;
  /** The kind of the final model response, for example "assistant" or "provider_error". */
  responseKind: string;
  /** The assistant text; null when the turn has no verified assistant message. */
  text: string | null;
  /** True when the saved assistant message matches the hash of the model response. */
  verified: boolean;
  stopReason: string | null;
  resolvedModel: string | null;
  /** True when the builder sent a batch of tool calls that Basalt refused. */
  rejectedBatch: boolean;
  toolCalls: BuildToolCall[];
  tokens: {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
  };
  /** The confirmed charge of the requests of the turn; null when one is unknown. */
  chargeUsd: number | null;
  latencyMs: number | null;
  /** The ledger request of the answer; null when the turn and the ledger do not agree. */
  requestId: string | null;
  /** The ledger requests of the turn, with the tries after a rate limit. */
  tries: number;
}

/** How one build was built: only what the builder saw, checked against the saved records. */
export interface BuildHistory {
  operationId: string;
  subjectId: string;
  model: string;
  harness: string;
  systemPrompt: string;
  prompt: string;
  context: { text: string; images: BuildImage[] } | null;
  /** True when the build has a final checkpoint. */
  finished: boolean;
  status: string | null;
  stopReason: string | null;
  /** True when the hash chain of the changes ends at the saved code of the build. */
  sealedMatch: boolean | null;
  notices: string[];
  turns: BuildTurn[];
  totals: { turns: number; toolCalls: number; changes: number; unverifiedChanges: number };
}

/** One page of turns of a build history. */
export interface BuildHistoryPage extends Omit<BuildHistory, "turns"> {
  turns: BuildTurn[];
  page: number;
  pages: number;
  pageSize: number;
}
