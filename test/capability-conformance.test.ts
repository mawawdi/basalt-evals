import assert from "node:assert/strict";
import { execFile as execCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertStudioCollectionPlan } from "../packages/contracts/src/index.js";
import {
  SOURCE_LINT_CODES,
  SPIKE_PENDING_RULES,
  STUDIO_CAPABILITY_CATALOG,
} from "../packages/contracts/src/capabilities.js";
import {
  privateEvaluatorSchema,
  roleSchema,
  studioFactSchema,
} from "../packages/eval-authoring/src/tool-schemas.js";

const execFile = promisify(execCallback);
const actor = "primary";
const path = "role.test_object";
const plan = (fact: object | null, action: object = { kind: "wait" }) => ({
  schema: "basalt-evals/studio-plan",
  clients: 1,
  actors: [actor],
  roles: [
    {
      id: "test_object",
      className: "BasePart",
      scope: "workspace",
      cardinality: "zero_or_one",
    },
  ],
  phases: [
    {
      id: "static",
      label: "Static view",
      instruction: "Observe the session",
      driver: { kind: "wait_for_session", timeoutMs: 30000 },
      facts: [],
      captures: [],
    },
  ],
  scenarios: [
    {
      id: "behavior",
      label: "Behavior window",
      durationMs: 600000,
      reportContexts: ["server", actor],
      steps: [
        {
          id: "observe",
          at: { startMs: 0 } as Record<string, unknown>,
          horizonMs: 1000,
          holdMs: 0,
          action,
          observations: fact ? [{ context: "server", fact }] : [],
          requirement: null as null | { withinMs: number; quote: string },
        },
      ],
    },
  ],
});

test("compiler vocabulary and fixed Luau validator agree across every observation and action", async () => {
  const cases: Array<{ name: string; plan: unknown; accepted: boolean }> = [];
  const add = (name: string, value: unknown, expected = true) => {
    let accepted = true;
    try {
      assertStudioCollectionPlan(value);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, expected, `TypeScript ${name}`);
    cases.push({ name, plan: value, accepted });
  };
  const schemaNames = (
    studioFactSchema.oneOf as Array<{ properties: { kind: { enum: string[] } } }>
  ).map((entry) => entry.properties.kind.enum[0]);
  assert.deepEqual(schemaNames.sort(), [...STUDIO_CAPABILITY_CATALOG.observations].sort());
  assert.deepEqual(roleSchema.properties.className.enum, [
    ...STUDIO_CAPABILITY_CATALOG.roleClasses,
  ]);
  for (const className of STUDIO_CAPABILITY_CATALOG.roleClasses) {
    const rolePlan = plan({ id: "state", kind: "replication_probe", path, attribute: "Status" });
    rolePlan.roles[0]!.className = className;
    if (className === "ScreenGui") {
      add("role-class-ScreenGui-needs-player-gui", structuredClone(rolePlan), false);
      rolePlan.roles[0]!.scope = "local_player_gui";
    }
    add(`role-class-${className}`, rolePlan);
  }
  const unknownClass = plan(null);
  unknownClass.roles[0]!.className = "InventedStateContainer";
  add("undeclared-role-class", unknownClass, false);
  assert.deepEqual(
    Object.keys(STUDIO_CAPABILITY_CATALOG.phaseDriverSemantics).sort(),
    [...STUDIO_CAPABILITY_CATALOG.phaseDrivers].sort(),
  );
  for (const kind of STUDIO_CAPABILITY_CATALOG.observations) {
    const fields =
      kind === "diagnostics" || kind === "player_count"
        ? {}
        : kind === "actor_health"
          ? { actor }
          : kind === "actor_part_support"
            ? { actor, path }
            : kind === "replication_probe"
              ? { path, attribute: "State" }
              : kind === "part_motion" || kind === "actor_part_motion"
                ? {
                    path,
                    sampleCount: 11,
                    intervalMs: 60000,
                    ...(kind === "actor_part_motion" ? { actor } : {}),
                  }
                : kind === "part_physics_trace"
                  ? { path, durationMs: 600000 }
                  : kind === "part_route_trace"
                    ? {
                        path,
                        startPath: path,
                        endPath: "game.Workspace.End",
                        durationMs: 600000,
                        proximityStuds: 0.1,
                      }
                    : kind === "performance_trace"
                      ? { sampleCount: 480, intervalMs: 1250 }
                      : { path };
    const valid = plan({ id: "observation", kind, ...fields });
    if (kind === "gui_layout") {
      Object.assign(valid.roles[0]!, { className: "ScreenGui", scope: "local_player_gui" });
      valid.scenarios[0]!.steps[0]!.observations[0]!.context = actor;
    }
    add(kind, valid);
    const extra = structuredClone(valid);
    Object.assign(extra.scenarios[0]!.steps[0]!.observations[0]!.fact!, {
      evaluatorCode: "return true",
    });
    add(`${kind}-unknown-field`, extra, false);
  }
  for (const kind of STUDIO_CAPABILITY_CATALOG.scenarioActions) {
    const fields =
      kind === "wait"
        ? {}
        : kind === "disconnect"
          ? { actor }
          : kind === "place_relative_to_part" || kind === "move_relative_to_part"
            ? { actor, targetPath: path, offsetStuds: [-10000, 0, 10000] }
            : kind === "move_to" || kind === "place_on_part"
              ? { actor, targetPath: path }
              : kind === "probe_barrier"
                ? { actor, barrierPath: path }
                : kind === "press_key"
                  ? { actor, key: "E" }
                  : kind === "hold_key"
                    ? { actor, key: "Space", durationMs: 5000 }
                    : kind === "gui_text_entry"
                      ? { actor, path, text: "Hello" }
                      : kind === "fire_remote"
                        ? { actor, path, arguments: [{ kind: "literal", value: false }] }
                        : { actor, path };
    const actionPlan = plan(null, { kind, ...fields });
    if (kind === "disconnect") {
      add("disconnect-actor-cannot-report", structuredClone(actionPlan), false);
      actionPlan.scenarios[0]!.reportContexts = ["server"];
    }
    if (kind === "gui_activate" || kind === "gui_text_entry") {
      actionPlan.roles[0]!.className = kind === "gui_text_entry" ? "TextBox" : "GuiObject";
      actionPlan.roles[0]!.scope = "local_player_gui";
      const wrongClass = structuredClone(actionPlan);
      wrongClass.roles[0]!.className = "Instance";
      add(`${kind}-wrong-class`, wrongClass, false);
      const wrongScope = structuredClone(actionPlan);
      wrongScope.roles[0]!.scope = "workspace";
      add(`${kind}-wrong-scope`, wrongScope, false);
    }
    add(kind, actionPlan);
    if (kind === "place_relative_to_part" || kind === "move_relative_to_part") {
      for (const offsetStuds of [
        [0, 0],
        [0, 0, 10001],
        [0, "far", 20],
      ])
        add(
          `${kind}-invalid-${JSON.stringify(offsetStuds)}`,
          plan(null, { kind, actor, targetPath: path, offsetStuds }),
          false,
        );
    }
  }
  // Every fixed anchor fact, an extra field on each, and the timing rules.
  const anchored = (after: object, fields: Record<string, unknown> = {}) => {
    const value = plan({ id: "state", kind: "instance", path });
    value.roles.push({
      id: "banner",
      className: "GuiObject",
      scope: "local_player_gui",
      cardinality: "zero_or_one",
    });
    value.scenarios[0]!.steps.push({
      id: "anchored",
      at: { after, offsetMs: 0 },
      horizonMs: 2000,
      holdMs: 0,
      action: { kind: "wait" },
      observations: [],
      requirement: null,
      ...fields,
    });
    return value;
  };
  const anchorFacts: Record<string, object> = {
    humanoid_state: { kind: "humanoid_state", actor, state: "Landed" },
    character_on_part: { kind: "character_on_part", actor, path },
    character_near_part: { kind: "character_near_part", actor, path, radiusStuds: 4 },
    gui_visible: { kind: "gui_visible", path: "role.banner", visible: true },
    instance_present: { kind: "instance_present", path, present: false },
    part_can_collide: { kind: "part_can_collide", path, value: false },
    part_anchored: { kind: "part_anchored", path, value: true },
  };
  assert.deepEqual(
    Object.keys(anchorFacts).sort(),
    [...STUDIO_CAPABILITY_CATALOG.anchorFacts].sort(),
  );
  for (const [kind, fact] of Object.entries(anchorFacts)) {
    add(`anchor-${kind}`, anchored({ fact, scope: actor }));
    add(
      `anchor-${kind}-unknown-field`,
      anchored({ fact: { ...fact, callback: "x" }, scope: actor }),
      false,
    );
  }
  const candidateAnchor = { kind: "replication_probe", path, attribute: "Ready" };
  add("anchor-candidate-attribute", anchored({ fact: candidateAnchor, scope: "server" }), false);
  add(
    "anchor-gui-needs-client",
    anchored({ fact: anchorFacts.gui_visible, scope: "server" }),
    false,
  );
  add(
    "anchor-gui-needs-player-gui",
    anchored({ fact: { kind: "gui_visible", path, visible: true }, scope: actor }),
    false,
  );
  add(
    "anchor-humanoid-state-list",
    anchored({ fact: { ...anchorFacts.humanoid_state, state: "Teleported" }, scope: actor }),
    false,
  );
  add(
    "anchor-scope-reports",
    anchored({ fact: anchorFacts.part_anchored, scope: "outsider" }),
    false,
  );
  add("anchor-earlier-step", anchored({ step: "observe" }));
  add("anchor-later-step", anchored({ step: "anchored" }), false);
  add(
    "anchor-hold",
    anchored({ fact: anchorFacts.part_anchored, scope: "server" }, { holdMs: 250 }),
  );
  add("anchor-hold-needs-fact", anchored({ step: "observe" }, { holdMs: 250 }), false);
  add(
    "anchor-hold-below-horizon",
    anchored({ fact: anchorFacts.part_anchored, scope: "server" }, { holdMs: 2000 }),
    false,
  );
  add("anchor-horizon-limit", anchored({ step: "observe" }, { horizonMs: 60001 }), false);
  const bound = (withinMs: number, quote: string) =>
    anchored(
      { fact: anchorFacts.part_can_collide, scope: "server" },
      { requirement: { withinMs, quote } },
    );
  add("requirement-quote", bound(1500, "The door opens within 1.5 seconds."));
  add("requirement-quote-milliseconds", bound(400, "It reacts in 400 ms or less."));
  add("requirement-quote-needs-duration", bound(1500, "The door opens quickly."), false);
  add("requirement-quote-other-duration", bound(1500, "The door opens within 2 seconds."), false);
  add("requirement-within-horizon", bound(2500, "within 2.5 seconds"), false);
  add(
    "requirement-needs-fact",
    anchored({ step: "observe" }, { requirement: { withinMs: 500, quote: "within 500 ms" } }),
    false,
  );
  const stepAtMs = plan(null);
  Object.assign(stepAtMs.scenarios[0]!.steps[0]!, { atMs: 0 });
  add("step-atMs-unknown", stepAtMs, false);
  for (const name of await readdir(resolve("tasks/pilot"))) {
    const evaluator = JSON.parse(
      await readFile(resolve("tasks/pilot", name, "evaluator.json"), "utf8"),
    );
    add(`authored-${name}`, evaluator.studio);
    const development = JSON.parse(
      await readFile(resolve("tasks/pilot", name, "development.json"), "utf8").catch(() => "null"),
    );
    if (development) add(`development-${name}`, development.plan);
  }
  const actorView = plan(null);
  Object.assign(actorView.phases[0]!, {
    driver: { kind: "observe_from_actor", targetPath: path, timeoutMs: 1000 },
    facts: [{ id: "view-target", kind: "instance", path }],
  });
  add("actor-view", actorView);
  const inventedView = structuredClone(actorView);
  Object.assign(inventedView.phases[0]!.driver, { position: [0, 6, 18] });
  add("actor-view-cannot-invent-world-origin", inventedView, false);
  const missingViewTarget = structuredClone(actorView);
  Object.assign(missingViewTarget.phases[0]!, { facts: [] });
  add("actor-view-needs-recorded-target-availability", missingViewTarget, false);
  for (const kind of ["instance", "instance_name", "replication_probe"]) {
    const presence = plan(null);
    Object.assign(presence.phases[0]!, {
      driver: { kind: "wait_for_exists", readyFactId: "present", timeoutMs: 1000 },
      facts: [
        {
          id: "present",
          kind,
          path,
          ...(kind === "replication_probe" ? { attribute: "State" } : {}),
        },
      ],
    });
    add(`same-phase-live-presence-${kind}`, presence);
    const missing = structuredClone(presence);
    Object.assign(missing.phases[0]!, { facts: [] });
    add(`same-phase-presence-needs-collector-${kind}`, missing, false);
  }
  const invalid = plan({
    id: "motion",
    kind: "part_motion",
    path,
    sampleCount: 12,
    intervalMs: 60000,
  });
  add("sampling-exceeds-window", invalid, false);
  // A performance trace runs on the server in a scenario. A GUI layout reads a client ScreenGui.
  const performance = { id: "load", kind: "performance_trace", sampleCount: 4, intervalMs: 250 };
  const performanceOn = (context: string, fact: object = performance) => {
    const value = plan(fact);
    value.scenarios[0]!.steps[0]!.observations[0]!.context = context;
    return value;
  };
  add("performance-server", performanceOn("server"));
  add("performance-client", performanceOn(actor), false);
  add(
    "performance-interval-floor",
    performanceOn("server", { ...performance, intervalMs: 249 }),
    false,
  );
  add(
    "performance-window",
    performanceOn("server", { ...performance, sampleCount: 480, intervalMs: 1251 }),
    false,
  );
  add("performance-path", performanceOn("server", { ...performance, path }), false);
  const performancePhase = plan(null);
  Object.assign(performancePhase.phases[0]!, { facts: [performance] });
  add("performance-phase", performancePhase, false);
  const layoutOn = (context: string, layoutPath: string, className = "ScreenGui") => {
    const value = plan({ id: "layout", kind: "gui_layout", path: layoutPath });
    Object.assign(value.roles[0]!, { className, scope: "local_player_gui" });
    value.scenarios[0]!.steps[0]!.observations[0]!.context = context;
    return value;
  };
  add("layout-client-role", layoutOn(actor, path));
  add("layout-client-literal", layoutOn(actor, "game.Players.LocalPlayer.PlayerGui.Hud"));
  add("layout-server", layoutOn("server", path), false);
  add("layout-gui-object-role", layoutOn(actor, path, "GuiObject"), false);
  add("layout-workspace-path", layoutOn(actor, "game.Workspace.Hud"), false);
  const layoutPhase = layoutOn(actor, path);
  layoutPhase.scenarios = [];
  Object.assign(layoutPhase.phases[0]!, {
    facts: [{ id: "layout", kind: "gui_layout", path }],
  });
  add("layout-phase", layoutPhase);
  const screenAnchor = anchored({ fact: anchorFacts.gui_visible, scope: actor });
  screenAnchor.roles[1]!.className = "ScreenGui";
  add("anchor-gui-visible-screen-gui", screenAnchor, false);
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-conformance-"));
  try {
    const file = resolve(directory, "plans.json");
    await writeFile(file, JSON.stringify(cases));
    const result = await execFile("lune", ["run", "scripts/test-plan-conformance.luau", file], {
      cwd: process.cwd(),
    });
    assert.match(result.stdout, new RegExp(`${cases.length} plans`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed fact diagnostics identify the exact phase or scenario location", () => {
  assert.throws(
    () => assertStudioCollectionPlan(plan(null, { kind: "undeclared_action", actor })),
    /Scenario behavior, step observe, action: Invalid Studio scenario action kind/u,
  );
  assert.throws(
    () => assertStudioCollectionPlan(plan({ id: "bar-after", kind: "gui_geometry" })),
    /Scenario behavior, step observe, context server, fact bar-after: Invalid Studio fact path/u,
  );
  const phase = plan(null);
  Object.assign(phase.phases[0]!, { facts: [{ id: "label", kind: "gui_text" }] });
  assert.throws(
    () => assertStudioCollectionPlan(phase),
    /Phase static, fact label: Invalid Studio fact path/u,
  );
});

test("the evaluator tool schema offers every drafted code check rule of the catalog", () => {
  const deterministic = privateEvaluatorSchema.properties.deterministic.items as {
    properties: { rule: { oneOf: unknown[] } };
  };
  const rules = (
    deterministic.properties.rule.oneOf as Array<{
      properties: { kind: { enum: string[] }; codes?: { items: { enum: string[] } } };
    }>
  ).map((entry) => entry.properties);
  // Only a person adds a step time bound, so the schema for drafts does not offer it.
  assert.deepEqual(
    rules.map((rule) => rule.kind.enum[0]).sort(),
    STUDIO_CAPABILITY_CATALOG.deterministicRules
      .filter((kind) => kind !== "scenario_step_within")
      .sort(),
  );
  assert.deepEqual(
    rules.find((rule) => rule.kind.enum[0] === "source_lint_absent")?.codes?.items.enum,
    [...SOURCE_LINT_CODES],
  );
  assert.ok(STUDIO_CAPABILITY_CATALOG.supported.includes("source_lint"));
});

test("a rule that waits for a spike stays out of the catalog, its text and the tool schema", () => {
  assert.deepEqual(
    [...SPIKE_PENDING_RULES],
    ["gui_layout_holds", "performance_within", "capture_text_contrast", "capture_exposure"],
  );
  const deterministic = privateEvaluatorSchema.properties.deterministic.items as {
    properties: { rule: { oneOf: Array<{ properties: { kind: { enum: string[] } } }> } };
  };
  const offered = deterministic.properties.rule.oneOf.map((entry) => entry.properties.kind.enum[0]);
  const catalogText = JSON.stringify(STUDIO_CAPABILITY_CATALOG);
  for (const kind of SPIKE_PENDING_RULES) {
    assert.ok(!(STUDIO_CAPABILITY_CATALOG.deterministicRules as readonly string[]).includes(kind));
    assert.ok(!offered.includes(kind), kind);
    assert.ok(!catalogText.includes(kind), kind);
  }
});
