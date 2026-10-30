import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import {
  assertStudioObservation,
  hashJson,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import { DIAGNOSTIC_SEMANTICS } from "../packages/contracts/src/capabilities.js";
import { criterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import { batchJudgmentRequest } from "../packages/eval-authoring/src/batch-judgment.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";
import { capabilityFixture } from "./shared-api-fixture.js";

function observation() {
  return {
    factId: "errors",
    kind: "diagnostics" as const,
    messages: ["loadstring() is not available"],
    scriptErrors: [
      {
        message: "loadstring() is not available",
        stackTrace: "Plugin.Settings:142\nPlugin:66",
        source: {
          kind: "script" as const,
          path: "cloud_example.Plugin.Settings",
          className: "ModuleScript",
          inDataModel: false,
        },
      },
      {
        message: "loadstring() is not available",
        stackTrace: "ServerScriptService.Mechanic:12",
        source: {
          kind: "script" as const,
          path: "ServerScriptService.Mechanic",
          className: "Script",
          inDataModel: true,
        },
      },
      {
        message: "Unknown origin",
        stackTrace: "Retained stack",
        source: { kind: "unavailable" as const },
      },
    ],
  };
}

test("diagnostics require bounded engine origin without inferred ownership or message matching", () => {
  const value = observation();
  assertStudioObservation(value);
  assert.equal(value.scriptErrors.length, 3);
  const { scriptErrors: _omitted, ...oldShape } = value;
  assert.throws(() => assertStudioObservation(oldShape), /diagnostic/);
  for (const source of [
    { kind: "script", path: "Plugin", className: "Script", inDataModel: "false" },
    { kind: "script", path: "", className: "Script", inDataModel: false },
    {
      kind: "script",
      path: "Plugin",
      className: "Script",
      inDataModel: false,
      candidateOwned: false,
    },
    { kind: "unavailable", path: "guessed" },
    { kind: "candidate" },
  ])
    assert.throws(
      () =>
        assertStudioObservation({ ...value, scriptErrors: [{ ...value.scriptErrors[0], source }] }),
      /script/,
    );
  assert.throws(
    () =>
      assertStudioObservation({ ...value, scriptErrors: Array(101).fill(value.scriptErrors[0]) }),
    /bounds/,
  );
  assert.throws(
    () =>
      assertStudioObservation({
        ...value,
        scriptErrors: [{ ...value.scriptErrors[0], stackTrace: "x".repeat(16385) }],
      }),
    /content/,
  );
});

test("signed diagnostic origin reaches direct and batch graders without changing authored meaning", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-diagnostic-material-"));
  try {
    const evaluator = capabilityFixture("static").privateProposal.privateEvaluator;
    const criterion = structuredClone(evaluator.unscaled[0]!);
    criterion.statement = "The Play session emits no runtime errors from the mechanic.";
    // The author set no class for this runtime-fact judgment, so it uses no rendered frames.
    criterion.evidenceClass = null;
    criterion.evidence = {
      sourceSelection: null,
      captureIds: [],
      sequence: false,
      facts: [{ phaseId: "scene", factId: "errors" }],
      actions: [],
    };
    evaluator.studio.phases[0]!.facts.push({ id: "errors", kind: "diagnostics" });
    const diagnostic = observation();
    const evidence = {
      phases: [{ phaseId: "scene", observations: [diagnostic], captures: [] }],
      scenarios: [],
    } as unknown as StudioEvidence;
    const material = await criterionMaterial({
      files: new RepositoryFiles(root),
      sourceRoot: "source",
      sourceFiles: [],
      evidence,
      plan: evaluator.studio,
      criterion,
    });
    assert.deepEqual(material.signedObservations[0]!.observation, diagnostic);
    assert.equal(material.signedObservations[0]!.hash, hashJson(diagnostic));
    assert.deepEqual(material.unavailable, []);
    const batch = batchJudgmentRequest({
      configuration: {
        modelId: "test",
        seed: 0,
        maxOutputTokens: 8192,
        sampling: catalogRecommendedSampling(null),
      },
      criteria: [
        {
          id: criterion.id,
          statement: criterion.statement,
          authoredPassages: [criterion.statement],
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          comparisons: [],
          anchors: null,
          scoreRange: null,
          minimumPassingScore: null,
        },
      ],
      publicTask: "Build a moving platform.",
      context: { actors: [], intervals: [] },
      images: [],
      observation: null,
      criterionEvidence: [material],
    });
    for (const request of [batch]) {
      assert.ok(request.system.includes(DIAGNOSTIC_SEMANTICS));
      assert.match(request.system, /candidate script that was unparented/);
      assert.match(request.system, /Neither membership value alone proves or rules out/);
      const content = JSON.parse(request.messages[0]!.content).buildOutput;
      assert.deepEqual(content.criterionEvidence[0].observations, ["O1"]);
      assert.deepEqual(content.signedObservations[0].observation, diagnostic);
      assert.ok(request.messages[0]!.content.includes(criterion.statement));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
