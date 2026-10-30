import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  AgentInterrupted,
  DevelopmentCandidateError,
  AgentBudgetPaused,
  builderPrompt,
  MAX_TOOL_RESULT_BYTES,
  runAgent,
  type LocalVerification,
} from "../packages/agent-runtime/src/index.js";
import type { BoundedAgentCheckpoint } from "../packages/agent-runtime/src/checkpoint.js";
import { parseToolCall } from "../packages/agent-runtime/src/tools.js";
import {
  contentHash,
  hashJson,
  stableJson,
  type PublicTask,
  type Treatment,
} from "../packages/contracts/src/index.js";
import {
  openRouterModelClientDescriptor,
  modelTurnRequestHash,
  type ModelClient,
  type ModelSnapshot,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ModelToolCall,
  BoundedModelClient,
  DurableSpendLedger,
  SpendingCeilingError,
  ModelRequestAdmissionError,
} from "../packages/model-client/src/index.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import {
  builderAnswer,
  builderSnapshot,
  builderTask,
  builderTreatment,
  builderWorkspace,
  providerRejection,
  scriptedTransport,
  studioHarness,
  testHarness,
} from "./builder-fixture.js";
import { discoverTaskDirectories } from "../packages/task-registry/src/index.js";

test("public builder instructions preserve each role's authored cardinality", () => {
  const task: PublicTask = {
    schema: "basalt-evals/task",
    slug: "optional-binding",
    title: "Optional marker",
    prompt: "Build a scene.",
    seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
    acceptance: [],
    evidenceInstructions: [],
    roles: [
      {
        id: "marker",
        className: "BasePart",
        scope: "workspace",
        cardinality: "zero_or_one",
      },
    ],
  };
  const prompt = builderPrompt(task, testHarness());
  assert.match(prompt, /cardinality zero or one/u);
  assert.doesNotMatch(prompt, /exactly one/u);
});

test("a pre-dispatch spending stop is retained without a phantom provider call", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-spending-stop-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), "--!strict\n");
    const task: PublicTask = {
      schema: "basalt-evals/task",
      slug: "spending-stop",
      title: "Spending stop",
      prompt: "Build the task.",
      seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
      roles: [],
      acceptance: ["It works."],
      evidenceInstructions: [],
    };
    const model = new FakeModelClient(contentHash("--!strict\n"));
    model.complete = async () => {
      throw new SpendingCeilingError();
    };
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: model,
      verify: async () => ({ gate: "rejected", reasons: ["Seed is incomplete"], checks: [] }),
    });
    assert.equal(run.stopReason, "spending_limit");
    assert.equal(run.failure?.classification, "budget_or_stop_failure");
    assert.equal(run.usage.calls, 0);
    assert.equal(run.status, "incomplete");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a builder resume after a rate limit starts again at the first try of its turn", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-rate-limit-resume-"));
  const root = await mkdtemp(resolve(tmpdir(), "basalt-evals-rate-limit-ledger-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), "--!strict\n");
    const task: PublicTask = {
      schema: "basalt-evals/task",
      slug: "rate-limit-resume",
      title: "Rate limit resume",
      prompt: "Build the task.",
      seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
      roles: [],
      acceptance: ["It works."],
      evidenceInstructions: [],
    };
    const treatment = treatmentFor(task);
    const fake = new FakeModelClient(contentHash("--!strict\n"));
    let dispatches = 0;
    // The first dispatch of each turn is a rate limit. The second gets the planned answer.
    const transport: ModelClient = {
      descriptor: fake.descriptor,
      async complete(request) {
        dispatches += 1;
        if (dispatches % 2 === 1)
          return {
            kind: "provider_error",
            requestHash: modelTurnRequestHash(request, fake.descriptor),
            errorClass: "http_429",
            providerErrorType: null,
            message: "OpenRouter request failed with HTTP 429.",
            retryable: true,
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
        const answer = await fake.complete(request);
        return { ...answer, usage: { ...answer.usage, costUsd: 0.00001 } };
      },
    };
    const snapshot = {
      id: "fake/model-20260917",
      name: "Fake model",
      revision: "fake/model-20260917",
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
    const ledger = new DurableSpendLedger(root, "builder-rate-limit", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const waits: number[] = [];
    // The builder stage saves the ordinals of the finished calls with each checkpoint.
    let saved: { state: BoundedAgentCheckpoint; completedCalls: number } | null = null;
    const attempt = (completedCalls: number, stopAtTurn: number | null) => {
      const bounded = new BoundedModelClient(
        transport,
        ledger,
        [snapshot],
        "builder:rate-limit",
        false,
        undefined,
        completedCalls,
      );
      bounded.pause = async (milliseconds) => {
        waits.push(milliseconds);
        if (stopAtTurn === 1) throw new Error("The operator stopped the run");
      };
      const resume = saved?.state;
      return runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: bounded,
        verify: eligibleVerification,
        retainInterruption: true,
        ...(resume ? { resume } : {}),
        checkpoint: async (state) => {
          saved = { state: structuredClone(state), completedCalls: bounded.completedCalls };
          if (state.point === "before_model" && state.turn === stopAtTurn && stopAtTurn !== 1)
            throw new AgentInterrupted();
        },
      });
    };
    const latest = () => {
      assert.ok(saved);
      return saved;
    };

    // Stop during the wait after the first rate limit. The turn did not finish.
    await assert.rejects(attempt(0, 1), AgentInterrupted);
    assert.equal(latest().completedCalls, 0);
    // The resume replays the rejection, waits again and sends the second try.
    await assert.rejects(attempt(latest().completedCalls, 2), AgentInterrupted);
    assert.equal(latest().state.turn, 2);
    assert.equal(latest().state.usage.calls, 1);
    assert.equal(latest().completedCalls, 2, "The first turn used two request ordinals");
    const run = await attempt(latest().completedCalls, null);
    assert.equal(run.status, "locally_eligible");
    assert.equal(run.usage.calls, 2);
    assert.equal(dispatches, 4);
    assert.deepEqual(waits, [20_000, 20_000, 20_000]);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => [entry.stage, entry.billedUsd]),
      [
        ["builder:rate-limit", 0],
        ["builder:rate-limit", 0.00001],
        ["builder:rate-limit", 0],
        ["builder:rate-limit", 0.00001],
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a content-filter stop without tool calls ends the build as a refusal", async () => {
  const workspace = await builderWorkspace();
  try {
    const transport = scriptedTransport([
      (request) => builderAnswer(request, 1, { stopReason: "refusal", toolCalls: false }),
    ]);
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: builderTreatment(),
      modelClient: transport,
      verify: eligibleVerification,
      retainInterruption: true,
    });
    assert.equal(run.stopReason, "refusal");
    assert.equal(run.status, "incomplete");
    assert.equal(run.failure?.classification, "model_refusal");
    assert.equal(run.usage.calls, 1);
    assert.equal(transport.dispatches, 1, "Basalt does not send a refused request again");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an HTTP refusal ends the build as a refusal at zero charge", async () => {
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-evals-refusal-ledger-"));
  try {
    const ledger = new DurableSpendLedger(root, "builder-refusal", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    // A moderation 403 is a request failure with the refusal mark, not an account failure.
    const transport = scriptedTransport([
      (request) => providerRejection(request, 403, "content_policy_violation"),
    ]);
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: builderTreatment(),
      modelClient: new BoundedModelClient(
        transport,
        ledger,
        [builderSnapshot()],
        "builder:refusal",
      ),
      verify: eligibleVerification,
      retainInterruption: true,
    });
    assert.equal(run.stopReason, "refusal");
    assert.equal(run.status, "incomplete");
    assert.equal(run.failure?.classification, "model_refusal");
    assert.equal(run.usage.calls, 1);
    assert.equal(transport.dispatches, 1);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => [entry.status, entry.billedUsd]),
      [["billed", 0]],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

class FakeModelClient implements ModelClient {
  readonly descriptor = openRouterModelClientDescriptor(["fake/model-20260917"]);
  readonly requests: ModelTurnRequest[] = [];
  private turn = 0;
  constructor(
    private readonly originalHash: string,
    private readonly plannedTools?: ModelToolCall[][],
  ) {}

  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request);
    this.turn += 1;
    const toolCalls = this.plannedTools
      ? this.plannedTools[this.turn - 1]!
      : this.turn === 1
        ? [
            {
              id: "write-1",
              name: "workspace.write",
              arguments: {
                path: "src/server/Mechanic.server.luau",
                content: '--!strict\nprint("candidate")\n',
                expectedHash: this.originalHash,
              },
            },
          ]
        : [{ id: "finish-1", name: "workspace.finish", arguments: { summary: "Implemented." } }];
    const message = { role: "assistant" as const, content: "", toolCalls };
    return {
      kind: "assistant",
      message,
      stopReason: "tool_calls",
      responseHash: hashJson(message),
      requestHash: modelTurnRequestHash(request, this.descriptor),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
      responseFacts: {
        requestedModel: "fake/model-20260917",
        resolvedModel: "fake/model",
        servingProvider: "fake",
        requestedServiceTier: null,
        servingServiceTier: null,
        responseId: `response-${this.turn}`,
        latencyMs: 1,
        retryCount: 0,
        finishReason: "tool_calls",
        continuationHash: null,
        continuationBytes: null,
      },
    };
  }
}

function exhaustedModel(knownUsage = true) {
  const model = new FakeModelClient("", [[], [], []]);
  const complete = model.complete.bind(model);
  model.complete = async (request) => {
    const result = await complete(request);
    if (result.kind !== "assistant") throw new Error("Expected fixture assistant");
    const payload = { reasoning: "Synthetic retained unfinished analysis." };
    const serialized = stableJson(payload);
    const continuation = {
      transport: model.descriptor.transport,
      payload,
      hash: contentHash(serialized),
      bytes: Buffer.byteLength(serialized),
    };
    result.stopReason = "max_tokens";
    result.message.continuation = continuation;
    result.responseHash = hashJson(result.message);
    result.responseFacts = {
      ...result.responseFacts,
      finishReason: "length",
      continuationHash: continuation.hash,
      continuationBytes: continuation.bytes,
    };
    result.usage = knownUsage
      ? {
          inputTokens: 1752,
          outputTokens: 8192,
          reasoningTokens: 8191,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0024164,
        }
      : {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
        };
    return result;
  };
  return model;
}

for (const knownUsage of [true, false])
  test(`an exhausted response without tools stops after one request with ${knownUsage ? "known" : "unknown"} usage`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-output-limit-"));
    try {
      await writeSceneWorkspace(workspace);
      const task = runtimeTask();
      const model = exhaustedModel(knownUsage);
      let saved: BoundedAgentCheckpoint | null = null;
      const run = await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment: treatmentFor(task),
        modelClient: model,
        verify: async () => ({ gate: "rejected", reasons: ["Unfinished seed"], checks: [] }),
        checkpoint: async (state) => {
          saved = state;
        },
      });
      assert.equal(model.requests.length, 1, "No blind continuation after output exhaustion");
      assert.equal(run.stopReason, "output_limit");
      assert.equal(run.status, "incomplete", "An unfinished response is not a quality verdict");
      assert.equal(run.failure?.classification, "budget_or_stop_failure");
      assert.equal(run.usage.calls, 1);
      assert.equal(run.usage.outputTokens, knownUsage ? 8192 : null);
      assert.equal(run.usage.reasoningTokens, knownUsage ? 8191 : null);
      assert.equal(run.usage.providerReportedCostUsd, knownUsage ? 0.0024164 : null);
      assert.ok(saved);
      const final = saved as BoundedAgentCheckpoint;
      const message = final.conversation.find((item) => item.role === "assistant");
      assert.ok(message && message.role === "assistant" && message.continuation);
      assert.equal(
        contentHash(stableJson(message.continuation.payload)),
        message.continuation.hash,
      );
      assert.equal(run.trace.filter((event) => event.kind === "tool_call").length, 0);
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment: treatmentFor(task),
          modelClient: model,
          verify: eligibleVerification,
          resume: final,
        }),
        /completed|finished|bounded public attempt/u,
      );
      assert.equal(model.requests.length, 1, "A completed run cannot dispatch again");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

test("an interrupted exhausted response resumes its retained receipt without another call", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-output-limit-resume-"));
  try {
    await writeSceneWorkspace(workspace);
    const task = runtimeTask();
    const model = exhaustedModel();
    const treatment = treatmentFor(task);
    let saved: BoundedAgentCheckpoint | null = null;
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: model,
        verify: eligibleVerification,
        checkpoint: async (state) => {
          if (state.point === "after_model") {
            saved = state;
            throw new AgentInterrupted();
          }
        },
      }),
      AgentInterrupted,
    );
    assert.ok(saved);
    const different = structuredClone(treatment);
    different.harness.maxTurns += 1;
    const { schema: _schema, id: _id, ...body } = different;
    different.id = `tr-${hashJson(body).slice(0, 20)}`;
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment: different,
        modelClient: model,
        verify: eligibleVerification,
        resume: saved,
      }),
      /Checkpoint does not describe this bounded public attempt/u,
    );
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: model,
      verify: eligibleVerification,
      resume: saved,
    });
    assert.equal(model.requests.length, 1);
    assert.equal(run.stopReason, "output_limit");
    assert.equal(run.status, "incomplete");
    assert.equal(run.usage.calls, 1);
    assert.equal(run.usage.outputTokens, 8192);
    assert.equal(run.usage.providerReportedCostUsd, 0.0024164);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const stopReason of ["max_tokens", "other"] as const)
  test(`${stopReason} preserves ${stopReason === "max_tokens" ? "valid tool calls" : "unknown-stop classification"}`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-output-stop-boundary-"));
    try {
      await writeSceneWorkspace(workspace);
      const task = runtimeTask();
      const model = new FakeModelClient("", [
        stopReason === "max_tokens"
          ? [{ id: "finish-limit", name: "workspace.finish", arguments: { summary: "Done" } }]
          : [],
      ]);
      const complete = model.complete.bind(model);
      model.complete = async (request) => {
        const result = await complete(request);
        if (result.kind !== "assistant") throw new Error("Expected fixture assistant");
        result.stopReason = stopReason;
        result.responseFacts.finishReason = stopReason === "max_tokens" ? "length" : "unknown";
        return result;
      };
      const run = await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment: treatmentFor(task),
        modelClient: model,
        verify: eligibleVerification,
      });
      assert.equal(model.requests.length, 1);
      assert.equal(run.stopReason, stopReason === "max_tokens" ? "finished" : "invalid_tool_call");
      assert.equal(run.status, stopReason === "max_tokens" ? "locally_eligible" : "incomplete");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

for (const profile of ["local", "studio"] as const)
  test(`${profile} builders inspect the exact public scene while source access remains Luau-only`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-public-seed-scene-"));
    try {
      const { project, bytes } = await writeSceneWorkspace(workspace);
      await writeFile(resolve(workspace, "evaluator.json"), '{"secret":"WITHHELD_ORACLE"}');
      await writeFile(resolve(workspace, "outside.luau"), "-- PRIVATE_OUTSIDE_ROOT\n");
      const task = runtimeTask();
      const treatment = treatmentFor(task);
      if (profile === "studio") treatment.harness = studioHarness();
      const { schema: _schema, id: _id, ...body } = treatment;
      treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
      const model = new FakeModelClient("", [
        [
          { id: "scene", name: "workspace.list", arguments: {} },
          {
            id: "read-project",
            name: "workspace.read",
            arguments: { path: "default.project.json" },
          },
          { id: "read-private", name: "workspace.read", arguments: { path: "evaluator.json" } },
          { id: "read-outside", name: "workspace.read", arguments: { path: "outside.luau" } },
          { id: "search-private", name: "workspace.search", arguments: { text: "ORACLE" } },
          {
            id: "write-project",
            name: "workspace.write",
            arguments: {
              path: "default.project.json",
              expectedHash: contentHash(bytes),
              content: "{}",
            },
          },
          {
            id: "patch-project",
            name: "workspace.patch",
            arguments: {
              path: "default.project.json",
              expectedHash: contentHash(bytes),
              before: "EvalEndpointA",
              after: "Changed",
            },
          },
        ],
        [{ id: "finish", name: "workspace.finish", arguments: { summary: "Scene inspected." } }],
      ]);
      const run = await runAgent({
        // The allowance of each request comes from its own content.
        outputTokens: (request) => 8000 + request.messages.length,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: model,
        verify: eligibleVerification,
        ...(profile === "studio"
          ? {
              development: {
                publicScenarios: ["public-view"],
                maxRuns: 1,
                run: async () => {
                  throw new Error("No Studio call expected");
                },
                inspect: async () => {
                  throw new Error("No Studio call expected");
                },
              },
            }
          : {}),
      });
      assert.equal(run.status, "locally_eligible");
      for (const request of model.requests)
        assert.equal(request.maxOutputTokens, 8000 + request.messages.length);
      const messages = model.requests[1]!.messages;
      const sceneMessage = messages.find(
        (message) => message.role === "tool" && message.toolCallId === "scene",
      )!;
      const listing = JSON.parse(sceneMessage.content);
      assert.deepEqual(listing.scene, {
        projectFile: "default.project.json",
        projectHash: contentHash(bytes),
        tree: project.tree,
      });
      assert.equal(listing.scene.tree.Workspace.EvalEndpointA.$className, "Part");
      assert.deepEqual(
        listing.scene.tree.Workspace.EvalEndpointA.$properties.CFrame,
        [-15, 5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      );
      assert.equal(listing.scene.tree.Workspace.EvalEndpointB.$properties.CanCollide, false);
      assert.equal(listing.scene.tree.ServerScriptService.$path, "src/server");
      assert.equal(listing.scene.tree.ReplicatedStorage.Shared.$path, "src/shared");
      assert.deepEqual(
        listing.files.map((file: { path: string }) => file.path),
        [
          "src/client/Main.client.luau",
          "src/server/Main.server.luau",
          "src/shared/Placeholder.luau",
        ],
      );
      assert.ok(Buffer.byteLength(sceneMessage.content, "utf8") <= MAX_TOOL_RESULT_BYTES);
      assert.doesNotMatch(
        stableJson(messages),
        /WITHHELD_ORACLE|PRIVATE_OUTSIDE_ROOT|PRIVATE_HOST_METADATA/,
      );
      for (const id of [
        "read-project",
        "read-private",
        "read-outside",
        "write-project",
        "patch-project",
      ]) {
        const result = messages.find(
          (message) => message.role === "tool" && message.toolCallId === id,
        )!;
        assert.equal(JSON.parse(result.content).ok, false);
      }
      const search = messages.find(
        (message) => message.role === "tool" && message.toolCallId === "search-private",
      )!;
      assert.deepEqual(JSON.parse(search.content).matches, []);
      assert.equal(await readFile(resolve(workspace, "default.project.json"), "utf8"), bytes);
      assert.equal(
        run.candidate.files.find((file) => file.path === "default.project.json")!.hash,
        contentHash(bytes),
      );
      const trace = run.trace.find(
        (event) => event.kind === "tool_result" && event.data.id === "scene",
      )!;
      assert.equal((trace.data.result as Record<string, unknown>).projectHash, contentHash(bytes));
      assert.equal(
        (trace.data.result as Record<string, unknown>).sceneHash,
        hashJson(listing.scene),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

for (const defect of [
  "missing",
  "invalid-json",
  "missing-tree",
  "project-symlink",
  "project-directory-symlink",
  "oversized-project",
  "oversized-scene",
  "absolute-mapping",
  "parent-mapping",
  "outside-root-mapping",
  "missing-mapping",
  "non-source-mapping",
  "mapping-symlink",
  "unsupported-directive",
  "nonfinite-property",
] as const)
  test(`public scene ${defect} is rejected before any model request`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-public-scene-rejection-"));
    try {
      await mkdir(resolve(workspace, "src/server"), { recursive: true });
      await writeFile(resolve(workspace, "src/server/Main.server.luau"), "-- seed\n");
      const task = runtimeTask();
      const project: Record<string, unknown> = { tree: { $className: "DataModel" } };
      const tree = project.tree as Record<string, unknown>;
      const mappings: Partial<Record<typeof defect, string>> = {
        "absolute-mapping": "/private/host-data.luau",
        "parent-mapping": "../private/host-data.luau",
        "outside-root-mapping": "private/host-data.luau",
        "missing-mapping": "src/absent.luau",
        "non-source-mapping": "src/private.json",
        "mapping-symlink": "src/link",
      };
      if (mappings[defect]) tree.Script = { $path: mappings[defect] };
      if (defect === "non-source-mapping")
        await writeFile(resolve(workspace, "src/private.json"), "{}");
      if (defect === "mapping-symlink")
        await symlink(resolve(workspace, "src/server"), resolve(workspace, "src/link"));
      if (defect === "missing-tree") delete project.tree;
      if (defect === "unsupported-directive") tree.$include = "private/evaluator.json";
      if (defect === "oversized-scene")
        tree.$properties = { Name: "x".repeat(MAX_TOOL_RESULT_BYTES) };
      let bytes = stableJson(project);
      if (defect === "invalid-json") bytes = "{";
      if (defect === "nonfinite-property")
        bytes = '{"tree":{"$properties":{"Transparency":1e999}}}';
      if (defect === "oversized-project") bytes += " ".repeat(2 * 1024 * 1024);
      const path = resolve(workspace, task.seed.projectFile);
      if (defect === "project-symlink") {
        await writeFile(resolve(workspace, "actual.project.json"), bytes);
        await symlink(resolve(workspace, "actual.project.json"), path);
      } else if (defect === "project-directory-symlink") {
        await mkdir(resolve(workspace, "project"));
        await writeFile(resolve(workspace, "project/default.project.json"), bytes);
        await symlink(resolve(workspace, "project"), resolve(workspace, "linked"));
        task.seed.projectFile = "linked/default.project.json";
      } else if (defect !== "missing") await writeFile(path, bytes);
      const model = new FakeModelClient("");
      let verifications = 0;
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment: treatmentFor(task),
          modelClient: model,
          verify: async () => {
            verifications++;
            return eligibleVerification();
          },
        }),
      );
      assert.equal(model.requests.length, 0);
      assert.equal(verifications, 0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

test("all registered task and study seed projects expose their existing declarative scene", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-existing-public-scenes-"));
  try {
    const directories = await discoverTaskDirectories(process.cwd());
    assert.ok(directories.length >= 10);
    for (const [index, directory] of directories.entries()) {
      const workspace = resolve(temporary, String(index));
      await cp(resolve(directory, "seed"), workspace, { recursive: true });
      const task = JSON.parse(
        await readFile(resolve(directory, "task.json"), "utf8"),
      ) as PublicTask;
      const model = new FakeModelClient("", [
        [{ id: "scene", name: "workspace.list", arguments: {} }],
        [{ id: "finish", name: "workspace.finish", arguments: { summary: "Scene inspected." } }],
      ]);
      await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment: treatmentFor(task),
        modelClient: model,
        verify: eligibleVerification,
      });
      const message = model.requests[1]!.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "scene",
      )!;
      const expected = JSON.parse(
        await readFile(resolve(directory, "seed", task.seed.projectFile), "utf8"),
      );
      assert.deepEqual(JSON.parse(message.content).scene.tree, expected.tree, directory);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const boundary of ["after-response", "before-dispatch"] as const)
  test(`changed public project at ${boundary} stops before another paid request`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-public-scene-change-"));
    try {
      await writeSceneWorkspace(workspace);
      const task = runtimeTask();
      const model = new FakeModelClient("", [
        [{ id: "scene", name: "workspace.list", arguments: {} }],
        [{ id: "finish", name: "workspace.finish", arguments: { summary: "Done." } }],
      ]);
      if (boundary === "after-response") {
        const complete = model.complete.bind(model);
        model.complete = async (request) => {
          const result = await complete(request);
          await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}');
          return result;
        };
      }
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment: treatmentFor(task),
          modelClient: model,
          verify: eligibleVerification,
          ...(boundary === "before-dispatch"
            ? {
                checkpoint: async (state: BoundedAgentCheckpoint) => {
                  if (state.point === "before_model")
                    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}');
                },
              }
            : {}),
        }),
        /Public seed project changed/,
      );
      assert.equal(model.requests.length, boundary === "before-dispatch" ? 0 : 1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

test("scene inspection resumes with the exact retained project and conversation", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-public-scene-resume-"));
  try {
    const { bytes } = await writeSceneWorkspace(workspace);
    const task = runtimeTask();
    const model = new FakeModelClient("", [
      [{ id: "scene", name: "workspace.list", arguments: {} }],
      [{ id: "finish", name: "workspace.finish", arguments: { summary: "Done." } }],
    ]);
    const input = {
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: model,
      verify: eligibleVerification,
    };
    let retained: BoundedAgentCheckpoint | null = null;
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        ...input,
        checkpoint: async (state) => {
          if (state.point === "after_tool") {
            retained = state;
            throw new Error("Retain scene checkpoint");
          }
        },
      }),
      /Retain scene checkpoint/,
    );
    assert.ok(retained);
    const checkpoint = retained as BoundedAgentCheckpoint;
    assert.equal(
      checkpoint.source.files.find((file) => file.path === "default.project.json")!.hash,
      contentHash(bytes),
    );
    const result = checkpoint.conversation.find(
      (message) => message.role === "tool" && message.toolCallId === "scene",
    )!;
    assert.equal(JSON.parse(result.content).scene.projectHash, contentHash(bytes));
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}');
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        ...input,
        resume: checkpoint,
      }),
      /Workspace differs/,
    );
    assert.equal(model.requests.length, 1);
    await writeFile(resolve(workspace, "default.project.json"), bytes);
    const run = await runAgent({
      outputTokens: () => 8192,
      ...input,
      resume: checkpoint,
    });
    assert.equal(run.status, "locally_eligible");
    assert.equal(model.requests.length, 2);
    assert.equal(
      run.trace.filter(
        (event) => event.kind === "tool_call" && event.data.name === "workspace.list",
      ).length,
      1,
    );
    assert.deepEqual(
      model.requests[1]!.messages.slice(0, checkpoint.conversation.length),
      checkpoint.conversation,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writeSceneWorkspace(workspace: string) {
  const seed = neutralRojoSeed("Public scene", {
    parts: ["EvalEndpointA", "EvalEndpointB", "EvalPlatform"].map((name, index) => ({
      name,
      position: [index === 1 ? 15 : -15, 5, 0],
      size: [12, 1, 10],
      anchored: true,
      canCollide: index === 2,
      transparency: index === 2 ? 0 : 0.35,
    })),
  });
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  for (const source of seed.sources) await writeFile(resolve(workspace, source.path), source.text);
  const project = seed.project as { tree: Record<string, unknown> };
  const bytes = stableJson({ ...project, serveAddress: "PRIVATE_HOST_METADATA" });
  await writeFile(resolve(workspace, "default.project.json"), bytes);
  return { project, bytes };
}

async function eligibleVerification(): Promise<LocalVerification> {
  return { gate: "eligible", reasons: [], checks: [] };
}

for (const boundary of [
  "before_model:1",
  "after_model:1",
  "before_tool:1",
  "write_published:1",
  "after_tool:1",
  "before_model:2",
  "after_model:2",
  "before_tool:2",
  "after_tool:2",
])
  test(`bounded recovery at ${boundary} retains prior turns and applies each tool once`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-bounded-recovery-"));
    try {
      await mkdir(resolve(workspace, "src/server"), { recursive: true });
      await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
      const initial = "--!strict\n-- seed\n";
      const changed = '--!strict\nprint("candidate")\n';
      const path = resolve(workspace, "src/server/Mechanic.server.luau");
      await writeFile(path, initial);
      const task: PublicTask = {
        schema: "basalt-evals/task",
        slug: "resume",
        title: "Resume",
        prompt: "Build the public task.",
        seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
        roles: [],
        acceptance: ["Implement the task."],
        evidenceInstructions: [],
      };
      const treatment = treatmentFor(task);
      const { schema: _schema, id: _id, ...body } = treatment;
      treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
      const model = new FakeModelClient(contentHash(initial));
      const verify = async (): Promise<LocalVerification> => ({
        gate: "eligible",
        reasons: [],
        checks: [],
      });
      let saved: BoundedAgentCheckpoint | null = null;
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment,
          modelClient: model,
          verify,
          checkpoint: async (state) => {
            saved = state;
            const target = boundary.replace("write_published", "before_tool");
            if (`${state.point}:${state.turn}` === target)
              throw new Error("simulated interruption");
          },
        }),
        /simulated interruption/,
      );
      assert.ok(saved);
      if (boundary.startsWith("write_published")) await writeFile(path, changed);
      const run = await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: model,
        verify,
        resume: saved,
      });
      assert.equal(run.status, "locally_eligible");
      assert.equal(run.usage.calls, 2);
      assert.equal(model.requests.length, 2);
      assert.equal(run.trace.filter((event) => event.kind === "model_request").length, 2);
      assert.equal(run.trace.filter((event) => event.kind === "tool_call").length, 2);
      assert.equal(
        run.trace.filter((event) => event.kind === "tool_result" && event.data.ok === true).length,
        2,
      );
      assert.equal(await readFile(path, "utf8"), changed);
      assert.equal(run.startedAt, (saved as BoundedAgentCheckpoint).startedAt);
      await writeFile(path, "unrelated mutation");
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment,
          modelClient: model,
          verify,
          resume: saved,
        }),
        /Workspace differs/,
      );
      assert.equal(model.requests.length, 2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

for (const blockedBy of ["implementation", "spending"] as const)
  test(`${blockedBy} admission interruption preserves an unfinished build without inventing a provider call`, async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "basalt-agent-admission-"));
    try {
      await mkdir(resolve(workspace, "src/server"), { recursive: true });
      await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
      const path = resolve(workspace, "src/server/Mechanic.server.luau");
      const original = "--!strict\n-- seed\n";
      await writeFile(path, original);
      const task = runtimeTask();
      const treatment = treatmentFor(task);
      const fake = new FakeModelClient(contentHash(original));
      let blocked = true;
      const client: ModelClient = {
        descriptor: fake.descriptor,
        async complete(request) {
          if (blocked && fake.requests.length === 1) {
            if (blockedBy === "spending") throw new SpendingCeilingError();
            throw new ModelRequestAdmissionError(new Error("Frozen implementation changed"));
          }
          return fake.complete(request);
        },
      };
      const verify = async (): Promise<LocalVerification> => ({
        gate: "eligible",
        reasons: [],
        checks: [],
      });
      let saved: BoundedAgentCheckpoint | null = null;
      await assert.rejects(
        runAgent({
          outputTokens: () => 8192,
          workspaceRoot: workspace,
          task,
          treatment,
          modelClient: client,
          verify,
          retainInterruption: true,
          checkpoint: async (state) => {
            saved = state;
          },
        }),
        (error: unknown) =>
          blockedBy === "spending"
            ? error instanceof AgentBudgetPaused
            : error instanceof AgentInterrupted &&
              error.message === "Frozen implementation changed",
      );
      assert.ok(saved);
      const checkpoint = saved as BoundedAgentCheckpoint;
      assert.equal(checkpoint.usage.calls, 1);
      assert.equal(checkpoint.point, "before_model");
      assert.equal(checkpoint.pendingAction, null);
      assert.equal(checkpoint.completedRun, null);
      assert.equal(fake.requests.length, 1);
      assert.equal(await readFile(path, "utf8"), '--!strict\nprint("candidate")\n');
      blocked = false;
      const run = await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: client,
        verify,
        resume: checkpoint,
        retainInterruption: true,
      });
      assert.equal(run.status, "locally_eligible");
      assert.equal(run.usage.calls, 2);
      assert.equal(fake.requests.length, 2);
      assert.equal(
        run.trace.filter(
          (event) => event.kind === "tool_call" && event.data.name === "workspace.write",
        ).length,
        1,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

test("bounded recovery consumes a saved model answer and resumes the remaining tool batch", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-batch-recovery-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const path = resolve(workspace, "src/server/Mechanic.server.luau");
    const original = "--!strict\n-- seed\n";
    await writeFile(path, original);
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    const { schema: _schema, id: _id, ...body } = treatment;
    treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
    const fake = new FakeModelClient(contentHash(original));
    const receipts = new Map<string, ModelTurnResult>();
    const client: ModelClient = {
      descriptor: fake.descriptor,
      async complete(request) {
        const hash = modelTurnRequestHash(request, fake.descriptor);
        const saved = receipts.get(hash);
        if (saved) return saved;
        const result = await fake.complete(request);
        if (result.kind !== "assistant") throw new Error("Expected fixture assistant");
        result.message.toolCalls.push({
          id: "finish-batch",
          name: "workspace.finish",
          arguments: { summary: "Complete" },
        });
        result.responseHash = hashJson(result.message);
        receipts.set(hash, result);
        return result;
      },
    };
    const verify = async (): Promise<LocalVerification> => ({
      gate: "eligible",
      checks: [],
      reasons: [],
    });
    let saved: BoundedAgentCheckpoint | null = null;
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: client,
        verify,
        checkpoint: async (state) => {
          if (state.point === "after_model")
            throw new Error("response saved, checkpoint not committed");
          saved = state;
        },
      }),
      /response saved/,
    );
    assert.ok(saved);
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: client,
        verify,
        resume: saved,
        checkpoint: async (state) => {
          saved = state;
          if (state.point === "after_tool") throw new Error("first tool committed");
        },
      }),
      /first tool committed/,
    );
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: client,
      verify,
      resume: saved,
    });
    assert.equal(fake.requests.length, 1);
    assert.equal(run.usage.calls, 1);
    assert.equal(run.status, "locally_eligible");
    assert.deepEqual(
      run.trace.filter((event) => event.kind === "tool_result").map((event) => event.data.id),
      ["write-1", "finish-batch"],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an interrupted public development action recovers its receipt without a second launch", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-development-recovery-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const original = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), original);
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    treatment.harness = studioHarness({ developmentRuns: 3 });
    const { schema: _schema, id: _id, ...body } = treatment;
    treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
    const fake = new FakeModelClient(contentHash(original));
    const client: ModelClient = {
      descriptor: fake.descriptor,
      async complete(request) {
        const result = await fake.complete(request);
        if (fake.requests.length === 1 && result.kind === "assistant") {
          result.message.toolCalls = [
            { id: "public-scene", name: "development.run", arguments: { scenarioId: "public" } },
          ];
          result.responseHash = hashJson(result.message);
        }
        return result;
      },
    };
    let launches = 0;
    let ownedId = "";
    let saved: BoundedAgentCheckpoint | null = null;
    const development = {
      publicScenarios: ["public"],
      maxRuns: 3,
      run: async (_workspace: string, _candidate: unknown, _scenario: string, actionId: string) => {
        launches += 1;
        ownedId = actionId;
        throw new AgentInterrupted("The Studio lane admission stopped.");
      },
      inspect: async () => {
        throw new Error("No inspect requested");
      },
    };
    const verify = async (): Promise<LocalVerification> => ({
      gate: "eligible",
      checks: [],
      reasons: [],
    });
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: client,
        verify,
        development,
        retainInterruption: true,
        checkpoint: async (state) => {
          saved = state;
        },
      }),
      (error: unknown) =>
        error instanceof AgentInterrupted && error.message === "The Studio lane admission stopped.",
    );
    assert.ok(saved);
    const checkpoint = saved as BoundedAgentCheckpoint;
    assert.equal(checkpoint.pendingAction?.kind, "public_studio");
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task,
        treatment,
        modelClient: client,
        verify,
        resume: checkpoint,
        development: {
          ...development,
          recover: async () => {
            throw new Error("No signed receipt yet");
          },
        },
      }),
      (error: unknown) =>
        error instanceof AgentInterrupted && /\(No signed receipt yet\)/.test(error.message),
    );
    assert.equal(fake.requests.length, 1);
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: client,
      verify,
      resume: checkpoint,
      development: {
        ...development,
        recover: async (_workspace, candidate, scenario, id) => {
          assert.equal(id, ownedId);
          assert.equal(scenario, "public");
          return {
            evidenceId: id,
            candidateHash: candidate.rootHash,
            summary: "Signed acquisition recovered",
            activeDurationMs: 1,
            frames: [],
          };
        },
      },
    });
    assert.equal(run.status, "locally_eligible");
    assert.equal(launches, 1);
    assert.equal(fake.requests.length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a recovered public development run returns a candidate failure to the builder", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-development-candidate-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const original = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), original);
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    treatment.harness = studioHarness({ developmentRuns: 3 });
    const { schema: _schema, id: _id, ...body } = treatment;
    treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
    const fake = new FakeModelClient(contentHash(original));
    const client: ModelClient = {
      descriptor: fake.descriptor,
      async complete(request) {
        const result = await fake.complete(request);
        if (fake.requests.length === 1 && result.kind === "assistant") {
          result.message.toolCalls = [
            { id: "public-scene", name: "development.run", arguments: { scenarioId: "public" } },
          ];
          result.responseHash = hashJson(result.message);
        }
        return result;
      },
    };
    let saved: BoundedAgentCheckpoint | null = null;
    const development = {
      publicScenarios: ["public"],
      maxRuns: 3,
      // The run stops while the job waits for a Studio lane.
      run: async () => {
        throw new AgentInterrupted("The Studio lane admission stopped.");
      },
      inspect: async () => {
        throw new Error("No inspect requested");
      },
    };
    const verify = async (): Promise<LocalVerification> => ({
      gate: "eligible",
      checks: [],
      reasons: [],
    });
    const common = {
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: client,
      verify,
    };
    await assert.rejects(
      runAgent({
        ...common,
        development,
        retainInterruption: true,
        checkpoint: async (state) => {
          saved = state;
        },
      }),
      AgentInterrupted,
    );
    const failure = "Rojo could not build the Studio place: synthetic Rojo output";
    const run = await runAgent({
      ...common,
      resume: saved as unknown as BoundedAgentCheckpoint,
      development: {
        ...development,
        recover: async () => {
          throw new DevelopmentCandidateError(failure);
        },
      },
    });
    const result = run.trace.find(
      (event) => event.kind === "tool_result" && event.data.name === "development.run",
    );
    assert.equal(result?.data.ok, false, "The builder gets the failure as a tool result");
    assert.match(JSON.stringify(result?.data), /Rojo could not build the Studio place/);
    assert.equal(fake.requests.length, 2, "The build continues with its next model turn");
    // A fault of the host, for example an absent Rojo, is not a result for the builder.
    await assert.rejects(
      runAgent({
        ...common,
        resume: saved as unknown as BoundedAgentCheckpoint,
        development: {
          ...development,
          recover: async () => {
            throw new Error("spawn rojo ENOENT");
          },
        },
      }),
      (error) => error instanceof AgentInterrupted && /spawn rojo ENOENT/.test(error.message),
    );
    assert.equal(fake.requests.length, 2, "No model turn follows the interruption");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent runtime exposes only public task context and seals the exact candidate", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const initial = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), initial);
    const task: PublicTask = {
      schema: "basalt-evals/task",
      slug: "runtime-test",
      title: "Runtime test",
      prompt: "Implement the public mechanic.",
      seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
      roles: [],
      acceptance: ["It works."],
      evidenceInstructions: ["Keep Mechanic stable."],
    };
    const treatment = treatmentFor(task);
    const model = new FakeModelClient(contentHash(initial));
    const checkpoints: BoundedAgentCheckpoint[] = [];
    const verify = async (root: string): Promise<LocalVerification> => ({
      gate: (await readFile(resolve(root, "src/server/Mechanic.server.luau"), "utf8")).includes(
        "candidate",
      )
        ? "eligible"
        : "rejected",
      reasons: [],
      checks: [{ name: "fixture", outcome: "pass" }],
    });
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: model,
      verify,
      checkpoint: async (state) => {
        checkpoints.push(state);
      },
    });
    assert.equal(run.status, "locally_eligible");
    assert.equal(run.stopReason, "finished");
    assert.equal(run.usage.calls, 2);
    assert.equal(run.candidate.files.length, 2);
    assert.equal(run.candidate.rootHash, hashJson(run.candidate.files));
    assert.deepEqual(
      checkpoints.map((state) => state.point),
      [
        "before_model",
        "after_model",
        "before_tool",
        "after_tool",
        "before_model",
        "after_model",
        "before_tool",
        "after_tool",
        "finished",
      ],
    );
    assert.equal(checkpoints[2]!.pendingAction?.id, "write-1");
    assert.notEqual(checkpoints[2]!.source.rootHash, checkpoints[3]!.source.rootHash);
    assert.deepEqual(checkpoints.at(-1)!.completedRun, run);
    assert.doesNotMatch(
      JSON.stringify(checkpoints.map((state) => state.conversation)),
      /hidden|evaluator|oracle/,
    );
    assert.equal(
      run.candidate.files.find((file) => file.path.endsWith("Mechanic.server.luau"))?.hash,
      contentHash('--!strict\nprint("candidate")\n'),
    );
    const wireContext = JSON.stringify(model.requests);
    assert.doesNotMatch(wireContext, /hidden|evaluator|oracle/);
    const traceContext = JSON.stringify(run.trace);
    assert.doesNotMatch(traceContext, /print\(\"candidate\"\)/);
    assert.match(traceContext, /contentHash/);
    assert.doesNotMatch(traceContext, /Implemented\./);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("caller and adapter mutations cannot change a frozen run or later model context", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-snapshot-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const initial = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), initial);
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    const expectedTreatment = treatment.id;
    const model = new FakeModelClient(contentHash(initial));
    let calls = 0;
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      modelClient: {
        descriptor: model.descriptor,
        async complete(request) {
          calls += 1;
          assert.equal(request.model, "fake/model-20260917");
          assert.doesNotMatch(JSON.stringify(request), /tampered/);
          const result = await model.complete(request);
          task.prompt = "tampered";
          treatment.id = "tampered";
          treatment.harness.maxTurns = 1;
          request.messages[0]!.content = "tampered";
          request.tools[0]!.description = "tampered";
          return result;
        },
      },
      verify: async (_root, publicTask) => {
        assert.doesNotMatch(publicTask.prompt, /tampered/);
        publicTask.seed.projectFile = "tampered.json";
        return { gate: "eligible", reasons: [], checks: [] };
      },
    });
    assert.equal(calls, 2);
    assert.equal(run.status, "locally_eligible");
    assert.equal(run.treatmentId, expectedTreatment);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unvalidated provider exceptions cannot leak request or credential text into run artifacts", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-exception-"));
  try {
    await mkdir(resolve(workspace, "src"));
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/Mechanic.luau"), "--!strict\n");
    const task = runtimeTask();
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: {
        descriptor: openRouterModelClientDescriptor(["fake/model-20260917"]),
        async complete() {
          throw new Error("Authorization: secret-that-must-not-be-saved");
        },
      },
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(run.stopReason, "provider_error");
    assert.equal(run.usage.calls, 1);
    assert.equal(run.failure?.classification, "provider_or_transport_failure");
    assert.doesNotMatch(JSON.stringify(run), /secret-that-must-not-be-saved|Authorization/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace size failures leave the original source untouched", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-limit-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    const project = '{"tree":{}}\n';
    const initial = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "default.project.json"), project);
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), initial);
    const workspaceLimit = 8 * 1024 * 1024;
    await writeFile(
      resolve(workspace, "payload.bin"),
      Buffer.alloc(workspaceLimit - Buffer.byteLength(project) - Buffer.byteLength(initial)),
    );
    const task = runtimeTask();
    const model = new FakeModelClient(contentHash(initial));
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: model,
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(
      await readFile(resolve(workspace, "src/server/Mechanic.server.luau"), "utf8"),
      initial,
    );
    assert.equal(run.status, "locally_eligible");
    assert.match(JSON.stringify(run.trace), /workspace exceeds byte limit/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime rejects a workspace reached through a symlink before a model call", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-agent-ancestor-"));
  try {
    const actual = resolve(temporary, "actual");
    await mkdir(resolve(actual, "workspace"), { recursive: true });
    const linked = resolve(temporary, "linked");
    await symlink(actual, linked);
    const task = runtimeTask();
    const model = new FakeModelClient("a".repeat(64));
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: resolve(linked, "workspace"),
        task,
        treatment: treatmentFor(task),
        modelClient: model,
        verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
      }),
      /symbolic|unsafe/i,
    );
    assert.equal(model.requests.length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("slow successful model responses complete without an elapsed-time cutoff", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-agent-untimed-"));
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const original = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), original);
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    const { schema: _schema, id: _id, ...body } = treatment;
    treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
    const fake = new FakeModelClient(contentHash(original));
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      now: () => new Date(clock),
      modelClient: {
        descriptor: fake.descriptor,
        async complete(request) {
          const result = await fake.complete(request);
          clock += 900_001;
          return result;
        },
      },
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(run.usage.calls, 2);
    assert.equal(run.status, "locally_eligible");
    assert.ok(fake.requests.every((request) => !Object.hasOwn(request, "timeoutMs")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recovery records elapsed work without installing a cancellation deadline", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-agent-recovery-time-"));
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const initial = "--!strict\n-- seed\n";
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), initial);
    const task = runtimeTask();
    const fake = new FakeModelClient(contentHash(initial));
    const input = {
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      now: () => new Date(0),
      modelClient: {
        descriptor: fake.descriptor,
        async complete(request: ModelTurnRequest) {
          const response = await fake.complete(request);
          response.responseFacts.latencyMs = 200_000;
          return response;
        },
      },
      verify: async (): Promise<LocalVerification> => ({
        gate: "eligible",
        reasons: [],
        checks: [],
      }),
    };
    let saved: BoundedAgentCheckpoint | null = null;
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        ...input,
        checkpoint: async (state) => {
          saved = { ...state, activeElapsedMs: 3_600_000 };
          throw new Error("interrupt before reserved request recovery");
        },
      }),
      /interrupt before reserved request recovery/,
    );
    assert.ok(saved);
    const result = await runAgent({
      outputTokens: () => 8192,
      ...input,
      resume: saved,
    });
    assert.equal(result.status, "locally_eligible");
    assert.deepEqual(deadlines, []);
    assert.equal(fake.requests.length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit cancellation reaches a bounded in-flight builder call", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-agent-cancel-request-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    const source = resolve(workspace, "src/server/Mechanic.server.luau");
    await writeFile(source, "--!strict\n-- seed\n");
    const task = runtimeTask();
    const treatment = treatmentFor(task);
    const { schema: _schema, id: _id, ...body } = treatment;
    treatment.id = `tr-${hashJson(body).slice(0, 20)}`;
    const controller = new AbortController();
    let reached = false;
    const fake = new FakeModelClient(contentHash("--!strict\n-- seed\n"));
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment,
      signal: controller.signal,
      modelClient: {
        descriptor: fake.descriptor,
        async complete(request, signal) {
          assert.equal(Object.hasOwn(request, "timeoutMs"), false);
          assert.ok(signal);
          reached = true;
          queueMicrotask(() => controller.abort());
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          );
          throw new Error("unreachable");
        },
      },
      verify: async () => ({ gate: "rejected", reasons: ["Seed is incomplete"], checks: [] }),
    });
    assert.equal(reached, true);
    assert.equal(run.stopReason, "cancelled");
    assert.equal(run.status, "incomplete");
    assert.equal(await readFile(source, "utf8"), "--!strict\n-- seed\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate tool-call IDs reject the whole batch before execution", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-duplicate-"));
  try {
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), "--!strict\n");
    const task = runtimeTask();
    const model: ModelClient = {
      descriptor: openRouterModelClientDescriptor(["fake/model-20260917"]),
      async complete(request) {
        const message = {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "duplicate", name: "workspace.list", arguments: {} },
            { id: "duplicate", name: "workspace.verify", arguments: {} },
          ],
        };
        return {
          kind: "assistant",
          message,
          stopReason: "tool_calls",
          responseHash: hashJson(message),
          requestHash: modelTurnRequestHash(request, model.descriptor),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
          responseFacts: {
            requestedModel: "fake/model-20260917",
            resolvedModel: "fake/model",
            servingProvider: "fake",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "duplicate-response",
            latencyMs: 1,
            retryCount: 0,
            finishReason: "tool-calls",
            continuationHash: null,
            continuationBytes: null,
          },
        };
      },
    };
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: model,
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.stopReason, "invalid_tool_call");
    assert.match(run.failure?.detail ?? "", /IDs must be unique/);
    assert.equal(
      run.trace.some((event) => event.kind === "tool_call"),
      false,
    );
    assert.deepEqual(
      run.trace.filter((event) => event.kind === "tool_rejection").map((event) => event.data),
      [
        {
          proposed: 2,
          reason: "invalid_tool_batch",
          responseHash: run.trace.find((event) => event.kind === "model_response")?.data
            .responseHash,
        },
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejected edit arguments name the exact problem for the builder", () => {
  const hash = "a".repeat(64);
  const patch = (expectedHash: unknown) => () =>
    parseToolCall({
      id: "call-1",
      name: "workspace.patch",
      arguments: { path: "src/a.luau", expectedHash, before: "x", after: "y" },
    });
  assert.throws(patch(`${hash}c`), /64-character .* You sent 65 characters\. Copy the hash/);
  assert.throws(patch(hash.slice(0, 37)), /You sent 37 characters/);
  assert.throws(patch("A".repeat(64)), /You sent characters other than 0-9 and a-f/);
  assert.throws(patch(null), /You sent a null value/);
  assert.equal(patch(hash)().name, "workspace.patch");
  assert.throws(
    () =>
      parseToolCall({
        id: "call-2",
        name: "workspace.patch",
        arguments: { path: "src/a.luau", expectedHash: hash, before: 1, after: "y" },
      }),
    /workspace\.patch before must be a string/,
  );
  assert.throws(
    () => parseToolCall({ id: "call-3", name: "workspace.write", arguments: { content: "x" } }),
    /workspace\.write arguments must contain exactly: path, content, expectedHash \(missing path, expectedHash\)/,
  );
  assert.throws(
    () =>
      parseToolCall({
        id: "call-4",
        name: "workspace.write",
        arguments: { path: "src/a.luau", content: "x", expectedHash: "sha256:x" },
      }),
    /You sent 8 characters\. .* Use null only to create an absent file/,
  );
  assert.throws(
    () => parseToolCall({ id: "call-5", name: "workspace.list", arguments: { all: true } }),
    /workspace\.list arguments must contain exactly: no fields \(unknown all\)/,
  );
});

test("model client contract violations become auditable incomplete runs", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-evals-agent-client-contract-"));
  try {
    await mkdir(resolve(workspace, "src"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/Mechanic.luau"), "--!strict\n");
    const task = runtimeTask();
    const message = {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "finish", name: "workspace.finish", arguments: { summary: "Done." } }],
    };
    const model: ModelClient = {
      descriptor: openRouterModelClientDescriptor(["fake/model-20260917"]),
      async complete() {
        return {
          kind: "assistant",
          message,
          stopReason: "tool_calls",
          responseHash: hashJson(message),
          requestHash: "a".repeat(64),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
          responseFacts: {
            requestedModel: "fake/model-20260917",
            resolvedModel: "fake/model",
            servingProvider: "fake",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "detached-request",
            latencyMs: 1,
            retryCount: 0,
            finishReason: "tool-calls",
            continuationHash: null,
            continuationBytes: null,
          },
        };
      },
    };
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task,
      treatment: treatmentFor(task),
      modelClient: model,
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.stopReason, "provider_error");
    assert.match(run.failure?.detail ?? "", /violated its result contract/);
    assert.equal(
      run.trace.some((event) => event.kind === "tool_call"),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runtimeTask(): PublicTask {
  return {
    schema: "basalt-evals/task",
    slug: "runtime-test",
    title: "Runtime test",
    prompt: "Implement the public mechanic.",
    seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
    roles: [],
    acceptance: ["It works."],
    evidenceInstructions: ["Keep Mechanic stable."],
  };
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
  return {
    schema: "basalt-evals/treatment",
    id: `tr-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
}
