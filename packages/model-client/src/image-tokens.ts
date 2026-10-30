import type { ModelSnapshot } from "./catalog.js";

/**
 * Per-family image token rules from official provider documents. Each rule gives an upper
 * bound that is conservative for its documented formula. A model without a documented rule
 * keeps the reservation of all remaining prompt capacity. The billed usage stays authoritative.
 */
interface ImageTokenRule {
  family: string;
  basis: string;
  source: string;
  /** Tokens for one image with known pixel dimensions. Throws if the provider rejects it. */
  known(width: number, height: number): { expected: number | null; upper: number };
  /** Upper bound for one image with unknown dimensions, or null without a documented bound. */
  unknownUpper: number | null;
}

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/vision";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/guides/images-vision";
const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/image-understanding";
const GEMINI_RESOLUTION_SOURCE = "https://ai.google.dev/gemini-api/docs/media-resolution";
const QWEN_SOURCE = "https://www.alibabacloud.com/help/en/model-studio/vision-model/";
const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/guides/vision/";

function dimensions(width: number, height: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 65535))
    throw new Error("Invalid image dimensions");
}

/** Python round(): ties go to the even neighbour. */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Xiaomi's published calculation uses Python's ties-to-even round. */
export function mimoImageTokens(width: number, height: number): number {
  dimensions(width, height);
  let h = roundTiesToEven(height / 32) * 32,
    w = roundTiesToEven(width / 32) * 32;
  if (h * w > 8388608) {
    const scale = Math.sqrt((width * height) / 8388608);
    h = Math.floor(height / scale / 32) * 32;
    w = Math.floor(width / scale / 32) * 32;
  } else if (h * w < 8192) {
    const scale = Math.sqrt(8192 / (height * width));
    h = Math.ceil((height * scale) / 32) * 32;
    w = Math.ceil((width * scale) / 32) * 32;
  }
  if (h < 32 || w < 32) throw new Error("Image aspect ratio has no supported patch extent");
  return (h * w) / 1024;
}

/** The reference resize of the Claude vision guide, then one token for each 28 px patch. */
export function claudeImageTokens(
  width: number,
  height: number,
  tier: { maxEdge: number; maxTokens: number },
): number {
  dimensions(width, height);
  const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);
  const fits = (w: number, h: number) =>
    Math.ceil(w / 28) * 28 <= tier.maxEdge &&
    Math.ceil(h / 28) * 28 <= tier.maxEdge &&
    tokens(w, h) <= tier.maxTokens;
  const resized = (w: number, h: number): [number, number] => {
    if (fits(w, h)) return [w, h];
    if (h > w) {
      const [rh, rw] = resized(h, w);
      return [rw, rh];
    }
    const aspect = w / h;
    let lo = 1,
      hi = w;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid, Math.max(roundTiesToEven(mid / aspect), 1))) lo = mid;
      else hi = mid;
    }
    return [lo, Math.max(roundTiesToEven(lo / aspect), 1)];
  };
  const [w, h] = resized(width, height);
  return tokens(w, h);
}

const CLAUDE_STANDARD = { maxEdge: 1568, maxTokens: 1568 };
const CLAUDE_HIGH_RESOLUTION = { maxEdge: 2576, maxTokens: 4784 };

/** "Claude 4.7 and later models" use the high-resolution tier; an unread version does too. */
function claudeTier(modelId: string) {
  const match = /^anthropic\/claude-[a-z]+-(\d+)(?:\.(\d+))?$/u.exec(modelId);
  if (!match) return CLAUDE_HIGH_RESOLUTION;
  const major = Number(match[1]),
    minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7) ? CLAUDE_HIGH_RESOLUTION : CLAUDE_STANDARD;
}

/**
 * OpenAI patch models: 32 px patches times a model multiplier. `auto` detail applies, because
 * the transport sends no detail level. A null budget keeps the image at its original size, and
 * the API rejects more than 30,000 patches. An undocumented budget uses that API maximum.
 */
const OPENAI_PATCH_MODELS: Record<string, { multiplier: number; budget: number | null }> = {
  "gpt-6-astra": { multiplier: 1.2, budget: null },
  "gpt-5.6-sol": { multiplier: 1.2, budget: null },
  "gpt-5.6-terra": { multiplier: 1.2, budget: null },
  "gpt-5.6-luna": { multiplier: 1.2, budget: null },
  "gpt-5.5": { multiplier: 1.2, budget: 10_000 },
  "gpt-5.4": { multiplier: 1.2, budget: 2_500 },
  "gpt-5.4-mini": { multiplier: 1.2, budget: 2_500 },
  "gpt-5.4-nano": { multiplier: 1.2, budget: 2_500 },
  "gpt-5.2": { multiplier: 1.2, budget: 6_144 },
  "gpt-4.1-mini": { multiplier: 1.62, budget: 6_144 },
  "gpt-5-mini": { multiplier: 1.2, budget: 30_000 },
  "gpt-5-nano": { multiplier: 1.5, budget: 30_000 },
  "gpt-4.1-nano": { multiplier: 2.46, budget: 30_000 },
  "o4-mini": { multiplier: 1.72, budget: 30_000 },
};
const OPENAI_PATCH_LIMIT = 30_000;

/** OpenAI tile models: base tokens plus tile tokens for each 512 px square at `high` detail. */
const OPENAI_TILE_MODELS: Record<string, { base: number; tile: number }> = {
  "gpt-5.1": { base: 70, tile: 140 },
  "gpt-5": { base: 70, tile: 140 },
  "gpt-4.1": { base: 85, tile: 170 },
  "gpt-4o": { base: 85, tile: 170 },
  "gpt-4o-mini": { base: 2833, tile: 5667 },
};

export function openAiTileCount(width: number, height: number): number {
  dimensions(width, height);
  let w = width,
    h = height;
  const fit = Math.min(1, 2048 / Math.max(w, h));
  w *= fit;
  h *= fit;
  const short = Math.min(1, 768 / Math.min(w, h));
  w *= short;
  h *= short;
  return Math.ceil(Math.ceil(w) / 512) * Math.ceil(Math.ceil(h) / 512);
}

/** Gemini 2 tiles: one crop unit is two thirds of the short edge, at most 768 px. */
export function gemini2ImageTokens(width: number, height: number): number {
  dimensions(width, height);
  if (width <= 384 && height <= 384) return 258;
  const unit = Math.max(1, Math.min(768, Math.floor(Math.min(width, height) / 1.5)));
  return Math.ceil(width / unit) * Math.ceil(height / unit) * 258;
}

/** Qwen VL: one token for each patch square, between the documented bounds, plus two. */
export function qwenImageTokens(width: number, height: number, patch: 28 | 32): number {
  dimensions(width, height);
  const patches = Math.ceil(width / patch) * Math.ceil(height / patch);
  return Math.min(Math.max(patches, 256), 16_384) + 2;
}

export function imageTokenRule(snapshot: Pick<ModelSnapshot, "id">): ImageTokenRule | null {
  const id: string = snapshot.id;
  if (id === "xiaomi/mimo-v2.6-flash")
    return {
      family: "Xiaomi MiMo",
      basis:
        "Xiaomi published scaling estimate; reserve the published maximum pixel budget per image",
      source: "Xiaomi MiMo image input documentation",
      known: (width, height) => ({
        expected: mimoImageTokens(width, height),
        upper: Math.max(8192, mimoImageTokens(width, height)),
      }),
      unknownUpper: 8192,
    };
  if (id.startsWith("anthropic/")) {
    const tier = claudeTier(id);
    return {
      family: "Anthropic Claude",
      basis: `28 px patches after the reference resize to ${tier.maxEdge} px and ${tier.maxTokens} tokens`,
      source: ANTHROPIC_SOURCE,
      known: (width, height) => {
        const tokens = claudeImageTokens(width, height, tier);
        return { expected: tokens, upper: tokens };
      },
      unknownUpper: tier.maxTokens,
    };
  }
  if (id.startsWith("openai/")) {
    const name = id.slice("openai/".length);
    const patch = OPENAI_PATCH_MODELS[name];
    if (patch)
      return {
        family: "OpenAI patch",
        basis: `32 px patches times ${patch.multiplier}, plus one token of rounding for each image`,
        source: OPENAI_SOURCE,
        known: (width, height) => {
          dimensions(width, height);
          const patches = Math.ceil(width / 32) * Math.ceil(height / 32);
          if (patch.budget === null && patches > OPENAI_PATCH_LIMIT)
            throw new Error("Original-detail image exceeds the documented patch limit");
          const tokens = Math.ceil(
            Math.min(patches, patch.budget ?? OPENAI_PATCH_LIMIT) * patch.multiplier,
          );
          return { expected: tokens, upper: tokens + 1 };
        },
        unknownUpper: Math.ceil((patch.budget ?? OPENAI_PATCH_LIMIT) * patch.multiplier) + 1,
      };
    const tile = OPENAI_TILE_MODELS[name];
    if (tile)
      return {
        family: "OpenAI tile",
        basis: `${tile.base} base tokens and ${tile.tile} tokens for each 512 px tile`,
        source: OPENAI_SOURCE,
        known: (width, height) => {
          const tokens = tile.base + tile.tile * openAiTileCount(width, height);
          return { expected: tokens, upper: tokens };
        },
        unknownUpper: tile.base + tile.tile * 8,
      };
    return null;
  }
  const gemini = /^google\/gemini-(\d+)(?:\.\d+)?(?:-|$)/u.exec(id);
  if (gemini) {
    if (Number(gemini[1]) >= 3)
      return {
        family: "Google Gemini 3",
        basis: "1120 tokens for each image at the default media resolution",
        source: GEMINI_RESOLUTION_SOURCE,
        known: (width, height) => {
          dimensions(width, height);
          return { expected: 1120, upper: 1120 };
        },
        unknownUpper: 1120,
      };
    if (Number(gemini[1]) === 2)
      return {
        family: "Google Gemini 2",
        basis: "258 tokens for each crop tile of two thirds of the short edge",
        source: GEMINI_SOURCE,
        known: (width, height) => {
          const tokens = gemini2ImageTokens(width, height);
          return { expected: tokens, upper: tokens };
        },
        unknownUpper: null,
      };
    return null;
  }
  if (id.startsWith("qwen/")) {
    // Qwen3-VL and later native multimodal models use 32 px; every other Qwen model
    // uses the 28 px rule, which gives the larger count for the same image.
    const patch = /^qwen\/qwen(?:3-vl|3\.5|3\.6)/u.test(id) ? 32 : 28;
    return {
      family: "Qwen VL",
      basis: `${patch} px patches, bounded to 256 through 16384 tokens, plus two tokens`,
      source: QWEN_SOURCE,
      known: (width, height) => {
        const tokens = qwenImageTokens(width, height, patch);
        return { expected: tokens, upper: tokens };
      },
      unknownUpper: 16_384 + 2,
    };
  }
  if (id === "deepseek/deepseek-v4.1-flash" || id === "deepseek/deepseek-v4-flash-vision-exp")
    return {
      family: "DeepSeek",
      basis: "the documented upper bound of 1024 tokens for each image; no formula is published",
      source: DEEPSEEK_SOURCE,
      known: (width, height) => {
        dimensions(width, height);
        return { expected: null, upper: 1024 };
      },
      unknownUpper: 1024,
    };
  return null;
}

/** Sum the per-image rule. An unknown rule reserves all remaining prompt capacity. */
export function imageTokenWork(
  snapshot: ModelSnapshot,
  images: Array<{ width: number | null; height: number | null }>,
  remainingInputCapacity: number,
): { expected: number | null; upper: number; basis: string } {
  if (!images.length) return { expected: 0, upper: 0, basis: "no_images" };
  if (!snapshot.inputModalities.includes("image"))
    throw new Error("The selected model cannot read images. Select a different model.");
  const rule = imageTokenRule(snapshot);
  const unbounded = () => {
    // Missing model-specific preprocessing metadata is an explicit unknown estimate.
    // Only the remaining admitted prompt capacity bounds liability; never invent a token constant.
    if (remainingInputCapacity < 1)
      throw new Error(
        "The request text fills the context limit of the selected model, so no room remains for images. Select a different model.",
      );
    return {
      expected: null,
      upper: remainingInputCapacity,
      basis:
        "Image token estimate unavailable for this model/endpoint; liability uses remaining admitted prompt capacity.",
    };
  };
  if (!rule) return unbounded();
  let expected: number | null = 0,
    upper = 0;
  for (const { width, height } of images) {
    if (width === null || height === null) {
      if (rule.unknownUpper === null) return unbounded();
      expected = null;
      upper += rule.unknownUpper;
      continue;
    }
    const estimate = rule.known(width, height);
    expected =
      expected === null || estimate.expected === null ? null : expected + estimate.expected;
    upper += estimate.upper;
  }
  return {
    expected,
    upper,
    basis: `${rule.family}: ${rule.basis}. Source: ${rule.source}. Billed usage remains authoritative.`,
  };
}
