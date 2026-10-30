import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { OpenRouterModelClient } from "../packages/model-client/src/index.js";
import { validateModelImages } from "../packages/model-client/src/index.js";
import { toWireTools } from "../packages/model-client/src/openrouter-ai-sdk.js";
import type {
  ModelResponseIdentity,
  ModelTurnRequest,
} from "../packages/model-client/src/contracts.js";
import {
  chunk,
  endlessStream,
  generationRecord,
  sseResponse,
  streamedCompletion,
} from "./openrouter-stream.js";

test("model images are content-bound and rejected before transport when altered", async () => {
  const bytes = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const image = {
    mediaType: "image/png" as const,
    dataBase64: bytes.toString("base64"),
    hash: contentHash(bytes),
    label: "Image 1: frame-1.",
  };
  assert.doesNotThrow(() => validateModelImages([image]));
  assert.throws(() => validateModelImages([{ ...image, hash: "a".repeat(64) }]), /differ/);
  for (const label of ["", " Image 1:", "Image 1:\nframe-1", "x".repeat(513)])
    assert.throws(() => validateModelImages([{ ...image, label }]), /label of one bounded line/);
  assert.doesNotThrow(() => validateModelImages(Array(64).fill(image)));
  assert.throws(() => validateModelImages(Array(65).fill(image)), /one to sixty-four/);
  let fetched = false;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("network should not be called");
    },
  });
  const result = await client.complete({
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [
      { role: "user", content: "Inspect the frame.", images: [{ ...image, hash: "a".repeat(64) }] },
    ],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(result.kind, "provider_error");
  assert.equal(fetched, false);
});

test("OpenRouter transport rejects out-of-policy requests before network I/O", async () => {
  let fetched = false;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("network should not be called");
    },
  });
  const result = await client.complete({
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 0,
  });
  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") assert.equal(result.errorClass, "request_configuration");
  assert.equal(fetched, false);
});

test("OpenRouter transport names the local cause of a request that it cannot prepare", async () => {
  let fetched = false;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("network should not be called");
    },
  });
  const parameters = { type: "object", properties: {}, additionalProperties: false };
  const result = await client.complete({
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [
      { name: "workspace.list", description: "List files.", parameters },
      { name: "workspace_list", description: "List files again.", parameters },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") {
    assert.equal(result.errorClass, "request_configuration");
    assert.match(result.message, /collide on provider wire name workspace_list/);
  }
  assert.equal(fetched, false);
});

test("OpenRouter transport rejects blank credentials", () => {
  assert.throws(
    () => new OpenRouterModelClient({ apiKey: "   ", allowedModels: ["fake/model"] }),
    /OPENROUTER_API_KEY is required/,
  );
});

test("Stop during durable dispatch preparation prevents provider network I/O", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new OpenRouterModelClient({
    apiKey: "offline-test",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      calls++;
      throw new Error("A stopped request must not dispatch");
    },
  });
  const result = await client.complete(
    {
      model: "fake/model",
      seed: 1,
      system: "Use the tool.",
      messages: [{ role: "user", content: "Inspect the workspace." }],
      tools: [
        {
          name: "workspace.list",
          description: "List files.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      maxOutputTokens: 100,
    },
    controller.signal,
    {
      beforeDispatch: async () => {
        await Promise.resolve();
        controller.abort();
      },
      response: async () => {
        assert.fail("A stopped request cannot receive provider identity");
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") assert.equal(result.errorClass, "cancelled");
});

test("OpenRouter waits without a local timer and reports explicit Stop as cancellation", async (t) => {
  const controller = new AbortController();
  let dispatched!: () => void;
  const started = new Promise<void>((done) => {
    dispatched = done;
  });
  let calls = 0;
  const client = new OpenRouterModelClient({
    apiKey: "offline-test",
    allowedModels: ["fake/model"],
    fetchImpl: async (_url, init) => {
      calls++;
      const signal = init?.signal;
      assert.ok(signal);
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = client.complete(
    {
      model: "fake/model",
      seed: 1,
      system: "Use the tool.",
      messages: [{ role: "user", content: "Inspect the workspace." }],
      tools: [
        {
          name: "workspace.list",
          description: "List files.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      maxOutputTokens: 100,
    },
    controller.signal,
  );
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await started;
  t.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.equal(settled, false);
  controller.abort();
  const result = await pending;
  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") assert.equal(result.errorClass, "cancelled");
  assert.equal(result.usage.costUsd, null);
  assert.equal(calls, 1);
});

test("the request lets OpenRouter pick the endpoint and sends only the price limit", async () => {
  let wire: unknown;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    routes: {
      "fake/model": {
        seedSupported: false,
        reasoningEffort: null,
        serviceTier: "default" as const,
        maxPrice: { prompt: 1, completion: 2, request: 0.1, image: 0.2 },
      },
    },
    fetchImpl: async (_url, options) => {
      wire = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return streamedCompletion({
        id: "gen-pinned",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  await client.complete({
    model: "fake/model",
    seed: 7,
    system: "Build the task.",
    messages: [{ role: "user", content: "Go" }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.ok(wire);
  const request = wire as Record<string, unknown>;
  const provider = request.provider as Record<string, unknown>;
  // OpenRouter picks the endpoint and the fallbacks with its default routing.
  assert.deepEqual(Object.keys(provider).sort(), [
    "allow_fallbacks",
    "max_price",
    "require_parameters",
  ]);
  assert.equal(provider.allow_fallbacks, true);
  assert.equal(provider.require_parameters, true);
  assert.deepEqual(provider.max_price, { prompt: 1, completion: 2, request: 0.1, image: 0.2 });
  assert.equal(request.seed, undefined);
  for (const parameter of ["temperature", "top_p", "top_k", "repetition_penalty"])
    assert.equal(request[parameter], undefined, "a request without sampling sends none");
});

test("the wire seed fits a signed 32-bit integer and stays deterministic", async () => {
  const seeds: unknown[] = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async (_url, options) => {
      seeds.push((JSON.parse(String(options?.body)) as Record<string, unknown>).seed);
      return streamedCompletion({
        id: "generation-1",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  // Google Vertex rejected the seed 4194367865 with "Invalid value at 'generation_config.seed'".
  for (const seed of [4_194_367_865, 7])
    await client.complete({
      model: "fake/model",
      seed,
      system: "Judge.",
      messages: [{ role: "user", content: "Go" }],
      tools: [
        {
          name: "workspace.list",
          description: "List files.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      maxOutputTokens: 100,
    });
  assert.deepEqual(seeds, [4_194_367_865 - 2 ** 31, 7]);
});

test("labelled images precede the question, and only explicit sampling values reach the wire", async () => {
  let wire: Record<string, unknown> | undefined;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async (_url, options) => {
      wire = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return streamedCompletion({
        id: "gen-labels",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  const bytes = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const image = (label: string) => ({
    mediaType: "image/png" as const,
    dataBase64: bytes.toString("base64"),
    hash: contentHash(bytes),
    label,
  });
  await client.complete({
    model: "fake/model",
    seed: 7,
    system: "Judge the frames.",
    messages: [
      {
        role: "user",
        content: "Question text.",
        images: [image("Image 1: frame-1."), image("Image 2: frame-2.")],
      },
    ],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
    sampling: {
      temperature: 1,
      top_p: 0.95,
      top_k: null,
      frequency_penalty: 0,
      presence_penalty: null,
      repetition_penalty: null,
    },
  });
  const user = (wire!.messages as Array<{ role: string; content: unknown }>).find(
    (message) => message.role === "user",
  )!;
  const parts = user.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    parts.map((part) => (part.type === "text" ? part.text : part.type)),
    ["Image 1: frame-1.", "image_url", "Image 2: frame-2.", "image_url", "Question text."],
  );
  assert.ok(!JSON.stringify(parts).includes("development-evidence"), "no file name is sent");
  assert.equal(wire!.temperature, 1);
  assert.equal(wire!.top_p, 0.95);
  assert.equal(wire!.frequency_penalty, 0);
  for (const parameter of ["top_k", "presence_penalty", "repetition_penalty"])
    assert.equal(wire![parameter], undefined, "a null value leaves the provider default");
});

test("an untimed paid request is accepted without a client deadline", async () => {
  let fetched = false;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      fetched = true;
      return streamedCompletion({
        id: "gen-untimed",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  const result = await client.complete({
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Continue." }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(fetched, true);
  assert.equal(result.kind, "assistant");
});

test("a judge response with more than 256 KiB of reasoning keeps its answer", async () => {
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model-20260917"],
    fetchImpl: async () =>
      streamedCompletion({
        id: "generation-1",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning: "Compare the criterion with the evidence. ".repeat(16_000),
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "submit_judgment_batch", arguments: '{"decisions":[]}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 48_000, total_tokens: 48_001, cost: 0 },
      }),
  });
  const result = await client.complete({
    model: "fake/model-20260917",
    seed: 1,
    system: "Judge the criteria.",
    messages: [{ role: "user", content: "Judge the evidence." }],
    tools: [
      {
        name: "submit_judgment_batch",
        description: "Submit the decisions.",
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    ],
    maxOutputTokens: 131_072,
  });
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") return;
  assert.ok(result.message.continuation!.bytes > 256 * 1024);
  assert.equal(result.message.toolCalls[0]?.name, "submit_judgment_batch");
});

test("a continuation keeps each reasoning copy that the next request sends, and no other copy", async () => {
  const reasoning = "Read the scene before the patch. ".repeat(2_000);
  const details = [{ type: "reasoning.text", text: reasoning, format: "unknown", index: 0 }];
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model-20260917"],
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return streamedCompletion({
        id: `generation-${bodies.length}`,
        model: "fake/model",
        provider: "Fake Provider",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning,
              reasoning_details: details,
              tool_calls: ["call-1", "call-2"].map((id) => ({
                id,
                type: "function" as const,
                function: { name: "workspace_list", arguments: "{}" },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  const tools = [
    {
      name: "workspace.list",
      description: "List files.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  const first = await client.complete({
    model: "fake/model-20260917",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools,
    maxOutputTokens: 100,
  });
  assert.equal(first.kind, "assistant");
  if (first.kind !== "assistant") return;
  // The request sends the reasoning text and the reasoning details. The continuation keeps
  // these two copies only.
  assert.ok(first.message.continuation!.bytes < 2.2 * reasoning.length);
  await client.complete({
    model: "fake/model-20260917",
    seed: 1,
    system: "Use the tool.",
    messages: [
      { role: "user", content: "Inspect the workspace." },
      first.message,
      ...["call-1", "call-2"].map((id) => ({
        role: "tool" as const,
        toolCallId: id,
        name: "workspace.list",
        content: '{"files":[]}',
      })),
    ],
    tools,
    maxOutputTokens: 100,
  });
  const sent = (bodies[1]!.messages as Array<Record<string, unknown>>).find(
    (message) => message.role === "assistant",
  )!;
  assert.equal(sent.reasoning, reasoning);
  assert.deepEqual(sent.reasoning_details, details);
  assert.equal((sent.tool_calls as unknown[]).length, 2);
});

test("OpenRouter transport canonicalizes successful AI SDK continuations", async () => {
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model-20260917"],
    fetchImpl: async () =>
      streamedCompletion({
        id: "generation-1",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "workspace_list", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      }),
  });
  const result = await client.complete({
    model: "fake/model-20260917",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") return;
  assert.equal(result.responseFacts.requestedModel, "fake/model-20260917");
  assert.equal(result.responseFacts.resolvedModel, "fake/model");
  assert.equal(result.responseFacts.servingProvider, "Fake Provider");
  assert.deepEqual(result.message.toolCalls, [
    { id: "call-1", name: "workspace.list", arguments: {} },
  ]);
  assert.ok(result.message.continuation);
  assert.match(result.message.continuation.hash, /^[a-f0-9]{64}$/);
  const followup = await client.complete({
    model: "fake/model-20260917",
    seed: 1,
    system: "Use the tool.",
    messages: [
      { role: "user", content: "Inspect the workspace." },
      result.message,
      { role: "tool", toolCallId: "call-1", name: "workspace.list", content: '{"files":[]}' },
    ],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(followup.kind, "assistant");
});

test("OpenRouter transport records a sanitized unexpected error type", async () => {
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      throw new TypeError("private network detail");
    },
  });
  const result = await client.complete({
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [
      {
        name: "workspace.list",
        description: "List files.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    maxOutputTokens: 100,
  });
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(result.errorClass, "transport_type_error");
  assert.doesNotMatch(result.message, /private network detail/);
});

test("OpenRouter retains typed failure diagnostics and bounded wait hints without retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00.000Z") });
  for (const example of [
    {
      status: 429,
      code: 429,
      errorType: "rate_limit_exceeded",
      providerCode: "rate_limited",
      retryAfter: "60",
      seconds: 60,
    },
    {
      status: 503,
      code: 503,
      errorType: "provider_overloaded",
      providerCode: "overloaded_error",
      retryAfter: "Wed, 30 Sep 2026 12:01:30 GMT",
      seconds: 90,
    },
    {
      status: 200,
      code: 429,
      errorType: "rate_limit_exceeded",
      providerCode: "rate_limit_error",
      retryAfter: "0",
      seconds: 0,
    },
    {
      status: 200,
      code: 503,
      errorType: "provider_overloaded",
      providerCode: "overloaded_error",
      retryAfter: "86400",
      seconds: 86_400,
    },
  ]) {
    const result = await completeErrorResponse(
      example.status,
      {
        error: {
          code: example.code,
          message: "private-provider-message",
          metadata: {
            error_type: example.errorType,
            provider_code: example.providerCode,
            provider_name: "private-provider-name",
            raw: '{"error":{"message":"private-response-body"}}',
            reasoning: "private-reasoning",
          },
        },
      },
      example.retryAfter,
    );
    const prefix =
      example.status === 200
        ? `OpenRouter returned an error response (code ${example.code}).`
        : `OpenRouter request failed with HTTP ${example.status}.`;
    assert.equal(
      result.errorClass,
      example.status === 200 ? `provider_response_error_${example.code}` : `http_${example.status}`,
    );
    assert.equal(
      result.message,
      `${prefix} Provider error type: ${example.errorType}. Provider code: ${example.providerCode}. Retry-After: ${example.seconds} seconds.`,
    );
    assert.equal(result.providerErrorType, example.errorType);
    assert.equal(result.retryable, example.status !== 200);
  }
});

test("a mid-stream error event keeps its documented provider error type", async () => {
  for (const errorType of ["refusal", "context_length_exceeded", "provider_unavailable"]) {
    const event = {
      ...(chunk("gen-mid-stream", { content: "" }, "error") as Record<string, unknown>),
      error: {
        code: errorType === "provider_unavailable" ? 502 : errorType === "refusal" ? 403 : 400,
        message: "private-provider-message",
        metadata: { error_type: errorType, provider_code: "private-provider-code" },
      },
    };
    const client = new OpenRouterModelClient({
      apiKey: "private-test-api-key",
      allowedModels: ["fake/model"],
      fetchImpl: async () => sseResponse([event]),
    });
    const result = await client.complete({
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
    assert.equal(result.kind, "provider_error");
    if (result.kind !== "provider_error") return;
    assert.equal(result.providerErrorType, errorType);
    assert.match(result.errorClass, /^provider_response_error_[45][0-9]{2}$/u);
    // The event carries a generation ID, so the charge is not known from the error alone.
    assert.equal(result.responseFacts.responseId, "gen-mid-stream");
    assert.doesNotMatch(JSON.stringify(result), /private[-_]/u);
  }
});

test("an HTTP gateway timeout keeps its status instead of becoming a transport timeout", async () => {
  const result = await completeErrorResponse(
    504,
    { error: { code: 504, message: "Upstream request timed out" } },
    "30",
  );
  assert.equal(result.errorClass, "http_504");
  assert.match(result.message, /^OpenRouter request failed with HTTP 504\./);
});

test("OpenRouter keeps safe diagnostics when the SDK cannot process a bounded error envelope", async () => {
  const envelope = (depth: number) =>
    '{"error":{"code":503,"message":"private-provider-message","metadata":{"error_type":"provider_overloaded","provider_code":"overloaded_error","raw":' +
    '{"error":'.repeat(depth) +
    '{"message":"private-provider-detail"}' +
    "}".repeat(depth) +
    "}}}";
  const bounded = await completeErrorResponse(503, envelope(6_000), "120");
  assert.equal(
    bounded.message,
    "OpenRouter request failed with HTTP 503. Provider error type: provider_overloaded. Provider code: overloaded_error. Retry-After: 120 seconds.",
  );
  assert.equal(bounded.providerErrorType, "provider_overloaded");
  const oversized = await completeErrorResponse(503, envelope(9_000), "120");
  assert.equal(
    oversized.message,
    "OpenRouter request failed with HTTP 503. Retry-After: 120 seconds.",
  );
  assert.equal(oversized.providerErrorType, null);
});

test("OpenRouter ignores unknown or malformed diagnostics instead of retaining provider content", async () => {
  for (const status of [200, 429]) {
    const prefix =
      status === 200
        ? "OpenRouter returned an error response (code 429)."
        : "OpenRouter request failed with HTTP 429.";
    for (const metadata of [
      undefined,
      null,
      [],
      "private-metadata",
      { error_type: ["rate_limit_exceeded"], provider_code: { code: "rate_limited" } },
      { error_type: "private_secret_token", provider_code: "private_secret_token" },
      { error_type: "RATE_LIMIT_EXCEEDED", provider_code: "RATE_LIMITED" },
      {
        error_type: "rate_limit_exceeded private-token",
        provider_code: "rate_limited\nprivate-token",
      },
    ]) {
      const result = await completeErrorResponse(status, {
        error: { code: 429, message: "private-provider-message", metadata },
      });
      assert.equal(result.message, prefix);
      assert.equal(result.providerErrorType, null);
      assert.equal(result.errorClass, status === 200 ? "provider_response_error_429" : "http_429");
    }
    const result = await completeErrorResponse(status, {
      error: {
        code: 429,
        message: "private-provider-message",
        metadata: { error_type: "rate_limit_exceeded", provider_code: "private_secret_token" },
      },
    });
    assert.equal(result.message, `${prefix} Provider error type: rate_limit_exceeded.`);
    assert.equal(result.providerErrorType, "rate_limit_exceeded");
  }
});

test("an image count rejection keeps only the provider image limit", async () => {
  for (const [raw, limit] of [
    [
      '{"detail":"Model supports at most 9 multimodal inputs per request; received 30. private-detail"}',
      9,
    ],
    ['{"error":"At most 10 image(s) may be provided in one request. private-detail"}', 10],
    ['{"error":{"message":"Too many images in request: 30 > 4","type":"private-type"}}', 4],
  ] as const) {
    const result = await completeErrorResponse(400, {
      error: {
        code: 400,
        message: "Provider returned error",
        metadata: { raw, provider_name: "private-provider-name" },
      },
    });
    assert.equal(result.errorClass, "http_400");
    assert.equal(
      result.message,
      `OpenRouter request failed with HTTP 400. Provider image limit: ${limit} images in one request.`,
    );
  }
});

test("OpenRouter normalizes valid wait dates and ignores malformed or excessive Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00.500Z") });
  const body = { error: { code: 429, message: "private-provider-message" } };
  for (const retryAfter of [
    "",
    "-1",
    "1.5",
    "1e2",
    "NaN",
    "Infinity",
    "86401",
    "9".repeat(65),
    "private-header-secret",
    "Wed, 30 Sep 2026 12:01:00 GMT private-header-secret",
    "2026-09-30T12:01:00.000Z",
    "Tue, 30 Sep 2026 12:01:00 GMT",
    "Thu, 31 Sep 2026 12:01:00 GMT",
    "Wed, 30 Sep 2026 25:00:00 GMT",
    "Fri, 02 Oct 2026 12:00:00 GMT",
  ]) {
    const result = await completeErrorResponse(429, body, retryAfter);
    assert.equal(result.message, "OpenRouter request failed with HTTP 429.", retryAfter);
  }
  for (const [retryAfter, seconds] of [
    ["000060", 60],
    ["Wed, 30 Sep 2026 12:01:01 GMT", 61],
    ["Wed, 30 Sep 2026 11:59:00 GMT", 0],
  ] as const) {
    const result = await completeErrorResponse(429, body, retryAfter);
    assert.equal(
      result.message,
      `OpenRouter request failed with HTTP 429. Retry-After: ${seconds} seconds.`,
    );
  }
  const malformed = await completeErrorResponse(429, "private-invalid-response-body");
  assert.equal(malformed.message, "OpenRouter request failed with HTTP 429.");
});

const writeTool = {
  name: "workspace.write",
  description: "Write a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

function writeRequest(): ModelTurnRequest {
  return {
    model: "fake/model",
    seed: 1,
    system: "Use the tool.",
    messages: [{ role: "user", content: "Write the file." }],
    tools: [writeTool],
    maxOutputTokens: 100,
  };
}

test("a strict tool sends its strict wire schema, and a tool that is not strict goes out unchanged", async () => {
  const declared = {
    type: "object",
    properties: {
      kind: { const: "wait" },
      steps: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 3 },
    },
    required: ["kind", "steps"],
    additionalProperties: false,
  };
  const strictWire = {
    type: "object",
    properties: {
      kind: { enum: ["wait"] },
      // Each removed bound goes into the description of its field.
      steps: {
        type: "array",
        items: { type: "integer", description: "The value is 0 or more." },
        description: "The list has 3 or fewer items.",
      },
    },
    required: ["kind", "steps"],
    additionalProperties: false,
  };
  const plan = { name: "submit.plan", description: "Submit.", parameters: declared };
  const tools = [writeTool, { ...plan, strict: true as const }];
  let wire: Record<string, unknown> | undefined;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async (_url, init) => {
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamedCompletion({
        id: "gen-strict",
        model: "fake/model",
        provider: "Fake Provider",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      });
    },
  });
  const result = await client.complete({ ...writeRequest(), tools });
  assert.equal(result.kind, "assistant");
  assert.deepEqual(wire?.tools, [
    {
      type: "function",
      function: {
        name: "workspace_write",
        description: "Basalt tool workspace.write. Write a file.",
        parameters: writeTool.parameters,
        strict: false,
      },
    },
    {
      type: "function",
      function: {
        name: "submit_plan",
        description: "Basalt tool submit.plan. Submit.",
        parameters: strictWire,
        strict: true,
      },
    },
  ]);
  const sdkTools = toWireTools(tools).tools;
  assert.equal(sdkTools.workspace_write!.strict, false);
  assert.equal(sdkTools.submit_plan!.strict, true);
  assert.deepEqual(
    (sdkTools.submit_plan!.inputSchema as { jsonSchema: unknown }).jsonSchema,
    strictWire,
  );
  assert.equal(declared.properties.steps.maxItems, 3, "The declared schema stays complete");
  const loose = await client.complete({ ...writeRequest(), tools: [writeTool, plan] });
  assert.notEqual(
    result.requestHash,
    loose.requestHash,
    "The strict marker is in the request identity",
  );
});

test("an incompatible strict tool fails as request configuration before any network call", async () => {
  let fetched = false;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("network should not be called");
    },
  });
  for (const [tool, message] of [
    [
      {
        ...writeTool,
        strict: true as const,
        parameters: { ...writeTool.parameters, required: ["path"] },
      },
      "Basalt tool workspace.write cannot use strict mode. The schema at # is an object whose property content is not in required.",
    ],
    [
      { ...writeTool, strict: false as unknown as true },
      "Basalt tool workspace.write has an invalid strict marker. Use strict: true, or omit the marker.",
    ],
  ] as const) {
    const result = await client.complete({ ...writeRequest(), tools: [tool] });
    assert.equal(result.kind, "provider_error");
    if (result.kind !== "provider_error") return;
    assert.equal(result.errorClass, "request_configuration");
    assert.equal(result.message, message);
    assert.throws(() => client.validateRequest({ ...writeRequest(), tools: [tool] }), { message });
  }
  assert.equal(fetched, false);
});

test("a streamed answer keeps the result shape of a complete response", async () => {
  let wire: Record<string, unknown> | undefined;
  const identities: ModelResponseIdentity[] = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async (_url, init) => {
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const call = (fn: Record<string, unknown>, first = false) => ({
        tool_calls: [
          { index: 0, ...(first ? { id: "call-1", type: "function" } : {}), function: fn },
        ],
      });
      return sseResponse([
        chunk("gen-streamed", { role: "assistant", reasoning: "Read the request." }),
        chunk("gen-streamed", { content: "I write the file." }),
        chunk("gen-streamed", call({ name: "workspace_write", arguments: '{"path":' }, true)),
        chunk("gen-streamed", call({ arguments: ' "src/a.luau", ' })),
        chunk("gen-streamed", call({ arguments: '"content": "return 1"}' })),
        chunk("gen-streamed", {}, "tool_calls"),
        {
          ...(chunk("gen-streamed", {}) as Record<string, unknown>),
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 30,
            total_tokens: 42,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 5 },
            cost: 0.0042,
          },
        },
      ]);
    },
  });
  const result = await client.complete(writeRequest(), undefined, {
    beforeDispatch: async () => {},
    response: async (identity) => {
      identities.push(identity);
    },
  });
  assert.equal(wire?.stream, true);
  assert.deepEqual(wire?.stream_options, { include_usage: true });
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") return;
  assert.equal(result.message.content, "I write the file.");
  assert.deepEqual(result.message.toolCalls, [
    {
      id: "call-1",
      name: "workspace.write",
      arguments: { path: "src/a.luau", content: "return 1" },
    },
  ]);
  assert.equal(result.stopReason, "tool_calls");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 30,
    reasoningTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: null,
    costUsd: 0.0042,
  });
  assert.equal(result.responseFacts.responseId, "gen-streamed");
  assert.equal(result.responseFacts.resolvedModel, "fake/model");
  assert.equal(result.responseFacts.servingProvider, "Fake Provider");
  assert.equal(result.responseFacts.finishReason, "tool-calls");
  assert.equal(result.responseHash, contentHash(stableJson(result.message)));
  assert.equal(result.responseFacts.continuationHash, result.message.continuation?.hash);
  assert.equal(
    result.responseFactsHash,
    contentHash(stableJson({ facts: result.responseFacts, usage: result.usage })),
  );
  // The observer keeps the generation ID from the first event, before the stream ends.
  assert.deepEqual(identities, [
    {
      generationId: "gen-streamed",
      resolvedModel: "fake/model",
      servingProvider: "Fake Provider",
      servingServiceTier: null,
      costUsd: null,
    },
  ]);
});

test("a whitespace run of 4096 characters or fewer does not stop the stream", async () => {
  const run = (length: number) => Array(length / 512).fill(" \t\n".repeat(512).slice(0, 512));
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () =>
      sseResponse([
        ...run(4_096).map((content) => chunk("gen-boundary", { content })),
        chunk("gen-boundary", { content: "done" }),
        ...run(4_096).map((content) => chunk("gen-boundary", { content })),
        chunk("gen-boundary", {}, "stop"),
        {
          ...(chunk("gen-boundary", {}) as Record<string, unknown>),
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
        },
      ]),
  });
  const result = await client.complete(writeRequest());
  assert.equal(result.kind, "assistant");
  if (result.kind === "assistant") assert.equal(result.message.content.trim(), "done");
});

const usageEvent = (generationId: string) => ({
  ...(chunk(generationId, {}) as Record<string, unknown>),
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
});
const startCall = (index: number, id: string, text: string) =>
  chunk("gen-join", {
    tool_calls: [
      { index, id, type: "function", function: { name: "workspace_write", arguments: text } },
    ],
  });
const moreArguments = (index: number, text: string) =>
  chunk("gen-join", { tool_calls: [{ index, function: { arguments: text } }] });

test("a stream of 256 KB of tool arguments in deltas of 8 characters parses the long arguments only a few times", async () => {
  // The SDK adapter parses all of the arguments again after each delta until they parse. The
  // stream tap joins the deltas, so the cost stays linear. A count of the parses does not change
  // with the load of the machine. Without the join, this stream made 16,390 parses of 128 KB or
  // more, and it used approximately 10 s. With the join, it made 3, and it used 0.2 s to 0.4 s.
  const content = "a".repeat(262_144);
  const events = [
    startCall(0, "call-1", '{"path":"a.luau","content":"'),
    ...Array.from({ length: content.length / 8 }, () => moreArguments(0, "a".repeat(8))),
    moreArguments(0, '"}'),
    chunk("gen-join", {}, "tool_calls"),
    usageEvent("gen-join"),
  ];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => sseResponse(events),
  });
  const parse = JSON.parse;
  let longParses = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === "string" && text.length >= 131_072) longParses++;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  let result: Awaited<ReturnType<typeof client.complete>>;
  try {
    result = await client.complete(writeRequest());
  } finally {
    JSON.parse = parse;
  }
  assert.equal(result.kind, "assistant");
  if (result.kind === "assistant")
    assert.deepEqual(result.message.toolCalls, [
      { id: "call-1", name: "workspace.write", arguments: { path: "a.luau", content } },
    ]);
  assert.ok(longParses <= 8, `The transport parsed the long arguments ${longParses} times`);
});

test("joined argument deltas give the same tool calls as the deltas one by one", async () => {
  const end = [chunk("gen-join", {}, "tool_calls"), usageEvent("gen-join")];
  const cases: Array<[string, unknown[], unknown[]]> = [
    [
      "whitespace after the value",
      [
        startCall(0, "c1", '{"path":"a'),
        moreArguments(0, '.luau","content":"x"}'),
        moreArguments(0, "  \n"),
      ],
      [{ path: "a.luau", content: "x" }],
    ],
    [
      // The adapter keeps the first value that parses. Later text does not change the call.
      "text after the closing delta",
      [
        startCall(0, "c1", '{"path":"a'),
        moreArguments(0, '.luau","content":"x"}'),
        moreArguments(0, ' {"more":1}'),
      ],
      [{ path: "a.luau", content: "x" }],
    ],
    [
      // Arguments that never parse become an empty object in the adapter.
      "text after the value in the closing delta",
      [startCall(0, "c1", '{"path":"a'), moreArguments(0, '.luau","content":"x"} junk')],
      [{}],
    ],
    [
      "brackets inside a string",
      [startCall(0, "c1", '{"path":"a.luau","content":"}'), moreArguments(0, ' {\\"q\\": 1} ]"}')],
      [{ path: "a.luau", content: '} {"q": 1} ]' }],
    ],
    [
      "two calls",
      [
        startCall(0, "c1", '{"path":"a.luau",'),
        moreArguments(0, '"content":'),
        moreArguments(0, '"1"}'),
        startCall(1, "c2", '{"path":"b.luau",'),
        moreArguments(1, '"content":"2"}'),
      ],
      [
        { path: "a.luau", content: "1" },
        { path: "b.luau", content: "2" },
      ],
    ],
  ];
  for (const [name, events, expected] of cases) {
    const client = new OpenRouterModelClient({
      apiKey: "test-key",
      allowedModels: ["fake/model"],
      fetchImpl: async () => sseResponse([...events, ...end]),
    });
    const result = await client.complete(writeRequest());
    assert.equal(result.kind, "assistant", name);
    if (result.kind === "assistant")
      assert.deepEqual(
        result.message.toolCalls.map((call) => call.arguments),
        expected,
        name,
      );
  }
  // A text delta between two argument deltas keeps its place.
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () =>
      sseResponse([
        startCall(0, "c1", '{"path":"a.luau",'),
        chunk("gen-join", { content: "note" }),
        moreArguments(0, '"content":"z"}'),
        ...end,
      ]),
  });
  const result = await client.complete(writeRequest());
  assert.equal(result.kind, "assistant");
  if (result.kind === "assistant") {
    assert.equal(result.message.content, "note");
    assert.deepEqual(result.message.toolCalls[0]!.arguments, { path: "a.luau", content: "z" });
  }
});

test("a long whitespace run in tool arguments stops the stream and keeps the reported charge", async () => {
  const counter = { pulled: 0 };
  let streamSignal: AbortSignal | null | undefined;
  const lookups: string[] = [];
  const waits: number[] = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    pause: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImpl: async (url, init) => {
      if (String(url).startsWith("https://openrouter.ai/api/v1/generation")) {
        lookups.push(String(url));
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
        // The generation record appears some seconds after the stop.
        return lookups.length < 3
          ? new Response("{}", { status: 404 })
          : generationRecord("gen-runaway", 0.0123);
      }
      streamSignal = init?.signal;
      return endlessStream(
        init?.signal,
        [
          chunk("gen-runaway", {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "workspace_write", arguments: '{"path": "a.luau",' },
              },
            ],
          }),
        ],
        () =>
          chunk("gen-runaway", {
            tool_calls: [{ index: 0, function: { arguments: " ".repeat(512) } }],
          }),
        counter,
      );
    },
  });
  const result = await client.complete(writeRequest());
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(result.errorClass, "runaway_output");
  assert.equal(result.retryable, false);
  assert.equal(
    result.message,
    "The model output has a run of more than 4096 whitespace characters. Basalt stopped the stream. OpenRouter reported the charge of the stopped generation.",
  );
  assert.equal(result.usage.costUsd, 0.0123);
  assert.equal(result.responseFacts.responseId, "gen-runaway");
  assert.equal(result.responseFacts.servingProvider, "Fake Provider");
  assert.equal(streamSignal?.aborted, true, "The stop aborts the provider request");
  // A run of 4,097 characters needs 9 deltas of 512 characters.
  assert.ok(counter.pulled < 40, `The stream sent ${counter.pulled} events`);
  assert.deepEqual(
    lookups,
    Array(3).fill("https://openrouter.ai/api/v1/generation?id=gen-runaway"),
  );
  assert.deepEqual(waits, [3_000, 3_000, 3_000]);
});

test("a runaway stop without a reported charge keeps the generation ID and no cost", async () => {
  let lookups = 0;
  const waits: number[] = [];
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    pause: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImpl: async (url, init) => {
      if (String(url).startsWith("https://openrouter.ai/api/v1/generation")) {
        lookups++;
        return new Response("{}", { status: 404 });
      }
      return endlessStream(init?.signal, [], () =>
        chunk("gen-runaway-text", { content: `\n${" ".repeat(511)}` }),
      );
    },
  });
  const result = await client.complete(writeRequest());
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(result.errorClass, "runaway_output");
  assert.match(result.message, /the charge stays pending\.$/);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.responseFacts.responseId, "gen-runaway-text");
  assert.equal(lookups, 10);
  assert.equal(
    waits.reduce((sum, wait) => sum + wait, 0),
    30_000,
  );
});

test("Stop during a started stream stays a cancellation and keeps the generation ID", async () => {
  const controller = new AbortController();
  let lookups = 0;
  const client = new OpenRouterModelClient({
    apiKey: "test-key",
    allowedModels: ["fake/model"],
    pause: async () => {},
    fetchImpl: async (url, init) => {
      if (String(url).startsWith("https://openrouter.ai/api/v1/generation")) lookups++;
      return endlessStream(
        init?.signal,
        [chunk("gen-held", { content: `${" ".repeat(4_000)}x` })],
        null,
      );
    },
  });
  const result = await client.complete(writeRequest(), controller.signal, {
    beforeDispatch: async () => {},
    response: async () => {
      // The first event arrived. A person selects Stop.
      controller.abort();
    },
  });
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(result.errorClass, "cancelled");
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.responseFacts.responseId, "gen-held");
  assert.equal(lookups, 0, "A cancellation does no billing read");
});

async function completeErrorResponse(status: number, body: unknown, retryAfter?: string) {
  let calls = 0;
  const client = new OpenRouterModelClient({
    apiKey: "private-test-api-key",
    allowedModels: ["fake/model"],
    fetchImpl: async () => {
      calls++;
      const headers = {
        authorization: "Bearer private-header-secret",
        ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
      };
      // OpenRouter sends an error inside a started stream as an event of that stream.
      if (status === 200) return sseResponse([body], { headers });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    },
  });
  const result = await client.complete({
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
  assert.equal(calls, 1, "A retry hint cannot dispatch another request");
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") assert.fail("Expected a normalized provider error");
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.responseFacts.responseId, null);
  assert.equal(result.responseFacts.retryCount, 0);
  assert.ok(result.message.length <= 500);
  assert.doesNotMatch(JSON.stringify(result), /private[-_]/u);
  return result;
}
