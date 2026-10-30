import type { AccumulatedAgentUsage, BoundedAgentCheckpoint } from "./checkpoint.js";
import {
  AGENT_RUN_SCHEMA,
  assertAgentRun,
  assertPublicTask,
  assertTreatment,
  contentHash,
  hashJson,
  MAX_PROVIDER_PAUSES,
  publicTaskInstructions,
  stableJson,
  type AgentRun,
  type AgentTraceEvent,
  type CandidateManifest,
  type HarnessDefinition,
  type JsonValue,
  type PublicTask,
  type Treatment,
} from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";
// Import transport-neutral contracts directly; the package barrel would load the provider SDK.
import {
  MODEL_CONTINUATION_MAX_BYTES,
  isProviderErrorType,
  modelTurnRequestHash,
  ModelRequestAdmissionError,
  ModelRequestPendingError,
  ModelRequestValidationError,
  validateModelImages,
  type ModelClient,
  type ModelImage,
  type ModelMessage,
  type ModelTurnResult,
  type ModelTurnRequest,
  type ModelUsage,
} from "../../model-client/src/contracts.js";
import { SpendingCeilingError } from "../../model-client/src/ledger.js";
import { ProviderHoldError } from "../../model-client/src/bounded-client.js";
import { classifyProviderFailure } from "../../model-client/src/provider-failure.js";
import type { PauseRecord, ProviderPauseScope } from "../../contracts/src/execution.js";
import {
  boundedToolResult,
  executeTool,
  parseToolCall,
  runVerification,
  toolDefinitions,
  type CandidateVerifier,
  type ParsedToolCall,
  type SourceAnalyzer,
  type VerifyLint,
} from "./tools.js";
import { compactedConversation, compactionRequest, compactionSummary } from "./compaction.js";
import type { NotesPackReader } from "./notes.js";
import { CandidateWorkspace } from "./workspace.js";

export {
  BUILDER_TOOL_DEFINITIONS,
  MAX_TOOL_RESULT_BYTES,
  toolDefinitions,
  type LocalVerification,
  type SourceAnalyzer,
} from "./tools.js";

export const MAX_DEVELOPMENT_SUMMARY_BYTES = 12_000;
const MAX_TRACE_TEXT_BYTES = 128 * 1024;
export const MAX_MODEL_MESSAGE_BYTES = 12 * 1024 * 1024;
export const MAX_CONVERSATION_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_CALLS_PER_TURN = 16;

interface DevelopmentFrame {
  id: string;
  actor: string;
  acquisitionStart: string;
  acquisitionEnd: string;
  image: ModelImage;
}

export interface DevelopmentObservation {
  activeDurationMs?: number;
  evidenceId: string;
  candidateHash: string;
  summary: string;
  frames: DevelopmentFrame[];
}

/** Only public, independently authored recipes may back these callbacks. */
export interface DevelopmentServices {
  publicScenarios: string[];
  maxRuns: number;
  run(
    workspaceRoot: string,
    candidate: CandidateManifest,
    scenarioId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<DevelopmentObservation>;
  recover?(
    workspaceRoot: string,
    candidate: CandidateManifest,
    scenarioId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<DevelopmentObservation>;
  inspect(evidenceId: string, frameIds: string[]): Promise<DevelopmentObservation>;
}

interface AgentRuntimeInput {
  workspaceRoot: string;
  task: PublicTask;
  treatment: Treatment;
  modelClient: ModelClient;
  verify: CandidateVerifier;
  repairContext?: { summary: string; images: ModelImage[] };
  /**
   * The prompts of the earlier stages of a staged evaluation, in order. The workspace holds the
   * build of those stages. Absent for the first stage and for an evaluation without stages.
   */
  earlierPrompts?: string[];
  development?: DevelopmentServices;
  /** The frozen API notes pack. A harness with a notes pack needs it, and others refuse it. */
  notes?: NotesPackReader;
  /**
   * The analyzer of the lint feedback of `workspace.verify`. A harness with `verifyLint` needs
   * it, and others refuse it.
   */
  sourceAnalyzer?: SourceAnalyzer;
  signal?: AbortSignal;
  now?: () => Date;
  checkpoint?: (state: BoundedAgentCheckpoint) => Promise<void>;
  resume?: BoundedAgentCheckpoint;
  retainInterruption?: boolean;
  /** The output allowance of one request. It is at most the output limit of the frozen endpoint set. */
  outputTokens(request: Omit<ModelTurnRequest, "maxOutputTokens">): number;
}

export class AgentBudgetPaused extends Error {}

/** The cause of a provider pause: a failure of a request of this build, or a hold. */
interface ProviderPause {
  scope: ProviderPauseScope;
  errorClass: string;
  /** The pause of another unit that held this build before its request, or null. */
  hold: PauseRecord | null;
}

/**
 * An account, model or persistent provider failure paused the build at its `before_model`
 * checkpoint. Only an explicit resume of the run continues the build.
 */
export class AgentProviderPaused extends Error {
  constructor(readonly pause: ProviderPause) {
    super(
      pause.hold
        ? `An earlier provider failure (${pause.errorClass}) held the build before its next request. Resume the run to continue the build.`
        : `The provider failure ${pause.errorClass} paused the build. Resume the run to continue the build.`,
    );
    this.name = "AgentProviderPaused";
  }
}

export class AgentInterrupted extends Error {
  constructor(
    message = "The build stopped before it finished. To continue the build from this point, resume the run.",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The candidate caused the failure of a public Studio tool, for example Rojo cannot build it.
 * The same candidate gives the same failure, so a recovered call also returns it to the builder.
 */
export class DevelopmentCandidateError extends Error {}

export function builderRequest(input: {
  task: PublicTask;
  harness: HarnessDefinition;
  model: string;
  seed: number;
  messages?: ModelMessage[];
  development?: Pick<DevelopmentServices, "publicScenarios">;
  earlierPrompts?: string[];
}): Omit<ModelTurnRequest, "maxOutputTokens"> {
  return {
    model: input.model,
    seed: input.seed,
    system: input.harness.systemPrompt,
    messages: input.messages ?? [
      {
        role: "user",
        content: builderPrompt(
          input.task,
          input.harness,
          input.development,
          input.earlierPrompts ?? [],
        ),
      },
    ],
    tools: toolDefinitions(input.harness),
    ...harnessRequestReasoning(input.harness),
  };
}

/** `catalog_balanced` sends no policy, so the frozen transport selects the catalog effort. */
export function harnessRequestReasoning(
  harness: Pick<HarnessDefinition, "reasoning">,
): Pick<ModelTurnRequest, "reasoning"> {
  return harness.reasoning.kind === "catalog_balanced"
    ? {}
    : { reasoning: structuredClone(harness.reasoning) };
}

export async function runAgent(input: AgentRuntimeInput): Promise<AgentRun> {
  input = {
    ...input,
    task: structuredClone(input.task),
    treatment: structuredClone(input.treatment),
    ...(input.repairContext ? { repairContext: structuredClone(input.repairContext) } : {}),
  };
  const descriptor = structuredClone(input.modelClient.descriptor);
  assertPublicTask(input.task);
  assertTreatment(input.treatment);
  assertTreatmentMatchesTask(input.treatment, input.task);
  const harness = input.treatment.harness;
  if (harness.developmentRuns > 0 !== !!input.development)
    throw new Error(
      harness.developmentRuns > 0
        ? "This harness requires public Studio development services"
        : "This harness has no Studio development runs and cannot receive development services",
    );
  if (
    input.development &&
    (input.development.maxRuns !== harness.developmentRuns ||
      input.development.publicScenarios.length === 0 ||
      new Set(input.development.publicScenarios).size !== input.development.publicScenarios.length)
  )
    throw new Error("Invalid bounded public development service");
  if (
    (harness.notesPack === null) !== !input.notes ||
    (harness.notesPack &&
      (input.notes!.hash !== harness.notesPack.hash ||
        input.notes!.manifest.id !== harness.notesPack.id))
  )
    throw new Error("The API notes pack differs from the frozen harness");
  if (!harness.verifyLint !== !input.sourceAnalyzer)
    throw new Error(
      harness.verifyLint
        ? "This harness reports lint findings and needs a source analyzer"
        : "This harness has no lint feedback and cannot receive a source analyzer",
    );
  const lint: VerifyLint | null =
    harness.verifyLint && input.sourceAnalyzer
      ? { codes: harness.verifyLint.codes, analyze: input.sourceAnalyzer }
      : null;
  if (hashJson(descriptor) !== input.treatment.transportConfigurationHash)
    throw new Error("Model transport configuration does not match the frozen treatment");
  const now = input.now ?? (() => new Date());
  const resumed = input.resume ? structuredClone(input.resume) : null;
  const startedAt = resumed?.startedAt ?? now().toISOString();
  const activeStarted = now().getTime();
  let elapsedBefore = resumed?.activeElapsedMs ?? 0;
  const activeElapsedMs = () => elapsedBefore + Math.max(0, now().getTime() - activeStarted);
  const recordRecoveredTime = (durationMs: number) => {
    elapsedBefore += durationMs;
  };
  const workspace = new CandidateWorkspace(input.workspaceRoot, input.task.seed);
  await workspace.assertSafe();
  if (resumed) {
    if (
      resumed.treatmentId !== input.treatment.id ||
      resumed.publicTaskHash !== hashJson(input.task) ||
      resumed.transportConfigurationHash !== hashJson(descriptor) ||
      resumed.completedRun ||
      resumed.point === "finished" ||
      !Number.isSafeInteger(resumed.turn) ||
      resumed.turn < 1 ||
      resumed.turn > harness.maxTurns ||
      resumed.remainingTurns !== harness.maxTurns - resumed.turn ||
      !Number.isFinite(Date.parse(resumed.startedAt)) ||
      !Number.isSafeInteger(resumed.pausedCalls) ||
      resumed.pausedCalls < 0 ||
      !Number.isSafeInteger(resumed.compactions) ||
      resumed.compactions < 0 ||
      resumed.compactions >
        (harness.compaction.kind === "summarize_at" ? harness.compaction.maxSummaries : 0) ||
      resumed.usage.calls !==
        resumed.turn -
          (resumed.point === "before_model" ? 1 : 0) +
          resumed.pausedCalls +
          resumed.compactions ||
      (resumed.point === "before_model") !== (resumed.activeTurn === null)
    )
      throw new Error("Checkpoint does not describe this bounded public attempt");
    const current = await workspace.manifest(input.task.seed.projectFile);
    if (
      hashJson(current) !== hashJson(resumed.source) &&
      !(
        resumed.point === "before_tool" &&
        resumed.pendingAction?.expectedSource &&
        hashJson(current) === hashJson(resumed.pendingAction.expectedSource)
      )
    )
      throw new Error("Workspace differs from the checkpoint and its exact pending write");
    if (
      resumed.point === "before_tool" &&
      resumed.pendingAction?.kind === "public_studio" &&
      !input.development?.recover
    )
      throw new Error(
        "Interrupted public Studio action needs a bound acquisition receipt; it cannot be repeated",
      );
  }
  const trace: AgentTraceEvent[] = resumed?.trace ?? [];
  const usage = resumed?.usage ?? emptyUsage();
  const messages: ModelMessage[] = resumed?.conversation ?? [
    {
      role: "user",
      content: builderPrompt(input.task, harness, input.development, input.earlierPrompts ?? []),
    },
  ];
  if (input.repairContext && !resumed) {
    if (
      typeof input.repairContext.summary !== "string" ||
      !input.repairContext.summary.trim() ||
      Buffer.byteLength(input.repairContext.summary, "utf8") > 8_192
    )
      throw new Error("Repair context must be a bounded development report");
    if (input.repairContext.images.length > 4)
      throw new Error("Repair context exceeds four quoted public frames");
    validateModelImages(input.repairContext.images);
    messages.push({
      role: "user",
      content: input.repairContext.summary,
      images: input.repairContext.images,
    });
  }
  let sequence = trace.at(-1)?.sequence ?? 0;
  // The request helpers below also set the stop, so the declared type keeps every stop reason.
  let stopReason = "turn_limit" as AgentRun["stopReason"];
  let failure: AgentRun["failure"] | undefined;
  let finishRequested = resumed?.finishRequested ?? false;
  let developmentRuns = resumed?.developmentRuns ?? 0;
  let recoverableRejections = resumed?.recoverableRejections ?? 0;
  let pausedCalls = resumed?.pausedCalls ?? 0;
  let compactions = resumed?.compactions ?? 0;
  let activeTurn = resumed?.activeTurn ?? null;
  const seenToolCallIds = new Set<string>(resumed?.seenToolCallIds ?? []);
  let recoveringAction = resumed?.pendingAction ?? null;

  const record = (kind: AgentTraceEvent["kind"], data: Record<string, JsonValue>): void => {
    sequence += 1;
    trace.push({ sequence, at: now().toISOString(), kind, data });
  };
  // Each pause and each hold of the build counts against its pause limit.
  const providerPauses = () =>
    trace.filter(
      (event) =>
        event.kind === "model_response" &&
        (event.data.kind === "provider_paused" || event.data.kind === "provider_hold"),
    ).length;

  const checkpoint = async (
    turn: number,
    point: BoundedAgentCheckpoint["point"],
    pendingAction: BoundedAgentCheckpoint["pendingAction"] = null,
    completedRun: AgentRun | null = null,
  ) => {
    if (!input.checkpoint) return;
    await input.checkpoint(
      structuredClone({
        treatmentId: input.treatment.id,
        publicTaskHash: hashJson(input.task),
        transportConfigurationHash: hashJson(descriptor),
        startedAt,
        activeElapsedMs: activeElapsedMs(),
        usage,
        source: await workspace.manifest(input.task.seed.projectFile),
        conversation: messages,
        trace,
        turn,
        remainingTurns: Math.max(0, harness.maxTurns - turn),
        pausedCalls,
        compactions,
        developmentRuns,
        recoverableRejections,
        seenToolCallIds: [...seenToolCallIds],
        finishRequested,
        activeTurn,
        point,
        pendingAction,
        completedRun,
      }),
    );
  };

  /**
   * Send one request of the build: a turn or a compaction. It returns the assistant answer, or
   * null when the request ended the build. A pause throws after its checkpoint.
   */
  const dispatch = async (
    content: Omit<ModelTurnRequest, "maxOutputTokens">,
    turn: number,
    compaction: boolean,
  ): Promise<Extract<ModelTurnResult, { kind: "assistant" }> | null> => {
    const maxOutputTokens = input.outputTokens(content);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
      throw new Error("Builder output allowance must come from the frozen endpoint set");
    const request: ModelTurnRequest = { ...content, maxOutputTokens };
    const requestHash = modelTurnRequestHash(request, descriptor);
    const recoveringModel = recoveringAction?.kind === "model_call";
    if (recoveringAction) {
      if (recoveringAction.kind !== "model_call" || recoveringAction.requestHash !== requestHash)
        throw new Error("Pending model request differs from its checkpoint");
      recoveringAction = null;
    } else
      record("model_request", {
        turn,
        ...(compaction ? { kind: "compaction" } : {}),
        requestHash,
        messageCount: content.messages.length,
      });
    let result: ModelTurnResult;
    await checkpoint(turn, "before_model", {
      id: compaction ? `compaction-${compactions + 1}` : `model-${turn}`,
      kind: "model_call",
      requestHash,
      expectedSource: null,
    });
    await workspace.assertProjectUnchanged();
    try {
      // Adapters own their request/response copies, never the live conversation
      // or global tool definitions used by subsequent turns.
      result = structuredClone(
        await input.modelClient.complete(structuredClone(request), input.signal),
      );
      if (recoveringModel) recordRecoveredTime(result.responseFacts?.latencyMs ?? 0);
    } catch (error) {
      const hold =
        error instanceof ModelRequestAdmissionError && error.cause instanceof ProviderHoldError
          ? error.cause.record
          : null;
      if (input.retainInterruption && hold) {
        // The pause of another unit holds this build before dispatch. No call occurred.
        if (providerPauses() < MAX_PROVIDER_PAUSES) {
          record("model_response", {
            turn,
            kind: "provider_hold",
            scope: hold.scope,
            errorClass: hold.errorClass,
            requestHash,
          });
          await checkpoint(turn, "before_model");
          throw new AgentProviderPaused({ scope: hold.scope, errorClass: hold.errorClass, hold });
        }
        record("model_response", {
          turn,
          kind: "admission_blocked",
          errorClass: "provider_pause_limit",
          requestHash,
        });
        stopReason = "provider_error";
        failure = {
          classification: "provider_or_transport_failure",
          detail: `The provider paused this build ${MAX_PROVIDER_PAUSES} times. The build is incomplete.`,
        };
        return null;
      }
      if (input.retainInterruption && error instanceof ModelRequestAdmissionError) {
        // Admission failed before reserving or dispatching this request. Keep
        // the unfinished build without inventing a call or an uncertain receipt.
        record("model_response", {
          turn,
          kind: "admission_blocked",
          errorClass: "local_request_admission",
          requestHash,
        });
        await checkpoint(turn, "before_model");
        throw new AgentInterrupted(error.message);
      }
      if (
        error instanceof AgentInterrupted ||
        (input.retainInterruption && error instanceof ModelRequestPendingError)
      )
        throw error;
      const spendingStop = error instanceof SpendingCeilingError;
      if (spendingStop && input.retainInterruption) {
        record("model_response", {
          turn,
          kind: "spending_limit",
          errorClass: "spending_ceiling",
          requestHash,
        });
        await checkpoint(turn, "before_model");
        throw new AgentBudgetPaused(
          "The run reached its spending limit before the next request for this build. Increase the spending limit to continue, or stop the run.",
        );
      }
      const locallyRejected =
        error instanceof ModelRequestValidationError || error instanceof ModelRequestAdmissionError;
      const cancelled = input.signal?.aborted ?? false;
      if (!spendingStop && !locallyRejected) usage.calls += 1;
      stopReason = cancelled ? "cancelled" : spendingStop ? "spending_limit" : "provider_error";
      failure = cancelled
        ? {
            classification: "budget_or_stop_failure",
            detail: "Agent run cancelled during a model request",
          }
        : spendingStop
          ? { classification: "budget_or_stop_failure", detail: error.message }
          : locallyRejected
            ? { classification: "harness_context_failure", detail: error.message }
            : {
                classification: "provider_or_transport_failure",
                detail: "Model client threw before returning a validated response",
              };
      record("model_response", {
        turn,
        kind: cancelled ? "cancelled" : spendingStop ? "spending_limit" : "provider_error",
        errorClass: cancelled
          ? "aborted_request"
          : spendingStop
            ? "spending_ceiling"
            : locallyRejected
              ? "local_request_validation"
              : "client_exception",
        requestHash,
      });
      return null;
    }
    usage.calls += 1;
    try {
      assertModelTurnResult(
        result,
        input.treatment.model.id,
        input.treatment.model.responseModelId,
        descriptor.transport,
        requestHash,
      );
    } catch (error) {
      stopReason = "provider_error";
      failure = {
        classification: "provider_or_transport_failure",
        detail: `Model client violated its result contract: ${errorMessage(error)}`,
      };
      record("model_response", {
        turn,
        kind: "invalid_model_response",
        errorClass: "client_contract",
        requestHash,
      });
      return null;
    }
    addUsage(usage, result.usage);
    if (result.kind !== "assistant") {
      const providerFailure = classifyProviderFailure(result);
      const response = {
        turn,
        kind: result.kind,
        errorClass: result.errorClass,
        ...(result.kind === "provider_error"
          ? { providerErrorType: result.providerErrorType }
          : {}),
        requestHash: result.requestHash,
        ...responseTraceData(result),
      };
      // An account, model or persistent failure pauses the build. The rejected request has a
      // known charge, so a resume sends the same request again as the next request ordinal.
      if (
        input.retainInterruption &&
        providerFailure &&
        providerFailure.scope !== "request" &&
        providerPauses() < MAX_PROVIDER_PAUSES
      ) {
        pausedCalls += 1;
        record("model_response", {
          ...response,
          kind: "provider_paused",
          scope: providerFailure.scope,
        });
        await checkpoint(turn, "before_model");
        throw new AgentProviderPaused({
          scope: providerFailure.scope,
          errorClass: result.errorClass,
          hold: null,
        });
      }
      stopReason = providerFailure?.refusal ? "refusal" : "provider_error";
      failure = {
        classification: providerFailure?.refusal
          ? "model_refusal"
          : "provider_or_transport_failure",
        detail: `${result.errorClass}: ${result.message}`,
      };
      record("model_response", response);
      return null;
    }
    return result;
  };

  /**
   * Replace a long conversation with a summary before the next turn. A compaction is one
   * metered request without a turn. It returns false when its request ended the build.
   */
  const compact = async (turn: number): Promise<boolean> => {
    const content = compactionRequest({
      model: input.treatment.model.id,
      seed: input.treatment.randomSeed,
      messages,
      reasoning: harnessRequestReasoning(harness),
    });
    const beforeBytes = Buffer.byteLength(stableJson(messages), "utf8");
    const result = await dispatch(content, turn, true);
    if (!result) return false;
    const summary = compactionSummary(result);
    record("model_response", {
      turn,
      kind: summary === null ? "invalid_summary" : "compaction",
      stopReason: result.stopReason,
      requestHash: result.requestHash,
      responseHash: result.responseHash,
      toolCalls: result.message.toolCalls.length,
      ...(summary === null ? {} : traceText("summary", summary)),
      ...responseTraceData(result),
    });
    if (summary === null) {
      stopReason = "invalid_tool_call";
      failure = {
        classification: "model_reasoning_failure",
        detail:
          "The context summary was empty, larger than 64 KiB, or did not use the context.summary tool. The build is incomplete.",
      };
      return false;
    }
    compactions += 1;
    const listing = await executeTool(
      { id: `compaction-${compactions}`, name: "workspace.list", arguments: {} },
      workspace,
      input.verify,
      input.task,
    );
    messages.splice(
      0,
      messages.length,
      ...compactedConversation({
        seed: messages[0]!,
        summary,
        compaction: compactions,
        harness,
        workspace: boundedToolResult(listing),
      }),
    );
    record("boundary", {
      turn,
      compaction: compactions,
      requestHash: result.requestHash,
      summaryHash: contentHash(summary),
      beforeBytes,
      afterBytes: Buffer.byteLength(stableJson(messages), "utf8"),
    });
    await checkpoint(turn, "before_model");
    return true;
  };

  turns: for (let turn = resumed?.turn ?? 1; turn <= harness.maxTurns; turn += 1) {
    if (input.signal?.aborted) {
      stopReason = "cancelled";
      failure = {
        classification: "budget_or_stop_failure",
        detail: "Agent run cancelled",
      };
      break;
    }
    if (Buffer.byteLength(stableJson(messages), "utf8") > MAX_CONVERSATION_BYTES) {
      stopReason = "context_limit";
      failure = {
        classification: "harness_context_failure",
        detail: "Agent conversation exceeded the fixed context byte limit",
      };
      break;
    }
    if (!activeTurn) {
      // A compacted conversation has no assistant message, so one summary never follows another.
      // The checkpoint holds each part of this condition, so a resume decides the same way.
      const compaction = harness.compaction;
      if (
        compaction.kind === "summarize_at" &&
        compactions < compaction.maxSummaries &&
        messages.some((message) => message.role === "assistant") &&
        Buffer.byteLength(stableJson(messages), "utf8") > compaction.atBytes &&
        !(await compact(turn))
      )
        break;
      const result = await dispatch(
        builderRequest({
          task: input.task,
          harness,
          model: input.treatment.model.id,
          seed: input.treatment.randomSeed,
          messages,
        }),
        turn,
        false,
      );
      if (!result) break;
      record("model_response", {
        turn,
        kind: result.kind,
        stopReason: result.stopReason,
        requestHash: result.requestHash,
        responseHash: result.responseHash,
        toolCalls: result.message.toolCalls.length,
        ...traceText("assistantText", result.message.content),
        ...responseTraceData(result),
      });

      let messageBytes: number;
      try {
        messageBytes = Buffer.byteLength(stableJson(result.message), "utf8");
      } catch (error) {
        stopReason = "invalid_tool_call";
        failure = {
          classification: "model_reasoning_failure",
          detail: `Model response was not canonical JSON: ${errorMessage(error)}`,
        };
        break;
      }
      if (
        messageBytes > MAX_MODEL_MESSAGE_BYTES ||
        result.message.toolCalls.length > MAX_TOOL_CALLS_PER_TURN
      ) {
        stopReason = "context_limit";
        failure = {
          classification: "harness_context_failure",
          detail:
            messageBytes > MAX_MODEL_MESSAGE_BYTES
              ? "Model response exceeded the fixed message byte limit"
              : `Model requested more than ${MAX_TOOL_CALLS_PER_TURN} tools in one turn`,
        };
        break;
      }
      messages.push(result.message);
      activeTurn = { result, validated: false, nextToolIndex: 0, earlierToolFailed: false };
      await checkpoint(turn, "after_model");
    }
    const result = activeTurn.result;

    if (result.message.toolCalls.length === 0) {
      if (result.stopReason === "refusal") {
        stopReason = "refusal";
        failure = {
          classification: "model_refusal",
          detail: "The model refused the task without a tool call. The build is incomplete.",
        };
        break;
      }
      if (result.stopReason === "max_tokens") {
        stopReason = "output_limit";
        failure = {
          classification: "budget_or_stop_failure",
          detail:
            "The model reached its output limit without a tool call. The build is incomplete.",
        };
        break;
      }
      stopReason = "invalid_tool_call";
      failure = {
        classification: "model_reasoning_failure",
        detail: "Model ended without calling workspace.finish",
      };
      break;
    }

    let parsedCalls: ParsedToolCall[];
    try {
      const callIds = new Set(result.message.toolCalls.map((call) => call.id));
      if (
        result.message.toolCalls.some(
          (call) => typeof call.id !== "string" || call.id.length === 0 || call.id.length > 256,
        )
      )
        throw new Error("Tool call IDs must be non-empty bounded strings");
      if (callIds.size !== result.message.toolCalls.length)
        throw new Error("Tool call IDs must be unique");
      if (
        !activeTurn.validated &&
        result.message.toolCalls.some((call) => seenToolCallIds.has(call.id))
      )
        throw new Error("Tool call IDs must be unique across the run");
      parsedCalls = result.message.toolCalls.map(parseToolCall);
      const unavailable = parsedCalls.find((call) => !harness.tools.includes(call.name));
      if (unavailable) throw new Error(`Tool ${unavailable.name} is not available in this harness`);
      const finishCalls = parsedCalls.filter((call) => call.name === "workspace.finish");
      if (
        finishCalls.length > 1 ||
        (finishCalls.length === 1 && parsedCalls.at(-1)?.name !== "workspace.finish")
      )
        throw new Error(
          "workspace.finish must appear at most once and must be the final tool call",
        );
      for (const call of parsedCalls) seenToolCallIds.add(call.id);
      activeTurn.validated = true;
    } catch (error) {
      // Count the rejected proposals without persisting untrusted arguments.
      record("tool_rejection", {
        proposed: result.message.toolCalls.length,
        reason: "invalid_tool_batch",
        responseHash: result.responseHash,
      });
      recoverableRejections += 1;
      if (
        recoverableRejections > 2 ||
        result.message.toolCalls.some(
          (call) =>
            typeof call.id !== "string" ||
            !call.id ||
            call.id.length > 256 ||
            seenToolCallIds.has(call.id),
        ) ||
        new Set(result.message.toolCalls.map((call) => call.id)).size !==
          result.message.toolCalls.length
      ) {
        stopReason = "invalid_tool_call";
        failure = { classification: "model_tool_use_failure", detail: errorMessage(error) };
        break;
      }
      for (const call of result.message.toolCalls) {
        seenToolCallIds.add(call.id);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: stableJson({
            ok: false,
            error: errorMessage(error),
            instruction:
              "Correct the tool arguments and retry. No action from this batch executed.",
          }),
        });
      }
      activeTurn = null;
      continue;
    }
    for (let index = activeTurn.nextToolIndex; index < parsedCalls.length; index += 1) {
      const call = parsedCalls[index]!;
      // A provider or tool can return after an explicit stop. Never apply late edits.
      const recovered = recoveringAction;
      if (recovered) {
        if (recovered.id !== call.id || recovered.requestHash !== hashJson(call))
          throw new Error("Pending tool differs from the frozen tool batch");
        recoveringAction = null;
      } else
        record("tool_call", {
          id: call.id,
          name: call.name,
          arguments: traceToolArguments(call),
          argumentsHash: hashJson(call.arguments),
        });
      if (input.signal?.aborted) {
        stopReason = "cancelled";
        failure = {
          classification: "budget_or_stop_failure",
          detail: "Agent run cancelled",
        };
        record("tool_result", {
          id: call.id,
          name: call.name,
          result: { ok: false, error: failure.detail },
        });
        break turns;
      }
      let toolResult: Record<string, JsonValue>;
      const expectedSource =
        recovered?.expectedSource ??
        (await workspace.expectedWrite(call, input.task.seed.projectFile));
      if (!recovered)
        await checkpoint(turn, "before_tool", {
          id: call.id,
          kind: call.name === "development.run" ? "public_studio" : "workspace_tool",
          requestHash: hashJson(call),
          expectedSource,
        });
      let toolImages: DevelopmentFrame[] = [];
      if (call.name === "development.run" || call.name === "development.inspect") {
        try {
          if (!input.development) throw new Error("Public Studio development is unavailable");
          let observation: DevelopmentObservation;
          if (call.name === "development.run") {
            if (!input.development.publicScenarios.includes(call.arguments.scenarioId))
              throw new Error("Unknown public development scenario");
            if (developmentRuns >= input.development.maxRuns)
              throw new Error("Public Studio development run limit reached");
            developmentRuns += 1;
            const candidate = await workspace.manifest(input.task.seed.projectFile);
            const runDevelopment = recovered ? input.development.recover! : input.development.run;
            observation = await runDevelopment(
              workspace.root,
              candidate,
              call.arguments.scenarioId,
              `development-${hashJson({ treatment: input.treatment.id, call }).slice(0, 24)}`,
              input.signal,
            );
            if (recovered) recordRecoveredTime(observation.activeDurationMs ?? 0);
            if (observation.candidateHash !== candidate.rootHash)
              throw new Error("Development evidence does not bind the requested candidate");
            if (
              (await workspace.manifest(input.task.seed.projectFile)).rootHash !==
              candidate.rootHash
            )
              throw new Error("Candidate changed while its public Studio test was running");
          } else {
            observation = await input.development.inspect(
              call.arguments.evidenceId,
              call.arguments.frameIds,
            );
            if (
              observation.candidateHash !==
              (await workspace.manifest(input.task.seed.projectFile)).rootHash
            )
              throw new Error(
                "Development evidence belongs to an older candidate; run the public scenario again",
              );
          }
          assertDevelopmentObservation(observation);
          toolImages = observation.frames;
          toolResult = {
            ok: true,
            evidenceId: observation.evidenceId,
            candidateHash: observation.candidateHash,
            summary: observation.summary,
            frames: observation.frames.map(
              ({ id, actor, acquisitionStart, acquisitionEnd, image }) => ({
                id,
                actor,
                acquisitionStart,
                acquisitionEnd,
                hash: image.hash,
              }),
            ),
          };
        } catch (error) {
          if (error instanceof AgentInterrupted) throw error;
          if (input.retainInterruption && input.signal?.aborted) throw new AgentInterrupted();
          // A recovered Studio test cannot run again, so its failure is an interruption. A failure
          // that the candidate causes is the same in each attempt, so the builder gets it.
          if (
            recovered &&
            call.name === "development.run" &&
            !(error instanceof DevelopmentCandidateError)
          )
            throw new AgentInterrupted(
              `Basalt cannot recover the interrupted public Studio test (${errorMessage(error)}). To continue the build from this point, resume the run.`,
              { cause: error },
            );
          toolResult = { ok: false, error: errorMessage(error) };
        }
      } else if (
        recovered &&
        expectedSource &&
        hashJson(await workspace.manifest(input.task.seed.projectFile)) ===
          hashJson(expectedSource) &&
        (call.name === "workspace.write" || call.name === "workspace.patch")
      ) {
        toolResult = {
          ok: true,
          hash: expectedSource.files.find((file) => file.path === call.arguments.path)!.hash,
        };
      } else
        toolResult = await executeTool(
          call,
          workspace,
          input.verify,
          input.task,
          input.notes,
          lint,
        );
      if (call.name === "workspace.finish" && activeTurn.earlierToolFailed)
        toolResult = {
          ok: false,
          error: "workspace.finish cannot follow a failed tool call in the same batch",
        };
      if (toolResult.ok !== true) activeTurn.earlierToolFailed = true;
      if (call.name === "workspace.finish" && toolResult.ok === true) finishRequested = true;
      const content = boundedToolResult(toolResult);
      // All tool results of a batch must directly follow its assistant message. Thus a result
      // goes before the frame messages of earlier inspections in the same batch.
      let position = messages.length;
      while (messages[position - 1]?.role === "user") position -= 1;
      messages.splice(position, 0, { role: "tool", toolCallId: call.id, name: call.name, content });
      record("tool_result", {
        id: call.id,
        name: call.name,
        resultHash: contentHash(content),
        ok: toolResult.ok === true,
        result: traceToolResult(call, toolResult),
        ...(call.name === "workspace.verify" ? { verificationGate: toolResult.gate ?? null } : {}),
      });
      if (toolResult.ok === true && toolImages.length > 0) {
        // Repeated inspections carry the original image bytes into separate
        // provider turns. Older bytes are removed from later requests; their
        // content hashes and timing remain in the tool result and trace.
        for (const message of messages)
          if (message.role === "user" && message.images) delete message.images;
        messages.push({
          role: "user",
          content: `Development frames for ${String(toolResult.evidenceId)}: ${toolImages
            .map(
              (frame) =>
                `${frame.id} actor=${frame.actor} acquired=[${frame.acquisitionStart},${frame.acquisitionEnd}] sha256=${frame.image.hash}`,
            )
            .join("; ")}. These are debugging observations, not final evaluator verdicts.`,
          images: toolImages.map((frame) => frame.image),
        });
      }
      activeTurn.nextToolIndex = index + 1;
      await checkpoint(turn, "after_tool");
    }
    if (finishRequested) {
      stopReason = "finished";
      break;
    }
    activeTurn = null;
  }

  if (stopReason === "cancelled" && input.retainInterruption) throw new AgentInterrupted();
  const verification = await runVerification(input.verify, workspace.root, input.task).catch(
    (error: unknown) => ({
      gate: "incomplete" as const,
      reasons: [errorMessage(error)],
      checks: [{ name: "local_verifier", outcome: "unavailable" as const }],
    }),
  );
  record("gate", {
    gate: verification.gate,
    reasons: verification.reasons,
    checks: verification.checks,
  });
  const candidate = await workspace.manifest(input.task.seed.projectFile);
  const status: AgentRun["status"] =
    stopReason === "spending_limit" ||
    stopReason === "cancelled" ||
    stopReason === "output_limit" ||
    stopReason === "refusal"
      ? "incomplete"
      : verification.gate === "eligible" && finishRequested
        ? "locally_eligible"
        : verification.gate === "rejected"
          ? "rejected"
          : "incomplete";
  if (status !== "locally_eligible" && failure === undefined) {
    failure = {
      classification:
        verification.gate === "rejected"
          ? "static_or_luau_failure"
          : verification.gate === "eligible"
            ? "budget_or_stop_failure"
            : "environment_failure",
      detail:
        verification.reasons.join("; ") ||
        (verification.gate === "eligible"
          ? `Agent stopped with ${stopReason} before a valid finish`
          : `Local gate ${verification.gate}`),
    };
  }
  const endedAt = now().toISOString();
  const runBody = {
    treatmentId: input.treatment.id,
    startedAt,
    endedAt,
    status,
    stopReason,
    candidate,
    usage: finalizeUsage(usage, input.treatment),
    trace,
    ...(failure ? { failure } : {}),
  };
  const run: AgentRun = {
    schema: AGENT_RUN_SCHEMA,
    id: `run-${hashJson(runBody).slice(0, 20)}`,
    ...runBody,
  };
  assertAgentRun(run);
  await checkpoint(usage.calls - pausedCalls - compactions, "finished", null, run);
  return run;
}

/**
 * The stage list of a build of stage 2 or later: the prompts of the earlier stages, in order.
 * The text is empty for the first stage and for an evaluation without stages.
 */
function earlierStagesText(earlierPrompts: string[]): string {
  if (!earlierPrompts.length) return "";
  return [
    "This build continues your build of the earlier stages of this task. The workspace already holds that build.",
    ...earlierPrompts.flatMap((prompt, index) => [`Prompt of stage ${index + 1}:`, prompt]),
    `This is stage ${earlierPrompts.length + 1}.`,
    "",
  ].join("\n");
}

/**
 * The first user message of a build: the harness template with each slot filled. The slot text
 * is fixed, and each request hash includes it.
 */
export function builderPrompt(
  task: PublicTask,
  harness: Pick<HarnessDefinition, "promptTemplate" | "tools" | "developmentRuns" | "notesPack">,
  development?: Pick<DevelopmentServices, "publicScenarios">,
  earlierPrompts: string[] = [],
): string {
  if (harness.developmentRuns > 0 !== !!development)
    throw new Error(
      "The development slot needs the public scenarios of a harness with Studio runs",
    );
  const runs = harness.developmentRuns;
  const slots: Record<string, string> = {
    stages: earlierStagesText(earlierPrompts),
    task: publicTaskInstructions(task),
    workspace: `Call workspace.list to inspect the immutable public seed scene: its exact instance names, declared classes, properties, and source mappings. The scene is setup data, not an additional acceptance criterion. Edit only declared Luau source roots, ${harness.tools.includes("workspace.verify") ? "run workspace.verify, " : ""}then call workspace.finish.`,
    development: development
      ? [
          `Public Studio development scenarios: ${development.publicScenarios.join(", ")}.`,
          `You may run ${runs === 1 ? "one public Studio development test" : `at most ${runs} public Studio development tests`}. Inspect rendered frames and runtime observations, fix problems, and retest before submission. Development results are debugging observations, not the independent final evaluation.`,
        ].join("\n")
      : "",
    notes: harness.notesPack
      ? "API notes: call notes.list to see the frozen reference notes about public Roblox and Luau APIs, and call notes.read to read one file. The notes are general reference material. They do not describe this task or how the build is checked."
      : "",
  };
  return harness.promptTemplate.replace(/\{\{([a-z]+)\}\}/gu, (_, slot: string) => slots[slot]!);
}

function traceToolResult(
  call: ParsedToolCall,
  value: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (value.ok !== true)
    return { ok: false, error: typeof value.error === "string" ? value.error : "Tool failed" };
  if (call.name === "workspace.list") {
    const files = Array.isArray(value.files) ? value.files : [];
    let totalBytes = 0;
    for (const file of files)
      if (isRecord(file) && typeof file.bytes === "number") totalBytes += file.bytes;
    return {
      ok: true,
      fileCount: files.length,
      totalBytes,
      inventoryHash: hashJson(files),
      projectFile: isRecord(value.scene) ? (value.scene.projectFile ?? null) : null,
      projectHash: isRecord(value.scene) ? (value.scene.projectHash ?? null) : null,
      sceneHash: isRecord(value.scene) ? hashJson(value.scene) : null,
    };
  }
  if (call.name === "workspace.read")
    return {
      ok: true,
      path: typeof value.path === "string" ? value.path : call.arguments.path,
      hash: typeof value.hash === "string" ? value.hash : "",
      bytes: typeof value.content === "string" ? Buffer.byteLength(value.content, "utf8") : 0,
    };
  if (call.name === "workspace.search")
    return { ok: true, matches: Array.isArray(value.matches) ? value.matches : [] };
  if (call.name === "notes.list")
    return {
      ok: true,
      fileCount: Array.isArray(value.files) ? value.files.length : 0,
      inventoryHash: hashJson(value.files ?? []),
    };
  if (call.name === "notes.read")
    return {
      ok: true,
      path: typeof value.path === "string" ? value.path : call.arguments.path,
      hash: typeof value.hash === "string" ? value.hash : "",
      bytes: typeof value.content === "string" ? Buffer.byteLength(value.content, "utf8") : 0,
    };
  if (call.name === "workspace.write" || call.name === "workspace.patch")
    return { ok: true, hash: typeof value.hash === "string" ? value.hash : "" };
  if (call.name === "development.run" || call.name === "development.inspect")
    return {
      ok: true,
      evidenceId: value.evidenceId ?? null,
      candidateHash: value.candidateHash ?? null,
      frames: value.frames ?? [],
      summary: value.summary ?? null,
    };
  if (call.name === "workspace.verify")
    return {
      ok: true,
      gate: typeof value.gate === "string" ? value.gate : "incomplete",
      reasons: Array.isArray(value.reasons) ? value.reasons : [],
      checks: Array.isArray(value.checks) ? value.checks : [],
      ...(Array.isArray(value.lint) ? { lint: value.lint } : {}),
    };
  const summary =
    typeof value.summary === "string"
      ? value.summary
      : call.name === "workspace.finish"
        ? call.arguments.summary
        : "";
  return {
    ok: true,
    finished: true,
    summaryHash: contentHash(summary),
    summaryBytes: Buffer.byteLength(summary, "utf8"),
  };
}

function traceToolArguments(call: ParsedToolCall): Record<string, JsonValue> {
  if (call.name === "workspace.write")
    return {
      path: call.arguments.path,
      expectedHash: call.arguments.expectedHash,
      contentHash: contentHash(call.arguments.content),
      contentBytes: Buffer.byteLength(call.arguments.content, "utf8"),
    };
  if (call.name === "workspace.finish")
    return {
      summaryHash: contentHash(call.arguments.summary),
      summaryBytes: Buffer.byteLength(call.arguments.summary, "utf8"),
    };
  return call.arguments;
}

function traceText(prefix: string, value: string): Record<string, JsonValue> {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_TRACE_TEXT_BYTES)
    return { [prefix]: value, [`${prefix}Hash`]: contentHash(value), [`${prefix}Bytes`]: bytes };
  const bounded = Buffer.from(value, "utf8").subarray(0, MAX_TRACE_TEXT_BYTES).toString("utf8");
  return {
    [prefix]: bounded,
    [`${prefix}Hash`]: contentHash(value),
    [`${prefix}Bytes`]: bytes,
    [`${prefix}Truncated`]: true,
  };
}

function emptyUsage(): MutableUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerReportedCostUsd: 0,
  };
}

type MutableUsage = AccumulatedAgentUsage;

function addUsage(total: MutableUsage, next: ModelUsage): void {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const value = next[field];
    if (value === null || total[field] === null) total[field] = null;
    else {
      const combined = total[field] + value;
      total[field] = Number.isSafeInteger(combined) ? combined : null;
    }
  }
  if (next.costUsd === null || total.providerReportedCostUsd === null)
    total.providerReportedCostUsd = null;
  else {
    const combined = total.providerReportedCostUsd + next.costUsd;
    total.providerReportedCostUsd = Number.isFinite(combined) ? combined : null;
  }
}

function finalizeUsage(total: MutableUsage, treatment: Treatment): AgentRun["usage"] {
  const computedCost =
    total.inputTokens === null || total.outputTokens === null
      ? null
      : (total.inputTokens * treatment.model.pricing.inputPerMillionTokens +
          total.outputTokens * treatment.model.pricing.outputPerMillionTokens) /
        1_000_000;
  const estimatedCostUsd =
    computedCost !== null && Number.isFinite(computedCost) ? computedCost : null;
  return {
    calls: total.calls,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    estimatedCostUsd,
    providerReportedCostUsd: total.providerReportedCostUsd,
  };
}

function assertTreatmentMatchesTask(treatment: Treatment, task: PublicTask): void {
  if (
    !treatment.task.id.startsWith(`${task.slug}:`) ||
    treatment.task.publicTaskHash !== hashJson(task)
  )
    throw new Error("Treatment does not bind the supplied public task");
}

function responseTraceData(result: ModelTurnResult): Record<string, JsonValue> {
  return {
    requestedModel: result.responseFacts.requestedModel,
    resolvedModel: result.responseFacts.resolvedModel,
    servingProvider: result.responseFacts.servingProvider,
    requestedServiceTier: result.responseFacts.requestedServiceTier,
    servingServiceTier: result.responseFacts.servingServiceTier,
    responseId: result.responseFacts.responseId,
    latencyMs: result.responseFacts.latencyMs,
    retryCount: result.responseFacts.retryCount,
    finishReason: result.responseFacts.finishReason,
    continuationHash: result.responseFacts.continuationHash,
    continuationBytes: result.responseFacts.continuationBytes,
    responseFactsHash: result.responseFactsHash ?? null,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    providerReportedCostUsd: result.usage.costUsd,
  };
}

function assertModelTurnResult(
  value: ModelTurnResult,
  expectedRequestedModel: string,
  expectedResolvedModel: string,
  expectedTransport: string,
  expectedRequestHash: string,
): void {
  if (
    !isRecord(value) ||
    !new Set(["assistant", "invalid_model_response", "provider_error", "spending_limit"]).has(
      String(value.kind),
    )
  )
    throw new Error("result kind is invalid");
  if (value.requestHash !== expectedRequestHash) throw new Error("request hash is invalid");
  if (!isRecord(value.usage)) throw new Error("usage is invalid");
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const)
    if (!isNullableNonNegativeInteger(value.usage[field]))
      throw new Error(`usage ${field} is invalid`);
  if (!isNullableFiniteNonNegative(value.usage.costUsd)) throw new Error("usage cost is invalid");
  if (!isRecord(value.responseFacts)) throw new Error("response facts are invalid");
  const facts = value.responseFacts;
  if (
    facts.requestedModel !== expectedRequestedModel ||
    !isNullableBoundedText(facts.resolvedModel, 256) ||
    !isNullableBoundedText(facts.servingProvider, 256) ||
    !isNullableBoundedText(facts.responseId, 512) ||
    !Number.isFinite(facts.latencyMs) ||
    facts.latencyMs < 0 ||
    facts.retryCount !== 0 ||
    !isNullableBoundedText(facts.finishReason, 256) ||
    !isNullableHash(facts.continuationHash) ||
    !isNullableNonNegativeInteger(facts.continuationBytes) ||
    (facts.continuationHash === null) !== (facts.continuationBytes === null)
  )
    throw new Error("response facts are invalid");
  if (
    value.responseFactsHash !== undefined &&
    (!isHash(value.responseFactsHash) ||
      value.responseFactsHash !== contentHash(stableJson({ facts, usage: value.usage })))
  )
    throw new Error("response facts hash is invalid");
  if (value.kind !== "assistant") {
    if (
      typeof value.errorClass !== "string" ||
      value.errorClass.length === 0 ||
      value.errorClass.length > 256 ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 2_000 ||
      (value.kind === "provider_error" &&
        (typeof value.retryable !== "boolean" ||
          (value.providerErrorType !== null && !isProviderErrorType(value.providerErrorType))))
    )
      throw new Error("failure result is invalid");
    return;
  }
  if (
    facts.resolvedModel !== expectedResolvedModel ||
    facts.servingProvider === null ||
    facts.responseId === null ||
    !isHash(value.responseHash) ||
    !new Set(["end_turn", "tool_calls", "max_tokens", "refusal", "other"]).has(value.stopReason) ||
    !isRecord(value.message) ||
    value.message.role !== "assistant" ||
    typeof value.message.content !== "string" ||
    !Array.isArray(value.message.toolCalls)
  )
    throw new Error("assistant result identity is invalid");
  if (value.responseHash !== contentHash(stableJson(value.message)))
    throw new Error("assistant response hash is invalid");
  const continuation = value.message.continuation;
  if (continuation === undefined) {
    if (facts.continuationHash !== null || facts.continuationBytes !== null)
      throw new Error("assistant continuation facts are invalid");
    return;
  }
  const serialized = stableJson(continuation.payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (
    continuation.transport !== expectedTransport ||
    bytes !== continuation.bytes ||
    bytes > MODEL_CONTINUATION_MAX_BYTES ||
    contentHash(serialized) !== continuation.hash ||
    facts.continuationHash !== continuation.hash ||
    facts.continuationBytes !== continuation.bytes
  )
    throw new Error("assistant continuation identity is invalid");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function isNullableBoundedText(value: unknown, maxLength: number): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length > 0 && value.length <= maxLength)
  );
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isNullableFiniteNonNegative(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
}

function assertDevelopmentObservation(value: DevelopmentObservation): void {
  if (
    !value ||
    !/^[a-z][a-z0-9-]{0,119}$/.test(value.evidenceId) ||
    !isHash(value.candidateHash) ||
    (value.activeDurationMs !== undefined &&
      (!Number.isFinite(value.activeDurationMs) || value.activeDurationMs < 0)) ||
    typeof value.summary !== "string" ||
    Buffer.byteLength(value.summary, "utf8") > MAX_DEVELOPMENT_SUMMARY_BYTES ||
    !Array.isArray(value.frames) ||
    value.frames.length > 4
  )
    throw new Error("Public Studio development returned an invalid bounded observation");
  if (value.frames.length > 0) validateModelImages(value.frames.map((frame) => frame.image));
  for (const frame of value.frames) {
    if (
      !/^[a-z][a-z0-9-]{0,119}$/.test(frame.id) ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(frame.actor) ||
      !Number.isFinite(Date.parse(frame.acquisitionStart)) ||
      !Number.isFinite(Date.parse(frame.acquisitionEnd)) ||
      frame.acquisitionEnd < frame.acquisitionStart
    )
      throw new Error("Public Studio development frame metadata is invalid");
  }
}
