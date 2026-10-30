import { workloadCeiling } from "../packages/model-client/src/quote.js";
import assert from "node:assert/strict";
import test from "node:test";
import { promptCapacity } from "../packages/model-client/src/request-workload.js";
import {
  claudeImageTokens,
  gemini2ImageTokens,
  imageTokenRule,
  imageTokenWork,
  mimoImageTokens,
  openAiTileCount,
  qwenImageTokens,
} from "../packages/model-client/src/image-tokens.js";
import {
  assertImageRequestLimits,
  imageRequestLimits,
} from "../packages/model-client/src/image-limits.js";
import {
  parsePriceTiers,
  selectModelSnapshot,
  type ModelSnapshot,
} from "../packages/model-client/src/catalog.js";
import { createRunQuote } from "../packages/model-client/src/quote.js";
import { combineNativeWork } from "../packages/studio-runner/src/workload.js";

function snapshot(id: "xiaomi/mimo-v2.6-flash" | "openai/gpt-6-luna") {
  return selectModelSnapshot(
    { id, canonical_slug: id + "-test", architecture: { input_modalities: ["text", "image"] } },
    {
      data: {
        endpoints: [
          {
            model_id: id,
            tag: "test",
            provider_name: "test",
            quantization: null,
            context_length: 100000,
            max_prompt_tokens: 90000,
            max_completion_tokens: 8192,
            supported_parameters: ["tools"],
            status: 0,
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      },
    },
    { tools: true },
    "2026-09-25T00:00:00.000Z",
  );
}
test("MiMo image estimation follows scaling and ties-to-even with independently retained admission bounds", () => {
  assert.equal(mimoImageTokens(1024, 1024), 1024);
  assert.equal(mimoImageTokens(960, 540), 510);
  assert.equal(mimoImageTokens(80, 80), 9);
  assert.ok(mimoImageTokens(8192, 8192) <= 8192);
  const work = imageTokenWork(
    snapshot("xiaomi/mimo-v2.6-flash"),
    [{ width: 960, height: 540 }],
    50000,
  );
  assert.equal(work.expected, 510);
  assert.equal(work.upper, 8192);
});
/** A frozen snapshot of another family; only the identity and endpoint facts matter here. */
function family(id: string, provider = "test", contextLength = 1_000_000): ModelSnapshot {
  const base = snapshot("xiaomi/mimo-v2.6-flash");
  return {
    ...base,
    id: id as ModelSnapshot["id"],
    endpoints: [{ ...base.endpoints[0]!, provider, contextLength, maxPromptTokens: null }],
  };
}

test("Claude estimates follow the documented resize examples of both resolution tiers", () => {
  const standard = { maxEdge: 1568, maxTokens: 1568 };
  const high = { maxEdge: 2576, maxTokens: 4784 };
  for (const [width, height, tokens] of [
    [200, 200, 64],
    [1000, 1000, 1296],
    [1092, 1092, 1521],
    [1920, 1080, 1560],
    [2000, 1500, 1564],
    [3840, 2160, 1560],
    [1075, 1520, 33 * 47],
  ] as const)
    assert.equal(claudeImageTokens(width, height, standard), tokens, `${width}x${height}`);
  for (const [width, height, tokens] of [
    [1920, 1080, 2691],
    [2000, 1500, 3888],
    [3840, 2160, 4784],
  ] as const)
    assert.equal(claudeImageTokens(width, height, high), tokens, `${width}x${height}`);
  // "Claude 4.7 and later" use the high-resolution tier; an unread version is conservative.
  for (const [id, tokens] of [
    ["anthropic/claude-opus-4.6", 1560],
    ["anthropic/claude-sonnet-4", 1560],
    ["anthropic/claude-opus-4.7", 2691],
    ["anthropic/claude-sonnet-5.5", 2691],
    ["anthropic/claude-3.7-sonnet", 2691],
  ] as const)
    assert.deepEqual(imageTokenRule(family(id))!.known(1920, 1080), {
      expected: tokens,
      upper: tokens,
    });
  assert.equal(imageTokenRule(family("anthropic/claude-opus-4.6"))!.unknownUpper, 1568);
});

test("OpenAI, Gemini, Qwen and DeepSeek estimators follow their documented formulas", () => {
  // OpenAI: "A 1024 × 1024 image needs 32 × 32 = 1024 patches ... ceil(1024 × 1.2) = 1229".
  for (const id of ["openai/gpt-6-astra", "openai/gpt-5.6-luna"])
    assert.deepEqual(imageTokenRule(family(id))!.known(1024, 1024), {
      expected: 1229,
      upper: 1230,
    });
  assert.throws(
    () => imageTokenRule(family("openai/gpt-5.6-luna"))!.known(6000, 6000),
    /patch limit/,
  );
  assert.equal(imageTokenRule(family("openai/gpt-5.6-luna"))!.unknownUpper, 36001);
  // A 2,500-patch budget bounds a resized image.
  assert.deepEqual(imageTokenRule(family("openai/gpt-5.4"))!.known(2048, 2048), {
    expected: 3000,
    upper: 3001,
  });
  // Tile models: 1024 x 1024 is four 512 px tiles; 2048 x 4096 is six.
  assert.equal(openAiTileCount(1024, 1024), 4);
  assert.equal(openAiTileCount(2048, 4096), 6);
  assert.equal(imageTokenRule(family("openai/gpt-4o"))!.known(1024, 1024).upper, 85 + 4 * 170);
  assert.equal(imageTokenRule(family("openai/gpt-6-luna")), null, "not in the OpenAI guide");
  // Gemini 2: 258 tokens up to 384 px; larger images use crop tiles of two thirds of the short edge.
  assert.equal(gemini2ImageTokens(384, 384), 258);
  assert.equal(gemini2ImageTokens(1280, 720), 6 * 258);
  assert.equal(gemini2ImageTokens(1000, 1000), 4 * 258);
  assert.equal(imageTokenRule(family("google/gemini-2.5-flash"))!.unknownUpper, null);
  assert.deepEqual(imageTokenRule(family("google/gemini-3.1-pro-preview"))!.known(4000, 3000), {
    expected: 1120,
    upper: 1120,
  });
  assert.equal(imageTokenRule(family("google/gemma-4-31b-it")), null);
  // Qwen: one token for each patch square, at least 256, at most 16,384, plus two.
  assert.equal(qwenImageTokens(1280, 720, 32), 40 * 23 + 2);
  assert.equal(qwenImageTokens(1280, 720, 28), 46 * 26 + 2);
  assert.equal(qwenImageTokens(32, 32, 32), 256 + 2);
  assert.equal(qwenImageTokens(8192, 8192, 32), 16_384 + 2);
  assert.equal(imageTokenRule(family("qwen/qwen3-vl-8b-instruct"))!.known(1280, 720).upper, 922);
  assert.equal(
    imageTokenRule(family("qwen/qwen2.5-vl-72b-instruct"))!.known(1280, 720).upper,
    1198,
  );
  assert.equal(imageTokenRule(family("qwen/qwen3.8-flash"))!.known(1280, 720).upper, 1198);
  // DeepSeek publishes only an upper bound.
  assert.deepEqual(imageTokenRule(family("deepseek/deepseek-v4.1-flash"))!.known(5000, 5000), {
    expected: null,
    upper: 1024,
  });
  for (const id of ["meta/muse-spark-1.3-contributor", "z-ai/glm-5.3-flash"])
    assert.equal(imageTokenRule(family(id)), null, `${id} has no documented formula`);
});

test("a documented family bounds small judgments instead of reserving all prompt capacity", () => {
  const claude = family("anthropic/claude-opus-4.7");
  const work = imageTokenWork(
    claude,
    [
      { width: 1920, height: 1080 },
      { width: null, height: null },
    ],
    900_000,
  );
  assert.equal(work.expected, null);
  assert.equal(work.upper, 2691 + 4784);
  assert.match(work.basis, /platform\.claude\.com/);
  const gemini2 = family("google/gemini-2.5-flash");
  assert.equal(imageTokenWork(gemini2, [{ width: null, height: null }], 50_000).upper, 50_000);
});

test("provider request limits refuse images before spend and never resize them", () => {
  const edge = (width: number, count: number, encodedBytes: number | null = null) =>
    Array.from({ length: count }, () => ({ width, height: 720, encodedBytes }));
  const direct = family("anthropic/claude-opus-4.7", "Anthropic");
  assert.equal(imageRequestLimits(direct.id, direct.endpoints[0]!).maxImages, 64);
  assert.equal(
    imageRequestLimits(
      "anthropic/claude-haiku-4.5",
      family("anthropic/claude-haiku-4.5", "Anthropic", 200_000).endpoints[0]!,
    ).maxImages,
    64,
  );
  assert.doesNotThrow(() => assertImageRequestLimits(direct, edge(2048, 20), null));
  assert.throws(
    () => assertImageRequestLimits(direct, edge(2048, 21), null),
    /at most 2000 px in this request\. Image 1 has an edge of 2048 px\. Basalt does not resize images/,
  );
  assert.doesNotThrow(() => assertImageRequestLimits(direct, edge(1280, 3, 9_000_000), 1000));
  assert.throws(
    () => assertImageRequestLimits(direct, edge(1280, 4, 9_000_000), 1000),
    /at most 32000000 bytes/,
  );
  const bedrock = family("anthropic/claude-opus-4.7", "Amazon Bedrock");
  assert.throws(
    () => assertImageRequestLimits(bedrock, edge(1280, 1, 6_000_000), 1000),
    /at most 5000000 encoded bytes for one image/,
  );
  assert.throws(
    () => assertImageRequestLimits(bedrock, edge(1280, 5, 4_900_000), 1000),
    /at most 20000000 bytes/,
  );
  // An unknown host of a Claude model receives the lowest documented limits.
  assert.equal(
    imageRequestLimits(
      "anthropic/claude-opus-4.7",
      family("anthropic/claude-opus-4.7", "Other").endpoints[0]!,
    ).maxRequestBytes,
    20_000_000,
  );
  const deepseek = family("deepseek/deepseek-v4.1-flash", "DeepSeek");
  assert.doesNotThrow(() => assertImageRequestLimits(deepseek, edge(5000, 14), null));
  assert.throws(() => assertImageRequestLimits(deepseek, edge(5000, 15), null), /4096 px/);
  const meta = family("meta/muse-spark-1.3-contributor", "Meta");
  assert.throws(() => assertImageRequestLimits(meta, edge(1280, 51), null), /at most 50 images/);
  // OpenAI request limits (1,500 images and 512 MB) do not bind Basalt's own bounds.
  assert.doesNotThrow(() =>
    assertImageRequestLimits(family("openai/gpt-5.6-luna", "OpenAI"), edge(4000, 64, 2_000_000), 1),
  );
});

test("undocumented image preprocessing has an unavailable estimate and an explicit capacity reservation", () => {
  const model = snapshot("openai/gpt-6-luna");
  const work = imageTokenWork(model, [{ width: 1000, height: 800 }], 50000);
  assert.equal(work.expected, null);
  assert.equal(work.upper, 50000);
  assert.equal(promptCapacity(model, 8192), 90000);
  assert.throws(() => promptCapacity(model, 8193), /output limit/);
});
test("native-only replay permits a quote with no paid calls or model snapshots", () => {
  const quote = createRunQuote(
    {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 3,
      ...combineNativeWork(),
      criterionOutcomes: 0,
      judgmentBatches: 0,
      modelWork: [],
    },
    [],
  );
  assert.equal(workloadCeiling(quote), 0);
});
test("tariff predicates retain combined context and weekday information and reject malformed clocks", () => {
  const tiers = parsePriceTiers({
    prompt: "0.000001",
    completion: "0.000002",
    overrides: [
      {
        min_prompt_tokens: 10000,
        utc_days: ["monday"],
        utc_start: 100,
        utc_end: 400,
        prompt: "0.000004",
      },
    ],
  });
  assert.equal(tiers[1]!.minPromptTokens, 10000);
  assert.deepEqual(tiers[1]!.temporal, { utcStart: 100, utcEnd: 400, utcDays: ["monday"] });
  assert.throws(
    () =>
      parsePriceTiers({
        prompt: "1",
        completion: "1",
        overrides: [{ utc_start: 1265, utc_end: 1400 }],
      }),
    /temporal price boundary/,
  );
});
