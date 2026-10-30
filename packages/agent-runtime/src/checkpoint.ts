import type { AgentRun, AgentTraceEvent, CandidateManifest } from "../../contracts/src/index.js";
import type { ModelMessage, ModelTurnResult } from "../../model-client/src/contracts.js";

export interface AccumulatedAgentUsage {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  providerReportedCostUsd: number | null;
}

/** Durable bounded-attempt state. A resume from it rebuilds the same request hashes. */
export interface BoundedAgentCheckpoint {
  treatmentId: string;
  publicTaskHash: string;
  transportConfigurationHash: string;
  startedAt: string;
  activeElapsedMs: number;
  usage: AccumulatedAgentUsage;
  source: CandidateManifest;
  conversation: ModelMessage[];
  trace: AgentTraceEvent[];
  turn: number;
  remainingTurns: number;
  /** The calls that a provider failure paused. Each one is a call without a turn. */
  pausedCalls: number;
  /** The completed context compactions. Each one is a call without a turn. */
  compactions: number;
  developmentRuns: number;
  recoverableRejections: number;
  seenToolCallIds: string[];
  finishRequested: boolean;
  activeTurn: {
    result: Extract<ModelTurnResult, { kind: "assistant" }>;
    validated: boolean;
    nextToolIndex: number;
    earlierToolFailed: boolean;
  } | null;
  point: "before_model" | "after_model" | "before_tool" | "after_tool" | "finished";
  pendingAction: {
    id: string;
    kind: "model_call" | "workspace_tool" | "public_studio";
    requestHash: string;
    expectedSource: CandidateManifest | null;
  } | null;
  completedRun: AgentRun | null;
}
