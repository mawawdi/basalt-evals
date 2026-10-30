import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import {
  modelRoute,
  modelTreatmentIdentity,
  selectModelSnapshot,
  type ModelSnapshot,
} from "../packages/model-client/src/catalog.js";
import {
  OpenRouterModelClient,
  openRouterModelClientDescriptor,
} from "../packages/model-client/src/openrouter-ai-sdk.js";
import {
  modelTurnRequestHash,
  type ModelTurnRequest,
} from "../packages/model-client/src/contracts.js";
import {
  modelPreparationRoles,
  type PreparationDispatcher,
} from "../packages/agent-runtime/src/preparation-models.js";
import {
  gradingConfiguration,
  assertGradingQuote,
} from "../packages/eval-authoring/src/scoring.js";
import {
  observationRequest,
  batchJudgmentRequest,
} from "../packages/eval-authoring/src/batch-judgment.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import { quoteRequest } from "../packages/model-client/src/quoted-request.js";
import {
  createRunQuote,
  JUDGMENT_RETRIES,
  workloadCeiling,
} from "../packages/model-client/src/quote.js";
import { requestUsage } from "../packages/model-client/src/request-workload.js";
import {
  catalogRecommendedSampling,
  recommendedRequestSampling,
} from "../packages/model-client/src/sampling.js";
import { maximumRequestCost } from "../packages/model-client/src/bounded-client.js";
import { combineNativeWork } from "../packages/studio-runner/src/workload.js";
import { streamedCompletion } from "./openrouter-stream.js";

const modelId = "deepseek/deepseek-v4.1-flash";
function snapshot(
  reasoning: unknown,
  id: ModelSnapshot["id"] = modelId,
  sampling: { defaults?: unknown; parameters?: string[] } = {},
) {
  return selectModelSnapshot(
    {
      id,
      canonical_slug: id + "-synthetic",
      reasoning,
      architecture: { input_modalities: ["text"] },
      ...(sampling.defaults === undefined ? {} : { default_parameters: sampling.defaults }),
    },
    {
      data: {
        endpoints: [
          {
            model_id: id,
            tag: "synthetic",
            provider_name: "Synthetic",
            quantization: "fp4",
            status: 0,
            context_length: 100000,
            max_completion_tokens: 32768,
            supported_parameters: [
              "tools",
              "reasoning",
              "tool_choice",
              ...(sampling.parameters ?? []),
            ],
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      },
    },
    { tools: true },
    "2026-09-25T00:00:00.000Z",
  );
}

test("reasoning pins use advertised efforts and distinguish unrestricted from unavailable metadata", () => {
  const restricted = snapshot({
    supported_efforts: ["max", "high", "low"],
    default_effort: "high",
    mandatory: false,
  });
  assert.equal(modelRoute(restricted).reasoningEffort, "low");
  assert.equal(
    modelRoute(snapshot({ supported_efforts: ["medium", "low"] })).reasoningEffort,
    "medium",
  );
  assert.equal(modelRoute(snapshot({ supported_efforts: null })).reasoningEffort, "medium");
  assert.equal(modelRoute(snapshot({ default_effort: "high" })).reasoningEffort, null);
  assert.equal(modelRoute(snapshot(undefined)).reasoningEffort, null);
  assert.notEqual(
    modelTreatmentIdentity(restricted),
    modelTreatmentIdentity(snapshot({ supported_efforts: ["medium", "low"] })),
  );
  assert.throws(
    () => snapshot({ supported_efforts: ["low"], default_effort: "medium" }),
    /not supported/,
  );
  assert.throws(
    () => snapshot({ supported_efforts: ["none"], default_effort: "none", mandatory: true }),
    /mandatory/,
  );
  assert.throws(() => snapshot({ supported_efforts: ["none"], mandatory: true }), /mandatory/);
});

const request: ModelTurnRequest = {
  model: modelId,
  seed: 1,
  system: "Submit the audit using its submission tool.",
  messages: [{ role: "user", content: "Inspect the public contract." }],
  tools: [
    {
      name: "submit.audit",
      description: "Submit issues.",
      parameters: {
        type: "object",
        properties: { issues: { type: "array", items: { type: "string" } } },
        required: ["issues"],
        additionalProperties: false,
      },
    },
  ],
  maxOutputTokens: 8192,
};

test("grading uses the endpoint's own output limit and only advertised reasoning controls", () => {
  const medium = snapshot({ supported_efforts: ["medium"], supports_max_tokens: true });
  assert.deepEqual(gradingConfiguration(medium, 5), {
    modelId,
    seed: 5,
    maxOutputTokens: 32768,
    reasoning: { kind: "effort", effort: "medium" },
    sampling: catalogRecommendedSampling(null),
  });
  assert.deepEqual(
    gradingConfiguration(snapshot({ supported_efforts: ["low"], supports_max_tokens: false }), 5)
      .reasoning,
    { kind: "effort", effort: "low" },
  );
  const mimo = snapshot({ mandatory: false }, "xiaomi/mimo-v2.6-flash");
  assert.equal(modelRoute(mimo).reasoningEffort, null);
  assert.deepEqual(gradingConfiguration(mimo, 5), {
    modelId: mimo.id,
    seed: 5,
    maxOutputTokens: 32768,
    reasoning: { kind: "provider_default" },
    sampling: catalogRecommendedSampling(null),
  });
  // Basalt adds no cap of its own: the provider's limit is the allowance, large or small.
  const provider = structuredClone(medium);
  for (const limit of [131072, 16384, 4096]) {
    provider.endpoints[0]!.maxOutputTokens = limit;
    assert.equal(gradingConfiguration(provider, 5).maxOutputTokens, limit);
  }
  provider.endpoints[0]!.supportedParameters = ["tools"];
  assert.deepEqual(gradingConfiguration(provider, 5).reasoning, { kind: "provider_default" });
});

test("grading freezes and sends only the catalog sampling recommendation that the endpoint accepts", () => {
  const defaults = { temperature: 1, top_p: 0.95, top_k: 20, frequency_penalty: null };
  const recommended = snapshot({ mandatory: false }, modelId, {
    defaults,
    parameters: ["temperature", "top_p"],
  });
  assert.deepEqual(recommended.recommendedSampling, {
    ...catalogRecommendedSampling(null),
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
  });
  // top_k has a recommendation, but the frozen endpoint does not accept it: it is not sent.
  assert.deepEqual(gradingConfiguration(recommended, 5).sampling, {
    ...catalogRecommendedSampling(null),
    temperature: 1,
    top_p: 0.95,
  });
  const silent = snapshot({ mandatory: false }, modelId, {
    defaults: {},
    parameters: ["temperature", "top_p"],
  });
  assert.deepEqual(recommendedRequestSampling(silent), catalogRecommendedSampling(null));
  assert.notEqual(
    modelTreatmentIdentity(recommended),
    modelTreatmentIdentity(silent),
    "The catalog recommendation is part of the frozen judge identity",
  );
  assert.throws(
    () => snapshot({ mandatory: false }, modelId, { defaults: { temperature: "hot" } }),
    /sampling value/,
  );
  assert.throws(
    () => snapshot({ mandatory: false }, modelId, { defaults: { min_tokens: 1 } }),
    /unknown parameter/,
  );
  const judgment = batchJudgmentRequest({
    configuration: gradingConfiguration(recommended, 5),
    criteria: [
      {
        id: "audit",
        statement: "A beacon exists.",
        authoredPassages: ["A beacon exists."],
        required: true,
        evidenceClass: null,
        polarity: "presence" as const,
        comparisons: [],
        anchors: null,
        scoreRange: null,
        minimumPassingScore: null,
      },
    ],
    publicTask: "Build a beacon.",
    context: { actors: [], intervals: [] },
    images: [],
    observation: null,
    criterionEvidence: [pendingCriterionMaterial("audit")],
  });
  assert.doesNotThrow(() => requestUsage(recommended, judgment));
  assert.throws(
    () => requestUsage(silent, { ...judgment, sampling: { ...judgment.sampling!, top_k: 20 } }),
    /does not accept the sampling parameter top_k/,
  );
  const descriptor = openRouterModelClientDescriptor([modelId]);
  assert.notEqual(
    modelTurnRequestHash(judgment, descriptor),
    modelTurnRequestHash({ ...judgment, sampling: catalogRecommendedSampling(null) }, descriptor),
  );
});

test("request reasoning is frozen in quote and admission with the same total liability", () => {
  const model = snapshot({ supported_efforts: ["medium"], supports_max_tokens: true });
  const configuration = gradingConfiguration(model, 1);
  const criterion = {
    id: "audit",
    statement: "A beacon exists.",
    authoredPassages: ["A beacon exists."],
    required: true,
    evidenceClass: null,
    polarity: "presence" as const,
    comparisons: [],
    anchors: null,
    scoreRange: null,
    minimumPassingScore: null,
  };
  const judgment = batchJudgmentRequest({
    configuration,
    criteria: [criterion],
    publicTask: "Build a beacon.",
    context: { actors: [], intervals: [] },
    images: [],
    observation: null,
    criterionEvidence: [pendingCriterionMaterial(criterion.id)],
  });
  const observation = observationRequest(configuration, { actors: [], intervals: [] }, []);
  // The observation tool admits 25,173 answer characters before any frame ID.
  assert.throws(
    () =>
      observationRequest(
        { ...configuration, maxOutputTokens: 16384 },
        { actors: [], intervals: [] },
        [],
      ),
    /submit_observations accepts an answer of up to \d+ characters/,
  );
  for (const executable of [judgment, observation]) {
    const work = quoteRequest({
      stage: "grading",
      snapshot: model,
      request: executable,
      calls: 1,
      futureTextBytes: 0,
      expectedFutureTextBytes: 0,
      imageDimensions: [],
    });
    assert.deepEqual(work.reasoning, configuration.reasoning);
    assert.deepEqual(work.upper, requestUsage(model, executable).upper);
    assert.equal(
      work.upper.outputTokens,
      model.endpoints[0]!.maxOutputTokens,
      "The provider's output limit, reasoning included, is the total output liability",
    );
    assertGradingQuote(configuration, [work]);
    const workload = {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 0,
      ...combineNativeWork(),
      criterionOutcomes: 1,
      judgmentBatches: 1,
      modelWork: [work],
    };
    const quote = createRunQuote(workload, [model]);
    assert.equal(
      workloadCeiling(quote),
      (1 + JUDGMENT_RETRIES) * maximumRequestCost(model, executable),
      "Each quoted checking call carries the liability of its bounded rate-limit retries",
    );
    const changed = { ...work, reasoning: { kind: "provider_default" as const } };
    assert.notEqual(createRunQuote({ ...workload, modelWork: [changed] }, [model]).id, quote.id);
    assert.throws(() => assertGradingQuote(configuration, [changed]), /Make a new preview/);
    assert.throws(
      () =>
        assertGradingQuote(configuration, [
          { ...work, upper: { ...work.upper, outputTokens: 8192 } },
        ]),
      /Make a new preview/,
    );
  }
  const unknown = snapshot({ mandatory: false });
  assert.throws(() => requestUsage(unknown, judgment), /does not advertise/);
  assert.throws(
    () =>
      quoteRequest({
        stage: "grading",
        snapshot: unknown,
        request: judgment,
        calls: 1,
        futureTextBytes: 0,
        expectedFutureTextBytes: 0,
        imageDimensions: [],
      }),
    /does not advertise/,
  );
  assert.throws(
    () => requestUsage(model, { ...judgment, reasoning: { kind: "effort", effort: "high" } }),
    /does not advertise/,
  );
  const descriptor = openRouterModelClientDescriptor([modelId]);
  assert.equal(
    modelTurnRequestHash(request, descriptor),
    "47a0331b1a4d676b8cebf3ff0c4fff222e4c5711385a68358afd6db847d41d94",
    "Omitted per-request controls retain the original transport-default request identity",
  );
  assert.notEqual(
    modelTurnRequestHash(judgment, descriptor),
    modelTurnRequestHash({ ...judgment, reasoning: { kind: "provider_default" } }, descriptor),
  );
});

for (const metadata of [
  { supported_efforts: ["medium"], supports_max_tokens: true },
  { supported_efforts: ["low"], supports_max_tokens: false },
  { mandatory: false },
]) {
  test(`explicit grading ${JSON.stringify(metadata)} reaches the supported wire fields`, async () => {
    const model = snapshot(metadata);
    const configuration = gradingConfiguration(model, 1);
    let wire: Record<string, unknown> | undefined;
    const client = new OpenRouterModelClient({
      apiKey: "synthetic",
      allowedModels: [modelId],
      routes: { [modelId]: modelRoute(model) },
      fetchImpl: async (_url, options) => {
        wire = JSON.parse(String(options?.body));
        return streamedCompletion({
          id: "gen-synthetic-graded",
          model: modelId,
          provider: "Synthetic",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.001 },
        });
      },
    });
    const executable = {
      ...request,
      maxOutputTokens: configuration.maxOutputTokens,
      reasoning: configuration.reasoning!,
    };
    const result = await client.complete(executable);
    assert.equal(result.kind, "assistant");
    assert.equal(wire?.max_tokens, model.endpoints[0]!.maxOutputTokens);
    assert.equal(wire?.tool_choice, "auto");
    assert.deepEqual(
      wire?.reasoning,
      metadata.supported_efforts
        ? { effort: metadata.supported_efforts[0], exclude: false }
        : undefined,
    );
    assert.equal(wire?.reasoning_effort, undefined, "Do not send a second reasoning control");
    assert.equal(result.requestHash, modelTurnRequestHash(executable, client.descriptor));
  });
}

for (const effort of ["low", "max"] as const) {
  test(`advertised ${effort} reasoning reaches the wire without forcing a tool during thinking`, async () => {
    const model = snapshot({ supported_efforts: [effort], default_effort: effort });
    let wire: Record<string, unknown> | undefined;
    const client = new OpenRouterModelClient({
      apiKey: "synthetic",
      allowedModels: [modelId],
      routes: { [modelId]: modelRoute(model) },
      fetchImpl: async (_url, options) => {
        wire = JSON.parse(String(options?.body));
        assert.equal(
          wire?.tool_choice,
          "auto",
          "Individual capability flags cannot authorize forced tool choice during thinking",
        );
        return streamedCompletion({
          id: "gen-synthetic-submission",
          model: modelId,
          provider: "Synthetic",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-audit",
                    type: "function",
                    function: { name: "submit_audit", arguments: JSON.stringify({ issues: [] }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.001 },
        });
      },
    });
    const result = await client.complete(request);
    assert.equal(result.kind, "assistant");
    if (result.kind === "assistant")
      assert.equal(result.message.toolCalls[0]!.name, "submit.audit");
    assert.deepEqual(wire?.reasoning, { effort, exclude: false });
    assert.equal(wire?.max_tokens, 8192);
    const changedPin = { ...modelRoute(model), reasoningEffort: null };
    const changedClient = new OpenRouterModelClient({
      apiKey: "synthetic",
      allowedModels: [modelId],
      routes: { [modelId]: changedPin },
    });
    assert.notEqual(
      modelTurnRequestHash(request, client.descriptor),
      modelTurnRequestHash(request, changedClient.descriptor),
    );
  });
}

test("an exhausted thinking reply retains its known charge and cannot masquerade as a submitted proposal", async () => {
  let calls = 0;
  const model = snapshot({ supported_efforts: ["low", "high", "max"] });
  const client = new OpenRouterModelClient({
    apiKey: "synthetic",
    allowedModels: [modelId],
    routes: { [modelId]: modelRoute(model) },
    fetchImpl: async () => {
      calls++;
      return streamedCompletion({
        id: "gen-synthetic-exhausted",
        model: modelId,
        provider: "Synthetic",
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "Synthetic unfinished analysis.",
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8192,
          total_tokens: 8212,
          completion_tokens_details: { reasoning_tokens: 8192 },
          cost: 0.003,
        },
      });
    },
  });
  const result = await client.complete(request);
  assert.equal(calls, 1);
  assert.equal(result.kind, "assistant");
  assert.equal(result.usage.costUsd, 0.003);
  if (result.kind === "assistant") {
    assert.equal(result.stopReason, "max_tokens");
    assert.deepEqual(result.message.toolCalls, []);
    assert.equal(result.usage.reasoningTokens, 8192);
  }
  const roles = modelPreparationRoles({
    dispatcher: { complete: async () => result } as unknown as PreparationDispatcher,
    publicModel: { id: modelId, maxOutputTokens: 16_384 },
    privateModel: { id: modelId, maxOutputTokens: 16_384 },
    seed: 1,
  });
  await assert.rejects(
    roles.preparePublic({
      stagePrompts: ["Inspect the public contract."],
      title: "Inspect",
      slug: "inspect",
      previousProposal: null,
      diagnostics: [],
      attempt: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutionFault);
      assert.equal(error.failure.causeCode, "preparation_output_limit");
      assert.equal(error.failure.evidenceRefs[0], result.requestHash);
      assert.match(
        error.message,
        /reached its output limit before it completed a preparation response/,
      );
      return true;
    },
  );
  assert.equal(calls, 1, "a truncated preparation cannot dispatch a paid retry");
  assert.equal(result.usage.costUsd, 0.003);
});

test("an answer from another served service tier stays valid and records both tiers", async () => {
  const model = snapshot({ supported_efforts: ["medium"], supports_max_tokens: true });
  const route = modelRoute(model);
  const client = new OpenRouterModelClient({
    apiKey: "synthetic",
    allowedModels: [modelId],
    routes: { [modelId]: route },
    fetchImpl: async () =>
      streamedCompletion({
        id: "gen-provisioned",
        model: modelId,
        provider: "Google",
        service_tier: "provisioned",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.002 },
      }),
  });
  const result = await client.complete({ ...request, maxOutputTokens: 100 });
  assert.equal(result.kind, "assistant", "OpenRouter routing picked the tier");
  assert.equal(result.responseFacts.requestedServiceTier, route.serviceTier);
  assert.equal(result.responseFacts.servingServiceTier, "provisioned");
  assert.equal(result.usage.costUsd, 0.002);
});
