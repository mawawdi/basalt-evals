import { OperationJournal } from "../../artifact-store/src/journal.js";
import { isModelConcurrency, MODEL_CONCURRENCY } from "../../contracts/src/execution-limits.js";
import type { RunOperationManifest, RunSubject } from "../../contracts/src/execution.js";
import {
  fetchModelCatalog,
  MODEL_ID_PATTERN,
  type CatalogModel,
} from "../../model-client/src/catalog.js";

/** A model that a person added from the OpenRouter catalog. */
export interface RegisteredModel {
  id: string;
  name: string;
  inputModalities: string[];
  addedAt: string;
  /** The most requests of this model that one run sends at the same time. */
  maxConcurrentRequests: number;
}

/** The roles that a new launch uses until a person selects other models. */
interface ModelDefaults {
  builderModelIds: string[];
  gradingModelId: string | null;
  preparationModelId: string | null;
  /** Optional. It writes coverage notes about each prepared draft. */
  coverageModelId: string | null;
}

export interface ModelRegistry {
  models: RegisteredModel[];
  defaults: ModelDefaults;
}

const NAMESPACE = "settings";
const IDENTITY = "model-registry";
const EMPTY: ModelRegistry = {
  models: [],
  defaults: {
    builderModelIds: [],
    gradingModelId: null,
    preparationModelId: null,
    coverageModelId: null,
  },
};

async function withJournal<T>(root: string, action: (journal: OperationJournal) => T): Promise<T> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => action(journal));
  } finally {
    journal.close();
  }
}

/** The registry inside an open journal transaction. */
export function storedModelRegistry(journal: OperationJournal): ModelRegistry {
  return journal.read<ModelRegistry>(NAMESPACE, IDENTITY) ?? structuredClone(EMPTY);
}

/** The models that a person added, in the sequence of addition, and their default roles. */
export async function readModelRegistry(root: string): Promise<ModelRegistry> {
  return withJournal(root, storedModelRegistry);
}

/** Refuse a model that a person did not add. A frozen run keeps its own model snapshots. */
export function assertRegisteredModels(registry: ModelRegistry, ids: readonly string[]): void {
  const missing = ids.filter((id) => !registry.models.some((model) => model.id === id));
  if (missing.length)
    throw new Error(
      `Add ${missing.join(", ")} on the Models page before you use ${missing.length === 1 ? "it" : "them"}.`,
    );
}

/** The name that a person sees. A model that a person removed keeps its ID. */
export function registeredModelName(registry: ModelRegistry, id: string): string {
  return registry.models.find((model) => model.id === id)?.name ?? id;
}

/** The name in a frozen run. It stays the same after a person removes the model. */
export function frozenModelName(
  models: ReadonlyArray<{ id: string; name: string }>,
  id: string,
): string {
  return models.find((model) => model.id === id)?.name ?? id;
}

/**
 * Who made a build, in console words: its model, or what the build is when no model made it.
 * A person supplied a reference build. A saved build comes from an earlier run.
 */
export function buildMaker(
  models: ReadonlyArray<{ id: string; name: string }>,
  subject: Pick<RunSubject, "builder" | "kind">,
): string {
  if (subject.builder) return frozenModelName(models, subject.builder.model.id);
  return subject.kind === "control" ? "Reference build" : "Saved build";
}

/** "Build 2": the place of a build in the plan of its run, from 1. */
export function buildName(manifest: Pick<RunOperationManifest, "subjects">, subjectId: string) {
  return `Build ${manifest.subjects.findIndex((subject) => subject.id === subjectId) + 1}`;
}

/** "GPT-6 Luna · Build 2": the maker of a build and its name in its run. */
export function buildTitle(
  manifest: Pick<RunOperationManifest, "subjects" | "modelSnapshots">,
  subject: Pick<RunSubject, "id" | "builder" | "kind">,
) {
  return `${buildMaker(manifest.modelSnapshots, subject)} · ${buildName(manifest, subject.id)}`;
}

/** The preparation model of the defaults. Preparation and reference tests use it. */
export function defaultPreparationModel(registry: ModelRegistry): string {
  const id = registry.defaults.preparationModelId;
  if (!id) throw new Error("Select a preparation model on the Models page.");
  assertRegisteredModels(registry, [id]);
  return id;
}

/** Search the public OpenRouter catalog by ID or name. It sends no model request. */
export async function searchModelCatalog(
  root: string,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<CatalogModel & { added: boolean }>> {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const [catalog, registry] = await Promise.all([
    fetchModelCatalog(fetchImpl),
    readModelRegistry(root),
  ]);
  return catalog
    .filter((model) => {
      const text = `${model.id} ${model.name}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 50)
    .map((model) => ({
      ...model,
      added: registry.models.some((item) => item.id === model.id),
    }));
}

/** Add a model of the OpenRouter catalog. Basalt needs tool calls from each model. */
export async function addModel(
  root: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<ModelRegistry> {
  if (!MODEL_ID_PATTERN.test(id))
    throw new Error("Enter an OpenRouter model ID, for example vendor/model.");
  const catalog = await fetchModelCatalog(fetchImpl);
  const model = catalog.find((item) => item.id === id);
  if (!model) throw new Error(`OpenRouter does not list ${id}. Search for the model again.`);
  if (!model.tools)
    throw new Error(
      `${model.name} does not accept tool calls. Basalt needs tool calls from builders and judges.`,
    );
  return withJournal(root, (journal) => {
    const registry = storedModelRegistry(journal);
    if (!registry.models.some((item) => item.id === id))
      registry.models.push({
        id,
        name: model.name,
        inputModalities: model.inputModalities,
        addedAt: now.toISOString(),
        maxConcurrentRequests: MODEL_CONCURRENCY.default,
      });
    journal.put(NAMESPACE, IDENTITY, registry);
    return registry;
  });
}

/** Remove a model from new launches. Runs that used it keep their frozen snapshots. */
export async function removeModel(root: string, id: string): Promise<ModelRegistry> {
  return withJournal(root, (journal) => {
    const registry = storedModelRegistry(journal);
    registry.models = registry.models.filter((model) => model.id !== id);
    registry.defaults = {
      builderModelIds: registry.defaults.builderModelIds.filter((item) => item !== id),
      gradingModelId:
        registry.defaults.gradingModelId === id ? null : registry.defaults.gradingModelId,
      preparationModelId:
        registry.defaults.preparationModelId === id ? null : registry.defaults.preparationModelId,
      coverageModelId:
        registry.defaults.coverageModelId === id ? null : registry.defaults.coverageModelId,
    };
    journal.put(NAMESPACE, IDENTITY, registry);
    return registry;
  });
}

/** Save the default roles. Each default must be a model that a person added. */
export async function setModelDefaults(root: string, value: unknown): Promise<ModelRegistry> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "builderModelIds,coverageModelId,gradingModelId,preparationModelId"
  )
    throw new Error(
      "Send the builder models, the judge model, the preparation model and the coverage model.",
    );
  const defaults = value as ModelDefaults;
  const optional = (id: unknown) => id === null || typeof id === "string";
  if (
    !Array.isArray(defaults.builderModelIds) ||
    defaults.builderModelIds.some((id) => typeof id !== "string") ||
    new Set(defaults.builderModelIds).size !== defaults.builderModelIds.length ||
    !optional(defaults.gradingModelId) ||
    !optional(defaults.preparationModelId) ||
    !optional(defaults.coverageModelId)
  )
    throw new Error(
      "Select each builder model one time. Select one model or no model for each other role.",
    );
  return withJournal(root, (journal) => {
    const registry = storedModelRegistry(journal);
    assertRegisteredModels(registry, [
      ...defaults.builderModelIds,
      ...(defaults.gradingModelId ? [defaults.gradingModelId] : []),
      ...(defaults.preparationModelId ? [defaults.preparationModelId] : []),
      ...(defaults.coverageModelId ? [defaults.coverageModelId] : []),
    ]);
    registry.defaults = {
      builderModelIds: [...defaults.builderModelIds],
      gradingModelId: defaults.gradingModelId,
      preparationModelId: defaults.preparationModelId,
      coverageModelId: defaults.coverageModelId,
    };
    journal.put(NAMESPACE, IDENTITY, registry);
    return registry;
  });
}

/**
 * Save the most requests that one run sends to a model at the same time. A run freezes the
 * value when it starts, so a change applies only to later runs.
 */
export async function setModelConcurrency(root: string, value: unknown): Promise<ModelRegistry> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "id,maxConcurrentRequests"
  )
    throw new Error("Send the model ID and the number of requests at once.");
  const { id, maxConcurrentRequests } = value as { id: unknown; maxConcurrentRequests: unknown };
  if (typeof id !== "string" || !isModelConcurrency(maxConcurrentRequests))
    throw new Error(
      `Choose a whole number of requests at once from ${MODEL_CONCURRENCY.minimum} to ${MODEL_CONCURRENCY.maximum}.`,
    );
  return withJournal(root, (journal) => {
    const registry = storedModelRegistry(journal);
    assertRegisteredModels(registry, [id]);
    registry.models = registry.models.map((model) =>
      model.id === id ? { ...model, maxConcurrentRequests } : model,
    );
    journal.put(NAMESPACE, IDENTITY, registry);
    return registry;
  });
}

/**
 * The request concurrency of each model of a new run, read from the Models page. A model that a
 * person removed after the preview gets the default. The frozen run keeps these values.
 */
export async function frozenModelConcurrency(
  root: string,
  models: ReadonlyArray<{ id: string }>,
): Promise<Record<string, number>> {
  const registry = await readModelRegistry(root);
  return Object.fromEntries(
    [...new Set(models.map((model) => model.id))]
      .sort()
      .map((id) => [
        id,
        registry.models.find((model) => model.id === id)?.maxConcurrentRequests ??
          MODEL_CONCURRENCY.default,
      ]),
  );
}
