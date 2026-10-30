import { contentHash, MAX_CAPTURE_BYTES, stableJson } from "../../contracts/src/index.js";
import type { ModelRequestReasoning, ReasoningEffort } from "../../contracts/src/reasoning.js";

// A response continuation keeps the reasoning and the answer. Measured responses used up to
// 13 bytes for each output token, so 8 MiB holds more than 600,000 output tokens. The limit
// is not an output limit, and it leaves room in the 16 MiB receipt.
export const MODEL_CONTINUATION_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_MODEL_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_MODEL_IMAGES = 64;
const MAX_MODEL_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_MODEL_IMAGE_LABEL_CHARS = 512;
export {
  REASONING_EFFORTS,
  type ModelRequestReasoning,
  type ReasoningEffort,
} from "../../contracts/src/reasoning.js";

export interface ModelContinuation {
  transport: string;
  payload: unknown;
  hash: string;
  bytes: number;
}

export type ModelMessage =
  | { role: "user"; content: string; images?: ModelImage[] }
  | {
      role: "assistant";
      content: string;
      toolCalls: ModelToolCall[];
      continuation?: ModelContinuation;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * Provider-neutral, content-bound image. The transport sends the label as text immediately
 * before the image, because a model does not read image file names or metadata.
 */
export interface ModelImage {
  mediaType: "image/png" | "image/jpeg";
  dataBase64: string;
  hash: string;
  label: string;
}

export function validateModelImages(images: ModelImage[]): void {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_MODEL_IMAGES)
    throw new Error("Image context must contain one to sixty-four bounded images");
  let total = 0;
  for (const image of images) {
    if (
      !image ||
      typeof image.label !== "string" ||
      !image.label.trim() ||
      image.label !== image.label.trim() ||
      image.label.length > MAX_MODEL_IMAGE_LABEL_CHARS ||
      /[\r\n]/u.test(image.label)
    )
      throw new Error("Each model image needs a label of one bounded line");
    if (
      !["image/png", "image/jpeg"].includes(image.mediaType) ||
      typeof image.dataBase64 !== "string" ||
      image.dataBase64.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) ||
      typeof image.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(image.hash)
    )
      throw new Error("Model image has invalid format or digest");
    const bytes = Buffer.from(image.dataBase64, "base64");
    if (
      bytes.length < 8 ||
      bytes.length > MAX_CAPTURE_BYTES ||
      bytes.toString("base64") !== image.dataBase64 ||
      contentHash(bytes) !== image.hash ||
      (image.mediaType === "image/png" &&
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (image.mediaType === "image/jpeg" &&
        (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9))
    )
      throw new Error("Model image bytes differ from their bounded media identity");
    total += bytes.length;
    if (total > MAX_MODEL_IMAGE_BYTES)
      throw new Error("Image payload exceeds the bounded presentation size");
  }
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelToolDefinition {
  name: string;
  description: string;
  /** The declared JSON Schema. The local validators always use this complete schema. */
  parameters: unknown;
  /**
   * Send the tool in strict mode. The transport then sends a strict wire form of the schema,
   * or it refuses the request before dispatch. Omit the marker for a tool that is not strict.
   */
  strict?: true;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/** Sampling parameters in their OpenRouter wire names. */
export const SAMPLING_PARAMETERS = [
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
] as const;
type SamplingParameter = (typeof SAMPLING_PARAMETERS)[number];

/**
 * One value for each sampling parameter. A number is sent explicitly. Null sends no value,
 * so the provider default applies and the request does not record it.
 */
export type ModelSampling = Record<SamplingParameter, number | null>;

export interface ModelTurnRequest {
  model: string;
  /** A best-effort provider seed. It does not make a response reproducible. */
  seed: number;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  maxOutputTokens: number;
  reasoning?: ModelRequestReasoning;
  /** Omission sends no sampling parameter. */
  sampling?: ModelSampling;
}

export interface ModelResponseFacts {
  requestedModel: string;
  /** Exact model reported by the response envelope, never inferred from the request. */
  resolvedModel: string | null;
  /** Exact serving provider reported by OpenRouter, or null when no response established it. */
  servingProvider: string | null;
  responseId: string | null;
  requestedServiceTier: "default" | "flex" | "priority" | null;
  servingServiceTier: string | null;
  latencyMs: number;
  retryCount: 0;
  finishReason: string | null;
  continuationHash: string | null;
  continuationBytes: number | null;
}

/**
 * The closed list of provider error types. OpenRouter documents these categories in the
 * `error_type` of its error metadata. A result keeps only a value of this list, never the text
 * of the provider.
 */
export const PROVIDER_ERROR_TYPES = [
  "context_length_exceeded",
  "max_tokens_exceeded",
  "token_limit_exceeded",
  "string_too_long",
  "authentication",
  "permission_denied",
  "payment_required",
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "invalid_request",
  "invalid_prompt",
  "not_found",
  "precondition_failed",
  "payload_too_large",
  "unprocessable",
  "content_policy_violation",
  "refusal",
  "invalid_image",
  "image_too_large",
  "image_too_small",
  "unsupported_image_format",
  "image_not_found",
  "image_download_failed",
  "server",
  "timeout",
  "unmapped",
] as const;
export type ProviderErrorType = (typeof PROVIDER_ERROR_TYPES)[number];

export function isProviderErrorType(value: unknown): value is ProviderErrorType {
  return (PROVIDER_ERROR_TYPES as readonly unknown[]).includes(value);
}

interface ModelTurnBase {
  usage: ModelUsage;
  requestHash: string;
  /** Hash of the normalized response facts and usage admitted by the transport. */
  responseFactsHash?: string;
}

export type ModelTurnResult =
  | (ModelTurnBase & {
      kind: "assistant";
      message: Extract<ModelMessage, { role: "assistant" }>;
      stopReason: "end_turn" | "tool_calls" | "max_tokens" | "refusal" | "other";
      responseHash: string;
      responseFacts: ModelResponseFacts;
    })
  | (ModelTurnBase & {
      kind: "invalid_model_response";
      errorClass: string;
      message: string;
      responseFacts: ModelResponseFacts;
    })
  | (ModelTurnBase & {
      kind: "provider_error";
      errorClass: string;
      /** The documented type of the provider failure, or null when the provider gave none. */
      providerErrorType: ProviderErrorType | null;
      message: string;
      retryable: boolean;
      responseFacts: ModelResponseFacts;
    });

export interface ModelClientDescriptor {
  transport: string;
  configuration: {
    aiSdk: { package: string };
    providerAdapter: { package: string };
    routing: {
      allowlistHash: string;
      allowlistedModels: readonly string[];
      providerAllowlist: "none";
      modelFallbacks: false;
      /** OpenRouter picks the endpoint and its fallbacks with its default routing. */
      providerSelection: "openrouter_default";
      requireParameters: true;
      requireTools: true;
      routes?: Record<string, ModelRoute>;
    };
    reasoning: { effort: "catalog_supported_balanced"; exclude: false; mode: "when_supported" };
    request: {
      steps: 1;
      toolChoice: "auto";
      providerParallelToolCalls: "not_requested";
      toolBatchExecution: "atomic_validate_then_sequential";
      toolNameEncoding: "openai_function_slug";
      toolSchemaMode: "declared_per_tool";
      responseDelivery: "server_sent_events";
      /** The transport stops a stream when one run of whitespace is longer than this. */
      runawayWhitespaceStop: number;
      maxRetries: 0;
      telemetry: false;
      timeoutPolicy: "explicit_cancellation";
      seed: "treatment_random_seed_31_bit";
      sampling: "explicit_request_values";
      imagePresentation: "labelled_images_before_text";
    };
    continuation: { maxBytes: number };
  };
}

/**
 * The frozen endpoint set of one model. OpenRouter sends each request to the endpoint of the set
 * with the highest live throughput, and to the next endpoint if that one fails.
 */
export interface ModelRoute {
  seedSupported: boolean;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: "default" | "flex" | "priority";
  maxPrice: { prompt: number; completion: number; request: number; image?: number };
}

export interface ModelClient {
  readonly descriptor: ModelClientDescriptor;
  /** True only when the adapter observes the actual network dispatch boundary. */
  readonly observesDispatch?: true;
  /** Pure transport serialization checks. Must never perform I/O or dispatch. */
  validateRequest?(request: ModelTurnRequest): void;
  complete(
    request: ModelTurnRequest,
    signal?: AbortSignal,
    observer?: ModelDispatchObserver,
  ): Promise<ModelTurnResult>;
}

export interface ModelResponseIdentity {
  generationId: string | null;
  resolvedModel: string | null;
  servingProvider: string | null;
  costUsd: number | null;
  servingServiceTier: string | null;
}

/** Provider-independent durability hooks; neither hook may initiate model work. */
export interface ModelDispatchObserver {
  beforeDispatch(): Promise<void>;
  response(identity: ModelResponseIdentity): Promise<void>;
}

/** The request failed before any transport dispatch or spending reservation. */
export class ModelRequestAdmissionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Model request admission was interrupted", {
      cause,
    });
    this.name = "ModelRequestAdmissionError";
  }
}

/** Local request validation failed; no provider request was sent. */
export class ModelRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestValidationError";
  }
}

/** A reserved request has no reconciled response yet; its execution must remain recoverable. */
export class ModelRequestPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestPendingError";
  }
}

/** Hash the exact secret-free request and frozen transport policy sent to a model client. */
export function modelTurnRequestHash(
  request: ModelTurnRequest,
  descriptor: ModelClientDescriptor,
): string {
  return contentHash(
    stableJson({
      model: request.model,
      seed: request.seed,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(request.sampling ? { sampling: request.sampling } : {}),
      transport: descriptor,
    }),
  );
}
