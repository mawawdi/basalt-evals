import { criteriaSubmission } from "../packages/eval-authoring/src/preparation-request.js";
import { launchDefaults } from "../packages/operator/src/workflow.js";
import { addModel, setModelDefaults } from "../packages/operator/src/model-registry.js";
import { readFile, appendFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { sign } from "node:crypto";
import { existsSync } from "node:fs";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import { PNG } from "pngjs";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import {
  hashJson,
  contentHash,
  stableJson,
  type StudioCollectionPlan,
  type StudioObservation,
  type StudioFactRequest,
} from "../packages/contracts/src/index.js";
import { createEvalDraft, type EvalDraft } from "../packages/eval-authoring/src/index.js";
import type {
  EvaluationStageContext,
  PreparationRoles,
  PublicPreparation,
  PublicProposal,
  PrivateProposal,
} from "../packages/eval-authoring/src/proposals.js";
import type { ExecutionAdapters } from "../packages/operator/src/adapters.js";
import { modelRoute, type ModelSnapshot } from "../packages/model-client/src/catalog.js";
import {
  modelTurnRequestHash,
  type ModelTurnRequest,
  type ModelClient,
  type ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/openrouter-ai-sdk.js";
import { JUDGMENT_RETRIES } from "../packages/model-client/src/quote.js";
import {
  loadStudioSession,
  finalizeStudioEvidence,
  type StudioSubmission,
} from "../packages/studio-runner/src/index.js";
import type { SignedWorkerManifest } from "../packages/studio-runner/src/native-worker.js";
import { STUDIO_ADMISSIONS_FILE } from "../packages/studio-runner/src/adapter.js";
import { publishScreenRecording } from "../packages/studio-runner/src/screen-recording.js";
import type { SequencePlan, SequenceAssessment } from "../packages/studio-runner/src/sequence.js";

/** The bytes of the synthetic screen recording. The console only links to it. */
const syntheticRecording = Buffer.from("synthetic screen recording");

export const fixtureInput = {
  schema: "basalt-evals/eval-authoring-input" as const,
  title: "Blue Beacon",
  stages: [
    {
      prompt: "Create a blue Beacon part.",
      rubric: "- A Beacon object exists.\n- The Beacon looks blue.\n  - Evidence class: appearance",
    },
  ],
};

const draft = createEvalDraft(fixtureInput);
const roles = [
  {
    id: "beacon",
    className: "BasePart",
    scope: "workspace" as const,
    cardinality: "exactly_one" as const,
  },
];
const plan: StudioCollectionPlan = {
  schema: "basalt-evals/studio-plan",
  clients: 1,
  actors: ["primary"],
  roles,
  scenarios: [],
  phases: [
    {
      id: "scene",
      label: "Scene",
      instruction: "Capture the current scene.",
      driver: { kind: "wait_for_session", timeoutMs: 10000 },
      facts: [
        { id: "beacon", kind: "instance", path: "role.beacon" },
        { id: "beacon-name", kind: "instance_name", path: "role.beacon" },
      ],
      captures: [{ id: "scene", instruction: "Capture the scene." }],
    },
  ],
};
export const fixturePublic: PublicProposal = {
  publicTask: {
    schema: "basalt-evals/task",
    slug: draft.slug,
    title: draft.title,
    prompt: fixtureInput.stages[0]!.prompt,
    seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
    roles,
    acceptance: ["Create a blue Beacon part."],
    evidenceInstructions: ["Tag the Beacon part with the public Beacon role."],
  },
  publicScene: { parts: [] },
  publicDevelopment: {
    schema: "basalt-evals/public-development",
    task: { slug: draft.slug },
    plan: {
      ...plan,
      scenarios: [
        {
          id: "inspect",
          label: "Inspect the scene",
          durationMs: 2000,
          reportContexts: ["server", "primary"],
          steps: [
            {
              id: "observe",
              at: { startMs: 1000 },
              horizonMs: 1000,
              holdMs: 0,
              requirement: null,
              action: { kind: "wait" },
              observations: [],
            },
          ],
        },
      ],
    },
    views: [
      {
        id: "scene",
        scenarioId: "inspect",
        requiredTransitions: [],
        camera: null,
        viewport: null,
        maximumGapMs: 1000,
        frameBudget: 64,
      },
    ],
  },
};
export const fixturePrivate: PrivateProposal = {
  privateEvaluator: {
    sequence: null,
    schema: "basalt-evals/evaluator",
    task: { slug: draft.slug },
    studio: plan,
    deterministic: [
      {
        id: "beacon-exists",
        layer: "engine",
        statement: draft.stages[0]!.criteria[0]!.text,
        required: true,
        rule: {
          kind: "fact_equals",
          phaseId: "scene",
          factId: "beacon-name",
          field: "name",
          expected: "Beacon",
        },
      },
    ],
    codeQuality: [],
    visual: [],
    humanReview: [],
    unscaled: [
      {
        id: "beacon-blue",
        statement: draft.stages[0]!.criteria[1]!.text,
        required: true,
        evidenceClass: draft.stages[0]!.criteria[1]!.evidenceClass,
        polarity: draft.stages[0]!.criteria[1]!.polarity,
        evidence: {
          sequence: false,
          actions: [],
          sourceSelection: { kind: "all_luau_in_roots", roots: ["src"] },
          facts: [{ phaseId: "scene", factId: "beacon" }],
          captureIds: ["scene"],
        },
      },
    ],
  },
  criterionMappings: draft.stages[0]!.criteria.map((criterion, index) => ({
    authoredCriterionId: criterion.id,
    authoredClauseIds: criterion.clauses.map((clause) => clause.id),
    authority: { source: "human_rubric" as const, start: criterion.start, end: criterion.end },
    method: index === 0 ? ("deterministic" as const) : ("unscaled" as const),
    executableCriterionId: index === 0 ? "beacon-exists" : "beacon-blue",
    rationale: "Synthetic integration fixture with explicitly bound evidence.",
  })),
  requiredCapabilities: ["state_observation", "static_capture"],
};

/** The public preparation of a one-stage evaluation with the public part of the proposal. */
export function publicPreparation(proposal: PublicProposal): PublicPreparation {
  return {
    publicScene: proposal.publicScene,
    stages: [{ publicTask: proposal.publicTask, publicDevelopment: proposal.publicDevelopment }],
  };
}

/** The authored sources that the private preparation of stage 1 of a draft reads. */
export function stageSources(draft: EvalDraft): {
  builderPrompt: string;
  rubric: string;
  criteria: EvalDraft["stages"][number]["criteria"];
  evaluationStage: EvaluationStageContext;
} {
  const stage = draft.stages[0]!;
  return {
    builderPrompt: stage.prompt,
    rubric: stage.rubric,
    criteria: stage.criteria,
    evaluationStage: {
      index: 1,
      count: draft.stages.length,
      earlierPrompts: [],
      gateCriterionIds: stage.gateCriterionIds,
    },
  };
}

/** The input that a test gives to one complete private proposal for each private stage. */
interface StagedPrivateInput {
  stage: "plan" | "criteria";
  attempt: number;
  diagnostics: string[];
  publicProposal: PublicProposal;
  previousPrivateProposal: PrivateProposal | null;
}

/**
 * Test roles that serve both private stages from one complete private proposal. The plan stage
 * takes the plan of the proposal. The criteria stage takes its criteria and keeps the frozen plan.
 */
export function stagedPrivateRoles(
  prepare: (input: StagedPrivateInput) => PrivateProposal | Promise<PrivateProposal>,
): Pick<PreparationRoles, "preparePrivatePlan" | "preparePrivateCriteria"> {
  return {
    preparePrivatePlan: async (input) => {
      const proposal = await prepare({ ...input, previousPrivateProposal: null, stage: "plan" });
      return structuredClone({
        studio: proposal.privateEvaluator.studio,
        sequence: proposal.privateEvaluator.sequence,
      });
    },
    preparePrivateCriteria: async (input) => {
      const proposal = await prepare({ ...input, stage: "criteria" });
      return structuredClone({
        ...proposal,
        privateEvaluator: {
          ...proposal.privateEvaluator,
          studio: input.plan.studio,
          sequence: input.plan.sequence,
        },
      });
    },
  };
}

export function capabilityFixture(kind: "static" | "gui" | "multiplayer" | "causal") {
  const input = structuredClone(fixtureInput),
    publicProposal = structuredClone(fixturePublic),
    privateProposal = structuredClone(fixturePrivate);
  if (kind === "static") return { input, publicProposal, privateProposal };
  const collection = structuredClone(fixturePublic.publicDevelopment.plan);
  if (kind === "gui") {
    input.title = "Blue button";
    input.stages[0]!.prompt =
      "Create a blue button and a text entry field. The button accepts activation.";
    input.stages[0]!.rubric =
      "- The button accepts activation.\n- The button looks blue and emits no runtime errors.\n  - Evidence class: appearance";
    collection.roles = [
      {
        id: "beacon",
        className: "GuiObject",
        scope: "local_player_gui",
        cardinality: "exactly_one",
      },
      {
        id: "entry",
        className: "TextBox",
        scope: "local_player_gui",
        cardinality: "exactly_one",
      },
    ];
    collection.phases[0]!.facts = [{ id: "beacon", kind: "gui_geometry", path: "role.beacon" }];
    collection.scenarios[0]!.steps = [
      {
        id: "type",
        at: { startMs: 100 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "gui_text_entry", actor: "primary", path: "role.entry", text: "Hello" },
        observations: [
          { context: "primary", fact: { id: "text", kind: "gui_text", path: "role.entry" } },
        ],
      },
      {
        id: "activate",
        at: { startMs: 300 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "gui_activate", actor: "primary", path: "role.beacon" },
        observations: [
          {
            context: "primary",
            fact: { id: "geometry", kind: "gui_geometry", path: "role.beacon" },
          },
        ],
      },
      {
        id: "diagnostics",
        at: { startMs: 900 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "wait" },
        observations: [{ context: "primary", fact: { id: "errors", kind: "diagnostics" } }],
      },
    ];
    privateProposal.privateEvaluator.unscaled[0]!.evidence.facts.push({
      scenarioId: "inspect",
      stepId: "diagnostics",
      context: "primary",
      factId: "errors",
    });
    privateProposal.privateEvaluator.deterministic[0]!.rule = {
      kind: "scenario_action_succeeded",
      scenarioId: "inspect",
      stepId: "activate",
      actor: "primary",
    };
    privateProposal.requiredCapabilities = [
      "gui_activation",
      "gui_text_entry",
      "gui_geometry",
      "static_capture",
    ];
  } else if (kind === "causal") {
    input.title = "Server-created object";
    input.stages[0]!.prompt = "Create a Beacon from a server script during Play.";
    input.stages[0]!.rubric =
      "- A Beacon object exists.\n- Server source creates the Beacon.\n  - Evidence class: causality";
    privateProposal.privateEvaluator.unscaled[0]!.evidence.captureIds = [];
    collection.phases[0]!.facts.push({ id: "script-origin", kind: "diagnostics" });
    privateProposal.privateEvaluator.unscaled[0]!.evidence.facts.push({
      phaseId: "scene",
      factId: "script-origin",
    });
    collection.scenarios[0]!.steps = [
      {
        id: "approach",
        at: { startMs: 100 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "move_to", actor: "primary", targetPath: "role.beacon" },
        observations: [],
      },
    ];
    privateProposal.privateEvaluator.unscaled[0]!.evidence.actions = [
      { scenarioId: "inspect", stepId: "approach", context: "primary" },
    ];
  } else {
    input.title = "Two-player scene";
    input.stages[0]!.prompt = "Create a blue Beacon in a scene that admits two players.";
    input.stages[0]!.rubric =
      "- Two players are present.\n- The Beacon looks blue.\n  - Evidence class: appearance";
    collection.clients = 2;
    collection.actors = ["primary", "secondary"];
    collection.scenarios[0]!.reportContexts = ["server", "primary", "secondary"];
    collection.scenarios[0]!.steps = [
      {
        id: "observe",
        at: { startMs: 1000 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "wait" },
        observations: [{ context: "server", fact: { id: "players", kind: "player_count" } }],
      },
    ];
    privateProposal.privateEvaluator.deterministic[0]!.rule = {
      kind: "scenario_fact_equals",
      scenarioId: "inspect",
      stepId: "observe",
      context: "server",
      factId: "players",
      field: "value",
      expected: 2,
    };
    privateProposal.requiredCapabilities = ["multiplayer", "state_observation", "static_capture"];
  }
  const authored = createEvalDraft(input);
  publicProposal.publicTask = {
    ...publicProposal.publicTask,
    title: input.title,
    slug: authored.slug,
    prompt: input.stages[0]!.prompt,
    acceptance: [input.stages[0]!.prompt],
    roles: collection.roles,
  };
  publicProposal.publicDevelopment = {
    ...publicProposal.publicDevelopment,
    task: { slug: authored.slug },
    plan: collection,
  };
  privateProposal.privateEvaluator = {
    ...privateProposal.privateEvaluator,
    task: { slug: authored.slug },
    studio: collection,
  };
  if (kind === "gui" || kind === "multiplayer") {
    privateProposal.privateEvaluator.sequence = {
      scenarioId: "inspect",
      requiredTransitions: [],
      camera: null,
      viewport: { width: 800, height: 600 },
      maximumGapMs: 1000,
      frameBudget: 64,
    };
    privateProposal.privateEvaluator.unscaled[0]!.evidence.sequence = true;
    // GUI uses only the same-session sequence; multiplayer also exercises
    // combining the phase image with the two actor streams.
    if (kind === "gui") privateProposal.privateEvaluator.unscaled[0]!.evidence.captureIds = [];
  }
  privateProposal.privateEvaluator.deterministic[0]!.statement =
    authored.stages[0]!.criteria[0]!.text;
  privateProposal.privateEvaluator.unscaled[0]!.statement = authored.stages[0]!.criteria[1]!.text;
  privateProposal.privateEvaluator.unscaled[0]!.evidenceClass =
    authored.stages[0]!.criteria[1]!.evidenceClass;
  privateProposal.criterionMappings = authored.stages[0]!.criteria.map((criterion, index) => ({
    ...privateProposal.criterionMappings[index]!,
    authoredCriterionId: criterion.id,
    authoredClauseIds: criterion.clauses.map((clause) => clause.id),
    authority: { source: "human_rubric", start: criterion.start, end: criterion.end },
  }));
  return { input, publicProposal, privateProposal };
}

/** Visible candidate text at every synthetic capture. It routes review and makes no verdict. */
const syntheticSceneText = {
  complete: true,
  entries: [
    {
      path: "Workspace.Beacon.Label.Caption",
      className: "TextLabel" as const,
      layer: "BillboardGui" as const,
      owner: "candidate" as const,
      property: "Text" as const,
      text: "Beacon",
      visible: true,
    },
  ],
};

export function syntheticObservation(
  fact: StudioFactRequest,
  target: string | null | undefined,
  elapsedMs = 0,
): StudioObservation {
  const failed = target === "beacon-exists";
  if (fact.kind === "instance")
    return { factId: fact.id, kind: fact.kind, exists: true, className: "Part" };
  // A tagged wrong-name object is observed failure; an unresolved role is unknown.
  if (fact.kind === "instance_name")
    return { factId: fact.id, kind: fact.kind, exists: true, name: failed ? "Other" : "Beacon" };
  if (fact.kind === "gui_geometry")
    return {
      factId: fact.id,
      kind: fact.kind,
      exists: true,
      visible: true,
      x: 20,
      y: 20,
      width: 100,
      height: 40,
    };
  if (fact.kind === "gui_text")
    return { factId: fact.id, kind: fact.kind, exists: true, visible: true, text: "Hello" };
  if (fact.kind === "part_position")
    return {
      factId: fact.id,
      kind: fact.kind,
      exists: true,
      x: !failed && elapsedMs >= 1000 ? 2 : 0,
      y: 0,
      z: 0,
    };
  if (fact.kind === "player_count")
    return { factId: fact.id, kind: fact.kind, value: failed ? 1 : 2 };
  if (fact.kind === "replication_probe")
    return {
      factId: fact.id,
      kind: fact.kind,
      exists: true,
      value: "CheckpointA",
      observedFrom: "studio",
    };
  if (fact.kind === "diagnostics")
    return {
      factId: fact.id,
      kind: fact.kind,
      messages: fact.id === "script-origin" ? ["Synthetic plugin error"] : [],
      scriptErrors:
        fact.id === "script-origin"
          ? [
              {
                message: "Synthetic plugin error",
                stackTrace: "Plugin.Settings:142",
                source: {
                  kind: "script",
                  path: "synthetic_plugin.Settings",
                  className: "ModuleScript",
                  inDataModel: false,
                },
              },
            ]
          : [],
    };
  throw new Error("Synthetic adapter has no observation fixture for " + fact.kind);
}
/** The models of the offline tests. A person adds real models on the Models page. */
const FIXTURE_MODELS = [
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek 4.1 Flash" },
  { id: "xiaomi/mimo-v2.6-flash", name: "MiMo 2.6 Flash" },
  { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
];

/** A public catalog response for the fixture models. It needs no network. */
const fixtureCatalogFetch: typeof fetch = async () =>
  Response.json({
    data: FIXTURE_MODELS.map((model) => ({
      ...model,
      canonical_slug: `${model.id}-synthetic`,
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools", "seed", "response_format", "temperature", "top_p"],
      context_length: 2_000_000,
      pricing: { prompt: "0.000000001", completion: "0.000000001" },
    })),
  });

/** The model defaults of the offline tests. */
const FIXTURE_DEFAULTS = {
  builderModelIds: ["openai/gpt-6-luna"],
  gradingModelId: "xiaomi/mimo-v2.6-flash",
  preparationModelId: "openai/gpt-6-luna",
  coverageModelId: "xiaomi/mimo-v2.6-flash",
};

/** Add the fixture models and the defaults of the offline tests to a workspace. */
export async function seedModelRegistry(root: string): Promise<void> {
  for (const model of FIXTURE_MODELS) await addModel(root, model.id, fixtureCatalogFetch);
  await setModelDefaults(root, structuredClone(FIXTURE_DEFAULTS));
}

/** The launch defaults that `seedModelRegistry` saves. */
export const fixtureLaunchDefaults = launchDefaults(
  { models: [], defaults: structuredClone(FIXTURE_DEFAULTS) },
  { defaultHarnessId: "production" },
);

export const fixtureSnapshots: ModelSnapshot[] = FIXTURE_MODELS.map((model) => {
  const body = {
    id: model.id,
    name: model.name,
    revision: `${model.id}-synthetic`,
    capturedAt: "2026-09-25T00:00:00.000Z",
    inputModalities: ["text", "image"],
    reasoning: null,
    // A catalog recommendation exercises the explicit judge sampling identity.
    recommendedSampling: {
      temperature: 1,
      top_p: 0.95,
      top_k: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
    },
    endpoints: [
      {
        tag: model.id.startsWith("openai/") ? "openai" : "synthetic",
        provider: "Synthetic Test Adapter",
        quantization: "synthetic",
        contextLength: 2000000,
        maxPromptTokens: null,
        // The grounded observation tool admits 32,213 answer characters for 20 frames.
        maxOutputTokens: 32768,
        rawPricing: {},
        supportedParameters: ["tools", "seed", "response_format", "temperature", "top_p"],
        tiers: [
          {
            minPromptTokens: 0,
            temporal: null,
            inputPerTokenUsd: 1e-9,
            outputPerTokenUsd: 1e-9,
            imagePerImageUsd: 0,
            requestUsd: 0,
            cacheReadPerTokenUsd: null,
            cacheWritePerTokenUsd: null,
          },
        ],
      },
    ],
  };
  return { ...body, hash: hashJson(body) };
});

function result(
  request: ModelTurnRequest,
  client: ModelClient,
  name: string,
  args: unknown,
): ModelTurnResult {
  const message = {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: `synthetic-${hashJson(request).slice(0, 12)}`, name, arguments: args }],
  };
  return {
    kind: "assistant",
    requestHash: modelTurnRequestHash(request, client.descriptor),
    message,
    responseHash: hashJson(message),
    stopReason: "tool_calls",
    responseFacts: {
      requestedModel: request.model,
      resolvedModel: request.model,
      servingProvider: "Synthetic Test Adapter",
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId: `synthetic-${hashJson(request)}`,
      latencyMs: 1,
      retryCount: 0,
      finishReason: "tool_calls",
      continuationHash: null,
      continuationBytes: null,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1e-8,
    },
  };
}
export function fixtureAdapters(root: string): ExecutionAdapters {
  const files = new RepositoryFiles(root);
  const log = (value: unknown) =>
    appendFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), JSON.stringify(value) + "\n");
  // Each judgment batch gets its own client, and its retries use that client.
  let clients = 0;
  const malformedTarget = async (clientId: string) => {
    const file = resolve(root, ".basalt-evals/synthetic-failure-target");
    await writeFile(file, clientId, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return (await readFile(file, "utf8")) === clientId;
  };
  // The applied marker ends an injected failure. Only the request that creates it gets the value
  // true, so two concurrent requests cannot both inject one failure.
  const markApplied = async (kind: string) => {
    try {
      await writeFile(resolve(root, ".basalt-evals/synthetic-failure-applied"), kind, {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    // The next injected failure selects its own target.
    await rm(resolve(root, ".basalt-evals/synthetic-failure-target"), { force: true });
    return true;
  };
  const adapters: ExecutionAdapters = {
    async billing(generationId) {
      if (!generationId.startsWith("synthetic-"))
        throw new Error("External billing lookup prohibited in offline integration");
      await log({ kind: "billing_lookup", generationId });
      return { generationId, costUsd: 1e-8 };
    },
    async catalog(selections) {
      return selections.map(({ id }) => fixtureSnapshots.find((model) => model.id === id)!);
    },
    model(models) {
      const clientId = `${process.pid}-${(clients += 1)}`;
      const client: ModelClient = {
        observesDispatch: true,
        descriptor: openRouterModelClientDescriptor(
          models.map((model) => model.id),
          Object.fromEntries(models.map((model) => [model.id, modelRoute(model)])),
        ),
        async complete(request, signal, observer) {
          const failure = await files
            .json<{
              kind: "rate_limit" | "malformed_batch" | "cancel";
              /** Malformed judgment answers before recovery; all bounded attempts by default. */
              attempts?: number;
            }>(".basalt-evals/synthetic-failure.json")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          const applied = failure
            ? await readFile(
                resolve(root, ".basalt-evals/synthetic-failure-applied"),
                "utf8",
              ).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              })
            : null;
          // Judgment batches run concurrently. The malformed answers go to one batch only: the
          // client of the first batch request is the target, and its retries use that client.
          // Another failure goes to the first request that creates the applied marker.
          const inject =
            !!failure &&
            !applied &&
            (failure.kind === "malformed_batch"
              ? request.tools[0]?.name === "submit_judgment_batch" &&
                (await malformedTarget(clientId))
              : await markApplied(failure.kind));
          if (inject && failure.kind === "malformed_batch") {
            const attempt =
              Number(
                await readFile(
                  resolve(root, ".basalt-evals/synthetic-failure-attempts"),
                  "utf8",
                ).catch(() => "0"),
              ) + 1;
            await writeFile(
              resolve(root, ".basalt-evals/synthetic-failure-attempts"),
              String(attempt),
            );
            if (attempt === (failure.attempts ?? 1 + JUDGMENT_RETRIES))
              await markApplied(failure.kind);
          }
          await observer?.beforeDispatch();
          await log({
            kind: "model",
            model: request.model,
            request,
            requestHash: modelTurnRequestHash(request, client.descriptor),
          });
          if (inject) {
            if (failure.kind === "malformed_batch")
              return result(request, client, "submit_judgment_batch", { decisions: "[]" });
            if (failure.kind === "cancel")
              await new Promise<never>((_resolve, reject) => {
                if (signal?.aborted) reject(new Error("Synthetic request cancelled"));
                else
                  signal?.addEventListener(
                    "abort",
                    () => reject(new Error("Synthetic request cancelled")),
                    { once: true },
                  );
              });
            const original = result(request, client, "submit_public_proposal", {});
            return {
              kind: "provider_error",
              requestHash: original.requestHash,
              errorClass: "http_429",
              providerErrorType: null,
              message: "Explicit synthetic provider failure",
              retryable: false,
              responseFacts: {
                ...original.responseFacts!,
                responseId: null,
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
          const tool = request.tools[0]?.name;
          // The marker removes the phases of the private plan, and each correction is invalid.
          const preparationDefect = existsSync(
            resolve(root, ".basalt-evals/synthetic-preparation-defect"),
          );
          const user = request.messages.find((message) => message.role === "user");
          const { publicProposal, privateProposal } = capabilityFixture("static");
          if (tool === "submit_public_proposal") {
            const value = JSON.parse(String(user?.content));
            // Each stage gets the same public part. Code adds the prompt of each stage.
            return result(request, client, tool, {
              publicScene: publicProposal.publicScene,
              stages: (value.stagePrompts as string[]).map(() => ({
                publicTask: {
                  roles: publicProposal.publicTask.roles,
                  acceptance: publicProposal.publicTask.acceptance,
                  evidenceInstructions: publicProposal.publicTask.evidenceInstructions,
                },
                publicDevelopment: {
                  ...publicProposal.publicDevelopment,
                  task: { slug: value.slug },
                },
              })),
            });
          }
          if (tool === "submit_private_plan") {
            const studio = structuredClone(privateProposal.privateEvaluator.studio);
            if (preparationDefect) Reflect.deleteProperty(studio, "phases");
            return result(request, client, tool, {
              studio,
              sequence: privateProposal.privateEvaluator.sequence,
            });
          }
          if (tool === "submit_private_plan_correction") {
            const value = JSON.parse(String(user?.content));
            return result(request, client, tool, {
              baseHash: value.correctionBaseHash,
              edits: [
                {
                  op: "add",
                  path: "/studio/phases",
                  value: preparationDefect
                    ? "invalid"
                    : privateProposal.privateEvaluator.studio.phases,
                },
              ],
            });
          }
          if (tool === "submit_private_criteria") {
            const value = JSON.parse(String(user?.content));
            return result(request, client, tool, criteriaSubmission(privateProposal, value));
          }
          if (tool === "submit_private_criteria_correction") {
            const value = JSON.parse(String(user?.content));
            return result(request, client, tool, {
              baseHash: value.correctionBaseHash,
              edits: [
                {
                  op: "replace",
                  path: "/unscaled/0/evidence",
                  value: privateProposal.privateEvaluator.unscaled[0]!.evidence,
                },
              ],
            });
          }
          if (tool === "submit_coverage_notes") {
            // The tool lists the IDs that the request asks for: criteria, checks or both.
            const lists = (
              request.tools[0]!.parameters as {
                properties: Record<
                  string,
                  { items: { properties: Record<string, { enum?: string[] }> } }
                >;
              }
            ).properties;
            const mappings: Array<{ authoredCriterionId: string; executableCriterionId: string }> =
              JSON.parse(String(user?.content)).plan.criterionMappings;
            return result(request, client, tool, {
              ...(lists.criteria && {
                criteria: lists.criteria.items.properties.criterionId!.enum!.map((criterionId) => ({
                  criterionId,
                  evidenceFor: "Synthetic plan element.",
                  evidenceAgainst: "",
                  coverage: "matches",
                  promptSupport: "stated",
                  mixesClasses: false,
                  note: "Explicitly synthetic offline coverage note.",
                })),
              }),
              ...(lists.checks && {
                checks: lists.checks.items.properties.checkId!.enum!.map((checkId) => ({
                  checkId,
                  evidenceFor: "Synthetic plan element.",
                  evidenceAgainst: "",
                  support: "supports",
                  criterionIds: mappings
                    .filter((mapping) => mapping.executableCriterionId === checkId)
                    .map((mapping) => mapping.authoredCriterionId),
                  note: "Explicitly synthetic offline check note.",
                })),
              }),
            });
          }
          if (tool === "submit_failure_hypotheses") {
            // Each answer names the first observation of its criterion. Gaming is the hypothesis.
            const value = JSON.parse(String(user?.content));
            return result(request, client, tool, {
              criteria: value.criteria.map(
                (criterion: { criterionId: string; observations: Array<{ id: string }> }) => ({
                  criterionId: criterion.criterionId,
                  answers: value.questions.map((question: { id: string }) => ({
                    questionId: question.id,
                    evidenceFor: `Synthetic evidence from ${criterion.observations[0]?.id ?? "the plan"}.`,
                    evidenceAgainst: "",
                    value: question.id === "gaming" ? "yes" : "unclear",
                    observationIds: criterion.observations.slice(0, 1).map((row) => row.id),
                  })),
                }),
              ),
            });
          }
          if (tool === "submit_observations") {
            const context = JSON.parse(String(user?.content));
            return result(request, client, tool, {
              observations: [
                {
                  frameIds: context.intervals.map((frame: { frameId: string }) => frame.frameId),
                  description: "Synthetic visible blue square.",
                },
              ],
              limitations: ["Explicit synthetic fixture; no physical claim."],
            });
          }
          if (tool === "submit_judgment_batch") {
            const data = JSON.parse(String(user?.content));
            const image = user?.role === "user" ? user.images?.[0] : undefined;
            const blue = image
              ? PNG.sync.read(Buffer.from(image.dataBase64, "base64")).data[2] === 255
              : !!data.buildOutput.observation || data.buildOutput.sealedSources.length > 0;
            // A test can queue the answer of each next judge request. Each request takes one.
            const queue = resolve(root, ".basalt-evals/synthetic-judge-answers.json");
            const queued: string[] = existsSync(queue)
              ? JSON.parse(await readFile(queue, "utf8"))
              : [];
            if (queued.length) await writeFile(queue, JSON.stringify(queued.slice(1)));
            const answer = queued[0] ?? (blue ? "satisfied" : "violated");
            return result(request, client, tool, {
              addressedToEvaluator: { found: false, quote: null },
              decisions: data.criteria.map((criterion: { id: string; anchors: unknown }) => ({
                criterionId: criterion.id,
                verdict: criterion.anchors !== null ? "insufficient" : answer,
                score: criterion.anchors !== null ? (blue ? 7.25 : 2.5) : null,
                confidence: 1,
                rationale: "Explicitly synthetic offline test judgment.",
              })),
            });
          }
          if (tool === "submit_build_comparison") {
            const data = JSON.parse(String(user?.content));
            const images = user?.role === "user" ? (user.images ?? []) : [];
            // The wider first image is better. Equal widths give an insufficient answer.
            const width = (build: "A" | "B") => {
              const position: number | undefined =
                data.buildOutput.pairs[0]?.images[build === "A" ? 0 : 1] ??
                data.buildOutput.unpaired.find((item: { build: string }) => item.build === build)
                  ?.image;
              const image = position ? images[position - 1] : undefined;
              return image ? Buffer.from(image.dataBase64, "base64").readUInt32BE(16) : 0;
            };
            const [a, b] = [width("A"), width("B")];
            return result(request, client, tool, {
              addressedToEvaluator: { found: false, quote: null },
              better: a > b ? "A" : b > a ? "B" : "insufficient",
              rationale: "Explicitly synthetic offline build comparison.",
            });
          }
          if (tool === "submit_control_source") {
            const value = JSON.parse(String(user?.content));
            const target = value.control.targetCriterionId;
            return result(request, client, tool, {
              files: [
                {
                  path: "src/server/Main.server.luau",
                  text: `-- Synthetic ${value.control.kind} ${target ?? "valid"}\n`,
                },
              ],
              contrast: "Synthetic source contrast for integration only.",
              basis: "Explicitly synthetic test adapter; no Roblox behavior is claimed.",
              expectedDeterministic: {
                "beacon-exists": target === "beacon-exists" ? "rejected" : "verified",
              },
            });
          }
          const toolResults = request.messages.filter((message) => message.role === "tool");
          if (!toolResults.length) return result(request, client, "workspace.list", {});
          if (toolResults.length === 1) {
            const listing = JSON.parse(toolResults[0]!.content);
            const path = "src/server/BuilderMarker.server.luau";
            const prior = listing.files.find(
              (file: { path: string; hash: string }) => file.path === path,
            );
            // A repair starts from a build with the marker, so its source differs from the parent.
            return result(request, client, "workspace.write", {
              path,
              content: prior ? "-- synthetic repaired marker\n" : "-- synthetic builder marker\n",
              expectedHash: prior?.hash ?? null,
            });
          }
          if (
            request.tools.some((tool) => tool.name === "development.run") &&
            toolResults.length === 2
          )
            return result(request, client, "development.run", { scenarioId: "scene" });
          return result(request, client, "workspace.finish", {
            summary: "Synthetic builder completion.",
          });
        },
      };
      const complete = client.complete;
      client.complete = async (request, signal, observer) => {
        // A patch without its hash and text. Basalt refuses it three times and stops the build.
        if (
          existsSync(resolve(root, ".basalt-evals/synthetic-tool-refusal")) &&
          request.tools[0]?.name === "workspace.list"
        ) {
          await observer?.beforeDispatch();
          return result(request, client, "workspace.patch", {
            path: "src/server/Main.server.luau",
          });
        }
        const response = await complete(request, signal, observer);
        if (
          existsSync(resolve(root, ".basalt-evals/synthetic-output-limit")) &&
          request.tools[0]?.name === "workspace.list" &&
          response.kind === "assistant"
        ) {
          const message = { role: "assistant" as const, content: "", toolCalls: [] };
          return {
            ...response,
            message,
            responseHash: hashJson(message),
            stopReason: "max_tokens" as const,
            usage: { ...response.usage, outputTokens: 8192, reasoningTokens: 8191 },
            responseFacts: { ...response.responseFacts, finishReason: "length" },
          };
        }
        return response;
      };
      return client;
    },
    studio: {
      // The synthetic lane is free at once. It records its admission as the native lane does.
      async admit(input) {
        const queuedAt = input.queuedAt ?? new Date().toISOString(),
          admittedAt = new Date().toISOString();
        await appendFile(
          resolve(dirname(input.directory), STUDIO_ADMISSIONS_FILE),
          JSON.stringify({
            purpose: input.purpose,
            lane: 0,
            queuedAt,
            laneRequestedAt: admittedAt,
            admittedAt,
            waitedMs: Math.max(0, Date.parse(admittedAt) - Date.parse(queuedAt)),
          }) + "\n",
          { mode: 0o600 },
        );
        return { lane: 0, connectorUrl: "http://127.0.0.1:43123", async release() {} };
      },
      async capabilities() {
        return {
          host: {
            osVersion: "synthetic",
            osBuild: "synthetic",
            hardwareModel: "synthetic",
            gpus: [],
          },
          workers: [
            {
              id: "synthetic",
              lanes: [0],
              maxClients: 8,
              captureMethod: "studio_mcp_screenshot" as const,
              screenRecording: true,
              templateHash: contentHash("synthetic preferences template"),
            },
          ],
        };
      },
      async preflight() {
        // The synthetic Studio setup passes each read-only check.
        return [];
      },
      async identity() {
        const changed = await files.optional<{ artifactHash: string }>(
          ".basalt-evals/synthetic-connector.json",
        );
        return {
          studioVersion: "synthetic-test",
          environmentHash: contentHash("synthetic runner and isolated account"),
          connectorSourceHash: contentHash("synthetic connector source"),
          connectorArtifactHash:
            changed?.artifactHash ?? contentHash("synthetic connector artifact"),
        };
      },
      async reconcile(input) {
        return new RepositoryFiles(input.directory).json<SignedWorkerManifest>(
          "native/manifest.json",
        );
      },
      async run(input) {
        await log({ kind: "native", directory: relative(root, input.directory), synthetic: true });
        if (
          existsSync(resolve(root, ".basalt-evals/synthetic-readiness-failure")) &&
          relative(root, input.directory).startsWith(".basalt-evals/studio-readiness/")
        )
          throw new ExecutionFault({
            causeCode: "connector_unavailable",
            category: "startup",
            dependency: null,
            unit: { stage: "readiness", id: "synthetic-readiness" },
            evidenceRefs: [],
            recoveryActions: ["inspect", "resume"],
            explanation: "Synthetic readiness failure before spending starts.",
          });
        const session = await loadStudioSession(input.directory),
          sf = new RepositoryFiles(input.directory);
        const control = await files.optional<{ source: { targetCriterionId: string | null } }>(
          relative(root, resolve(dirname(input.directory), "source.json")),
        );
        const target = control?.source.targetCriterionId;
        const scene = existsSync(resolve(root, ".basalt-evals/synthetic-scene"));
        const largeImages = existsSync(resolve(root, ".basalt-evals/synthetic-large-images"));
        const image = new PNG({
          width: largeImages ? 1024 : scene ? 1280 : 32,
          height: largeImages ? 768 : scene ? 720 : 32,
        });
        for (let i = 0; i < image.data.length; i += 4) {
          image.data[i] = target === "beacon-blue" ? 255 : 0;
          image.data[i + 2] = target === "beacon-blue" ? 0 : 255;
          image.data[i + 3] = 255;
        }
        if (scene) {
          // Deterministic visual fixture: geometry provides a useful viewport for UX checks.
          const polygon = (points: number[][], color: number[]) => {
            for (let y = 0; y < image.height; y++)
              for (let x = 0; x < image.width; x++) {
                let inside = false;
                for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                  const a = points[i]!,
                    b = points[j]!;
                  if (
                    a[1]! > y !== b[1]! > y &&
                    x < ((b[0]! - a[0]!) * (y - a[1]!)) / (b[1]! - a[1]!) + a[0]!
                  )
                    inside = !inside;
                }
                if (inside) {
                  const offset = (y * image.width + x) * 4;
                  image.data.set([...color, 255], offset);
                }
              }
          };
          polygon(
            [
              [0, 0],
              [1280, 0],
              [1280, 720],
              [0, 720],
            ],
            [174, 198, 207],
          );
          polygon(
            [
              [0, 305],
              [1280, 305],
              [1280, 720],
              [0, 720],
            ],
            [184, 194, 181],
          );
          polygon(
            [
              [384, 495],
              [704, 401],
              [955, 524],
              [597, 633],
            ],
            [139, 153, 139],
          );
          polygon(
            [
              [498, 277],
              [650, 233],
              [773, 294],
              [621, 343],
            ],
            target === "beacon-blue" ? [239, 118, 94] : [65, 147, 249],
          );
          polygon(
            [
              [498, 277],
              [621, 343],
              [621, 509],
              [498, 435],
            ],
            target === "beacon-blue" ? [167, 60, 42] : [27, 78, 176],
          );
          polygon(
            [
              [621, 343],
              [773, 294],
              [773, 455],
              [621, 509],
            ],
            target === "beacon-blue" ? [209, 80, 55] : [36, 109, 225],
          );
          // The synthetic judge's fixed color oracle is outside the depicted scene.
          image.data[0] = target === "beacon-blue" ? 255 : 0;
          image.data[1] = 0;
          image.data[2] = target === "beacon-blue" ? 0 : 255;
        }
        const bytes = PNG.sync.write(image, largeImages ? { deflateLevel: 0 } : {}),
          hash = contentHash(bytes),
          signed: string[] = [];
        const startedAt = "2026-09-25T00:00:00.000Z",
          endedAt = "2026-09-25T00:00:02.000Z";
        const submission: StudioSubmission = {
          schema: "basalt-evals/studio-submission",
          sessionId: session.id,
          studioVersion: session.expectedStudioVersion,
          startedAt,
          endedAt,
          phases: [],
        };
        for (const phase of session.plan.phases) {
          const observations = phase.facts.map((fact) => syntheticObservation(fact, target));
          const captures = [];
          for (const capture of phase.captures) {
            const file = `captures/${hashJson({ phaseId: phase.id, captureId: capture.id })}-${hash}.image`;
            await sf.write(file, bytes);
            signed.push(file);
            captures.push({ captureId: capture.id, hash, sceneText: syntheticSceneText });
          }
          submission.phases.push({ phaseId: phase.id, observations, captures });
        }
        await sf.writeJson("submission.json", submission);
        signed.push("submission.json");
        // The Studio clock of the synthetic scenarios starts with the evidence.
        const startAt = Date.parse(startedAt) / 1000;
        for (const scenario of session.plan.scenarios) {
          const evidence = {
            scenarioId: scenario.id,
            startedAt,
            endedAt,
            reports: scenario.reportContexts.map((context) => ({
              context,
              startAt,
              actors: session.plan.actors.map((actor, index) => ({
                actor,
                userId: -index - 1,
                name: `Synthetic${index + 1}`,
              })),
              steps: scenario.steps.map((step, index) => {
                // Clock steps keep their offset. Anchored steps follow 100 ms apart.
                const offsetMs = "startMs" in step.at ? step.at.startMs : 100 * (index + 1);
                const scheduledAt = startAt + offsetMs / 1000;
                const observations = step.observations
                  .filter((item) => item.context === context)
                  .map((item) => syntheticObservation(item.fact, target, offsetMs));
                return {
                  stepId: step.id,
                  outcome: "observed",
                  dueAt: scheduledAt,
                  anchorObservedAt: startAt,
                  scheduledAt,
                  ...(step.action.kind !== "wait" && step.action.actor === context
                    ? {
                        actedAt: scheduledAt,
                        action: {
                          kind: step.action.kind,
                          succeeded: !(
                            target === "beacon-exists" && step.action.kind === "gui_activate"
                          ),
                        },
                      }
                    : {}),
                  ...(observations.length ? { capturedAt: scheduledAt } : {}),
                  observations,
                };
              }),
            })),
          };
          const file = `runtime/${scenario.id}/evidence.json`;
          await sf.writeJson(file, evidence);
          signed.push(file);
        }
        const sequence = await sf.optional<SequencePlan>("sequence.json");
        if (sequence) {
          signed.push("sequence.json");
          const prefix = `native/sequence/${sequence.scenarioId}-attempt-01/`;
          const frames = session.plan.actors.flatMap((actor, actorIndex) =>
            [0, 1000].map((offset, index) => ({
              file: `frame-${actor}-${index}.png`,
              hash,
              bytes: bytes.length,
              mediaType: "image/png",
              width: image.width,
              height: image.height,
              playerUserId: -actorIndex - 1,
              studioId: "synthetic",
              startedAt: new Date(Date.parse(startedAt) + offset).toISOString(),
              endedAt: new Date(Date.parse(startedAt) + offset + 50).toISOString(),
            })),
          );
          for (const frame of frames) {
            await sf.write(prefix + frame.file, bytes);
            signed.push(prefix + frame.file);
          }
          await sf.writeJson(prefix + "index.json", {
            schema: "basalt-evals/sequence-acquisition",
            placeFile: session.place.file,
            startedAt,
            endedAt,
            expectedClients: session.plan.clients,
            status: "complete",
            reason: null,
            frames,
            clockProbes: [],
          });
          const assessment: SequenceAssessment = {
            schema: "basalt-evals/sequence-assessment",
            planHash: hashJson(sequence),
            status: "sufficient",
            reasons: [],
            actorFrames: session.plan.actors.map((actor, index) => ({
              actor,
              userId: -index - 1,
              frameCount: 2,
              dimensions: ["32x32"],
              cameraSamples: 2,
              avatarSamples: 2,
              gameViewports: ["32x32"],
            })),
            clock: { offsetMs: 0, uncertaintyMs: 50 },
            transitions: [],
            stateChanges: [],
          };
          await sf.writeJson(prefix + "assessment.json", assessment);
          signed.push(prefix + "index.json", prefix + "assessment.json");
        }
        await finalizeStudioEvidence({ sessionDirectory: input.directory });
        signed.push("evidence.json");
        const publicKey = (
          await files.bytes(".basalt-evals/native-worker/isolated-public-key.pem")
        ).toString();
        const receipt: SignedWorkerManifest = {
          publicKey,
          signature: "",
          manifest: {
            schema: "basalt-evals/native-worker",
            jobId: hashJson(session).slice(0, 32),
            sessionId: session.id,
            candidateHash: session.candidateHash,
            collectionPlanHash: session.collectionPlanHash,
            runnerHash: contentHash("synthetic test adapter"),
            startedAt,
            completedAt: endedAt,
            status: "complete",
            failure: null,
            failureRecord: null,
            processes: [],
            completion: { trialId: "synthetic-integration", submissionHash: hashJson(submission) },
            artifacts: await Promise.all(
              signed.map(async (file) => {
                const data = await sf.bytes(file);
                return { file, hash: contentHash(data), bytes: data.length };
              }),
            ),
            preferences: {
              templateHash: contentHash("synthetic preferences template"),
              reset: "applied",
            },
            screenRecording: {
              status: "recorded",
              failure: null,
              bytes: syntheticRecording.length,
              hash: contentHash(syntheticRecording),
            },
          },
        };
        // An observation gets a synthetic screen recording beside its session, as an import does.
        if (relative(root, input.directory).includes("/capture/")) {
          const staged = resolve(dirname(input.directory), "screen-staged.mp4");
          await writeFile(staged, syntheticRecording);
          await publishScreenRecording({
            staged,
            directory: dirname(input.directory),
            recording: receipt.manifest.screenRecording,
            lane: 0,
            worker: "synthetic",
          }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          await rm(staged, { force: true });
        }
        receipt.signature = sign(
          null,
          Buffer.from(stableJson(receipt.manifest)),
          await readFile(resolve(root, ".basalt-evals/synthetic-private-key.pem")),
        ).toString("base64");
        await sf.writeJson("native/manifest.json", receipt);
        return receipt;
      },
    },
  };
  return adapters;
}
