import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addModel,
  assertRegisteredModels,
  buildMaker,
  defaultPreparationModel,
  readModelRegistry,
  removeModel,
  searchModelCatalog,
  setModelConcurrency,
  setModelDefaults,
} from "../packages/operator/src/model-registry.js";
import {
  assertLaunchModels,
  launchDefaults,
  launchSelection,
} from "../packages/operator/src/workflow.js";

const catalog: typeof fetch = async () =>
  Response.json({
    data: [
      {
        id: "qwen/qwen3-vl-plus",
        name: "Qwen3 VL Plus",
        canonical_slug: "qwen/qwen3-vl-plus-20260901",
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "temperature"],
        context_length: 262_144,
        pricing: { prompt: "0.0000002", completion: "0.0000016" },
      },
      {
        id: "xiaomi/mimo-v2.6-flash",
        name: "Xiaomi: MiMo 2.6 Flash",
        canonical_slug: "xiaomi/mimo-v2.6-flash-20260921",
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools"],
        context_length: 1_048_576,
        pricing: { prompt: "0.00000014", completion: "0.00000028" },
      },
      {
        id: "example/no-tools",
        name: "Example without tools",
        canonical_slug: "example/no-tools",
        architecture: { input_modalities: ["text"] },
        supported_parameters: ["temperature"],
        context_length: 8192,
        pricing: { prompt: "0", completion: "0" },
      },
    ],
  });

async function workspace<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "basalt-model-registry-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a person searches the OpenRouter catalog and adds a model with tool calls", () =>
  workspace(async (root) => {
    assert.deepEqual(await readModelRegistry(root), {
      models: [],
      defaults: {
        builderModelIds: [],
        gradingModelId: null,
        preparationModelId: null,
        coverageModelId: null,
      },
    });
    const found = await searchModelCatalog(root, "QWEN vl", catalog);
    assert.deepEqual(
      found.map((model) => [model.id, model.tools, model.added]),
      [["qwen/qwen3-vl-plus", true, false]],
    );
    assert.equal(found[0]!.promptPerMillionUsd, 0.2);
    const registry = await addModel(root, "qwen/qwen3-vl-plus", catalog, new Date(0));
    assert.deepEqual(registry.models, [
      {
        id: "qwen/qwen3-vl-plus",
        name: "Qwen3 VL Plus",
        inputModalities: ["text", "image"],
        addedAt: "1970-01-01T00:00:00.000Z",
        maxConcurrentRequests: 4,
      },
    ]);
    assert.equal((await searchModelCatalog(root, "qwen", catalog))[0]!.added, true);
    await assert.rejects(addModel(root, "example/no-tools", catalog), /does not accept tool calls/);
    await assert.rejects(addModel(root, "example/absent", catalog), /does not list/);
    await assert.rejects(addModel(root, "not an id", catalog), /OpenRouter model ID/);
  }));

test("defaults name only added models, and a removed model leaves the defaults", () =>
  workspace(async (root) => {
    await addModel(root, "qwen/qwen3-vl-plus", catalog);
    await addModel(root, "xiaomi/mimo-v2.6-flash", catalog);
    await assert.rejects(
      setModelDefaults(root, {
        builderModelIds: ["openai/gpt-6-luna"],
        gradingModelId: null,
        preparationModelId: null,
        coverageModelId: null,
      }),
      /Add openai\/gpt-6-luna on the Models page/,
    );
    const saved = await setModelDefaults(root, {
      builderModelIds: ["qwen/qwen3-vl-plus"],
      gradingModelId: "xiaomi/mimo-v2.6-flash",
      preparationModelId: "qwen/qwen3-vl-plus",
      coverageModelId: "xiaomi/mimo-v2.6-flash",
    });
    assert.equal(defaultPreparationModel(saved), "qwen/qwen3-vl-plus");
    const selection = launchSelection({
      ...launchDefaults(saved, { defaultHarnessId: "production" }),
      sources: [{ kind: "draft", id: "a".repeat(64) }],
    });
    assert.doesNotThrow(() => assertLaunchModels(selection, saved));
    const removed = await removeModel(root, "qwen/qwen3-vl-plus");
    assert.deepEqual(removed.defaults, {
      builderModelIds: [],
      gradingModelId: "xiaomi/mimo-v2.6-flash",
      preparationModelId: null,
      coverageModelId: "xiaomi/mimo-v2.6-flash",
    });
    // A saved selection keeps its models, but a new preview refuses a removed model.
    assert.throws(() => assertLaunchModels(selection, removed), /Add qwen\/qwen3-vl-plus/);
    assert.throws(() => defaultPreparationModel(removed), /Select a preparation model/);
    assert.throws(
      () =>
        launchSelection({
          ...launchDefaults(saved, { defaultHarnessId: "production" }),
          gradingModelId: null,
          sources: [{ kind: "evaluation", id: "b".repeat(64) }],
        }),
      /Select a judge model/,
    );
    assert.throws(
      () => assertRegisteredModels(removed, ["a/b", "c/d"]),
      /Add a\/b, c\/d on the Models page before you use them/,
    );
  }));

test("a person sets the requests at once of an added model, and the defaults keep their keys", () =>
  workspace(async (root) => {
    await addModel(root, "qwen/qwen3-vl-plus", catalog);
    await addModel(root, "xiaomi/mimo-v2.6-flash", catalog);
    const saved = await setModelConcurrency(root, {
      id: "qwen/qwen3-vl-plus",
      maxConcurrentRequests: 16,
    });
    assert.deepEqual(
      saved.models.map((model) => [model.id, model.maxConcurrentRequests]),
      [
        ["qwen/qwen3-vl-plus", 16],
        ["xiaomi/mimo-v2.6-flash", 4],
      ],
    );
    assert.deepEqual(await readModelRegistry(root), saved);
    for (const maxConcurrentRequests of [0, 17, 2.5, "2", null])
      await assert.rejects(
        setModelConcurrency(root, { id: "qwen/qwen3-vl-plus", maxConcurrentRequests }),
        /Choose a whole number of requests at once from 1 to 16/,
      );
    await assert.rejects(
      setModelConcurrency(root, { id: "qwen/qwen3-vl-plus", maxConcurrentRequests: 2, extra: 1 }),
      /Send the model ID and the number of requests at once/,
    );
    await assert.rejects(
      setModelConcurrency(root, { id: "openai/gpt-6-luna", maxConcurrentRequests: 2 }),
      /Add openai\/gpt-6-luna on the Models page/,
    );
    // The defaults route accepts only the four roles, not a request concurrency.
    await assert.rejects(
      setModelDefaults(root, {
        builderModelIds: [],
        gradingModelId: null,
        preparationModelId: null,
        coverageModelId: null,
        maxConcurrentRequests: 2,
      }),
      /Send the builder models, the judge model, the preparation model and the coverage model/,
    );
    assert.equal((await readModelRegistry(root)).models[0]!.maxConcurrentRequests, 16);
  }));

test("a build without a model reads as a saved build or a reference build, never as its kind", () => {
  const models = [{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" }];
  const builder = { model: { id: "openai/gpt-6-luna" } } as Parameters<
    typeof buildMaker
  >[1]["builder"];
  assert.equal(buildMaker(models, { kind: "generated", builder }), "OpenAI: GPT-6 Luna");
  assert.equal(buildMaker(models, { kind: "retained", builder: null }), "Saved build");
  assert.equal(buildMaker(models, { kind: "control", builder: null }), "Reference build");
});
