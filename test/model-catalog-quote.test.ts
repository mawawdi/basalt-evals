import assert from "node:assert/strict";
import test from "node:test";
import {
  routePriceLimit,
  priceForUsage,
  maximumUsageCost,
  parsePriceTiers,
  selectModelSnapshot,
  modelRoute,
  modelTreatmentIdentity,
  modelIdentityWithoutPrices,
  fetchModelSnapshots,
} from "../packages/model-client/src/catalog.js";
import { modelLimits } from "../packages/model-client/src/model-limits.js";
import { createRunQuote, includePriorCommittedSpend } from "../packages/model-client/src/quote.js";
import { quoteRequest } from "../packages/model-client/src/quoted-request.js";
import type { ModelTurnRequest } from "../packages/model-client/src/contracts.js";
import { builderRequest, MAX_TOOL_RESULT_BYTES } from "../packages/agent-runtime/src/index.js";
import { quoteBuilderTurns } from "../packages/agent-runtime/src/workload.js";
import {
  requestOutputTokens,
  requestTextBound,
  requestUsage,
} from "../packages/model-client/src/request-workload.js";
import {
  contentHash,
  MAXIMUM_PRESENTED_FRAMES,
  stableJson,
  type PublicTask,
} from "../packages/contracts/src/index.js";
import { previewEvaluationLaunch } from "../packages/operator/src/workflow.js";
import { fixtureLaunchDefaults, seedModelRegistry } from "./shared-api-fixture.js";
import { testHarness, writeRunConfiguration } from "./builder-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionAdapters } from "../packages/operator/src/adapters.js";
import type { ModelRequirement } from "../packages/model-client/src/catalog.js";

const id = "openai/gpt-6-luna";
const catalogEntry = {
  id,
  canonical_slug: "openai/gpt-6-luna-20260922",
  architecture: { input_modalities: ["text", "image"] },
};
const endpointResponse = {
  data: {
    endpoints: [
      {
        model_id: id,
        tag: "openai",
        provider_name: "OpenAI",
        quantization: "unknown",
        context_length: 1_000_000,
        max_completion_tokens: 128_000,
        supported_parameters: ["tools", "response_format", "seed"],
        status: 0,
        pricing: {
          prompt: "0.0000001",
          completion: "0.0000005",
          image: "0.0002",
          overrides: [
            { min_prompt_tokens: 272_000, prompt: "0.0000002", completion: "0.00000075" },
          ],
        },
      },
    ],
  },
};

test("builder quotes include scene discovery instructions and bound retained public scene tool results", () => {
  const snapshot = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true },
    "2026-09-30T00:00:00Z",
  );
  const task: PublicTask = {
    schema: "basalt-evals/task",
    slug: "public-scene",
    title: "Public scene",
    prompt: "Complete the seed.",
    seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
    roles: [],
    acceptance: ["The mechanic works."],
    evidenceInstructions: [],
  };
  const harness = testHarness({ id: "thin", maxTurns: 2 });
  const quoted = quoteBuilderTurns({ task, harness, snapshot, trials: 1, development: null });
  const request = builderRequest({
    task,
    harness,
    model: snapshot.id,
    seed: 0,
  });
  assert.equal(quoted.length, 2);
  assert.equal(quoted[0]!.calls, 1);
  assert.equal(quoted[0]!.upper.inputTokens, requestTextBound(request));
  assert.match(request.messages[0]!.content, /workspace\.list.*immutable public seed scene/);
  assert.match(
    request.tools.find((tool) => tool.name === "workspace.list")!.description,
    /project SHA-256/,
  );
  const scene = {
    projectFile: task.seed.projectFile,
    projectHash: contentHash("exact public project bytes"),
    tree: { Workspace: { EvalEndpointA: { $className: "Part", $properties: { Name: "" } } } },
  };
  const result = { ok: true, files: [], scene };
  scene.tree.Workspace.EvalEndpointA.$properties.Name = "x".repeat(
    MAX_TOOL_RESULT_BYTES - Buffer.byteLength(stableJson(result), "utf8"),
  );
  const content = stableJson(result);
  assert.equal(Buffer.byteLength(content, "utf8"), MAX_TOOL_RESULT_BYTES);
  request.messages.push(
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "scene", name: "workspace.list", arguments: {} }],
    },
    { role: "tool", toolCallId: "scene", name: "workspace.list", content },
  );
  assert.ok(
    requestTextBound(request) <= quoted[1]!.upper.inputTokens,
    "The unchanged tool result bound must cover the retained scene on the next request",
  );
  // Output costs more than input here, so the full output limit stays the costliest split.
  assert.deepEqual(
    [quoted[1]!.upper.inputTokens, quoted[1]!.upper.outputTokens],
    [872_000, 128_000],
  );
  // A request fits its output allowance to the context that remains. If a price tier starts
  // above the room that the full output limit leaves, the quote uses the start of that tier.
  const tiered = structuredClone(endpointResponse);
  tiered.data.endpoints[0]!.max_completion_tokens = 900_000;
  tiered.data.endpoints[0]!.pricing.overrides = [
    { min_prompt_tokens: 500_000, prompt: "0.000001", completion: "0.000005" },
  ];
  const wide = selectModelSnapshot(catalogEntry, tiered, { tools: true }, "2026-10-03");
  const split = quoteBuilderTurns({ task, harness, snapshot: wide, trials: 1, development: null });
  assert.deepEqual([split[1]!.upper.inputTokens, split[1]!.upper.outputTokens], [500_000, 500_000]);
  assert.ok(
    priceForUsage(wide, split[1]!.upper) >
      priceForUsage(wide, { ...split[1]!.upper, inputTokens: 100_000, outputTokens: 900_000 }),
  );
});

test("a request uses the output limit, or the context that remains after its input bound", () => {
  const response = structuredClone(endpointResponse);
  response.data.endpoints[0]!.max_completion_tokens = 943_718;
  response.data.endpoints[0]!.context_length = 1_048_576;
  const snapshot = selectModelSnapshot(catalogEntry, response, { tools: true }, "2026-10-03");
  const request = (bytes: number) => ({
    model: snapshot.id,
    seed: 0,
    system: "Build the task.",
    messages: [{ role: "user" as const, content: "x".repeat(bytes) }],
    tools: [],
  });
  assert.equal(requestOutputTokens(snapshot, request(1_000)), 943_718);
  const large = request(500_000);
  const fitted = requestOutputTokens(snapshot, large);
  assert.equal(fitted, 1_048_576 - requestTextBound(large));
  // The fitted request passes admission, and its reservation uses the fitted allowance.
  assert.equal(
    requestUsage(snapshot, { ...large, maxOutputTokens: fitted }).upper.outputTokens,
    fitted,
  );
  assert.throws(
    () => requestUsage(snapshot, { ...large, maxOutputTokens: 943_718 }),
    /exceeds its frozen endpoint context limit/,
  );
  // If no room remains, the admission check refuses the request.
  const full = request(1_048_576);
  assert.equal(requestOutputTokens(snapshot, full), 1);
  assert.throws(
    () => requestUsage(snapshot, { ...full, maxOutputTokens: 1 }),
    /exceeds its frozen endpoint context limit/,
  );
});

test("native-only workloads perform no provider lookup", async () => {
  let calls = 0;
  assert.deepEqual(
    await fetchModelSnapshots([], async () => {
      calls++;
      throw new Error("No network permitted");
    }),
    [],
  );
  assert.equal(calls, 0);
});

test("public catalog transport failures explain the undispatched stage without leaking cause data", async () => {
  const selections = [{ id, requirement: { tools: true } }] as const;
  const secret = "Bearer fake-secret private prompt /Users/private-secret";
  await assert.rejects(
    fetchModelSnapshots(selections, async () => {
      throw new TypeError("fetch failed " + secret, {
        cause: { code: "ECONNRESET", message: secret },
      });
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /catalog|endpoint/i);
      assert.match(error.message, /Basalt sent no model request/);
      assert.match(error.message, /Resume/);
      assert.doesNotMatch(error.message, /fake-secret|private prompt|Users/);
      return true;
    },
  );
});

test("catalog and endpoint reads start together, retain selection order and refresh prices", async () => {
  const otherId = "openai/gpt-5.6-luna";
  const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    assert.equal(options?.cache, "no-store");
    return new Promise<Response>((resolve) => pending.push({ url: String(url), resolve }));
  };
  const selections = [
    { id: otherId, requirement: { tools: true } },
    { id, requirement: { tools: true } },
  ] as const;
  for (const price of ["0.0000001", "0.0000003"]) {
    const result = fetchModelSnapshots(selections, fetchImpl, "2026-09-29T00:00:00Z");
    assert.equal(pending.length, 3, "endpoint reads must not wait for the catalog response");
    const responses = pending.splice(0);
    for (const request of responses.reverse()) {
      if (request.url.endsWith("/models")) {
        request.resolve(
          Response.json({
            data: [
              catalogEntry,
              { ...catalogEntry, id: otherId, canonical_slug: `${otherId}-20260922` },
            ],
          }),
        );
      } else {
        const data = structuredClone(endpointResponse);
        data.data.endpoints[0]!.model_id = request.url.includes(otherId) ? otherId : id;
        data.data.endpoints[0]!.pricing.prompt = price;
        request.resolve(Response.json(data));
      }
    }
    const snapshots = await result;
    assert.deepEqual(
      snapshots.map((model) => model.id),
      [otherId, id],
    );
    assert.equal(snapshots[1]!.endpoints[0]!.tiers[0]!.inputPerTokenUsd, Number(price));
  }
  await assert.rejects(
    fetchModelSnapshots(selections, async (url) =>
      String(url).includes(otherId)
        ? new Response(null, { status: 503 })
        : Response.json(
            String(url).endsWith("/models") ? { data: [catalogEntry] } : endpointResponse,
          ),
    ),
    /the endpoint list of the provider for openai\/gpt-5\.6-luna \(HTTP 503\).*Basalt sent no model request.*Resume/,
  );
});

test("a snapshot holds every capable endpoint and reads no data retention list", async () => {
  const response = structuredClone(endpointResponse);
  response.data.endpoints.push({ ...response.data.endpoints[0]!, tag: "azure" });
  const urls: string[] = [];
  const [snapshot] = await fetchModelSnapshots(
    [{ id, requirement: { tools: true } }],
    async (url) => {
      urls.push(String(url));
      return Response.json(String(url).endsWith("/models") ? { data: [catalogEntry] } : response);
    },
  );
  // OpenRouter picks the endpoint of each request. Basalt does not filter the endpoints itself.
  assert.deepEqual(
    snapshot!.endpoints.map((endpoint) => endpoint.tag),
    ["azure", "openai"],
  );
  assert.deepEqual(urls.sort(), [
    "https://openrouter.ai/api/v1/models",
    `https://openrouter.ai/api/v1/models/${id}/endpoints`,
  ]);
});

test("an endpoint with a negative status stays in the set, because its status changes within seconds", () => {
  // OpenRouter reported a status of -2 or 0 every few seconds for an endpoint that served requests.
  const response = structuredClone(endpointResponse);
  response.data.endpoints.push({ ...response.data.endpoints[0]!, tag: "azure", status: -2 });
  assert.deepEqual(
    selectModelSnapshot(catalogEntry, response, { tools: true }, "2026-10-03").endpoints.map(
      (endpoint) => endpoint.tag,
    ),
    ["azure", "openai"],
  );
});

test("endpoint selection uses the executable request factory, including serialized source and output capacity", () => {
  const response = structuredClone(endpointResponse);
  response.data.endpoints.unshift({
    ...response.data.endpoints[0]!,
    tag: "small-cheap",
    context_length: 12000,
    pricing: { ...response.data.endpoints[0]!.pricing, prompt: "0", completion: "0" },
  });
  const request: ModelTurnRequest = {
    model: id,
    system: "Inspect this retained source",
    messages: [{ role: "user", content: "x".repeat(14000) }],
    tools: [],
    seed: 0,
    maxOutputTokens: 8192,
  };
  const factory = (snapshot: Parameters<typeof quoteRequest>[0]["snapshot"]) => {
    const work = quoteRequest({
      stage: "builder",
      snapshot,
      request,
      calls: 3,
      futureTextBytes: 0,
      expectedFutureTextBytes: 0,
      imageDimensions: [],
    });
    return [{ calls: work.calls, usage: work.upper }];
  };
  const selected = selectModelSnapshot(
    catalogEntry,
    response,
    { tools: true, quoteWorkload: factory },
    "2026-09-25T00:00:00Z",
  );
  assert.deepEqual(
    selected.endpoints.map((endpoint) => endpoint.tag),
    ["openai"],
    "The endpoint with a small context does not join the set",
  );
  assert.equal(factory(selected)[0]!.usage.outputTokens, 8192);
});

test("treatment drift ignores display and retrieval metadata but retains capability, price and endpoint identity", () => {
  const model = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true },
    "2026-09-23T00:00:00.000Z",
  );
  const cosmetic = structuredClone(model);
  cosmetic.name = "Updated display name";
  cosmetic.capturedAt = "2026-09-25T00:00:00.000Z";
  cosmetic.hash = "f".repeat(64);
  cosmetic.endpoints[0]!.rawPricing = {
    ...cosmetic.endpoints[0]!.rawPricing,
    retrieved_at: cosmetic.capturedAt,
  };
  cosmetic.endpoints[0]!.supportedParameters.reverse();
  cosmetic.inputModalities.reverse();
  assert.equal(modelTreatmentIdentity(model), modelTreatmentIdentity(cosmetic));
  for (const change of [
    (copy: typeof model) => {
      copy.endpoints[0]!.tiers[0]!.inputPerTokenUsd *= 2;
    },
    (copy: typeof model) => {
      copy.endpoints[0]!.tag += "/flex";
    },
    (copy: typeof model) => {
      copy.endpoints[0]!.supportedParameters = [];
    },
    (copy: typeof model) => {
      copy.endpoints[0]!.quantization = "int8";
    },
    (copy: typeof model) => {
      copy.endpoints.push({ ...copy.endpoints[0]!, tag: "azure" });
    },
    (copy: typeof model) => {
      copy.revision += "-changed";
    },
  ]) {
    const altered = structuredClone(model);
    change(altered);
    assert.notEqual(modelTreatmentIdentity(model), modelTreatmentIdentity(altered));
  }
});

test("a changed evaluation keeps the approved models when only their prices moved", () => {
  const model = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true },
    "2026-09-23T00:00:00.000Z",
  );
  // OpenRouter changed a price after the approval: the run keeps its models, and its limit holds.
  const repriced = structuredClone(model);
  repriced.endpoints[0]!.tiers[0]!.inputPerTokenUsd *= 0.8;
  repriced.capturedAt = "2026-09-23T00:20:00.000Z";
  assert.notEqual(modelTreatmentIdentity(model), modelTreatmentIdentity(repriced));
  assert.equal(modelIdentityWithoutPrices(model), modelIdentityWithoutPrices(repriced));
  // Any other change is still a change of the models.
  const narrowed = structuredClone(model);
  narrowed.endpoints[0]!.supportedParameters = [];
  assert.notEqual(modelIdentityWithoutPrices(model), modelIdentityWithoutPrices(narrowed));
  const moved = structuredClone(model);
  moved.endpoints[0]!.tag += "/flex";
  assert.notEqual(modelIdentityWithoutPrices(model), modelIdentityWithoutPrices(moved));
});

test("catalog selection freezes the endpoint set and applies context price tiers", () => {
  const snapshot = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true, images: true },
    "2026-09-23T00:00:00.000Z",
  );
  assert.deepEqual(
    snapshot.endpoints.map((endpoint) => endpoint.tag),
    ["openai"],
  );
  assert.deepEqual(routePriceLimit(snapshot), {
    prompt: 0.2,
    completion: 0.75,
    request: 0,
    image: 0.0002,
  });
  assert.equal(
    priceForUsage(snapshot, { inputTokens: 1_000, outputTokens: 100, images: 1 }),
    0.00035,
  );
  assert.ok(
    Math.abs(
      priceForUsage(snapshot, { inputTokens: 272_000, outputTokens: 100, images: 0 }) - 0.054475,
    ) < 1e-12,
  );
});

test("the set holds every capable endpoint and reserves the highest price of the set", () => {
  const response = structuredClone(endpointResponse);
  const base = response.data.endpoints[0]!;
  const priced = (tag: string, prompt: string, completion: string) => ({
    ...base,
    tag,
    pricing: { prompt, completion, image: "0.0002", overrides: [] },
  });
  response.data.endpoints.push(
    priced("reseller", "0.00000012", "0.0000006"),
    priced("z-expensive", "0.0000004", "0.000002"),
  );
  const snapshot = selectModelSnapshot(
    catalogEntry,
    response,
    { tools: true },
    "2026-09-23T00:00:00.000Z",
  );
  assert.deepEqual(
    snapshot.endpoints.map((endpoint) => endpoint.tag),
    ["openai", "reseller", "z-expensive"],
  );
  // OpenRouter can serve a request with any endpoint, so the reservation uses the highest price.
  assert.ok(
    Math.abs(
      priceForUsage(snapshot, { inputTokens: 1_000, outputTokens: 100, images: 0 }) - 0.0006,
    ) < 1e-15,
  );
  assert.deepEqual(modelRoute(snapshot), {
    seedSupported: true,
    reasoningEffort: null,
    serviceTier: "default",
    maxPrice: { prompt: 0.4, completion: 2, request: 0, image: 0.0002 },
  });
});

test("the set uses the default tier, Flex needs a person to select it, and priority is the last tier", () => {
  const endpoint = endpointResponse.data.endpoints[0]!;
  const half = { ...endpoint.pricing, prompt: "0.00000005", completion: "0.00000025" };
  const response = {
    data: {
      endpoints: [
        { ...endpoint, tag: "azure" },
        { ...endpoint, tag: "openai" },
        { ...endpoint, tag: "openai/flex", pricing: half },
        { ...endpoint, tag: "openai/fast", pricing: half },
      ],
    },
  };
  const tags = (requirement: ModelRequirement, endpoints = response) =>
    selectModelSnapshot(catalogEntry, endpoints, requirement, "2026-09-28").endpoints.map(
      (item) => item.tag,
    );
  // OpenRouter uses Flex and priority endpoints only when a request asks for them.
  assert.deepEqual(tags({ tools: true }), ["azure", "openai"]);
  assert.deepEqual(tags({ tools: true, allowFlex: true }), ["openai/flex"]);
  const priority = structuredClone(response);
  priority.data.endpoints = priority.data.endpoints.filter((item) =>
    item.tag.startsWith("openai/fast"),
  );
  assert.deepEqual(tags({ tools: true }, priority), ["openai/fast"]);
  assert.equal(
    modelRoute(selectModelSnapshot(catalogEntry, priority, { tools: true }, "2026-09-28"))
      .serviceTier,
    "priority",
  );
});

test("every weight precision joins the set, and the smallest limit of the set bounds each request", () => {
  const glm = {
    id: "z-ai/glm-5.3-flash",
    canonical_slug: "z-ai/glm-5.3-flash-20260921",
    architecture: { input_modalities: ["text"] },
  };
  const endpoint = { ...endpointResponse.data.endpoints[0]!, model_id: glm.id };
  const response = {
    data: {
      endpoints: [
        { ...endpoint, tag: "cheap/fp4", quantization: "fp4" },
        { ...endpoint, tag: "io-net/fp8", quantization: "fp8", max_completion_tokens: 65_536 },
        { ...endpoint, tag: "morph/fp8", quantization: "fp8", max_completion_tokens: 943_718 },
      ],
    },
  };
  const snapshot = selectModelSnapshot(glm, response, { tools: true }, "2026-10-03");
  assert.deepEqual(
    snapshot.endpoints.map((item) => item.tag),
    ["cheap/fp4", "io-net/fp8", "morph/fp8"],
  );
  assert.equal(modelLimits(snapshot).maxOutputTokens, 65_536);
});

test("endpoint selection skips an endpoint with a known image limit below one request", () => {
  const judge = {
    id: "xiaomi/mimo-v2.6-flash",
    canonical_slug: "xiaomi/mimo-v2.6-flash-20260921",
    architecture: { input_modalities: ["text", "image"] },
  };
  const endpoint = { ...endpointResponse.data.endpoints[0]!, model_id: judge.id };
  const response = {
    data: {
      endpoints: [
        {
          ...endpoint,
          tag: "io-net/fp8",
          provider_name: "Io Net",
          latency_last_30m: 1,
          throughput_last_30m: 200,
        },
        {
          ...endpoint,
          tag: "novita/fp8",
          provider_name: "Novita",
          latency_last_30m: 5,
          throughput_last_30m: 50,
        },
      ],
    },
  };
  const requirement = (images: number) => ({
    tools: true,
    images: true,
    workload: { inputTokens: 8192, outputTokens: 1024, images, imageInputTokens: 1024 * images },
  });
  const tags = (selected: ModelRequirement, endpoints = response) =>
    selectModelSnapshot(judge, endpoints, selected, "2026-10-02").endpoints.map((item) => item.tag);
  assert.deepEqual(tags(requirement(9)), ["io-net/fp8", "novita/fp8"]);
  assert.deepEqual(tags(requirement(30)), ["novita/fp8"]);
  assert.deepEqual(tags({ tools: true, images: true, imagesPerRequest: 64 }), ["novita/fp8"]);
  assert.throws(
    () => tags(requirement(30), { data: { endpoints: [response.data.endpoints[0]!] } }),
    /io-net\/fp8: The endpoint accepts at most 9 images in one request/,
  );
});

test("the launch preview freezes a judge set that accepts the maximum presented frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-judge-images-"));
  try {
    await seedModelRegistry(root);
    await writeRunConfiguration(root);
    const requirements = new Map<string, ModelRequirement>();
    const adapters = {
      async catalog(selections: Array<{ id: string; requirement: ModelRequirement }>) {
        for (const { id, requirement } of selections) requirements.set(id, requirement);
        throw new Error("catalog recorded");
      },
      studio: { identity: async () => ({}) },
    } as unknown as ExecutionAdapters;
    await assert.rejects(
      previewEvaluationLaunch(
        root,
        { ...fixtureLaunchDefaults, sources: [{ kind: "evaluation", id: "a".repeat(64) }] },
        adapters,
      ),
      /catalog recorded/,
    );
    assert.equal(
      requirements.get("xiaomi/mimo-v2.6-flash")?.imagesPerRequest,
      MAXIMUM_PRESENTED_FRAMES,
    );
    assert.equal(requirements.get("openai/gpt-6-luna")?.imagesPerRequest, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launch preview reads the catalog and the Studio identity together and reports a catalog error first", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-preview-together-"));
  try {
    await seedModelRegistry(root);
    await writeRunConfiguration(root);
    let identityStarted = false;
    let identityBeforeCatalogAnswer = false;
    const adapters = {
      async catalog() {
        await new Promise((done) => setImmediate(done));
        identityBeforeCatalogAnswer = identityStarted;
        throw new Error("catalog unavailable");
      },
      studio: {
        async identity() {
          identityStarted = true;
          throw new Error("Studio unavailable");
        },
      },
    } as unknown as ExecutionAdapters;
    await assert.rejects(
      previewEvaluationLaunch(
        root,
        { ...fixtureLaunchDefaults, sources: [{ kind: "evaluation", id: "a".repeat(64) }] },
        adapters,
      ),
      /catalog unavailable/,
    );
    assert.equal(identityBeforeCatalogAnswer, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weekday tariffs preserve predicates and raw metadata without assuming dispatch time", () => {
  const alternative = structuredClone(endpointResponse) as unknown as {
    data: { endpoints: Array<Record<string, unknown>> };
  };
  const pricing = {
    prompt: "0.00000001",
    completion: "0.00000002",
    image: "0.00001",
    overrides: [{ utc_days: ["monday"], prompt: "0.0000001" }],
  };
  alternative.data.endpoints[0]!.tag = "reseller";
  alternative.data.endpoints.push({
    ...alternative.data.endpoints[0],
    tag: "weekday-schedule",
    pricing,
  });
  const snapshot = selectModelSnapshot(
    catalogEntry,
    alternative,
    { tools: true },
    "2026-09-23T00:00:00.000Z",
  );
  const weekday = snapshot.endpoints.find((endpoint) => endpoint.tag === "weekday-schedule")!;
  assert.deepEqual(weekday.rawPricing, pricing);
  assert.deepEqual(weekday.tiers[1]!.temporal, {
    utcStart: null,
    utcEnd: null,
    utcDays: ["monday"],
  });
  assert.ok(
    Math.abs(priceForUsage(snapshot, { inputTokens: 1000, outputTokens: 0, images: 0 }) - 0.0001) <
      1e-12,
  );
});

test("maximum quotes cover falling tiers and cache writes above ordinary input prices", () => {
  const snapshot = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true },
    "2026-09-25T00:00:00.000Z",
  );
  snapshot.endpoints[0]!.tiers = [
    {
      minPromptTokens: 0,
      temporal: null,
      inputPerTokenUsd: 0.01,
      outputPerTokenUsd: 0.01,
      imagePerImageUsd: 0.02,
      requestUsd: 0.01,
      cacheReadPerTokenUsd: 0.001,
      cacheWritePerTokenUsd: 0.03,
    },
    {
      minPromptTokens: 1000,
      temporal: null,
      inputPerTokenUsd: 0.0001,
      outputPerTokenUsd: 0.0001,
      imagePerImageUsd: 0.001,
      requestUsd: 0,
      cacheReadPerTokenUsd: null,
      cacheWritePerTokenUsd: null,
    },
  ];
  const upper = maximumUsageCost(snapshot, {
    inputTokens: 2000,
    outputTokens: 10,
    images: 1,
    imageInputTokens: 100,
  });
  assert.ok(Math.abs(upper - (999 * 0.03 + 10 * 0.01 + 0.02 + 0.01)) < 1e-10);
});

test("an endpoint joins the set only if it accepts the executable workload", () => {
  const endpoints = structuredClone(endpointResponse);
  endpoints.data.endpoints.unshift({
    ...endpoints.data.endpoints[0]!,
    tag: "cheap-too-small",
    max_completion_tokens: 100,
    pricing: { ...endpoints.data.endpoints[0]!.pricing, prompt: "0", completion: "0" },
  });
  assert.deepEqual(
    selectModelSnapshot(
      catalogEntry,
      endpoints,
      {
        tools: true,
        workload: { inputTokens: 8192, outputTokens: 8192, images: 0, imageInputTokens: 0 },
      },
      "2026-09-25T00:00:00.000Z",
    ).endpoints.map((endpoint) => endpoint.tag),
    ["openai"],
  );
});

test("time-window pricing reserves the highest declared charge", () => {
  const tiers = parsePriceTiers({
    prompt: "0.0000003",
    completion: "0.0000012",
    input_cache_read: "0.00000003",
    overrides: [
      { utc_start: 0, utc_end: 1400, prompt: "0.0000004", completion: "0.0000010" },
      { utc_start: 1400, utc_end: 0, prompt: "0.00000015", completion: "0.0000006" },
    ],
  });
  assert.equal(tiers.length, 3);
  assert.equal(tiers[1]?.inputPerTokenUsd, 0.0000004);
  assert.equal(tiers[0]?.outputPerTokenUsd, 0.0000012);
  assert.doesNotThrow(() =>
    parsePriceTiers({
      prompt: "0.0000003",
      completion: "0.0000012",
      overrides: [{ min_prompt_tokens: 100, utc_start: 0, utc_end: 1400 }],
    }),
  );
});

test("quote retains workload denominator and a cold conservative ceiling", () => {
  const snapshot = selectModelSnapshot(
    catalogEntry,
    endpointResponse,
    { tools: true },
    "2026-09-23T00:00:00.000Z",
  );
  const quote = createRunQuote(
    {
      independentBuilderTrials: 48,
      nativeCaptureRepetitions: 3,
      capturePasses: 144,
      nativeRootLaunches: 144,
      nativeClientLaunches: 0,
      startupRecoveryRootLaunches: 432,
      startupRecoveryClientLaunches: 0,
      criterionOutcomes: 432,
      judgmentBatches: 144,
      modelWork: [
        {
          stage: "builder",
          modelId: id,
          calls: 48,
          expected: { inputTokens: 10_000, outputTokens: 2_000, images: 0, imageInputTokens: 0 },
          upper: { inputTokens: 30_000, outputTokens: 8_192, images: 0, imageInputTokens: 0 },
        },
      ],
    },
    [snapshot],
  );
  assert.equal(quote.workload.independentBuilderTrials, 48);
  assert.equal("expectedUsd" in quote, false);
  assert.equal("recommendedCeilingUsd" in quote, false);
  assert.equal(createRunQuote(quote.workload, [snapshot]).id, quote.id);
  const continuation = includePriorCommittedSpend(quote, 0.008574565);
  assert.equal(continuation.priorCommittedUsd, 0.008574565);
  assert.notEqual(continuation.id, quote.id);
  assert.equal(includePriorCommittedSpend(quote, 0.008574565).id, continuation.id);
  const previouslyAuthorized = includePriorCommittedSpend(quote, 0.008574565, 100);
  assert.equal(previouslyAuthorized.priorAuthorizedCeilingUsd, 100);
  assert.throws(() => includePriorCommittedSpend(quote, -0.01), /nonnegative USD/u);
  assert.throws(() => includePriorCommittedSpend(quote, 0.01, -1), /nonnegative USD/u);
});
