import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import type { JourneyProgress } from "../packages/contracts/src/console.js";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import { builderPrompt } from "../packages/agent-runtime/src/index.js";
import { workloadCeiling, type RunQuote } from "../packages/model-client/src/quote.js";
import { notReachedSummary } from "../packages/operator/src/catalog-projection.js";
import { projectJourney } from "../packages/operator/src/journey-progress.js";
import {
  RunOperationStore,
  allPlannedWorkDone,
  operationUnitSummary,
} from "../packages/operator/src/operation.js";
import { frozenRunStatus } from "../packages/operator/src/run-builder.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import { executeFrozenDeterministicGradingCell } from "../packages/operator/src/run-grade.js";
import { manifestHash } from "../packages/operator/src/run-manifest.js";
import { dispatchableUnits } from "../packages/operator/src/run-scheduler.js";
import { recordNotReached, stageReach } from "../packages/operator/src/stage-reach.js";
import { testHarness } from "./builder-fixture.js";
import { fixturePublic } from "./shared-api-fixture.js";
import { MARKER, PROMPTS, build, loggedRequests, stagedRun } from "./staged-fixture.js";

const idle = { running: new Set<string>(), unownedPending: false };

const dispatchable = (status: RunOperationStatus) =>
  dispatchableUnits(status, idle)
    .filter((unit) => unit.stage === "builder")
    .map((unit) => unit.unitId);

/**
 * Two tests read one run of two stages. Each real build takes about one second, so the run
 * builds each stage one time. It keeps the state before each build for the first test.
 */
async function buildTwoStages() {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-staged-build-"));
  roots.push(root);
  const run = await stagedRun(root, { stages: 2 });
  const [first, second] = run.subjects as [(typeof run.subjects)[0], (typeof run.subjects)[0]];
  const initial = await frozenRunStatus(root, run.manifest.id);
  const early = await build(root, second.id, run.adapters).then(
    () => null,
    (error: unknown) => error,
  );
  await build(root, first.id, run.adapters);
  const between = await frozenRunStatus(root, run.manifest.id);
  await build(root, second.id, run.adapters);
  return { root, ...run, first, second, initial, early, between };
}
const roots: string[] = [];
let twoStages: ReturnType<typeof buildTwoStages> | null = null;
const twoStageRun = () => (twoStages ??= buildTwoStages());
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("a later stage starts only after its parent completed, from the parent's sealed source", async () => {
  const { root, manifest, first, second, initial, early, between } = await twoStageRun();
  assert.equal(first.stageIndex, 1);
  assert.equal(first.parentSubjectId, null);
  assert.equal(second.stageIndex, 2);
  assert.equal(second.parentSubjectId, first.id);
  assert.deepEqual(manifest.evals[1]!.stage.earlierPrompts, [PROMPTS[0]]);

  assert.equal(stageReach(initial, second), "waiting");
  assert.deepEqual(dispatchable(initial), [first.id], "only stage 1 can start");
  assert.match(String(early), /needs the completed build of the stage before it/);
  assert.equal(stageReach(between, second), "reached");
  assert.deepEqual(dispatchable(between), [second.id]);

  const sealed = (subject: string) =>
    resolve(root, `.basalt-evals/eval-operations/${manifest.id}/builder/${subject}/candidate`);
  // The synthetic builder writes a new marker. It repairs a marker that it finds.
  assert.equal(
    await readFile(resolve(sealed(first.id), MARKER), "utf8"),
    "-- synthetic builder marker\n",
  );
  assert.equal(
    await readFile(resolve(sealed(second.id), MARKER), "utf8"),
    "-- synthetic repaired marker\n",
    "stage 2 found the marker of the sealed stage 1 build in its workspace",
  );
  const parentFiles = await inventoryTree(sealed(first.id));
  const childFiles = await inventoryTree(sealed(second.id));
  assert.deepEqual(
    childFiles.filter((file) => file.path !== MARKER),
    parentFiles.filter((file) => file.path !== MARKER),
    "stage 2 kept every other file of the parent build",
  );
});

test("a failed authored gate records later stages as not reached", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-staged-gate-"));
  try {
    const { manifest, operation, subjects, adapters } = await stagedRun(root, {
      stages: 3,
      gate: true,
      failGate: 1,
    });
    const [first, second, third] = subjects as Array<(typeof subjects)[0]>;
    assert.deepEqual(manifest.evals[0]!.stage.gateCriterionIds, ["beacon-exists"]);
    await build(root, first!.id, adapters);
    let status = await frozenRunStatus(root, manifest.id);
    assert.equal(stageReach(status, second!), "waiting", "the gate check has no result yet");
    assert.deepEqual(dispatchable(status), []);

    const capture = manifest.captureCells.find((cell) => cell.treatmentId === first!.id)!;
    await executeFrozenCaptureCell({
      root,
      operationId: manifest.id,
      cellId: capture.id,
      studioAdapter: adapters.studio,
    });
    const gate = manifest.gradingCells.find((cell) => cell.captureCellId === capture.id)!;
    await executeFrozenDeterministicGradingCell({
      root,
      operationId: manifest.id,
      cellId: gate.id,
    });
    status = await frozenRunStatus(root, manifest.id);
    assert.equal(
      status.criterionOutcomes.find((item) => item.cellId === gate.id)?.outcome,
      "rejected",
    );
    assert.equal(stageReach(status, second!), "not_reached");
    assert.deepEqual(dispatchable(status), [second!.id], "the run records the build at once");

    // The driver records each later build as not reached, and starts no model work for it.
    const before = (await loggedRequests(root)).length;
    assert.equal(await recordNotReached(operation, status, second!), true);
    status = await frozenRunStatus(root, manifest.id);
    assert.equal(stageReach(status, third!), "not_reached", "a stage after it is not reached");
    assert.equal(await recordNotReached(operation, status, third!), true);
    assert.equal((await loggedRequests(root)).length, before);
    await assert.rejects(build(root, second!.id, adapters));

    status = await frozenRunStatus(root, manifest.id);
    const units = operationUnitSummary(status);
    assert.deepEqual(
      { ...units.builder },
      {
        intended: 3,
        attempted: 1,
        completed: 1,
        failed: 0,
        incomplete: 0,
        notReached: 2,
        unattempted: 0,
      },
      "not reached counts apart from failed and unattempted builds",
    );
    assert.equal(units.final_capture.notReached, 2);
    assert.equal(units.grading.notReached, 2);
    assert.equal(units.judgment.notReached, 2);
    // The report counts a build that the run did not reach as done, not as unfinished work.
    const done = (unit: (typeof units)["builder"]) => ({
      ...unit,
      completed: unit.intended - unit.notReached,
    });
    const finished = {
      builder: done(units.builder),
      final_capture: done(units.final_capture),
      grading: done(units.grading),
      judgment: done(units.judgment),
    };
    assert.equal(allPlannedWorkDone(finished), true);
    assert.equal(
      allPlannedWorkDone({ ...finished, builder: { ...finished.builder, completed: 0 } }),
      false,
    );

    // A build that the run did not reach names the build before it and the gate check that failed.
    assert.deepEqual(
      [second!, third!].map((subject) => {
        const summary = notReachedSummary(status, subject)!;
        return { ...summary, parentTitle: summary.parentTitle.split(" · ").at(-1) };
      }),
      [
        {
          parentCandidateId: first!.id,
          parentTitle: "Build 1",
          parentStage: 1,
          failedGateChecks: [{ cellId: gate.id, pass: capture.pass }],
        },
        {
          parentCandidateId: second!.id,
          parentTitle: "Build 2",
          parentStage: 2,
          failedGateChecks: [],
        },
      ],
    );

    // Progress counts the builds that the run did not reach apart and drops their observations.
    const journal = await OperationJournal.open(root);
    try {
      projectJourney(journal, manifest.id, null, status, null);
      const progress = journal.read<JourneyProgress>("journey_progress", manifest.id)!;
      assert.equal(progress.notReachedCandidates, 2);
      assert.equal(
        progress.plannedCaptures,
        manifest.captureCells.filter((cell) => cell.treatmentId === first!.id).length,
      );
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each stage starts a fresh conversation with its own prompt and a list of the earlier prompts", async () => {
  const harness = testHarness();
  const task = { ...fixturePublic.publicTask, prompt: PROMPTS[2]! };
  const staged = builderPrompt(task, harness, undefined, PROMPTS.slice(0, 2));
  assert.ok(
    staged.startsWith(
      "This build continues your build of the earlier stages of this task. The workspace already holds that build.\n" +
        `Prompt of stage 1:\n${PROMPTS[0]}\n` +
        `Prompt of stage 2:\n${PROMPTS[1]}\n` +
        "This is stage 3.\n",
    ),
  );
  assert.ok(staged.includes(PROMPTS[2]!));
  // Stage 1 and an evaluation without stages get the same prompt as before.
  assert.equal(builderPrompt(task, harness).includes("Prompt of stage"), false);

  const { root } = await twoStageRun();
  // The first request of each build has one user message: the build starts a new conversation.
  const openings = (await loggedRequests(root)).filter(
    (request) => !request.messages.some((message) => message.role !== "user"),
  );
  assert.equal(openings.length, 2);
  const [first, second] = openings.map((request) => {
    assert.equal(request.messages.length, 1);
    return String(request.messages[0]!.content);
  }) as [string, string];
  assert.equal(first.includes("Prompt of stage"), false);
  assert.ok(first.includes(PROMPTS[0]!));
  assert.ok(second.includes(`Prompt of stage 1:\n${PROMPTS[0]}\nThis is stage 2.`));
  assert.ok(second.includes(PROMPTS[1]!));
  // The builder never sees the private criteria of any stage.
  for (const text of [first, second])
    for (const criterion of ["A Beacon object exists", "The Beacon looks blue"])
      assert.equal(text.includes(criterion), false);
});

test("the preview quotes every stage within one spending limit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-staged-quote-"));
  try {
    const { saved, manifest, revisions } = await stagedRun(root, { stages: 3 });
    const files = new RepositoryFiles(root);
    const components = await Promise.all(
      saved.componentQuoteIds.map((id) =>
        files.json<{ quote: RunQuote; selection: { revisionId: string } }>(
          `.basalt-evals/eval-run-quotes/${id}.json`,
        ),
      ),
    );
    assert.deepEqual(
      components.map((component) => component.selection.revisionId),
      revisions.map((revision) => revision.id),
      "one component for each stage, in stage order",
    );
    assert.equal(saved.quote.workload.independentBuilderTrials, 3);
    const builder = (quote: RunQuote) =>
      quote.workload.modelWork.filter((work) => work.stage === "builder");
    assert.deepEqual(
      builder(saved.quote),
      components.flatMap((component) => builder(component.quote)),
    );
    // A later builder request also carries the earlier prompts, so its input bound is larger.
    const [one, two] = components.map((component) => builder(component.quote)[0]!);
    assert.ok(two!.upper.inputTokens > one!.upper.inputTokens);
    const total = components.reduce((sum, component) => sum + workloadCeiling(component.quote), 0);
    assert.ok(Math.abs(workloadCeiling(saved.quote) - total) < 1e-9);
    // One run holds every stage, and every request reserves against its one spending limit.
    assert.equal(manifest.ceilingUsd, 5);
    assert.equal(manifest.workloadCeilingUsd, workloadCeiling(saved.quote));
    const spending = await new RunOperationStore(
      root,
      manifest.id,
      manifestHash(manifest),
      manifest.inputHash,
    ).ledger.read();
    assert.deepEqual(spending.authorizations, [{ quoteHash: manifest.quoteHash, ceilingUsd: 5 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
