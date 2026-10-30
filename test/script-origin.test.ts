import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  assertEvaluatorSpec,
  assertStudioEvidence,
  hashJson,
  type CandidateManifest,
  type DeterministicCriterion,
  type EvaluatorSpec,
  type ScriptDiagnostic,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import {
  SOURCE_ANALYSIS_SCHEMA,
  type SourceAnalysis,
  type SourceScript,
} from "../packages/contracts/src/source-analysis.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import { attributeScriptError, stackFramePaths } from "../packages/graders/src/script-origin.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";

const repository = resolve(process.cwd());

const scripts: SourceScript[] = [
  {
    file: "src/shared/Util.luau",
    className: "ModuleScript",
    dataModelPath: "ReplicatedStorage.Shared.Util",
  },
  {
    file: "src/server/Mechanic.server.luau",
    className: "Script",
    dataModelPath: "ServerScriptService.Mechanic",
  },
  {
    file: "src/tools/Handler.server.luau",
    className: "Script",
    dataModelPath: "StarterPack.Sword.Handler",
  },
  {
    file: "src/gui/Button.client.luau",
    className: "LocalScript",
    dataModelPath: "StarterGui.Menu.Button",
  },
  {
    file: "src/character/Sprint.client.luau",
    className: "LocalScript",
    dataModelPath: "StarterPlayer.StarterCharacterScripts.Sprint",
  },
  {
    file: "src/client/Hud.client.luau",
    className: "LocalScript",
    dataModelPath: "StarterPlayer.StarterPlayerScripts.Hud",
  },
];
const actors = ["Player1", "Player2"];

function scriptError(
  path: string,
  inDataModel = true,
  stackTrace = `${path}:3`,
  className = "Script",
): ScriptDiagnostic {
  return {
    message: `${path}:3: attempt to index nil with 'Parent'`,
    stackTrace,
    source: { kind: "script", path, className, inDataModel },
  };
}

function unattributed(stackTrace: string): ScriptDiagnostic {
  return { message: "attempt to call a nil value", stackTrace, source: { kind: "unavailable" } };
}

test("each Studio copy of a build script maps back to its sealed source", () => {
  const origin = (entry: ScriptDiagnostic) => attributeScriptError(entry, scripts, actors);
  for (const path of [
    "ServerScriptService.Mechanic",
    "ReplicatedStorage.Shared.Util",
    // StarterPlayerScripts runs in the PlayerScripts of each player.
    "Players.Player2.PlayerScripts.Hud",
    // StarterGui runs in the PlayerGui of each player.
    "Players.Player1.PlayerGui.Menu.Button",
    // StarterCharacterScripts runs in the character of each player.
    "Workspace.Player1.Sprint",
    // A StarterPack tool runs in the Backpack, and in the character when the player equips it.
    "Players.Player2.Backpack.Sword.Handler",
    "Workspace.Player2.Sword.Handler",
    // A ModuleScript can run where the build put it.
    "StarterPlayer.StarterPlayerScripts.Hud",
  ])
    assert.equal(origin(scriptError(path)), "build", path);
  // A player that is not an actor of the evidence is not a known copy.
  assert.equal(origin(scriptError("Players.Stranger.PlayerScripts.Hud")), "unknown");
  // A script in the place that the sourcemap does not name, for example a runtime clone.
  assert.equal(origin(scriptError("Workspace.Player1.ClonedHelper")), "unknown");
});

test("stack frames attribute an error in both Studio formats", () => {
  assert.deepEqual(
    stackFramePaths(
      [
        "ReplicatedStorage.Shared.Util:12 function helper",
        "ServerScriptService.Mechanic:40",
        "Script 'Players.Player1.PlayerScripts.Hud', Line 7 - function update",
        "Stack End",
        "",
      ].join("\n"),
    ),
    [
      "ReplicatedStorage.Shared.Util",
      "ServerScriptService.Mechanic",
      "Players.Player1.PlayerScripts.Hud",
    ],
  );
  const origin = (entry: ScriptDiagnostic) => attributeScriptError(entry, scripts, actors);
  assert.equal(origin(unattributed("ServerScriptService.Mechanic:3 function onTouched")), "build");
  assert.equal(
    origin(unattributed("Script 'Players.Player1.PlayerScripts.Hud', Line 7 - function update")),
    "build",
  );
  assert.equal(origin(unattributed("Workspace.Door.Script:3")), "unknown");
  assert.equal(origin(unattributed("")), "unknown");
  // A plugin error is external, unless a build frame is on its stack.
  assert.equal(
    origin(
      scriptError(
        "cloud_example.Plugin.Settings",
        false,
        "Plugin.Settings:142\nPlugin:66",
        "ModuleScript",
      ),
    ),
    "external",
  );
  assert.equal(
    origin(
      scriptError(
        "cloud_example.Plugin.Settings",
        false,
        "cloud_example.Plugin.Settings:142\nReplicatedStorage.Shared.Util:12 function helper",
      ),
    ),
    "build",
  );
  // An unparented build script keeps only the end of its full name, so its origin is unknown.
  assert.equal(origin(scriptError("Mechanic", false, "Mechanic:3")), "unknown");
  assert.equal(origin(scriptError("Shared.Util", false, "Shared.Util:3")), "unknown");
});

function analysisFor(candidateHash: string, patch: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    schema: SOURCE_ANALYSIS_SCHEMA,
    candidateHash,
    toolchain: {
      luauLsp: "1.63.0",
      rojo: "7.7.0",
      definitionsSha256: "a".repeat(64),
      flags: ["--no-strict-dm-types"],
      luaurc: '{"languageMode":"nonstrict","lint":{"*":true}}',
    },
    status: "complete",
    reason: null,
    scripts,
    findings: [],
    counts: {},
    suppressions: [],
    ...patch,
  };
}

const buildErrorRule = (facts: object[]) =>
  ({ kind: "build_errors_absent", facts }) as unknown as DeterministicCriterion["rule"];

async function movingPlatform(root: string) {
  const task = await loadRegisteredTask(repository, "tasks/pilot/moving-platform");
  const workspace = resolve(root, "workspace");
  await materializeTaskSeed(repository, task, workspace);
  const files = await inventoryTree(workspace);
  const candidate: CandidateManifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  const evaluator: EvaluatorSpec = structuredClone(task.evaluator);
  evaluator.deterministic.push({
    id: "no-build-errors",
    layer: "engine",
    statement: "The Play session emits no runtime errors from the mechanic.",
    required: true,
    rule: buildErrorRule([{ phaseId: "motion", factId: "errors" }]),
  });
  assertEvaluatorSpec(evaluator);
  return { workspace, candidate, evaluator };
}

function evidenceWith(
  candidate: CandidateManifest,
  evaluator: EvaluatorSpec,
  scriptErrors: ScriptDiagnostic[] | null,
): StudioEvidence {
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: "tr-build-errors",
    candidateHash: candidate.rootHash,
    collectionPlanHash: hashJson(evaluator.studio),
    connectorSourceHash: "a".repeat(64),
    connectorArtifactHash: "d".repeat(64),
    place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
    studio: { version: "test", sessionId: "studio-fixture" },
    startedAt: "2026-10-07T00:00:02.000Z",
    endedAt: "2026-10-07T00:00:03.000Z",
    // The actor names of the evidence come from its scenario reports.
    scenarios: [
      {
        scenarioId: "window",
        startedAt: "2026-10-07T00:00:02.000Z",
        endedAt: "2026-10-07T00:00:03.000Z",
        reports: [
          {
            context: "server",
            startAt: 1,
            actors: [{ actor: "primary", userId: 101, name: "Player1" }],
            steps: [
              {
                stepId: "observe",
                outcome: "not_observed_within_horizon",
                dueAt: 1,
                observations: [],
              },
            ],
          },
        ],
      },
    ],
    phases: [
      {
        phaseId: "motion",
        observations: [
          { factId: "platform", kind: "instance", exists: true, className: "Part" },
          ...(scriptErrors === null
            ? []
            : [{ factId: "errors", kind: "diagnostics" as const, messages: [], scriptErrors }]),
        ],
        captures: [],
      },
    ],
  };
  const evidence: StudioEvidence = {
    schema: "basalt-evals/studio-evidence",
    id: `evidence-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
  assertStudioEvidence(evidence);
  return evidence;
}

test("a build error check rejects only an error that it attributes to the build", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-build-errors-"));
  try {
    const { workspace, candidate, evaluator } = await movingPlatform(root);
    const analysis = analysisFor(candidate.rootHash);
    const grade = async (
      scriptErrors: ScriptDiagnostic[] | null,
      source: SourceAnalysis | null = analysis,
    ) =>
      (
        await evaluateDeterministicCriteria({
          workspaceRoot: workspace,
          evaluator,
          candidate,
          treatmentId: "tr-build-errors",
          evidence: evidenceWith(candidate, evaluator, scriptErrors),
          analysis: source ?? undefined,
        })
      ).find((item) => item.criterionId === "no-build-errors")!;
    const plugin = scriptError("cloud_example.Plugin.Settings", false, "Plugin.Settings:142");
    const clean = await grade([]);
    assert.equal(clean.outcome, "verified");
    assert.deepEqual(clean.observed, [0, 0, 0]);
    const external = await grade([plugin]);
    assert.equal(external.outcome, "verified");
    assert.deepEqual(external.observed, [0, 0, 1]);
    const rejected = await grade([plugin, scriptError("Players.Player1.PlayerScripts.Hud")]);
    assert.equal(rejected.outcome, "rejected");
    assert.deepEqual(rejected.observed, [1, 0, 1]);
    assert.match(rejected.explanation, /Players\.Player1\.PlayerScripts\.Hud/u);
    assert.equal(rejected.evidence[0], hashJson(analysis));
    assert.equal(rejected.evidence.length, 2);
    // Player2 is not an actor of this evidence, so its copy has an unknown origin.
    const unknown = await grade([scriptError("Players.Player2.PlayerScripts.Hud")]);
    assert.equal(unknown.outcome, "incomplete");
    assert.deepEqual(unknown.observed, [0, 1, 0]);
    // A full channel may hide a later build error.
    const full = await grade(Array(100).fill(plugin));
    assert.equal(full.outcome, "incomplete");
    assert.match(full.explanation, /limit of 100/u);
    const fullWithBuild = await grade([
      ...Array(99).fill(plugin),
      scriptError("ServerScriptService.Mechanic"),
    ]);
    assert.equal(fullWithBuild.outcome, "rejected");
    const missing = await grade(null);
    assert.equal(missing.outcome, "incomplete");
    assert.match(missing.explanation, /absent/u);
    const withoutAnalysis = await grade([plugin], null);
    assert.equal(withoutAnalysis.outcome, "incomplete");
    assert.match(withoutAnalysis.explanation, /No source analysis exists/u);
    const unavailable = await grade(
      [plugin],
      analysisFor(candidate.rootHash, {
        status: "unavailable",
        reason: "Rojo failed",
        scripts: [],
      }),
    );
    assert.equal(unavailable.outcome, "incomplete");
    assert.match(unavailable.explanation, /Rojo failed/u);
    const withoutEvidence = (
      await evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator,
        candidate,
        treatmentId: "tr-build-errors",
        analysis,
      })
    ).find((item) => item.criterionId === "no-build-errors")!;
    assert.equal(withoutEvidence.outcome, "incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build error rule binds only distinct diagnostics facts at the engine layer", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-build-error-contract-"));
  try {
    const { evaluator } = await movingPlatform(root);
    const variant = (patch: Partial<DeterministicCriterion>) => {
      const copy = structuredClone(evaluator);
      Object.assign(
        copy.deterministic.find((item) => item.id === "no-build-errors")!,
        patch,
      );
      return copy;
    };
    assert.throws(() => assertEvaluatorSpec(variant({ layer: "static" })), /evidence authority/u);
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({ rule: buildErrorRule([{ phaseId: "motion", factId: "travel" }]) }),
        ),
      /only diagnostics facts/u,
    );
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({ rule: buildErrorRule([{ phaseId: "motion", factId: "absent" }]) }),
        ),
      /only diagnostics facts/u,
    );
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({
            rule: buildErrorRule([
              { phaseId: "motion", factId: "errors" },
              { phaseId: "motion", factId: "errors" },
            ]),
          }),
        ),
      /repeats a fact/u,
    );
    assert.throws(() => assertEvaluatorSpec(variant({ rule: buildErrorRule([]) })), /1 to 16/u);
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({
            rule: buildErrorRule([{ phaseId: "motion", factId: "errors", context: "server" }]),
          }),
        ),
      /binding/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
