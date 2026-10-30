import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  MAX_DEVELOPMENT_SUMMARY_BYTES,
  runAgent,
  type DevelopmentServices,
} from "../packages/agent-runtime/src/index.js";
import {
  contentHash,
  hashJson,
  stableJson,
  type PublicTask,
  type Treatment,
} from "../packages/contracts/src/index.js";
import {
  assertPublicDevelopmentRecipe,
  loadPublicDevelopmentTask,
} from "../packages/development/src/index.js";
import {
  openRouterModelClientDescriptor,
  modelTurnRequestHash,
  type ModelClient,
  type ModelToolCall,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/index.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";
import { preparePublicStudioSession } from "../packages/studio-runner/src/index.js";
import { createPublicDevelopmentServices } from "../packages/development/src/service.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import type { SequenceAcquisition } from "../packages/studio-runner/src/studio-mcp.js";
import type { SequenceAssessment } from "../packages/studio-runner/src/sequence.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { fixtureAdapters, fixturePublic } from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { studioHarness, testHarness } from "./builder-fixture.js";

const root = resolve(process.cwd());

test("public development recipes bind three mechanics without hidden criteria or holdouts", async () => {
  for (const slug of ["replicated-checkpoint", "timed-shutter", "cooperative-gate"]) {
    const directory = `tasks/pilot/${slug}`;
    const publicData = await loadPublicDevelopmentTask(root, directory);
    const privateTask = await loadRegisteredTask(root, directory);
    assert.equal(publicData.taskHash, privateTask.publicTaskHash);
    assert.notEqual(hashJson(publicData.recipe.plan), privateTask.collectionPlanHash);
    assert.doesNotMatch(
      JSON.stringify(publicData.recipe),
      /deterministic|expectedIssue|expert|holdout|rubric/u,
    );
    const injected = { ...publicData.recipe, evaluator: privateTask.evaluator };
    assert.throws(
      () => assertPublicDevelopmentRecipe(injected, publicData.task),
      /publicDevelopment fields: missing \[\]; unexpected \[evaluator\]/u,
    );
    const { views, ...withoutViews } = publicData.recipe;
    assert.throws(
      () =>
        assertPublicDevelopmentRecipe(
          { ...withoutViews, plan: { ...withoutViews.plan, views } },
          publicData.task,
        ),
      /publicDevelopment fields: missing \[views\]/u,
    );
  }
});

test("public Studio session binds an independent plan and exact candidate without an evaluator", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-public-development-"));
  try {
    const registered = await loadRegisteredTask(root, "tasks/pilot/replicated-checkpoint");
    const publicData = await loadPublicDevelopmentTask(root, registered.directory);
    const workspace = resolve(temporary, "candidate");
    await materializeTaskSeed(root, registered, workspace);
    const files = await inventoryTree(workspace);
    const candidate = {
      projectFile: publicData.task.seed.projectFile,
      files,
      rootHash: hashJson(files),
    };
    const session = await preparePublicStudioSession({
      workspaceRoot: workspace,
      outputDirectory: resolve(temporary, "studio"),
      publicTask: publicData.task,
      collectionPlan: publicData.recipe.plan,
      treatmentId: "development-test",
      studioVersion: "test-version",
      candidate,
      connectorSourceHash: "a".repeat(64),
      connectorArtifactHash: "b".repeat(64),
    });
    assert.equal(session.collectionPlanHash, hashJson(publicData.recipe.plan));
    assert.equal(session.candidateHash, candidate.rootHash);
    assert.equal(session.plan.scenarios[0]?.id, "touch-checkpoint");
    assert.doesNotMatch(
      await readFile(resolve(temporary, "studio/session.json"), "utf8"),
      /deterministic|codeQuality|humanReview|minimumPassingScore/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const fixture of [
  { name: "365-frame ASCII", frameCount: 365, reason: "observation ".repeat(2_000) },
  { name: "401-frame Unicode", frameCount: 401, reason: "観測😀שלום ".repeat(2_000) },
])
  test(`${fixture.name} development remains byte-bounded and every original can be inspected`, async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-summary-"));
    try {
      const implementation = await implementationFixture(temporary);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      await mkdir(resolve(temporary, ".basalt-evals/native-worker"), { recursive: true });
      await writeFile(
        resolve(temporary, ".basalt-evals/synthetic-private-key.pem"),
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      await writeFile(
        resolve(temporary, ".basalt-evals/native-worker/isolated-public-key.pem"),
        publicKey.export({ type: "spki", format: "pem" }),
      );
      const workspace = resolve(temporary, ".basalt-evals/candidate");
      const seed = neutralRojoSeed("Development summary fixture");
      for (const directory of ["src/server", "src/client", "src/shared"])
        await mkdir(resolve(workspace, directory), { recursive: true });
      await writeFile(resolve(workspace, "default.project.json"), stableJson(seed.project));
      for (const source of seed.sources)
        await writeFile(resolve(workspace, source.path), source.text);
      const outputRoot = resolve(temporary, ".basalt-evals/development");
      await mkdir(outputRoot);
      const adapters = fixtureAdapters(temporary);
      let syntheticAcquisitions = 0;
      let originalFrameHash = "";
      const studio = {
        ...adapters.studio,
        async run(input: Parameters<typeof adapters.studio.run>[0]) {
          syntheticAcquisitions++;
          const receipt = await adapters.studio.run(input);
          const files = new RepositoryFiles(input.directory);
          const indexFile = receipt.manifest.artifacts.find((artifact) =>
            artifact.file.endsWith("/index.json"),
          )!.file;
          const prefix = indexFile.slice(0, -"index.json".length);
          const acquisition = await files.json<SequenceAcquisition>(indexFile);
          const first = acquisition.frames[0]!;
          const bytes = await files.bytes(prefix + first.file);
          originalFrameHash = contentHash(bytes);
          acquisition.frames = Array.from({ length: fixture.frameCount }, (_, index) => ({
            ...first,
            file: `bounded-frame-${index + 1}.png`,
            startedAt: new Date(Date.parse(acquisition.startedAt) + index * 4).toISOString(),
            endedAt: new Date(Date.parse(acquisition.startedAt) + index * 4 + 2).toISOString(),
          }));
          for (const frame of acquisition.frames) await files.write(prefix + frame.file, bytes);
          await writeFile(files.path(indexFile), stableJson(acquisition));
          const assessmentFile = prefix + "assessment.json";
          const assessment = await files.json<SequenceAssessment>(assessmentFile);
          assessment.reasons = [fixture.reason];
          assessment.actorFrames[0]!.frameCount = fixture.frameCount;
          await writeFile(files.path(assessmentFile), stableJson(assessment));
          const signedPaths = [
            ...receipt.manifest.artifacts.map((artifact) => artifact.file),
            ...acquisition.frames.map((frame) => prefix + frame.file),
          ];
          receipt.manifest.artifacts = await Promise.all(
            signedPaths.map(async (file) => {
              const content = await files.bytes(file);
              return { file, hash: contentHash(content), bytes: content.length };
            }),
          );
          receipt.signature = sign(
            null,
            Buffer.from(stableJson(receipt.manifest)),
            privateKey,
          ).toString("base64");
          await writeFile(files.path("native/manifest.json"), stableJson(receipt));
          return receipt;
        },
      };
      const services = () =>
        createPublicDevelopmentServices({
          root: temporary,
          outputRoot,
          task: fixturePublic.publicTask,
          recipe: fixturePublic.publicDevelopment,
          recipeHash: hashJson(fixturePublic.publicDevelopment),
          implementationCommit: implementation.implementationCommit,
          maxRuns: 1,
          studio,
        });
      const trial = treatment(fixturePublic.publicTask, 1);
      const runCall = { id: "run", name: "development.run", arguments: { scenarioId: "scene" } };
      const evidenceId = `development-${hashJson({ treatment: trial.id, call: runCall }).slice(0, 24)}`;
      const retainedFile = resolve(outputRoot, evidenceId, "development.json");
      let retainedBytes = "";
      const development: DevelopmentServices = {
        ...services(),
        async inspect(id, frameIds) {
          // Cached prose is not signed authority. A cold read must regenerate
          // current presentation without rewriting this retained receipt.
          const retained = JSON.parse(await readFile(retainedFile, "utf8"));
          retained.result.summary = "CACHED_PROSE_MUST_NOT_REACH_BUILDER " + "😀".repeat(9_000);
          retained.resultHash = hashJson(retained.result);
          retainedBytes = stableJson(retained);
          await writeFile(retainedFile, retainedBytes);
          const before = await stat(retainedFile);
          const result = await services().inspect(id, frameIds);
          assert.equal(await readFile(retainedFile, "utf8"), retainedBytes);
          assert.equal((await stat(retainedFile)).mtimeMs, before.mtimeMs);
          return result;
        },
      };
      const model = fakeClient([
        [runCall],
        [
          {
            id: "inspect",
            name: "development.inspect",
            arguments: { evidenceId, frameIds: [`frame-${fixture.frameCount}`] },
          },
        ],
        [
          {
            id: "finish",
            name: "workspace.finish",
            arguments: { summary: "Original frame inspected." },
          },
        ],
      ]);
      const result = await runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task: fixturePublic.publicTask,
        treatment: trial,
        modelClient: model,
        development,
        verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
      });
      assert.equal(result.status, "locally_eligible");
      assert.equal(syntheticAcquisitions, 1);
      assert.equal(model.requests.length, 3);
      const summaries: string[] = [];
      for (const id of ["run", "inspect"]) {
        const message = model.requests
          .at(-1)!
          .messages.find((message) => message.role === "tool" && message.toolCallId === id)!;
        const observation = JSON.parse(message.content);
        assert.equal(observation.ok, true, message.content);
        assert.ok(Buffer.byteLength(observation.summary, "utf8") <= MAX_DEVELOPMENT_SUMMARY_BYTES);
        assert.match(
          observation.summary,
          /Runtime observation summary truncated; complete observations remain in signed evidence/,
        );
        assert.ok(
          observation.summary.includes(
            `frame-1 through frame-${fixture.frameCount} (inclusive; ${fixture.frameCount} original frames)`,
          ),
        );
        assert.ok(
          observation.summary.endsWith("Use development.inspect with one to four exact IDs."),
        );
        assert.doesNotMatch(observation.summary, /\uFFFD|CACHED_PROSE_MUST_NOT_REACH_BUILDER/);
        summaries.push(observation.summary);
        if (id === "inspect") {
          assert.equal(observation.frames[0].id, `frame-${fixture.frameCount}`);
          assert.equal(observation.frames[0].hash, originalFrameHash);
        }
      }
      assert.equal(summaries[0], summaries[1]);
      const retained = JSON.parse(retainedBytes);
      assert.equal(retained.result.frames.length, fixture.frameCount);
      assert.equal(await readFile(retainedFile, "utf8"), retainedBytes);
      assert.equal(
        JSON.parse(
          await readFile(resolve(retained.result.sequenceDirectory, "assessment.json"), "utf8"),
        ).reasons[0],
        fixture.reason,
      );
      const invalid = { ...retained, resultHash: "0".repeat(64) };
      await writeFile(retainedFile, stableJson(invalid));
      await assert.rejects(services().inspect(evidenceId, ["frame-1"]), /invalid provenance/);
      await writeFile(retainedFile, retainedBytes);
      await writeFile(
        resolve(retained.result.sequenceDirectory, retained.result.frames.at(-1).file),
        "changed original",
      );
      await assert.rejects(
        services().inspect(evidenceId, [`frame-${fixture.frameCount}`]),
        /Worker artifact hash mismatch/,
      );
      assert.equal(syntheticAcquisitions, 1);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

/** A treatment whose harness has the given public Studio development runs. */
function treatment(task: PublicTask, developmentRuns: number): Treatment {
  const publicTaskHash = hashJson(task);
  const body: Omit<Treatment, "schema" | "id"> = {
    ordinal: 1,
    studyHash: "a".repeat(64),
    task: {
      id: `${task.slug}:${publicTaskHash.slice(0, 12)}`,
      publicTaskHash,
      evaluatorHash: "b".repeat(64),
      seedHash: "c".repeat(64),
      collectionPlanHash: "d".repeat(64),
    },
    model: {
      id: "fake/model",
      responseModelId: "fake/model",
      transport: "fake",
      revision: "fake/model",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 1,
        capturedAt: "2026-09-17T00:00:00.000Z",
      },
    },
    transportConfigurationHash: hashJson(openRouterModelClientDescriptor(["fake/model"])),
    harness:
      developmentRuns > 0
        ? studioHarness({ systemPrompt: "Build the public task.", maxTurns: 5, developmentRuns })
        : testHarness({ systemPrompt: "Build the public task.", maxTurns: 5 }),
    repetition: 1,
    randomSeed: 1,
    environment: {
      platform: "Roblox Studio",
      studioVersion: "test",
      captureProtocol: "studio-mcp-viewport",
      cameraProtocol: "native",
    },
  };
  return { schema: "basalt-evals/treatment", id: `tr-${hashJson(body).slice(0, 20)}`, ...body };
}

function fakeClient(script: ModelToolCall[][]): ModelClient & { requests: ModelTurnRequest[] } {
  const descriptor = openRouterModelClientDescriptor(["fake/model"]);
  const requests: ModelTurnRequest[] = [];
  return {
    descriptor,
    requests,
    async complete(request): Promise<ModelTurnResult> {
      requests.push(structuredClone(request));
      const toolCalls = script[requests.length - 1] ?? [];
      const message = { role: "assistant" as const, content: "", toolCalls };
      return {
        kind: "assistant",
        message,
        stopReason: "tool_calls",
        requestHash: modelTurnRequestHash(request, descriptor),
        responseHash: hashJson(message),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.000001,
        },
        responseFacts: {
          requestedModel: "fake/model",
          resolvedModel: "fake/model",
          servingProvider: "fake",
          requestedServiceTier: null,
          servingServiceTier: null,
          responseId: `r${requests.length}`,
          latencyMs: 1,
          retryCount: 0,
          finishReason: "tool_calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
}

test("production inspects multiple image turns; thin never receives Studio tools", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-runtime-"));
  try {
    const registered = await loadRegisteredTask(root, "tasks/pilot/replicated-checkpoint");
    const workspace = resolve(temporary, "candidate");
    await materializeTaskSeed(root, registered, workspace);
    const bytes = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const frame = {
      id: "frame-1",
      actor: "player",
      acquisitionStart: "2026-09-17T00:00:00.000Z",
      acquisitionEnd: "2026-09-17T00:00:00.100Z",
      image: {
        mediaType: "image/png" as const,
        dataBase64: bytes.toString("base64"),
        hash: contentHash(bytes),
        label: "Image 1: frame-1; player player.",
      },
    };
    const development: DevelopmentServices = {
      publicScenarios: ["standard"],
      maxRuns: 2,
      async run(_workspace, candidate) {
        return {
          evidenceId: "development-one",
          candidateHash: candidate.rootHash,
          summary: "The player view changed.",
          frames: [frame],
        };
      },
      async inspect() {
        return {
          evidenceId: "development-one",
          candidateHash: hashJson(await inventoryTree(workspace)),
          summary: "Verified original frame.",
          frames: [frame],
        };
      },
    };
    const model = fakeClient([
      [{ id: "d1", name: "development.run", arguments: { scenarioId: "standard" } }],
      [
        {
          id: "d2",
          name: "development.inspect",
          arguments: { evidenceId: "development-one", frameIds: ["frame-1"] },
        },
        {
          id: "d3",
          name: "development.inspect",
          arguments: { evidenceId: "development-one", frameIds: ["frame-1"] },
        },
      ],
      [{ id: "f1", name: "workspace.finish", arguments: { summary: "Ready" } }],
    ]);
    const verify = async () => ({ gate: "eligible" as const, reasons: [], checks: [] });
    const result = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: registered.publicTask,
      treatment: treatment(registered.publicTask, 2),
      modelClient: model,
      verify,
      development,
    });
    assert.equal(result.status, "locally_eligible");
    assert.equal(model.requests.length, 3);
    assert.ok(model.requests[0]!.tools.some((tool) => tool.name === "development.run"));
    assert.equal(
      model.requests[1]!.messages.filter((message) => message.role === "user" && message.images)
        .length,
      1,
    );
    assert.equal(
      model.requests[2]!.messages.filter((message) => message.role === "user" && message.images)
        .length,
      1,
    );
    // Both results of the inspection batch come before its frame messages.
    const last = model.requests[2]!.messages;
    const batch = last.findIndex(
      (message) => message.role === "assistant" && message.toolCalls.length === 2,
    );
    assert.deepEqual(
      last
        .slice(batch + 1)
        .map((message) => (message.role === "tool" ? message.toolCallId : message.role)),
      ["d2", "d3", "user", "user"],
    );
    assert.doesNotMatch(JSON.stringify(model.requests), /deterministic|expectedIssue|holdout/u);
    const thinModel = fakeClient([
      [{ id: "f1", name: "workspace.finish", arguments: { summary: "Ready" } }],
    ]);
    await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: registered.publicTask,
      treatment: treatment(registered.publicTask, 0),
      modelClient: thinModel,
      verify,
    });
    assert.ok(thinModel.requests[0]!.tools.every((tool) => !tool.name.startsWith("development.")));
    await assert.rejects(
      runAgent({
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task: registered.publicTask,
        treatment: treatment(registered.publicTask, 0),
        modelClient: thinModel,
        verify,
        development,
      }),
      /has no Studio development runs/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
