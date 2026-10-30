import {
  capabilityFixture,
  syntheticObservation,
  fixtureAdapters,
  publicPreparation,
  seedModelRegistry,
  stagedPrivateRoles,
} from "./shared-api-fixture.js";
import type { PrivateProposal } from "../packages/eval-authoring/src/proposals.js";
import {
  readPublicPreparation,
  savePublicPreparation,
} from "../packages/operator/src/public-preparation.js";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { PREPARATION_ATTEMPTS } from "../packages/eval-authoring/src/preparation-request.js";
import { assertManifest, operationTreatments } from "../packages/operator/src/run-manifest.js";
import { stopFrozenRun, resumeFrozenRun } from "../packages/operator/src/run-report.js";
import assert from "node:assert/strict";
import {
  prepareEvalDraft,
  normalizePublicPreparation,
  normalizePublicProposal,
  normalizePrivateCriteria,
  normalizePrivatePlan,
  type PublicPreparation,
  type PublicProposal,
} from "../packages/agent-runtime/src/eval-preparation.js";
import {
  CONTROL_RATE_LIMIT,
  prepareControlCases,
  ModelControlProposer,
  closeMissingRoleControlOutcomes,
  normalizeControlExpectations,
  assertControlSourceFiles,
  type RetainedControlAttempt,
} from "../packages/agent-runtime/src/control-generation.js";
import {
  controlSpecs,
  controlOutcomeSchema,
  requiredNegativeControlIds,
} from "../packages/eval-authoring/src/control-specs.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { implementationFixture } from "./implementation-fixture.js";
import { testHarness, writeRunConfiguration } from "./builder-fixture.js";
import { evaluationCatalog } from "../packages/operator/src/discovery.js";
import { projectRegisteredEvaluation } from "../packages/eval-authoring/src/catalog.js";
import {
  compileEvalProposal,
  assertUnattendedEvalRevision,
  authoredCriteria,
  createEvalDraft,
  EvalDefinitionStore,
  stageEvalRevision,
  summarizeControls,
  publicEvalRevisionView,
  quoteControlPreparation,
  type CheckedControlCase,
  type EvalControlSet,
  type EvalProposal,
  type EvalRevision,
} from "../packages/eval-authoring/src/index.js";
import type { EvaluationReadinessRecord } from "../packages/eval-authoring/src/registration.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  assertEvaluatorSpec,
  contentHash,
  hashJson,
  stableJson,
  type Treatment,
} from "../packages/contracts/src/index.js";
import { materializeEvalRevision } from "../packages/eval-authoring/src/materialize.js";
import {
  assertNeutralInteractionClearance,
  assertNeutralPathReferences,
  assertPublicScene,
  neutralRojoSeed,
  neutralWorkspacePaths,
} from "../packages/eval-authoring/src/seed.js";
import { createRunQuote } from "../packages/model-client/src/quote.js";
import { modelRoute, type ModelSnapshot } from "../packages/model-client/src/catalog.js";
import {
  ModelRequestAdmissionError,
  ModelRequestValidationError,
  modelTurnRequestHash,
  type ModelClient,
} from "../packages/model-client/src/contracts.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/openrouter-ai-sdk.js";
import { freezeRunOperation, RunOperationStore } from "../packages/operator/src/operation.js";
import { executeFrozenBuilderCell } from "../packages/operator/src/run-builder.js";
import { quoteSavedReplay } from "../packages/operator/src/replay.js";
import { sealedEvalCandidate } from "../packages/operator/src/sealed-candidate.js";
import { executeFrozenDeterministicGradingCell } from "../packages/operator/src/run-grade.js";
import { executeFrozenJudgmentBatch } from "../packages/operator/src/run-judgment.js";
import {
  qualitativeCriteria,
  scoringCriteria,
  scoringConfiguration,
  scoringPresentation,
} from "../packages/eval-authoring/src/scoring.js";
import { judgmentMaterial } from "../packages/operator/src/judgment-material.js";
import { judgeCriteria, quoteRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import { repairSelection } from "../packages/operator/src/repair.js";
import { judgmentGroups } from "../packages/eval-authoring/src/rendered-selection.js";
import { prepareStudioSession } from "../packages/studio-runner/src/index.js";
import type { SignedWorkerManifest } from "../packages/studio-runner/src/native-worker.js";
import { createTextDraft, textDraft } from "../packages/operator/src/prepare-draft.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import {
  discoverTaskDirectories,
  loadRegisteredTask,
} from "../packages/task-registry/src/index.js";

const base = resolve("tasks/pilot/replicated-checkpoint");
const task = JSON.parse(await readFile(resolve(base, "task.json"), "utf8"));
const evaluator = JSON.parse(await readFile(resolve(base, "evaluator.json"), "utf8"));
const development = JSON.parse(await readFile(resolve(base, "development.json"), "utf8"));
const project = JSON.parse(await readFile(resolve(base, "seed/default.project.json"), "utf8"));
const candidatePaths = new Set<string>();
const collectPaths = (value: unknown): void => {
  if (Array.isArray(value)) for (const item of value) collectPaths(item);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (
        ["path", "targetPath", "barrierPath"].includes(key) &&
        typeof item === "string" &&
        item.startsWith("game.")
      )
        candidatePaths.add(item);
      collectPaths(item);
    }
};
collectPaths(evaluator.studio);
collectPaths(development.plan);
collectPaths(development.views);
const roleIds = new Map([...candidatePaths].map((path, index) => [path, `target-${index + 1}`]));
const roles = [...roleIds].map(([path, id]) => ({
  id,
  className: path.includes("PlayerGui")
    ? "GuiObject"
    : path.includes("ReplicatedStorage")
      ? "Folder"
      : "BasePart",
  scope: path.includes("PlayerGui")
    ? "local_player_gui"
    : path.includes("ReplicatedStorage")
      ? "replicated_storage"
      : "workspace",
  cardinality: "exactly_one",
}));
const bindPaths = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(bindPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      ["path", "targetPath", "barrierPath"].includes(key) &&
      typeof item === "string" &&
      roleIds.has(item)
        ? `role.${roleIds.get(item)}`
        : bindPaths(item),
    ]),
  );
};
const boundTask = {
  ...task,
  prompt: task.prompt + " Implement the server in src/server/Checkpoint.server.luau.",
  roles,
};
const boundEvaluator = {
  ...evaluator,
  studio: { ...(bindPaths(evaluator.studio) as object), roles },
};
const boundDevelopment = {
  ...development,
  plan: { ...(bindPaths(development.plan) as object), roles },
  views: bindPaths(development.views),
};
const draft = createEvalDraft({
  schema: "basalt-evals/eval-authoring-input",
  stages: [
    {
      prompt: boundTask.prompt,
      rubric: [
        evaluator.deterministic[0].statement,
        evaluator.visual[0].statement +
          " Score 0: Absent. Score 1: Visible. Score 2: Clear. Minimum passing score 1.\n  - Evidence class: appearance",
        evaluator.deterministic[1].statement,
        evaluator.deterministic[2].statement,
        evaluator.codeQuality[0].statement +
          " Score 0: Unsafe. Score 1: Server-owned. Score 2: Defensive. Minimum passing score 1.",
      ]
        .map((line) => "- " + line)
        .join("\n"),
    },
  ],
});
const rubricAuthority = (index: number) => ({
  source: "human_rubric" as const,
  start: draft.stages[0]!.criteria[index]!.start,
  end: draft.stages[0]!.criteria[index]!.end,
});
const proposal: EvalProposal = {
  publicTask: boundTask,
  publicDevelopment: boundDevelopment,
  privateEvaluator: boundEvaluator,
  seed: { project, sources: [{ path: "src/server/Checkpoint.server.luau", text: "-- neutral\n" }] },
  criterionMappings: [
    {
      authoredCriterionId: "criterion-1",
      authoredClauseIds: draft.stages[0]!.criteria[0]!.clauses.map((clause) => clause.id),
      authority: rubricAuthority(0),
      method: "deterministic",
      executableCriterionId: evaluator.deterministic[0].id,
      rationale: "Bound Studio observation",
    },
    {
      authoredCriterionId: "criterion-2",
      authoredClauseIds: draft.stages[0]!.criteria[1]!.clauses.map((clause) => clause.id),
      authority: rubricAuthority(1),
      method: "visual",
      executableCriterionId: evaluator.visual[0].id,
      rationale: "Captured player view",
    },
    ...evaluator.deterministic.slice(1).map((criterion: { id: string }, index: number) => ({
      authoredCriterionId: `criterion-${index + 3}`,
      authoredClauseIds: draft.stages[0]!.criteria[index + 2]!.clauses.map((clause) => clause.id),
      authority: rubricAuthority(index + 2),
      method: "deterministic" as const,
      executableCriterionId: criterion.id,
      rationale: "Bound Studio observation",
    })),
    {
      authoredCriterionId: "criterion-5",
      authoredClauseIds: draft.stages[0]!.criteria[4]!.clauses.map((clause) => clause.id),
      authority: rubricAuthority(4),
      method: "code",
      executableCriterionId: evaluator.codeQuality[0].id,
      rationale: "Source review",
    },
  ],
  requiredCapabilities: ["state_observation", "movement"],
};

test("prompt-derived neutral parts are bounded and usable without task-specific runner paths", () => {
  const scene = {
    parts: [
      {
        name: "EvalPlatform",
        position: [0, 5, 0] as [number, number, number],
        size: [12, 1, 12] as [number, number, number],
        anchored: true,
        canCollide: true,
        transparency: 0,
      },
      {
        name: "EndpointA",
        position: [0, 3, 0] as [number, number, number],
        size: [2, 6, 2] as [number, number, number],
        anchored: true,
        canCollide: false,
        transparency: 0.65,
      },
      {
        name: "EndpointB",
        position: [24, 3, 0] as [number, number, number],
        size: [2, 6, 2] as [number, number, number],
        anchored: true,
        canCollide: false,
        transparency: 0.65,
      },
    ],
  };
  assertPublicScene(scene);
  const seed = neutralRojoSeed("Moving platform", scene);
  const paths = neutralWorkspacePaths(seed.project);
  assert.ok(paths.has("game.Workspace.EndpointB"));
  assertNeutralPathReferences({ path: "game.Workspace.EndpointB" }, paths, []);
  assertNeutralPathReferences(
    [{ path: "game.Players.LocalPlayer" }, { path: "game.Players.LocalPlayer.leaderstats.Wins" }],
    paths,
    [],
  );
  assert.throws(
    () => assertNeutralPathReferences({ path: "game.Workspace.HiddenOracle" }, paths, ["orb"]),
    /public semantic role: game\.Workspace\.HiddenOracle\..*The declared roles are role\.orb\. .*The private part cannot add a role/,
  );
  // A route trace names its markers in startPath and endPath.
  assert.throws(
    () =>
      assertNeutralPathReferences(
        { startPath: "game.Workspace.EndpointB", endPath: "game.Workspace.EndpointZ" },
        paths,
        [],
      ),
    /public semantic role: game\.Workspace\.EndpointZ\./,
  );
  assert.throws(
    () =>
      assertNeutralPathReferences(
        [{ path: "game.Players.Player1.leaderstats.Wins" }, { path: "game.Workspace.Hidden" }],
        paths,
        [],
      ),
    (error: Error) =>
      /only through game\.Players\.LocalPlayer, in the client context of the actor that owns it: game\.Players\.Player1\.leaderstats\.Wins\./.test(
        error.message,
      ) && /public semantic role: game\.Workspace\.Hidden\./.test(error.message),
  );
  assert.throws(
    () => assertPublicScene({ parts: [{ ...scene.parts[0], name: "Ground" }] }),
    /omit Basalt-supplied Ground/,
  );
  assert.throws(
    () => assertPublicScene({ parts: [{ ...scene.parts[0], name: "EvalSpawn" }] }),
    /omit Basalt-supplied EvalSpawn/,
  );
  assert.throws(
    () => assertPublicScene({ parts: [scene.parts[0], scene.parts[0]] }),
    /duplicates part EvalPlatform/,
  );
  assert.throws(
    () => assertPublicScene({ parts: [{ ...scene.parts[0], position: [Infinity, 0, 0] }] }),
    /invalid or duplicate/,
  );
  const workspace = (seed.project as { tree: { Workspace: Record<string, unknown> } }).tree
    .Workspace;
  assert.equal(
    (workspace.EndpointB as { $properties: { CFrame: number[] } }).$properties.CFrame[0],
    24,
  );
});

test("post-spawn contact plans reject neutral parts already touching the avatar at spawn", () => {
  const scene = {
    parts: [
      {
        name: "CheckpointA",
        position: [0, 1, 16] as [number, number, number],
        size: [8, 1, 8] as [number, number, number],
        anchored: true,
        canCollide: true,
        transparency: 0,
      },
    ],
  };
  const plan = structuredClone(development.plan);
  const near = neutralRojoSeed("Checkpoint", scene);
  assert.throws(
    () => assertNeutralInteractionClearance(near.project, [plan]),
    /CheckpointA overlaps EvalSpawn's avatar contact area/,
  );
  const overlapping = structuredClone(proposal);
  overlapping.seed = near;
  const publicAction = overlapping.publicDevelopment.plan.scenarios[0]!.steps[0]!.action;
  assert.equal(publicAction.kind, "move_to");
  if (publicAction.kind === "move_to") publicAction.targetPath = "game.Workspace.CheckpointA";
  const compiled = compileEvalProposal(draft, 1, overlapping);
  assert.equal(compiled.revision, null);
  assert.match(stableJson(compiled.validation.diagnostics), /CheckpointA overlaps EvalSpawn/u);
  assert.throws(
    () => assertUnattendedEvalRevision(overlapping as EvalRevision),
    /CheckpointA overlaps EvalSpawn's avatar contact area/,
  );
  plan.scenarios[0].steps[0].action = { kind: "wait" };
  plan.phases[0].driver = {
    kind: "character_reach_part",
    targetPath: "game.Workspace.CheckpointA",
    timeoutMs: 30_000,
  };
  assert.throws(
    () => assertNeutralInteractionClearance(near.project, [plan]),
    /CheckpointA overlaps EvalSpawn's avatar contact area/,
  );
  const clear = neutralRojoSeed("Checkpoint", {
    parts: [{ ...scene.parts[0]!, position: [0, 1, 0] }],
  });
  assert.doesNotThrow(() => assertNeutralInteractionClearance(clear.project, [plan]));
  const elevated = neutralRojoSeed("Checkpoint", {
    parts: [{ ...scene.parts[0]!, position: [0, 30, 16] }],
  });
  assert.doesNotThrow(() => assertNeutralInteractionClearance(elevated.project, [plan]));
});

test("historical revision bytes remain inspectable when new execution rules reject them", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-archived-eval-"));
  try {
    const store = new EvalDefinitionStore(root);
    await store.writeDraft(draft);
    const current = compileEvalProposal(draft, 1, proposal).revision;
    assert.ok(current);
    const archived = structuredClone(current);
    archived.seed = neutralRojoSeed("Checkpoint", {
      parts: [
        {
          name: "CheckpointA",
          position: [0, 1, 16],
          size: [8, 1, 8],
          anchored: true,
          canCollide: true,
          transparency: 0,
        },
      ],
    });
    const action = archived.publicDevelopment.plan.scenarios[0]!.steps[0]!.action;
    assert.equal(action.kind, "move_to");
    if (action.kind === "move_to") action.targetPath = "game.Workspace.CheckpointA";
    const { id: _oldId, ...body } = archived;
    archived.id = hashJson(body);
    await assert.rejects(store.writeRevision(archived), /no longer validates/u);
    const artifacts = new ImmutableJsonArtifactStore(
      join(root, ".basalt-evals/eval-definition-artifacts"),
    );
    const artifact = await artifacts.write(archived);
    const files = new RepositoryFiles(root);
    await files.directory(".basalt-evals/authoring/revisions");
    await files.writeJson(`.basalt-evals/authoring/revisions/${archived.id}.json`, {
      schema: "basalt-evals/eval-definition-pointer",
      id: archived.id,
      artifact,
    });
    assert.deepEqual(await store.readRevision(archived.id), archived);
    await assert.rejects(
      store.readExecutableRevision(archived.id),
      /The current Basalt cannot run it/u,
    );
    assert.throws(() => assertUnattendedEvalRevision(archived), /overlaps EvalSpawn/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unscaled human criteria compile without generated numerical anchors", () => {
  const unscaledDraft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: boundTask.prompt,
        rubric: [
          evaluator.deterministic[0].statement,
          evaluator.visual[0].statement + "\n  - Evidence class: appearance",
          evaluator.deterministic[1].statement,
          evaluator.deterministic[2].statement,
          evaluator.codeQuality[0].statement,
        ]
          .map((line) => "- " + line)
          .join("\n"),
      },
    ],
  });
  const unscaledProposal = structuredClone(proposal);
  unscaledProposal.privateEvaluator.visual = [];
  unscaledProposal.privateEvaluator.codeQuality = [];
  unscaledProposal.privateEvaluator.unscaled = [
    {
      id: evaluator.visual[0].id,
      statement: unscaledDraft.stages[0]!.criteria[1]!.text,
      required: true,
      evidenceClass: "appearance",
      polarity: "presence",
      evidence: {
        sequence: false,
        actions: [],
        sourceSelection: null,
        facts: [],
        captureIds: evaluator.visual[0].captureIds,
      },
    },
    {
      id: evaluator.codeQuality[0].id,
      statement: unscaledDraft.stages[0]!.criteria[4]!.text,
      required: true,
      evidenceClass: null,
      polarity: "presence",
      evidence: {
        sequence: false,
        actions: [],
        facts: [],
        captureIds: [],
        sourceSelection: evaluator.codeQuality[0].sourceSelection,
      },
    },
  ];
  unscaledProposal.criterionMappings = unscaledProposal.criterionMappings.map((mapping, index) => ({
    ...mapping,
    authoredClauseIds: unscaledDraft.stages[0]!.criteria[index]!.clauses.map((clause) => clause.id),
    authority: {
      source: "human_rubric" as const,
      start: unscaledDraft.stages[0]!.criteria[index]!.start,
      end: unscaledDraft.stages[0]!.criteria[index]!.end,
    },
    method: index === 1 || index === 4 ? ("unscaled" as const) : mapping.method,
  }));
  const compiled = compileEvalProposal(unscaledDraft, 1, unscaledProposal);
  assert.ok(compiled.revision, stableJson(compiled.validation.diagnostics));
  assert.equal(compiled.revision.privateEvaluator.unscaled.length, 2);
  const missingRendered = structuredClone(unscaledProposal);
  const phase = missingRendered.privateEvaluator.studio.phases[0]!;
  missingRendered.privateEvaluator.unscaled[0]!.evidence = {
    sequence: false,
    actions: [],
    sourceSelection: null,
    facts: [{ phaseId: phase.id, factId: phase.facts[0]!.id }],
    captureIds: [],
  };
  const incompleteVisual = compileEvalProposal(unscaledDraft, 1, missingRendered);
  assert.equal(incompleteVisual.revision, null);
  assert.match(stableJson(incompleteVisual.validation.diagnostics), /signed rendered frames/u);
  missingRendered.privateEvaluator.unscaled[0]!.evidence.captureIds =
    evaluator.visual[0].captureIds;
  assert.ok(compileEvalProposal(unscaledDraft, 1, missingRendered).revision);
  missingRendered.privateEvaluator.unscaled[0]!.evidence.sourceSelection =
    evaluator.codeQuality[0].sourceSelection;
  assert.ok(
    compileEvalProposal(unscaledDraft, 1, missingRendered).revision,
    "One authored passage can consume source, signed facts and rendered captures together",
  );
  const retiredShape = structuredClone(missingRendered);
  Object.assign(retiredShape.privateEvaluator.unscaled[0]!.evidence, { kind: "studio_evidence" });
  assert.equal(compileEvalProposal(unscaledDraft, 1, retiredShape).revision, null);
  assert.equal(compiled.revision.privateEvaluator.visual.length, 0);
  assert.equal(compiled.revision.privateEvaluator.codeQuality.length, 0);
  const invented = structuredClone(unscaledProposal);
  invented.privateEvaluator.unscaled[0]!.statement += " Must be bright green.";
  assert.equal(compileEvalProposal(unscaledDraft, 1, invented).revision, null);
  assert.match(
    stableJson(compileEvalProposal(unscaledDraft, 1, invented).validation.diagnostics),
    /exact authored passage/,
  );
  assert.equal(compileEvalProposal(unscaledDraft, 1, proposal).revision, null);
});

test("moving-platform criteria cannot be judged from a still but can bind signed motion samples", () => {
  const moving = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: boundTask.prompt,
        rubric: [
          evaluator.deterministic[0].statement,
          "The anchored platform travels at least 18 studs along the route and returns.\n  - Evidence class: motion",
          evaluator.deterministic[1].statement,
          evaluator.deterministic[2].statement,
          evaluator.codeQuality[0].statement +
            " Score 0: Unsafe. Score 1: Server-owned. Score 2: Defensive. Minimum passing score 1.",
        ]
          .map((line) => "- " + line)
          .join("\n"),
      },
    ],
  });
  const candidate = structuredClone(proposal);
  candidate.privateEvaluator.visual = [];
  candidate.privateEvaluator.unscaled = [
    {
      id: evaluator.visual[0].id,
      statement: moving.stages[0]!.criteria[1]!.text,
      required: true,
      evidenceClass: "motion",
      polarity: "presence",
      evidence: {
        sequence: false,
        actions: [],
        sourceSelection: null,
        facts: [],
        captureIds: evaluator.visual[0].captureIds,
      },
    },
  ];
  candidate.criterionMappings = candidate.criterionMappings.map((mapping, index) => ({
    ...mapping,
    authoredClauseIds: moving.stages[0]!.criteria[index]!.clauses.map((clause) => clause.id),
    authority: {
      source: "human_rubric" as const,
      start: moving.stages[0]!.criteria[index]!.start,
      end: moving.stages[0]!.criteria[index]!.end,
    },
    method: index === 1 ? ("unscaled" as const) : mapping.method,
  }));
  const still = compileEvalProposal(moving, 1, candidate);
  assert.equal(still.revision, null);
  assert.match(stableJson(still.validation.diagnostics), /motion criterion needs a runtime-fact/);

  const phase = candidate.privateEvaluator.studio.phases[0]!;
  const partRole = boundTask.roles.find(
    (role: { className: string }) => role.className === "BasePart",
  )!;
  phase.facts.push({
    id: "platform-motion",
    kind: "part_motion",
    path: `role.${partRole.id}`,
    sampleCount: 240,
    intervalMs: 100,
  });
  candidate.privateEvaluator.unscaled[0]!.evidence = {
    sequence: false,
    actions: [],
    sourceSelection: null,
    facts: [{ phaseId: phase.id, factId: "platform-motion" }],
    captureIds: [],
  };
  const missingPhysics = compileEvalProposal(moving, 1, candidate);
  assert.equal(missingPhysics.revision, null);
  assert.match(stableJson(missingPhysics.validation.diagnostics), /part_physics/);
  phase.facts.push({ id: "platform-physics", kind: "part_physics", path: `role.${partRole.id}` });
  candidate.privateEvaluator.unscaled[0]!.evidence.facts.push({
    phaseId: phase.id,
    factId: "platform-physics",
  });
  const sampled = compileEvalProposal(moving, 1, candidate);
  assert.ok(sampled.revision, stableJson(sampled.validation.diagnostics));
  const eventTrace = structuredClone(candidate);
  eventTrace.privateEvaluator.studio.scenarios.push({
    id: "anchor-watch",
    label: "Observe anchored state during travel",
    durationMs: 2_000,
    reportContexts: ["server"],
    steps: [
      {
        id: "watch",
        at: { startMs: 0 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "wait" },
        observations: [
          {
            context: "server",
            fact: {
              id: "anchored-window",
              kind: "part_physics_trace",
              path: `role.${partRole.id}`,
              durationMs: 1_000,
            },
          },
        ],
      },
    ],
  });
  const eventEvidence = eventTrace.privateEvaluator.unscaled[0]!.evidence;
  if (!eventEvidence.facts.length) throw new Error("Missing event evidence fixture");
  eventEvidence.facts = eventEvidence.facts.filter((fact) => fact.factId !== "platform-physics");
  eventEvidence.facts.push({
    scenarioId: "anchor-watch",
    stepId: "watch",
    context: "server",
    factId: "anchored-window",
  });
  assert.ok(compileEvalProposal(moving, 1, eventTrace).revision);
  const wrongEventPart = structuredClone(eventTrace);
  const wrongTrace =
    wrongEventPart.privateEvaluator.studio.scenarios.at(-1)!.steps[0]!.observations[0]!.fact;
  if (wrongTrace.kind !== "part_physics_trace") throw new Error("Missing trace fixture");
  wrongTrace.path = "game.Workspace.Ground";
  assert.match(
    stableJson(compileEvalProposal(moving, 1, wrongEventPart).validation.diagnostics),
    /moving part/,
  );
  const splitChecks = structuredClone(candidate);
  const travelEvidence = splitChecks.privateEvaluator.unscaled[0]!.evidence;
  if (!travelEvidence.facts.length) throw new Error("Missing motion evidence");
  travelEvidence.facts = travelEvidence.facts.filter((fact) => fact.factId !== "platform-physics");
  splitChecks.privateEvaluator.deterministic.push({
    id: "platform-anchor",
    layer: "engine",
    statement: "The platform is anchored.",
    required: true,
    rule: {
      kind: "fact_equals",
      phaseId: phase.id,
      factId: "platform-physics",
      field: "anchored",
      expected: true,
    },
  });
  splitChecks.criterionMappings.push({
    ...splitChecks.criterionMappings[1]!,
    method: "deterministic",
    executableCriterionId: "platform-anchor",
  });
  assert.equal(
    compileEvalProposal(moving, 1, splitChecks).revision,
    null,
    "Supporting observations cannot inflate one rubric item into multiple outcomes",
  );
  const wrongPart = structuredClone(splitChecks);
  const physics = wrongPart.privateEvaluator.studio.phases[0]!.facts.find(
    (fact) => fact.id === "platform-physics",
  );
  if (!physics || physics.kind !== "part_physics") throw new Error("Missing physics fact");
  physics.path = "game.Workspace.Ground";
  assert.match(
    stableJson(compileEvalProposal(moving, 1, wrongPart).validation.diagnostics),
    /moving part/,
  );
  const excessive = structuredClone(candidate);
  const motion = excessive.privateEvaluator.studio.phases[0]!.facts.find(
    (fact) => fact.id === "platform-motion",
  );
  if (!motion || motion.kind !== "part_motion") throw new Error("Missing motion fixture");
  motion.sampleCount = 481;
  assert.match(
    stableJson(compileEvalProposal(moving, 1, excessive).validation.diagnostics),
    /motion samples/,
  );
});

test("numeric grading cannot alter authored anchor labels or invent a passing score", () => {
  const altered = structuredClone(proposal);
  altered.privateEvaluator.visual[0]!.anchors[1]!.label = "Different";
  const result = compileEvalProposal(draft, 1, altered);
  assert.equal(result.revision, null);
  assert.match(stableJson(result.validation.diagnostics), /score anchors differ/);
  const noThresholdDraft = createEvalDraft({
    ...draft.input,
    stages: [
      {
        ...draft.input.stages[0]!,
        rubric: draft.stages[0]!.rubric.replaceAll(" Minimum passing score 1.", ""),
      },
    ],
  });
  const noThresholdProposal = structuredClone(proposal);
  noThresholdProposal.criterionMappings = noThresholdProposal.criterionMappings.map(
    (mapping, index) => ({
      ...mapping,
      authoredClauseIds: noThresholdDraft.stages[0]!.criteria[index]!.clauses.map(
        (clause) => clause.id,
      ),
      authority: {
        source: "human_rubric" as const,
        start: noThresholdDraft.stages[0]!.criteria[index]!.start,
        end: noThresholdDraft.stages[0]!.criteria[index]!.end,
      },
    }),
  );
  const unresolved = compileEvalProposal(noThresholdDraft, 1, noThresholdProposal);
  assert.equal(unresolved.revision, null);
  assert.match(stableJson(unresolved.validation.diagnostics), /passing score/);
});

function checkedValidationRecord(
  revision: EvalRevision,
  implementationCommit = "b".repeat(40),
): EvaluationReadinessRecord {
  return {
    validation: {
      schema: "basalt-evals/eval-validation",
      draftId: revision.draftId,
      revisionId: revision.id,
      status: "controls_checked",
      diagnostics: [],
      preparation: "compiled",
      acquisition: "validated",
      discrimination: "validated",
      humanCalibration: "unavailable",
      controlSetHash: "a".repeat(64),
      unreviewedClaims: [],
    },
    check: {
      schema: "basalt-evals/control-check",
      revisionId: revision.id,
      batchId: "d".repeat(64),
      controlSetHash: "a".repeat(64),
      implementationCommit,
      connectorArtifactHash: "c".repeat(64),
      status: "checked",
      acquisition: "validated",
      discrimination: "validated",
      diagnostics: [],
      unreviewedClaims: [],
      scoreContrasts: [],
      cases: [],
    },
    nextRecordHash: null,
  };
}

async function saveCheckedValidationRecord(
  root: string,
  revision: EvalRevision,
  implementationCommit = "b".repeat(40),
): Promise<void> {
  const record = checkedValidationRecord(revision, implementationCommit);
  await new RepositoryFiles(root).writeJson(
    `.basalt-evals/eval-validations/${revision.id}/${hashJson(record)}.json`,
    record,
  );
}

test("operator and console share immutable two-input draft storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-operator-draft-"));
  try {
    const created = await createTextDraft(root, draft.input);
    assert.deepEqual(created, draft);
    assert.deepEqual(await textDraft(root, draft.id), draft);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved control-checked eval quotes exact builder, capture, and grading cells", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const root = await mkdtemp(join(tmpdir(), "basalt-eval-run-quote-"));
  await seedModelRegistry(root);
  try {
    const definitions = new EvalDefinitionStore(root);
    await definitions.writeDraft(draft);
    await definitions.writeRevision(revision);
    await saveCheckedValidationRecord(root, revision);
    await writeRunConfiguration(root);
    const snapshot: ModelSnapshot = {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      revision: "test-catalog-revision",
      capturedAt: "2026-09-23T00:00:00.000Z",
      inputModalities: ["text", "image"],
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
          tag: "test-provider",
          provider: "test",
          quantization: "unknown",
          contextLength: 100_000,
          maxPromptTokens: null,
          rawPricing: {},
          maxOutputTokens: 32768,
          supportedParameters: ["tools"],
          tiers: [
            {
              minPromptTokens: 0,
              temporal: null,
              inputPerTokenUsd: 0.000001,
              outputPerTokenUsd: 0.000002,
              imagePerImageUsd: 0.001,
              requestUsd: 0,
              cacheReadPerTokenUsd: null,
              cacheWritePerTokenUsd: null,
            },
          ],
        },
      ],
      hash: "f".repeat(64),
    };
    const grader: ModelSnapshot = { ...snapshot, id: "xiaomi/mimo-v2.6-flash", name: "MiMo" };
    const selection = {
      captureScope: "final" as const,
      publicFeedbackId: null,
      sourceIds: [],
      parentSourceId: null,
      gradingMode: "all" as const,
      continuingOperationId: null,
      revisionId: revision.id,
      validationRecordHash: hashJson(checkedValidationRecord(revision)),
      builderModelIds: [snapshot.id],
      gradingModelId: grader.id,
      judgeSettings: { samples: 1, grouping: "shared" as const },
      harnessIds: ["thin" as const],
      repetitions: 1,
      nativeCaptureRepetitions: 2,
    };
    const saved = await quoteRegisteredEvalRun({
      root,
      selection,
      snapshots: [snapshot, grader],
    });
    const grading = saved.quote.workload.modelWork.filter((work) => work.stage === "grading");
    // Source criteria select no rendered evidence, so they get their own request with no images.
    assert.deepEqual(
      judgmentGroups(
        [
          ...revision.privateEvaluator.codeQuality,
          ...revision.privateEvaluator.visual,
          ...revision.privateEvaluator.unscaled,
        ],
        "shared",
      ).map((group) => group.images),
      [true, false],
    );
    assert.deepEqual(
      grading.map((work) => work.upper.images > 0),
      [true, false],
    );
    assert.equal(saved.quote.workload.judgmentBatches, 2 * 2);
    for (const work of grading) {
      assert.equal(
        work.upper.outputTokens,
        scoringConfiguration(revision, snapshot).maxOutputTokens,
      );
      assert.deepEqual(work.reasoning, scoringConfiguration(revision, snapshot).reasoning);
    }
    for (const work of quoteControlPreparation(
      [revision],
      snapshot,
      snapshot,
    ).workload.modelWork.filter((work) => work.stage === "grading")) {
      assert.equal(work.upper.outputTokens, grading[0]!.upper.outputTokens);
      assert.deepEqual(work.reasoning, grading[0]!.reasoning);
    }
    assert.equal(saved.quote.workload.independentBuilderTrials, 1);
    assert.equal(saved.quote.workload.nativeCaptureRepetitions, 2);
    assert.equal(saved.quote.workload.nativeRootLaunches, 2);
    assert.equal(
      saved.quote.workload.criterionOutcomes,
      2 *
        (revision.privateEvaluator.deterministic.length +
          revision.privateEvaluator.codeQuality.length +
          revision.privateEvaluator.visual.length),
    );
    assert.equal(
      saved.quote.workload.modelWork
        .filter((item) => item.stage === "builder")
        .reduce((sum, item) => sum + item.calls, 0),
      32,
    );
    assert.equal(
      (await quoteRegisteredEvalRun({ root, selection, snapshots: [snapshot, grader] })).id,
      saved.id,
    );
    await assert.rejects(
      quoteRegisteredEvalRun({
        root,
        selection: { ...selection, gradingModelId: null },
        snapshots: [snapshot],
      }),
      /judge model choice does not match this evaluation/,
    );
    // A run with only code checks needs no judge model and plans no judge request.
    const code = await quoteRegisteredEvalRun({
      root,
      selection: { ...selection, gradingMode: "code", gradingModelId: null },
      snapshots: [snapshot],
    });
    assert.equal(code.quote.workload.judgmentBatches, 0);
    assert.equal(
      code.quote.workload.criterionOutcomes,
      2 * revision.privateEvaluator.deterministic.length,
    );
    assert.deepEqual(
      code.quote.workload.modelWork.map((work) => work.stage),
      code.quote.workload.modelWork.map(() => "builder"),
    );
    await assert.rejects(
      quoteRegisteredEvalRun({
        root,
        selection: { ...selection, gradingMode: "code" },
        snapshots: [snapshot, grader],
      }),
      /Invalid bounded eval run selection/,
    );
    // Each judge sample is its own request, so the preview multiplies the judge requests.
    const sampled = await quoteRegisteredEvalRun({
      root,
      selection: { ...selection, judgeSettings: { samples: 3, grouping: "shared" } },
      snapshots: [snapshot, grader],
    });
    assert.equal(sampled.quote.workload.judgmentBatches, 3 * 2 * 2);
    assert.deepEqual(
      sampled.quote.workload.modelWork
        .filter((work) => work.stage === "grading")
        .map((work) => work.calls),
      grading.map((work) => 3 * work.calls),
    );
    const judged =
      revision.privateEvaluator.codeQuality.length + revision.privateEvaluator.visual.length;
    assert.equal(
      sampled.quote.workload.criterionOutcomes,
      saved.quote.workload.criterionOutcomes + 2 * 2 * judged,
    );
    // One criterion per request gives each observation one request for each judge criterion.
    const separate = await quoteRegisteredEvalRun({
      root,
      selection: { ...selection, judgeSettings: { samples: 1, grouping: "per_criterion" } },
      snapshots: [snapshot, grader],
    });
    assert.equal(separate.quote.workload.judgmentBatches, 2 * judged);
    assert.equal(separate.quote.workload.criterionOutcomes, saved.quote.workload.criterionOutcomes);
    // A record that differs from its hash is an integrity fault, with one text on each read path.
    const forged = hashJson({ forged: revision.id });
    await new RepositoryFiles(root).writeJson(
      `.basalt-evals/eval-validations/${revision.id}/${forged}.json`,
      checkedValidationRecord(revision),
    );
    await assert.rejects(
      quoteRegisteredEvalRun({
        root,
        selection: { ...selection, validationRecordHash: forged },
        snapshots: [snapshot, grader],
      }),
      /Validation evidence identity changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repair sends its judge model only for an evaluation with judge criteria", () => {
  const input = {
    modelId: "openai/gpt-6-luna",
    gradingModelId: "xiaomi/mimo-v2.6-flash",
    attempts: 1,
    passes: 1,
    publicFeedbackId: null,
  } as const;
  const evaluation = { id: "revision", validationRecordHash: "a".repeat(64) };
  assert.ok(judgeCriteria(proposal).length > 0);
  assert.equal(
    repairSelection(input, "production", "parent", evaluation, proposal).gradingModelId,
    "xiaomi/mimo-v2.6-flash",
  );
  const codeChecksOnly = {
    privateEvaluator: { ...proposal.privateEvaluator, codeQuality: [], visual: [], unscaled: [] },
  };
  assert.equal(judgeCriteria(codeChecksOnly).length, 0);
  assert.equal(
    repairSelection(input, "production", "parent", evaluation, codeChecksOnly).gradingModelId,
    null,
  );
});

test("prompt context cannot create additional scored criteria", () => {
  const extra = structuredClone(proposal.privateEvaluator.deterministic[0]!);
  extra.id = "prompt-only-check";
  const withPromptAuthority: EvalProposal = {
    ...proposal,
    privateEvaluator: {
      ...proposal.privateEvaluator,
      deterministic: [...proposal.privateEvaluator.deterministic, extra],
    },
    criterionMappings: [
      ...proposal.criterionMappings,
      {
        authoredCriterionId: null,
        authoredClauseIds: [],
        authority: {
          source: "builder_prompt",
          start: 0,
          end: draft.stages[0]!.prompt.length,
        },
        method: "deterministic",
        executableCriterionId: extra.id,
        rationale: "The public builder request establishes this requirement",
      },
    ],
  };
  assert.equal(compileEvalProposal(draft, 1, withPromptAuthority).revision, null);
  const forged = structuredClone(withPromptAuthority);
  forged.criterionMappings.at(-1)!.authority.end += 1;
  assert.equal(compileEvalProposal(draft, 1, forged).revision, null);
});

test("a generated proposal binds every exact human passage to executable evidence", () => {
  const result = compileEvalProposal(draft, 1, proposal);
  assert.equal(result.validation.status, "ready");
  assert.ok(result.revision);
  assert.equal(result.revision.rubricHash, draft.stages[0]!.rubricHash);
  assert.deepEqual(result.revision.authored.criteria, draft.stages[0]!.criteria);
  assert.equal(result.revision.authored.rubric, draft.stages[0]!.rubric);
  assert.ok(
    !JSON.stringify(publicEvalRevisionView(result.revision)).includes(draft.stages[0]!.rubric),
  );
  assert.equal(compileEvalProposal(draft, 1, proposal).revision?.id, result.revision.id);
});

test("the human evidence class routes rendered frames to appearance and other classes to runtime facts", () => {
  // Rebind the shared proposal to a rubric that differs only in its evidence class lines.
  const rebind = (rubric: string, candidate = structuredClone(proposal)) => {
    const authored = createEvalDraft({
      ...draft.input,
      stages: [{ ...draft.input.stages[0]!, rubric }],
    });
    candidate.criterionMappings = candidate.criterionMappings.map((mapping, index) => ({
      ...mapping,
      authoredClauseIds: authored.stages[0]!.criteria[index]!.clauses.map((clause) => clause.id),
      authority: {
        source: "human_rubric" as const,
        start: authored.stages[0]!.criteria[index]!.start,
        end: authored.stages[0]!.criteria[index]!.end,
      },
    }));
    return { authored, candidate };
  };
  const messages = (result: ReturnType<typeof compileEvalProposal>) =>
    stableJson(result.validation.diagnostics);
  const changed = structuredClone(proposal);
  changed.privateEvaluator.visual[0]!.evidenceClass = "timing";
  assert.match(
    messages(compileEvalProposal(draft, 1, changed)),
    /must use the evidence class that the rubric author set: appearance\. A model cannot set or change it/,
  );
  const unclassed = rebind(draft.stages[0]!.rubric.replace("\n  - Evidence class: appearance", ""));
  unclassed.candidate.privateEvaluator.visual[0]!.evidenceClass = null;
  const clarification = compileEvalProposal(unclassed.authored, 1, unclassed.candidate);
  assert.equal(clarification.validation.status, "needs_clarification");
  assert.match(messages(clarification), /Set an evidence class for this criterion/);
  const timed = rebind(draft.stages[0]!.rubric.replace("class: appearance", "class: timing"));
  timed.candidate.privateEvaluator.visual[0]!.evidenceClass = "timing";
  assert.match(
    messages(compileEvalProposal(timed.authored, 1, timed.candidate)),
    /A timing criterion needs a runtime-fact requirement/,
  );
  // The code-quality item is the last rubric line, so a nested class line belongs to it.
  const reviewed = rebind(draft.stages[0]!.rubric + "\n  - Evidence class: causality");
  assert.match(
    messages(compileEvalProposal(reviewed.authored, 1, reviewed.candidate)),
    /A causality criterion needs a signed runtime fact: an engine rule or evidence\.facts/,
  );
  const sourced = rebind(draft.stages[0]!.rubric + "\n  - Evidence class: appearance");
  assert.match(
    messages(compileEvalProposal(sourced.authored, 1, sourced.candidate)),
    /Source review cannot show what a player sees/,
  );
});

test("a drafted plan cannot set a step time bound or turn a sample into a deadline", () => {
  const timed = structuredClone(proposal);
  timed.privateEvaluator.studio.scenarios.push({
    id: "checkpoint-timing",
    label: "Checkpoint activation",
    durationMs: 6_000,
    reportContexts: ["server", "primary"],
    steps: [
      {
        id: "before",
        at: { startMs: 0 },
        horizonMs: 1_000,
        holdMs: 0,
        action: { kind: "wait" },
        observations: [
          {
            context: "server",
            fact: { id: "state", kind: "instance", path: "game.Workspace.CheckpointA" },
          },
        ],
        requirement: null,
      },
      {
        id: "activate",
        at: { after: { step: "before" }, offsetMs: 300 },
        horizonMs: 1_000,
        holdMs: 0,
        action: {
          kind: "move_to",
          actor: "primary",
          targetPath: "game.Workspace.CheckpointA",
        },
        observations: [],
        requirement: null,
      },
      {
        id: "after",
        at: {
          after: {
            fact: { kind: "instance_present", path: "game.Workspace.CheckpointA", present: true },
            scope: "server",
          },
          offsetMs: 0,
        },
        horizonMs: 3_000,
        holdMs: 0,
        action: { kind: "wait" },
        observations: [
          {
            context: "server",
            fact: { id: "state", kind: "instance", path: "game.Workspace.CheckpointA" },
          },
        ],
        requirement: { withinMs: 1_000, quote: "within 1 second" },
      },
    ],
  });
  timed.privateEvaluator.deterministic.push({
    id: "drafted-deadline",
    layer: "engine",
    statement: "The checkpoint becomes present within 1 second.",
    required: true,
    rule: { kind: "scenario_step_within", scenarioId: "checkpoint-timing", stepId: "after" },
  });
  timed.criterionMappings.push({
    authoredCriterionId: "criterion-1",
    authoredClauseIds: draft.stages[0]!.criteria[0]!.clauses.map((clause) => clause.id),
    authority: rubricAuthority(0),
    method: "deterministic",
    executableCriterionId: "drafted-deadline",
    rationale: "Generated timing interpretation",
  });
  // The shape is valid, but only a person can add the bound.
  assertEvaluatorSpec(timed.privateEvaluator);
  const drafted = compileEvalProposal(draft, 1, timed);
  assert.equal(drafted.revision, null);
  assert.match(stableJson(drafted.validation.diagnostics), /set requirement to null/u);
  const unbounded = structuredClone(timed);
  unbounded.privateEvaluator.studio.scenarios.at(-1)!.steps[2]!.requirement = null;
  assert.throws(
    () => assertEvaluatorSpec(unbounded.privateEvaluator),
    /human-authored requirement/u,
  );
  const fixedSample = structuredClone(unbounded);
  fixedSample.privateEvaluator.deterministic.at(-1)!.rule = {
    kind: "scenario_fact_equals",
    scenarioId: "checkpoint-timing",
    stepId: "after",
    context: "server",
    factId: "state",
    field: "exists",
    expected: true,
  };
  assert.match(
    stableJson(compileEvalProposal(draft, 1, fixedSample).validation.diagnostics),
    /fixed state sample/u,
  );
  // The refusal names its authored criterion. For a gate, only a person can choose another gate.
  const sampled = compileEvalProposal(draft, 1, fixedSample).validation.diagnostics.find(
    (item) => item.code === "fixed_state_sample",
  );
  assert.equal(sampled?.authoredCriterionId, "criterion-1");
  const gated = structuredClone(draft);
  gated.stages[0]!.gateCriterionIds = ["criterion-1"];
  const gate = compileEvalProposal(gated, 1, fixedSample).validation.diagnostics.find(
    (item) => item.code === "gate_fixed_state_sample",
  );
  assert.equal(gate?.authoredCriterionId, "criterion-1");
  assert.match(gate!.message, /scenario_number_delta_in_range.*a person must change the gate/u);
  fixedSample.privateEvaluator.deterministic.at(-1)!.rule.kind = "scenario_fact_supports_value";
  assert.match(
    stableJson(compileEvalProposal(draft, 1, fixedSample).validation.diagnostics),
    /cannot be a required failure gate/u,
  );
  fixedSample.privateEvaluator.deterministic.at(-1)!.required = false;
  assert.doesNotMatch(
    stableJson(compileEvalProposal(draft, 1, fixedSample).validation.diagnostics),
    /fixed state sample|cannot be a required failure gate|set requirement to null/u,
  );
  const untimedRole = structuredClone(fixedSample);
  untimedRole.privateEvaluator.deterministic.at(-1)!.rule.kind = "scenario_fact_equals";
  untimedRole.privateEvaluator.studio.scenarios.at(-1)!.steps[1]!.action = { kind: "wait" };
  untimedRole.privateEvaluator.studio.scenarios.at(-1)!.steps[2]!.observations[0]!.fact = {
    id: "state",
    kind: "instance",
    path: `role.${untimedRole.publicTask.roles[0]!.id}`,
  };
  assert.match(
    stableJson(compileEvalProposal(draft, 1, untimedRole).validation.diagnostics),
    /fixed state sample/u,
  );
  untimedRole.privateEvaluator.deterministic.at(-1)!.rule.kind = "scenario_fact_supports_value";
  assert.doesNotMatch(
    stableJson(compileEvalProposal(draft, 1, untimedRole).validation.diagnostics),
    /fixed state sample/u,
  );
});

test("candidate capture wait cannot become an unrequested pass/fail deadline", () => {
  const staticRole = structuredClone(proposal);
  staticRole.privateEvaluator.studio.phases.push({
    id: "candidate-capture-window",
    label: "Observe candidate",
    instruction: "Collect candidate evidence",
    driver: { kind: "wait_for_exists", readyFactId: "candidate-present", timeoutMs: 15_000 },
    facts: [
      {
        id: "candidate-present",
        kind: "instance",
        path: `role.${staticRole.publicTask.roles[0]!.id}`,
      },
    ],
    captures: [],
  });
  staticRole.privateEvaluator.deterministic.push({
    id: "candidate-present-by-window",
    layer: "engine",
    statement: "Candidate is present",
    required: false,
    rule: {
      kind: "fact_equals",
      phaseId: "candidate-capture-window",
      factId: "candidate-present",
      field: "exists",
      expected: true,
    },
  });
  assert.match(
    stableJson(compileEvalProposal(draft, 1, staticRole).validation.diagnostics),
    /candidate-dependent capture window into a pass\/fail deadline/u,
  );
  const roleRule = staticRole.privateEvaluator.deterministic.at(-1)!.rule;
  assert.equal(roleRule.kind, "fact_equals");
  if (roleRule.kind !== "fact_equals") throw new Error("Expected a phase equality rule");
  roleRule.expected = false;
  assert.match(
    stableJson(compileEvalProposal(draft, 1, staticRole).validation.diagnostics),
    /candidate-dependent capture window into a pass\/fail deadline/u,
  );
});

test("compiled evals cannot depend on manual Studio phases", () => {
  const manual = structuredClone(proposal);
  manual.publicDevelopment.plan.phases[0]!.driver = { kind: "manual" };
  manual.privateEvaluator.studio.phases[0]!.driver = { kind: "manual" };
  const compiled = compileEvalProposal(draft, 1, manual);
  assert.equal(compiled.revision, null);
  assert.match(stableJson(compiled.validation.diagnostics), /cannot run unattended/u);
  assert.throws(
    () => assertUnattendedEvalRevision(manual as EvalRevision),
    /cannot run unattended/u,
  );
});

test("a manual public phase is corrected by the rubric-blind public preparer", async () => {
  const diagnostics: string[][] = [];
  let calls = 0;
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async (input) => {
      diagnostics.push(input.diagnostics);
      calls += 1;
      const publicDevelopment = structuredClone(proposal.publicDevelopment);
      if (calls === 1) publicDevelopment.plan.phases[0]!.driver = { kind: "manual" };
      return publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment,
        publicScene: { parts: [] },
      });
    },
    ...stagedPrivateRoles(() => ({
      privateEvaluator: structuredClone(proposal.privateEvaluator),
      criterionMappings: structuredClone(proposal.criterionMappings),
      requiredCapabilities: [...proposal.requiredCapabilities],
    })),
  });
  assert.ok(prepared.revisions[0]);
  assert.equal(calls, 2);
  assert.match(diagnostics[1]!.join(" "), /public development cannot use manual Studio phases/u);
});

test("motion capability registration and unknown names preserve bounded correction", async () => {
  const measured = compileEvalProposal(draft, 1, {
    ...proposal,
    requiredCapabilities: [...proposal.requiredCapabilities, "part_motion"],
  });
  assert.ok(measured.revision, JSON.stringify(measured.validation.diagnostics));
  let privateCalls = 0;
  const corrections: string[][] = [];
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async () =>
      publicPreparation(
        structuredClone({
          publicTask: proposal.publicTask,
          publicDevelopment: proposal.publicDevelopment,
          publicScene: { parts: [] },
        }),
      ),
    ...stagedPrivateRoles((input) => {
      if (input.stage === "criteria") {
        privateCalls += 1;
        corrections.push(input.diagnostics);
      }
      return {
        privateEvaluator: structuredClone(proposal.privateEvaluator),
        criterionMappings: structuredClone(proposal.criterionMappings),
        requiredCapabilities:
          privateCalls === 1
            ? (["invented_motion_alias"] as unknown as EvalProposal["requiredCapabilities"])
            : [...proposal.requiredCapabilities, "part_motion"],
      };
    }),
  });
  assert.equal(privateCalls, 2);
  assert.match(corrections[1]!.join(" "), /Unknown required capability invented_motion_alias/);
  assert.ok(prepared.revisions[0]);
});

test("compiler retains actionable diagnostics for missing evidence and capabilities", () => {
  const missing = compileEvalProposal(draft, 1, {
    ...proposal,
    criterionMappings: proposal.criterionMappings.filter(
      (item) => item.authoredCriterionId !== "criterion-2",
    ),
  });
  assert.equal(missing.revision, null);
  assert.deepEqual(
    [
      ...new Set(
        missing.validation.diagnostics
          .filter((item) => item.code === "missing_coverage")
          .map((item) => item.authoredCriterionId)
          .filter((id) => id !== null),
      ),
    ],
    ["criterion-2"],
  );
  const unsupported = compileEvalProposal(draft, 1, {
    ...proposal,
    requiredCapabilities: ["data_store_persistence"],
  });
  assert.equal(unsupported.validation.status, "unsupported");
  assert.match(unsupported.validation.diagnostics[0]!.message, /data_store_persistence/);
});

test("covering one compound clause cannot silently cover its remaining requirements", () => {
  const incomplete = structuredClone(proposal);
  const mapping = incomplete.criterionMappings.find(
    (item) => item.authoredCriterionId === "criterion-5",
  )!;
  assert.ok(mapping.authoredClauseIds.length > 1);
  const omitted = mapping.authoredClauseIds.pop()!;
  const result = compileEvalProposal(draft, 1, incomplete);
  assert.equal(result.revision, null);
  const clause = draft.stages[0]!.criteria[4]!.clauses.find((clause) => clause.id === omitted)!;
  assert.ok(
    result.validation.diagnostics.some(
      (item) => item.code === "missing_coverage" && item.message.includes(clause.text),
    ),
  );
  mapping.authoredClauseIds.push("invented-clause");
  assert.match(
    stableJson(compileEvalProposal(draft, 1, incomplete).validation.diagnostics),
    /exact authored clauses/,
  );
});

test("compiler cannot silently rewrite the builder request", () => {
  const result = compileEvalProposal(draft, 1, {
    ...proposal,
    publicTask: { ...proposal.publicTask, prompt: "Build a different task" },
  });
  assert.equal(result.revision, null);
  assert.match(result.validation.diagnostics[0]!.message, /exact authored builder prompt/);
});

test("explicit rubric threshold and optional coverage retain human authority", () => {
  const preciseRubric = draft.stages[0]!.rubric.replace(
    evaluator.visual[0].statement,
    `${evaluator.visual[0].statement} The minimum passing score is exactly 1.`,
  );
  const precise = createEvalDraft({
    ...draft.input,
    stages: [{ ...draft.input.stages[0]!, rubric: preciseRubric }],
  });
  const altered = structuredClone(proposal);
  altered.criterionMappings = altered.criterionMappings.map((mapping) => {
    const criterion = precise.stages[0]!.criteria.find(
      (item) => item.id === mapping.authoredCriterionId,
    )!;
    return {
      ...mapping,
      authoredClauseIds: criterion.clauses.map((clause) => clause.id),
      authority: { source: "human_rubric" as const, start: criterion.start, end: criterion.end },
    };
  });
  altered.privateEvaluator.visual[0]!.minimumPassingScore = 2;
  const conflict = compileEvalProposal(precise, 1, altered);
  assert.equal(conflict.revision, null);
  assert.equal(conflict.validation.status, "preparation_failed");
  assert.ok(conflict.validation.diagnostics.some((item) => item.code === "invalid_proposal"));
  const optional = structuredClone(proposal);
  optional.privateEvaluator.visual[0]!.required = false;
  assert.equal(compileEvalProposal(draft, 1, optional).revision, null);
  assert.ok(
    compileEvalProposal(draft, 1, optional).validation.diagnostics.some((item) =>
      item.message.includes("became optional"),
    ),
  );
  const optionalDraft = createEvalDraft({
    ...draft.input,
    stages: [
      {
        ...draft.input.stages[0]!,
        rubric: draft.stages[0]!.rubric.replace(
          evaluator.visual[0].statement,
          `Optional: ${evaluator.visual[0].statement}`,
        ),
      },
    ],
  });
  const authoredOptional = optionalDraft.stages[0]!.criteria.find((item) => !item.required)!;
  assert.ok(authoredOptional);
  optional.privateEvaluator.visual[0]!.statement = authoredOptional.text;
  optional.criterionMappings = optional.criterionMappings.map((mapping) => {
    const criterion = optionalDraft.stages[0]!.criteria.find(
      (item) => item.id === mapping.authoredCriterionId,
    )!;
    return {
      ...mapping,
      authoredClauseIds: criterion.clauses.map((clause) => clause.id),
      authority: { source: "human_rubric", start: criterion.start, end: criterion.end },
    };
  });
  const validOptional = compileEvalProposal(optionalDraft, 1, optional);
  assert.ok(validOptional.revision, JSON.stringify(validOptional.validation.diagnostics));
  const humanOnly = structuredClone(proposal);
  const humanMapping = humanOnly.criterionMappings.find((item) => item.method === "deterministic")!;
  humanOnly.privateEvaluator.deterministic = humanOnly.privateEvaluator.deterministic.filter(
    (item) => item.id !== humanMapping.executableCriterionId,
  );
  humanMapping.method = "human";
  humanMapping.executableCriterionId = null;
  humanOnly.privateEvaluator.humanReview.push(
    draft.stages[0]!.criteria.find((item) => item.id === humanMapping.authoredCriterionId)!.text,
  );
  assert.equal(compileEvalProposal(draft, 1, humanOnly).validation.status, "needs_clarification");
});

test("headings and nested anchors retain exact CRLF spans in coverage", () => {
  const text =
    "## Timing\r\n- The gate opens promptly.\r\n  - 0: No response\r\n  - 1: Opens within one second\r\n\r\nOptional presentation:\r\n- Optional glow feedback";
  const parsed = authoredCriteria(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.text, "- The gate opens promptly.");
  assert.equal(parsed[1]?.text, "- Optional glow feedback");
  assert.equal(parsed[1]?.required, false);
  const document = createEvalDraft({
    ...draft.input,
    stages: [{ ...draft.input.stages[0]!, rubric: text }],
  }).stages[0]!.document;
  assert.ok(
    parsed[0]!.contextNodeIds.some(
      (id) => document.find((node) => node.id === id)?.text === "- 1: Opens within one second",
    ),
  );
  for (const criterion of parsed)
    assert.equal(text.slice(criterion.start, criterion.end), criterion.text);
});

test("generated exact source selections need public prompt authority", () => {
  const changed = structuredClone(proposal);
  changed.privateEvaluator.codeQuality[0]!.sourceSelection = {
    kind: "exact_files",
    paths: ["src/server/OnlyThis.server.luau"],
  };
  const result = compileEvalProposal(draft, 1, changed);
  assert.equal(result.revision, null);
  assert.ok(
    result.validation.diagnostics.some(
      (item) => item.code === "invalid_proposal" && item.message.includes("OnlyThis.server.luau"),
    ),
  );
  const scenePath = structuredClone(proposal);
  scenePath.privateEvaluator.deterministic[0]!.rule = {
    kind: "path_exists",
    path: "game.Workspace.CheckpointA",
  };
  assert.match(
    stableJson(compileEvalProposal(draft, 1, scenePath).validation.diagnostics),
    /path rule must select a Luau source file/u,
  );
  const unrequestedFile = structuredClone(proposal);
  unrequestedFile.privateEvaluator.deterministic[0]!.rule = {
    kind: "path_exists",
    path: "src/server/OnlyThis.server.luau",
  };
  assert.match(
    stableJson(compileEvalProposal(draft, 1, unrequestedFile).validation.diagnostics),
    /Exact source file src\/server\/OnlyThis.server.luau was not required/u,
  );
});

test("abstract semantic role classes cannot be compared to concrete ClassName facts", () => {
  const candidate = structuredClone(proposal);
  const criterion = candidate.privateEvaluator.deterministic.find(
    (item) => item.rule.kind === "fact_equals",
  );
  assert.ok(criterion && criterion.rule.kind === "fact_equals");
  criterion.rule.field = "className";
  criterion.rule.expected = "BasePart";
  const result = compileEvalProposal(draft, 1, candidate);
  assert.equal(result.revision, null);
  assert.ok(
    result.validation.diagnostics.some((item) =>
      item.message.includes("compares concrete ClassName to abstract BasePart"),
    ),
  );
});

test("private preparation cannot replace public fields or leak hidden canaries", async () => {
  const canary = "SECRET_PRIVATE_ORACLE_CANARY";
  const result = await prepareEvalDraft(draft, {
    preparePublic: async () =>
      publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      }),
    ...stagedPrivateRoles(
      () =>
        ({
          privateEvaluator: structuredClone(proposal.privateEvaluator),
          criterionMappings: structuredClone(proposal.criterionMappings),
          requiredCapabilities: [...proposal.requiredCapabilities],
          publicTask: { ...proposal.publicTask, acceptance: [canary] },
        }) as unknown as PrivateProposal,
    ),
  });
  assert.deepEqual(result.revisions, []);
  assert.match(result.validation.diagnostics[0]!.message, /Private criteria contains/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PRIVATE_ORACLE_CANARY/);
});

test("a local stop before dispatch ends preparation without a correction", async () => {
  let publicCalls = 0;
  await assert.rejects(
    prepareEvalDraft(draft, {
      preparePublic: async () => {
        publicCalls += 1;
        throw new ModelRequestAdmissionError(new Error("Execution source changed"));
      },
      ...stagedPrivateRoles(() => {
        throw new Error("The private call must not start");
      }),
    }),
    (error: unknown) =>
      error instanceof ModelRequestAdmissionError && error.message === "Execution source changed",
  );
  assert.equal(publicCalls, 1);
  let privateCalls = 0;
  await assert.rejects(
    prepareEvalDraft(draft, {
      preparePublic: async () =>
        publicPreparation({
          publicTask: structuredClone(proposal.publicTask),
          publicDevelopment: structuredClone(proposal.publicDevelopment),
          publicScene: { parts: [] },
        }),
      ...stagedPrivateRoles(() => {
        privateCalls += 1;
        throw new ModelRequestValidationError("The request has too many images");
      }),
    }),
    /The request has too many images/,
  );
  assert.equal(privateCalls, 1);
});

test("public correction receives its previous proposal and exact validation diagnostic", async () => {
  const seen: Array<{ attempt: number; diagnostic: string[]; previous: unknown }> = [];
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async (input) => {
      seen.push({
        attempt: input.attempt,
        diagnostic: input.diagnostics,
        previous: input.previousProposal,
      });
      const valid = publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      });
      if (input.attempt === 1) {
        const malformed = valid as unknown as Record<string, unknown>;
        malformed.views = [];
        return malformed as unknown as typeof valid;
      }
      return valid;
    },
    ...stagedPrivateRoles(() => ({
      privateEvaluator: structuredClone(proposal.privateEvaluator),
      criterionMappings: structuredClone(proposal.criterionMappings),
      requiredCapabilities: [...proposal.requiredCapabilities],
    })),
  });
  assert.ok(prepared.revisions[0], stableJson(prepared.validation.diagnostics));
  assert.deepEqual(prepared.attempts, {
    public: 2,
    stages: [{ privatePlan: 1, privateCriteria: 1 }],
  });
  assert.equal(seen[0]?.previous, null);
  assert.match(seen[1]!.diagnostic[0]!, /\/views: must NOT have additional properties/);
  assert.ok((seen[1]!.previous as Record<string, unknown>).views);
});

test("the public part and each private stage get their own corrections", async () => {
  const calls = { publicPlanning: 0, privatePlanning: 0, privateCriteria: 0 };
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async () => {
      calls.publicPlanning++;
      if (calls.publicPlanning === 1) throw new Error("Malformed public submission");
      return publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      });
    },
    ...stagedPrivateRoles(({ stage }) => {
      calls[stage === "plan" ? "privatePlanning" : "privateCriteria"]++;
      if (stage === "plan" ? calls.privatePlanning === 1 : calls.privateCriteria === 1)
        throw new Error(`Malformed private ${stage} submission`);
      return {
        privateEvaluator: structuredClone(proposal.privateEvaluator),
        criterionMappings: structuredClone(proposal.criterionMappings),
        requiredCapabilities: [...proposal.requiredCapabilities],
      };
    }),
  });
  assert.ok(prepared.revisions[0], stableJson(prepared.validation.diagnostics));
  assert.deepEqual(prepared.attempts, {
    public: 2,
    stages: [{ privatePlan: 2, privateCriteria: 2 }],
  });
  assert.deepEqual(calls, {
    publicPlanning: 2,
    privatePlanning: 2,
    privateCriteria: 2,
  });
});

test("a malformed private correction retains unresolved feedback without reopening public preparation", async () => {
  const seen: string[][] = [];
  let publicCalls = 0;
  const concern = "Correct the evidence mapping without changing the rubric.";
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async () => {
      publicCalls++;
      return publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      });
    },
    ...stagedPrivateRoles((input) => {
      seen.push([...input.diagnostics]);
      throw new Error(input.attempt === 1 ? concern : "Malformed private submission");
    }),
  });
  assert.deepEqual(prepared.revisions, []);
  assert.deepEqual(prepared.attempts, {
    public: 1,
    stages: [{ privatePlan: PREPARATION_ATTEMPTS, privateCriteria: 0 }],
  });
  assert.equal(publicCalls, 1);
  assert.ok(seen[1]!.includes("private plan: " + concern));
  assert.match(JSON.stringify(prepared.validation), /Malformed private submission/);
});

test("public proposal normalization repairs only a sole-step observation move, ID spelling and an absent step requirement", () => {
  const raw = structuredClone({
    publicTask: proposal.publicTask,
    publicDevelopment: proposal.publicDevelopment,
    publicScene: { parts: [] },
  }) as unknown as Record<string, unknown>;
  const development = raw.publicDevelopment as Record<string, unknown>;
  const plan = development.plan as Record<string, unknown>;
  plan.scenarios = [
    {
      id: "single_scene",
      label: "Inspect the scene",
      durationMs: 1000,
      reportContexts: ["server"],
      observations: [{ context: "server", fact: { kind: "diagnostics", id: "diag" } }],
      steps: [
        { id: "observe", at: { startMs: 0 }, horizonMs: 1000, holdMs: 0, action: { kind: "wait" } },
      ],
    },
  ];
  development.views = [
    {
      id: "single_view",
      scenarioId: "single_scene",
      requiredTransitions: [],
      camera: null,
      viewport: null,
    },
  ];
  const normalized = normalizePublicProposal(raw as unknown as PublicProposal);
  assert.equal(normalized.proposal.publicDevelopment.plan.scenarios[0]!.id, "single-scene");
  assert.equal(normalized.proposal.publicDevelopment.views[0]!.scenarioId, "single-scene");
  assert.equal(normalized.proposal.publicDevelopment.views[0]!.id, "single-view");
  assert.equal(
    normalized.proposal.publicDevelopment.plan.scenarios[0]!.steps[0]!.observations.length,
    1,
  );
  assert.equal(normalized.notes.length, 4);
  assert.ok(
    normalized.notes.includes(
      "Filled the absent requirement of 1 steps in scenario single_scene with null",
    ),
  );
  assert.equal(
    normalized.proposal.publicDevelopment.plan.scenarios[0]!.steps[0]!.requirement,
    null,
  );
  assert.ok(Object.hasOwn((plan.scenarios as Record<string, unknown>[])[0]!, "observations"));
  (plan.scenarios as Record<string, unknown>[])[0]!.steps = [
    { id: "one", at: { startMs: 0 }, horizonMs: 1000, holdMs: 0, action: { kind: "wait" } },
    { id: "two", at: { startMs: 1 }, horizonMs: 1000, holdMs: 0, action: { kind: "wait" } },
  ];
  const ambiguous = normalizePublicProposal(raw as unknown as PublicProposal);
  assert.ok(Object.hasOwn(ambiguous.proposal.publicDevelopment.plan.scenarios[0]!, "observations"));
});

test("the compiler names all independent errors of a proposal in one validation", () => {
  const broken = structuredClone(proposal);
  broken.privateEvaluator.task = { ...broken.privateEvaluator.task, slug: "another-task" };
  const action = broken.publicDevelopment.plan.scenarios[0]!.steps[0]!.action;
  assert.equal(action.kind, "move_to");
  if (action.kind === "move_to") action.targetPath = "game.Workspace.SpawnLocation";
  const compiled = compileEvalProposal(draft, 1, broken);
  assert.equal(compiled.revision, null);
  const messages = compiled.validation.diagnostics.map((item) => item.message);
  assert.ok(messages.some((message) => /bound to a different public task/u.test(message)));
  const paths = messages.find((message) => message.includes("game.Workspace.SpawnLocation"));
  assert.match(paths ?? "", /The neutral scene supplies only .*game\.Workspace\.EvalSpawn/u);
});

test("a departed client leaves reportContexts only when no report of it is read", () => {
  const raw = structuredClone({
    publicTask: proposal.publicTask,
    publicDevelopment: proposal.publicDevelopment,
    publicScene: { parts: [] },
  });
  const scenario = raw.publicDevelopment.plan.scenarios[0]!;
  const first = scenario.steps[0]!;
  scenario.reportContexts = [...scenario.reportContexts, "leaver"];
  scenario.steps.push({
    id: "leave",
    at: { after: { step: first.id }, offsetMs: 0 },
    horizonMs: 1_000,
    holdMs: 0,
    action: { kind: "disconnect", actor: "leaver" },
    observations: [],
    requirement: null,
  });
  const normalized = normalizePublicProposal(structuredClone(raw));
  assert.ok(
    !normalized.proposal.publicDevelopment.plan.scenarios[0]!.reportContexts.includes("leaver"),
  );
  assert.ok(
    normalized.notes.includes(
      `Removed departed client leaver from the reportContexts of ${scenario.id}`,
    ),
  );
  // If a step reads a report of that client, the validator keeps the conflict and names it.
  first.observations = [...first.observations, { ...first.observations[0]!, context: "leaver" }];
  const read = normalizePublicProposal(structuredClone(raw));
  assert.ok(read.proposal.publicDevelopment.plan.scenarios[0]!.reportContexts.includes("leaver"));
  assert.ok(!read.notes.some((note) => note.startsWith("Removed departed client")));
});

test("public proposal normalization keeps step and transition references aligned", () => {
  const raw = structuredClone({
    publicTask: proposal.publicTask,
    publicDevelopment: proposal.publicDevelopment,
    publicScene: { parts: [] },
  });
  raw.publicDevelopment.plan.scenarios[0]!.steps[0]!.id = "stand_on_platform";
  raw.publicDevelopment.views[0]!.requiredTransitions = [
    {
      id: "stand_on_platform",
      source: { kind: "action", stepId: "stand_on_platform" },
      effectWindowMs: 1000,
      holdMs: 0,
    },
  ];
  raw.publicDevelopment.plan.scenarios[0]!.steps.push({
    id: "follow",
    at: { after: { step: "stand_on_platform" }, offsetMs: 0 },
    horizonMs: 1_000,
    holdMs: 0,
    action: { kind: "wait" },
    observations: [],
    requirement: null,
  });
  const normalized = normalizePublicProposal(raw);
  assert.equal(
    normalized.proposal.publicDevelopment.plan.scenarios[0]!.steps[0]!.id,
    "stand-on-platform",
  );
  assert.deepEqual(normalized.proposal.publicDevelopment.plan.scenarios[0]!.steps.at(-1)!.at, {
    after: { step: "stand-on-platform" },
    offsetMs: 0,
  });
  assert.deepEqual(normalized.proposal.publicDevelopment.views[0]!.requiredTransitions, [
    {
      id: "stand-on-platform",
      source: { kind: "action", stepId: "stand-on-platform" },
      effectWindowMs: 1000,
      holdMs: 0,
    },
  ]);
  assert.equal(raw.publicDevelopment.plan.scenarios[0]!.steps[0]!.id, "stand_on_platform");
});

test("public proposal canonicalizes role IDs and their semantic references together", () => {
  const raw = structuredClone({
    publicTask: proposal.publicTask,
    publicDevelopment: proposal.publicDevelopment,
    publicScene: { parts: [] },
  });
  const original = raw.publicTask.roles[0]!.id;
  raw.publicTask.roles[0]!.id = "evalPlatform";
  raw.publicDevelopment.plan.roles[0]!.id = "evalPlatform";
  raw.publicDevelopment = JSON.parse(
    JSON.stringify(raw.publicDevelopment).replaceAll(`role.${original}`, "role.evalPlatform"),
  ) as typeof raw.publicDevelopment;
  const normalized = normalizePublicProposal(raw);
  assert.equal(normalized.proposal.publicTask.roles[0]!.id, "eval-platform");
  assert.equal(normalized.proposal.publicDevelopment.plan.roles[0]!.id, "eval-platform");
  assert.match(JSON.stringify(normalized.proposal.publicDevelopment), /role\.eval-platform/);
  assert.doesNotMatch(JSON.stringify(normalized.proposal.publicDevelopment), /role\.evalPlatform/);
  assert.equal(raw.publicTask.roles[0]!.id, "evalPlatform");
});

test("public correction restores only unchanged scene and misplaced plan sections", () => {
  const previous: PublicProposal = structuredClone({
    publicTask: proposal.publicTask,
    publicDevelopment: proposal.publicDevelopment,
    publicScene: { parts: [] },
  });
  const raw = structuredClone(previous) as unknown as Record<string, unknown>;
  const development = raw.publicDevelopment as Record<string, unknown>;
  const plan = development.plan as Record<string, unknown>;
  development.phases = plan.phases;
  delete plan.phases;
  raw.views = development.views;
  delete development.views;
  const normalized = normalizePublicProposal(raw as unknown as PublicProposal);
  assert.deepEqual(normalized.proposal, previous);
  assert.deepEqual(normalized.notes, [
    "Moved public views into publicDevelopment",
    "Moved public phases into publicDevelopment.plan",
  ]);
  const previousPreparation: PublicPreparation = {
    publicScene: previous.publicScene,
    stages: [{ publicTask: previous.publicTask, publicDevelopment: previous.publicDevelopment }],
  };
  const { publicScene: _scene, ...withoutScene } = structuredClone(previousPreparation);
  const restored = normalizePublicPreparation(
    withoutScene as unknown as PublicPreparation,
    previousPreparation,
  );
  assert.deepEqual(restored.preparation, previousPreparation);
  assert.deepEqual(restored.notes, ["Reused unchanged public scene from the previous proposal"]);
  assert.equal(
    Object.hasOwn(
      normalizePublicPreparation(
        withoutScene as unknown as PublicPreparation,
        withoutScene as unknown as PublicPreparation,
      ).preparation,
      "publicScene",
    ),
    false,
  );
  const conflicting = structuredClone(raw);
  (conflicting.publicDevelopment as Record<string, unknown>).views =
    previous.publicDevelopment.views;
  assert.ok(
    Object.hasOwn(
      normalizePublicProposal(conflicting as unknown as PublicProposal).proposal,
      "views",
    ),
  );
});

test("the private plan repair fills only an omitted fixed Studio plan schema", () => {
  const raw = structuredClone({
    studio: proposal.privateEvaluator.studio,
    sequence: proposal.privateEvaluator.sequence,
  });
  delete (raw.studio as { schema?: string }).schema;
  const normalized = normalizePrivatePlan(raw);
  assert.equal(normalized.plan.studio.schema, "basalt-evals/studio-plan");
  assert.match(normalized.notes[0]!, /fixed Studio plan schema/u);
  assert.equal((raw.studio as { schema?: string }).schema, undefined);

  const conflicting = structuredClone(raw);
  (conflicting.studio as { schema?: string }).schema = "wrong";
  assert.equal(normalizePrivatePlan(conflicting).plan.studio.schema, "wrong");
});

test("identical evidence references compile once without spending a correction or dropping distinct evidence", async () => {
  const fixture = capabilityFixture("causal");
  // Capture references need an appearance class, so this deduplication case sets one.
  fixture.input.stages[0]!.rubric = fixture.input.stages[0]!.rubric.replace(
    "causality",
    "appearance",
  );
  fixture.privateProposal.privateEvaluator.unscaled[0]!.evidenceClass = "appearance";
  const raw = structuredClone(fixture.privateProposal);
  const selection = raw.privateEvaluator.unscaled[0]!.evidence;
  const original = structuredClone(selection);
  selection.facts.push(...structuredClone(selection.facts));
  selection.actions.push(...structuredClone(selection.actions));
  selection.captureIds = ["scene", "scene"];
  assert.ok(selection.sourceSelection?.kind === "all_luau_in_roots");
  selection.sourceSelection.roots.push(...selection.sourceSelection.roots);
  const untouched = structuredClone(raw);
  const normalized = normalizePrivateCriteria(raw.privateEvaluator);
  const canonical = normalized.criteria.unscaled[0]!.evidence;
  assert.deepEqual(raw, untouched);
  assert.deepEqual(canonical, { ...original, captureIds: ["scene"] });
  assert.deepEqual(normalized.criteria.studio, raw.privateEvaluator.studio);
  assertEvaluatorSpec(normalized.criteria);
  assert.deepEqual(normalizePrivateCriteria(normalized.criteria).notes, []);
  let calls = 0;
  const prepared = await prepareEvalDraft(createEvalDraft(fixture.input), {
    preparePublic: async () => publicPreparation(fixture.publicProposal),
    ...stagedPrivateRoles(({ stage }) => {
      if (stage === "criteria") calls++;
      return raw;
    }),
  });
  assert.ok(prepared.revisions[0], JSON.stringify(prepared.validation));
  assert.equal(calls, 1);
  assert.deepEqual(prepared.attempts, {
    public: 1,
    stages: [{ privatePlan: 1, privateCriteria: 1 }],
  });
  assert.ok(prepared.normalizations.some((note) => note.includes("identical facts")));

  const misbound = structuredClone(raw);
  misbound.privateEvaluator.unscaled[0]!.evidence.facts.push({
    phaseId: "missing",
    factId: "beacon",
  });
  assert.throws(
    () => assertEvaluatorSpec(normalizePrivateCriteria(misbound.privateEvaluator).criteria),
    /missing Studio observation/,
  );
  const repeatedPlan = structuredClone(raw);
  repeatedPlan.privateEvaluator.studio.scenarios[0]!.steps.push(
    structuredClone(repeatedPlan.privateEvaluator.studio.scenarios[0]!.steps[0]!),
  );
  assert.throws(
    () => assertEvaluatorSpec(normalizePrivateCriteria(repeatedPlan.privateEvaluator).criteria),
    /duplicate|step/,
  );
});

test("runtime-error coverage is checked per judgment without changing public preparation", async () => {
  const fixture = capabilityFixture("gui");
  const draft = createEvalDraft(fixture.input);
  const original = structuredClone(fixture);
  const feedback: string[][] = [];
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async () => publicPreparation(fixture.publicProposal),
    ...stagedPrivateRoles(({ stage, attempt, diagnostics, publicProposal }) => {
      assert.deepEqual(publicProposal, fixture.publicProposal);
      if (stage === "criteria") feedback.push(diagnostics);
      const proposed = structuredClone(fixture.privateProposal);
      if (stage === "criteria" && attempt === 1)
        proposed.privateEvaluator.unscaled[0]!.evidence.facts = [];
      return proposed;
    }),
  });
  assert.ok(prepared.revisions[0], stableJson(prepared.validation));
  assert.deepEqual(prepared.attempts, {
    public: 1,
    stages: [{ privatePlan: 1, privateCriteria: 2 }],
  });
  assert.match(feedback[1]!.join(" "), /runtime-error wording needs a diagnostics observation/);
  assert.equal(prepared.revisions[0].authored.rubric, draft.stages[0]!.rubric);
  assert.deepEqual(fixture, original);
});

test("private normalization derives rule layers without changing authored authority", () => {
  const raw = structuredClone({
    privateEvaluator: proposal.privateEvaluator,
    criterionMappings: proposal.criterionMappings,
    requiredCapabilities: proposal.requiredCapabilities,
  });
  raw.privateEvaluator.deterministic[0]!.layer = "engine";
  raw.criterionMappings[0]!.authority = {
    source: "builder_prompt",
    start: 0,
    end: draft.stages[0]!.criteria[0]!.end,
  };
  const normalized = normalizePrivateCriteria(raw.privateEvaluator);
  assert.equal(normalized.criteria.deterministic[0]!.layer, "static");
  assert.equal(raw.privateEvaluator.deterministic[0]!.layer, "engine");
  assert.ok(normalized.notes.some((note) => note.includes("Derived static layer")));
  // A lint check reads sealed source. A build error check reads Studio facts.
  const analysisRules = normalizePrivateCriteria({
    deterministic: [
      { id: "lint", layer: "engine", rule: { kind: "source_lint_absent", codes: ["TypeError"] } },
      {
        id: "errors",
        layer: "static",
        rule: { kind: "build_errors_absent", facts: [{ phaseId: "scene", factId: "errors" }] },
      },
    ],
  });
  assert.deepEqual(
    analysisRules.criteria.deterministic.map((item) => item.layer),
    ["static", "engine"],
  );
});

test("private corrections keep the validated public contract byte-for-byte", async () => {
  let publicCalls = 0;
  let privateCalls = 0;
  const publicHashes: string[] = [];
  const prepared = await prepareEvalDraft(draft, {
    preparePublic: async () => {
      publicCalls += 1;
      return publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      });
    },
    ...stagedPrivateRoles(({ stage, publicProposal, previousPrivateProposal }) => {
      publicHashes.push(hashJson(publicProposal));
      if (stage === "criteria") {
        privateCalls += 1;
        if (privateCalls === 1) assert.equal(previousPrivateProposal, null);
        else assert.equal(previousPrivateProposal?.privateEvaluator.task.slug, "wrong-task");
      }
      const result = {
        privateEvaluator: structuredClone(proposal.privateEvaluator),
        criterionMappings: structuredClone(proposal.criterionMappings),
        requiredCapabilities: [...proposal.requiredCapabilities],
      };
      if (privateCalls === 1) result.privateEvaluator.task.slug = "wrong-task";
      return result;
    }),
  });
  assert.ok(prepared.revisions[0]);
  assert.equal(publicCalls, 1);
  assert.equal(privateCalls, 2);
  assert.equal(new Set(publicHashes).size, 1);
});

test("a failed preparation keeps the code and the authored criterion of its last problem", async () => {
  const gated = structuredClone(draft);
  const criterionId = gated.stages[0]!.criteria[0]!.id;
  gated.stages[0]!.gateCriterionIds = [criterionId];
  const prepared = await prepareEvalDraft(gated, {
    preparePublic: async () =>
      publicPreparation({
        publicTask: structuredClone(proposal.publicTask),
        publicDevelopment: structuredClone(proposal.publicDevelopment),
        publicScene: { parts: [] },
      }),
    ...stagedPrivateRoles(() => {
      const result = {
        privateEvaluator: structuredClone(proposal.privateEvaluator),
        criterionMappings: structuredClone(proposal.criterionMappings),
        requiredCapabilities: [...proposal.requiredCapabilities],
      };
      for (const criterion of result.privateEvaluator.deterministic) criterion.required = false;
      return result;
    }),
  });
  assert.equal(prepared.validation.status, "preparation_failed");
  const problem = prepared.validation.diagnostics.find((item) =>
    /^After 3 corrections, .*A gate needs a required deterministic code check/u.test(item.message),
  );
  assert.equal(problem?.authoredCriterionId, criterionId);
});

test("malformed private evaluator yields a bounded diagnostic", () => {
  const result = compileEvalProposal(draft, 1, {
    ...proposal,
    privateEvaluator: {} as EvalProposal["privateEvaluator"],
  });
  assert.equal(result.revision, null);
  assert.equal(result.validation.status, "preparation_failed");
  assert.ok(result.validation.diagnostics.some((item) => item.code === "invalid_proposal"));
});

test("compiled definitions materialize before explicit registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-eval-register-"));
  try {
    await Promise.all([
      mkdir(resolve(root, "tasks/pilot"), { recursive: true }),
      mkdir(resolve(root, "studies"), { recursive: true }),
    ]);
    const store = new EvalDefinitionStore(root);
    await store.writeDraft(draft);
    const compiled = compileEvalProposal(draft, 1, proposal);
    assert.ok(compiled.revision);
    await store.writeRevision(compiled.revision);
    const staged = await stageEvalRevision(root, compiled.revision.id);
    assert.deepEqual(await stageEvalRevision(root, compiled.revision.id), staged);
    assert.match(staged.directory, /^\.basalt-evals\/eval-staging\/[a-f0-9]{64}$/u);
    const loaded = await loadRegisteredTask(root, staged.directory);
    assert.equal(loaded.id, staged.taskId);
    assert.equal(loaded.publicTask.prompt, draft.stages[0]!.prompt);
    assert.ok(!(await discoverTaskDirectories(root)).includes(staged.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control gate checks frozen contrasts and permits coupled failures", () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const required = evaluator.deterministic.filter((item: { required: boolean }) => item.required);
  const visual = evaluator.visual.filter((item: { required: boolean }) => item.required);
  const code = evaluator.codeQuality.filter((item: { required: boolean }) => item.required);
  const specs: Omit<EvalControlSet, "id"> = {
    schema: "basalt-evals/eval-control-set",
    revisionId: revision.id,
    batchId: "d".repeat(64),
    implementationCommit: "a".repeat(40),
    connectorArtifactHash: "b".repeat(64),
    cases: [
      {
        id: "working",
        kind: "working",
        targetCriterionId: null,
        candidateHash: "1".repeat(64),
        contrast: "Working reference",
        basis: "Authored expected behavior",
        expectedDeterministic: Object.fromEntries(
          required.map((item: { id: string }) => [item.id, "verified"]),
        ),
      },
      {
        id: "alternative",
        kind: "alternative",
        targetCriterionId: null,
        candidateHash: "2".repeat(64),
        contrast: "Alternative valid structure",
        basis: "Same public behavior with different source organization",
        expectedDeterministic: Object.fromEntries(
          required.map((item: { id: string }) => [item.id, "verified"]),
        ),
      },
      ...[...required, ...code, ...visual].map((criterion: { id: string }, index: number) => ({
        id: `negative-${index}`,
        kind: "negative" as const,
        targetCriterionId: criterion.id,
        candidateHash: hashJson(criterion.id),
        contrast: "Targeted behavior violation",
        basis: "Source mutation of the working reference",
        expectedDeterministic: Object.fromEntries(
          required.map((item: { id: string }) => [
            item.id,
            item.id === criterion.id ? "rejected" : "verified",
          ]),
        ),
      })),
    ],
  };
  const set: EvalControlSet = { ...specs, id: hashJson(specs) };
  const cases: CheckedControlCase[] = set.cases.map((item) => ({
    ...item,
    receiptHash: "f".repeat(64),
    criteria: [...required, ...code, ...visual].map((criterion: { id: string }) => ({
      criterionId: criterion.id,
      layer: "engine" as const,
      outcome:
        item.expectedDeterministic[criterion.id] ??
        (item.targetCriterionId === criterion.id ? "rejected" : "verified"),
      explanation: "Signed control observation",
      evidence: ["f".repeat(64)],
      observed: null,
    })),
    captureIds: evaluator.studio.phases.flatMap((phase: { captures: Array<{ id: string }> }) =>
      phase.captures.map((capture) => capture.id),
    ),
    actionBindings: [],
    observationBindings: evaluator.studio.phases.flatMap(
      (phase: { id: string; facts: Array<{ id: string }> }) =>
        phase.facts.map((fact) => ({ phaseId: phase.id, factId: fact.id })),
    ),
  }));
  const checked = summarizeControls(revision, set, cases);
  assert.equal(checked.status, "checked", checked.diagnostics.join("; "));
  const acquisitionOnly = cases.map((item) => ({
    ...item,
    criteria: item.criteria.filter((criterion) =>
      required.some((required: { id: string }) => required.id === criterion.criterionId),
    ),
  }));
  assert.equal(summarizeControls(revision, set, acquisitionOnly).status, "incomplete");
  assert.ok(checked.unreviewedClaims.includes(visual[0].id));
  const scoredRevision = structuredClone(revision);
  const scored = scoredRevision.privateEvaluator.visual[0]!;
  scored.minimumPassingScore = null;
  scored.anchors = [];
  scored.scoreRange = { minimum: 0, maximum: 10, step: null };
  const scoredCases = structuredClone(cases);
  for (const control of scoredCases) {
    const result = control.criteria.find((criterion) => criterion.criterionId === scored.id)!;
    result.outcome = "incomplete";
    result.score =
      control.targetCriterionId === scored.id ? 2.5 : control.kind === "alternative" ? 8 : 7.5;
  }
  const scoredCheck = summarizeControls(scoredRevision, set, scoredCases);
  assert.equal(scoredCheck.status, "checked", scoredCheck.diagnostics.join("; "));
  assert.ok(scoredCheck.unreviewedClaims.includes("acceptance-threshold-unresolved:" + scored.id));
  assert.equal(
    scoredCheck.scoreContrasts.find((contrast) => contrast.expected === "distinct")?.result,
    "validated",
  );
  assert.equal(
    scoredCases[0]!.criteria.find((criterion) => criterion.criterionId === scored.id)!.outcome,
    "incomplete",
  );
  const scoringNegative = scoredCases.find((control) => control.targetCriterionId === scored.id)!;
  const scoringResult = scoringNegative.criteria.find(
    (criterion) => criterion.criterionId === scored.id,
  )!;
  scoringResult.score = 7.75;
  assert.equal(summarizeControls(scoredRevision, set, scoredCases).status, "failed");
  delete scoringResult.score;
  assert.equal(summarizeControls(scoredRevision, set, scoredCases).status, "incomplete");
  const broken = structuredClone(cases);
  broken[0]!.criteria[0]!.outcome = "rejected";
  const failed = summarizeControls(revision, set, broken);
  assert.equal(failed.status, "failed");
  assert.match(failed.diagnostics.join(" "), /expected verified, got rejected/);
  const coupled = structuredClone(specs);
  const second = required[1] as { id: string } | undefined;
  if (second) {
    const negative = coupled.cases.find(
      (item) => item.kind === "negative" && item.targetCriterionId === required[0]!.id,
    )!;
    negative.expectedDeterministic[second.id] = "rejected";
    const coupledSet: EvalControlSet = { ...coupled, id: hashJson(coupled) };
    const coupledRuns = structuredClone(cases);
    const run = coupledRuns.find((item) => item.id === negative.id)!;
    run.criteria.find((item) => item.criterionId === second.id)!.outcome = "rejected";
    assert.equal(summarizeControls(revision, coupledSet, coupledRuns).status, "checked");
  }
});

test("frozen run operation chains stage receipts and blocks uncertain paid work", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const snapshot: ModelSnapshot = {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    revision: "openai/gpt-6-luna-test",
    capturedAt: "2026-09-23T00:00:00.000Z",
    inputModalities: ["text", "image"],
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
        tag: "test",
        provider: "test",
        quantization: "unknown",
        contextLength: 100_000,
        maxPromptTokens: null,
        rawPricing: {},
        maxOutputTokens: 32768,
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
    hash: "f".repeat(64),
  };
  const quote = createRunQuote(
    {
      independentBuilderTrials: 1,
      nativeCaptureRepetitions: 3,
      capturePasses: 3,
      nativeRootLaunches: 3,
      nativeClientLaunches: 0,
      startupRecoveryRootLaunches: 9,
      startupRecoveryClientLaunches: 0,
      criterionOutcomes:
        3 *
        (revision.privateEvaluator.deterministic.filter((item) => item.required).length +
          revision.privateEvaluator.codeQuality.filter((item) => item.required).length +
          revision.privateEvaluator.visual.filter((item) => item.required).length),
      judgmentBatches: 3,
      modelWork: [
        {
          stage: "grading",
          modelId: snapshot.id,
          calls: 3,
          expected: null,
          upper: { inputTokens: 5000, outputTokens: 3000, images: 0, imageInputTokens: 0 },
        },
        {
          stage: "builder",
          modelId: snapshot.id,
          calls: 1,
          expected: { inputTokens: 1000, outputTokens: 1000, images: 0, imageInputTokens: 0 },
          upper: { inputTokens: 2000, outputTokens: 2000, images: 0, imageInputTokens: 0 },
        },
      ],
    },
    [snapshot],
    revision.id,
  );
  const controlsQuote = quoteControlPreparation([revision], snapshot, snapshot);
  assert.equal(
    controlsQuote.workload.modelWork
      .filter((work) => work.stage === "controls")
      .reduce((sum, work) => sum + work.calls, 0),
    3 *
      (2 +
        revision.privateEvaluator.deterministic.filter((item) => item.required).length +
        revision.privateEvaluator.codeQuality.filter((item) => item.required).length +
        revision.privateEvaluator.visual.filter((item) => item.required).length),
  );
  assert.equal(
    controlsQuote.workload.nativeRootLaunches,
    controlsQuote.workload.modelWork
      .filter((work) => work.stage === "controls")
      .reduce((sum, work) => sum + work.calls, 0) *
      (revision.privateEvaluator.studio.scenarios.length + 1),
  );
  const publicTaskHash = hashJson(revision.publicTask);
  const treatmentBody: Omit<Treatment, "schema" | "id"> = {
    ordinal: 1,
    studyHash: "1".repeat(64),
    task: {
      id: `${revision.publicTask.slug}:${publicTaskHash.slice(0, 12)}`,
      publicTaskHash,
      evaluatorHash: hashJson(revision.privateEvaluator),
      seedHash: "2".repeat(64),
      collectionPlanHash: hashJson(revision.privateEvaluator.studio),
    },
    model: {
      id: snapshot.id,
      responseModelId: snapshot.id,
      transport: "openrouter",
      revision: snapshot.revision,
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        capturedAt: snapshot.capturedAt,
      },
    },
    transportConfigurationHash: "3".repeat(64),
    harness: testHarness({ id: "thin" }),
    repetition: 1,
    randomSeed: 1,
    environment: {
      platform: "Roblox Studio",
      studioVersion: "test",
      captureProtocol: "studio-mcp-viewport",
      cameraProtocol: "fixed",
    },
  };
  const treatment: Treatment = {
    schema: "basalt-evals/treatment",
    id: `tr-${hashJson(treatmentBody).slice(0, 20)}`,
    ...treatmentBody,
  };
  const manifest = freezeRunOperation({
    inputHash: revision.draftId,
    stage: {
      firstRevisionId: revision.id,
      index: 1,
      count: 1,
      earlierPrompts: [],
      gateCriterionIds: [],
    },
    judgmentBatches: [1, 2, 3].map((pass) => ({
      id: `judgment-${pass}`,
      captureCellId: `capture-${pass}`,
      revisionId: revision.id,
      sampleGroupId: `judgment-${pass}`,
      sample: 1,
      grouping: "shared" as const,
      criterionIds: [...revision.privateEvaluator.codeQuality, ...revision.privateEvaluator.visual]
        .filter((c) => c.required)
        .map((c) => c.id),
      configuration: scoringConfiguration(revision, snapshot),
      presentation: scoringPresentation(revision),
      substitution: null,
    })),
    retainedSources: [],
    publicFeedbackId: null,
    views: [
      {
        id: "default",
        partition: "withheld",
        plan: revision.privateEvaluator.studio,
        sequence: null,
      },
    ],
    parentSourceId: null,
    gradingMode: "all",
    operationId: "eval-run-test",
    buildIdentityHash: "e".repeat(64),
    revision,
    validationRecord: checkedValidationRecord(revision),
    quote,
    implementationCommit: "b".repeat(40),
    connectorArtifactHash: "c".repeat(64),
    selectedModelIds: [snapshot.id],
    selectedHarnessIds: ["thin"],
    modelConcurrency: { [snapshot.id]: 4 },
    treatments: [treatment],
    captureCells: [1, 2, 3].map((pass) => ({
      id: `capture-${pass}`,
      treatmentId: treatment.id,
      viewId: "default",
      pass,
      partition: "withheld" as const,
    })),
    gradingCells: [1, 2, 3].flatMap((pass) =>
      [
        ...revision.privateEvaluator.deterministic
          .filter((item) => item.required)
          .map((item) => ({ id: item.id, method: "deterministic" as const })),
      ].map((criterion) => ({
        id: `grade-${pass}-${criterion.id}`,
        captureCellId: `capture-${pass}`,
        criterionId: criterion.id,
        method: criterion.method,
      })),
    ),
    // Checking carries the liability of bounded rate-limit retries.
    ceilingUsd: 0.3,
  });
  // A judgment batch reads the criteria of the evaluation of its own build.
  const otherRevision = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  otherRevision.judgmentBatches[0]!.revisionId = "f".repeat(64);
  assert.throws(() => assertManifest(otherRevision), /Invalid frozen judgment batch/u);
  const tooManySamples = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  tooManySamples.judgmentBatches[0]!.sample = 6;
  assert.throws(() => assertManifest(tooManySamples), /Invalid frozen judgment batch/u);
  // The samples of a group are numbered from 1 and send the same request.
  const gap = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  gap.judgmentBatches[0]!.sample = 2;
  assert.throws(() => assertManifest(gap), /Invalid frozen judge sample group/u);
  const different = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  different.judgmentBatches[1]!.sampleGroupId = different.judgmentBatches[0]!.sampleGroupId;
  different.judgmentBatches[1]!.sample = 2;
  assert.throws(() => assertManifest(different), /Invalid frozen judge sample group/u);
  const separate = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  separate.judgmentBatches[0]!.grouping = "per_criterion";
  assert.throws(() => assertManifest(separate), /Invalid frozen judgment batch/u);
  const root = await mkdtemp(join(tmpdir(), "basalt-run-operation-"));
  try {
    await saveCheckedValidationRecord(root, revision);
    const savedEvalManifest = { ...manifest, id: "saved-eval-run" };
    const savedEvalRun = new RunOperationStore(
      root,
      savedEvalManifest.id,
      hashJson(savedEvalManifest),
      savedEvalManifest.inputHash,
    );
    await savedEvalRun.create(savedEvalManifest);
    assert.deepEqual((await savedEvalRun.ledger.read()).authorizations, [
      { quoteHash: savedEvalManifest.quoteHash, ceilingUsd: savedEvalManifest.ceilingUsd },
    ]);
    const operation = new RunOperationStore(
      root,
      manifest.id,
      hashJson(manifest),
      manifest.inputHash,
    );
    await operation.ledger.initialize({
      quoteHash: hashJson("preparation-quote"),
      ceilingUsd: 0.03,
    });
    await operation.ledger.authorize({ quoteHash: hashJson("control-quote"), ceilingUsd: 0.06 });
    await operation.create(manifest);
    await operation.create(manifest);
    assert.deepEqual(operationTreatments((await operation.read()).manifest), [treatment]);
    await assert.rejects(
      operation.append({
        kind: "started",
        stage: "final_capture",
        unitId: "capture-1",
        artifactHashes: [],
        reason: null,
        at: "2026-09-23T00:00:00.000Z",
      }),
      /exact sealed source receipt/,
    );
    await assert.rejects(
      operation.append({
        kind: "started",
        stage: "report",
        unitId: "final",
        artifactHashes: [],
        reason: null,
        at: "2026-09-23T00:00:00.000Z",
      }),
      /all planned builder trials/,
    );
    const started = {
      kind: "started" as const,
      stage: "builder" as const,
      unitId: treatment.id,
      artifactHashes: [],
      reason: null,
      at: "2026-09-23T00:00:00.000Z",
    };
    await operation.append(started);
    assert.deepEqual((await operation.read()).inFlightUnits, [
      { stage: "builder", unitId: treatment.id },
    ]);
    await assert.rejects(operation.append(started), /twice/);
    await assert.rejects(
      operation.append({ ...started, kind: "completed", artifactHashes: ["d".repeat(64)] }),
      /run and sealed candidate hash/,
    );
    await operation.append({
      ...started,
      kind: "incomplete",
      artifactHashes: [],
      reason: "Offline fixture did not run a candidate",
    });
    assert.deepEqual((await operation.read()).completedUnits, []);
    await assert.rejects(operation.append(started), /twice/);
    const pending = "e".repeat(64);
    await operation.ledger.reserve({
      requestId: pending,
      requestHash: pending,
      stage: "judgment:judgment-1",
      maximumUsd: 0.01,
    });
    assert.equal((await operation.read()).uncertainBilling, true);
    assert.equal((await operation.read()).reservedUsd, 0.01);
    assert.equal((await operation.read()).uncertainRequests, 1);
    await assert.rejects(operation.append({ ...started, unitId: "trial-2" }), /dispatch/);
    await operation.ledger.reconcile(pending, 0.004);
    assert.equal((await operation.read()).uncertainBilling, false);
    assert.equal((await operation.read()).pendingBilling, false);
    assert.deepEqual((await operation.read()).inFlightUnits, []);
    await operation.append({
      ...started,
      kind: "stop_requested",
      stage: null,
      unitId: null,
      reason: "operator stopped",
    });
    assert.equal((await operation.read()).stopped, true);
    await operation.append({
      ...started,
      kind: "resumed",
      stage: null,
      unitId: null,
      reason: "operator resumed",
    });
    assert.equal((await operation.read()).stopped, false);
    await assert.rejects(operation.append({ ...started, unitId: "trial-2" }), /frozen treatment/);
    await assert.rejects(
      operation.append({
        ...started,
        kind: "completed",
        stage: "report",
        unitId: "final",
        artifactHashes: ["f".repeat(64)],
      }),
      /matching start/,
    );
    await operation.append({ ...started, stage: "report", unitId: "final" });
    const report = await operation.completeReport();
    assert.equal(report.outcome, "partial");
    assert.equal(report.units.final_capture.unattempted, 3);
    assert.equal((await operation.read()).finished, true);
    assert.equal((await operation.read()).measurementComplete, false);
    assert.deepEqual((await operation.read()).inFlightUnits, []);
    await rm(resolve(root, `.basalt-evals/eval-operations/${manifest.id}/report.json`));
    await assert.rejects(operation.read(), /ENOENT/);
    await rm(
      resolve(
        root,
        `.basalt-evals/eval-validations/${revision.id}/${hashJson(checkedValidationRecord(revision))}.json`,
      ),
    );
    await savedEvalRun.ledger.reserve({
      requestId: "f".repeat(64),
      requestHash: "f".repeat(64),
      stage: `builder:${treatment.id}`,
      maximumUsd: 0.01,
    });
    const stopped = await stopFrozenRun(
      root,
      savedEvalManifest.id,
      "Stop despite missing retained evidence",
    );
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.inFlightUnits, []);
    assert.equal(stopped.pendingBilling, true);
    assert.equal(stopped.reservedUsd, 0.01, "Stopping preserves uncertain request liabilities");
    await assert.rejects(
      resumeFrozenRun(root, savedEvalManifest.id),
      /ENOENT/,
      "Resume still requires the original verified evidence",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control preparation retains failed attempts and bounds corrections per case", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const generated: string[] = [];
  const result = await prepareControlCases({
    revision,
    startingFiles: null,
    batchId: "d".repeat(64),
    implementationCommit: "a".repeat(40),
    connectorArtifactHash: "b".repeat(64),
    propose: async ({ spec, attempt, workingFiles }) => {
      generated.push(`${spec.id}:${attempt}`);
      if (spec.kind !== "working") assert.ok(workingFiles);
      return {
        ...spec,
        id: `${spec.id}-attempt-${attempt}`,
        contrast: `${spec.kind} behavior`,
        basis: "Source inspection",
        expectedDeterministic: Object.fromEntries(
          revision.privateEvaluator.deterministic
            .filter((item) => item.required)
            .map((item) => [
              item.id,
              spec.kind === "negative" && spec.targetCriterionId === item.id
                ? "rejected"
                : "verified",
            ]),
        ),
        files: [{ path: "src/server/Main.server.luau", text: `-- ${spec.id} ${attempt}\n` }],
      };
    },
    verify: async (source) => ({
      accepted: source.id !== "working-attempt-1",
      candidateHash: hashJson(source.files),
      diagnostics: source.id === "working-attempt-1" ? ["Expected state not reached"] : [],
    }),
  });
  assert.equal(result.status, "ready_to_check");
  assert.ok(result.set);
  assert.equal(
    result.set.cases.length,
    2 +
      revision.privateEvaluator.deterministic.filter((item) => item.required).length +
      revision.privateEvaluator.codeQuality.filter((item) => item.required).length +
      revision.privateEvaluator.visual.filter((item) => item.required).length,
  );
  assert.deepEqual(generated.slice(0, 3), ["working:1", "working:2", "alternative:1"]);
  assert.equal(result.attempts.filter((item) => !item.result.accepted).length, 1);
});

test("environment player-count assertions use positive controls without impossible candidate negatives", () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const adapted = structuredClone(revision);
  const phase = adapted.privateEvaluator.studio.phases[0];
  assert.ok(phase);
  phase.facts.push({ id: "environment-players", kind: "player_count" });
  adapted.privateEvaluator.deterministic.push({
    id: "environment-player-count",
    layer: "engine",
    statement: "The Studio session has one player.",
    required: true,
    rule: {
      kind: "fact_equals",
      phaseId: phase.id,
      factId: "environment-players",
      field: "value",
      expected: 1,
    },
  });
  assert.ok(!requiredNegativeControlIds(adapted).includes("environment-player-count"));
  assert.ok(
    !controlSpecs(adapted).some((item) => item.targetCriterionId === "environment-player-count"),
  );
});

test("control tool schema permits only named required outcome statuses", () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const schema = controlOutcomeSchema(revision);
  const ids = revision.privateEvaluator.deterministic
    .filter((item) => item.required)
    .map((item) => item.id)
    .sort();
  assert.deepEqual(schema.required, ids);
  assert.deepEqual(Object.keys(schema.properties).sort(), ids);
  assert.equal(schema.additionalProperties, false);
  for (const property of Object.values(schema.properties))
    assert.deepEqual(property.enum, ["verified", "rejected", "incomplete"]);
});

test("categorical-only controls retain source when a model invents deterministic keys", async () => {
  const compiled = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(compiled);
  const revision = structuredClone(compiled);
  revision.privateEvaluator.deterministic = [];
  const root = await mkdtemp(join(tmpdir(), "basalt-categorical-control-"));
  try {
    const snapshot: ModelSnapshot = {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      revision: "test-catalog-revision",
      capturedAt: "2026-09-23T00:00:00.000Z",
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
          tag: "test-provider",
          provider: "test",
          quantization: "unknown",
          contextLength: 100_000,
          maxPromptTokens: null,
          rawPricing: {},
          maxOutputTokens: 32768,
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
      hash: "f".repeat(64),
    };
    const ledger = new DurableSpendLedger(root, "categorical-control", "a".repeat(64));
    await ledger.initialize({ quoteHash: "b".repeat(64), ceilingUsd: 1 });
    const descriptor = openRouterModelClientDescriptor([snapshot.id]);
    const client: ModelClient = {
      descriptor,
      async complete(request) {
        const message = {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "control-source",
              name: "submit_control_source",
              arguments: {
                files: [{ path: "src/server/Main.server.luau", text: "-- reference\n" }],
                contrast: "Working reference",
                basis: "Source produces the visual requirement",
                expectedDeterministic: { "criterion-1": "verified" },
              },
            },
          ],
        };
        return {
          kind: "assistant",
          requestHash: modelTurnRequestHash(request, descriptor),
          message,
          responseHash: hashJson(message),
          stopReason: "tool_calls",
          responseFacts: {
            requestedModel: request.model,
            resolvedModel: request.model,
            servingProvider: "test",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "offline-categorical-control",
            latencyMs: 1,
            retryCount: 0,
            finishReason: "tool_calls",
            continuationHash: null,
            continuationBytes: null,
          },
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.0001,
          },
        };
      },
    };
    const proposer = new ModelControlProposer(client, ledger, snapshot, 42, "c".repeat(64));
    const source = await proposer.propose({
      revision,
      spec: { id: "working", kind: "working", targetCriterionId: null },
      attempt: 1,
      diagnostics: [],
      workingFiles: null,
      startingFiles: null,
    });
    assert.deepEqual(source.expectedDeterministic, {});
    assert.match(source.basis, /discarded non-deterministic keys/u);
    assert.equal(source.files[0]?.path, "src/server/Main.server.luau");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing semantic role closes a present name equality as rejected before Studio", () => {
  const compiled = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(compiled);
  const revision = structuredClone(compiled);
  const phase = revision.privateEvaluator.studio.phases[0];
  const role = revision.publicTask.roles[0];
  assert.ok(phase && role);
  phase.facts.push(
    { id: "control-role-exists", kind: "instance", path: `role.${role.id}` },
    { id: "control-role-name", kind: "instance_name", path: `role.${role.id}` },
  );
  revision.privateEvaluator.deterministic.push(
    {
      id: "control-exists",
      layer: "engine",
      statement: "The role exists.",
      required: true,
      rule: {
        kind: "fact_equals",
        phaseId: phase.id,
        factId: "control-role-exists",
        field: "exists",
        expected: true,
      },
    },
    {
      id: "control-name",
      layer: "engine",
      statement: "The role has a name.",
      required: true,
      rule: {
        kind: "fact_equals",
        phaseId: phase.id,
        factId: "control-role-name",
        field: "name",
        expected: "Beacon",
      },
    },
  );
  const closed = closeMissingRoleControlOutcomes(revision, {
    "control-exists": "rejected",
    "control-name": "rejected",
  });
  assert.equal(closed.outcomes["control-name"], "incomplete");
  assert.match(closed.derivations[0]!, /no object name was observed/u);
  assert.equal(
    closeMissingRoleControlOutcomes(revision, {
      "control-exists": "verified",
      "control-name": "incomplete",
    }).outcomes["control-name"],
    "incomplete",
  );
  const scenario = {
    id: "control-role-scenario",
    label: "Observe the role",
    durationMs: 1_000,
    reportContexts: ["server"],
    steps: [
      {
        id: "observe-role",
        at: { startMs: 0 },
        horizonMs: 1000,
        holdMs: 0,
        requirement: null,
        action: { kind: "wait" as const },
        observations: [
          {
            context: "server",
            fact: {
              id: "scenario-role-exists",
              kind: "instance" as const,
              path: `role.${role.id}`,
            },
          },
          {
            context: "server",
            fact: {
              id: "scenario-role-name",
              kind: "instance_name" as const,
              path: `role.${role.id}`,
            },
          },
        ],
      },
    ],
  };
  revision.privateEvaluator.studio.scenarios.push(scenario);
  revision.privateEvaluator.deterministic.at(-2)!.rule = {
    kind: "scenario_fact_equals",
    scenarioId: scenario.id,
    stepId: scenario.steps[0]!.id,
    context: "server",
    factId: "scenario-role-exists",
    field: "exists",
    expected: true,
  };
  revision.privateEvaluator.deterministic.at(-1)!.rule = {
    kind: "scenario_fact_equals",
    scenarioId: scenario.id,
    stepId: scenario.steps[0]!.id,
    context: "server",
    factId: "scenario-role-name",
    field: "name",
    expected: "Beacon",
  };
  assert.equal(
    closeMissingRoleControlOutcomes(revision, {
      "control-exists": "rejected",
      "control-name": "incomplete",
    }).outcomes["control-name"],
    "incomplete",
  );
});

test("independent control batches keep one eval revision and separate frozen identities", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const make = (batchId: string) =>
    prepareControlCases({
      revision,
      startingFiles: null,
      batchId,
      implementationCommit: "a".repeat(40),
      connectorArtifactHash: "b".repeat(64),
      propose: async ({ spec, attempt }) => ({
        ...spec,
        id: `${spec.id}-attempt-${attempt}`,
        contrast: "Fixed contrast",
        basis: "Fixed source",
        expectedDeterministic: Object.fromEntries(
          revision.privateEvaluator.deterministic
            .filter((item) => item.required)
            .map((item) => [
              item.id,
              spec.kind === "negative" && spec.targetCriterionId === item.id
                ? "rejected"
                : "verified",
            ]),
        ),
        files: [{ path: "src/server/Main.server.luau", text: `-- ${spec.id}\n` }],
      }),
      verify: async (source) => ({
        accepted: true,
        candidateHash: hashJson(source.files),
        diagnostics: [],
      }),
    });
  const first = await make("1".repeat(64));
  const second = await make("2".repeat(64));
  assert.ok(first.set && second.set);
  assert.equal(first.set.revisionId, second.set.revisionId);
  assert.deepEqual(first.set.cases, second.set.cases);
  assert.notEqual(first.set.id, second.set.id);
  assert.equal(first.set.batchId, "1".repeat(64));
  assert.equal(second.set.batchId, "2".repeat(64));
});

test("malformed paid control output is retained and corrected without a Studio attempt", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  let verified = 0;
  const result = await prepareControlCases({
    revision,
    startingFiles: null,
    batchId: "d".repeat(64),
    implementationCommit: "a".repeat(40),
    connectorArtifactHash: "b".repeat(64),
    propose: async ({ spec, attempt, diagnostics }) => {
      if (spec.kind === "working" && attempt === 1)
        throw new Error("Control generator returned invalid source fields");
      if (spec.kind === "working")
        assert.deepEqual(diagnostics, ["Control generator returned invalid source fields"]);
      return {
        ...spec,
        id: `${spec.id}-attempt-${attempt}`,
        contrast: "Expected behavior",
        basis: "Source and Studio evidence",
        expectedDeterministic: Object.fromEntries(
          revision.privateEvaluator.deterministic
            .filter((item) => item.required)
            .map((item) => [
              item.id,
              spec.kind === "negative" && spec.targetCriterionId === item.id
                ? "rejected"
                : "verified",
            ]),
        ),
        files: [{ path: "src/server/Main.server.luau", text: `-- ${spec.id}\n` }],
      };
    },
    verify: async (source) => {
      verified += 1;
      return { accepted: true, candidateHash: hashJson(source.files), diagnostics: [] };
    },
  });
  assert.equal(result.status, "ready_to_check");
  assert.equal(result.attempts[0]?.sourceHash, null);
  assert.equal(result.attempts[0]?.result.accepted, false);
  assert.equal(verified, result.attempts.length - 1);
});

test("control rate limits pause once and resume at a distinct saved attempt", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const retained = new Map<string, RetainedControlAttempt>();
  const calls: string[] = [];
  const input: Parameters<typeof prepareControlCases>[0] = {
    revision,
    startingFiles: null,
    batchId: "d".repeat(64),
    implementationCommit: "a".repeat(40),
    connectorArtifactHash: "b".repeat(64),
    readAttempt: async (id: string) => retained.get(id) ?? null,
    recordAttempt: async (attempt: RetainedControlAttempt) => {
      retained.set(attempt.id, attempt);
    },
    propose: async ({ spec, attempt }) => {
      calls.push(`${spec.id}:${attempt}`);
      if (attempt === 1) throw new Error(CONTROL_RATE_LIMIT);
      return {
        ...spec,
        id: `${spec.id}-attempt-${attempt}`,
        contrast: "Known contrast",
        basis: "Saved source",
        expectedDeterministic: Object.fromEntries(
          revision.privateEvaluator.deterministic
            .filter((item) => item.required)
            .map((item) => [item.id, "verified"]),
        ),
        files: [{ path: "src/server/Main.server.luau", text: "-- source\n" }],
      };
    },
    verify: async (source) => ({
      accepted: true,
      candidateHash: hashJson(source.files),
      diagnostics: [],
    }),
  };
  const first = await prepareControlCases(input);
  assert.equal(first.status, "incomplete");
  assert.deepEqual(calls, ["working:1"]);
  const second = await prepareControlCases(input);
  assert.equal(second.status, "incomplete");
  assert.deepEqual(calls, ["working:1", "working:2", "alternative:1"]);
  assert.equal(second.attempts[0]?.id, "working-attempt-1");
});

test("private control sources cannot leave neutral Luau roots or duplicate a file", () => {
  assert.throws(
    () =>
      assertControlSourceFiles([{ path: "src/server/../../evaluator.json", text: "return {}" }]),
    /unsafe/,
  );
  assert.throws(
    () =>
      assertControlSourceFiles([
        { path: "src/server/Main.server.luau", text: "-- one" },
        { path: "src/server/Main.server.luau", text: "-- two" },
      ]),
    /duplicate/,
  );
  assert.doesNotThrow(() =>
    assertControlSourceFiles([{ path: "src/server/Main.server.luau", text: "-- safe\n" }]),
  );
});

test("explained control expectations retain one canonical frozen outcome", () => {
  assert.deepEqual(
    normalizeControlExpectations({
      checkpoint: { outcome: "pass", reason: "The server owns this state." },
      feedback: "incomplete",
    }),
    { checkpoint: "verified", feedback: "incomplete" },
  );
  assert.deepEqual(
    normalizeControlExpectations(
      { checkpoint: "pass", blocked: "fail", capture: "present" },
      new Set(["capture"]),
    ),
    { checkpoint: "verified", blocked: "rejected", capture: "verified" },
  );
  assert.deepEqual(
    normalizeControlExpectations(
      { exists: true, name: "Beacon", players: 1 },
      new Set(),
      new Map<string, unknown>([
        ["exists", true],
        ["name", "Beacon"],
        ["players", 1],
      ]),
    ),
    { exists: "verified", name: "verified", players: "verified" },
  );
  assert.deepEqual(
    normalizeControlExpectations({
      exists: { expected: true, observed: false, outcome: "fail", reason: "Missing part" },
      name: { outcome: "abstain", reason: "No instance to name" },
      players: { expected: 1, outcome: "pass", reason: "Solo session" },
    }),
    { exists: "rejected", name: "incomplete", players: "verified" },
  );
  assert.throws(
    () => normalizeControlExpectations({ exists: false }, new Set(), new Map([["exists", true]])),
    /invalid contrast expectation/u,
  );
  assert.throws(
    () => normalizeControlExpectations({ checkpoint: "present" }, new Set(["capture"])),
    /invalid contrast expectation/u,
  );
  assert.throws(
    () => normalizeControlExpectations({ checkpoint: { outcome: "pass" } }),
    /invalid contrast expectation/u,
  );
  assert.throws(
    () => normalizeControlExpectations({ checkpoint: { outcome: "maybe", reason: "unclear" } }),
    /invalid contrast expectation/u,
  );
});

test("shared operation entry point runs and seals one frozen builder cell offline", async () => {
  const revision = compileEvalProposal(draft, 1, proposal).revision;
  assert.ok(revision);
  const root = await mkdtemp(join(tmpdir(), "basalt-eval-builder-entry-"));
  try {
    const implementation = await implementationFixture(root);
    const taskDirectory = `.basalt-evals/eval-revisions/${revision.id}`;
    const definitions = new EvalDefinitionStore(root);
    await createTextDraft(root, draft.input);
    await definitions.writeRevision(revision);
    await materializeEvalRevision({
      repositoryRoot: root,
      relativeDirectory: taskDirectory,
      revision,
      metadata: { schema: "basalt-evals/registered-eval", revisionId: revision.id },
    });
    const registered = await loadRegisteredTask(root, taskDirectory);
    const model: ModelSnapshot = {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      revision: "test-catalog-revision",
      capturedAt: "2026-09-23T00:00:00.000Z",
      inputModalities: ["text", "image"],
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
          tag: "openai",
          provider: "OpenAI",
          quantization: "unknown",
          contextLength: 100_000,
          maxPromptTokens: null,
          rawPricing: {},
          maxOutputTokens: 32768,
          supportedParameters: ["tools", "seed", "response_format"],
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
      hash: "f".repeat(64),
    };
    const descriptor = openRouterModelClientDescriptor([model.id], {
      [model.id]: modelRoute(model),
    });
    const treatmentBody: Omit<Treatment, "schema" | "id"> = {
      ordinal: 1,
      studyHash: "1".repeat(64),
      task: {
        id: registered.id,
        publicTaskHash: registered.publicTaskHash,
        evaluatorHash: registered.evaluatorHash,
        seedHash: registered.seedHash,
        collectionPlanHash: registered.collectionPlanHash,
      },
      model: {
        id: model.id,
        responseModelId: model.id,
        transport: "openrouter",
        revision: model.revision,
        pricing: {
          currency: "USD",
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 2,
          capturedAt: model.capturedAt,
        },
      },
      transportConfigurationHash: hashJson(descriptor),
      harness: testHarness({
        id: "thin",
        systemPrompt: "Build the public request.",
        maxTurns: 2,
      }),
      repetition: 1,
      randomSeed: 1,
      environment: {
        platform: "Roblox Studio",
        studioVersion: "test",
        captureProtocol: "studio-mcp-viewport",
        cameraProtocol: "fixed",
      },
    };
    const treatment: Treatment = {
      schema: "basalt-evals/treatment",
      id: `tr-${hashJson(treatmentBody).slice(0, 20)}`,
      ...treatmentBody,
    };
    const quote = createRunQuote(
      {
        independentBuilderTrials: 1,
        nativeCaptureRepetitions: 1,
        capturePasses: 1,
        nativeRootLaunches: 1,
        nativeClientLaunches: 0,
        startupRecoveryRootLaunches: 3,
        startupRecoveryClientLaunches: 0,
        criterionOutcomes:
          revision.privateEvaluator.deterministic.filter((item) => item.required).length +
          revision.privateEvaluator.codeQuality.filter((item) => item.required).length +
          revision.privateEvaluator.visual.filter((item) => item.required).length,
        judgmentBatches: 1,
        modelWork: [
          {
            stage: "grading",
            modelId: model.id,
            calls: 1,
            expected: null,
            upper: { inputTokens: 67_232, outputTokens: 32768, images: 0, imageInputTokens: 0 },
          },
          {
            stage: "builder",
            modelId: model.id,
            calls: 1,
            expected: { inputTokens: 1000, outputTokens: 50, images: 0, imageInputTokens: 0 },
            upper: { inputTokens: 10_000, outputTokens: 100, images: 0, imageInputTokens: 0 },
          },
        ],
      },
      [model],
      revision.id,
    );
    const savedSelection = {
      revisionId: revision.id,
      validationRecordHash: hashJson(
        checkedValidationRecord(revision, implementation.implementationCommit),
      ),
      builderModelIds: [model.id],
      gradingModelId: model.id,
      harnessIds: ["thin" as const],
      repetitions: 1,
      nativeCaptureRepetitions: 1,
    };
    const savedQuoteBody = {
      schema: "basalt-evals/saved-run-quote" as const,
      kind: "eval" as const,
      selection: savedSelection,
      quote,
    };
    const savedQuoteId = hashJson(savedQuoteBody);
    await new RepositoryFiles(root).writeJson(
      `.basalt-evals/eval-run-quotes/${savedQuoteId}.json`,
      { ...savedQuoteBody, id: savedQuoteId },
    );
    const manifest = freezeRunOperation({
      inputHash: revision.draftId,
      stage: {
        firstRevisionId: revision.id,
        index: 1,
        count: 1,
        earlierPrompts: [],
        gateCriterionIds: [],
      },
      judgmentBatches: [
        {
          id: "judgment-1",
          captureCellId: "capture-1",
          revisionId: revision.id,
          sampleGroupId: "judgment-1",
          sample: 1,
          grouping: "shared" as const,
          criterionIds: [
            ...revision.privateEvaluator.codeQuality,
            ...revision.privateEvaluator.visual,
          ].map((c) => c.id),
          configuration: scoringConfiguration(revision, model),
          presentation: scoringPresentation(revision),
          substitution: null,
        },
      ],
      retainedSources: [],
      publicFeedbackId: null,
      views: [
        {
          id: "default",
          partition: "withheld",
          plan: revision.privateEvaluator.studio,
          sequence: null,
        },
      ],
      parentSourceId: null,
      gradingMode: "all",
      operationId: "builder-entry-test",
      buildIdentityHash: implementation.buildIdentityHash,
      revision,
      validationRecord: checkedValidationRecord(revision, implementation.implementationCommit),
      quote,
      quoteSelectionId: savedQuoteId,
      implementationCommit: implementation.implementationCommit,
      connectorArtifactHash: "c".repeat(64),
      selectedModelIds: [model.id],
      selectedHarnessIds: ["thin"],
      modelConcurrency: { [model.id]: 4 },
      treatments: [treatment],
      captureCells: [
        {
          id: "capture-1",
          treatmentId: treatment.id,
          viewId: "default",
          pass: 1,
          partition: "withheld",
        },
      ],
      gradingCells: [
        ...revision.privateEvaluator.deterministic
          .filter((item) => item.required)
          .map((item) => ({ id: item.id, method: "deterministic" as const })),
      ].map((criterion) => ({
        id: `grade-1-${criterion.id}`,
        captureCellId: "capture-1",
        criterionId: criterion.id,
        method: criterion.method,
      })),
      ceilingUsd: 1,
    });
    await saveCheckedValidationRecord(root, revision, implementation.implementationCommit);
    await projectRegisteredEvaluation(root, revision.id, savedSelection.validationRecordHash, true);
    const catalog = await evaluationCatalog(root);
    assert.equal(
      catalog.items.find((item) => item.id === revision.id)?.validationRecordHash,
      savedSelection.validationRecordHash,
    );
    const operation = new RunOperationStore(root, manifest.id, hashJson(manifest), draft.id);
    await operation.create(manifest);
    let calls = 0;
    const client: ModelClient = {
      descriptor,
      async complete(request) {
        calls += 1;
        const message = {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "finish-one",
              name: "workspace.finish",
              arguments: { summary: "Completed the public task." },
            },
          ],
        };
        return {
          kind: "assistant",
          requestHash: modelTurnRequestHash(request, descriptor),
          message,
          responseHash: hashJson(message),
          stopReason: "tool_calls",
          responseFacts: {
            requestedModel: model.id,
            resolvedModel: model.id,
            servingProvider: "OpenAI",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "offline-builder-one",
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
            costUsd: 0.0001,
          },
        };
      },
    };
    const run = await executeFrozenBuilderCell({
      root,
      operationId: manifest.id,
      unitId: treatment.id,
      modelClient: client,
      snapshot: {
        ...model,
        capturedAt: "2026-09-24T00:00:00.000Z",
        hash: "e".repeat(64),
      },
    });
    assert.equal(run.treatmentId, treatment.id);
    assert.equal(calls, 1);
    assert.equal((await operation.read()).completedUnits[0], `builder:${treatment.id}`);
    assert.equal(
      hashJson(
        await inventoryTree(
          resolve(
            root,
            `.basalt-evals/eval-operations/${manifest.id}/builder/${treatment.id}/candidate`,
          ),
        ),
      ),
      run.candidate.rootHash,
    );
    assert.equal(
      (await sealedEvalCandidate(root, manifest.id, treatment.id)).candidate.rootHash,
      run.candidate.rootHash,
    );
    await assert.rejects(
      quoteSavedReplay({
        root,
        operationId: "../escape",
        subjectId: treatment.id,
        passes: 3,
      }),
      /Invalid run operation/u,
    );
    const replay = await executeFrozenBuilderCell({
      root,
      operationId: manifest.id,
      unitId: treatment.id,
      modelClient: client,
      snapshot: model,
    });
    assert.equal(replay.id, run.id);
    assert.equal(calls, 1);
    await assert.rejects(
      executeFrozenBuilderCell({
        root,
        operationId: manifest.id,
        unitId: treatment.id,
        modelClient: client,
        snapshot: {
          ...model,
          endpoints: [{ ...model.endpoints[0]!, quantization: "fp8" }],
        },
      }),
      /endpoint and prices/u,
    );
    const captureStart = {
      kind: "started" as const,
      stage: "final_capture" as const,
      unitId: "capture-1",
      artifactHashes: [],
      reason: null,
      at: "2026-09-23T00:00:00.000Z",
    };
    await assert.rejects(
      operation.append({ ...captureStart, unitId: "unplanned-capture" }),
      /not a frozen acquisition cell/,
    );
    await operation.append(captureStart);
    await assert.rejects(
      operation.append({
        ...captureStart,
        kind: "completed",
        artifactHashes: ["a".repeat(64), "b".repeat(64)],
      }),
      /ENOENT/,
    );
    // Test-only signed acquisition: this exercises binding and grading without launching Studio.
    const studioRelative = `.basalt-evals/eval-operations/${manifest.id}/capture/capture-1/studio`;
    const studio = resolve(root, studioRelative);
    await new RepositoryFiles(root).directory(
      `.basalt-evals/eval-operations/${manifest.id}/capture/capture-1`,
    );
    const session = await prepareStudioSession({
      workspaceRoot: resolve(
        root,
        `.basalt-evals/eval-operations/${manifest.id}/builder/${treatment.id}/candidate`,
      ),
      outputDirectory: studio,
      task: registered,
      treatment,
      candidate: run.candidate,
      connectorSourceHash: "d".repeat(64),
      connectorArtifactHash: manifest.connectorArtifactHash,
    });
    const files = new RepositoryFiles(root);
    const image = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const phases = [];
    for (const phase of session.plan.phases) {
      const captures = [];
      for (const capture of phase.captures) {
        const file = `capture-${capture.id}.png`;
        await files.write(`${studioRelative}/${file}`, image);
        captures.push({
          captureId: capture.id,
          file,
          hash: contentHash(image),
          bytes: image.length,
          mediaType: "image/png" as const,
          width: 2,
          height: 2,
          sceneText: { complete: true, entries: [] },
        });
      }
      phases.push({
        phaseId: phase.id,
        observations: phase.facts.map((fact) => syntheticObservation(fact, null)),
        captures,
      });
    }
    const evidenceBody = {
      treatmentId: treatment.id,
      candidateHash: run.candidate.rootHash,
      collectionPlanHash: session.collectionPlanHash,
      connectorSourceHash: session.connectorSourceHash,
      connectorArtifactHash: session.connectorArtifactHash,
      place: session.place,
      studio: { version: treatment.environment.studioVersion, sessionId: session.id },
      startedAt: "2026-09-23T00:00:00.000Z",
      endedAt: "2026-09-23T00:00:01.000Z",
      scenarios: [],
      phases,
    };
    const evidence = {
      schema: "basalt-evals/studio-evidence" as const,
      id: `evidence-${hashJson(evidenceBody).slice(0, 20)}`,
      ...evidenceBody,
    };
    await files.writeJson(`${studioRelative}/evidence.json`, evidence);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    await files.write(".basalt-evals/native-worker/isolated-public-key.pem", key);
    const artifactFiles = [
      "evidence.json",
      ...phases.flatMap((phase) => phase.captures.map((capture) => capture.file)),
    ];
    const receipt: SignedWorkerManifest = {
      publicKey: key,
      signature: "",
      manifest: {
        schema: "basalt-evals/native-worker",
        jobId: "a".repeat(32),
        sessionId: session.id,
        candidateHash: run.candidate.rootHash,
        collectionPlanHash: session.collectionPlanHash,
        runnerHash: "f".repeat(64),
        startedAt: evidence.startedAt,
        completedAt: evidence.endedAt,
        status: "complete",
        failure: null,
        failureRecord: null,
        processes: [],
        completion: { trialId: "offline-test-only", submissionHash: "e".repeat(64) },
        artifacts: await Promise.all(
          artifactFiles.map(async (file) => {
            const bytes = await readFile(resolve(studio, file));
            return { file, hash: contentHash(bytes), bytes: bytes.length };
          }),
        ),
        preferences: null,
        screenRecording: { status: "off", failure: null, bytes: null, hash: null },
      },
    };
    receipt.signature = sign(null, Buffer.from(stableJson(receipt.manifest)), privateKey).toString(
      "base64",
    );
    await files.writeJson(`${studioRelative}/native/manifest.json`, receipt);
    await operation.append({
      ...captureStart,
      kind: "completed",
      artifactHashes: [
        contentHash(await readFile(resolve(studio, "native/manifest.json"))),
        hashJson(evidence),
      ],
    });
    const gradeCell = manifest.gradingCells.find((item) => item.criterionId === "server-source")!;
    const grade = await executeFrozenDeterministicGradingCell({
      root,
      operationId: manifest.id,
      cellId: gradeCell.id,
    });
    assert.equal(grade.criterion.outcome, "verified");
    assert.equal((await operation.read()).criterionOutcomes.length, 1);
    const batch = manifest.judgmentBatches[0]!;
    const criteria = scoringCriteria(revision, batch.criterionIds);
    let graderCalls = 0;
    const grader: ModelClient = {
      descriptor,
      async complete(request) {
        graderCalls += 1;
        const visualInput = request.messages[0];
        assert.equal(visualInput?.role, "user");
        if (visualInput?.role !== "user") throw new Error("Visual grader needs user evidence");
        assert.ok(visualInput.images?.length);
        assert.match(String(request.messages[0]?.content), /authoredPassages/u);
        const message = {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "criterion-one",
              name: "submit_judgment_batch",
              arguments: {
                addressedToEvaluator: { found: false, quote: null },
                decisions: criteria.map((c) => ({
                  criterionId: c.id,
                  verdict: "violated",
                  score: c.anchors?.[0]?.score ?? null,
                  confidence: 0.6,
                  rationale: "Synthetic judgment on bound evidence.",
                })),
              },
            },
          ],
        };
        return {
          kind: "assistant",
          requestHash: modelTurnRequestHash(request, descriptor),
          message,
          responseHash: hashJson(message),
          stopReason: "tool_calls",
          responseFacts: {
            requestedModel: model.id,
            resolvedModel: model.id,
            servingProvider: "OpenAI",
            requestedServiceTier: null,
            servingServiceTier: null,
            responseId: "offline-grader-one",
            latencyMs: 1,
            retryCount: 0,
            finishReason: "tool_calls",
            continuationHash: null,
            continuationBytes: null,
          },
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.0002,
          },
        };
      },
    };
    const adapters = {
      ...fixtureAdapters(root),
      catalog: async () => [model],
      model: () => grader,
    };
    const judged = await executeFrozenJudgmentBatch({
      root,
      operationId: manifest.id,
      batchId: batch.id,
      adapters,
    });
    assert.deepEqual(
      await executeFrozenJudgmentBatch({
        root,
        operationId: manifest.id,
        batchId: batch.id,
        adapters,
      }),
      judged,
    );
    assert.equal(graderCalls, 1);
    // A batch of criteria without rendered evidence gets no images.
    const imageless = {
      ...batch,
      id: `judgment-no-images-${batch.captureCellId}`,
      criterionIds: judgmentGroups(qualitativeCriteria(revision), "shared")
        .filter((group) => !group.images)
        .flatMap((group) => group.criteria.map((item) => item.id)),
    };
    assert.ok(imageless.criterionIds.length);
    assert.equal((await judgmentMaterial(root, manifest, imageless)).images.length, 0);
    await operation.append({
      kind: "started",
      stage: "report",
      unitId: "final",
      artifactHashes: [],
      reason: null,
      at: "2026-09-23T00:00:02.000Z",
    });
    const report = await operation.completeReport();
    assert.equal(report.outcome, "partial");
    assert.equal(report.criterionOutcomes[0]?.outcome, "verified");
    assert.equal(report.units.grading.unattempted, 2);
    assert.equal(
      (await operation.read()).events.at(-1)?.reason,
      "Some planned work did not complete.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private-only edits reuse the frozen public preparation and retain a distinct private definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-public-preparation-"));
  try {
    const context = {
      stagePrompts: [draft.stages[0]!.prompt],
      title: draft.title,
      slug: draft.slug,
      buildIdentityHash: hashJson("implementation"),
      preparationIdentityHash: hashJson("planner"),
    };
    const frozenStage: PublicProposal = {
      publicTask: structuredClone(proposal.publicTask),
      publicDevelopment: structuredClone(proposal.publicDevelopment),
      publicScene: { parts: [] },
    };
    const frozen = publicPreparation(frozenStage);
    await savePublicPreparation(root, context, frozen, "model");
    const cached = await readPublicPreparation(root, context);
    assert.deepEqual(cached, frozen);
    const changed = createEvalDraft({
      ...draft.input,
      stages: [{ ...draft.input.stages[0]!, rubric: draft.stages[0]!.rubric + "\n" }],
    });
    const prepared = await prepareEvalDraft(
      changed,
      {
        preparePublic: async () => {
          throw new Error("Private edit must not regenerate public material");
        },
        ...stagedPrivateRoles(({ publicProposal }) => {
          assert.deepEqual(publicProposal, frozenStage);
          return {
            privateEvaluator: structuredClone(proposal.privateEvaluator),
            criterionMappings: structuredClone(proposal.criterionMappings),
            requiredCapabilities: [...proposal.requiredCapabilities],
          };
        }),
      },
      undefined,
      {
        proposal: cached,
        accepted: async () => {
          throw new Error("Cached proposal was regenerated");
        },
      },
    );
    assert.ok(prepared.revisions[0]);
    assert.notEqual(prepared.revisions[0].draftId, draft.id);
    assert.equal(
      await readPublicPreparation(root, { ...context, stagePrompts: ["Different public request"] }),
      null,
    );
    const altered = structuredClone(frozen);
    altered.stages[0]!.publicTask.acceptance.push("new public requirement");
    await assert.rejects(savePublicPreparation(root, context, altered, "model"), /already frozen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
