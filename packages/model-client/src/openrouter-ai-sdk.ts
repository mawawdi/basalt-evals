import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "undici";
import {
  APICallError,
  InvalidToolInputError,
  JSONParseError,
  NoSuchToolError,
  StreamProviderError,
  TypeValidationError,
  jsonSchema,
  modelMessageSchema,
  stepCountIs,
  streamText,
  tool,
  type JSONValue,
  type ModelMessage as AiModelMessage,
  type ToolSet,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { lookupOpenRouterGenerationBilling } from "./generation-billing.js";
import { assertRequestReasoning } from "./reasoning.js";
import { assertRequestSampling } from "./sampling.js";
import { strictToolWireSchema } from "./strict-tool-schema.js";
import {
  MODEL_CONTINUATION_MAX_BYTES,
  REASONING_EFFORTS,
  isProviderErrorType,
  modelTurnRequestHash,
  validateModelImages,
  type ModelClient,
  type ModelContinuation,
  type ModelRoute,
  type ModelMessage,
  type ModelResponseFacts,
  type ModelToolDefinition,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ModelUsage,
  type ModelDispatchObserver,
  type ModelResponseIdentity,
  type ProviderErrorType,
} from "./contracts.js";
import { isRecord } from "../../contracts/src/validation.js";
const TRANSPORT = "openrouter-ai-sdk-core";

/**
 * A finished JSON value never needs thousands of consecutive whitespace characters. If one run
 * of whitespace in the text or in the arguments of one tool call becomes longer than this, the
 * transport stops the stream. The value changes execution, so the descriptor records it.
 */
const RUNAWAY_WHITESPACE_STOP = 4_096;

/**
 * OpenRouter can write the generation record some seconds after a stop. The transport reads it
 * at most 10 times in approximately 30 s. Each wait comes before its read.
 */
const STOPPED_GENERATION_BILLING_WAITS_MS: readonly number[] = Array(10).fill(3_000);
const BILLING_READ_TIMEOUT_MS = 10_000;

/** Public, secret-free transport identity used to freeze a treatment. */
export function openRouterModelClientDescriptor(
  allowlistedModels: readonly string[],
  routes?: Record<string, ModelRoute>,
) {
  const models = validatedModelAllowlist(allowlistedModels);
  if (routes) {
    if (Object.keys(routes).some((id) => !models.includes(id)))
      throw new Error("An endpoint set references a model outside the allowlist");
    for (const route of Object.values(routes))
      if (
        !route ||
        typeof route.seedSupported !== "boolean" ||
        (route.reasoningEffort !== null && !REASONING_EFFORTS.includes(route.reasoningEffort)) ||
        !["default", "flex", "priority"].includes(route.serviceTier) ||
        !route.maxPrice ||
        [
          route.maxPrice.prompt,
          route.maxPrice.completion,
          route.maxPrice.request,
          route.maxPrice.image,
        ]
          .filter((value) => value !== undefined)
          .some((value) => !Number.isFinite(value) || value! < 0)
      )
        throw new Error("Invalid provider endpoint set");
  }
  return {
    transport: TRANSPORT,
    configuration: {
      aiSdk: { package: "ai" },
      providerAdapter: { package: "@openrouter/ai-sdk-provider" },
      routing: {
        allowlistHash: contentHash(stableJson(models)),
        allowlistedModels: models,
        providerAllowlist: "none" as const,
        modelFallbacks: false as const,
        providerSelection: "openrouter_default" as const,
        requireParameters: true as const,
        requireTools: true as const,
        ...(routes ? { routes } : {}),
      },
      reasoning: {
        effort: "catalog_supported_balanced" as const,
        exclude: false as const,
        mode: "when_supported" as const,
      },
      request: {
        steps: 1 as const,
        toolChoice: "auto" as const,
        providerParallelToolCalls: "not_requested" as const,
        toolBatchExecution: "atomic_validate_then_sequential" as const,
        toolNameEncoding: "openai_function_slug" as const,
        toolSchemaMode: "declared_per_tool" as const,
        responseDelivery: "server_sent_events" as const,
        runawayWhitespaceStop: RUNAWAY_WHITESPACE_STOP,
        maxRetries: 0 as const,
        telemetry: false as const,
        timeoutPolicy: "explicit_cancellation" as const,
        seed: "treatment_random_seed_31_bit" as const,
        sampling: "explicit_request_values" as const,
        imagePresentation: "labelled_images_before_text" as const,
      },
      continuation: { maxBytes: MODEL_CONTINUATION_MAX_BYTES },
    },
  };
}

/** HTTP statuses whose response must not carry a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Model inference may remain quiet while the provider works. Do not reintroduce
// a five-minute response cutoff through Node's default HTTP client settings.
const modelHttp = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const modelFetch: typeof fetch = (url, init) =>
  fetch(url, { ...init, dispatcher: modelHttp } as RequestInit & { dispatcher: Agent });

interface OpenRouterAiSdkClientOptions {
  apiKey: string;
  allowedModels: readonly string[];
  fetchImpl?: typeof fetch;
  routes?: Record<string, ModelRoute>;
  /** The wait before a billing read of a stopped generation. A test can make it immediate. */
  pause?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** The dispatch facts of one model turn. */
interface DispatchContext {
  sent: boolean;
  identity: ModelResponseIdentity | null;
  observer?: ModelDispatchObserver;
  /** The Retry-After header of a successful stream, for an error event inside the stream. */
  retryAfter?: string;
  /** True after the stream tap found a runaway whitespace run and stopped the turn. */
  runaway: boolean;
  /** Stop the stream of this turn after a runaway whitespace run. The turn sets it. */
  stopRunaway?: () => void;
}

export class OpenRouterModelClient implements ModelClient {
  readonly descriptor;
  readonly observesDispatch = true as const;
  private readonly dispatch = new AsyncLocalStorage<DispatchContext>();

  private readonly provider: ReturnType<typeof createOpenRouter>;
  private readonly allowedModels: ReadonlySet<string>;
  private readonly routes: Record<string, ModelRoute>;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: OpenRouterAiSdkClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) throw new Error("OPENROUTER_API_KEY is required");
    this.descriptor = openRouterModelClientDescriptor(options.allowedModels, options.routes);
    this.allowedModels = new Set(this.descriptor.configuration.routing.allowlistedModels);
    this.routes = options.routes ?? {};
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl;
    this.pause =
      options.pause ??
      ((milliseconds, signal) => delay(milliseconds, undefined, signal ? { signal } : {}));
    this.provider = createOpenRouter({
      apiKey,
      fetch: async (url, init) => {
        const context = this.dispatch.getStore();
        if (!context || context.sent) throw new Error("A model turn may dispatch exactly once");
        init?.signal?.throwIfAborted();
        await context.observer?.beforeDispatch();
        init?.signal?.throwIfAborted();
        context.sent = true;
        const response = await (options.fetchImpl ?? modelFetch)(url, init);
        if (response.ok && response.body !== null) {
          // A successful response is a stream. A tap reads each event before the SDK reads it.
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter !== null) context.retryAfter = retryAfter;
          return new Response(response.body.pipeThrough(streamTap(context)), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        // Read the body once, then give the SDK the same bytes. A cloned body shares one
        // stream, and the runtime can cancel it when the clone is collected. Then the SDK
        // reads an empty error body and loses the provider details.
        const bytes = await response.arrayBuffer();
        let body: unknown = null;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          body = null;
        }
        if (isRecord(body)) {
          const usage = isRecord(body.usage) ? body.usage : null;
          context.identity = {
            generationId: boundedText(body.id),
            resolvedModel: boundedText(body.model),
            servingProvider: boundedText(body.provider),
            servingServiceTier: boundedText(body.service_tier),
            costUsd: finiteOrNull(usage?.cost),
          };
          await context.observer?.response(context.identity);
        }
        return new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      compatibility: "strict",
    });
  }

  validateRequest(request: ModelTurnRequest): void {
    modelTurnRequestHash(request, this.descriptor);
    const error = requestConfigurationError(request);
    if (error) throw new Error(error);
    if (!this.allowedModels.has(request.model)) throw new Error("Model is not allowlisted");
    const tools = toWireTools(request.tools);
    const messages = toAiMessages(request.messages, tools.publicToWire);
    stableJson({ system: request.system, messages, tools: tools.providerTools });
  }

  async complete(
    request: ModelTurnRequest,
    signal?: AbortSignal,
    observer?: ModelDispatchObserver,
  ): Promise<ModelTurnResult> {
    const context: DispatchContext = {
      sent: false,
      identity: null,
      runaway: false,
      ...(observer ? { observer } : {}),
    };
    return this.dispatch.run(context, async () => {
      const result = await this.completeTurn(request, context, signal);
      const requestedTier = this.routes[request.model]?.serviceTier ?? null;
      result.responseFacts.requestedServiceTier = requestedTier;
      const identity = context.identity;
      if (identity) {
        result.responseFacts.responseId ??= identity.generationId;
        result.responseFacts.resolvedModel ??= identity.resolvedModel;
        result.responseFacts.servingProvider ??= identity.servingProvider;
        result.responseFacts.servingServiceTier = identity.servingServiceTier;
        result.usage.costUsd ??= identity.costUsd;
      }
      // OpenRouter routing can serve another tier, for example `provisioned`. The answer stays
      // valid. The response facts keep both tiers, and the ledger still checks the charge.
      result.responseFactsHash = normalizedResponseHash(
        result.responseFacts,
        result.usage,
      ).responseFactsHash;
      return result;
    });
  }

  private async completeTurn(
    request: ModelTurnRequest,
    context: DispatchContext,
    signal?: AbortSignal,
  ): Promise<ModelTurnResult> {
    const startedAt = Date.now();
    let requestHash: string;
    try {
      requestHash = modelTurnRequestHash(request, this.descriptor);
    } catch {
      const requestedModel = typeof request.model === "string" ? request.model : "invalid";
      requestHash = contentHash(stableJson({ invalidRequest: true, transport: this.descriptor }));
      return providerFailure(
        "request_configuration",
        "Model request is not canonically serializable.",
        false,
        requestHash,
        emptyUsage(),
        responseFacts(requestedModel, null, null, null, Date.now() - startedAt, null),
      );
    }
    const requestError = requestConfigurationError(request);
    if (requestError !== null)
      return providerFailure(
        "request_configuration",
        requestError,
        false,
        requestHash,
        emptyUsage(),
        responseFacts(
          typeof request.model === "string" ? request.model : "invalid",
          null,
          null,
          null,
          Date.now() - startedAt,
          null,
        ),
      );
    if (!this.allowedModels.has(request.model)) {
      return providerFailure(
        "model_not_allowlisted",
        `Requested model ${request.model.slice(0, 200)} is not in this study's model allowlist.`,
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }
    let wireTools: WireTools;
    try {
      wireTools = toWireTools(request.tools);
    } catch (error) {
      return providerFailure(
        "request_configuration",
        localPreparationMessage(error),
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }

    let messages: AiModelMessage[];
    try {
      messages = toAiMessages(request.messages, wireTools.publicToWire);
    } catch (error) {
      return providerFailure(
        "invalid_continuation",
        localPreparationMessage(error),
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }

    // A runaway stop aborts only this turn. It stays separate from the Stop of the caller.
    const runawayStop = new AbortController();
    context.stopRunaway = () => {
      if (signal?.aborted) return;
      context.runaway = true;
      runawayStop.abort();
    };
    let aborted = false;
    let failure: { error: unknown } | null = null;
    try {
      const route = this.routes[request.model];
      const result = streamText({
        model: this.provider.chat(request.model, {
          // OpenRouter picks the endpoint and the fallbacks with its default routing. The price
          // limit only keeps each charge inside the cost that the request reserved.
          provider: {
            allow_fallbacks: true,
            require_parameters: true,
            ...(route ? { max_price: route.maxPrice } : {}),
          },
          usage: { include: true },
        }),
        system: request.system,
        messages,
        tools: wireTools.tools,
        // The pinned OpenRouter adapter drops AI SDK's per-tool `strict` flag.
        // Its documented call-level passthrough must carry the exact same tools
        // with the strict mode that each tool declares.
        providerOptions: {
          openrouter: {
            tools: wireTools.providerTools,
            ...(route ? { service_tier: route.serviceTier } : {}),
            // The transport sends only explicit values; null leaves the provider default.
            ...sentSampling(request),
            // Call-level options preserve catalog efforts beyond the adapter's static enum.
            ...(request.reasoning
              ? request.reasoning.kind === "provider_default"
                ? {}
                : {
                    reasoning: { effort: request.reasoning.effort, exclude: false },
                  }
              : route?.reasoningEffort
                ? { reasoning: { effort: route.reasoningEffort, exclude: false } }
                : {}),
          },
        },
        toolOrder: wireTools.order,
        // Tool support does not establish that forced choice works with reasoning.
        // The runtime validates the submitted response independently.
        toolChoice: "auto",
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        maxOutputTokens: request.maxOutputTokens,
        // Google Vertex accepts only a signed 32-bit seed. The remainder stays deterministic.
        ...(route?.seedSupported === false ? {} : { seed: request.seed % 2 ** 31 }),
        abortSignal: signal ? AbortSignal.any([signal, runawayStop.signal]) : runawayStop.signal,
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        // The transport reads each error from the stream parts.
        onError: () => {},
      });

      // The stream tap watches the whitespace runs. A runaway stop aborts the stream here.
      try {
        for await (const part of result.stream) {
          if (part.type === "abort") aborted = true;
          else if (part.type === "error") failure ??= { error: part.error };
        }
      } catch (error) {
        failure ??= { error };
      }
      if (context.runaway)
        return await this.runawayFailure(request, requestHash, context, startedAt, signal);
      // Only the Stop of the caller can abort the stream here, so streamFailure reports it as
      // a cancellation.
      if (aborted || failure !== null)
        return streamFailure(failure?.error, request, requestHash, context, startedAt, signal);

      const step = await result.finalStep;
      const responseMessages = await result.responseMessages;
      const latencyMs = Date.now() - startedAt;
      const usage = usageFrom(step.usage, step.providerMetadata);
      const servingProvider = providerName(step.providerMetadata);
      if (
        step.response.modelId.trim().length === 0 ||
        step.response.modelId.length > 256 ||
        servingProvider === null
      ) {
        return providerFailure(
          "response_identity_mismatch",
          "OpenRouter response did not establish a bounded model identity and serving provider.",
          false,
          requestHash,
          usage,
          responseFacts(
            request.model,
            step.response.modelId,
            servingProvider,
            step.response.id,
            latencyMs,
            step.finishReason,
          ),
        );
      }
      const continuation = createContinuation(responseMessages);
      if (!continuation.ok) {
        return providerFailure(
          continuation.errorClass,
          continuation.message,
          false,
          requestHash,
          usage,
          responseFacts(
            request.model,
            step.response.modelId,
            servingProvider,
            step.response.id,
            latencyMs,
            step.finishReason,
            continuation.identity,
          ),
        );
      }
      const calls = step.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: wireTools.wireToPublic.get(call.toolName) ?? call.toolName,
        arguments: call.input,
      }));
      const message: Extract<ModelMessage, { role: "assistant" }> = {
        role: "assistant",
        content: step.text,
        toolCalls: calls,
        continuation: continuation.value,
      };
      const facts = responseFacts(
        request.model,
        step.response.modelId,
        servingProvider,
        step.response.id,
        latencyMs,
        step.finishReason,
        continuation.value,
      );
      return {
        kind: "assistant",
        message,
        stopReason: normalizeStop(step.finishReason, calls.length),
        usage,
        requestHash,
        responseHash: contentHash(stableJson(message)),
        responseFacts: facts,
        ...normalizedResponseHash(facts, usage),
      };
    } catch (error) {
      return streamFailure(error, request, requestHash, context, startedAt, signal);
    }
  }

  /**
   * The result of a runaway stop. It keeps the generation ID. If OpenRouter reports the charge
   * of the stopped generation, the result carries it. If not, the charge stays pending.
   */
  private async runawayFailure(
    request: ModelTurnRequest,
    requestHash: string,
    context: DispatchContext,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<ModelTurnResult> {
    const latencyMs = Date.now() - startedAt;
    const generationId = context.identity?.generationId ?? null;
    const costUsd =
      generationId === null ? null : await this.stoppedGenerationCost(generationId, signal);
    return providerFailure(
      "runaway_output",
      `The model output has a run of more than ${RUNAWAY_WHITESPACE_STOP} whitespace characters. Basalt stopped the stream. ${
        costUsd === null
          ? "Basalt did not get the charge of the stopped generation, so the charge stays pending."
          : "OpenRouter reported the charge of the stopped generation."
      }`,
      false,
      requestHash,
      { ...emptyUsage(), costUsd },
      responseFacts(
        request.model,
        context.identity?.resolvedModel ?? null,
        context.identity?.servingProvider ?? null,
        generationId,
        latencyMs,
        null,
      ),
    );
  }

  /** Read-only billing reads of a stopped generation. Stop ends the reads at once. */
  private async stoppedGenerationCost(
    generationId: string,
    signal: AbortSignal | undefined,
  ): Promise<number | null> {
    const base = this.fetchImpl ?? fetch;
    const read: typeof fetch = (url, init) =>
      base(url, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(BILLING_READ_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      });
    for (const wait of STOPPED_GENERATION_BILLING_WAITS_MS) {
      try {
        await this.pause(wait, signal);
      } catch {
        return null;
      }
      try {
        return (await lookupOpenRouterGenerationBilling(generationId, this.apiKey, read)).costUsd;
      } catch {
        // OpenRouter can write the record later. The next read tries again.
      }
    }
    return null;
  }
}

interface WireTools {
  tools: ToolSet;
  providerTools: JSONValue[];
  order: string[];
  publicToWire: ReadonlyMap<string, string>;
  wireToPublic: ReadonlyMap<string, string>;
}

/** The AI SDK tools and the provider passthrough tools of one request. They must agree. */
export function toWireTools(definitions: ModelToolDefinition[]): WireTools {
  const tools: ToolSet = {};
  const providerTools: JSONValue[] = [];
  const order: string[] = [];
  const publicToWire = new Map<string, string>();
  const wireToPublic = new Map<string, string>();
  for (const definition of definitions) {
    const wireName = definition.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (wireName.length === 0 || wireName.length > 64 || !/^[A-Za-z0-9_-]+$/.test(wireName))
      throw new Error(`Basalt tool ${definition.name} has no valid provider wire name.`);
    if (wireToPublic.has(wireName))
      throw new Error(
        `Basalt tools ${wireToPublic.get(wireName)} and ${definition.name} collide on provider wire name ${wireName}.`,
      );
    publicToWire.set(definition.name, wireName);
    wireToPublic.set(wireName, definition.name);
    order.push(wireName);
    const description = `Basalt tool ${definition.name}. ${definition.description}`;
    if ("strict" in definition && definition.strict !== true)
      throw new Error(
        `Basalt tool ${definition.name} has an invalid strict marker. Use strict: true, or omit the marker.`,
      );
    const strict = definition.strict === true;
    const parameters = strict
      ? strictWireSchema(definition.parameters, definition.name)
      : providerJsonSchema(definition.parameters, definition.name);
    tools[wireName] = tool({
      description,
      inputSchema: jsonSchema(parameters),
      strict,
    });
    providerTools.push({
      type: "function",
      function: { name: wireName, description, parameters: parameters as JSONValue, strict },
    });
  }
  return { tools, providerTools, order, publicToWire, wireToPublic };
}

/** A strict tool sends the strict wire form of its schema, or Basalt refuses the request. */
function strictWireSchema(value: unknown, toolName: string): Parameters<typeof jsonSchema>[0] {
  try {
    return strictToolWireSchema(value) as Parameters<typeof jsonSchema>[0];
  } catch (error) {
    throw new Error(
      `Basalt tool ${toolName} cannot use strict mode. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Provider schema types stay inside this transport adapter. The native model
 * contract deliberately carries provider-independent data, so validate the
 * object boundary before adapting it to the AI SDK's JSON Schema type.
 */
function providerJsonSchema(value: unknown, toolName: string): Parameters<typeof jsonSchema>[0] {
  if (!isRecord(value))
    throw new Error(`Basalt tool ${toolName} must provide an object JSON Schema.`);
  return value as Parameters<typeof jsonSchema>[0];
}

function toAiMessages(
  messages: ModelMessage[],
  publicToWire: ReadonlyMap<string, string>,
): AiModelMessage[] {
  const result: AiModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      // Each label is text immediately before its image, and all images come before the
      // question text. A model does not read image file names, so the transport sends none.
      result.push({
        role: "user",
        content: message.images
          ? [
              ...message.images.flatMap((image) => [
                { type: "text" as const, text: image.label },
                {
                  type: "file" as const,
                  data: { type: "data" as const, data: image.dataBase64 },
                  mediaType: image.mediaType,
                },
              ]),
              { type: "text" as const, text: message.content },
            ]
          : message.content,
      });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: publicToWire.get(message.name) ?? message.name,
            output: { type: "text", value: message.content },
          },
        ],
      });
      continue;
    }
    if (message.continuation) {
      result.push(...validatedContinuation(message.continuation));
      continue;
    }
    result.push({
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: publicToWire.get(call.name) ?? call.name,
          input: call.arguments,
        })),
      ],
    });
  }
  return result;
}

function validatedContinuation(continuation: ModelContinuation): AiModelMessage[] {
  if (continuation.transport !== TRANSPORT || !Array.isArray(continuation.payload))
    throw new Error("Continuation transport or payload did not match");
  const serialized = stableJson(continuation.payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (
    bytes !== continuation.bytes ||
    bytes > MODEL_CONTINUATION_MAX_BYTES ||
    contentHash(serialized) !== continuation.hash
  )
    throw new Error("Continuation identity did not match");
  const messages: AiModelMessage[] = [];
  for (const value of continuation.payload) {
    const parsed = modelMessageSchema.safeParse(value);
    if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
      throw new Error("Continuation contained an invalid response message");
    messages.push(value as AiModelMessage);
  }
  return messages;
}

function createContinuation(payload: unknown):
  | { ok: true; value: ModelContinuation }
  | {
      ok: false;
      errorClass: "invalid_continuation" | "continuation_too_large";
      message: string;
      identity?: { hash: string; bytes: number };
    } {
  if (!Array.isArray(payload))
    return {
      ok: false,
      errorClass: "invalid_continuation",
      message: "AI SDK response continuation was malformed.",
    };
  const messages: AiModelMessage[] = [];
  try {
    for (const value of payload) {
      const parsed = modelMessageSchema.safeParse(value);
      if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
        return {
          ok: false,
          errorClass: "invalid_continuation",
          message: "AI SDK response continuation was malformed.",
        };
      messages.push(
        withoutUnreadReasoning(removeUndefinedProperties(parsed.data)) as AiModelMessage,
      );
    }
  } catch {
    return {
      ok: false,
      errorClass: "invalid_continuation",
      message: "AI SDK response continuation was malformed.",
    };
  }
  const serialized = stableJson(messages);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MODEL_CONTINUATION_MAX_BYTES)
    return {
      ok: false,
      errorClass: "continuation_too_large",
      message: `AI SDK response continuation exceeded ${MODEL_CONTINUATION_MAX_BYTES} bytes.`,
      identity: { hash: contentHash(serialized), bytes },
    };
  return {
    ok: true,
    value: { transport: TRANSPORT, payload: messages, hash: contentHash(serialized), bytes },
  };
}

/**
 * The OpenRouter provider of the AI SDK puts the reasoning details of a response on its first
 * tool call and again on each reasoning part. The next request reads the copy on the tool call
 * if one exists. Thus the continuation keeps only that copy, and the request does not change.
 */
function withoutUnreadReasoning(message: unknown): unknown {
  const details = (part: unknown) =>
    isRecord(part) && isRecord(part.providerOptions) && isRecord(part.providerOptions.openrouter)
      ? part.providerOptions.openrouter.reasoning_details
      : undefined;
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    !message.content.some((part) => {
      const value = details(part);
      return (
        isRecord(part) && part.type === "tool-call" && Array.isArray(value) && value.length > 0
      );
    })
  )
    return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (!isRecord(part) || part.type !== "reasoning" || details(part) === undefined) return part;
      const { providerOptions, ...rest } = part as { providerOptions: Record<string, unknown> };
      const { reasoning_details: _unread, ...openrouter } = providerOptions.openrouter as Record<
        string,
        unknown
      >;
      const { openrouter: _replaced, ...others } = providerOptions;
      const kept = Object.keys(openrouter).length ? { ...others, openrouter } : others;
      return Object.keys(kept).length ? { ...rest, providerOptions: kept } : rest;
    }),
  };
}

function removeUndefinedProperties(value: unknown): unknown {
  if (value === undefined) throw new Error("Undefined array value");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(removeUndefinedProperties);
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Continuation value is not plain data");
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, removeUndefinedProperties(entry)]),
  );
}

function responseFacts(
  requestedModel: string,
  resolvedModel: string | null,
  servingProvider: string | null,
  responseId: string | null,
  latencyMs: number,
  finishReason: string | null,
  continuation?: Pick<ModelContinuation, "hash" | "bytes">,
): ModelResponseFacts {
  return {
    requestedModel,
    resolvedModel,
    servingProvider,
    responseId,
    requestedServiceTier: null,
    servingServiceTier: null,
    latencyMs,
    retryCount: 0,
    finishReason,
    continuationHash: continuation?.hash ?? null,
    continuationBytes: continuation?.bytes ?? null,
  };
}

function usageFrom(
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    };
    outputTokenDetails?: { reasoningTokens?: number | undefined };
  },
  metadata: unknown,
): ModelUsage {
  const openrouter = openRouterMetadata(metadata);
  const accounting = isRecord(openrouter?.usage) ? openrouter.usage : undefined;
  return {
    inputTokens: nonNegativeIntegerOrNull(usage.inputTokens),
    outputTokens: nonNegativeIntegerOrNull(usage.outputTokens),
    reasoningTokens: nonNegativeIntegerOrNull(usage.outputTokenDetails?.reasoningTokens),
    cacheReadTokens: nonNegativeIntegerOrNull(usage.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: nonNegativeIntegerOrNull(usage.inputTokenDetails?.cacheWriteTokens),
    costUsd: finiteOrNull(accounting?.cost),
  };
}

function providerName(metadata: unknown): string | null {
  const value = openRouterMetadata(metadata)?.provider;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function openRouterMetadata(metadata: unknown): Record<string, unknown> | undefined {
  return isRecord(metadata) && isRecord(metadata.openrouter) ? metadata.openrouter : undefined;
}

function normalizedResponseHash(
  facts: ModelResponseFacts,
  usage: ModelUsage,
): { responseFactsHash: string } {
  return { responseFactsHash: contentHash(stableJson({ facts, usage })) };
}

function providerFailure(
  errorClass: string,
  message: string,
  retryable: boolean,
  requestHash: string,
  usage: ModelUsage,
  facts: ModelResponseFacts,
  providerErrorType: ProviderErrorType | null = null,
): Extract<ModelTurnResult, { kind: "provider_error" }> {
  return {
    kind: "provider_error",
    errorClass,
    providerErrorType,
    message: message.slice(0, 500),
    retryable,
    usage,
    requestHash,
    responseFacts: facts,
    ...normalizedResponseHash(facts, usage),
  };
}

function normalizeStop(
  value: string,
  calls: number,
): Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"] {
  if (value === "length") return "max_tokens";
  if (value === "content-filter") return "refusal";
  if (calls > 0 || value === "tool-calls") return "tool_calls";
  if (value === "stop") return "end_turn";
  return "other";
}

/** Basalt makes these errors itself before dispatch, so their text holds no provider data. */
function localPreparationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classify a stream failure by its error identity, never by provider-controlled text. */
function streamFailure(
  error: unknown,
  request: ModelTurnRequest,
  requestHash: string,
  context: DispatchContext,
  startedAt: number,
  signal: AbortSignal | undefined,
): ModelTurnResult {
  const latencyMs = Date.now() - startedAt;
  const facts = (finishReason: string | null) =>
    responseFacts(request.model, null, null, null, latencyMs, finishReason);
  if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
    const usage = emptyUsage();
    const invalid = facts("invalid-tool-call");
    return {
      kind: "invalid_model_response",
      errorClass: InvalidToolInputError.isInstance(error) ? "invalid_tool_input" : "unknown_tool",
      message: "The provider returned an invalid Basalt tool request.",
      usage,
      requestHash,
      responseFacts: invalid,
      ...normalizedResponseHash(invalid, usage),
    };
  }
  if (signal?.aborted)
    return providerFailure(
      "cancelled",
      "The model request stopped before Basalt received a complete response.",
      false,
      requestHash,
      emptyUsage(),
      facts(null),
    );
  const apiError = findApiCallError(error);
  // An HTTP status means the provider answered; only a transport deadline is a timeout.
  if ((apiError?.statusCode ?? null) === null && (isTimeout(error) || isTimeout(apiError?.cause)))
    return providerFailure(
      "timeout",
      "The OpenRouter request timed out before Basalt received a complete response.",
      true,
      requestHash,
      emptyUsage(),
      facts(null),
    );
  if (apiError !== null) {
    const status = apiError.statusCode ?? null;
    if (status === null)
      return providerFailure(
        "provider_api",
        "OpenRouter request failed.",
        apiError.isRetryable,
        requestHash,
        emptyUsage(),
        facts(null),
      );
    const envelope = apiFailureEnvelope(apiError);
    const type = providerErrorType(envelope, status);
    return providerFailure(
      `http_${status}`,
      `OpenRouter request failed with HTTP ${status}.${apiFailureDetails(envelope, type, apiError.responseHeaders?.["retry-after"])}`,
      apiError.isRetryable,
      requestHash,
      emptyUsage(),
      facts(null),
      type,
    );
  }
  // The SDK keeps the error envelope of an error event inside a successful stream.
  if (StreamProviderError.isInstance(error)) {
    const providerCode = /^[45][0-9]{2}$/.test(String(error.code ?? ""))
      ? String(error.code)
      : null;
    const type = providerErrorType(error.data, providerCode === null ? null : Number(providerCode));
    return providerFailure(
      `provider_response_error${providerCode ? `_${providerCode}` : ""}`,
      `OpenRouter returned an error response${providerCode ? ` (code ${providerCode})` : ""}.${apiFailureDetails(error.data, type, context.retryAfter)}`,
      // The HTTP status of the stream was 200, which is not a retryable status.
      false,
      requestHash,
      emptyUsage(),
      facts(null),
      type,
    );
  }
  if (TypeValidationError.isInstance(error) || JSONParseError.isInstance(error))
    return providerFailure(
      "invalid_response_schema",
      "OpenRouter returned a response that Basalt cannot read.",
      false,
      requestHash,
      emptyUsage(),
      facts(null),
    );
  return providerFailure(
    transportErrorClass(error),
    // The text of a connection error can contain response data, so it stays out.
    "The connection to OpenRouter failed before Basalt received a complete response.",
    false,
    requestHash,
    emptyUsage(),
    facts(null),
  );
}

/** The length of the whitespace run at the end of the text, or a length above the stop. */
function whitespaceRun(run: number, delta: string): number {
  for (let index = 0; index < delta.length; index++) {
    if (!isWhitespace(delta.charCodeAt(index))) run = 0;
    else if (++run > RUNAWAY_WHITESPACE_STOP) return run;
  }
  return run;
}

/** The characters of the JavaScript `\s` class. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** The tap does not read a longer event line. The line goes to the SDK without a change. */
const MAX_TAPPED_EVENT_LINE_CHARS = 1_048_576;

/**
 * Read each server-sent event of a stream before the SDK reads it. The events go to the SDK in
 * the same sequence. The tap does three things:
 * 1. It gives the first event with a generation ID to the dispatch observer at once, so a stop
 *    or a crash during the stream keeps the ID for a billing read.
 * 2. It stops the turn when one run of whitespace in the text or in the arguments of one tool
 *    call becomes longer than RUNAWAY_WHITESPACE_STOP.
 * 3. It joins consecutive argument deltas of one tool call into one event. The SDK adapter parses
 *    all of the arguments again after each delta until they parse, so one event for each group
 *    keeps that cost linear. A group ends at the delta that closes the first JSON value, so the
 *    adapter finds the complete call at the same delta as before.
 */
function streamTap(context: DispatchContext): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const runs = new Map<string, number>();
  const scans = new Map<number, ArgumentScan>();
  let line = "";
  let longLine = false;
  let reported = false;
  let stopped = false;
  let output = "";
  // The held group: the first event of the group, the key of its shape and its argument parts.
  let held: { event: Record<string, unknown>; shape: string; parts: string[] } | null = null;

  const release = () => {
    if (held === null) return;
    const call = toolCallDelta(held.event)!;
    call.function.arguments = held.parts.join("");
    output += `data: ${JSON.stringify(held.event)}\n\n`;
    held = null;
  };
  const identify = async (chunk: Record<string, unknown>) => {
    const identity = (context.identity ??= {
      generationId: null,
      resolvedModel: null,
      servingProvider: null,
      servingServiceTier: null,
      costUsd: null,
    });
    identity.generationId ??= boundedText(chunk.id);
    identity.resolvedModel ??= boundedText(chunk.model);
    identity.servingProvider ??= boundedText(chunk.provider);
    identity.servingServiceTier = boundedText(chunk.service_tier) ?? identity.servingServiceTier;
    const cost = isRecord(chunk.usage) ? finiteOrNull(chunk.usage.cost) : null;
    if (cost !== null) identity.costUsd = cost;
    if (!reported && identity.generationId !== null) {
      reported = true;
      await context.observer?.response({ ...identity });
    }
  };
  /** True if a whitespace run of this event goes above the stop. */
  const runaway = (chunk: Record<string, unknown>): boolean => {
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : null;
    if (delta === null) return false;
    const texts: Array<[string, string]> = [];
    if (typeof delta.content === "string") texts.push(["text", delta.content]);
    if (Array.isArray(delta.tool_calls))
      for (const call of delta.tool_calls)
        if (
          isRecord(call) &&
          isRecord(call.function) &&
          typeof call.function.arguments === "string"
        )
          texts.push([`tool:${String(call.index)}`, call.function.arguments]);
    for (const [key, text] of texts) {
      const run = whitespaceRun(runs.get(key) ?? 0, text);
      runs.set(key, run);
      if (run > RUNAWAY_WHITESPACE_STOP) return true;
    }
    return false;
  };
  const event = async (raw: string) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // A blank line ends an event, and a comment line carries no data. Neither ends a group.
    if (value === "" || value.startsWith(":")) {
      output += `${raw}\n`;
      return;
    }
    let chunk: unknown = null;
    if (value.startsWith("data:"))
      try {
        chunk = JSON.parse(value.slice(5).trim());
      } catch {
        chunk = null;
      }
    if (!isRecord(chunk)) {
      release();
      output += `${raw}\n`;
      return;
    }
    await identify(chunk);
    if (runaway(chunk)) {
      stopped = true;
      context.stopRunaway?.();
      return;
    }
    const call = toolCallDelta(chunk);
    const scan = call ? scans.get(call.index) : undefined;
    if (call === null || scan === undefined || scan.scalar || !joinable(chunk)) {
      // The first delta of a call starts its scan. It goes to the SDK on its own.
      release();
      if (call !== null) {
        if (scan === undefined) scans.set(call.index, new ArgumentScan());
        scans.get(call.index)!.read(call.function.arguments);
      }
      output += `${raw}\n`;
      return;
    }
    const text = call.function.arguments;
    call.function.arguments = "";
    const shape = JSON.stringify(chunk);
    call.function.arguments = text;
    if (held !== null && held.shape !== shape) release();
    held ??= { event: chunk, shape, parts: [] };
    held.parts.push(text);
    if (scan.read(text)) release();
  };
  const read = async (text: string) => {
    let start = 0;
    for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
      if (stopped) return;
      if (longLine) output += `${text.slice(start, end)}\n`;
      else await event(line + text.slice(start, end));
      line = "";
      longLine = false;
      start = end + 1;
    }
    if (stopped) return;
    if (longLine) {
      output += text.slice(start);
      return;
    }
    line += text.slice(start);
    if (line.length > MAX_TAPPED_EVENT_LINE_CHARS) {
      // The tap does not read a very long line. It goes to the SDK as it arrives.
      release();
      output += line;
      line = "";
      longLine = true;
    }
  };
  const send = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (output.length > 0) controller.enqueue(encoder.encode(output));
    output = "";
  };
  return new TransformStream({
    async transform(chunk, controller) {
      // The identity is known before the SDK reads the same event.
      await read(decoder.decode(chunk, { stream: true }));
      send(controller);
    },
    async flush(controller) {
      const rest = decoder.decode();
      if (longLine) output += rest;
      else if (rest.length > 0 || line.length > 0) await read(`${rest}\n`);
      if (!stopped) release();
      send(controller);
    },
  });
}

/** The single tool call delta of a stream event, or null. */
function toolCallDelta(
  chunk: Record<string, unknown>,
): { index: number; function: { arguments: string } } | null {
  const choice =
    Array.isArray(chunk.choices) && chunk.choices.length === 1 ? chunk.choices[0] : null;
  const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : null;
  const calls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : null;
  const call = calls?.length === 1 ? calls[0] : null;
  if (
    !isRecord(call) ||
    !Number.isSafeInteger(call.index) ||
    !isRecord(call.function) ||
    typeof call.function.arguments !== "string"
  )
    return null;
  return call as { index: number; function: { arguments: string } };
}

const emptyDeltaValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/**
 * True if the event carries only argument text of a call that already started. Then a join with
 * the next events of the same shape gives the SDK the same call and nothing less.
 */
function joinable(chunk: Record<string, unknown>): boolean {
  if (!emptyDeltaValue(chunk.usage) || chunk.error !== undefined) return false;
  const choice = (chunk.choices as unknown[])[0] as Record<string, unknown>;
  if (!emptyDeltaValue(choice.finish_reason) || !emptyDeltaValue(choice.native_finish_reason))
    return false;
  const delta = choice.delta as Record<string, unknown>;
  for (const [key, value] of Object.entries(delta))
    if (key !== "tool_calls" && key !== "role" && !emptyDeltaValue(value)) return false;
  const call = (delta.tool_calls as Array<Record<string, unknown>>)[0]!;
  return emptyDeltaValue((call.function as Record<string, unknown>).name);
}

/**
 * Find the end of the first JSON value in the arguments of one tool call, in linear time. The
 * scan counts brackets outside strings. It does not validate the JSON: the SDK still parses it.
 */
class ArgumentScan {
  /** True if the first value is not an object or an array. Such a call is not joined. */
  scalar = false;
  private started = false;
  private closed = false;
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Read the next argument text. True if the first value ends in this text. */
  read(text: string): boolean {
    if (this.closed || this.scalar) return false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (code === 0x5c) this.escaped = true;
        else if (code === 0x22) this.inString = false;
      } else if (!this.started) {
        if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
        this.started = true;
        if (code !== 0x7b && code !== 0x5b) {
          this.scalar = true;
          return false;
        }
        this.depth = 1;
      } else if (code === 0x22) this.inString = true;
      else if (code === 0x7b || code === 0x5b) this.depth++;
      else if ((code === 0x7d || code === 0x5d) && --this.depth === 0) {
        this.closed = true;
        return true;
      }
    }
    return false;
  }
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

// Only documented, closed vocabularies may enter receipts. SDK messages can
// incorporate metadata.raw, provider messages, and other private response data.
const providerAvailabilityCodes = new Set([
  "rate_limited",
  "rate_limit_exceeded",
  "rate_limit_error",
  "overloaded_error",
]);

function apiFailureEnvelope(error: APICallError): unknown {
  if (isRecord(error.data) && isRecord(error.data.error)) return error.data.error;
  // The SDK can retain response bytes while dropping data after its error
  // message processing fails. Read only a bounded envelope; apiFailureDetails
  // still admits only the closed diagnostic vocabulary, never raw messages.
  const body = error.responseBody;
  if (typeof body !== "string" || body.length > 65_536 || Buffer.byteLength(body, "utf8") > 65_536)
    return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
      ? parsed.error
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The documented type of an error envelope. OpenRouter marks a moderation flag with a 403 and
 * the moderation metadata, which has `reasons` and `flagged_input` but no `error_type`. That
 * flag has the meaning of `content_policy_violation`. Basalt keeps only the type, never the
 * reasons or the flagged text.
 */
function providerErrorType(envelope: unknown, status: number | null): ProviderErrorType | null {
  const metadata = isRecord(envelope) && isRecord(envelope.metadata) ? envelope.metadata : null;
  if (isProviderErrorType(metadata?.error_type)) return metadata.error_type;
  if (
    status === 403 &&
    Array.isArray(metadata?.reasons) &&
    typeof metadata?.flagged_input === "string"
  )
    return "content_policy_violation";
  return null;
}

function apiFailureDetails(
  envelope: unknown,
  type: ProviderErrorType | null,
  retryAfter: string | undefined,
): string {
  const metadata = isRecord(envelope) && isRecord(envelope.metadata) ? envelope.metadata : null;
  const details: string[] = [];
  if (type !== null) details.push(`Provider error type: ${type}.`);
  if (
    typeof metadata?.provider_code === "string" &&
    providerAvailabilityCodes.has(metadata.provider_code)
  )
    details.push(`Provider code: ${metadata.provider_code}.`);
  const imageLimit = providerImageLimit(metadata?.raw);
  if (imageLimit !== null)
    details.push(`Provider image limit: ${imageLimit} images in one request.`);
  const seconds = retryAfterSeconds(retryAfter);
  if (seconds !== null) details.push(`Retry-After: ${seconds} seconds.`);
  return details.length > 0 ? ` ${details.join(" ")}` : "";
}

// A provider states its image limit only in its raw message. Keep only the bounded number.
function providerImageLimit(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  const match =
    /at most ([0-9]{1,4}) (?:multimodal inputs|image\(s\)|images)/iu.exec(raw) ??
    /too many images in request: [0-9]{1,6} > ([0-9]{1,4})/iu.exec(raw);
  return match ? Number(match[1]) : null;
}

function retryAfterSeconds(header: string | undefined): number | null {
  if (header === undefined || header.length > 64) return null;
  const value = header.trim();
  let seconds: number;
  if (/^[0-9]+$/u.test(value)) seconds = Number(value);
  else {
    if (
      !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u.test(
        value,
      )
    )
      return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return null;
    seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
  }
  // This is a bounded diagnosis. The bounded client can use it to wait longer before it tries a
  // rate limit again. It never authorizes spending.
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : null;
}

function findApiCallError(error: unknown): APICallError | null {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (APICallError.isInstance(current)) return current;
    if (seen.has(current) || typeof current !== "object") return null;
    seen.add(current);
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

function transportErrorClass(error: unknown): string {
  const names: string[] = [];
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current) || typeof current !== "object") break;
    seen.add(current);
    const name = "name" in current && typeof current.name === "string" ? current.name : "unknown";
    const normalized = name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
      .slice(0, 64);
    names.push(normalized || "unknown");
    current = "cause" in current ? current.cause : null;
  }
  return `transport_${names.join("_caused_by_") || "unknown"}`.slice(0, 256);
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Classify by error identity, never by provider-controlled message text. */
function isTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (
      current.name === "AbortError" ||
      current.name === "TimeoutError" ||
      (code !== undefined && TIMEOUT_CODES.has(code))
    )
      return true;
    current = current.cause;
  }
  return false;
}

function emptyUsage(): ModelUsage {
  return {
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validatedModelAllowlist(allowlistedModels: readonly string[]): readonly string[] {
  if (allowlistedModels.length === 0) throw new Error("At least one model must be allowlisted");
  if (
    allowlistedModels.some(
      (model) =>
        typeof model !== "string" ||
        model.trim().length === 0 ||
        model !== model.trim() ||
        model.length > 256,
    )
  )
    throw new Error("Allowlisted model IDs must be non-empty, bounded, and trimmed");
  if (new Set(allowlistedModels).size !== allowlistedModels.length)
    throw new Error("Allowlisted models must be unique");
  return Object.freeze([...allowlistedModels].sort());
}

function requestConfigurationError(request: ModelTurnRequest): string | null {
  if (typeof request.model !== "string" || request.model.trim().length === 0)
    return "Model request ID must not be empty.";
  if (!Number.isSafeInteger(request.seed)) return "Model request seed must be a safe integer.";
  if (typeof request.system !== "string" || request.system.trim().length === 0)
    return "Model request system prompt must not be empty.";
  if (!Array.isArray(request.messages) || request.messages.length === 0)
    return "Model request must contain at least one message.";
  try {
    const imageMessages = request.messages.filter(
      (message) => message.role === "user" && message.images !== undefined,
    );
    if (imageMessages.length > 4) return "At most four bounded image contexts are allowed";
    for (const message of imageMessages)
      if (message.role === "user" && message.images) validateModelImages(message.images);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid image context";
  }
  if (!Array.isArray(request.tools) || request.tools.length === 0)
    return "Model request must contain at least one tool.";
  // The frozen endpoint's own output limit bounds each request when it is quoted and admitted.
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
    return "Model request output budget must be a positive integer.";
  try {
    assertRequestReasoning(request.reasoning);
    assertRequestSampling(request.sampling);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid request reasoning or sampling policy";
  }
  return null;
}

/** OpenRouter wire values; the call-level options are copied into the request body. */
function sentSampling(request: ModelTurnRequest): Record<string, number> {
  return Object.fromEntries(
    Object.entries(request.sampling ?? {}).filter(
      (entry): entry is [string, number] => entry[1] !== null,
    ),
  );
}
