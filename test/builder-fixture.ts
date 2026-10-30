import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  contentHash,
  hashJson,
  type HarnessDefinition,
  type PublicTask,
  type Treatment,
} from "../packages/contracts/src/index.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import {
  modelTurnRequestHash,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/openrouter-ai-sdk.js";

/** A small builder fixture: one public task, its treatment, a model snapshot and a workspace. */
export const FAKE_MODEL = "fake/model-20260917";
const SEED_SOURCE = "--!strict\n";

export const builderTask: PublicTask = {
  schema: "basalt-evals/task",
  slug: "builder-fixture",
  title: "Builder fixture",
  prompt: "Build the task.",
  seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
  roles: [],
  acceptance: ["It works."],
  evidenceInstructions: [],
};

export const builderDescriptor = openRouterModelClientDescriptor([FAKE_MODEL]);

/** Copy the operator configuration and the harness registry of this checkout into a root. */
export async function writeRunConfiguration(root: string): Promise<void> {
  await mkdir(resolve(root, "studies"), { recursive: true });
  await cp(resolve("studies/operator-config.json"), resolve(root, "studies/operator-config.json"));
  await cp(resolve("studies/harnesses"), resolve(root, "studies/harnesses"), { recursive: true });
}

/** A valid harness with local tools only: no Studio runs, no API notes and no compaction. */
export function testHarness(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  return {
    id: "test",
    title: "Test tools",
    systemPrompt: "Build the task.",
    promptTemplate: "{{stages}}{{task}}\n{{workspace}}",
    tools: [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "workspace.patch",
      "workspace.write",
      "workspace.verify",
      "workspace.finish",
    ],
    developmentRuns: 0,
    maxTurns: 3,
    reasoning: { kind: "catalog_balanced" },
    notesPack: null,
    compaction: { kind: "none" },
    ...overrides,
  };
}

/** A valid harness with one public Studio development run. */
export function studioHarness(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  const base = testHarness();
  return testHarness({
    promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{development}}",
    tools: [...base.tools, "development.run", "development.inspect"],
    developmentRuns: 1,
    ...overrides,
  });
}

/** The treatment identity of a changed treatment body. */
export function reidentify(treatment: Treatment): Treatment {
  const { schema: _schema, id: _id, ...body } = treatment;
  return { ...treatment, id: `tr-${hashJson(body).slice(0, 20)}` };
}

export function builderTreatment(task: PublicTask = builderTask): Treatment {
  const publicTaskHash = hashJson(task);
  const body: Omit<Treatment, "schema" | "id"> = {
    ordinal: 1,
    studyHash: "1".repeat(64),
    task: {
      id: `${task.slug}:${publicTaskHash.slice(0, 12)}`,
      publicTaskHash,
      evaluatorHash: "3".repeat(64),
      seedHash: "4".repeat(64),
      collectionPlanHash: "5".repeat(64),
    },
    model: {
      id: FAKE_MODEL,
      responseModelId: "fake/model",
      transport: "fake",
      revision: FAKE_MODEL,
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        capturedAt: "2026-09-17T00:00:00.000Z",
      },
    },
    transportConfigurationHash: hashJson(builderDescriptor),
    harness: testHarness(),
    repetition: 1,
    randomSeed: 1,
    environment: {
      platform: "Roblox Studio",
      studioVersion: "test",
      captureProtocol: "studio-mcp-viewport",
      cameraProtocol: "fixed",
    },
  };
  return { schema: "basalt-evals/treatment", id: `tr-${hashJson(body).slice(0, 20)}`, ...body };
}

export function builderSnapshot(): ModelSnapshot {
  return {
    id: FAKE_MODEL,
    name: "Fake model",
    revision: FAKE_MODEL,
    capturedAt: "2026-09-17T00:00:00.000Z",
    inputModalities: ["text"],
    reasoning: null,
    recommendedSampling: {
      temperature: null,
      top_p: null,
      top_k: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
    },
    endpoints: [
      {
        tag: "fake",
        provider: "fake",
        quantization: "unknown",
        contextLength: 1_000_000,
        maxPromptTokens: null,
        rawPricing: {},
        maxOutputTokens: 100_000,
        supportedParameters: ["tools"],
        tiers: [
          {
            minPromptTokens: 0,
            temporal: null,
            inputPerTokenUsd: 0.000001,
            outputPerTokenUsd: 0.000002,
            imagePerImageUsd: 0,
            requestUsd: 0,
            cacheReadPerTokenUsd: null,
            cacheWritePerTokenUsd: null,
          },
        ],
      },
    ],
    hash: hashJson("fake-model"),
  } as unknown as ModelSnapshot;
}

/** A workspace with the seed project and one Luau source. */
export async function builderWorkspace(): Promise<string> {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-builder-fixture-"));
  await mkdir(resolve(workspace, "src/server"), { recursive: true });
  await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
  await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), SEED_SOURCE);
  return workspace;
}

/** A provider failure without a generation ID and without a cost: a rejection at $0. */
export function providerRejection(
  request: ModelTurnRequest,
  status: number,
  providerErrorType: Extract<ModelTurnResult, { kind: "provider_error" }>["providerErrorType"],
): ModelTurnResult {
  return {
    kind: "provider_error",
    requestHash: modelTurnRequestHash(request, builderDescriptor),
    errorClass: `http_${status}`,
    providerErrorType,
    message: `OpenRouter request failed with HTTP ${status}.`,
    retryable: false,
    responseFacts: {
      requestedModel: request.model,
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
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    },
  };
}

/**
 * An assistant answer with a known cost. Without planned tool calls, the first answer writes the
 * source and each later answer calls `workspace.finish`.
 */
export function builderAnswer(
  request: ModelTurnRequest,
  turn: number,
  options: { stopReason?: "tool_calls" | "refusal"; toolCalls?: boolean } = {},
): ModelTurnResult {
  const toolCalls =
    options.toolCalls === false
      ? []
      : turn === 1
        ? [
            {
              id: `write-${turn}`,
              name: "workspace.write",
              arguments: {
                path: "src/server/Mechanic.server.luau",
                content: '--!strict\nprint("candidate")\n',
                expectedHash: contentHash(SEED_SOURCE),
              },
            },
          ]
        : [
            {
              id: `finish-${turn}`,
              name: "workspace.finish",
              arguments: { summary: "Implemented." },
            },
          ];
  const message = { role: "assistant" as const, content: "", toolCalls };
  return {
    kind: "assistant",
    message,
    stopReason: options.stopReason ?? "tool_calls",
    responseHash: hashJson(message),
    requestHash: modelTurnRequestHash(request, builderDescriptor),
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.00001,
    },
    responseFacts: {
      requestedModel: FAKE_MODEL,
      resolvedModel: "fake/model",
      servingProvider: "fake",
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId: `response-${turn}-${options.stopReason ?? "tool_calls"}`,
      latencyMs: 1,
      retryCount: 0,
      finishReason: options.stopReason ?? "tool_calls",
      continuationHash: null,
      continuationBytes: null,
    },
  };
}

/** A transport that answers each dispatch with the next scripted result. */
export function scriptedTransport(
  script: Array<(request: ModelTurnRequest) => ModelTurnResult>,
): ModelClient & { dispatches: number } {
  const transport = {
    descriptor: builderDescriptor,
    dispatches: 0,
    async complete(request: ModelTurnRequest) {
      const next = script[transport.dispatches];
      transport.dispatches += 1;
      if (!next) throw new Error("The scripted transport has no more answers");
      return next(request);
    },
  };
  return transport;
}

/** An assistant answer with the given text and tool calls, and a known cost. */
export function assistantAnswer(
  request: ModelTurnRequest,
  responseId: string,
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  content = "",
): ModelTurnResult {
  const message = { role: "assistant" as const, content, toolCalls };
  return {
    kind: "assistant",
    message,
    stopReason: "tool_calls",
    responseHash: hashJson(message),
    requestHash: modelTurnRequestHash(request, builderDescriptor),
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.00001,
    },
    responseFacts: {
      requestedModel: FAKE_MODEL,
      resolvedModel: "fake/model",
      servingProvider: "fake",
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId,
      latencyMs: 1,
      retryCount: 0,
      finishReason: "tool_calls",
      continuationHash: null,
      continuationBytes: null,
    },
  };
}
