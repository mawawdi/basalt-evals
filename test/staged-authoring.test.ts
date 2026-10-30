import assert from "node:assert/strict";
import test from "node:test";
import { prepareEvalDraft } from "../packages/agent-runtime/src/eval-preparation.js";
import { compileEvalProposal, gateCheckIds } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import {
  PREPARATION_ATTEMPTS,
  preparationRequests,
} from "../packages/eval-authoring/src/preparation-request.js";
import type {
  EvaluationStageContext,
  PublicPreparation,
} from "../packages/eval-authoring/src/proposals.js";
import { preparationModelWork } from "../packages/eval-authoring/src/quote.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import {
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  fixtureSnapshots,
  stagedPrivateRoles,
} from "./shared-api-fixture.js";
import { PROMPTS as STAGE_PROMPTS } from "./staged-fixture.js";

// The first two stages of the staged fixture.
const PROMPTS = STAGE_PROMPTS.slice(0, 2);
const RUBRIC = fixtureInput.stages[0]!.rubric;

const staged = (gates: string[][], rubrics = [RUBRIC, RUBRIC]) => ({
  schema: "basalt-evals/eval-authoring-input" as const,
  title: "Staged beacon",
  stages: PROMPTS.map((prompt, index) => ({
    prompt,
    rubric: rubrics[index]!,
    ...(gates[index]?.length ? { gateCriterionIds: gates[index] } : {}),
  })),
});

test("a gate can name only required code checks of its own stage", () => {
  const optional = "- A Beacon object exists.\n- Optional: the Beacon glows.";
  const longer = "- A Beacon object exists.\n- The Beacon pulses.\n- The pulse lasts one second.";
  assert.throws(
    () => createEvalDraft(staged([["criterion-2"]], [optional, longer])),
    /Stage 1: The gate names criterion-2, which is optional/,
  );
  assert.throws(
    () => createEvalDraft(staged([["criterion-3"]], [optional, longer])),
    /Stage 1: The gate names criterion-3, but the success criteria of this stage have no such criterion/,
  );
  assert.throws(
    () => createEvalDraft(staged([[], ["criterion-1"]])),
    /Stage 2: The last stage cannot have a gate/,
  );
  // The gate keeps the authored order of the criteria.
  const ordered = createEvalDraft(staged([["criterion-2", "criterion-1"]]));
  assert.deepEqual(ordered.stages[0]!.gateCriterionIds, ["criterion-1", "criterion-2"]);
  assert.deepEqual(ordered.stages[1]!.gateCriterionIds, []);

  // A gate criterion needs a required code check. A judged check cannot decide a gate.
  const { publicScene, ...publicProposal } = fixturePublic;
  const proposal = (prompt: string) => ({
    ...publicProposal,
    publicTask: { ...publicProposal.publicTask, prompt },
    ...structuredClone(fixturePrivate),
    seed: neutralRojoSeed("Staged beacon", publicScene),
  });
  const coded = createEvalDraft(staged([["criterion-1"]]));
  const last = compileEvalProposal(coded, 2, proposal(PROMPTS[1]!));
  assert.ok(last.revision, JSON.stringify(last.validation));
  assert.throws(
    () => compileEvalProposal(coded, 2, proposal(PROMPTS[1]!), last.revision!.id),
    /The last stage has no next stage revision/,
  );
  const first = compileEvalProposal(coded, 1, proposal(PROMPTS[0]!), last.revision.id);
  assert.ok(first.revision, JSON.stringify(first.validation));
  assert.deepEqual(first.revision.stage, {
    index: 1,
    count: 2,
    earlierPrompts: [],
    gateCriterionIds: ["criterion-1"],
    nextRevisionId: last.revision.id,
  });
  assert.deepEqual(gateCheckIds(first.revision), ["beacon-exists"]);
  assert.deepEqual(last.revision.stage.earlierPrompts, [PROMPTS[0]]);

  const judged = createEvalDraft(staged([["criterion-2"]]));
  const refused = compileEvalProposal(judged, 1, proposal(PROMPTS[0]!));
  assert.equal(refused.revision, null);
  assert.deepEqual(
    refused.validation.diagnostics.map((item) => [item.stage, item.authoredCriterionId]),
    [[1, "criterion-2"]],
  );
  assert.match(refused.validation.diagnostics[0]!.message, /A gate needs a required deterministic/);
});

test("public preparation sees every stage prompt and private preparation runs once for each stage", async () => {
  const draft = createEvalDraft(staged([["criterion-1"]]));
  const publicInputs: string[][] = [];
  const privateInputs: Array<{
    stage: string;
    builderPrompt: string;
    evaluationStage: EvaluationStageContext;
    publicPrompt: string;
  }> = [];
  const prepared = await prepareEvalDraft(draft, {
    async preparePublic(input) {
      publicInputs.push(input.stagePrompts);
      return {
        publicScene: fixturePublic.publicScene,
        stages: input.stagePrompts.map((prompt) => ({
          publicTask: { ...structuredClone(fixturePublic.publicTask), prompt, slug: draft.slug },
          publicDevelopment: {
            ...structuredClone(fixturePublic.publicDevelopment),
            task: { slug: draft.slug },
          },
        })),
      } satisfies PublicPreparation;
    },
    ...stagedPrivateRoles((input) => {
      const { evaluationStage, builderPrompt } = input as typeof input & {
        evaluationStage: EvaluationStageContext;
        builderPrompt: string;
      };
      privateInputs.push({
        stage: input.stage,
        builderPrompt,
        evaluationStage,
        publicPrompt: input.publicProposal.publicTask.prompt,
      });
      const proposal = structuredClone(fixturePrivate);
      proposal.privateEvaluator.task.slug = draft.slug;
      return proposal;
    }),
  });
  assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
  assert.deepEqual(publicInputs, [PROMPTS], "one public preparation sees both prompts");
  assert.deepEqual(
    privateInputs.map((item) => [item.stage, item.evaluationStage.index]),
    [
      ["plan", 1],
      ["criteria", 1],
      ["plan", 2],
      ["criteria", 2],
    ],
  );
  for (const item of privateInputs) {
    const index = item.evaluationStage.index;
    assert.equal(item.builderPrompt, PROMPTS[index - 1]);
    assert.equal(item.publicPrompt, PROMPTS[index - 1], "each stage reads its own public part");
    assert.deepEqual(item.evaluationStage, {
      index,
      count: 2,
      earlierPrompts: PROMPTS.slice(0, index - 1),
      gateCriterionIds: index === 1 ? ["criterion-1"] : [],
    });
  }
  assert.deepEqual(prepared.attempts, {
    public: 1,
    stages: [
      { privatePlan: 1, privateCriteria: 1 },
      { privatePlan: 1, privateCriteria: 1 },
    ],
  });
  const [first, second] = prepared.revisions;
  assert.ok(first && second);
  assert.equal(first.stage.nextRevisionId, second.id);
  assert.equal(second.stage.nextRevisionId, null);
  assert.deepEqual(first.seed, second.seed, "the stages share one public scene");
  assert.notEqual(first.builderPromptHash, second.builderPromptHash);

  // The requests: the public request holds every prompt and no rubric. Each private request
  // holds the place of its stage.
  const requests = preparationRequests({
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const publicRequest = requests.preparePublic({
    stagePrompts: PROMPTS,
    title: draft.title,
    slug: draft.slug,
    attempt: 1,
    diagnostics: [],
    previousProposal: null,
  });
  const publicContext = JSON.parse(String(publicRequest.messages[0]!.content));
  assert.deepEqual(publicContext.stagePrompts, PROMPTS);
  assert.equal(JSON.stringify(publicRequest).includes("A Beacon object exists"), false);
  const schema = publicRequest.tools[0]!.parameters as {
    properties: { stages: { minItems: number; maxItems: number } };
  };
  assert.deepEqual([schema.properties.stages.minItems, schema.properties.stages.maxItems], [2, 2]);
  const privateRequest = requests.preparePrivatePlan({
    builderPrompt: PROMPTS[1]!,
    rubric: RUBRIC,
    criteria: draft.stages[1]!.criteria,
    evaluationStage: privateInputs[2]!.evaluationStage,
    publicProposal: { ...fixturePublic, publicTask: { ...fixturePublic.publicTask } },
    previousPlan: null,
    attempt: 1,
    diagnostics: [],
  });
  assert.deepEqual(
    JSON.parse(String(privateRequest.messages[0]!.content)).evaluationStage,
    privateInputs[2]!.evaluationStage,
  );

  // The quote has one public part and the private parts of each stage.
  const snapshot = fixtureSnapshots[0]!;
  // Each part has its attempts: the public part, then the plan and the criteria of each stage.
  assert.equal(
    preparationModelWork(createEvalDraft(fixtureInput), snapshot).length,
    PREPARATION_ATTEMPTS * (1 + 2),
  );
  assert.equal(preparationModelWork(draft, snapshot).length, PREPARATION_ATTEMPTS * (1 + 2 * 2));
});
