import assert from "node:assert/strict";
import test from "node:test";
import { combineNativeWork, nativeLaunchWork } from "../packages/studio-runner/src/workload.js";
import { readHarnessRegistry } from "../packages/operator/src/config.js";
import {
  assertSemanticRoles,
  assertStudioObservation,
  type StudioCollectionPlan,
} from "../packages/contracts/src/index.js";

test("semantic role contracts distinguish required binding failures from legitimate absence", () => {
  assertSemanticRoles([
    {
      id: "optional_object",
      className: "BasePart",
      scope: "workspace",
      cardinality: "zero_or_one",
    },
  ]);
  assertStudioObservation({
    factId: "object",
    kind: "binding_failure",
    requestedKind: "instance",
    path: "role.optional_object",
    reason: "missing",
  });
  assertStudioObservation({ factId: "object", kind: "instance", exists: false, className: "" });
  assert.throws(() =>
    assertSemanticRoles([
      {
        id: "object",
        className: "BasePart",
        scope: "workspace",
        cardinality: "any",
      },
    ]),
  );
  // The role id is the tag, so a role has no separate tag.
  assert.throws(
    () =>
      assertSemanticRoles([
        {
          id: "object",
          tag: "Object",
          className: "BasePart",
          scope: "workspace",
          cardinality: "zero_or_one",
        },
      ]),
    /semantic role fields/,
  );
  // One message names each invalid role and each of its problems.
  assert.throws(
    () =>
      assertSemanticRoles([
        {
          id: "basalt.round.state",
          className: "Folder",
          scope: "replicated_storage",
          cardinality: "zero_or_one",
        },
        { id: "hud", className: "Sound", scope: "player", cardinality: "one" },
      ]),
    (error: Error) =>
      /^Invalid semantic role binding: role 0 \("basalt\.round\.state"\): id must have/.test(
        error.message,
      ) &&
      /role 1 \("hud"\): className must be one of .*; scope must be one of .*; cardinality must be one of/.test(
        error.message,
      ),
  );
});

test("capture passes count their scenario roots, clients and bounded recovery independently", () => {
  const plan: StudioCollectionPlan = {
    schema: "basalt-evals/studio-plan",
    clients: 2,
    actors: [],
    roles: [],
    scenarios: [
      {
        id: "scenario",
        label: "Scenario",
        durationMs: 1000,
        reportContexts: ["server"],
        steps: [
          {
            id: "wait",
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
    phases: [],
  };
  assert.deepEqual(nativeLaunchWork(plan, 4), {
    capturePasses: 4,
    nativeRootLaunches: 8,
    nativeClientLaunches: 8,
    startupRecoveryRootLaunches: 24,
    startupRecoveryClientLaunches: 24,
  });
  const staticPlan = { ...plan, scenarios: [] };
  const combined = combineNativeWork(nativeLaunchWork(plan, 4), nativeLaunchWork(staticPlan, 3));
  assert.equal(combined.capturePasses, 7);
  assert.equal(combined.nativeRootLaunches, 11);
  assert.equal(combined.nativeClientLaunches, 8);
});

test("the harness comparison changes capability access without changing base instructions or bounds", async () => {
  const { harnesses } = await readHarnessRegistry(process.cwd());
  const thin = harnesses.find((item) => item.id === "thin")!;
  const production = harnesses.find((item) => item.id === "production")!;
  for (const key of ["systemPrompt", "maxTurns", "reasoning", "compaction"] as const)
    assert.deepEqual(thin[key], production[key]);
  assert.equal(thin.maxTurns, 32);
  assert.deepEqual([thin.developmentRuns, production.developmentRuns], [0, 1]);
  assert.deepEqual(
    production.tools.filter((tool) => !thin.tools.includes(tool)),
    ["development.run", "development.inspect"],
  );
  // Each request's output limit is the frozen endpoint's own, never a harness constant.
  for (const harness of [thin, production]) {
    assert.equal(Object.hasOwn(harness, "maxOutputTokensPerTurn"), false);
    assert.equal(Object.hasOwn(harness, "timeoutMs"), false);
  }
});
