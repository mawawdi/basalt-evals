import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  MAX_CANDIDATE_BYTES,
  MAX_HARNESS_TURNS,
  assertCandidateManifest,
  assertEvaluatorSpec,
  assertFrozenStudy,
  assertPublicTask,
  assertStudyDefinition,
  assertStudioCollectionPlan,
  hashJson,
  stableJson,
  type Treatment,
} from "../packages/contracts/src/index.js";
import {
  builderTaskView,
  freezeStudy,
  hashDirectoryTree,
  loadRegisteredTask,
  materializeTaskSeed,
} from "../packages/task-registry/src/index.js";
import {
  operatorStudyTemplate,
  readHarnessRegistry,
  readOperatorStudy,
} from "../packages/operator/src/config.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/index.js";
import { verifyCandidateLocally } from "../packages/graders/src/index.js";

const root = resolve(process.cwd());
const currentStudy = async (
  directories = [
    "tasks/pilot/moving-platform",
    "tasks/pilot/replicated-checkpoint",
    "tasks/pilot/timed-shutter",
    "tasks/pilot/cooperative-gate",
  ],
) => readOperatorStudy(root, directories);

const pairedStudy = (study: Awaited<ReturnType<typeof currentStudy>>) => {
  const models = study.models.filter((model) =>
    ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna"].includes(model.id),
  );
  return {
    ...study,
    models,
    transportConfigurationHash: hashJson(
      openRouterModelClientDescriptor(models.map((model) => model.id)),
    ),
  };
};

test("operator registry uses discovered tasks rather than a historical task list", async () => {
  const configuration = JSON.parse(await readFile("studies/operator-config.json", "utf8"));
  const { harnesses, defaultHarnessId } = await readHarnessRegistry(root);
  const directories = ["tasks/pilot/new-mechanic", "tasks/pilot/another-mechanic"];
  const study = operatorStudyTemplate(configuration, harnesses, directories);
  assert.deepEqual(study.taskDirectories, directories);
  assert.equal(study.models.length, 6);
  assert.deepEqual(
    study.harnesses.map((harness) => [harness.id, harness.developmentRuns]),
    [
      ["production-lint", 1],
      ["production", 1],
      ["thin", 0],
    ],
  );
  assert.equal(defaultHarnessId, "production");
  assert.throws(
    () =>
      operatorStudyTemplate(
        { ...configuration, taskDirectories: directories },
        harnesses,
        directories,
      ),
    /configuration fields/u,
  );
  assert.throws(
    () => operatorStudyTemplate({ ...configuration, harnesses }, harnesses, directories),
    /configuration fields/u,
  );
});

test("public task schema accepts open-ended requests without a mechanic category", async () => {
  const task = JSON.parse(
    await readFile(resolve(root, "tasks/pilot/cooperative-gate/task.json"), "utf8"),
  );
  assertPublicTask(task);
  assert.equal(task.schema, "basalt-evals/task");
  assert.ok(!Object.hasOwn(task, "category"));
  assert.throws(() => assertPublicTask({ ...task, category: "multiplayer_security" }), /fields/);
  assert.throws(() => assertPublicTask({ ...task, schema: "basalt-evals/unknown-task" }), /schema/);
});

test("Studio input plans allow only bounded typed drivers with declared readiness facts", async () => {
  const {
    evaluator: { studio: plan },
  } = await loadRegisteredTask(root, "studies/impact-vfx/task");
  assertStudioCollectionPlan(plan);
  assert.throws(
    () => assertStudioCollectionPlan({ ...plan, schema: "basalt-evals/unknown-plan" }),
    /schema/,
  );
  const capture = plan.phases[0]!.captures[0]!;
  assert.deepEqual(Object.keys(capture).sort(), ["id", "instruction"]);
  for (const field of ["viewport", "uiViewport", "camera", "code"]) {
    assert.throws(
      () =>
        assertStudioCollectionPlan({
          ...plan,
          phases: [{ ...plan.phases[0], captures: [{ ...capture, [field]: {} }] }],
        }),
      /fields/,
    );
  }
  const change = (driver: unknown) => ({ ...plan, phases: [{ ...plan.phases[0], driver }] });
  const driver = plan.phases[0]!.driver;
  assert.equal(driver.kind, "gui_button");
  assert.throws(
    () => assertStudioCollectionPlan(change({ ...driver, callback: "return true" })),
    /driver/i,
  );
  assert.throws(
    () => assertStudioCollectionPlan(change({ ...driver, timeoutMs: 60_001 })),
    /readiness/,
  );
  assert.throws(
    () => assertStudioCollectionPlan(change({ ...driver, path: "game.Workspace[1]" })),
    /readiness/,
  );
  assert.throws(
    () => assertStudioCollectionPlan(change({ ...driver, readyFactId: "hidden-oracle" })),
    /readiness/,
  );
  assert.throws(
    () => assertStudioCollectionPlan(change({ kind: "execute_luau", source: "print(1)" })),
    /kind/,
  );
  const shutter = await loadRegisteredTask(root, "tasks/pilot/timed-shutter");
  const presence = shutter.evaluator.studio.phases[0]!.driver;
  assert.equal(presence.kind, "wait_for_exists");
  assertStudioCollectionPlan(shutter.evaluator.studio);
  const shutterChange = (driver: unknown) => ({
    ...shutter.evaluator.studio,
    phases: [{ ...shutter.evaluator.studio.phases[0], driver }],
  });
  assert.throws(
    () => assertStudioCollectionPlan(shutterChange({ ...presence, readyValue: "closed" })),
    /driver/,
  );
  assert.throws(
    () => assertStudioCollectionPlan(shutterChange({ ...presence, readyFactId: "missing" })),
    /readiness/,
  );
  assertStudioCollectionPlan(
    shutterChange({
      kind: "character_reach_part",
      targetPath: "game.Workspace.Shutter",
      timeoutMs: 30_000,
    }),
  );
  assert.throws(
    () =>
      assertStudioCollectionPlan(
        shutterChange({
          kind: "character_reach_part",
          targetPath: "game.Workspace[1]",
          timeoutMs: 30_000,
        }),
      ),
    /reach-part/,
  );
  const checkpoint = await loadRegisteredTask(root, "tasks/pilot/replicated-checkpoint");
  const movement = checkpoint.evaluator.studio.phases[0]!.driver;
  assert.equal(movement.kind, "character_move_to");
  assertStudioCollectionPlan(checkpoint.evaluator.studio);
  assert.throws(
    () =>
      assertStudioCollectionPlan({
        ...checkpoint.evaluator.studio,
        phases: [
          {
            ...checkpoint.evaluator.studio.phases[0],
            driver: { ...movement, targetPath: "game.Workspace[1]" },
          },
        ],
      }),
    /readiness/,
  );
  assert.throws(
    () =>
      assertStudioCollectionPlan({
        ...checkpoint.evaluator.studio,
        phases: [
          {
            ...checkpoint.evaluator.studio.phases[0],
            driver: { ...movement, speed: 1000 },
          },
        ],
      }),
    /driver/,
  );
  assert.throws(
    () => assertStudioCollectionPlan({ ...plan, schema: "basalt-evals/unknown-plan" }),
    /schema/,
  );
});

test("multiplayer plans bind actors, contexts, actions, and hidden observations", async () => {
  const task = await loadRegisteredTask(root, "tasks/pilot/bomb-passing");
  const plan = task.evaluator.studio;
  assertStudioCollectionPlan(plan);
  assert.equal(plan.clients, 2);
  assert.deepEqual(plan.actors, ["holder", "receiver"]);
  assert.equal(plan.scenarios.length, 5);
  assert.equal(plan.phases[0]?.driver.kind, "wait_for_fact");

  const unknownActor = structuredClone(plan);
  const action = unknownActor.scenarios[0]!.steps[0]!.action;
  assert.equal(action.kind, "move_to");
  if (action.kind === "move_to") action.actor = "intruder";
  assert.throws(() => assertStudioCollectionPlan(unknownActor), /action actor/);

  const missingServer = structuredClone(plan);
  missingServer.scenarios[0]!.reportContexts = ["holder", "receiver"];
  assert.throws(() => assertStudioCollectionPlan(missingServer), /report contexts/);

  const reordered = structuredClone(plan);
  reordered.scenarios[0]!.steps[1]!.at = { startMs: 100 };
  assert.throws(
    () => assertStudioCollectionPlan(reordered),
    /step place-receiver-near timing: startMs=100 must be an integer from 500/,
  );
  const forward = structuredClone(plan);
  forward.scenarios[0]!.steps[3]!.at = { after: { step: "after-pass" }, offsetMs: 0 };
  assert.throws(() => assertStudioCollectionPlan(forward), /after\.step must name an earlier step/);

  const arbitraryKey = structuredClone(plan);
  Object.assign(arbitraryKey.scenarios[0]!.steps[0]!.action, { source: "return true" });
  assert.throws(() => assertStudioCollectionPlan(arbitraryKey), /movement fields/);

  // One message names the errors of all scenarios, so one correction can repair them together.
  const twoErrors = structuredClone(plan);
  twoErrors.scenarios[0]!.reportContexts = ["holder", "receiver"];
  twoErrors.scenarios[1]!.reportContexts = ["holder", "receiver"];
  assert.throws(
    () => assertStudioCollectionPlan(twoErrors),
    (error: Error) =>
      error.message.startsWith("2 Studio scenarios have errors:\n") &&
      error.message.split("\n").filter((line) => /report contexts/.test(line)).length === 2,
  );

  // A LocalPlayer path resolves only in the client context of an actor.
  const owned = structuredClone(plan);
  const observations = owned.scenarios[0]!.steps[0]!.observations;
  const wins = {
    id: "own-wins",
    kind: "instance",
    path: "game.Players.LocalPlayer.leaderstats.Wins",
  };
  observations.push({ context: "holder", fact: wins } as (typeof observations)[number]);
  assertStudioCollectionPlan(owned);
  observations.push({ context: "server", fact: wins } as (typeof observations)[number]);
  assert.throws(
    () => assertStudioCollectionPlan(owned),
    /context server, fact own-wins: the server has no LocalPlayer/,
  );
  // The same guard applies when the observation reads the Value of the leaderstats object.
  const valued = structuredClone(plan);
  const valueObservations = valued.scenarios[0]!.steps[0]!.observations;
  const winsValue = { ...wins, id: "own-wins-value", kind: "instance_value" };
  valueObservations.push({ context: "holder", fact: winsValue } as (typeof observations)[number]);
  assertStudioCollectionPlan(valued);
  valueObservations.push({ context: "server", fact: winsValue } as (typeof observations)[number]);
  assert.throws(
    () => assertStudioCollectionPlan(valued),
    /context server, fact own-wins-value: the server has no LocalPlayer/,
  );

  const builder = JSON.stringify(builderTaskView(task));
  assert.doesNotMatch(builder, /scenario_action_succeeded|reportContexts|minimumPassingScore/);
});

test("canonical JSON is key-order independent and rejects unsupported values", () => {
  assert.equal(stableJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
  assert.throws(() => stableJson({ bad: Number.NaN }), /finite/);
  assert.throws(() => stableJson({ bad: undefined }), /JSON-serializable/);
  assert.throws(() => stableJson(new Date("2026-09-17T00:00:00.000Z")), /plain objects/);
  assert.throws(() => stableJson(new Uint8Array([1, 2, 3])), /plain objects/);
  assert.throws(() => stableJson(new Array(1)), /dense data arrays/);
  const accessor = {} as { value?: number };
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => stableJson(accessor), /enumerable data properties/);
});

test("model transport allowlist identity is order independent", () => {
  const first = openRouterModelClientDescriptor(["b/model", "a/model"]);
  const second = openRouterModelClientDescriptor(["a/model", "b/model"]);
  assert.equal(
    first.configuration.routing.allowlistHash,
    second.configuration.routing.allowlistHash,
  );
  assert.deepEqual(first.configuration.routing.allowlistedModels, ["a/model", "b/model"]);
  assert.throws(() => openRouterModelClientDescriptor([" padded/model "]), /trimmed/);
  assert.throws(() => openRouterModelClientDescriptor(["a/model", "a/model"]), /unique/);
});

test("task registry keeps hidden evaluator material outside the builder view", async () => {
  const task = await loadRegisteredTask(root, "tasks/pilot/replicated-checkpoint");
  const builder = stableJson(builderTaskView(task));
  assert.doesNotMatch(builder, /checkpoint-state/);
  assert.doesNotMatch(builder, /evaluatorHash|collectionPlanHash|minimumPassingScore/);
  assert.match(stableJson(task.evaluator), /LastCheckpoint/);
  assert.match(task.id, /^replicated-checkpoint:/);
  const reservedCriterion = structuredClone(task.evaluator);
  reservedCriterion.visual[0]!.id = "human:visual:reserved";
  assert.throws(() => assertEvaluatorSpec(reservedCriterion), /visual criterion identity/);
});

test("pilot study freezes a deterministic balanced treatment matrix", async () => {
  const study = pairedStudy(await currentStudy());
  const connectorSourceHash = await hashDirectoryTree(resolve(root, "plugin"));
  const common = {
    repositoryRoot: root,
    study,
    implementationCommit: "a".repeat(40),
    dirty: false,
    connectorSourceHash,
    connectorArtifactHash: "b".repeat(64),
    frozenAt: "2026-09-17T00:00:00.000Z",
  };
  const first = await freezeStudy(common);
  const second = await freezeStudy(common);
  assertFrozenStudy(first);
  assert.equal(first.treatments.length, 72);
  assert.equal(new Set(first.treatments.map((entry) => entry.id)).size, 72);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.treatments.map((entry) => entry.task.id)).size, 4);
  assert.equal(new Set(first.treatments.map((entry) => entry.model.id)).size, 2);
  assert.equal(new Set(first.treatments.map((entry) => entry.harness.id)).size, 3);
  const tampered = structuredClone(first);
  tampered.treatments[0]!.randomSeed += 1;
  assert.throws(() => assertFrozenStudy(tampered), /treatment/);
  const reordered = structuredClone(first);
  reordered.treatments[0]!.repetition = 2;
  reordered.treatments[1]!.repetition = 1;
  reordered.treatments[0]!.id = treatmentId(reordered.treatments[0]!);
  reordered.treatments[1]!.id = treatmentId(reordered.treatments[1]!);
  assert.throws(() => assertFrozenStudy(reordered), /frozen treatment binding/);
  assert.throws(
    () =>
      assertStudyDefinition({
        ...study,
        environment: { ...study.environment, captureProtocol: "macos-window" },
      }),
    /capture protocol/,
  );
});

test("current builder study freezes two models across exactly two repetitions", async () => {
  const base = pairedStudy(await currentStudy(["tasks/pilot/bomb-passing"]));
  const study = { ...base, harnesses: [{ ...base.harnesses[0]!, maxTurns: 14 }], repetitions: 2 };
  const frozen = await freezeStudy({
    repositoryRoot: root,
    study,
    implementationCommit: "a".repeat(40),
    dirty: false,
    connectorSourceHash: await hashDirectoryTree(resolve(root, "plugin")),
    connectorArtifactHash: "b".repeat(64),
    frozenAt: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(frozen.treatments.length, 4);
  assert.deepEqual(
    [...new Set(frozen.treatments.map((entry) => entry.model.id))],
    ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna"],
  );
  assert.deepEqual(
    frozen.treatments.map((entry) => entry.repetition),
    [1, 2, 1, 2],
  );
  assert.equal(new Set(frozen.treatments.map((entry) => entry.task.id)).size, 1);
  assert.ok(frozen.treatments.every((entry) => entry.harness.maxTurns === 14));
});

test("plausible client-authoritative regression clears the local gate but faces hidden checks", async () => {
  const task = await loadRegisteredTask(root, "tasks/pilot/bomb-passing");
  const fixture = resolve(root, "studies/bomb-passing/regressions/client-selected-target");
  const local = await verifyCandidateLocally(fixture, task.publicTask);
  assert.equal(local.gate, "eligible", local.reasons.join("\n"));
  const criteria = new Set(task.evaluator.deterministic.map((criterion) => criterion.id));
  assert.ok(criteria.has("fuse-preserved"));
  assert.ok(criteria.has("forgery-rejected"));
  const forged = task.evaluator.studio.scenarios.find(
    (scenario) => scenario.id === "forged-request",
  );
  assert.equal(
    forged?.steps.some((step) => step.action.kind === "fire_remote"),
    true,
  );
});

function treatmentId(treatment: Treatment): string {
  const { schema: _schema, id: _id, ...body } = treatment;
  return `tr-${hashJson(body).slice(0, 20)}`;
}

test("candidate manifests bind sorted inventory, project file, and root hash", () => {
  const files = [
    { path: "default.project.json", hash: "a".repeat(64), bytes: 10 },
    { path: "src/Main.luau", hash: "b".repeat(64), bytes: 20 },
  ];
  const manifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  assertCandidateManifest(manifest);
  assert.throws(
    () => assertCandidateManifest({ ...manifest, files: [...files].reverse() }),
    /manifest identity/,
  );
  assert.throws(
    () => assertCandidateManifest({ ...manifest, rootHash: "c".repeat(64) }),
    /manifest identity/,
  );
  assert.throws(
    () =>
      assertCandidateManifest({
        ...manifest,
        files: [{ ...files[0]!, bytes: MAX_CANDIDATE_BYTES + 1 }],
      }),
    /candidate byte limit/,
  );
});

test("study validation bounds treatment expansion and harness budgets", async () => {
  const study = await currentStudy();
  assert.throws(
    () =>
      assertStudyDefinition({
        ...study,
        environment: { ...study.environment, viewport: { width: 8192, height: 8192 } },
      }),
    /study environment fields/,
  );
  assert.throws(() => assertStudyDefinition({ ...study, repetitions: 1_000 }), /10000 treatments/);
  assert.throws(
    () =>
      assertStudyDefinition({
        ...study,
        harnesses: [{ ...study.harnesses[0]!, maxTurns: MAX_HARNESS_TURNS + 1 }],
      }),
    /harness maxTurns/,
  );
});

test("task seeds are independent of temporary output state", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-registry-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    assert.equal(task.seedHash.length, 64);
    assert.notEqual(task.seedHash, hashJson(temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test("seed materialization verifies the registered inventory before creating output", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-seed-preflight-"));
  const destination = resolve(temporary, "workspace");
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    await assert.rejects(
      materializeTaskSeed(root, { ...task, seedHash: "0".repeat(64) }, destination),
      /seed no longer matches/,
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("registry rejects symlinks in ancestor directories for reads and seed output", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-registry-symlink-"));
  try {
    const link = resolve(temporary, "repo-link");
    await symlink(root, link);
    await assert.rejects(
      loadRegisteredTask(link, "tasks/pilot/moving-platform"),
      /symbolic|unsafe/i,
    );
    await assert.rejects(hashDirectoryTree(resolve(link, "plugin")), /symbolic|unsafe/i);
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const outputLink = resolve(temporary, "output-link");
    await symlink(temporary, outputLink);
    await assert.rejects(
      materializeTaskSeed(root, task, resolve(outputLink, "workspace")),
      /symbolic|unsafe/i,
    );
    await assert.rejects(lstat(resolve(temporary, "workspace")), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
