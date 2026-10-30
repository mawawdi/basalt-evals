import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderFailure,
  OpenRouterModelClient,
  PROVIDER_ERROR_TYPES,
  type ModelTurnResult,
  type ProviderErrorType,
  type ProviderFailureScope,
} from "../packages/model-client/src/index.js";
import { sseResponse } from "./openrouter-stream.js";

/** The expected scope of each documented error type. It does not read the table of the module. */
const TYPE_SCOPES: Record<ProviderErrorType, ProviderFailureScope> = {
  authentication: "account",
  payment_required: "account",
  permission_denied: "account",
  not_found: "model",
  rate_limit_exceeded: "persistent",
  provider_overloaded: "persistent",
  provider_unavailable: "persistent",
  server: "persistent",
  timeout: "persistent",
  unmapped: "persistent",
  context_length_exceeded: "request",
  max_tokens_exceeded: "request",
  token_limit_exceeded: "request",
  string_too_long: "request",
  invalid_request: "request",
  invalid_prompt: "request",
  precondition_failed: "request",
  payload_too_large: "request",
  unprocessable: "request",
  content_policy_violation: "request",
  refusal: "request",
  invalid_image: "request",
  image_too_large: "request",
  image_too_small: "request",
  unsupported_image_format: "request",
  image_not_found: "request",
  image_download_failed: "request",
};

const STATUS_SCOPES: Array<[number, ProviderFailureScope]> = [
  [400, "request"],
  [401, "account"],
  [402, "account"],
  [403, "account"],
  [404, "model"],
  [408, "persistent"],
  [409, "request"],
  [413, "request"],
  [422, "request"],
  [429, "persistent"],
  [500, "persistent"],
  [502, "persistent"],
  [503, "persistent"],
  [504, "persistent"],
];

test("each status and error type maps to one failure scope", () => {
  assert.deepEqual(Object.keys(TYPE_SCOPES).sort(), [...PROVIDER_ERROR_TYPES].sort());
  for (const type of PROVIDER_ERROR_TYPES)
    for (const errorClass of ["http_400", "provider_response_error_500"]) {
      assert.deepEqual(
        classifyProviderFailure(providerError(errorClass, type, 0.001)),
        {
          scope: TYPE_SCOPES[type],
          refusal: type === "refusal" || type === "content_policy_violation",
        },
        `${errorClass} ${type}`,
      );
    }
  for (const [status, scope] of STATUS_SCOPES)
    for (const prefix of ["http", "provider_response_error"])
      assert.deepEqual(
        classifyProviderFailure(providerError(`${prefix}_${status}`, null, 0.001)),
        { scope, refusal: false },
        `${prefix}_${status}`,
      );
  // A 5xx failure without a known charge is uncertain, so it has no scope.
  assert.equal(classifyProviderFailure(providerError("http_502", null, null)), null);
  assert.equal(classifyProviderFailure(providerError("http_503", "server", null)), null);
  // A rejection has a known zero charge.
  assert.deepEqual(classifyProviderFailure(providerError("http_429", null, null)), {
    scope: "persistent",
    refusal: false,
  });
  // A failure without a status and without a documented type is not a provider failure scope.
  for (const errorClass of ["timeout", "cancelled", "runaway_output", "transport_type_error"])
    assert.equal(classifyProviderFailure(providerError(errorClass, null, null)), null);
  const failure = providerError("http_400", null, null);
  assert.equal(
    classifyProviderFailure({
      kind: "invalid_model_response",
      errorClass: "invalid_tool_input",
      message: "The provider returned an invalid Basalt tool request.",
      usage: failure.usage,
      requestHash: failure.requestHash,
      responseFacts: failure.responseFacts,
    }),
    null,
  );
});

test("a moderation 403 is a request failure", async () => {
  const moderation = {
    error: {
      code: 403,
      message: "private-provider-message",
      metadata: {
        reasons: ["private-reason"],
        flagged_input: "private-flagged-input",
        provider_name: "private-provider-name",
        model_slug: "fake/model",
      },
    },
  };
  for (const response of [
    () => Response.json(moderation, { status: 403 }),
    // OpenRouter sends an error inside a started stream as an event of that stream.
    () => sseResponse([moderation]),
    () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "private-provider-message",
            metadata: { error_type: "content_policy_violation" },
          },
        },
        { status: 403 },
      ),
  ]) {
    const result = await complete(response);
    assert.equal(result.kind, "provider_error");
    if (result.kind !== "provider_error") return;
    assert.equal(result.providerErrorType, "content_policy_violation");
    assert.match(result.message, /Provider error type: content_policy_violation\./u);
    assert.doesNotMatch(JSON.stringify(result), /private[-_]/u);
    assert.deepEqual(classifyProviderFailure(result), { scope: "request", refusal: true });
  }
  for (const body of [
    { error: { code: 403, message: "private-provider-message" } },
    {
      error: {
        code: 403,
        message: "private-provider-message",
        metadata: { error_type: "permission_denied" },
      },
    },
    // The moderation metadata needs both fields. Other metadata is not a moderation flag.
    {
      error: {
        code: 403,
        message: "private-provider-message",
        metadata: { reasons: "private-reason", flagged_input: "private-flagged-input" },
      },
    },
  ]) {
    const result = await complete(() => Response.json(body, { status: 403 }));
    assert.deepEqual(classifyProviderFailure(result), { scope: "account", refusal: false });
  }
});

test("a 404 is a model failure", async () => {
  for (const metadata of [undefined, { error_type: "not_found" }]) {
    const result = await complete(() =>
      Response.json(
        { error: { code: 404, message: "private-provider-message", metadata } },
        { status: 404 },
      ),
    );
    assert.equal(result.kind, "provider_error");
    assert.equal(result.kind === "provider_error" && result.errorClass, "http_404");
    assert.deepEqual(classifyProviderFailure(result), { scope: "model", refusal: false });
  }
  // A missing image is a failure of the request, not of the model.
  assert.deepEqual(classifyProviderFailure(providerError("http_404", "image_not_found", null)), {
    scope: "request",
    refusal: false,
  });
});

function providerError(
  errorClass: string,
  providerErrorType: ProviderErrorType | null,
  costUsd: number | null,
): Extract<ModelTurnResult, { kind: "provider_error" }> {
  return {
    kind: "provider_error",
    errorClass,
    providerErrorType,
    message: "Offline provider failure.",
    retryable: false,
    requestHash: "a".repeat(64),
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd,
    },
    responseFacts: {
      requestedModel: "fake/model",
      resolvedModel: null,
      servingProvider: null,
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId: null,
      latencyMs: 1,
      retryCount: 0,
      finishReason: null,
      continuationHash: null,
      continuationBytes: null,
    },
  };
}

async function complete(response: () => Response): Promise<ModelTurnResult> {
  const client = new OpenRouterModelClient({
    apiKey: "private-test-api-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => response(),
  });
  return client.complete({
    model: "fake/model",
    seed: 1,
    system: "private-system-prompt",
    messages: [{ role: "user", content: "private-user-prompt" }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
}
