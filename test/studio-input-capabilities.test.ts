import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEvaluatorSpec,
  assertStudioCollectionPlan,
  assertStudioObservation,
  boundStudioObservation,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import { loadRegisteredTask } from "../packages/task-registry/src/index.js";
import { assertPublicDevelopmentRecipe } from "../packages/development/src/index.js";

const task = await loadRegisteredTask(process.cwd(), "tasks/pilot/cooperative-gate");
const base = task.evaluator.studio;

function withAction(action: unknown) {
  const plan = structuredClone(base) as unknown as Record<string, unknown>;
  const scenarios = plan.scenarios as Array<{ steps: Array<{ action: unknown }> }>;
  scenarios[0]!.steps[0]!.action = action;
  return plan;
}

test("fixed scenario plans admit bounded GUI and held-input actions", () => {
  const actor = base.actors[0]!;
  for (const action of [
    { kind: "gui_activate", actor, path: "game.Players.LocalPlayer.PlayerGui.Action" },
    {
      kind: "gui_text_entry",
      actor,
      path: "game.Players.LocalPlayer.PlayerGui.Code",
      text: "open",
    },
    { kind: "hold_key", actor, key: "E", durationMs: 750 },
    { kind: "place_on_part", actor, targetPath: "game.Workspace.Platform" },
    {
      kind: "place_relative_to_part",
      actor,
      targetPath: "game.Workspace.Platform",
      offsetStuds: [0, 3, 20],
    },
  ])
    assertStudioCollectionPlan(withAction(action));
  assertStudioCollectionPlan({
    ...base,
    phases: [
      {
        ...base.phases[0]!,
        driver: { kind: "wait_for_session", timeoutMs: 10_000 },
      },
    ],
  });
});

test("a repeated observation names its scenario, step, context and fact for the correction", () => {
  const plan = structuredClone(base);
  const step = plan.scenarios[0]!.steps[0]!;
  step.observations.push(structuredClone(step.observations[0]!));
  assert.throws(() => assertStudioCollectionPlan(plan), {
    message:
      "Studio scenario initial-closed-passage step initial-state observes fact open in context server two times. Keep one observation, or give the other fact a new ID",
  });
});

test("input bounds reject arbitrary paths, keys, text and callbacks", () => {
  const actor = base.actors[0]!;
  for (const action of [
    { kind: "gui_activate", actor, path: "game.Players.LocalPlayer; unsafe" },
    {
      kind: "gui_text_entry",
      actor,
      path: "game.Players.LocalPlayer.PlayerGui.Code",
      text: "x".repeat(257),
    },
    { kind: "hold_key", actor, key: "Escape", durationMs: 750 },
    { kind: "hold_key", actor, key: "E", durationMs: 5_001 },
    { kind: "hold_key", actor, key: "E", durationMs: 750, callback: "return true" },
    { kind: "place_on_part", actor, targetPath: "game.Workspace; unsafe" },
    {
      kind: "place_relative_to_part",
      actor,
      targetPath: "game.Workspace.Platform",
      offsetStuds: [0, 0, 10001],
    },
    {
      kind: "place_relative_to_part",
      actor,
      targetPath: "game.Workspace.Platform",
      offsetStuds: [0, 0],
    },
    {
      kind: "place_relative_to_part",
      actor,
      targetPath: "game.Workspace.Platform",
      offsetStuds: [0, 0, Infinity],
    },
    {
      kind: "place_relative_to_part",
      actor,
      targetPath: "game.Workspace.Platform",
      offsetStuds: [0, 0, NaN],
    },
  ])
    assert.throws(() => assertStudioCollectionPlan(withAction(action)));
});

test("fixed geometry observations preserve numeric bounds and visible state", () => {
  for (const kind of ["gui_geometry", "part_position", "part_physics"]) {
    const plan = structuredClone(base);
    plan.phases[0]!.facts.push({ id: kind, kind, path: "game.Workspace.Target" } as never);
    assertStudioCollectionPlan(plan);
  }
  assertStudioObservation({
    factId: "button",
    kind: "gui_geometry",
    exists: true,
    visible: false,
    x: -10,
    y: 12,
    width: 45,
    height: 20,
  });
  assertStudioObservation({
    factId: "door",
    kind: "part_position",
    exists: true,
    x: 1.25,
    y: 2,
    z: -7,
  });
  assertStudioObservation({
    factId: "platform",
    kind: "part_physics",
    exists: true,
    anchored: true,
    canCollide: true,
  });
  assert.throws(
    () =>
      assertStudioObservation({
        factId: "platform",
        kind: "part_physics",
        exists: false,
        anchored: true,
        canCollide: false,
      }),
    /absent part physics/,
  );
  assert.throws(() =>
    assertStudioObservation({
      factId: "button",
      kind: "gui_geometry",
      exists: true,
      visible: true,
      x: 0,
      y: 0,
      width: -1,
      height: 20,
    }),
  );
});

test("a tagged role can expose its actual instance name as signed evidence", () => {
  const plan = structuredClone(base);
  plan.phases[0]!.facts.push({
    id: "actual-name",
    kind: "instance_name",
    path: "game.Workspace.Target",
  });
  assertStudioCollectionPlan(plan);
  assertStudioObservation({
    factId: "actual-name",
    kind: "instance_name",
    exists: true,
    name: "GameState",
  });
  assert.throws(
    () =>
      assertStudioObservation({
        factId: "actual-name",
        kind: "instance_name",
        exists: true,
        name: 17,
      }),
    /instance-name observation/,
  );
});

test("actor-part motion binds an actor and validates paired measured samples", () => {
  const actor = base.actors[0]!;
  const plan = structuredClone(base);
  plan.scenarios[0]!.durationMs = 70_000;
  plan.scenarios[0]!.steps[0]!.observations.push({
    context: "server",
    fact: {
      id: "ride",
      kind: "actor_part_motion",
      actor,
      path: "game.Workspace.Target",
      sampleCount: 240,
      intervalMs: 250,
    },
  });
  assertStudioCollectionPlan(plan);
  const repeatedRoute = structuredClone(plan);
  repeatedRoute.scenarios[0]!.durationMs = 125_000;
  const repeatedFact = repeatedRoute.scenarios[0]!.steps[0]!.observations.at(-1)!.fact;
  if (repeatedFact.kind !== "actor_part_motion")
    throw new Error("Missing actor-part motion fixture");
  repeatedFact.intervalMs = 500;
  assertStudioCollectionPlan(repeatedRoute);
  repeatedRoute.scenarios[0]!.durationMs = 1_800_001;
  assert.throws(() => assertStudioCollectionPlan(repeatedRoute), /Studio scenario metadata/);
  const tooShort = structuredClone(plan);
  tooShort.scenarios[0]!.durationMs = 10_000;
  assert.throws(
    () => assertStudioCollectionPlan(tooShort),
    /observation window exceeds the scenario budget/,
  );
  const invalid = structuredClone(plan);
  const fact = invalid.scenarios[0]!.steps[0]!.observations.at(-1)!.fact;
  if (fact.kind !== "actor_part_motion") throw new Error("Missing actor-part motion fixture");
  fact.sampleCount = 481;
  assert.throws(() => assertStudioCollectionPlan(invalid), /actor-part motion sampling window/);
  const excessiveSpan = structuredClone(plan);
  const excessiveFact = excessiveSpan.scenarios[0]!.steps[0]!.observations.at(-1)!.fact;
  if (excessiveFact.kind !== "actor_part_motion")
    throw new Error("Missing actor-part motion fixture");
  excessiveFact.sampleCount = 480;
  excessiveFact.intervalMs = 1_300;
  assert.throws(
    () => assertStudioCollectionPlan(excessiveSpan),
    /actor-part motion sampling window/,
  );
  const observation = {
    factId: "ride",
    kind: "actor_part_motion",
    actor,
    exists: true,
    samples: [
      {
        elapsedMs: 0,
        x: 0,
        y: 0,
        z: 0,
        actorX: 0,
        actorY: 4,
        actorZ: 0,
        localX: 0,
        localY: 4,
        localZ: 0,
        sizeX: 8,
        sizeY: 1,
        sizeZ: 8,
      },
      {
        elapsedMs: 250,
        x: 3,
        y: 0,
        z: 0,
        actorX: 3,
        actorY: 4,
        actorZ: 0,
        localX: 0,
        localY: 4,
        localZ: 0,
        sizeX: 8,
        sizeY: 1,
        sizeZ: 8,
      },
    ],
    partDelta: 3,
    actorDelta: 3,
    maxRelativeDelta: 0,
  };
  assertStudioObservation(observation);
  assert.throws(
    () => assertStudioObservation({ ...observation, actorDelta: 0 }),
    /summary does not match/,
  );
  assert.throws(
    () => assertStudioObservation({ ...observation, samples: observation.samples.slice(1) }),
    /sample/,
  );
  assert.throws(
    () =>
      assertStudioObservation({
        ...observation,
        samples: [{ ...observation.samples[0], sizeX: 0 }, observation.samples[1]],
      }),
    /sample/,
  );
});

test("actor-part support binds the actor and reports target-local contact evidence", () => {
  const actor = base.actors[0]!;
  const plan = structuredClone(base);
  plan.scenarios[0]!.steps[0]!.observations.push({
    context: actor,
    fact: { id: "support", kind: "actor_part_support", actor, path: "game.Workspace.Platform" },
  });
  assertStudioCollectionPlan(plan);
  const observation = {
    factId: "support",
    kind: "actor_part_support",
    actor,
    exists: true,
    localX: 0,
    localY: 4,
    localZ: 0,
    sizeX: 8,
    sizeY: 1,
    sizeZ: 8,
    hitTarget: true,
    hitDistance: 3.5,
  };
  assertStudioObservation(observation);
  assert.throws(
    () => assertStudioObservation({ ...observation, hitDistance: -1 }),
    /actor-part support observation/,
  );
  const invalid = structuredClone(plan);
  invalid.phases[0]!.facts.push({
    id: "support",
    kind: "actor_part_support",
    actor,
    path: "game.Workspace.Platform",
  });
  assert.throws(() => assertStudioCollectionPlan(invalid), /scenario-only/);
});

test("event-based anchored trace detects an unanchored interval between snapshots", () => {
  const plan = structuredClone(base);
  plan.scenarios[0]!.durationMs = 5_000;
  plan.scenarios[0]!.steps[0]!.observations.push({
    context: "server",
    fact: {
      id: "physics-window",
      kind: "part_physics_trace",
      path: "game.Workspace.Platform",
      durationMs: 2_000,
    },
  });
  assertStudioCollectionPlan(plan);
  assertStudioObservation({
    factId: "physics-window",
    kind: "part_physics_trace",
    exists: true,
    initialAnchored: true,
    finalAnchored: true,
    initialCanCollide: true,
    finalCanCollide: true,
    everUnanchored: true,
    observedMs: 2_050,
    changes: [
      { elapsedMs: 500, anchored: false, canCollide: true },
      { elapsedMs: 900, anchored: true, canCollide: true },
    ],
  });
  assert.throws(
    () =>
      assertStudioObservation({
        factId: "physics-window",
        kind: "part_physics_trace",
        exists: true,
        initialAnchored: true,
        finalAnchored: true,
        initialCanCollide: true,
        finalCanCollide: true,
        everUnanchored: false,
        observedMs: 2_050,
        changes: [
          { elapsedMs: 500, anchored: false, canCollide: true },
          { elapsedMs: 900, anchored: true, canCollide: true },
        ],
      }),
    /part physics trace summary/,
  );
  plan.scenarios[0]!.durationMs = 1_000;
  assert.throws(
    () => assertStudioCollectionPlan(plan),
    /observation window exceeds the scenario budget/,
  );
});

test("collision trace retains an open interval missed by equal initial and final snapshots", () => {
  const observation = {
    factId: "collision-window",
    kind: "part_physics_trace",
    exists: true,
    initialAnchored: true,
    finalAnchored: true,
    everUnanchored: false,
    initialCanCollide: true,
    finalCanCollide: true,
    observedMs: 9000,
    changes: [
      { elapsedMs: 1000, anchored: true, canCollide: false },
      { elapsedMs: 6000, anchored: true, canCollide: true },
    ],
  };
  assertStudioObservation(observation);
  assert.throws(
    () => assertStudioObservation({ ...observation, finalCanCollide: false }),
    /part physics trace summary/,
  );
  assert.throws(
    () => assertStudioObservation({ ...observation, exists: false }),
    /part physics trace summary/,
  );
  assert.throws(
    () => assertStudioObservation({ ...observation, observedMs: 5000 }),
    /part physics trace change/,
  );
});

test("frame-level route visits retain measured pauses and reject incomplete timing", () => {
  const plan = structuredClone(base);
  plan.scenarios[0]!.durationMs = 5_000;
  plan.scenarios[0]!.steps[0]!.observations.push({
    context: "server",
    fact: {
      id: "route",
      kind: "part_route_trace",
      path: "game.Workspace.Platform",
      startPath: "game.Workspace.StartMarker",
      endPath: "game.Workspace.EndMarker",
      durationMs: 3_000,
      proximityStuds: 2,
    },
  });
  assertStudioCollectionPlan(plan);
  const observation = {
    factId: "route",
    kind: "part_route_trace",
    exists: true,
    observedMs: 3_016,
    sampleCount: 180,
    maxFrameGapMs: 35,
    visits: [
      {
        marker: "start",
        enterMs: 0,
        exitMs: 400,
        travelStuds: 0.8,
        minDistanceStuds: 0.1,
        longestStillMs: 250,
        maxFrameGapMs: 35,
      },
      {
        marker: "end",
        enterMs: 1_500,
        exitMs: 1_900,
        travelStuds: 0.6,
        minDistanceStuds: 0.2,
        longestStillMs: 200,
        maxFrameGapMs: 33,
      },
    ],
  };
  assertStudioObservation(observation);
  assert.throws(
    () => assertStudioObservation({ ...observation, maxFrameGapMs: 4_000 }),
    /part route trace observation/,
  );
  assert.throws(
    () =>
      assertStudioObservation({
        ...observation,
        visits: [{ ...observation.visits[0], exitMs: 4_000 }],
      }),
    /part route visit/,
  );
  plan.scenarios[0]!.durationMs = 2_000;
  assert.throws(
    () => assertStudioCollectionPlan(plan),
    /observation window exceeds the scenario budget/,
  );
});

test("categorical criteria bind exact signed scenario observations", () => {
  const evaluator = structuredClone(task.evaluator);
  const scenario = evaluator.studio.scenarios[0]!;
  const step = scenario.steps[0]!;
  step.observations.push({
    context: "server",
    fact: {
      id: "ride-motion",
      kind: "actor_part_motion",
      actor: evaluator.studio.actors[0]!,
      path: "game.Workspace.Target",
      sampleCount: 2,
      intervalMs: 250,
    },
  });
  const binding = {
    scenarioId: scenario.id,
    stepId: step.id,
    context: "server",
    factId: "ride-motion",
  };
  evaluator.unscaled.push({
    id: "carry-criterion",
    statement: "The player stays on the moving platform.",
    required: true,
    evidenceClass: "motion",
    polarity: "presence",
    evidence: {
      sequence: false,
      actions: [],
      sourceSelection: null,
      facts: [binding],
      captureIds: [],
    },
  });
  assertEvaluatorSpec(evaluator);
  const wrong = structuredClone(evaluator);
  if (!wrong.unscaled[0]) throw new Error("Missing scenario evidence fixture");
  wrong.unscaled[0].evidence.facts = [{ ...binding, context: "unknown" }];
  assert.throws(
    () => assertEvaluatorSpec(wrong),
    new RegExp(`missing Studio observation scenario:${scenario.id}:${step.id}:unknown:ride-motion`),
  );
  const observation = { factId: "ride-motion", kind: "actor_part_motion" };
  const evidence = {
    phases: [],
    scenarios: [
      {
        scenarioId: scenario.id,
        reports: [{ context: "server", steps: [{ stepId: step.id, observations: [observation] }] }],
      },
    ],
  } as unknown as StudioEvidence;
  assert.equal(boundStudioObservation(evidence, binding), observation);
  assert.equal(boundStudioObservation(evidence, { ...binding, context: "unknown" }), null);
});

test("public static scenes can be inspected without a fabricated state change", () => {
  const recipe = {
    schema: "basalt-evals/public-development",
    task: { slug: task.publicTask.slug },
    plan: {
      ...structuredClone(base),
      scenarios: [
        {
          id: "static-view",
          label: "Observe the current scene",
          durationMs: 2_000,
          reportContexts: ["server", ...base.actors],
          steps: [
            {
              id: "observe",
              at: { startMs: 0 },
              horizonMs: 1000,
              holdMs: 0,
              requirement: null,
              action: { kind: "wait" },
              observations: [],
            },
          ],
        },
      ],
      phases: [
        {
          id: "presentation",
          label: "Player view",
          instruction: "Capture the player view after the session starts.",
          driver: { kind: "wait_for_session", timeoutMs: 10_000 },
          facts: [{ id: "errors", kind: "diagnostics" }],
          captures: [{ id: "view", instruction: "Unmodified player view" }],
        },
      ],
    },
    views: [
      {
        id: "standard",
        scenarioId: "static-view",
        requiredTransitions: [],
        camera: null,
        viewport: null,
        maximumGapMs: 1000,
        frameBudget: 64,
      },
    ],
  };
  assertPublicDevelopmentRecipe(recipe, task.publicTask);
});

test("categorical action bindings select only a unique performing actor receipt", () => {
  const evaluator = structuredClone(task.evaluator);
  const scenario = evaluator.studio.scenarios[0]!;
  const step = scenario.steps[0]!;
  const actor = evaluator.studio.actors[0]!;
  step.action = { kind: "move_to", actor, targetPath: "game.Workspace.Gate" };
  if (!scenario.reportContexts.includes(actor)) scenario.reportContexts.push(actor);
  const binding = { scenarioId: scenario.id, stepId: step.id, context: actor };
  evaluator.unscaled = [
    {
      id: "input-evidence",
      statement: "Interaction is available.",
      required: true,
      evidenceClass: null,
      polarity: "presence",
      evidence: {
        sequence: false,
        sourceSelection: null,
        facts: [],
        actions: [binding],
        captureIds: [],
      },
    },
  ];
  assertEvaluatorSpec(evaluator);
  for (const invalid of [
    { ...binding, scenarioId: "missing" },
    { ...binding, stepId: "missing" },
    { ...binding, context: "server" },
    { ...binding, factId: "invented" },
  ]) {
    const wrong = structuredClone(evaluator);
    wrong.unscaled[0]!.evidence.actions = [invalid];
    assert.throws(() => assertEvaluatorSpec(wrong), /missing performed action|action binding/);
  }
  const repeated = structuredClone(evaluator);
  repeated.unscaled[0]!.evidence.actions.push(binding);
  assert.throws(() => assertEvaluatorSpec(repeated), /repeats action/);
  const wait = structuredClone(evaluator);
  wait.studio.scenarios[0]!.steps[0]!.action = { kind: "wait" };
  assert.throws(() => assertEvaluatorSpec(wait), /missing performed action/);
  const absentChannel = structuredClone(evaluator);
  delete (absentChannel.unscaled[0]!.evidence as { actions?: unknown }).actions;
  assert.throws(() => assertEvaluatorSpec(absentChannel), /unscaled evidence channels/);
});
