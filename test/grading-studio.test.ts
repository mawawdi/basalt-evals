import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  assertStudioEvidence,
  assertStudioObservation,
  contentHash,
  hashJson,
  type AgentRun,
  type CriterionResult,
  type DeterministicCriterion,
  type DeterministicRule,
  type EvaluatorSpec,
  type JsonPrimitive,
  type StudioEvidence,
  type StudioObservation,
  type StudioScenario,
  type StudioScenarioReport,
  type StudioScenarioStepReport,
} from "../packages/contracts/src/index.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import {
  freezeStudy,
  hashDirectoryTree,
  loadRegisteredTask,
  materializeTaskSeed,
} from "../packages/task-registry/src/index.js";
import {
  finalizeStudioEvidence,
  prepareStudioSession,
  serveStudioSession,
} from "../packages/studio-runner/src/index.js";
import { decodeCaptureImage } from "../packages/studio-runner/src/images.js";
import { readLatestStudioTrace } from "./studio-trace-reader.js";
import type { SequencePlan } from "../packages/studio-runner/src/sequence.js";

const root = resolve(process.cwd());

test("motion evidence requires measured chronology and a sample-supported distance", () => {
  const observation = {
    factId: "travel",
    kind: "part_motion",
    delta: 5,
    samples: [
      { elapsedMs: 0, x: 0, y: 0, z: 0 },
      { elapsedMs: 217, x: 3, y: 4, z: 0 },
      { elapsedMs: 451, x: 1, y: 0, z: 0 },
    ],
  };
  assertStudioObservation(observation);
  assertStudioObservation({ ...observation, samples: [], delta: 0 });
  assert.throws(() => assertStudioObservation({ ...observation, samples: [] }), /motion delta/);
  assert.throws(() => assertStudioObservation({ ...observation, delta: 20 }), /motion delta/);
  for (const times of [
    [1, 217, 451],
    [0, 217, 217],
    [0, 217, 100],
  ])
    assert.throws(
      () =>
        assertStudioObservation({
          ...observation,
          samples: observation.samples.map((sample, i) => ({ ...sample, elapsedMs: times[i] })),
        }),
      /motion sample/,
    );
});

test("session-wide diagnostics check both channels without attributing their cause", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-diagnostic-grade-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-diagnostics");
    for (const channel of ["clean", "output", "script"] as const) {
      const evidence = evidenceFor(agent, hashJson(task.evaluator.studio));
      const diagnostics = evidence.phases[0]!.observations.find(
        (item) => item.kind === "diagnostics",
      );
      assert.ok(diagnostics && diagnostics.kind === "diagnostics");
      if (channel === "output") diagnostics.messages.push("Unattributed output error");
      if (channel === "script")
        diagnostics.scriptErrors.push({
          message: "Plugin error",
          stackTrace: "Plugin.Settings:142",
          source: {
            kind: "script",
            path: "cloud_example.Plugin.Settings",
            className: "ModuleScript",
            inDataModel: false,
          },
        });
      const { id: _id, schema: _schema, ...body } = evidence;
      evidence.id = `evidence-${hashJson(body).slice(0, 20)}`;
      const results = await evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator: task.evaluator,
        candidate: agent.candidate,
        treatmentId: agent.treatmentId,
        evidence,
      });
      const diagnosticResult = results.find((item) => item.criterionId === "runtime-clean");
      assert.equal(diagnosticResult?.outcome, channel === "clean" ? "verified" : "rejected");
      if (channel !== "clean")
        assert.match(JSON.stringify(diagnosticResult), /does not attribute their cause/);
      assert.equal(
        results.find((item) => item.criterionId === "travel-distance")?.outcome,
        "verified",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("signed part physics supports an anchored criterion and rejects an unanchored part", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-part-physics-grade-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-part-physics-grade");
    const evaluator = structuredClone(task.evaluator);
    evaluator.studio.phases[0]!.facts.push({
      id: "physics",
      kind: "part_physics",
      path: "game.Workspace.EvalPlatform",
    });
    evaluator.deterministic.push({
      id: "anchored-platform",
      layer: "engine",
      statement: "The platform is anchored.",
      required: true,
      rule: {
        kind: "fact_equals",
        phaseId: "motion",
        factId: "physics",
        field: "anchored",
        expected: true,
      },
    });
    const evidence = evidenceFor(agent, hashJson(evaluator.studio));
    evidence.phases[0]!.observations.push({
      factId: "physics",
      kind: "part_physics",
      exists: true,
      anchored: true,
      canCollide: true,
    });
    const { id: _firstId, schema: _firstSchema, ...firstBody } = evidence;
    evidence.id = `evidence-${hashJson(firstBody).slice(0, 20)}`;
    const accepted = await evaluateDeterministicCriteria({
      workspaceRoot: workspace,
      evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
      evidence,
    });
    assert.equal(
      accepted.find((item) => item.criterionId === "anchored-platform")?.outcome,
      "verified",
    );
    const unanchored = structuredClone(evidence);
    const physics = unanchored.phases[0]!.observations.find((item) => item.factId === "physics");
    assert.ok(physics && physics.kind === "part_physics");
    physics.anchored = false;
    const { id: _secondId, schema: _secondSchema, ...secondBody } = unanchored;
    unanchored.id = `evidence-${hashJson(secondBody).slice(0, 20)}`;
    const rejected = await evaluateDeterministicCriteria({
      workspaceRoot: workspace,
      evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
      evidence: unanchored,
    });
    assert.equal(
      rejected.find((item) => item.criterionId === "anchored-platform")?.outcome,
      "rejected",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("missing objects cannot satisfy false or zero value rules, but explicit absence is observable", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-absent-values-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-absent-values");
    const evaluator = structuredClone(task.evaluator);
    evaluator.studio.phases[0]!.facts.push(
      { id: "physics", kind: "part_physics", path: "game.Workspace.Missing" },
      { id: "position", kind: "part_position", path: "game.Workspace.Missing" },
    );
    evaluator.deterministic = [
      {
        id: "false-value",
        layer: "engine",
        statement: "No collision",
        required: true,
        rule: {
          kind: "fact_equals",
          phaseId: "motion",
          factId: "physics",
          field: "canCollide",
          expected: false,
        },
      },
      {
        id: "zero-value",
        layer: "engine",
        statement: "At origin",
        required: true,
        rule: {
          kind: "number_in_range",
          phaseId: "motion",
          factId: "position",
          field: "x",
          minimum: 0,
          maximum: 0,
        },
      },
      {
        id: "absence",
        layer: "engine",
        statement: "Object absent",
        required: true,
        rule: {
          kind: "fact_equals",
          phaseId: "motion",
          factId: "physics",
          field: "exists",
          expected: false,
        },
      },
    ];
    const evidence = evidenceFor(agent, hashJson(evaluator.studio));
    evidence.phases[0]!.observations.push(
      {
        factId: "physics",
        kind: "part_physics",
        exists: false,
        anchored: false,
        canCollide: false,
      },
      { factId: "position", kind: "part_position", exists: false, x: 0, y: 0, z: 0 },
    );
    const { id: _id, schema: _schema, ...body } = evidence;
    evidence.id = `evidence-${hashJson(body).slice(0, 20)}`;
    const results = await evaluateDeterministicCriteria({
      workspaceRoot: workspace,
      evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
      evidence,
    });
    assert.deepEqual(
      results.map((item) => item.outcome),
      ["incomplete", "incomplete", "verified"],
    );
    const requiredExistence = structuredClone(evaluator.deterministic[2]!);
    requiredExistence.id = "required-existence";
    requiredExistence.statement = "The required object exists";
    if (requiredExistence.rule.kind !== "fact_equals") throw new Error("Invalid test rule");
    requiredExistence.rule.expected = true;
    evaluator.deterministic.push(requiredExistence);
    evidence.phases[0]!.observations = evidence.phases[0]!.observations.filter(
      (item) => item.factId !== "physics",
    );
    evidence.phases[0]!.observations.push({
      factId: "physics",
      kind: "binding_failure",
      requestedKind: "part_physics",
      path: "role.missing",
      reason: "missing",
    });
    const { id: _missingId, schema: _missingSchema, ...missingBody } = evidence;
    evidence.id = `evidence-${hashJson(missingBody).slice(0, 20)}`;
    const missing = await evaluateDeterministicCriteria({
      workspaceRoot: workspace,
      evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
      evidence,
    });
    // A required role with no tagged target violates the public role contract for its own
    // existence check; dependent value checks and optional absence remain unknown.
    assert.deepEqual(
      missing.map((item) => item.outcome),
      ["incomplete", "incomplete", "incomplete", "rejected"],
    );
    assert.match(missing[3]!.explanation, /public role contract is not satisfied/);
    assert.match(missing[3]!.explanation, /does not show that no similar untagged object exists/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an instance value observation binds the type of its value to its class", () => {
  const valid: StudioObservation[] = [
    { factId: "wins", kind: "instance_value", exists: true, className: "IntValue", value: 3 },
    { factId: "ratio", kind: "instance_value", exists: true, className: "NumberValue", value: 0.5 },
    { factId: "open", kind: "instance_value", exists: true, className: "BoolValue", value: false },
    { factId: "phase", kind: "instance_value", exists: true, className: "StringValue", value: "" },
    { factId: "absent", kind: "instance_value", exists: false, className: "", value: false },
  ];
  for (const observation of valid) assertStudioObservation(observation);
  const value = { factId: "wins", kind: "instance_value", exists: true };
  for (const invalid of [
    { ...value, className: "IntValue", value: 2.5 },
    { ...value, className: "IntValue", value: "3" },
    { ...value, className: "BoolValue", value: 0 },
    { ...value, className: "StringValue", value: "x".repeat(65_537) },
    { ...value, className: "ObjectValue", value: "Part" },
    { ...value, exists: false, className: "", value: 0 },
    { ...value, exists: false, className: "IntValue", value: false },
    { ...value, className: "IntValue", value: 3, property: "MaxValue" },
  ])
    assert.throws(() => assertStudioObservation(invalid), /instance-value observation/);
});

test("instance values support equality and range rules, and an absent value cannot pass", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-instance-value-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-instance-value");
    const evaluator = structuredClone(task.evaluator);
    evaluator.studio.phases[0]!.facts.push(
      { id: "score", kind: "instance_value", path: "game.Workspace.Score" },
      { id: "open", kind: "instance_value", path: "game.Workspace.Open" },
      { id: "phase", kind: "instance_value", path: "game.Workspace.Phase" },
    );
    const fact = (factId: string, field: "value" | "className", expected: JsonPrimitive) =>
      ({ kind: "fact_equals", phaseId: "motion", factId, field, expected }) as const;
    evaluator.deterministic = [
      engineCriterion("score-equals", fact("score", "value", 3)),
      engineCriterion("score-range", {
        kind: "number_in_range",
        phaseId: "motion",
        factId: "score",
        field: "value",
        minimum: 0,
        maximum: 5,
      }),
      engineCriterion("score-class", fact("score", "className", "IntValue")),
      engineCriterion("closed", fact("open", "value", false)),
      engineCriterion("phase-ready", fact("phase", "value", "ready")),
    ];
    const graded = async (observations: StudioObservation[]) => {
      const evidence = evidenceFor(agent, hashJson(evaluator.studio));
      evidence.phases[0]!.observations.push(...observations);
      const { id: _id, schema: _schema, ...body } = evidence;
      evidence.id = `evidence-${hashJson(body).slice(0, 20)}`;
      const results = await evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator,
        candidate: agent.candidate,
        treatmentId: agent.treatmentId,
        evidence,
      });
      return results.map((item) => item.outcome);
    };
    const observed = (score: number, open: boolean, phase: string): StudioObservation[] => [
      {
        factId: "score",
        kind: "instance_value",
        exists: true,
        className: "IntValue",
        value: score,
      },
      { factId: "open", kind: "instance_value", exists: true, className: "BoolValue", value: open },
      {
        factId: "phase",
        kind: "instance_value",
        exists: true,
        className: "StringValue",
        value: phase,
      },
    ];
    assert.deepEqual(await graded(observed(3, false, "ready")), Array(5).fill("verified"));
    assert.deepEqual(await graded(observed(7, true, "waiting")), [
      "rejected",
      "rejected",
      "verified",
      "rejected",
      "rejected",
    ]);
    // The fallback false of an absent value cannot satisfy a false, a zero or a class check.
    const absent = (factId: string): StudioObservation => ({
      factId,
      kind: "instance_value",
      exists: false,
      className: "",
      value: false,
    });
    assert.deepEqual(
      await graded([absent("score"), absent("open"), absent("phase")]),
      Array(5).fill("incomplete"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("each code check records the Studio values that it read, and a source check records none", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-observed-values-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-observed-values");
    const evaluator = structuredClone(task.evaluator);
    evaluator.studio.phases[0]!.facts.push({
      id: "label",
      kind: "gui_text",
      path: "game.StarterGui.Status.Label",
    });
    evaluator.deterministic = [
      engineCriterion("platform-class", {
        kind: "fact_equals",
        phaseId: "motion",
        factId: "platform",
        field: "className",
        expected: "Part",
      }),
      engineCriterion("travel-distance", {
        kind: "number_in_range",
        phaseId: "motion",
        factId: "travel",
        field: "delta",
        minimum: 18,
        maximum: 30,
      }),
      engineCriterion("runtime-clean", {
        kind: "diagnostics_empty",
        phaseId: "motion",
        factId: "errors",
      }),
      engineCriterion("label-text", {
        kind: "fact_contains",
        phaseId: "motion",
        factId: "label",
        field: "text",
        text: "Ready",
        caseSensitive: true,
      }),
      engineCriterion("wide-capture", {
        kind: "capture_present",
        phaseId: "motion",
        captureId: "platform-wide",
      }),
      {
        id: "mechanic-source",
        layer: "static",
        statement: "The mechanic source exists.",
        required: true,
        rule: { kind: "path_exists", path: "src/server/Mechanic.server.luau" },
      },
      {
        id: "mechanic-text",
        layer: "static",
        statement: "The mechanic source names the platform.",
        required: false,
        rule: {
          kind: "source_contains",
          path: "src/server/Mechanic.server.luau",
          text: "EvalPlatform",
          caseSensitive: false,
        },
      },
    ];
    const label = "Ready " + "x".repeat(300);
    const evidence = evidenceFor(agent, hashJson(evaluator.studio));
    evidence.phases[0]!.observations.push({
      factId: "label",
      kind: "gui_text",
      exists: true,
      text: label,
      visible: true,
    });
    const { id: _id, schema: _schema, ...body } = evidence;
    evidence.id = `evidence-${hashJson(body).slice(0, 20)}`;
    const results = await evaluateDeterministicCriteria({
      workspaceRoot: workspace,
      evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
      evidence,
    });
    assert.deepEqual(Object.fromEntries(results.map((item) => [item.criterionId, item.observed])), {
      "platform-class": ["Part"],
      "travel-distance": [20],
      "runtime-clean": [0, 0],
      // A text longer than the bound becomes its hash, so the result stays small.
      "label-text": [`sha256:${contentHash(label)}`],
      "wide-capture": null,
      "mechanic-source": null,
      "mechanic-text": null,
    });
    assert.equal(results.find((item) => item.criterionId === "label-text")!.outcome, "verified");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("scenario rules compare instance values across steps and contexts", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-instance-value-scenario-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/bomb-passing");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-instance-value-scenario");
    const evaluator = structuredClone(task.evaluator);
    const scenario = evaluator.studio.scenarios[0]!;
    const wins = {
      id: "wins",
      kind: "instance_value" as const,
      path: "game.Players.LocalPlayer.leaderstats.Wins",
    };
    const round = { id: "round", kind: "instance_value" as const, path: "game.Workspace.Round" };
    for (const stepId of ["before-pass", "after-pass"])
      scenario.steps
        .find((step) => step.id === stepId)!
        .observations.push(
          { context: "holder", fact: wins },
          { context: "server", fact: round },
          { context: "holder", fact: round },
        );
    const scenarioId = scenario.id;
    evaluator.deterministic = [
      engineCriterion("wins-rise", {
        kind: "scenario_number_delta_in_range",
        scenarioId,
        context: "holder",
        fromStepId: "before-pass",
        fromFactId: "wins",
        toStepId: "after-pass",
        toFactId: "wins",
        field: "value",
        minimum: 1,
        maximum: 1,
      }),
      engineCriterion("wins-after", {
        kind: "scenario_fact_equals",
        scenarioId,
        stepId: "after-pass",
        context: "holder",
        factId: "wins",
        field: "value",
        expected: 1,
      }),
      engineCriterion("round-active", {
        kind: "scenario_fact_supports_value",
        scenarioId,
        stepId: "after-pass",
        context: "server",
        factId: "round",
        field: "value",
        expected: "active",
      }),
      engineCriterion("round-converges", {
        kind: "scenario_cross_context_equals",
        scenarioId,
        stepId: "after-pass",
        factId: "round",
        field: "value",
        contexts: ["server", "holder"],
      }),
    ];
    const reportsWith = (after: {
      wins: StudioObservation;
      serverRound: StudioObservation;
      holderRound: StudioObservation;
    }) => {
      const reports = scenario.reportContexts.map((context) => scenarioReport(scenario, context));
      const replace = (context: string, factId: string, observation: StudioObservation) => {
        const step = reports
          .find((report) => report.context === context)!
          .steps.find((item) => item.stepId === "after-pass")!;
        step.observations = step.observations.map((item) =>
          item.factId === factId ? observation : item,
        );
      };
      replace("holder", "wins", after.wins);
      replace("server", "round", after.serverRound);
      replace("holder", "round", after.holderRound);
      return reports;
    };
    const graded = async (after: Parameters<typeof reportsWith>[0]) =>
      (
        await evaluateDeterministicCriteria({
          workspaceRoot: workspace,
          evaluator,
          candidate: agent.candidate,
          treatmentId: agent.treatmentId,
          evidence: scenarioEvidence(agent, hashJson(evaluator.studio), reportsWith(after)),
        })
      ).map((item) => item.outcome);
    const int = (factId: string, value: number): StudioObservation => ({
      factId,
      kind: "instance_value",
      exists: true,
      className: "IntValue",
      value,
    });
    const text = (value: string): StudioObservation => ({
      factId: "round",
      kind: "instance_value",
      exists: true,
      className: "StringValue",
      value,
    });
    const absent = (factId: string): StudioObservation => ({
      factId,
      kind: "instance_value",
      exists: false,
      className: "",
      value: false,
    });
    assert.deepEqual(
      await graded({
        wins: int("wins", 1),
        serverRound: text("active"),
        holderRound: text("active"),
      }),
      Array(4).fill("verified"),
    );
    assert.deepEqual(
      await graded({
        wins: int("wins", 2),
        serverRound: text("waiting"),
        holderRound: text("active"),
      }),
      ["rejected", "rejected", "incomplete", "rejected"],
    );
    // Two absent values have the same fallback, but they cannot agree or change by a delta.
    assert.deepEqual(
      await graded({
        wins: absent("wins"),
        serverRound: absent("round"),
        holderRound: absent("round"),
      }),
      Array(4).fill("incomplete"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("capture decoding refuses an image without complete pixel data", () => {
  const png = PNG.sync.write(new PNG({ width: 32, height: 24 }));
  assert.equal(decodeCaptureImage(png, "image/png").width, 32);
  const corrupt = Buffer.from(png);
  corrupt[32] = corrupt[32]! ^ 1;
  assert.throws(() => decodeCaptureImage(corrupt, "image/png"), /CRC/);
  assert.throws(() => decodeCaptureImage(png.subarray(0, -12), "image/png"));
  assert.throws(
    () => decodeCaptureImage(Buffer.concat([png, png.subarray(-12)]), "image/png"),
    /after IEND/,
  );
  const huge = Buffer.from(png);
  huge.writeUInt32BE(8192, 16);
  huge.writeUInt32BE(8192, 20);
  assert.throws(() => decodeCaptureImage(huge, "image/png"), /pixel limit/);

  // pngjs skips an unknown ancillary chunk without a CRC check. Without IDAT, it fills the
  // pixels from uninitialized memory.
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const bytes = Buffer.alloc(body.length + 8);
    bytes.writeUInt32BE(data.length, 0);
    body.copy(bytes, 4);
    bytes.writeUInt32BE(crc32(body), body.length + 4);
    return bytes;
  };
  const idat = png.indexOf("IDAT") - 4;
  const end = idat + 12 + png.readUInt32BE(idat);
  const renamed = chunk("tDAT", png.subarray(idat + 8, end - 4));
  const withoutImage = Buffer.concat([png.subarray(0, idat), renamed, png.subarray(end)]);
  assert.throws(() => decodeCaptureImage(withoutImage, "image/png"), /no image data/);
  const note = chunk("tEXt", Buffer.from("Comment\0capture", "latin1"));
  const noted = Buffer.concat([png.subarray(0, idat), note, png.subarray(idat)]);
  assert.equal(decodeCaptureImage(noted, "image/png").height, 24);
  note[note.length - 1] = note[note.length - 1]! ^ 1;
  assert.throws(
    () =>
      decodeCaptureImage(
        Buffer.concat([png.subarray(0, idat), note, png.subarray(idat)]),
        "image/png",
      ),
    /chunk 1 has a wrong CRC/,
  );

  const encoded = jpeg.encode(
    { width: 32, height: 24, data: Buffer.alloc(32 * 24 * 4, 255) },
    80,
  ).data;
  assert.equal(decodeCaptureImage(encoded, "image/jpeg").height, 24);
  const nativeViewport = { width: 1908, height: 1080 };
  const nativeJpeg = jpeg.encode(
    { ...nativeViewport, data: Buffer.alloc(nativeViewport.width * nativeViewport.height * 4) },
    70,
  ).data;
  assert.equal(decodeCaptureImage(nativeJpeg, "image/jpeg").width, 1908);
  assert.throws(() => decodeCaptureImage(encoded.subarray(0, -2), "image/jpeg"), /complete/);
  assert.throws(
    () => decodeCaptureImage(Buffer.from("ffd8ffd9", "hex"), "image/jpeg"),
    /no scan data/,
  );
  // jpeg-js decodes a JPEG without a scan to a uniform image.
  const scan = encoded.indexOf(Buffer.from([0xff, 0xda]));
  assert.throws(
    () =>
      decodeCaptureImage(
        Buffer.concat([encoded.subarray(0, scan), Buffer.from([0xff, 0xd9])]),
        "image/jpeg",
      ),
    /no scan data/,
  );
});

test("code checks verify bound evidence and never claim Studio results without it", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-grade-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-grade");
    const bound = {
      workspaceRoot: workspace,
      evaluator: task.evaluator,
      candidate: agent.candidate,
      treatmentId: agent.treatmentId,
    };
    const engine = (criteria: CriterionResult[]) =>
      criteria.filter((item) => item.layer === "engine");
    const evidence = evidenceFor(agent, task.collectionPlanHash);
    const observed = await evaluateDeterministicCriteria({ ...bound, evidence });
    assert.ok(engine(observed).length > 0);
    assert.ok(engine(observed).every((item) => item.outcome === "verified"));
    const withoutStudio = await evaluateDeterministicCriteria(bound);
    assert.ok(engine(withoutStudio).every((item) => item.outcome === "incomplete"));
    await assert.rejects(
      evaluateDeterministicCriteria({ ...bound, treatmentId: "other-treatment", evidence }),
      /Studio evidence binding mismatch/,
    );

    const evaluator = structuredClone(task.evaluator);
    evaluator.deterministic.push({
      id: "required-static-file",
      layer: "static",
      statement: "The required source file exists.",
      required: true,
      rule: { kind: "path_exists", path: "src/server/Absent.server.luau" },
    });
    const absent = await evaluateDeterministicCriteria({ ...bound, evaluator });
    assert.equal(
      absent.find((item) => item.criterionId === "required-static-file")?.outcome,
      "rejected",
    );

    await writeFile(resolve(workspace, "src/server/Mechanic.server.luau"), "-- changed\n");
    await assert.rejects(
      evaluateDeterministicCriteria(bound),
      /no longer matches the sealed candidate/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("scenario grading distinguishes player actions, authority, convergence, deltas, and timing", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-scenario-grade-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/bomb-passing");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-scenario-grade");
    const grade = (evaluator: EvaluatorSpec, evidence: StudioEvidence) =>
      evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator,
        candidate: agent.candidate,
        treatmentId: agent.treatmentId,
        evidence,
      });
    const evaluator = structuredClone(task.evaluator);
    evaluator.deterministic = evaluator.deterministic.filter((criterion) =>
      [
        "real-pass-input",
        "near-pass-start-owner",
        "near-pass-owner",
        "near-pass-replicates",
        "fuse-preserved",
      ].includes(criterion.id),
    );
    evaluator.deterministic.push(
      {
        id: "literal-owner",
        layer: "engine",
        statement: "The initial owner is the frozen fixture player.",
        required: true,
        rule: {
          kind: "scenario_fact_equals",
          scenarioId: "legitimate-pass",
          stepId: "before-pass",
          context: "server",
          factId: "owner",
          field: "value",
          expected: 101,
        },
      },
      {
        id: "observed-owner-support",
        layer: "engine",
        statement: "A sampled owner value can support a result without imposing a deadline.",
        required: false,
        rule: {
          kind: "scenario_fact_supports_value",
          scenarioId: "legitimate-pass",
          stepId: "after-pass",
          context: "server",
          factId: "owner",
          field: "value",
          expected: 202,
        },
      },
    );
    evaluator.codeQuality = [];
    evaluator.visual = [];
    evaluator.humanReview = [];
    const scenario = evaluator.studio.scenarios[0]!;
    const reports = scenario.reportContexts.map((context) => scenarioReport(scenario, context));
    for (const report of reports) {
      const after = report.steps.find((step) => step.stepId === "after-pass")!;
      for (const observation of after.observations) {
        if (observation.kind === "replication_probe" && observation.factId === "owner")
          observation.value = 202;
      }
    }
    const evidence = scenarioEvidence(agent, task.collectionPlanHash, reports);
    const result = await grade(evaluator, evidence);
    assert.deepEqual(
      result.map((criterion) => criterion.outcome),
      Array(result.length).fill("verified"),
    );
    // Each scenario rule records the values that it read, in the sequence of its rule.
    assert.deepEqual(Object.fromEntries(result.map((item) => [item.criterionId, item.observed])), {
      "real-pass-input": [true],
      "near-pass-start-owner": [101],
      "near-pass-owner": [202],
      "near-pass-replicates": [202, 202, 202],
      "fuse-preserved": [10, 10],
      "literal-owner": [101],
      "observed-owner-support": [202],
    });
    const slowerReports = structuredClone(reports);
    const delayedOwner = slowerReports
      .find((report) => report.context === "server")!
      .steps.find((step) => step.stepId === "after-pass")!
      .observations.find((observation) => observation.factId === "owner")!;
    if (delayedOwner.kind !== "replication_probe") throw new Error("invalid fixture");
    delayedOwner.value = 101;
    const slower = await grade(
      evaluator,
      scenarioEvidence(agent, task.collectionPlanHash, slowerReports),
    );
    assert.equal(
      slower.find((criterion) => criterion.criterionId === "observed-owner-support")?.outcome,
      "incomplete",
    );

    const preexistingReports = structuredClone(reports);
    const preexistingServer = preexistingReports.find((report) => report.context === "server")!;
    const beforeOwner = preexistingServer.steps
      .find((step) => step.stepId === "before-pass")!
      .observations.find((observation) => observation.factId === "owner")!;
    if (beforeOwner.kind !== "replication_probe") throw new Error("invalid fixture");
    beforeOwner.value = 202;
    const preexisting = await grade(
      evaluator,
      scenarioEvidence(agent, task.collectionPlanHash, preexistingReports),
    );
    assert.equal(
      preexisting.find((item) => item.criterionId === "literal-owner")?.outcome,
      "rejected",
    );

    // A person adds a time bound to a fact-anchored step. The receiver sees its
    // notice at its own first sighting; the bound starts at the actedAt of the press.
    const timed = structuredClone(evaluator);
    const timedScenario = timed.studio.scenarios[0]!;
    const pressIndex = timedScenario.steps.findIndex((step) => step.id === "press-pass");
    timedScenario.steps.splice(pressIndex + 1, 0, {
      id: "owner-notice",
      at: {
        after: {
          fact: {
            kind: "gui_visible",
            path: "game.Players.LocalPlayer.PlayerGui.BombNotice",
            visible: true,
          },
          scope: "receiver",
        },
        offsetMs: 0,
      },
      horizonMs: 3000,
      holdMs: 0,
      action: { kind: "wait" },
      observations: [],
      requirement: { withinMs: 2000, quote: "within 2 seconds" },
    });
    timed.deterministic.push({
      id: "pass-latency",
      layer: "engine",
      statement: "The receiver sees the bomb notice within 2 seconds after the key press.",
      required: true,
      rule: { kind: "scenario_step_within", scenarioId: "legitimate-pass", stepId: "owner-notice" },
    });
    const pressedAt = scenarioReport(timedScenario, "holder").steps[pressIndex]!.actedAt!;
    const latencies: Array<JsonPrimitive[] | null> = [];
    const latency = async (change: (step: StudioScenarioStepReport) => void) => {
      const timedReports = timedScenario.reportContexts.map((context) =>
        scenarioReport(timedScenario, context),
      );
      const notice = timedReports.find((report) => report.context === "receiver")!.steps[
        pressIndex + 1
      ]!;
      notice.pollIntervalMs = 16.667;
      change(notice);
      const graded = await grade(
        timed,
        scenarioEvidence(agent, hashJson(timed.studio), timedReports),
      );
      const latencyResult = graded.find((item) => item.criterionId === "pass-latency")!;
      latencies.push(latencyResult.observed);
      return latencyResult.outcome;
    };
    const sightedAfter = (seconds: number) => (step: StudioScenarioStepReport) => {
      step.anchorObservedAt = pressedAt + seconds;
      step.scheduledAt = pressedAt + seconds;
      step.dueAt = pressedAt;
    };
    assert.equal(await latency(sightedAfter(1.2)), "verified");
    assert.equal(await latency(sightedAfter(2.5)), "rejected");
    assert.equal(await latency(sightedAfter(2.01)), "incomplete", "The poll interval straddles it");
    assert.equal(
      await latency((step) => {
        sightedAfter(0.5)(step);
        step.anchorPreexisting = true;
      }),
      "incomplete",
      "A fact that held at the first poll cannot time the change",
    );
    const unseen = (outcome: StudioScenarioStepReport["outcome"], dueAt: number) =>
      latency((step) => {
        step.outcome = outcome;
        step.dueAt = dueAt;
        delete step.anchorObservedAt;
        delete step.scheduledAt;
      });
    assert.equal(
      await unseen("not_observed_within_horizon", pressedAt),
      "rejected",
      "The runner looked through the whole bound",
    );
    assert.equal(
      await unseen("not_observed_within_horizon", pressedAt + 1.5),
      "incomplete",
      "The runner started to look after the reference, so its horizon misses part of the bound",
    );
    assert.equal(await unseen("acquisition_failed", pressedAt), "incomplete");
    assert.deepEqual(
      latencies,
      [[1200], [2500], null, null, [null], null, null],
      "A timed step records the latency of its first sighting, or no sighting",
    );

    const divergentReports = structuredClone(reports);
    const receiver = divergentReports.find((report) => report.context === "receiver")!;
    const receiverOwner = receiver.steps
      .find((step) => step.stepId === "after-pass")!
      .observations.find((observation) => observation.factId === "owner")!;
    if (receiverOwner.kind !== "replication_probe") throw new Error("invalid fixture");
    receiverOwner.value = 999;
    const divergent = await grade(
      evaluator,
      scenarioEvidence(agent, task.collectionPlanHash, divergentReports),
    );
    assert.equal(
      divergent.find((criterion) => criterion.criterionId === "near-pass-replicates")?.outcome,
      "rejected",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("prepared Studio session accepts only bound fixed-plan evidence and finalizes it", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-studio-"));
  let server: Awaited<ReturnType<typeof serveStudioSession>>["server"] | undefined;
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/moving-platform");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const { readOperatorStudy } = await import("../packages/operator/src/config.js");
    const study = await readOperatorStudy(root, ["tasks/pilot/moving-platform"]);
    const frozen = await freezeStudy({
      repositoryRoot: root,
      study,
      implementationCommit: "a".repeat(40),
      dirty: false,
      connectorSourceHash: await hashDirectoryTree(resolve(root, "plugin")),
      connectorArtifactHash: "d".repeat(64),
      frozenAt: "2026-09-17T00:00:00.000Z",
    });
    const treatment = frozen.treatments.find((entry) => entry.task.id === task.id);
    assert.ok(treatment);
    const agent = await fakeAgentRun(workspace, treatment.id);
    const wrongProject = structuredClone(agent);
    wrongProject.candidate.projectFile = "src/server/Mechanic.server.luau";
    wrongProject.id = agentRunId(wrongProject);
    await assert.rejects(
      prepareStudioSession({
        workspaceRoot: workspace,
        outputDirectory: resolve(temporary, "wrong-project-studio"),
        task,
        treatment,
        candidate: wrongProject.candidate,
        connectorSourceHash: frozen.connectorSourceHash,
        connectorArtifactHash: frozen.connectorArtifactHash,
      }),
      /candidate project does not match/,
    );
    const sessionDirectory = resolve(temporary, "studio");
    const connectorUrl = await availableLoopbackUrl();
    const session = await prepareStudioSession({
      workspaceRoot: workspace,
      outputDirectory: sessionDirectory,
      task,
      treatment,
      candidate: agent.candidate,
      connectorSourceHash: frozen.connectorSourceHash,
      connectorArtifactHash: frozen.connectorArtifactHash,
      createdAt: "2026-09-17T02:00:00.000Z",
      connectorUrl,
    });
    assert.equal(session.schema, "basalt-evals/studio-session");
    assert.equal(session.connectorUrl, connectorUrl);
    assert.match(session.place.file, /^BasaltEval-[a-f0-9]{20}\.rbxlx$/);
    assert.ok(!session.place.file.includes(session.token));
    const preparedPlace = await readFile(resolve(sessionDirectory, session.place.file), "utf8");
    assert.match(preparedPlace, /<string name="Name">BasaltEvalBootstrap<\/string>/u);
    assert.match(preparedPlace, /basalt-evals\/studio-bootstrap/u);
    assert.match(preparedPlace, new RegExp(session.token, "u"));
    const publicPlace = preparedPlace.replace(/<(\w+) name="Source">[\s\S]*?<\/\1>/gu, "");
    assert.doesNotMatch(publicPlace, /BasaltEvalConnectionId/u);
    assert.ok(
      !publicPlace.includes(session.token),
      "The capability must not enter replicated values or attributes",
    );
    assert.deepEqual(
      (await readdir(sessionDirectory)).sort(),
      [session.place.file, "session.json"].sort(),
    );
    const sourceImage = PNG.sync.write(new PNG({ width: 1279, height: 720 }));
    let windowBytes: Buffer = sourceImage;
    let captureCalls = 0;
    let permissionCalls = 0;
    let permissionError: string | undefined;
    let captureError: string | undefined;
    let pendingCapture: Promise<void> | undefined;
    let captureStarted: (() => void) | undefined;
    const nativeJob = "b".repeat(32);
    let nativeCompletion: unknown;
    let nativeFailure: string | undefined;
    const served = await serveStudioSession(
      sessionDirectory,
      {
        close() {},
        async check() {
          permissionCalls++;
          if (permissionError) throw new Error(permissionError);
        },
        async capture() {
          captureCalls++;
          captureStarted?.();
          await pendingCapture;
          if (captureError) throw new Error(captureError);
          return { bytes: windowBytes, mediaType: "image/png" };
        },
      },
      {
        jobId: nativeJob,
        complete: (receipt) => {
          nativeCompletion = receipt;
        },
        failed: (error) => {
          nativeFailure = error;
        },
      },
    );
    server = served.server;
    const workerReady = await fetch(`${served.url}/worker-ready`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.deepEqual(await workerReady.json(), { ready: false, jobId: nativeJob });
    assert.equal(served.url, connectorUrl);
    const unauthorized = await fetch(`${served.url}/session`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await fetch(`${served.url}/sequence-view`)).status, 401);
    const staleToken = `${session.token[0] === "a" ? "b" : "a"}${session.token.slice(1)}`;
    const stalePlace = await fetch(`${served.url}/session`, {
      headers: { authorization: `Bearer ${staleToken}` },
    });
    assert.equal(stalePlace.status, 401);
    assert.deepEqual(await stalePlace.json(), { error: "unauthorized" });
    for (const route of [
      "capture-ready",
      "captures/motion/platform-wide",
      "submission",
      "trace",
      "trial",
      "worker-complete",
    ]) {
      const denied = await fetch(`${served.url}/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${staleToken}` },
        body: "invalid JSON must not be parsed before authorization",
      });
      assert.equal(denied.status, 401);
    }
    const malformed = await fetch(`${served.url}/session`, {
      headers: { authorization: "Basic do-not-log-this-credential" },
    });
    assert.equal(malformed.status, 401);
    assert.equal(permissionCalls, 0, "A stale place cannot request screen recording permission");
    assert.equal(captureCalls, 0, "A stale place cannot capture the window");
    const deniedTrace = await readLatestStudioTrace(sessionDirectory);
    assert.ok(!deniedTrace.text.includes(staleToken));
    assert.ok(!deniedTrace.text.includes("do-not-log-this-credential"));
    const deniedEvents = deniedTrace.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(deniedEvents[0].data.placeFile, resolve(sessionDirectory, session.place.file));
    assert.deepEqual(
      [
        ...new Set(
          deniedEvents
            .filter((event) => event.stage === "request.denied")
            .map((event) => event.data.reason),
        ),
      ],
      ["missing_authorization", "session_token_mismatch", "malformed_authorization"],
    );
    assert.ok(!deniedEvents.some((event) => event.stage === "trial.started"));
    const response = await fetch(`${served.url}/session`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.clone().json()).connectorUrl, connectorUrl);
    const view = await fetch(`${served.url}/sequence-view`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.deepEqual(await view.json(), {
      schema: "basalt-evals/sequence-view",
      viewport: null,
    });
    const clientId = "c".repeat(32);
    const begin = async (mode: string) => {
      const response = await fetch(`${served.url}/trial`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ clientId: mode === "launch" ? nativeJob : clientId, mode }),
      });
      assert.equal(response.status, 201);
      return (await response.json()).trialId as string;
    };
    const trialId = await begin("launch");
    assert.equal(
      await begin("capture"),
      trialId,
      "The Play client must join its Edit launch trace",
    );
    assert.equal(await begin("launch"), trialId, "Fresh Studio steps keep one trial identity");
    assert.equal(await begin("capture"), trialId, "A later Play client joins the same trial");
    const pluginTrace = await fetch(`${served.url}/trace`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        events: [
          {
            sequence: 1,
            at: "2026-09-18T00:00:00.000Z",
            stage: "play.requested",
            trialId,
            data: { method: "ExecutePlayModeAsync", argument: "table" },
          },
        ],
      }),
    });
    assert.equal(pluginTrace.status, 200);
    const readiness = {
      clientId,
      events: [
        {
          sequence: 2,
          at: "2026-09-18T00:00:01.000Z",
          stage: "connection.ready",
          trialId: "",
          data: { transport: "http", runState: "Stopped", sessionId: session.id },
        },
      ],
    };
    const traceBatch = (batch: unknown, token = session.token) =>
      fetch(`${served.url}/trace`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
    assert.equal((await traceBatch(readiness, staleToken)).status, 401);
    const ready = async () =>
      (
        await fetch(`${served.url}/worker-ready`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).json();
    assert.equal((await ready()).ready, false);
    assert.equal((await traceBatch(readiness)).status, 200);
    assert.equal((await ready()).ready, true);
    served.resetWorkerReady();
    assert.equal((await ready()).ready, false);
    assert.equal((await traceBatch(readiness)).status, 200);
    assert.equal((await ready()).ready, false, "A repeated trace cannot arm a fresh native step");
    assert.equal(
      (await traceBatch({ ...readiness, events: [{ ...readiness.events[0], sequence: 3 }] }))
        .status,
      200,
    );
    assert.equal((await ready()).ready, true);
    const failureBatch = {
      clientId,
      events: [
        {
          sequence: 4,
          at: "2026-09-18T00:00:02.000Z",
          stage: "trial.failed",
          trialId,
          data: { error: `Capture failed with capability ${session.token}` },
        },
      ],
    };
    assert.equal((await traceBatch(failureBatch, staleToken)).status, 401);
    assert.equal(nativeFailure, undefined, "Unauthenticated traces cannot terminate a worker");
    assert.equal((await traceBatch(failureBatch)).status, 200);
    assert.equal(nativeFailure, "Capture failed with capability [REDACTED]");
    nativeFailure = undefined;
    assert.equal((await traceBatch(failureBatch)).status, 200);
    assert.equal(nativeFailure, undefined, "A repeated failure cannot cancel a later native step");
    assert.equal(permissionCalls, 0, "Discovery must never request OS permission");
    const check = (authorized = true) =>
      fetch(`${served.url}/capture-ready`, {
        method: "POST",
        headers: authorized
          ? { authorization: `Bearer ${session.token}`, "x-basalt-trial": trialId }
          : {},
      });
    assert.equal((await check(false)).status, 401);
    assert.equal(permissionCalls, 0);
    nativeFailure = undefined;
    permissionError = "Enable Studio as MCP server";
    const denied = await check();
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /Enable Studio as MCP server/);
    assert.equal(nativeFailure, permissionError);
    permissionError = undefined;
    assert.deepEqual(await (await check()).json(), { ready: true });

    const captureBytes = sourceImage;
    const capture = (
      body: unknown = { source: "studio-mcp" },
      captureId = "platform-wide",
      authorized = true,
    ) =>
      fetch(`${served.url}/captures/motion/${captureId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-basalt-trial": trialId,
          ...(authorized ? { authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await capture({}, "platform-wide", false)).status, 401);
    assert.equal((await capture({}, "unplanned")).status, 400);
    for (const body of [null, { nonce: "bad" }, { windowId: 123 }])
      assert.equal((await capture(body)).status, 400);
    const rawUpload = await fetch(`${served.url}/captures/motion/platform-wide`, {
      method: "POST",
      headers: { "content-type": "image/png", authorization: `Bearer ${session.token}` },
      body: Buffer.from(captureBytes),
    });
    assert.equal(rawUpload.status, 400, "Raw screenshot uploads are not a supported capture path");
    assert.equal(captureCalls, 0, "Invalid requests must not read the screen");
    nativeFailure = undefined;
    captureError = "Selected Studio instance is disconnected";
    const failedCapture = await capture();
    assert.equal(failedCapture.status, 400);
    assert.match(await failedCapture.text(), /Selected Studio instance/);
    assert.equal(
      nativeFailure,
      captureError,
      "The native owner must stop without waiting for a Play client failure trace",
    );
    captureError = undefined;
    nativeFailure = undefined;
    windowBytes = Buffer.from("not a PNG");
    assert.equal((await capture()).status, 400);
    assert.ok(nativeFailure, "Image validation failures must also stop the native owner");
    const attempts = await readdir(resolve(sessionDirectory, "acquisitions"));
    const failed = await Promise.all(
      attempts
        .filter((name) => name.startsWith("capture-"))
        .map(async (name) => {
          const directory = resolve(sessionDirectory, "acquisitions", name);
          return { directory, files: await readdir(directory) };
        }),
    );
    const malformedImage = failed.find((attempt) => attempt.files.includes("received.image"))!;
    assert.ok(malformedImage.files.includes("failure.json"));
    assert.equal(
      (await readFile(resolve(malformedImage.directory, "received.image"))).toString(),
      "not a PNG",
    );
    windowBytes = sourceImage;
    const escapedCaptureDirectory = resolve(temporary, "escaped-captures");
    await mkdir(escapedCaptureDirectory);
    const sessionCaptureDirectory = resolve(sessionDirectory, "captures");
    await symlink(escapedCaptureDirectory, sessionCaptureDirectory);
    assert.equal((await capture()).status, 400, "capture must reject symlink directories");
    await unlink(sessionCaptureDirectory);
    const uploaded = await capture();
    assert.equal(uploaded.status, 201);
    assert.deepEqual(await uploaded.json(), {
      captureId: "platform-wide",
      hash: contentHash(captureBytes),
    });
    let releaseCapture!: () => void;
    let startedCapture!: () => void;
    const started = new Promise<void>((accept) => {
      startedCapture = accept;
    });
    // Waiting inside the injected capture provides a deterministic concurrency
    // check without sleeps or any real OS operation.
    captureStarted = startedCapture;
    pendingCapture = new Promise<void>((accept) => {
      releaseCapture = accept;
    });
    const pending = capture();
    await started;
    const overlap = await capture();
    assert.equal(overlap.status, 400);
    assert.match(await overlap.text(), /in progress/);
    releaseCapture();
    assert.equal((await pending).status, 201, "Identical viewport bytes remain idempotent");
    pendingCapture = undefined;
    captureStarted = undefined;
    const submission = {
      schema: "basalt-evals/studio-submission",
      sessionId: session.id,
      studioVersion: "0.740.19.7400931",
      startedAt: "2026-09-17T02:01:00.000Z",
      endedAt: "2026-09-17T02:02:00.000Z",
      phases: [
        {
          phaseId: "motion",
          captures: [
            {
              captureId: "platform-wide",
              hash: contentHash(captureBytes),
              sceneText: { complete: true, entries: [] },
            },
          ],
          observations: [
            { factId: "platform", kind: "instance", exists: true, className: "Part" },
            { factId: "travel", kind: "part_motion", samples: motionSamples(), delta: 20 },
            { factId: "errors", kind: "diagnostics", messages: [], scriptErrors: [] },
          ],
        },
      ],
    };
    const post = (body: unknown) =>
      fetch(`${served.url}/submission`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const missing = structuredClone(submission);
    missing.phases[0]!.captures = [];
    assert.equal((await post(missing)).status, 400, "every planned image is required");
    const unbound = structuredClone(submission);
    unbound.phases[0]!.captures[0]!.hash = "f".repeat(64);
    assert.equal((await post(unbound)).status, 400, "unuploaded image hashes cannot submit");
    const unsupportedMotion = structuredClone(submission);
    unsupportedMotion.phases[0]!.observations[1]!.samples = [];
    assert.equal((await post(unsupportedMotion)).status, 400, "unsampled movement cannot submit");
    const undersampled = structuredClone(submission);
    undersampled.phases[0]!.observations[1]!.samples = motionSamples().slice(1);
    assert.equal((await post(undersampled)).status, 400, "missing motion samples cannot submit");
    const tooFast = structuredClone(submission);
    tooFast.phases[0]!.observations[1]!.samples = motionSamples().map((sample, i) => ({
      ...sample,
      elapsedMs: i,
    }));
    assert.equal((await post(tooFast)).status, 400, "sampling must respect the planned interval");
    const submitted = await fetch(`${served.url}/submission`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(submission),
    });
    assert.equal(submitted.status, 201);
    const submittedAgain = await fetch(`${served.url}/submission`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(submission),
    });
    assert.equal(submittedAgain.status, 201);
    const nativeFinish = (jobId: string, submissionHash: string) =>
      fetch(`${served.url}/worker-complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
          "x-basalt-trial": trialId,
        },
        body: JSON.stringify({ jobId, submissionHash }),
      });
    assert.equal((await nativeFinish("wrong-job", hashJson(submission))).status, 400);
    assert.equal((await nativeFinish(nativeJob, "f".repeat(64))).status, 400);
    assert.equal(nativeCompletion, undefined);
    assert.equal((await nativeFinish(nativeJob, hashJson(submission))).status, 200);
    assert.deepEqual(nativeCompletion, { trialId, submissionHash: hashJson(submission) });
    assert.equal((await nativeFinish(nativeJob, hashJson(submission))).status, 400);
    assert.equal(
      (await post({ ...submission, endedAt: "2026-09-17T02:03:00.000Z" })).status,
      400,
      "conflicting submissions cannot replace the sealed attempt",
    );
    await new Promise<void>((accept) => server?.close(() => accept()));
    server = undefined;
    const trace = await readLatestStudioTrace(sessionDirectory);
    assert.equal(trace.file, served.traceFile);
    assert.ok(
      !trace.text.includes(session.token),
      "Diagnostics cannot expose the session capability",
    );
    const events = trace.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].stage, "server.started");
    assert.equal(events.at(-1).stage, "server.stopped");
    assert.ok(
      events.some(
        (event) =>
          event.stage === "request.failed" &&
          event.data.error.includes("Selected Studio instance") &&
          event.trialId === trialId,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.stage === "capture.stored" &&
          event.data.width === 1279 &&
          event.data.height === 720,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.stage === "capture.stored" && event.data.hash === contentHash(captureBytes),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.source === "plugin" &&
          event.stage === "play.requested" &&
          event.trialId === trialId,
      ),
    );
    const captureFile = resolve(
      sessionCaptureDirectory,
      `${hashJson({ phaseId: "motion", captureId: "platform-wide" })}-${contentHash(captureBytes)}.image`,
    );
    await writeFile(captureFile, Buffer.from("changed"));
    await assert.rejects(finalizeStudioEvidence({ sessionDirectory }), /hash mismatch/);
    await writeFile(captureFile, captureBytes);
    const evidence = await finalizeStudioEvidence({ sessionDirectory });
    assert.equal(evidence.candidateHash, agent.candidate.rootHash);
    assert.equal(evidence.studio.version, submission.studioVersion);
    assert.equal(evidence.phases[0]?.observations.length, 3);
    assert.equal(evidence.phases[0]?.captures.length, 1);
    const impossibleViewport = structuredClone(evidence);
    impossibleViewport.phases[0]!.captures[0]!.width = 8_193;
    assert.throws(() => assertStudioEvidence(impossibleViewport), /Studio evidence capture/);
    const repeated = await finalizeStudioEvidence({ sessionDirectory });
    assert.deepEqual(repeated, evidence);

    const placeFile = resolve(sessionDirectory, session.place.file);
    const originalPlace = await readFile(placeFile);
    await writeFile(placeFile, Buffer.from("tampered place"));
    await assert.rejects(
      serveStudioSession(sessionDirectory, {
        async check() {},
        async capture() {
          throw new Error("must not capture");
        },
        close() {},
      }),
      /place no longer matches the prepared candidate/,
    );
    await writeFile(placeFile, originalPlace);

    const sessionFile = resolve(sessionDirectory, "session.json");
    const tamperedSession = JSON.parse(await readFile(sessionFile, "utf8")) as {
      plan: { phases: Array<{ label: string }> };
    };
    tamperedSession.plan.phases[0]!.label = "Tampered phase";
    await writeFile(sessionFile, `${JSON.stringify(tamperedSession)}\n`);
    await assert.rejects(
      serveStudioSession(sessionDirectory, {
        async check() {},
        async capture() {
          throw new Error("must not capture");
        },
        close() {},
      }),
      /plan hash|identity/,
    );
  } finally {
    if (server) await new Promise<void>((accept) => server?.close(() => accept()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("multiplayer sequence readiness and runtime reports are bound to the prepared scenario", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-runtime-"));
  const completions: Array<
    import("../packages/studio-runner/src/studio-mcp.js").StudioScenarioCompletion
  > = [];
  let server: Awaited<ReturnType<typeof serveStudioSession>>["server"] | undefined;
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/bomb-passing");
    const workspace = resolve(temporary, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const agent = await fakeAgentRun(workspace, "tr-runtime");
    const connectorUrl = await availableLoopbackUrl();
    const sessionDirectory = resolve(temporary, "studio");
    const session = await prepareStudioSession({
      workspaceRoot: workspace,
      outputDirectory: sessionDirectory,
      task,
      treatment: {
        id: agent.treatmentId,
        task: {
          id: task.id,
          publicTaskHash: task.publicTaskHash,
          evaluatorHash: task.evaluatorHash,
          seedHash: task.seedHash,
          collectionPlanHash: task.collectionPlanHash,
        },
        environment: {
          platform: "Roblox Studio",
          studioVersion: "0.739.0.7390687",
          captureProtocol: "studio-mcp-viewport",
          cameraProtocol: "Unmodified viewport",
        },
      },
      candidate: agent.candidate,
      connectorSourceHash: "a".repeat(64),
      connectorArtifactHash: "b".repeat(64),
      connectorUrl,
      createdAt: "2026-09-20T00:00:00.000Z",
    });
    const scenario = task.evaluator.studio.scenarios[0]!;
    const sequence: SequencePlan = {
      schema: "basalt-evals/sequence-plan",
      suiteHash: "c".repeat(64),
      sourceHash: session.candidateHash,
      implementationCommit: "d".repeat(40),
      scenarioId: scenario.id,
      viewId: "standard",
      requiredTransitions: [],
      camera: null,
      viewport: null,
      maximumGapMs: 1000,
      frameBudget: 64,
    };
    await writeFile(resolve(sessionDirectory, "sequence.json"), JSON.stringify(sequence));
    const served = await serveStudioSession(
      sessionDirectory,
      {
        close() {},
        async check() {},
        async capture() {
          throw new Error("runtime report test must not capture");
        },
      },
      {
        jobId: "d".repeat(32),
        complete() {},
        scenarioComplete: (receipt) => completions.push(receipt),
      },
    );
    server = served.server;
    const begin = await fetch(`${served.url}/trial`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "d".repeat(32), mode: "launch" }),
    });
    assert.equal(begin.status, 201);
    const trialId = ((await begin.json()) as { trialId: string }).trialId;
    const sequenceReady = (scenarioId = scenario.id, binding: string | null = trialId) =>
      fetch(`${served.url}/runtime/${scenarioId}/sequence-ready`, {
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(binding ? { "x-basalt-trial": binding } : {}),
        },
      });
    assert.equal((await fetch(`${served.url}/runtime/${scenario.id}/sequence-ready`)).status, 401);
    assert.equal((await sequenceReady(scenario.id, null)).status, 400);
    assert.equal((await sequenceReady(scenario.id, `trial-${"f".repeat(24)}`)).status, 400);
    assert.equal((await sequenceReady("unknown")).status, 400);
    assert.deepEqual(await (await sequenceReady()).json(), { ready: false });
    assert.deepEqual(
      await (await sequenceReady(task.evaluator.studio.scenarios[1]!.id)).json(),
      { ready: true },
      "A scenario without rendered acquisition keeps its existing start behavior",
    );
    assert.throws(() => served.markSequenceReady("unknown"), /recording scenario/);
    served.markSequenceReady(scenario.id);
    assert.deepEqual(await (await sequenceReady()).json(), { ready: true });
    const generation = served.resetWorkerReady(scenario.id);
    assert.deepEqual(
      await (await sequenceReady()).json(),
      { ready: false },
      "A fresh attempt cannot reuse the previous recorder's readiness",
    );
    served.markSequenceReady(scenario.id);
    const reports = new Map(
      scenario.reportContexts.map((context) => [context, scenarioReport(scenario, context)]),
    );
    // A client can join after two scheduled steps and start both at the same
    // time. The ordered step IDs, not artificial timestamp increments, preserve sequence.
    reports.get("holder")!.steps[0]!.dueAt = reports.get("holder")!.steps[1]!.dueAt;
    const post = (report: StudioScenarioReport, binding = trialId) =>
      fetch(`${served.url}/runtime/${scenario.id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
          "x-basalt-trial": binding,
        },
        body: JSON.stringify({
          schema: "basalt-evals/scenario-report",
          sessionId: session.id,
          scenarioId: scenario.id,
          report,
        }),
      });

    assert.equal((await post(reports.get("server")!, "trial-" + "f".repeat(24))).status, 400);
    assert.equal((await post(reports.get("server")!)).status, 201);
    assert.equal(completions.length, 0, "One context cannot complete a multiplayer recording");
    const mismatched = structuredClone(reports.get("holder")!);
    mismatched.actors[0]!.userId = 999;
    assert.equal((await post(mismatched)).status, 400);

    // The runner never starts an action before its schedule.
    const early = structuredClone(reports.get("holder")!);
    const press = early.steps.find((step) => step.actedAt !== undefined)!;
    press.actedAt = press.scheduledAt! - 0.001;
    assert.equal((await post(early)).status, 400);
    const unscheduled = structuredClone(reports.get("holder")!);
    delete unscheduled.steps.at(-1)!.scheduledAt;
    assert.equal((await post(unscheduled)).status, 400);

    const concurrent = await Promise.all([
      post(reports.get("holder")!),
      post(reports.get("receiver")!),
    ]);
    assert.deepEqual(
      concurrent.map((response) => response.status),
      [201, 201],
    );
    const receipts = await Promise.all(
      concurrent.map((response) => response.json() as Promise<{ complete: boolean }>),
    );
    assert.ok(receipts.some((receipt) => receipt.complete));
    const duplicate = await post(reports.get("holder")!);
    assert.equal(duplicate.status, 201, "an identical uncertain retry remains idempotent");
    assert.equal(((await duplicate.json()) as { complete: boolean }).complete, true);

    const conflicting = structuredClone(reports.get("holder")!);
    const action = conflicting.steps.find((step) => step.action !== undefined)!.action!;
    action.succeeded = false;
    assert.equal((await post(conflicting)).status, 400);

    const malformed = structuredClone(reports.get("server")!);
    Object.assign(malformed.steps[0]!, { action: null });
    assert.equal((await post(malformed)).status, 400, "absent actions cannot be encoded as null");

    const status = await fetch(`${served.url}/runtime/${scenario.id}`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-basalt-trial": trialId,
      },
    });
    assert.equal(status.status, 200);
    const runtimeStatus = (await status.json()) as {
      complete: boolean;
      runtimeHash: string;
      received: string[];
    };
    assert.equal(runtimeStatus.complete, true);
    assert.match(runtimeStatus.runtimeHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(runtimeStatus.received, scenario.reportContexts);
    const evidence = JSON.parse(
      await readFile(resolve(sessionDirectory, "runtime", scenario.id, "evidence.json"), "utf8"),
    ) as { reports: StudioScenarioReport[] };
    assert.deepEqual(
      evidence.reports.map((report) => report.context),
      scenario.reportContexts,
    );
    assert.equal(completions.length, 1, "Identical report retries cannot repeat completion");
    assert.equal(completions[0]!.trialId, trialId);
    assert.equal(completions[0]!.sessionId, session.id);
    assert.equal(completions[0]!.scenarioId, scenario.id);
    assert.equal(completions[0]!.generation, generation);
    assert.equal(completions[0]!.runtimeHash, runtimeStatus.runtimeHash);
    assert.ok(Number.isFinite(Date.parse(completions[0]!.completedAt)));
    served.resetWorkerReady(task.evaluator.studio.scenarios[1]!.id);
    assert.equal(
      (await post(reports.get("holder")!)).status,
      400,
      "Late reports cannot complete a later native scenario",
    );
    assert.equal(completions.length, 1);
    assert.throws(
      () => served.markSequenceReady(scenario.id, generation),
      /earlier native attempt/,
    );
  } finally {
    if (server) await new Promise<void>((accept) => server?.close(() => accept()));
    await rm(temporary, { recursive: true, force: true });
  }
});

async function availableLoopbackUrl(): Promise<string> {
  const server = createHttpServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
  });
  return `http://127.0.0.1:${address.port}`;
}

function scenarioReport(scenario: StudioScenario, context: string): StudioScenarioReport {
  const actors = [
    { actor: "holder", userId: 101, name: "Holder" },
    { actor: "receiver", userId: 202, name: "Receiver" },
  ];
  // Clock steps keep their offset from the start. Anchored steps follow one second apart.
  const startAt = 1_790_000_000;
  return {
    context,
    startAt,
    actors,
    steps: scenario.steps.map((step, index) => {
      const scheduledAt =
        startAt + ("startMs" in step.at ? step.at.startMs : 1000 * (index + 1)) / 1000;
      const observations = step.observations
        .filter((request) => request.context === context)
        .map(({ fact }): StudioObservation => {
          if (fact.kind === "instance_value")
            return {
              factId: fact.id,
              kind: "instance_value",
              exists: true,
              className: "IntValue",
              value: 0,
            };
          if (fact.kind !== "replication_probe")
            throw new Error("The runtime route fixture expects replication probes or values");
          return {
            factId: fact.id,
            kind: "replication_probe" as const,
            exists: true,
            value: fact.id === "deadline" ? 10 : 101,
            observedFrom: "studio" as const,
          };
        });
      return {
        stepId: step.id,
        outcome: "observed" as const,
        dueAt: scheduledAt,
        anchorObservedAt: scheduledAt,
        scheduledAt,
        ...(step.action.kind !== "wait" && step.action.actor === context
          ? { actedAt: scheduledAt, action: { kind: step.action.kind, succeeded: true } }
          : {}),
        ...(observations.length ? { capturedAt: scheduledAt } : {}),
        observations,
      };
    }),
  };
}

function scenarioEvidence(
  agent: AgentRun,
  collectionPlanHash: string,
  reports: StudioScenarioReport[],
): StudioEvidence {
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: agent.treatmentId,
    candidateHash: agent.candidate.rootHash,
    collectionPlanHash,
    connectorSourceHash: "a".repeat(64),
    connectorArtifactHash: "b".repeat(64),
    place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
    studio: { version: "test", sessionId: "studio-scenario" },
    startedAt: "2026-09-20T00:00:00.000Z",
    endedAt: "2026-09-20T00:00:20.000Z",
    scenarios: [
      {
        scenarioId: "legitimate-pass",
        startedAt: "2026-09-20T00:00:00.000Z",
        endedAt: "2026-09-20T00:00:05.000Z",
        reports,
      },
    ],
    phases: [
      {
        phaseId: "presentation",
        observations: [{ factId: "errors", kind: "diagnostics", messages: [], scriptErrors: [] }],
        captures: [],
      },
    ],
  };
  return {
    schema: "basalt-evals/studio-evidence",
    id: `evidence-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
}

async function fakeAgentRun(workspace: string, treatmentId: string): Promise<AgentRun> {
  const files = await inventoryTree(workspace);
  const body: Omit<AgentRun, "schema" | "id"> = {
    treatmentId,
    startedAt: "2026-09-17T00:00:00.000Z",
    endedAt: "2026-09-17T00:00:01.000Z",
    status: "locally_eligible",
    stopReason: "finished",
    candidate: { rootHash: hashJson(files), projectFile: "default.project.json", files },
    usage: {
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      providerReportedCostUsd: 0,
    },
    trace: [
      { sequence: 1, at: "2026-09-17T00:00:00.000Z", kind: "model_request", data: {} },
      { sequence: 2, at: "2026-09-17T00:00:00.500Z", kind: "model_response", data: {} },
      { sequence: 3, at: "2026-09-17T00:00:01.000Z", kind: "gate", data: {} },
    ],
  };
  return {
    schema: "basalt-evals/agent-run",
    id: `run-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
}

function evidenceFor(agent: AgentRun, collectionPlanHash: string): StudioEvidence {
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: agent.treatmentId,
    candidateHash: agent.candidate.rootHash,
    collectionPlanHash,
    connectorSourceHash: "a".repeat(64),
    connectorArtifactHash: "d".repeat(64),
    place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
    studio: { version: "test", sessionId: "studio-fixture" },
    startedAt: "2026-09-17T00:00:02.000Z",
    endedAt: "2026-09-17T00:00:03.000Z",
    scenarios: [],
    phases: [
      {
        phaseId: "motion",
        observations: [
          { factId: "platform", kind: "instance", exists: true, className: "Part" },
          { factId: "travel", kind: "part_motion", samples: motionSamples(), delta: 20 },
          { factId: "errors", kind: "diagnostics", messages: [], scriptErrors: [] },
        ],
        captures: [
          {
            captureId: "platform-wide",
            file: "capture.png",
            hash: "b".repeat(64),
            bytes: 45,
            mediaType: "image/png",
            width: 1280,
            height: 720,
            sceneText: { complete: true, entries: [] },
          },
        ],
      },
    ],
  };
  return {
    schema: "basalt-evals/studio-evidence",
    id: `evidence-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
}

function engineCriterion(id: string, rule: DeterministicRule): DeterministicCriterion {
  return { id, layer: "engine", statement: `Studio check ${id}`, required: true, rule };
}

function motionSamples() {
  return Array.from({ length: 41 }, (_, i) => ({ elapsedMs: i * 217, x: i / 2, y: 0, z: 0 }));
}

function agentRunId(agent: AgentRun): string {
  const { schema: _schema, id: _id, ...body } = agent;
  return `run-${hashJson(body).slice(0, 20)}`;
}
