import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSubmissionShape,
  assertPreparationShape,
} from "../packages/eval-authoring/src/submission-validation.js";
import {
  criteriaSubmission,
  privateCriteriaSchema,
  privatePlanSchema,
  publicProposalSchema,
} from "../packages/eval-authoring/src/preparation-request.js";
import {
  studioPlanSchema,
  studioActionSchema,
  studioFactSchema,
} from "../packages/eval-authoring/src/tool-schemas.js";
import { authoredAuthorityCatalog } from "../packages/eval-authoring/src/private-submission.js";
import { prepareEvalDraft } from "../packages/agent-runtime/src/eval-preparation.js";
import {
  capabilityFixture,
  publicPreparation,
  stagedPrivateRoles,
  stageSources,
} from "./shared-api-fixture.js";
import { createEvalDraft } from "../packages/eval-authoring/src/index.js";
import { assertStudioCollectionPlan } from "../packages/contracts/src/index.js";

test("one correction reports missing scene, absent phases and empty scenario steps together", () => {
  const { publicProposal } = capabilityFixture("gui");
  const broken = publicPreparation(structuredClone(publicProposal));
  Reflect.deleteProperty(broken, "publicScene");
  Reflect.deleteProperty(broken.stages[0]!.publicDevelopment.plan, "phases");
  broken.stages[0]!.publicDevelopment.plan.scenarios[0]!.steps = [];
  assert.throws(
    () => assertSubmissionShape(broken, publicProposalSchema(1), "Public preparation"),
    (error: Error) => {
      assert.match(error.message, /\/publicScene/);
      assert.match(error.message, /\/stages\/0\/publicDevelopment\/plan\/phases/);
      assert.match(error.message, /\/steps: must NOT have fewer than 1/);
      return true;
    },
  );
  assert.equal(
    Object.hasOwn(broken, "publicScene"),
    false,
    "validation cannot fill missing content",
  );
});

test("model-facing plan schema agrees with runner phase and client bounds", () => {
  const { publicProposal } = capabilityFixture("static");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  plan.clients = 8;
  plan.actors = Array.from({ length: 8 }, (_, index) => `actor-${index}`);
  assertSubmissionShape(plan, studioPlanSchema, "Plan");
  plan.phases = [];
  assert.throws(
    () => assertSubmissionShape(plan, studioPlanSchema, "Plan"),
    /\/phases: must NOT have fewer than 1/,
  );
});

test("an anchor fact used as an observation names the observation for that state", () => {
  const { publicProposal } = capabilityFixture("static");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  Object.assign(plan.phases[0]!, {
    facts: [{ kind: "gui_visible", id: "message", path: "role.message", visible: true }],
  });
  assert.throws(
    () => assertSubmissionShape(plan, studioPlanSchema, "Plan"),
    (error: Error) => {
      assert.match(
        error.message,
        /\/phases\/0\/facts\/0\/kind: gui_visible is an anchor fact\. Use it only in at\.after\.fact\. To observe this state, use gui_text or gui_geometry/,
      );
      return true;
    },
  );
});

test("a union without a kind field reports only the errors of its closest form", () => {
  const { publicProposal } = capabilityFixture("gui");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  Object.assign(plan.scenarios[0]!.steps[1]!, {
    at: {
      after: {
        fact: { kind: "instance_present", actor: "primary", path: "role.beacon", present: true },
        scope: "primary",
      },
      offsetMs: 0,
    },
  });
  assert.throws(
    () => assertSubmissionShape(plan, studioPlanSchema, "Plan"),
    (error: Error) => {
      assert.match(
        error.message,
        /\/scenarios\/0\/steps\/1\/at\/after\/fact\/actor: must NOT have/,
      );
      assert.doesNotMatch(error.message, /\/at\/startMs|\/at\/after\/step|\/at\/offsetMs/);
      return true;
    },
  );
});

test("a plan reads a leaderstats value with instance_value in the client context of its actor", () => {
  const kinds = (studioFactSchema.oneOf as Array<{ properties: { kind: { enum: string[] } } }>).map(
    (entry) => entry.properties.kind.enum[0],
  );
  assert.ok(kinds.includes("instance_value"));
  const { publicProposal } = capabilityFixture("static");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  const wins = {
    id: "wins",
    kind: "instance_value" as const,
    path: "game.Players.LocalPlayer.leaderstats.Wins",
  };
  plan.scenarios[0]!.steps[0]!.observations.push({ context: "primary", fact: wins });
  plan.phases[0]!.facts.push({ id: "round", kind: "instance_value", path: "game.Workspace.Round" });
  assertSubmissionShape(plan, studioPlanSchema, "Plan");
  assertStudioCollectionPlan(plan);
  Object.assign(plan.scenarios[0]!.steps[0]!.observations[0]!.fact, { property: "Value" });
  assert.throws(
    () => assertSubmissionShape(plan, studioPlanSchema, "Plan"),
    /\/observations\/0\/fact/,
  );
});

test("an actor view without its target observation names the phase and the missing fact", () => {
  const { publicProposal } = capabilityFixture("static");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  Object.assign(plan.phases[0]!, {
    driver: { kind: "observe_from_actor", targetPath: "role.beacon", timeoutMs: 10000 },
    facts: [{ id: "beacon-name", kind: "instance_name", path: "role.beacon" }],
  });
  assert.throws(
    () => assertStudioCollectionPlan(plan),
    /Add \{"kind":"instance","id":"<new id>","path":"role\.beacon"\} to the facts of phase "scene"/,
  );
});

test("errors from one observation kind cannot hide another observation's malformed fields", () => {
  const { publicProposal } = capabilityFixture("static");
  const plan = structuredClone(publicProposal.publicDevelopment.plan);
  Reflect.deleteProperty(plan, "roles");
  Object.assign(plan.phases[0]!, {
    facts: [
      { kind: "diagnostics" },
      {
        kind: "part_motion",
        id: "motion",
        path: "game.Workspace.Platform",
        sampleCount: 0,
        intervalMs: 10,
      },
      { kind: "unknown_fact", id: "unknown" },
    ],
  });
  assert.throws(
    () => assertSubmissionShape(plan, studioPlanSchema, "Plan"),
    (error: Error) => {
      assert.match(error.message, /\/roles/);
      assert.match(error.message, /\/phases\/0\/facts\/0\/id/);
      assert.match(error.message, /\/phases\/0\/facts\/1\/sampleCount.*must be >= 1/);
      assert.doesNotMatch(error.message, /\/facts\/0\/sampleCount/);
      assert.match(
        error.message,
        /\/phases\/0\/facts\/2\/kind: unsupported kind; expected one of:.*diagnostics/,
      );
      return true;
    },
  );
  assert.throws(
    () =>
      assertSubmissionShape(
        {
          kind: "press_key",
          actor: "player",
          key: "E",
          arguments: [{ kind: "unknown", value: "x" }],
        },
        studioActionSchema,
        "Action",
      ),
    (error: Error) => {
      assert.match(error.message, /\/arguments: must NOT have additional properties/);
      assert.doesNotMatch(error.message, /\/arguments\/0/);
      return true;
    },
  );
});

test("one correction includes malformed phases and all independently invalid sequence sources", () => {
  const fixture = capabilityFixture("gui");
  const value = structuredClone({
    studio: fixture.privateProposal.privateEvaluator.studio,
    sequence: fixture.privateProposal.privateEvaluator.sequence,
  });
  const scenario = value.studio.scenarios[0]!;
  value.studio.phases = [];
  value.sequence = {
    scenarioId: scenario.id,
    camera: null,
    viewport: null,
    maximumGapMs: 1000,
    frameBudget: 64,
    requiredTransitions: [
      {
        id: "first",
        source: { kind: "action", stepId: "not-declared" },
        effectWindowMs: 500,
        holdMs: 0,
      },
      {
        id: "second",
        source: { kind: "action", stepId: "also-missing" },
        effectWindowMs: 500,
        holdMs: 0,
      },
    ],
  };
  assert.throws(
    () => assertPreparationShape(value, privatePlanSchema, "Private plan"),
    (error: Error) => {
      assert.match(error.message, /\/studio\/phases: must NOT have fewer than 1/);
      assert.match(
        error.message,
        /\/sequence\/requiredTransitions\/0\/source\/stepId.*not-declared/,
      );
      assert.match(
        error.message,
        /\/sequence\/requiredTransitions\/1\/source\/stepId.*also-missing/,
      );
      return true;
    },
  );
});

test("the criteria stage names its absent fields in one result", () => {
  const fixture = capabilityFixture("static");
  const input = stageSources(createEvalDraft(fixture.input));
  const shape = privateCriteriaSchema(authoredAuthorityCatalog(input).map((item) => item.id));
  const complete = criteriaSubmission(fixture.privateProposal, input);
  assertSubmissionShape(complete, shape, "Private criteria");
  const broken = { unscaled: [], studio: {} };
  assert.throws(
    () => assertSubmissionShape(broken, shape, "Private criteria"),
    (error: Error) => {
      assert.match(error.message, /\/criterionMappings/);
      assert.match(error.message, /\/requiredCapabilities/);
      assert.match(error.message, /\/studio: must NOT have additional properties/);
      return true;
    },
  );
});

test("malformed public proposals receive one correction with aggregate local diagnostics", async () => {
  const fixture = capabilityFixture("static");
  const result = await prepareEvalDraft(createEvalDraft(fixture.input), {
    async preparePublic({ attempt, diagnostics }) {
      if (attempt === 1) {
        const broken = publicPreparation(structuredClone(fixture.publicProposal));
        Reflect.deleteProperty(broken, "publicScene");
        broken.stages[0]!.publicDevelopment.plan.phases = [];
        return broken;
      }
      assert.match(diagnostics.join("\n"), /\/publicScene/);
      assert.match(diagnostics.join("\n"), /\/stages\/0\/publicDevelopment\/plan\/phases/);
      return publicPreparation(fixture.publicProposal);
    },
    ...stagedPrivateRoles(() => fixture.privateProposal),
  });
  assert.ok(result.revisions[0]);
  assert.equal(result.attempts.public, 2);
  assert.deepEqual(result.attempts.stages, [{ privatePlan: 1, privateCriteria: 1 }]);
});
