import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import {
  REASONING_EFFORTS,
  type ModelRoute,
  type ModelSampling,
  type ReasoningEffort,
} from "./contracts.js";
import { imageRequestLimits } from "./image-limits.js";
import { modelLimits } from "./model-limits.js";
import { catalogRecommendedSampling } from "./sampling.js";

/** Tier suffixes are documented endpoint identities; absent suffix requests default capacity. */
function serviceTier(tag: string): ModelRoute["serviceTier"] {
  const suffix = tag.split("/").at(-1);
  return suffix === "flex"
    ? "flex"
    : suffix === "fast" || suffix === "priority"
      ? "priority"
      : "default";
}

/** The request options of one model. OpenRouter picks the endpoint itself. */
export function modelRoute(model: ModelSnapshot): ModelRoute {
  return {
    serviceTier: serviceTier(model.endpoints[0]!.tag),
    seedSupported: modelLimits(model).supportedParameters.includes("seed"),
    reasoningEffort: selectedReasoningEffort(model),
    maxPrice: routePriceLimit(model),
  };
}

/** An OpenRouter model ID, for example "xiaomi/mimo-v2.6-flash". */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:~-]*$/iu;

interface PriceTier {
  minPromptTokens: number;
  temporal: { utcStart: number | null; utcEnd: number | null; utcDays: string[] | null } | null;
  inputPerTokenUsd: number;
  outputPerTokenUsd: number;
  imagePerImageUsd: number | null;
  requestUsd: number;
  cacheReadPerTokenUsd: number | null;
  cacheWritePerTokenUsd: number | null;
}

export interface EndpointSnapshot {
  tag: string;
  provider: string;
  quantization: string;
  contextLength: number;
  maxPromptTokens: number | null;
  rawPricing: Record<string, unknown>;
  maxOutputTokens: number;
  supportedParameters: string[];
  tiers: PriceTier[];
}

export interface ModelSnapshot {
  id: string;
  name: string;
  revision: string;
  capturedAt: string;
  inputModalities: string[];
  reasoning: ReasoningCapabilities | null;
  /** The catalog `default_parameters`; null records that the catalog recommends no value. */
  recommendedSampling: ModelSampling;
  /** The frozen endpoint set, sorted by tag. Each receipt records the endpoint that served it. */
  endpoints: EndpointSnapshot[];
  hash: string;
}

/** Compare treatment and tariff facts; retrieval metadata and display names are not treatment changes. */
export function modelTreatmentIdentity(model: ModelSnapshot): string {
  return hashJson(identityFacts(model, true));
}

/**
 * The treatment identity of a model apart from its prices and the price limit of its route.
 * OpenRouter prices can change within minutes, and a price change does not change what the
 * model does. A run that changes its evaluations keeps the approved models by this identity,
 * and its spending limit still holds.
 */
export function modelIdentityWithoutPrices(model: ModelSnapshot): string {
  return hashJson(identityFacts(model, false));
}

function identityFacts(model: ModelSnapshot, prices: boolean) {
  const route = modelRoute(model);
  return {
    id: model.id,
    revision: model.revision,
    inputModalities: [...model.inputModalities].sort(),
    reasoning: model.reasoning,
    recommendedSampling: model.recommendedSampling,
    endpoints: model.endpoints.map((endpoint) => ({
      tag: endpoint.tag,
      provider: endpoint.provider,
      quantization: endpoint.quantization,
      contextLength: endpoint.contextLength,
      maxPromptTokens: endpoint.maxPromptTokens,
      maxOutputTokens: endpoint.maxOutputTokens,
      supportedParameters: [...endpoint.supportedParameters].sort(),
      ...(prices ? { tiers: endpoint.tiers } : {}),
    })),
    route: prices ? route : { ...route, maxPrice: null },
  };
}

export interface ModelRequirement {
  tools?: boolean;
  images?: boolean;
  /** The most images in one request. An endpoint with a lower known image limit is not eligible. */
  imagesPerRequest?: number;
  structuredOutputs?: boolean;
  allowFlex?: boolean;
  /** Local pure request factory; never serialized or sent to a provider. */
  quoteWorkload?: (snapshot: ModelSnapshot) => Array<{
    calls: number;
    usage: { inputTokens: number; outputTokens: number; images: number; imageInputTokens: number };
  }>;
  workload?: {
    inputTokens: number;
    outputTokens: number;
    images: number;
    imageInputTokens: number;
  };
}

type RecordValue = Record<string, unknown>;

interface ReasoningCapabilities {
  effortSelection: "unavailable" | "unrestricted" | "listed";
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
  defaultEnabled: boolean | null;
  mandatory: boolean | null;
  supportsTokenBudget: boolean | null;
}

function reasoningCapabilities(value: unknown): ReasoningCapabilities | null {
  if (value === undefined || value === null) return null;
  const metadata = record(value, "reasoning metadata");
  const validEffort = (effort: unknown): effort is ReasoningEffort =>
    typeof effort === "string" && (REASONING_EFFORTS as readonly string[]).includes(effort);
  if (
    (metadata.supported_efforts !== undefined &&
      metadata.supported_efforts !== null &&
      (!Array.isArray(metadata.supported_efforts) ||
        !metadata.supported_efforts.length ||
        !metadata.supported_efforts.every(validEffort))) ||
    (metadata.default_effort !== undefined &&
      metadata.default_effort !== null &&
      !validEffort(metadata.default_effort))
  )
    throw new Error("Invalid provider reasoning effort metadata");
  const boolean = (key: string) => {
    if (metadata[key] === undefined || metadata[key] === null) return null;
    if (typeof metadata[key] !== "boolean") throw new Error("Invalid provider reasoning " + key);
    return metadata[key] as boolean;
  };
  const result: ReasoningCapabilities = {
    effortSelection:
      metadata.supported_efforts === undefined
        ? "unavailable"
        : metadata.supported_efforts === null
          ? "unrestricted"
          : "listed",
    supportedEfforts: Array.isArray(metadata.supported_efforts)
      ? [...new Set(metadata.supported_efforts as ReasoningEffort[])].sort()
      : [],
    defaultEffort: (metadata.default_effort ?? null) as ReasoningEffort | null,
    defaultEnabled: boolean("default_enabled"),
    mandatory: boolean("mandatory"),
    supportsTokenBudget: boolean("supports_max_tokens"),
  };
  if (
    result.defaultEffort &&
    result.effortSelection === "listed" &&
    !result.supportedEfforts.includes(result.defaultEffort)
  )
    throw new Error("Provider default reasoning effort is not supported");
  if (result.mandatory === true && result.defaultEffort === "none")
    throw new Error("Provider mandatory reasoning conflicts with its default");
  if (
    result.mandatory === true &&
    result.effortSelection === "listed" &&
    result.supportedEfforts.every((effort) => effort === "none")
  )
    throw new Error("Provider mandatory reasoning has no supported enabled effort");
  return result;
}

/** Do not send a universal effort to models with different advertised vocabularies. */
function selectedReasoningEffort(model: ModelSnapshot): ReasoningEffort | null {
  const metadata = model.reasoning;
  if (
    !metadata ||
    metadata.effortSelection === "unavailable" ||
    !modelLimits(model).supportedParameters.some(
      (name) => name === "reasoning" || name === "reasoning_effort",
    )
  )
    return null;
  const supported =
    metadata.effortSelection === "unrestricted" ? REASONING_EFFORTS : metadata.supportedEfforts;
  return (
    (
      ["medium", "low", "minimal", metadata.defaultEffort, "high", "xhigh", "max", "none"] as const
    ).find(
      (effort) =>
        effort !== null &&
        supported.includes(effort) &&
        !(effort === "none" && metadata.mandatory === true),
    ) ?? null
  );
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider " + label);
  return value as RecordValue;
}

function nonnegative(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid provider " + label);
  return parsed;
}

function optionalPrice(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : nonnegative(value, label);
}

function priceTier(
  value: unknown,
  minPromptTokens: number,
  temporal: PriceTier["temporal"] = null,
): PriceTier {
  const pricing = record(value, "pricing");
  return {
    minPromptTokens,
    temporal,
    inputPerTokenUsd: nonnegative(pricing.prompt, "prompt price"),
    outputPerTokenUsd: nonnegative(pricing.completion, "completion price"),
    imagePerImageUsd: optionalPrice(pricing.image, "image price"),
    requestUsd: pricing.request === undefined ? 0 : nonnegative(pricing.request, "request price"),
    cacheReadPerTokenUsd: optionalPrice(pricing.input_cache_read, "cache read price"),
    cacheWritePerTokenUsd: optionalPrice(pricing.input_cache_write, "cache write price"),
  };
}

export function parsePriceTiers(value: unknown): PriceTier[] {
  const pricing = record(value, "pricing");
  const tiers = [priceTier(pricing, 0)];
  if (pricing.overrides !== undefined) {
    if (!Array.isArray(pricing.overrides)) throw new Error("Invalid provider pricing overrides");
    for (const override of pricing.overrides) {
      const item = record(override, "pricing override");
      const minimum =
        item.min_prompt_tokens === undefined
          ? 0
          : nonnegative(item.min_prompt_tokens, "tier threshold");
      if (!Number.isSafeInteger(minimum))
        throw new Error("Invalid provider pricing tier threshold");
      const temporal =
        item.utc_start !== undefined || item.utc_end !== undefined || item.utc_days !== undefined;
      let predicate: PriceTier["temporal"] = null;
      if (temporal) {
        const clock = (value: unknown) =>
          Number.isSafeInteger(value) &&
          (value as number) >= 0 &&
          (value as number) <= 2400 &&
          (value as number) % 100 < 60;
        if (
          (item.utc_start !== undefined || item.utc_end !== undefined) &&
          (!clock(item.utc_start) || !clock(item.utc_end))
        )
          throw new Error("Invalid provider temporal price boundary");
        const days =
          item.utc_days === undefined ? null : strings(item.utc_days, "pricing weekdays");
        if (
          days &&
          (!days.length ||
            new Set(days).size !== days.length ||
            days.some(
              (day) =>
                ![
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ].includes(day),
            ))
        )
          throw new Error("Invalid provider pricing weekdays");
        predicate = {
          utcStart: (item.utc_start as number | undefined) ?? null,
          utcEnd: (item.utc_end as number | undefined) ?? null,
          utcDays: days,
        };
      } else if (!minimum) throw new Error("Pricing override lacks a predicate");
      tiers.push(priceTier({ ...pricing, ...item }, minimum, predicate));
    }
  }
  tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  if (
    new Set(
      tiers.map((tier) => hashJson({ minimum: tier.minPromptTokens, temporal: tier.temporal })),
    ).size !== tiers.length
  )
    throw new Error("Duplicate provider pricing predicate");
  return tiers;
}

/** No undocumented weekday/overlap precedence is assumed. Bound every permitted dispatch time. */
function admissibleTiers(endpoint: EndpointSnapshot, inputTokens: number): PriceTier[] {
  const applicable = endpoint.tiers.filter((tier) => tier.minPromptTokens <= inputTokens);
  const contextual = applicable.filter((tier) => tier.temporal === null);
  const base = contextual.at(-1);
  if (!base) throw new Error("No applicable provider pricing tier");
  return [base, ...applicable.filter((tier) => tier.temporal !== null)];
}

/** The highest charge in the set, because OpenRouter can serve a request with any endpoint of it. */
export function priceForUsage(
  snapshot: ModelSnapshot,
  usage: {
    inputTokens: number;
    outputTokens: number;
    images: number;
    imageInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  for (const value of Object.values(usage))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Usage must be nonnegative integers");
  const imageInputTokens = usage.imageInputTokens ?? 0;
  const totalInputTokens = usage.inputTokens + imageInputTokens;
  return Math.max(
    ...snapshot.endpoints
      .flatMap((endpoint) => admissibleTiers(endpoint, totalInputTokens))
      .map((tier) => {
        if (usage.images > 0 && tier.imagePerImageUsd === null && imageInputTokens === 0)
          throw new Error(
            "The provider publishes no image price, and Basalt cannot count the image tokens",
          );
        const cacheRead = usage.cacheReadTokens ?? 0;
        const cacheWrite = usage.cacheWriteTokens ?? 0;
        if (cacheRead + cacheWrite > totalInputTokens)
          throw new Error("Cached tokens exceed input tokens");
        if (cacheRead > 0 && tier.cacheReadPerTokenUsd === null)
          throw new Error("Cache read charge is unknown");
        if (cacheWrite > 0 && tier.cacheWritePerTokenUsd === null)
          throw new Error("Cache write charge is unknown");
        return (
          (totalInputTokens - cacheRead - cacheWrite) * tier.inputPerTokenUsd +
          cacheRead * (tier.cacheReadPerTokenUsd ?? 0) +
          cacheWrite * (tier.cacheWritePerTokenUsd ?? 0) +
          usage.outputTokens * tier.outputPerTokenUsd +
          usage.images * (tier.imagePerImageUsd ?? 0) +
          tier.requestUsd
        );
      }),
  );
}

/**
 * Maximum charge anywhere inside the declared usage bounds, including cache writes, on any
 * endpoint of the set.
 */
export function maximumUsageCost(
  snapshot: ModelSnapshot,
  bound: { inputTokens: number; outputTokens: number; images: number; imageInputTokens: number },
): number {
  for (const value of Object.values(bound))
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid maximum usage bound");
  const maximumInput = bound.inputTokens + bound.imageInputTokens;
  let maximum = 0;
  for (const endpoint of snapshot.endpoints) {
    const boundaries = new Set([
      maximumInput,
      ...endpoint.tiers.flatMap((tier) =>
        tier.minPromptTokens > 0 && tier.minPromptTokens <= maximumInput
          ? [tier.minPromptTokens - 1, tier.minPromptTokens]
          : [],
      ),
    ]);
    for (const tokens of boundaries)
      for (const tier of admissibleTiers(endpoint, tokens)) {
        if (bound.images && tier.imagePerImageUsd === null && bound.imageInputTokens === 0)
          throw new Error("Image charge lacks a token or per-image bound");
        maximum = Math.max(
          maximum,
          tokens *
            Math.max(
              tier.inputPerTokenUsd,
              tier.cacheReadPerTokenUsd ?? 0,
              tier.cacheWritePerTokenUsd ?? 0,
            ) +
            bound.outputTokens * tier.outputPerTokenUsd +
            bound.images * (tier.imagePerImageUsd ?? 0) +
            tier.requestUsd,
        );
      }
  }
  return maximum;
}

/**
 * Provider max_price uses USD per million tokens and USD per request/image. It is the highest
 * price of the set, so OpenRouter skips an endpoint that raised its price after the preview.
 */
export function routePriceLimit(snapshot: ModelSnapshot): {
  prompt: number;
  completion: number;
  request: number;
  image?: number;
} {
  const tiers = snapshot.endpoints.flatMap((endpoint) => endpoint.tiers);
  if (tiers.length === 0) throw new Error("Selected endpoint has no price tiers");
  const images = tiers.map((tier) => tier.imagePerImageUsd);
  const upward = (value: number) => Math.ceil(value * 1_000_000_000) / 1_000_000_000;
  return {
    prompt: upward(Math.max(...tiers.map((tier) => tier.inputPerTokenUsd)) * 1_000_000),
    completion: upward(Math.max(...tiers.map((tier) => tier.outputPerTokenUsd)) * 1_000_000),
    request: upward(Math.max(...tiers.map((tier) => tier.requestUsd))),
    ...(images.every((price): price is number => price !== null)
      ? { image: upward(Math.max(...images)) }
      : {}),
  };
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Invalid provider " + label);
  return [...value];
}

/** Refuse a snapshot whose endpoints cannot all accept the work of the requirement. */
function assertRequirementFits(snapshot: ModelSnapshot, requirement: ModelRequirement): void {
  const limits = modelLimits(snapshot);
  const fits = (usage: { inputTokens: number; outputTokens: number; imageInputTokens: number }) =>
    usage.outputTokens <= limits.maxOutputTokens &&
    usage.inputTokens + usage.imageInputTokens + usage.outputTokens <= limits.contextLength &&
    usage.inputTokens + usage.imageInputTokens <= (limits.maxPromptTokens ?? Infinity);
  if (requirement.workload && !fits(requirement.workload))
    throw new Error("The context limit or the output limit is too small for the selected work");
  const imageLimit = Math.min(
    ...snapshot.endpoints.map((endpoint) => imageRequestLimits(snapshot.id, endpoint).maxImages),
  );
  const imageLimitError = () =>
    new Error(`The endpoint accepts at most ${imageLimit} images in one request`);
  if (Math.max(requirement.imagesPerRequest ?? 0, requirement.workload?.images ?? 0) > imageLimit)
    throw imageLimitError();
  // Invoke the same bounded request calculation used for the displayed quote.
  // It rejects output/context/image combinations before an endpoint is selected.
  if (requirement.quoteWorkload)
    for (const work of requirement.quoteWorkload(snapshot)) {
      if (!Number.isSafeInteger(work.calls) || work.calls < 0 || !fits(work.usage))
        throw new Error(
          "The context limit or the output limit is too small for the requests of this work",
        );
      if (work.calls > 0 && work.usage.images > imageLimit) throw imageLimitError();
      priceForUsage(snapshot, work.usage);
    }
}

/**
 * Freeze the endpoints of one model that can do the work in one service tier. OpenRouter picks
 * the endpoint of each request with its default routing. The snapshot gives the highest price and
 * the smallest limits of these endpoints, so each request reserves its full cost and fits them.
 */
export function selectModelSnapshot(
  catalogEntry: unknown,
  endpointResponse: unknown,
  requirement: ModelRequirement,
  capturedAt: string,
): ModelSnapshot {
  const model = record(catalogEntry, "model");
  if (typeof model.id !== "string" || !MODEL_ID_PATTERN.test(model.id))
    throw new Error("Invalid provider model identity");
  if (typeof model.canonical_slug !== "string" || !model.canonical_slug)
    throw new Error("Provider did not identify the exact model revision");
  const entry = {
    id: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id,
  };
  const modalities = strings(
    record(model.architecture, "architecture").input_modalities,
    "modalities",
  );
  if (requirement.images && !modalities.includes("image"))
    throw new Error(`${entry.name} cannot read images. Select a different model.`);
  const base = {
    id: entry.id,
    name: entry.name,
    revision: model.canonical_slug as string,
    capturedAt,
    inputModalities: modalities,
    reasoning: reasoningCapabilities(model.reasoning),
    recommendedSampling: catalogRecommendedSampling(model.default_parameters),
  };
  const snapshotOf = (endpoints: EndpointSnapshot[]): ModelSnapshot => {
    const body = { ...base, endpoints };
    return { ...body, hash: hashJson(body) };
  };
  const listed = record(
    record(endpointResponse, "endpoint response").data,
    "endpoint data",
  ).endpoints;
  if (!Array.isArray(listed)) throw new Error("Invalid provider endpoint list");
  // The status is not a filter. It changes between unavailable and available within seconds,
  // and OpenRouter does not send a request to an endpoint that it measures as unavailable.
  const eligible = listed
    .map((value) => record(value, "endpoint"))
    .filter((endpoint) => {
      const parameters = endpoint.supported_parameters;
      return (
        endpoint.model_id === entry.id &&
        typeof endpoint.tag === "string" &&
        Array.isArray(parameters) &&
        (!requirement.tools || parameters.includes("tools")) &&
        (!requirement.structuredOutputs ||
          parameters.includes("structured_outputs") ||
          parameters.includes("response_format"))
      );
    });
  if (eligible.length === 0)
    throw new Error(
      `No endpoint of ${entry.name} has the capabilities that this work needs. Select a different model.`,
    );
  const rejected: string[] = [];
  const capable = eligible.flatMap((value) => {
    try {
      const endpoint: EndpointSnapshot = {
        tag: value.tag as string,
        provider: String(value.provider_name ?? "unknown"),
        quantization: String(value.quantization ?? "unknown"),
        contextLength: nonnegative(value.context_length, "context length"),
        maxPromptTokens:
          value.max_prompt_tokens == null
            ? null
            : nonnegative(value.max_prompt_tokens, "prompt limit"),
        rawPricing: structuredClone(record(value.pricing, "pricing")),
        maxOutputTokens: nonnegative(value.max_completion_tokens, "output limit"),
        supportedParameters: strings(value.supported_parameters, "parameters"),
        tiers: parsePriceTiers(value.pricing),
      };
      assertRequirementFits(snapshotOf([endpoint]), requirement);
      return [endpoint];
    } catch (error) {
      rejected.push(
        `${String(value.tag)}: ${error instanceof Error ? error.message : "invalid metadata"}`,
      );
      return [];
    }
  });
  // Flex runs only when a person selects it. OpenRouter uses priority endpoints only on request.
  const tiers: Array<ModelRoute["serviceTier"]> = requirement.allowFlex
    ? ["flex", "default", "priority"]
    : ["default", "priority"];
  const tier = tiers.find((item) => capable.some((endpoint) => serviceTier(endpoint.tag) === item));
  if (!tier)
    throw new Error(
      `Basalt cannot use or price an endpoint of ${entry.name}. Select a different model. Endpoint problems: ${rejected.join("; ") || "none in the selected service tier"}.`,
    );
  const snapshot = snapshotOf(
    capable
      .filter((endpoint) => serviceTier(endpoint.tag) === tier)
      .sort((a, b) => compareCodeUnits(a.tag, b.tag)),
  );
  assertRequirementFits(snapshot, requirement);
  return snapshot;
}

/** Read one public OpenRouter metadata document. A failure names the read and sends no model request. */
async function readPublicMetadata(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  modelId: string | null = null,
): Promise<unknown> {
  const fault = (causeCode: string, detail: string) =>
    new ExecutionFault({
      causeCode,
      category: "provider",
      dependency: hashJson({ source: "provider_model_metadata", modelId }),
      unit: { stage: "model_catalog", id: modelId ?? "catalog" },
      evidenceRefs: [],
      recoveryActions: ["resume"],
      explanation:
        "Basalt could not read " +
        label +
        " (" +
        detail +
        "). Basalt sent no model request. Try again. If a run stopped, select Resume.",
    });
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store" });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    const safeCodes = new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ECONNREFUSED",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ]);
    throw fault(
      "provider_catalog_transport",
      typeof code === "string" && safeCodes.has(code)
        ? "connection interrupted; " + code
        : "connection interrupted",
    );
  }
  if (!response.ok) throw fault("provider_catalog_http", "HTTP " + response.status);
  try {
    return await response.json();
  } catch {
    throw fault("provider_catalog_response", "unreadable response");
  }
}

/** One model of the public OpenRouter catalog, as a person sees it before adding it. */
export interface CatalogModel {
  id: string;
  name: string;
  inputModalities: string[];
  /** Basalt needs tool calls from builders and judges. */
  tools: boolean;
  contextLength: number | null;
  promptPerMillionUsd: number | null;
  completionPerMillionUsd: number | null;
}

/** The public OpenRouter catalog. It needs no credential and sends no model request. */
export async function fetchModelCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogModel[]> {
  const catalog = record(
    await readPublicMetadata(
      fetchImpl,
      "https://openrouter.ai/api/v1/models",
      "the model catalog of the provider",
    ),
    "catalog",
  );
  if (!Array.isArray(catalog.data)) throw new Error("Invalid provider catalog");
  const price = (value: unknown) => {
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    // Twelve digits remove the binary rest of the decimal price, for example 0.19999999999999998.
    return Number.isFinite(parsed) && parsed >= 0
      ? Number((parsed * 1_000_000).toPrecision(12))
      : null;
  };
  return catalog.data.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const model = value as RecordValue;
    if (typeof model.id !== "string" || !MODEL_ID_PATTERN.test(model.id)) return [];
    const architecture = (model.architecture ?? {}) as RecordValue;
    const pricing = (model.pricing ?? {}) as RecordValue;
    const modalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
      : [];
    return [
      {
        id: model.id,
        name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id,
        inputModalities: modalities,
        tools:
          Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools"),
        contextLength:
          typeof model.context_length === "number" && model.context_length > 0
            ? model.context_length
            : null,
        promptPerMillionUsd: price(pricing.prompt),
        completionPerMillionUsd: price(pricing.completion),
      },
    ];
  });
}

export async function fetchModelSnapshots(
  selections: ReadonlyArray<{ id: string; requirement: ModelRequirement }>,
  fetchImpl: typeof fetch = fetch,
  capturedAt = new Date().toISOString(),
): Promise<ModelSnapshot[]> {
  if (selections.length === 0) return [];
  if (new Set(selections.map((item) => item.id)).size !== selections.length)
    throw new Error("Select each model only one time");
  if (selections.some((item) => !MODEL_ID_PATTERN.test(item.id)))
    throw new Error("A selected model has an invalid OpenRouter model ID");
  // Independent public metadata reads: keep prices fresh without serial network round trips.
  const [catalogResponse, ...endpoints] = await Promise.all([
    readPublicMetadata(
      fetchImpl,
      "https://openrouter.ai/api/v1/models",
      "the model catalog of the provider",
    ),
    ...selections.map(({ id }) =>
      readPublicMetadata(
        fetchImpl,
        "https://openrouter.ai/api/v1/models/" + id + "/endpoints",
        "the endpoint list of the provider for " + id,
        id,
      ),
    ),
  ]);
  const catalog = record(catalogResponse, "catalog");
  if (!Array.isArray(catalog.data)) throw new Error("Invalid provider catalog");
  const catalogEntries: unknown[] = catalog.data;
  return selections.map(({ id, requirement }, index) => {
    const model = catalogEntries.find((item) => record(item, "catalog entry").id === id);
    if (!model) throw new Error(`The provider no longer lists ${id}. Select a different model.`);
    return selectModelSnapshot(model, endpoints[index], requirement, capturedAt);
  });
}
