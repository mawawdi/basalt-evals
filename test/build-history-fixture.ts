import { testHarness } from "./builder-fixture.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAgent } from "../packages/agent-runtime/src/index.js";
import type { BoundedAgentCheckpoint } from "../packages/agent-runtime/src/checkpoint.js";
import {
  contentHash,
  hashJson,
  type AgentRun,
  type PublicTask,
  type Treatment,
} from "../packages/contracts/src/index.js";
import {
  modelTurnRequestHash,
  openRouterModelClientDescriptor,
  type ModelClient,
  type ModelToolCall,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/index.js";
import {
  buildHistory,
  type BuilderLedgerRequest,
  type BuilderMessage,
  type BuildHistoryInput,
} from "../packages/reporting/src/build-history.js";

const SEED_SOURCE = "--!strict\nlocal speed = 1\nreturn speed\n";
export const WRITTEN_SOURCE = "--!strict\nlocal speed = 16\nlocal jump = 50\nreturn speed\n";
export const SOURCE_PATH = "src/server/Mechanic.server.luau";
const PROJECT = '{"tree":{}}\n';

/** A model that answers with planned tool calls, one batch for each turn. */
class PlannedModel implements ModelClient {
  readonly descriptor = openRouterModelClientDescriptor(["fake/model-20260917"]);
  readonly requests: ModelTurnRequest[] = [];
  constructor(private readonly plan: Array<{ text: string; calls: ModelToolCall[] }>) {}
  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request);
    const turn = this.plan[this.requests.length - 1]!;
    const message = { role: "assistant" as const, content: turn.text, toolCalls: turn.calls };
    return {
      kind: "assistant",
      message,
      stopReason: "tool_calls",
      responseHash: hashJson(message),
      requestHash: modelTurnRequestHash(request, this.descriptor),
      usage: {
        inputTokens: 100 * this.requests.length,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
      responseFacts: {
        requestedModel: "fake/model-20260917",
        resolvedModel: "fake/model",
        servingProvider: "fake",
        requestedServiceTier: null,
        servingServiceTier: null,
        responseId: `response-${this.requests.length}`,
        latencyMs: 10 * this.requests.length,
        retryCount: 0,
        finishReason: "tool_calls",
        continuationHash: null,
        continuationBytes: null,
      },
    };
  }
}

function treatmentFor(task: PublicTask): Treatment {
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
      id: "fake/model-20260917",
      responseModelId: "fake/model",
      transport: "fake",
      revision: "fake/model-20260917",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        capturedAt: "2026-09-17T00:00:00.000Z",
      },
    },
    transportConfigurationHash: hashJson(openRouterModelClientDescriptor(["fake/model-20260917"])),
    harness: testHarness({ maxTurns: 6 }),
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

/**
 * Run a small build with a planned model: a write, a patch, a local check with a Luau error and
 * a finish. The result holds the final checkpoint and the input of its build history.
 */
export async function plannedBuild() {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-build-history-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), PROJECT);
    await writeFile(resolve(workspace, SOURCE_PATH), SEED_SOURCE);
    const task: PublicTask = {
      schema: "basalt-evals/task",
      slug: "build-history",
      title: "Build history",
      prompt: "Make the player faster.",
      seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
      roles: [],
      acceptance: ["The player is faster."],
      evidenceInstructions: [],
    };
    const treatment = treatmentFor(task);
    const model = new PlannedModel([
      {
        text: "I will raise the speed.",
        calls: [
          {
            id: "write-1",
            name: "workspace.write",
            arguments: {
              path: SOURCE_PATH,
              content: WRITTEN_SOURCE,
              expectedHash: contentHash(SEED_SOURCE),
            },
          },
        ],
      },
      {
        text: "",
        calls: [
          {
            id: "patch-1",
            name: "workspace.patch",
            arguments: {
              path: SOURCE_PATH,
              expectedHash: contentHash(WRITTEN_SOURCE),
              before: "local jump = 50\n",
              after: "local jump = 60\n",
            },
          },
          { id: "verify-1", name: "workspace.verify", arguments: {} },
        ],
      },
      {
        text: "Done.",
        calls: [{ id: "finish-1", name: "workspace.finish", arguments: { summary: "Faster." } }],
      },
    ]);
    const checkpoints: BoundedAgentCheckpoint[] = [];
    let checks = 0;
    const run: AgentRun = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: model,
      // The first local check reports a Luau error; the final check passes.
      verify: async () =>
        ++checks === 1
          ? {
              gate: "rejected",
              reasons: [`${SOURCE_PATH}:2: Type 'string' could not be converted into 'number'`],
              checks: [{ name: "luau_analyze", outcome: "fail" }],
            }
          : { gate: "eligible", reasons: [], checks: [{ name: "luau_analyze", outcome: "pass" }] },
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
      },
    });
    const final = checkpoints.at(-1)!;
    const requests: BuilderLedgerRequest[] = model.requests.map((request, index) => ({
      requestId: hashJson({ request: index }),
      ordinal: index + 1,
      requestHash: modelTurnRequestHash(request, model.descriptor),
      status: "billed",
      billedUsd: 0.001,
      latencyMs: 10 * (index + 1),
      inputTokens: 100 * (index + 1),
      outputTokens: 20,
      resultKind: "assistant",
    }));
    const input: BuildHistoryInput = {
      operationId: "run-build-history",
      subjectId: treatment.id,
      model: treatment.model.id,
      harness: treatment.harness.id,
      systemPrompt: treatment.harness.systemPrompt,
      checkpoint: {
        conversation: final.conversation as BuilderMessage[],
        trace: final.trace,
      },
      run: { status: run.status, stopReason: run.stopReason, files: run.candidate.files },
      start: {
        files: [
          { path: "default.project.json", hash: contentHash(PROJECT) },
          { path: SOURCE_PATH, hash: contentHash(SEED_SOURCE) },
        ],
        sources: { [SOURCE_PATH]: SEED_SOURCE },
      },
      requests,
    };
    return { run, final, input, history: buildHistory(input) };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
