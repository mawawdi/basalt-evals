import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createEvalDraft } from "../packages/eval-authoring/src/index.js";
import { prepareEvalDraft } from "../packages/agent-runtime/src/eval-preparation.js";
import {
  modelPreparationRoles,
  type PreparationDispatcher,
} from "../packages/agent-runtime/src/preparation-models.js";
import type { ModelTurnRequest, ModelTurnResult } from "../packages/model-client/src/contracts.js";
import {
  PREPARATION_ATTEMPTS,
  preparationRequests,
} from "../packages/eval-authoring/src/preparation-request.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { criteriaSubmission } from "../packages/eval-authoring/src/preparation-request.js";
import {
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  publicPreparation,
  stagedPrivateRoles,
  stageSources,
} from "./shared-api-fixture.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type { EvalAuthoringInput } from "../packages/eval-authoring/src/input.js";

test("retained moving-platform responses compile through the complete preparation path with one plan correction", async () => {
  const fixture = JSON.parse(
    await readFile(resolve("test/fixtures/preparation/moving-platform.json"), "utf8"),
  ) as {
    input: EvalAuthoringInput;
    publicSubmissions: Record<string, unknown>[];
    privatePlanSubmissions: Record<string, unknown>[];
    privateCriteriaSubmissions: Record<string, unknown>[];
  };
  const draft = createEvalDraft(fixture.input);
  const counts = { prepare_public: 0, prepare_private_plan: 0, prepare_private_criteria: 0 };
  const answers = {
    prepare_public: fixture.publicSubmissions,
    prepare_private_plan: fixture.privatePlanSubmissions,
    prepare_private_criteria: fixture.privateCriteriaSubmissions,
  };
  const dispatcher = {
    async complete(stage: keyof typeof counts, request: ModelTurnRequest) {
      const index = counts[stage]++;
      const context = JSON.parse(request.messages[0]!.content);
      assert.ok(index < answers[stage].length, "no extra generation or correction");
      if (stage === "prepare_public") {
        assert.ok(!Object.hasOwn(context, "rubric"));
      } else if (stage === "prepare_private_plan" && index === 1) {
        assert.match(context.diagnostics.join("\n"), /\/studio\/phases/);
        assert.equal(context.correctionBaseHash, fixture.privatePlanSubmissions[1]!.baseHash);
      } else if (stage === "prepare_private_criteria") {
        assert.deepEqual(context.plan.studio.phases.length, 1);
      }
      return {
        kind: "assistant",
        stopReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "retained-offline",
              name: request.tools[0]!.name,
              arguments: structuredClone(answers[stage][index]),
            },
          ],
        },
      } as ModelTurnResult;
    },
  } as unknown as PreparationDispatcher;
  const result = await prepareEvalDraft(
    draft,
    modelPreparationRoles({
      dispatcher,
      publicModel: { id: "offline", maxOutputTokens: 16_384 },
      privateModel: { id: "offline", maxOutputTokens: 16_384 },
      seed: 1,
    }),
  );
  assert.equal(result.validation.status, "ready", JSON.stringify(result.validation));
  assert.deepEqual(counts, {
    prepare_public: 1,
    prepare_private_plan: 2,
    prepare_private_criteria: 1,
  });
  assert.ok(result.revisions[0]);
  assert.equal(result.revisions[0].publicTask.prompt, fixture.input.stages[0]!.prompt);
  assert.equal(result.revisions[0].criterionMappings.length, draft.stages[0]!.criteria.length);
});

test("malformed private submissions retain their exact correction base in their own stage", async () => {
  for (const defect of [
    "missing_phases",
    "array_source_selection",
    "invalid_correction",
  ] as const) {
    const draft = createEvalDraft(fixtureInput);
    const sources = stageSources(draft);
    const plan = structuredClone({
      studio: fixturePrivate.privateEvaluator.studio,
      sequence: fixturePrivate.privateEvaluator.sequence,
    });
    const criteria = criteriaSubmission(fixturePrivate, sources);
    const planStage = defect !== "array_source_selection";
    const defective = planStage ? "prepare_private_plan" : "prepare_private_criteria";
    const malformed = structuredClone(planStage ? plan : criteria) as Record<string, unknown>;
    if (planStage) Reflect.deleteProperty(malformed.studio as object, "phases");
    else
      Object.assign(
        (malformed.unscaled as Array<{ evidence: Record<string, unknown> }>)[0]!.evidence,
        { sourceSelection: [] },
      );
    const stages: string[] = [];
    const dispatcher = {
      async complete(stage: string, request: ModelTurnRequest) {
        const index = stages.filter((item) => item === stage).length;
        stages.push(stage);
        const context = JSON.parse(request.messages[0]!.content);
        // Every later request of the defective stage is a correction of the retained submission.
        const correction = stage === defective && index >= 1;
        if (stage === defective && index === 1) {
          assert.equal(request.tools[0]!.name, `submit_${stage.slice(8)}_correction`);
          assert.deepEqual(context.previousSubmission, malformed);
          assert.equal(context.correctionBaseHash, hashJson(malformed));
          assert.match(context.diagnostics.join(" "), planStage ? /phases/ : /sourceSelection/);
        }
        const answer =
          stage !== defective
            ? stage === "prepare_private_plan"
              ? plan
              : criteria
            : correction
              ? {
                  baseHash: context.correctionBaseHash,
                  edits: [
                    planStage
                      ? {
                          op: "add",
                          path: "/studio/phases",
                          value: defect === "invalid_correction" ? "invalid" : plan.studio.phases,
                        }
                      : {
                          op: "replace",
                          path: "/unscaled/0/evidence/sourceSelection",
                          value: null,
                        },
                  ],
                }
              : malformed;
        return {
          kind: "assistant",
          stopReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "offline", name: request.tools[0]!.name, arguments: answer }],
          },
        } as ModelTurnResult;
      },
    } as unknown as PreparationDispatcher;
    const roles = modelPreparationRoles({
      dispatcher,
      publicModel: { id: "planner", maxOutputTokens: 16_384 },
      privateModel: { id: "planner", maxOutputTokens: 16_384 },
      seed: 1,
    });
    const result = await prepareEvalDraft(draft, {
      ...roles,
      preparePublic: async () => publicPreparation(structuredClone(fixturePublic)),
    });
    const attempts = defect === "invalid_correction" ? PREPARATION_ATTEMPTS : 2;
    assert.equal(
      stages.filter((stage) => stage === defective).length,
      attempts,
      "a valid correction ends the corrections",
    );
    assert.equal(
      result.validation.status,
      defect === "invalid_correction" ? "preparation_failed" : "ready",
      JSON.stringify(result.validation),
    );
    assert.deepEqual(result.attempts, {
      public: 1,
      stages: [
        {
          privatePlan: planStage ? attempts : 1,
          privateCriteria: defect === "invalid_correction" ? 0 : planStage ? 1 : attempts,
        },
      ],
    });
  }
});

test("a public answer with a shape error gets an edit correction of exactly that answer", async () => {
  const draft = createEvalDraft(fixtureInput);
  const valid = {
    publicScene: fixturePublic.publicScene,
    stages: [
      {
        publicTask: {
          roles: fixturePublic.publicTask.roles,
          acceptance: fixturePublic.publicTask.acceptance,
          evidenceInstructions: fixturePublic.publicTask.evidenceInstructions,
        },
        publicDevelopment: { ...fixturePublic.publicDevelopment, task: { slug: draft.slug } },
      },
    ],
  };
  const malformed = structuredClone(valid);
  Reflect.deleteProperty(malformed.stages[0]!.publicDevelopment, "views");
  const requests: ModelTurnRequest[] = [];
  const dispatcher = {
    async complete(stage: string, request: ModelTurnRequest) {
      assert.equal(stage, "prepare_public");
      requests.push(request);
      const context = JSON.parse(request.messages[0]!.content);
      const correction = requests.length === 2;
      if (correction) {
        assert.equal(request.tools[0]!.name, "submit_public_correction");
        assert.deepEqual(context.previousProposal, malformed);
        assert.equal(context.correctionBaseHash, hashJson(malformed));
        assert.match(context.diagnostics.join(" "), /views/);
      }
      return {
        kind: "assistant",
        stopReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "offline",
              name: request.tools[0]!.name,
              arguments: correction
                ? {
                    baseHash: context.correctionBaseHash,
                    edits: [
                      {
                        op: "add",
                        path: "/stages/0/publicDevelopment/views",
                        value: valid.stages[0]!.publicDevelopment.views,
                      },
                    ],
                  }
                : malformed,
            },
          ],
        },
      } as ModelTurnResult;
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const result = await prepareEvalDraft(draft, {
    ...roles,
    ...stagedPrivateRoles(() => structuredClone(fixturePrivate)),
  });
  assert.equal(requests.length, 2);
  assert.equal(result.attempts.public, 2);
  assert.equal(result.validation.status, "ready", JSON.stringify(result.validation));
});

test("a stopped runaway answer with a known charge leads to a new attempt", async () => {
  const draft = createEvalDraft(fixtureInput);
  const valid = {
    publicScene: fixturePublic.publicScene,
    stages: [
      {
        publicTask: {
          roles: fixturePublic.publicTask.roles,
          acceptance: fixturePublic.publicTask.acceptance,
          evidenceInstructions: fixturePublic.publicTask.evidenceInstructions,
        },
        publicDevelopment: { ...fixturePublic.publicDevelopment, task: { slug: draft.slug } },
      },
    ],
  };
  const requests: ModelTurnRequest[] = [];
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest) {
      requests.push(request);
      if (requests.length === 1)
        return {
          kind: "provider_error",
          errorClass: "runaway_output",
          providerErrorType: null,
          message: "The model output has a long run of whitespace.",
          retryable: false,
          requestHash: "a".repeat(64),
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            costUsd: 0.01,
          },
          responseFacts: {
            requestedModel: request.model,
            resolvedModel: request.model,
            servingProvider: "test",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "generation-runaway",
            latencyMs: 1,
            retryCount: 0,
            finishReason: null,
            continuationHash: null,
            continuationBytes: null,
          },
        } as ModelTurnResult;
      return {
        kind: "assistant",
        stopReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "offline", name: request.tools[0]!.name, arguments: valid }],
        },
      } as ModelTurnResult;
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const result = await prepareEvalDraft(draft, {
    ...roles,
    ...stagedPrivateRoles(() => structuredClone(fixturePrivate)),
  });
  assert.equal(requests.length, 2);
  // Without a base, the next attempt is a complete strict proposal again.
  assert.equal(requests[1]!.tools[0]!.name, "submit_public_proposal");
  assert.equal(requests[1]!.tools[0]!.strict, true);
  assert.match(
    JSON.parse(requests[1]!.messages[0]!.content as string).diagnostics.join(" "),
    /long run of whitespace, so Basalt stopped it/,
  );
  assert.equal(result.validation.status, "ready", JSON.stringify(result.validation));
});

test("edits that Basalt cannot apply keep the base and its errors, and say why", async () => {
  const draft = createEvalDraft(fixtureInput);
  const valid = {
    publicScene: fixturePublic.publicScene,
    stages: [
      {
        publicTask: {
          roles: fixturePublic.publicTask.roles,
          acceptance: fixturePublic.publicTask.acceptance,
          evidenceInstructions: fixturePublic.publicTask.evidenceInstructions,
        },
        publicDevelopment: { ...fixturePublic.publicDevelopment, task: { slug: draft.slug } },
      },
    ],
  };
  const malformed = structuredClone(valid);
  Reflect.deleteProperty(malformed.stages[0]!.publicDevelopment, "views");
  const contexts: Array<Record<string, unknown>> = [];
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest) {
      const context = JSON.parse(request.messages[0]!.content) as Record<string, unknown>;
      contexts.push(context);
      const answer =
        contexts.length === 1
          ? malformed
          : {
              baseHash: context.correctionBaseHash,
              edits:
                contexts.length === 2
                  ? [{ op: "remove", path: "/stages/0/publicDevelopment/absent" }]
                  : [
                      {
                        op: "add",
                        path: "/stages/0/publicDevelopment/views",
                        value: valid.stages[0]!.publicDevelopment.views,
                      },
                    ],
            };
      return {
        kind: "assistant",
        stopReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "offline", name: request.tools[0]!.name, arguments: answer }],
        },
      } as ModelTurnResult;
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const result = await prepareEvalDraft(draft, {
    ...roles,
    ...stagedPrivateRoles(() => structuredClone(fixturePrivate)),
  });
  assert.equal(contexts.length, 3);
  assert.equal(contexts[2]!.correctionBaseHash, hashJson(malformed));
  const diagnostics = (contexts[2]!.diagnostics as string[]).join("\n");
  assert.match(diagnostics, /views/);
  assert.match(
    diagnostics,
    /Basalt did not apply your edits, so the base did not change: Public correction edit 0 \(remove \/stages\/0\/publicDevelopment\/absent\): the field to remove is absent/,
  );
  assert.equal(result.validation.status, "ready", JSON.stringify(result.validation));
});

test("a repair reaches an answer that the shape check would reject, so no correction is needed", async () => {
  const draft = createEvalDraft(fixtureInput);
  const misplacedDevelopment: Record<string, unknown> = {
    ...fixturePublic.publicDevelopment,
    task: { slug: draft.slug },
    plan: {
      ...fixturePublic.publicDevelopment.plan,
      views: fixturePublic.publicDevelopment.views,
      scenarios: fixturePublic.publicDevelopment.plan.scenarios.map((scenario) => ({
        ...scenario,
        requirement: null,
      })),
    },
  };
  Reflect.deleteProperty(misplacedDevelopment, "views");
  const misplaced = {
    publicScene: fixturePublic.publicScene,
    stages: [
      {
        publicTask: {
          roles: fixturePublic.publicTask.roles,
          acceptance: fixturePublic.publicTask.acceptance,
          evidenceInstructions: fixturePublic.publicTask.evidenceInstructions,
        },
        publicDevelopment: misplacedDevelopment,
      },
    ],
  };
  let requests = 0;
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest) {
      requests += 1;
      return {
        kind: "assistant",
        stopReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "offline", name: request.tools[0]!.name, arguments: misplaced }],
        },
      } as ModelTurnResult;
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const result = await prepareEvalDraft(draft, {
    ...roles,
    ...stagedPrivateRoles(() => structuredClone(fixturePrivate)),
  });
  assert.equal(requests, 1);
  assert.equal(result.attempts.public, 1);
  assert.equal(result.validation.status, "ready", JSON.stringify(result.validation));
  assert.ok(
    result.normalizations.includes("Moved public views from the plan into publicDevelopment"),
  );
  assert.equal(
    result.normalizations.filter((note) => note.startsWith("Removed the empty requirement")).length,
    fixturePublic.publicDevelopment.plan.scenarios.length,
  );
});

test("public preparation receives the actual supplied seed and acquisition semantics", () => {
  const requests = preparationRequests({
    publicModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    privateModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    seed: 42,
  });
  const builderPrompt = "Create a blue part visible from the supplied spawn.";
  const planning = requests.preparePublic({
    stagePrompts: [builderPrompt],
    title: "Visible part",
    slug: "visible-part",
    attempt: 1,
    diagnostics: [],
    previousProposal: null,
  });
  for (const request of [planning]) {
    const context = JSON.parse(request.messages[0]!.content);
    assert.deepEqual(context.neutralSeed, neutralRojoSeed("Basalt public environment"));
    assert.ok(!Object.hasOwn(context, "rubric"));
    assert.ok(!Object.hasOwn(context, "criteria"));
    assert.match(request.system, /already supplies Ground and EvalSpawn/u);
    assert.match(request.system, /Rendered captures can support color and visibility/u);
    assert.match(request.system, /does not assign private rubric judgments/u);
    assert.match(request.system, /Source inspection is supplied outside the Studio plan/u);
    assert.match(
      request.system,
      /final evaluation and control grading can bind hash-verified sealed Luau/u,
    );
    assert.match(request.system, /dense short trajectory in addition to any long route window/u);
  }
});

test("a final rate limit stops preparation without a correction attempt", async () => {
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: "Create a blue part visible from spawn.",
        rubric: "The player can see the blue part from spawn.",
      },
    ],
  });
  let calls = 0;
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest): Promise<ModelTurnResult> {
      calls += 1;
      return {
        kind: "provider_error",
        requestHash: "a".repeat(64),
        errorClass: "http_429",
        providerErrorType: null,
        message: "Rate limited",
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
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    privateModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    seed: 9,
  });
  await assert.rejects(
    prepareEvalDraft(draft, roles),
    /rate limit \(http_429\) after all tries\. Basalt recorded no charge\./u,
  );
  assert.equal(calls, 1);
});

test("public preparation constrains human-facing fields without exposing the rubric", async () => {
  const capture: { request?: ModelTurnRequest } = {};
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest) {
      capture.request = request;
      throw new Error("captured public request");
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    privateModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    seed: 42,
  });
  await assert.rejects(
    roles.preparePublic({
      stagePrompts: ["Build a moving platform."],
      title: "Moving platform",
      slug: "moving-platform",
      attempt: 1,
      diagnostics: [],
      previousProposal: null,
    }),
    /captured public request/,
  );
  assert.ok(capture.request);
  assert.match(capture.request.system, /least restrictive role class/u);
  assert.match(capture.request.system, /rendered capture without requiring a TextLabel/u);
  assert.match(capture.request.system, /wait_for_session readiness/u);
  assert.match(capture.request.system, /Never list either name in publicScene.parts/u);
  assert.match(
    capture.request.system,
    /wait_for_exists phase may use its public role instance fact/u,
  );
  assert.match(capture.request.system, /allow the camera to aim within that viewpoint/u);
  assert.match(capture.request.system, /its task is \{slug\} with no other fields/u);
  const publicInput = JSON.parse(capture.request.messages[0]!.content) as Record<string, unknown>;
  assert.deepEqual(publicInput.stagePrompts, ["Build a moving platform."]);
  assert.ok(!Object.hasOwn(publicInput, "rubric"));
  const parameters = capture.request.tools[0]?.parameters as {
    properties: { stages: { minItems: number; maxItems: number; items: unknown } };
  };
  assert.equal(parameters.properties.stages.minItems, 1);
  assert.equal(parameters.properties.stages.maxItems, 1);
  const schema = parameters.properties.stages.items as {
    properties: {
      publicTask: {
        properties: {
          acceptance: { type: string; items: { type: string } };
          evidenceInstructions: { type: string; items: { type: string } };
        };
      };
      publicDevelopment: {
        properties: {
          schema: { enum: string[] };
          task: {
            type: string;
            properties: Record<string, unknown>;
            additionalProperties: boolean;
          };
          plan: {
            properties: {
              schema: { enum: string[] };
              scenarios: {
                items: {
                  properties: {
                    steps: {
                      items: {
                        properties: {
                          action: { oneOf: Array<{ properties: { kind: { enum: string[] } } }> };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
          views: { type: string };
        };
      };
    };
  };
  assert.equal(schema.properties.publicTask.properties.acceptance.type, "array");
  assert.equal(schema.properties.publicTask.properties.acceptance.items?.type, "string");
  assert.equal(schema.properties.publicTask.properties.evidenceInstructions.type, "array");
  assert.equal(schema.properties.publicTask.properties.evidenceInstructions.items?.type, "string");
  assert.deepEqual(schema.properties.publicDevelopment.properties.schema.enum, [
    "basalt-evals/public-development",
  ]);
  assert.deepEqual(Object.keys(schema.properties.publicDevelopment.properties.task.properties), [
    "slug",
  ]);
  assert.equal(schema.properties.publicDevelopment.properties.task.additionalProperties, false);
  assert.deepEqual(schema.properties.publicDevelopment.properties.plan.properties.schema.enum, [
    "basalt-evals/studio-plan",
  ]);
  assert.ok(
    schema.properties.publicDevelopment.properties.plan.properties.scenarios.items.properties.steps.items.properties.action.oneOf.some(
      (variant) => variant.properties.kind.enum.includes("move_to"),
    ),
  );
  assert.equal(schema.properties.publicDevelopment.properties.views.type, "array");
});

test("private tool schema exposes fixed actions, rules, source selectors and limits", async () => {
  const capture: { request?: ModelTurnRequest } = {};
  const dispatcher = {
    async complete(_stage: string, request: ModelTurnRequest) {
      capture.request = request;
      throw new Error("captured private request");
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    privateModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    seed: 42,
  });
  await assert.rejects(
    roles.preparePrivatePlan({
      builderPrompt: "Build a GUI",
      rubric: "The GUI is visible",
      criteria: [],
      evaluationStage: { index: 1, count: 1, earlierPrompts: [], gateCriterionIds: [] },
      publicProposal: {
        publicTask: {} as never,
        publicDevelopment: {} as never,
        publicScene: { parts: [] },
      },
      previousPlan: null,
      attempt: 1,
      diagnostics: [],
    }),
    /captured private request/,
  );
  assert.match(capture.request?.system ?? "", /studio\.schema must be basalt-evals\/studio-plan/u);
  assert.match(capture.request?.system ?? "", /^This is the plan stage\. Submit only studio/u);
  assert.equal(capture.request?.tools[0]?.name, "submit_private_plan");
  assert.match(capture.request?.system ?? "", /required concrete-class check must agree/u);
  assert.match(
    capture.request?.system ?? "",
    /Private acquisition is independent of public development/u,
  );
  assert.match(
    capture.request?.messages[0]?.content ?? "",
    /wait_for_exists on a same-phase public role instance fact/u,
  );
  const planSchema = JSON.stringify(capture.request?.tools[0]?.parameters);
  await assert.rejects(
    roles.preparePrivateCriteria({
      builderPrompt: "Build a GUI",
      rubric: "The GUI is visible",
      criteria: [],
      evaluationStage: { index: 1, count: 1, earlierPrompts: [], gateCriterionIds: [] },
      publicProposal: {
        publicTask: { slug: "gui" } as never,
        publicDevelopment: {} as never,
        publicScene: { parts: [] },
      },
      plan: { studio: fixturePrivate.privateEvaluator.studio, sequence: null },
      previousPrivateProposal: null,
      attempt: 1,
      diagnostics: [],
    }),
    /captured private request/,
  );
  assert.equal(capture.request?.tools[0]?.name, "submit_private_criteria");
  assert.match(capture.request?.system ?? "", /^This is the criteria stage\. The private plan/u);
  const schema = planSchema + JSON.stringify(capture.request?.tools[0]?.parameters);
  for (const supported of [
    "gui_text_entry",
    "hold_key",
    "scenario_barrier_passage",
    "all_luau_in_roots",
    "minimumPassingScore",
    "semantic_role_binding",
  ])
    assert.ok(schema.includes(supported), `Missing generated schema guidance for ${supported}`);
  assert.ok(!schema.includes('"additionalProperties":true'));
});

test("real role parser and preparation adapter reject a private public-task overwrite", async () => {
  const directory = resolve("tasks/pilot/replicated-checkpoint");
  const publicTask = JSON.parse(await readFile(resolve(directory, "task.json"), "utf8"));
  const publicDevelopment = JSON.parse(
    await readFile(resolve(directory, "development.json"), "utf8"),
  );
  const gameStateRole = {
    id: "game-state",
    className: "Folder",
    scope: "replicated_storage",
    cardinality: "exactly_one",
  };
  publicTask.roles = [gameStateRole];
  publicDevelopment.plan.roles = [gameStateRole];
  const boundDevelopment = JSON.parse(
    JSON.stringify(publicDevelopment).replaceAll(
      "game.ReplicatedStorage.GameState",
      "role.game-state",
    ),
  );
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: publicTask.prompt,
        rubric: "The checkpoint must remain private. SENTINEL-PRIVATE-RUBRIC",
      },
    ],
  });
  const outgoingPublic: string[] = [];
  const dispatcher = {
    async complete(stage: string, request: ModelTurnRequest): Promise<ModelTurnResult> {
      if (stage === "prepare_public") outgoingPublic.push(request.messages[0]!.content);
      const name = request.tools[0]!.name;
      const argumentsValue =
        stage === "prepare_public"
          ? {
              stages: [
                {
                  publicTask: {
                    roles: publicTask.roles,
                    acceptance: publicTask.acceptance,
                    evidenceInstructions: publicTask.evidenceInstructions,
                  },
                  publicDevelopment: {
                    ...boundDevelopment,
                    task: { slug: JSON.parse(request.messages[0]!.content).slug },
                  },
                },
              ],
              publicScene: {
                parts: [
                  {
                    name: "CheckpointA",
                    position: [0, 2, 0],
                    size: [4, 1, 4],
                    anchored: true,
                    canCollide: true,
                    transparency: 0,
                  },
                ],
              },
            }
          : stage === "audit_public"
            ? { issues: [] }
            : {
                privateEvaluator: {},
                criterionMappings: [],
                requiredCapabilities: [],
                publicTask: { acceptance: ["SENTINEL-PRIVATE-OVERWRITE"] },
              };
      return {
        kind: "assistant",
        requestHash: "a".repeat(64),
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "one", name, arguments: argumentsValue }],
        },
        stopReason: "tool_calls",
        responseHash: "b".repeat(64),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "test",
          requestedServiceTier: null,
          servingServiceTier: null,
          responseId: "generation-test",
          latencyMs: 1,
          retryCount: 0,
          finishReason: "tool_calls",
          continuationHash: null,
          continuationBytes: null,
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      };
    },
  } as unknown as PreparationDispatcher;
  const roles = modelPreparationRoles({
    dispatcher,
    publicModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    privateModel: { id: "openai/gpt-6-luna", maxOutputTokens: 16_384 },
    seed: 7,
  });
  const prepared = await prepareEvalDraft(draft, roles);
  assert.deepEqual(prepared.revisions, []);
  assert.deepEqual(
    prepared.attempts,
    { public: 1, stages: [{ privatePlan: PREPARATION_ATTEMPTS, privateCriteria: 0 }] },
    JSON.stringify(prepared.validation),
  );
  assert.match(
    prepared.validation.diagnostics[0]!.message,
    /\/publicTask: must NOT have additional properties/,
  );
  assert.ok(outgoingPublic.length > 0);
  assert.ok(outgoingPublic.every((message) => !message.includes("SENTINEL")));
});
