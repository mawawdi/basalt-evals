import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertBarrierTrajectory,
  assertEvaluatorSpec,
  assertStudioEvidence,
  hashJson,
  STUDIO_EVIDENCE_SCHEMA,
  type BarrierTrajectory,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import { classifyBarrierTrajectory } from "../packages/graders/src/barrier.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";
import { prepareStudioSession, serveStudioSession } from "../packages/studio-runner/src/index.js";

const root = resolve(process.cwd());
const execFileAsync = promisify(execFile);
// The shared scenario start on the Studio clock, in epoch seconds.
const START_AT = 1_790_000_000;

/** The timing fields of a step that started secondsAfterStart after the shared start. */
function observedAt(secondsAfterStart: number) {
  const scheduledAt = START_AT + secondsAfterStart;
  return {
    outcome: "observed" as const,
    dueAt: scheduledAt,
    anchorObservedAt: START_AT,
    scheduledAt,
  };
}

test("signed barrier trajectories preserve semantic role identities", () => {
  const captured = { ...trajectory("passed"), barrierPath: "role.shutter" };
  assertBarrierTrajectory(captured);
  assert.equal(classifyBarrierTrajectory(captured).outcome, "passed");
  assert.throws(
    () => assertBarrierTrajectory({ ...captured, barrierPath: "role.shutter.extra" }),
    /barrier trajectory path/,
  );
});

function trajectory(kind: "blocked" | "passed" | "stalled"): BarrierTrajectory {
  return {
    barrierPath: "game.Workspace.Gate",
    center: { x: 0, y: 5, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    halfDepth: 1,
    halfWidth: 9,
    halfHeight: 5,
    corridorHalfWidth: 3,
    samples: Array.from({ length: 51 }, (_, index) => ({
      elapsedMs: index * 50,
      x: 0,
      y: 3,
      z:
        kind === "blocked"
          ? 7 - Math.min(index / 10, 1) * 4.5
          : kind === "passed"
            ? 7 - Math.min(index / 30, 1) * 14
            : 7,
      health: 100,
    })),
  };
}

test("barrier classifier requires actual approach and sustained passage", () => {
  assert.equal(classifyBarrierTrajectory(trajectory("blocked")).outcome, "blocked");
  assert.equal(classifyBarrierTrajectory(trajectory("passed")).outcome, "passed");
  assert.equal(classifyBarrierTrajectory(trajectory("stalled")).outcome, "incomplete");
  const dead = trajectory("blocked");
  dead.samples[10]!.health = 0;
  assert.equal(classifyBarrierTrajectory(dead).outcome, "incomplete");
  const short = trajectory("blocked");
  short.samples.splice(-8);
  assert.equal(classifyBarrierTrajectory(short).outcome, "incomplete");
  const slow = trajectory("blocked");
  slow.samples.forEach((sample) => {
    sample.elapsedMs *= 1.2;
  });
  assert.equal(classifyBarrierTrajectory(slow).outcome, "incomplete");
  const jumped = trajectory("passed");
  jumped.samples[18]!.z = -7;
  assert.equal(classifyBarrierTrajectory(jumped).outcome, "incomplete");
  const retreated = trajectory("blocked");
  retreated.samples.slice(-20).forEach((sample, index) => {
    sample.z = 2.5 + (index + 1) * 0.225;
  });
  assert.equal(classifyBarrierTrajectory(retreated).outcome, "incomplete");
});

test("the same probe classifies an orthogonal shutter and the CLI discovers its task", async () => {
  const task = await loadRegisteredTask(root, "tasks/pilot/timed-shutter");
  assertEvaluatorSpec(task.evaluator);
  assert.equal(task.evaluator.studio.clients, 1);
  assert.equal(task.evaluator.visual.length, 0);
  const actions = task.evaluator.studio.scenarios.flatMap((scenario) =>
    scenario.steps.map((step) => step.action),
  );
  assert.equal(actions.filter((action) => action.kind === "probe_barrier").length, 3);
  const xAxis = trajectory("passed");
  xAxis.barrierPath = "game.Workspace.Shutter";
  xAxis.normal = { x: 1, y: 0, z: 0 };
  xAxis.samples.forEach((sample) => {
    sample.x = sample.z;
    sample.z = 0;
  });
  assert.equal(classifyBarrierTrajectory(xAxis).outcome, "passed");
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(root, "dist/packages/cli/src/index.js"), "task", "validate"],
    { cwd: root },
  );
  assert.match(stdout, /cooperative-gate:/);
  assert.match(stdout, /timed-shutter:/);
});

test("the plan bounds barrier paths, durations, actors, and expected outcomes", async () => {
  const task = await loadRegisteredTask(root, "tasks/pilot/cooperative-gate");
  assertEvaluatorSpec(task.evaluator);
  const invalidPath = structuredClone(task.evaluator);
  const action = invalidPath.studio.scenarios[0]!.steps[1]!.action;
  if (action.kind !== "probe_barrier") throw new Error("fixture changed");
  action.barrierPath = "game.Workspace.Gate[1]";
  assert.throws(() => assertEvaluatorSpec(invalidPath), /barrier probe path/);
  const invalidDuration = structuredClone(task.evaluator);
  invalidDuration.studio.scenarios[0]!.durationMs = 2_000;
  assert.throws(() => assertEvaluatorSpec(invalidDuration), /barrier probe exceeds/);
  const invalidRule = structuredClone(task.evaluator);
  const rule = invalidRule.deterministic[0]!.rule;
  if (rule.kind !== "scenario_barrier_passage") throw new Error("fixture changed");
  rule.actor = "beta";
  assert.throws(() => assertEvaluatorSpec(invalidRule), /barrier passage rule reference/);
  const invalidExpected = structuredClone(task.evaluator) as unknown as {
    deterministic: Array<{ rule: { expected: string } }>;
  };
  invalidExpected.deterministic[0]!.rule.expected = "visible";
  assert.throws(() => assertEvaluatorSpec(invalidExpected), /barrier passage rule/);
});

test("a signed-shape trajectory grades only when bound to the saved candidate and plan", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-barrier-test-"));
  try {
    const task = await loadRegisteredTask(root, "tasks/pilot/cooperative-gate");
    const workspace = resolve(directory, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const files = await inventoryTree(workspace);
    const candidate = {
      projectFile: task.publicTask.seed.projectFile,
      files,
      rootHash: hashJson(files),
    };
    const evaluator = structuredClone(task.evaluator);
    evaluator.deterministic = evaluator.deterministic.filter(
      (entry) => entry.id === "initial-barrier-blocks",
    );
    const report = {
      context: "alpha",
      startAt: START_AT,
      actors: [
        { actor: "alpha", userId: 101, name: "Alpha" },
        { actor: "beta", userId: 202, name: "Beta" },
      ],
      steps: [
        { stepId: "initial-state", ...observedAt(0.2), observations: [] },
        {
          stepId: "initial-passage",
          ...observedAt(0.5),
          actedAt: START_AT + 0.5,
          action: { kind: "probe_barrier", succeeded: true, probe: trajectory("blocked") },
          observations: [],
        },
      ],
    };
    const body = {
      treatmentId: "barrier-test",
      candidateHash: candidate.rootHash,
      collectionPlanHash: task.collectionPlanHash,
      connectorSourceHash: "a".repeat(64),
      connectorArtifactHash: "b".repeat(64),
      place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
      studio: { version: "test", sessionId: "studio-barrier-test" },
      startedAt: "2026-09-22T00:00:00.000Z",
      endedAt: "2026-09-22T00:00:10.000Z",
      scenarios: [
        {
          scenarioId: "initial-closed-passage",
          startedAt: "2026-09-22T00:00:00.000Z",
          endedAt: "2026-09-22T00:00:04.000Z",
          reports: [report],
        },
      ],
      phases: [{ phaseId: "gate-waiting", observations: [], captures: [] }],
    };
    const evidence = {
      schema: STUDIO_EVIDENCE_SCHEMA,
      id: `evidence-${hashJson(body).slice(0, 20)}`,
      ...body,
    } as StudioEvidence;
    assertStudioEvidence(evidence);
    const grade = async (value: StudioEvidence) =>
      evaluateDeterministicCriteria({
        workspaceRoot: workspace,
        evaluator,
        candidate,
        treatmentId: body.treatmentId,
        evidence: value,
      });
    const [passage] = await grade(evidence);
    assert.equal(passage!.outcome, "verified");
    assert.deepEqual(passage!.observed, ["blocked"], "The rule records the observed passage");
    const wrongPlan = structuredClone(evidence);
    wrongPlan.collectionPlanHash = "d".repeat(64);
    const { schema: _schema, id: _id, ...wrongBody } = wrongPlan;
    wrongPlan.id = `evidence-${hashJson(wrongBody).slice(0, 20)}`;
    await assert.rejects(() => grade(wrongPlan), /binding mismatch/);
    const malformed = structuredClone(trajectory("blocked")) as unknown as BarrierTrajectory;
    malformed.samples[0]!.elapsedMs = -1;
    assert.throws(() => assertBarrierTrajectory(malformed), /timestamp/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime accepts only the planned barrier path and actor trajectory", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-barrier-route-"));
  let server: Awaited<ReturnType<typeof serveStudioSession>>["server"] | undefined;
  try {
    const portServer = createServer();
    await new Promise<void>((accept) => portServer.listen(0, "127.0.0.1", accept));
    const address = portServer.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((accept) => portServer.close(() => accept()));
    const task = await loadRegisteredTask(root, "tasks/pilot/cooperative-gate");
    const workspace = resolve(directory, "workspace");
    await materializeTaskSeed(root, task, workspace);
    const files = await inventoryTree(workspace);
    const candidate = {
      projectFile: task.publicTask.seed.projectFile,
      files,
      rootHash: hashJson(files),
    };
    const sessionDirectory = resolve(directory, "studio");
    const session = await prepareStudioSession({
      workspaceRoot: workspace,
      outputDirectory: sessionDirectory,
      task,
      candidate,
      treatment: {
        id: "route-probe",
        task: {
          id: task.id,
          publicTaskHash: task.publicTaskHash,
          evaluatorHash: task.evaluatorHash,
          seedHash: task.seedHash,
          collectionPlanHash: task.collectionPlanHash,
        },
        environment: {
          platform: "Roblox Studio",
          studioVersion: "test",
          captureProtocol: "studio-mcp-viewport",
          cameraProtocol: "Unmodified viewport",
        },
      },
      connectorSourceHash: "a".repeat(64),
      connectorArtifactHash: "b".repeat(64),
      connectorUrl: `http://127.0.0.1:${address.port}`,
    });
    const served = await serveStudioSession(sessionDirectory, {
      close() {},
      async check() {},
      async capture() {
        throw new Error("No capture in route test");
      },
    });
    server = served.server;
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    const begun = await fetch(`${served.url}/trial`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: "a".repeat(32), mode: "launch" }),
    });
    assert.equal(begun.status, 201);
    const trialId = ((await begun.json()) as { trialId: string }).trialId;
    const actors = [
      { actor: "alpha", userId: 101, name: "Alpha" },
      { actor: "beta", userId: 202, name: "Beta" },
    ];
    const alpha = {
      context: "alpha",
      startAt: START_AT,
      actors,
      steps: [
        { stepId: "initial-state", ...observedAt(0.2), observations: [] },
        {
          stepId: "initial-passage",
          ...observedAt(0.5),
          actedAt: START_AT + 0.5,
          action: { kind: "probe_barrier", succeeded: true, probe: trajectory("blocked") },
          observations: [],
        },
      ],
    };
    const post = (report: unknown) =>
      fetch(`${served.url}/runtime/initial-closed-passage`, {
        method: "POST",
        headers: { ...headers, "x-basalt-trial": trialId },
        body: JSON.stringify({
          schema: "basalt-evals/scenario-report",
          sessionId: session.id,
          scenarioId: "initial-closed-passage",
          report,
        }),
      });
    const wrongPath = structuredClone(alpha);
    const passage = wrongPath.steps[1]!;
    if (!("action" in passage)) throw new Error("invalid fixture");
    passage.action.probe.barrierPath = "game.Workspace.Other";
    assert.equal((await post(wrongPath)).status, 400);
    const wrongActor = structuredClone(alpha);
    wrongActor.context = "beta";
    assert.equal((await post(wrongActor)).status, 400);
    const serverReport = {
      context: "server",
      startAt: START_AT,
      actors,
      steps: [
        {
          stepId: "initial-state",
          ...observedAt(0.2),
          capturedAt: START_AT + 0.2,
          observations: [
            {
              factId: "open",
              kind: "replication_probe",
              exists: true,
              value: false,
              observedFrom: "studio",
            },
          ],
        },
        { stepId: "initial-passage", ...observedAt(0.5), observations: [] },
      ],
    };
    assert.equal((await post(serverReport)).status, 201);
    assert.equal((await post(alpha)).status, 201);
  } finally {
    if (server) await new Promise<void>((accept) => server?.close(() => accept()));
    await rm(directory, { recursive: true, force: true });
  }
});
