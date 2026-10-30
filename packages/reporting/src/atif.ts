import type { JsonValue } from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";
import type { BuildHistory, BuildTurn } from "../../contracts/src/build-history.js";

/** The exact ATIF version of each exported trajectory (Harbor RFC 0001). */
export const ATIF_SCHEMA_VERSION = "ATIF-v1.7";

/** The fields of ATIF v1.7. Each object of the format forbids other fields. */
interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, JsonValue>;
  extra?: Record<string, JsonValue>;
}
interface AtifObservationResult {
  source_call_id?: string;
  content?: string;
  extra?: Record<string, JsonValue>;
}
interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, JsonValue>;
}
interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  message: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifMetrics;
  llm_call_count?: number;
  extra?: Record<string, JsonValue>;
}
interface AtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  session_id?: string;
  agent: {
    name: string;
    version: string;
    model_name?: string;
    tool_definitions?: Array<Record<string, JsonValue>>;
    extra?: Record<string, JsonValue>;
  };
  steps: AtifStep[];
  notes?: string;
  final_metrics?: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_cached_tokens: number;
    total_cost_usd: number;
    total_steps: number;
  };
  extra?: Record<string, JsonValue>;
}

export interface AtifOptions {
  /** The version of the Basalt builder harness, for example its code commit. */
  agentVersion: string;
  /** The tools that the builder could call, in the provider-neutral form of Basalt. */
  tools: Array<{ name: string; description: string; parameters: unknown }>;
}

/** Copy only the fields with a value. ATIF readers expect absent fields, not nulls. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  ) as Partial<T>;
}

function agentStep(turn: BuildTurn, stepId: number): AtifStep {
  const called = ["assistant", "provider_error", "invalid_model_response"].includes(
    turn.responseKind,
  );
  const metrics = defined({
    prompt_tokens: turn.tokens.input,
    completion_tokens: turn.tokens.output,
    cached_tokens: turn.tokens.cacheRead,
    cost_usd: turn.chargeUsd,
    extra: turn.tokens.reasoning === null ? null : { reasoning_tokens: turn.tokens.reasoning },
  }) as AtifMetrics;
  const results = turn.toolCalls.flatMap((call) =>
    call.result === null
      ? []
      : [
          defined({
            source_call_id: call.id,
            content: call.result,
            extra: call.images.length
              ? { basalt: { imageHashes: call.images.map((image) => image.hash) } }
              : null,
          }) as AtifObservationResult,
        ],
  );
  return defined({
    step_id: stepId,
    timestamp: turn.at,
    source: "agent" as const,
    model_name: turn.resolvedModel,
    message: turn.text ?? "",
    tool_calls: turn.toolCalls.length
      ? turn.toolCalls.map((call) => ({
          tool_call_id: call.id,
          function_name: call.name,
          arguments: isRecord(call.arguments) ? (call.arguments as Record<string, JsonValue>) : {},
        }))
      : null,
    observation: results.length ? { results } : null,
    // A turn without a model call has no metrics.
    metrics: called && Object.keys(metrics).length ? metrics : null,
    llm_call_count: called ? 1 : 0,
    extra: {
      basalt: {
        turn: turn.number,
        responseKind: turn.responseKind,
        verified: turn.verified,
        stopReason: turn.stopReason,
        requestId: turn.requestId,
        tries: turn.tries,
        latencyMs: turn.latencyMs,
        rejectedBatch: turn.rejectedBatch,
        changes: turn.toolCalls.flatMap((call) =>
          call.change
            ? [
                {
                  toolCallId: call.id,
                  path: call.change.path,
                  kind: call.change.kind,
                  beforeHash: call.change.beforeHash,
                  afterHash: call.change.afterHash,
                  verified: call.change.verified,
                },
              ]
            : [],
        ),
        luauErrors: turn.toolCalls.flatMap((call) => call.luauErrors),
      },
    },
  }) as AtifStep;
}

/**
 * The ATIF trajectory of one build: a system step, a user step for the prompt, a user step for
 * a repair context, and one agent step for each turn. Steps count from 1. Only agent steps have
 * metrics. The trajectory has final metrics only when every counter of every model call is
 * known. Facts that ATIF does not define stay in `extra`.
 */
export function atifTrajectory(history: BuildHistory, options: AtifOptions): AtifTrajectory {
  const steps: AtifStep[] = [
    { step_id: 1, source: "system", message: history.systemPrompt },
    defined({
      step_id: 2,
      timestamp: history.turns[0]?.at,
      source: "user" as const,
      message: history.prompt,
    }) as AtifStep,
  ];
  if (history.context)
    steps.push({
      step_id: steps.length + 1,
      source: "user",
      message: history.context.text,
      extra: { basalt: { imageHashes: history.context.images.map((image) => image.hash) } },
    });
  for (const turn of history.turns) steps.push(agentStep(turn, steps.length + 1));
  const calls = steps.filter((step) => step.llm_call_count === 1);
  const total = (field: keyof Omit<AtifMetrics, "extra">) =>
    calls.every((step) => typeof step.metrics?.[field] === "number")
      ? calls.reduce((sum, step) => sum + (step.metrics![field] as number), 0)
      : null;
  const totals = {
    total_prompt_tokens: total("prompt_tokens"),
    total_completion_tokens: total("completion_tokens"),
    total_cached_tokens: total("cached_tokens"),
    total_cost_usd: total("cost_usd"),
  };
  return defined({
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: `${history.operationId}/${history.subjectId}`,
    agent: {
      name: "basalt-builder",
      version: options.agentVersion,
      model_name: history.model,
      tool_definitions: options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as JsonValue,
        },
      })),
      extra: { basalt: { harness: history.harness } },
    },
    steps,
    notes:
      "Exported by Basalt from the saved checkpoint of one build. The steps hold only what the builder saw.",
    final_metrics: Object.values(totals).every((value) => value !== null)
      ? { ...(totals as Record<keyof typeof totals, number>), total_steps: steps.length }
      : null,
    extra: {
      basalt: {
        operationId: history.operationId,
        subjectId: history.subjectId,
        finished: history.finished,
        status: history.status,
        stopReason: history.stopReason,
        sealedMatch: history.sealedMatch,
        notices: history.notices,
      },
    },
  }) as AtifTrajectory;
}
