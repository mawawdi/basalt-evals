import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import type { AgentRun } from "../packages/contracts/src/index.js";
import type {
  RunOperationManifest,
  SavedEvalRunQuote,
} from "../packages/contracts/src/execution.js";
import { createLibraryEvaluation } from "../packages/eval-authoring/src/library.js";
import {
  readReadinessRecord,
  stageRecordHashes,
} from "../packages/eval-authoring/src/registration.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { readHoldoutAccess } from "../packages/operator/src/holdout-access.js";
import { knownBuildGate } from "../packages/operator/src/known-build-gate.js";
import { markKnownBuild, prepareKnownBuildGate } from "../packages/operator/src/known-builds.js";
import { RunOperationStore } from "../packages/operator/src/operation.js";
import { evaluationSummary } from "../packages/operator/src/discovery.js";
import { evaluationControls } from "../packages/operator/src/evaluation-detail.js";
import {
  quoteEvalControls,
  runQuotedEvalControls,
} from "../packages/operator/src/prepare-controls.js";
import { previewRecheck } from "../packages/operator/src/recheck.js";
import { quoteSavedRepair } from "../packages/operator/src/repair.js";
import { createReviewer } from "../packages/operator/src/reviewers.js";
import { quoteSavedPublicDevelopment, quoteSavedReplay } from "../packages/operator/src/replay.js";
import { frozenRunStatus } from "../packages/operator/src/run-builder.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import { manifestHash } from "../packages/operator/src/run-manifest.js";
import {
  freezeRegisteredEvalRun,
  quoteRegisteredEvalRun,
} from "../packages/operator/src/run-plan.js";
import { sealRegisteredSubject } from "../packages/operator/src/seal-source.js";
import { quoteSelectionRun } from "../packages/operator/src/selection-run.js";
import { readRegisteredSource } from "../packages/operator/src/sources.js";
import { recordNotReached, stageReach } from "../packages/operator/src/stage-reach.js";
import { freezeStageRun, quoteStageRun } from "../packages/operator/src/stage-run.js";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import {
  BUILDER,
  JUDGE,
  PROMPTS,
  build,
  loggedRequests,
  observeAndCheck,
  stagedDraft,
  stagedEvaluation,
  stagedVersion,
  twoBuiltStages,
} from "./staged-fixture.js";

/*
 * The actions on a saved build of a staged evaluation. The tests share two runs of three stages,
 * where stage 1 and stage 2 have sealed builds: one run without gates, and one run with gates.
 * Each test starts its own runs from these builds.
 */

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A new workspace that the tests delete at the end. */
async function workspace(name: string) {
  const root = await mkdtemp(resolve(tmpdir(), `basalt-staged-${name}-`));
  roots.push(root);
  return root;
}

let built: ReturnType<typeof twoBuiltStages> | null = null;
const twoStagesBuilt = async () =>
  (built ??= twoBuiltStages(await workspace("actions"), { stages: 3 }));

// The gate of stage 1 passes, and the gate of stage 2 never passes.
let gated: ReturnType<typeof twoBuiltStages> | null = null;
const gatedStages = async () =>
  (gated ??= twoBuiltStages(await workspace("gates"), {
    stages: 3,
    gate: true,
    failGate: 2,
    check: true,
  }));

test("a replay of a later stage observes its sealed build alone, in a stage run", async () => {
  const { root, manifest: origin, revisions, second, adapters } = await twoStagesBuilt();
  const saved = await quoteSavedReplay({
    root,
    operationId: origin.id,
    subjectId: second.id,
    passes: 2,
    adapters,
  });
  assert.ok(saved.kind === "stages");
  assert.equal(saved.firstRevisionId, revisions[0]!.id);
  assert.equal(saved.componentQuoteIds.length, 1);
  assert.equal(saved.quote.workload.independentBuilderTrials, 0);
  assert.deepEqual(saved.quote.workload.modelWork, [], "a replay sends no model request");

  const manifest = await freezeStageRun({
    root,
    operationId: "staged-replay",
    quoteId: saved.id,
    ceilingUsd: 1,
    adapters,
  });
  assert.deepEqual(
    manifest.evals.map((evaluation) => evaluation.stage),
    [
      {
        firstRevisionId: revisions[0]!.id,
        index: 2,
        count: 3,
        earlierPrompts: [PROMPTS[0]],
        gateCriterionIds: [],
      },
    ],
    "the run holds only stage 2",
  );
  assert.equal(manifest.subjects.length, 1);
  const [subject] = manifest.subjects;
  assert.equal(subject!.kind, "retained");
  assert.equal(subject!.stageIndex, 2);
  assert.equal(subject!.parentSubjectId, null);
  // The saved source is the sealed build of stage 2, which holds the work of stage 1.
  const { source } = await readRegisteredSource(root, subject!.sourceId!);
  const sealed = await new RepositoryFiles(root).json<AgentRun>(
    `.basalt-evals/eval-operations/${origin.id}/builder/${second.id}/agent-run.json`,
  );
  assert.equal(source.candidate.rootHash, sealed.candidate.rootHash);
  assert.equal(source.provenance.originOperationId, origin.id);

  const cell = manifest.captureCells.find((item) => item.pass === 1)!;
  await sealRegisteredSubject(root, manifest.id, subject!.id);
  await executeFrozenCaptureCell({
    root,
    operationId: manifest.id,
    cellId: cell.id,
    studioAdapter: adapters.studio,
  });
  const status = await frozenRunStatus(root, manifest.id);
  assert.ok(status.completedUnits.includes(`final_capture:${cell.id}`));

  // An extra observation with the public views of stage 2 is a stage run too.
  const extra = await quoteSavedPublicDevelopment({
    root,
    operationId: origin.id,
    subjectId: second.id,
    passes: 1,
    adapters,
  });
  assert.ok(extra.kind === "stages");
  assert.equal(extra.firstRevisionId, revisions[0]!.id);
});

test("a stage run holds consecutive stages, and only its first stage starts from saved sources", async () => {
  const { root, manifest: origin, revisions, second, adapters } = await twoStagesBuilt();
  const saved = await quoteSavedReplay({
    root,
    operationId: origin.id,
    subjectId: second.id,
    passes: 1,
    adapters,
  });
  assert.ok(saved.kind === "stages");
  const files = new RepositoryFiles(root);
  const { selection } = await files.json<SavedEvalRunQuote>(
    `.basalt-evals/eval-run-quotes/${saved.componentQuoteIds[0]}.json`,
  );
  const stage = (index: number) => ({
    ...selection,
    revisionId: revisions[index - 1]!.id,
    sourceIds: [],
  });
  const quote = (selections: (typeof selection)[]) =>
    quoteStageRun({ root, firstRevisionId: revisions[0]!.id, selections, adapters });
  await assert.rejects(
    quote([selection, stage(1)]),
    /consecutive stages of one evaluation, in stage order/u,
  );
  await assert.rejects(quote([stage(1), stage(3)]), /consecutive stages/u);
  // Stage 3 must use the readiness record that the record of stage 2 names.
  await assert.rejects(
    quote([selection, stage(3)]),
    /do not belong to one version of the evaluation/u,
  );
  await assert.rejects(
    quote([stage(2)]),
    /Only the first stage of a stage run starts from saved sources/u,
  );
  await assert.rejects(
    quoteStageRun({ root, firstRevisionId: revisions[1]!.id, selections: [selection], adapters }),
    /An evaluation starts at the revision of its first stage/u,
  );

  // An eval quote of a later stage alone has no stage 1, so its run cannot freeze.
  const alone = await quoteRegisteredEvalRun({ root, selection, adapters });
  await assert.rejects(
    freezeRegisteredEvalRun({
      root,
      operationId: "stage-alone",
      quoteId: alone.id,
      ceilingUsd: 1,
      adapters,
    }),
    /A later stage of an evaluation runs only in a run that names its stage 1/u,
  );
});

test("a repair of a later stage continues through the last stage until a gate fails", async () => {
  const { root, second, ...run } = await gatedStages();

  const saved = await quoteSavedRepair({
    root,
    operationId: run.manifest.id,
    subjectId: second.id,
    modelId: BUILDER,
    gradingModelId: JUDGE,
    attempts: 1,
    passes: 1,
    publicFeedbackId: null,
    adapters: run.adapters,
  });
  assert.ok(saved.kind === "stages");
  assert.equal(saved.firstRevisionId, run.revisions[0]!.id);
  assert.equal(saved.componentQuoteIds.length, 2, "stage 2 and stage 3");
  assert.equal(saved.quote.workload.independentBuilderTrials, 2);
  const manifest = await freezeStageRun({
    root,
    operationId: "staged-repair",
    quoteId: saved.id,
    ceilingUsd: 5,
    adapters: run.adapters,
  });
  assert.deepEqual(
    manifest.evals.map((evaluation) => evaluation.stage.index),
    [2, 3],
  );
  // Stage 3 uses the readiness record that the record of the repaired stage names.
  assert.deepEqual(
    manifest.evals.map((evaluation) => evaluation.validationRecordHash),
    await stageRecordHashes(
      root,
      run.revisions.slice(1),
      run.manifest.evals[1]!.validationRecordHash,
    ),
  );
  const [repair, later] = manifest.subjects as [
    RunOperationManifest["subjects"][0],
    (typeof manifest.subjects)[0],
  ];
  assert.equal(repair.kind, "repair");
  assert.equal(repair.stageIndex, 2);
  assert.equal(repair.parentSubjectId, null);
  const { source } = await readRegisteredSource(root, repair.parentSourceId!);
  const sealed = await new RepositoryFiles(root).json<AgentRun>(
    `.basalt-evals/eval-operations/${run.manifest.id}/builder/${second.id}/agent-run.json`,
  );
  assert.equal(
    source.candidate.rootHash,
    sealed.candidate.rootHash,
    "it repairs the stage 2 build",
  );
  assert.equal(later.kind, "generated");
  assert.equal(later.stageIndex, 3);
  assert.equal(later.parentSubjectId, repair.id, "stage 3 continues the repair build");
  assert.equal(later.publicFeedbackId, null);

  const before = (await loggedRequests(root)).length;
  await build(root, repair.id, run.adapters, manifest.id);
  const [opening] = (await loggedRequests(root))
    .slice(before)
    .filter((request) => request.messages.length === 1);
  assert.ok(
    String(opening!.messages[0]!.content).includes(
      `Prompt of stage 1:\n${PROMPTS[0]}\nThis is stage 2.`,
    ),
    "the repair build sees the earlier prompts",
  );
  let status = await frozenRunStatus(root, manifest.id);
  assert.equal(stageReach(status, later), "waiting", "the gate of stage 2 has no answer yet");

  await observeAndCheck(root, manifest, repair.id, run.adapters);
  status = await frozenRunStatus(root, manifest.id);
  assert.equal(stageReach(status, later), "not_reached");
  const operation = new RunOperationStore(
    root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const sent = (await loggedRequests(root)).length;
  assert.equal(await recordNotReached(operation, status, later), true);
  await assert.rejects(build(root, later.id, run.adapters, manifest.id));
  assert.equal((await loggedRequests(root)).length, sent, "stage 3 sends no model request");
  const spending = await operation.ledger.read();
  assert.ok(spending.entries.length > 0);
  assert.equal(
    spending.entries.some((entry) => entry.stage.includes(later.id)),
    false,
    "stage 3 reserves nothing",
  );
});

test("a recheck of a later stage is not reached when a changed gate fails on the build before it", async () => {
  const { root, manifest, revisions, draft, first, second, adapters } = await gatedStages();
  const recheck = (revisionId: string) =>
    previewRecheck(
      root,
      { operationId: manifest.id, subjectIds: [second.id], revisionId, judge: null },
      adapters,
    );
  const looks = async (revisionId: string) =>
    (await readHoldoutAccess(root, revisionId)).looks.map((look) => [
      look.purpose,
      look.subjectIds,
    ]);
  // This version expects another name in the gate check of stage 1, and in the check of stage 2.
  const closed = await stagedVersion(root, draft, { 1: "Lantern", 2: "Beacon" });
  const preview = await recheck(closed[0]!.id);
  assert.deepEqual(
    [...new Set(preview.cells.map((cell) => [cell.action, cell.reason, cell.after].join(" ")))],
    ["not_reached parent_gate_failed "],
  );
  const capture = manifest.captureCells.find((cell) => cell.treatmentId === first.id)!;
  assert.deepEqual(preview.gates, [
    {
      subjectId: second.id,
      stage: 1,
      parent: { operationId: manifest.id, subjectId: first.id },
      checks: [{ captureId: capture.id, criterionId: "beacon-exists", answer: "not_met" }],
      state: "failed",
      issue: null,
      reason:
        "This version changes the gate of stage 1, and the stage 1 build that this build continues does not pass it. This version never reaches the stage of this build.",
    },
  ]);
  assert.equal(preview.judge, null);
  assert.equal(preview.observation, null, "a build that is not reached gets no paid part");
  // The gate read the withheld observation of the stage 1 build: one look at the holdout of
  // stage 1. The recheck reads no evidence of the stage 2 build, because it is not reached.
  assert.deepEqual(preview.holdoutCaptureIds, [capture.id]);
  assert.deepEqual(await looks(revisions[0]!.id), [["recheck", [first.id]]]);
  assert.deepEqual(await looks(revisions[1]!.id), []);

  // A version that keeps the gate of stage 1 pairs the build with its own stage as usual.
  const open = await stagedVersion(root, draft, { 2: "Beacon" });
  const usual = await recheck(open[0]!.id);
  assert.deepEqual(usual.gates, []);
  assert.deepEqual(
    usual.cells
      .filter((cell) => cell.toCriterionId === "beacon-exists")
      .map((cell) => [cell.action, cell.reason, cell.before, cell.after]),
    [["code_recheck", "criterion_changed", "not_met", "met"]],
  );
  assert.deepEqual(await looks(revisions[1]!.id), [["recheck", [second.id]]]);

  // The target is a version by its stage 1, and its stages must pair with the stages of the run.
  await assert.rejects(
    recheck(open[1]!.id),
    /An evaluation starts at the revision of its first stage/u,
  );
  const shorter = stagedDraft({ stages: 2 });
  await new EvalDefinitionStore(root).writeDraft(shorter);
  const twoStages = await stagedVersion(root, shorter, {});
  await assert.rejects(recheck(twoStages[0]!.id), /This version has another number of stages/u);
});

test("a known build of a later stage checks the same stage of a new version, and a failed earlier gate leaves it incomplete", async () => {
  const { root, manifest, draft, second, adapters } = await gatedStages();
  const library = await createLibraryEvaluation(root, draft.id);
  const reviewer = await createReviewer(root, "Stage reviewer");
  // The check of stage 2 expects another name, so the stage 2 build does not meet it.
  const known = await markKnownBuild(root, {
    evaluationId: library.id,
    operationId: manifest.id,
    subjectId: second.id,
    criterionIds: ["criterion-1"],
    expectation: "not_met",
    reviewerId: reviewer.id,
    reason: "The stage 2 check expects a Lantern, and the build has a Beacon.",
  });
  const gate = async (revisionId: string) =>
    (
      await prepareKnownBuildGate({
        root,
        operationId: "prepare-known-builds",
        revisionId,
        draftId: draft.id,
        studio: adapters.studio,
        signal: new AbortController().signal,
      })
    )?.results.map((result) => [result.knownBuildId, result.status, result.checks, result.reason]);
  // This version expects the Beacon in stage 2, so the known bad build now meets the check.
  const open = await stagedVersion(root, draft, { 2: "Beacon" });
  assert.deepEqual(await gate(open[0]!.id), [
    [known.id, "broken", [{ criterionId: "beacon-exists", method: "code", answer: "met" }], null],
  ]);
  assert.equal((await knownBuildGate(root, open[0]!.id)).state, "blocked");
  // This version also changes the gate of stage 1, and the stage 1 build does not pass it.
  const closed = await stagedVersion(root, draft, { 1: "Lantern", 2: "Beacon" });
  const [[, status, checks, reason]] = (await gate(closed[0]!.id)) as [
    [string, string, unknown[], string],
  ];
  assert.deepEqual([status, checks], ["incomplete", []]);
  assert.match(reason, /changes the gate of stage 1/u);
  assert.equal((await knownBuildGate(root, closed[0]!.id)).state, "blocked");
});

/** A reference test of a staged evaluation, with the control-source requests that it sent. */
async function referenceTest(options: { failGate?: number }) {
  const root = await workspace("reference");
  const { revisions, adapters } = await stagedEvaluation(root, {
    stages: 2,
    gate: true,
    ...options,
  });
  const quote = await quoteEvalControls(root, revisions[0]!.id, JUDGE, adapters);
  const reference = await runQuotedEvalControls({
    root,
    revisionId: revisions[0]!.id,
    quoteId: quote.id,
    operationId: "staged-reference",
    ceilingUsd: 50,
    adapters,
  });
  const controls = (await loggedRequests(root))
    .filter((request) => request.tools?.[0]?.name === "submit_control_source")
    .map((request) => ({
      request,
      content: JSON.parse(String(request.messages[0]!.content)) as Record<string, unknown>,
    }));
  return { root, revisions, quote, reference, controls, adapters };
}

test("a reference test of a staged evaluation starts each later stage from the checked working control of the stage before", async () => {
  const { root, revisions, quote, reference, controls, adapters } = await referenceTest({});
  assert.equal(quote.subjectId, revisions[0]!.id, "one quote covers every stage");
  assert.equal(reference.interrupted, null);
  const [first, second] = reference.stages as [
    (typeof reference.stages)[0],
    (typeof reference.stages)[0],
  ];
  assert.deepEqual(
    [first.reached, first.parentSourceId, first.gate, first.result?.checkStatus],
    [true, null, [], "checked"],
  );
  assert.equal(second.reached, true);
  assert.deepEqual(second.gate, [{ criterionId: "beacon-exists", outcome: "verified" }]);
  assert.equal(second.result?.checkStatus, "checked");
  // The parent is the registered working control of stage 1, and each control of stage 2 starts
  // from it.
  const parent = await readRegisteredSource(root, second.parentSourceId!);
  assert.equal(parent.source.provenance.kind, "control");
  const working = second.result!.preparation!.set!.cases.find((item) => item.kind === "working")!;
  const workspace = await inventoryTree(
    resolve(
      root,
      `.basalt-evals/eval-control-runs/${revisions[1]!.id}/${second.result!.batchId}/${working.id}/workspace`,
    ),
  );
  for (const file of parent.source.candidate.files)
    assert.ok(
      workspace.some((item) => item.path === file.path),
      `the stage 2 control keeps ${file.path}`,
    );
  // Only a control of stage 2 gets the earlier prompts and the starting files.
  const stage = (prompt: string) =>
    controls.filter((item) => item.content.builderPrompt === prompt);
  assert.ok(stage(PROMPTS[0]!).length > 0);
  for (const { request, content } of stage(PROMPTS[0]!)) {
    assert.equal("startingFiles" in content || "earlierPrompts" in content, false);
    assert.equal(request.system!.includes("later stage"), false);
  }
  assert.ok(stage(PROMPTS[1]!).length > 0);
  for (const { request, content } of stage(PROMPTS[1]!)) {
    assert.deepEqual(content.earlierPrompts, [PROMPTS[0]]);
    assert.deepEqual(
      (content.startingFiles as Array<{ path: string }>).map((file) => file.path),
      parent.source.candidate.files
        .map((file) => file.path)
        .filter((path) => path.startsWith("src/") && /\.luau?$/u.test(path)),
    );
    assert.ok(request.system!.includes("This control is for a later stage"));
  }
  // The evaluation shows as checked only when every stage is checked. The checked record of
  // stage 1 names the checked record of stage 2.
  const summary = await evaluationSummary(root, revisions[0]!.id);
  assert.equal(summary?.readiness, "checked");
  assert.equal(summary?.validationRecordHash, reference.validationRecordHash);
  const records = await stageRecordHashes(root, revisions, reference.validationRecordHash!);
  const checks = await Promise.all(
    revisions.map(async (revision, index) => {
      const record = await readReadinessRecord(root, revision.id, records[index]!);
      return [record.validation.status, record.check?.batchId];
    }),
  );
  assert.deepEqual(checks, [
    ["controls_checked", first.result!.batchId],
    ["controls_checked", second.result!.batchId],
  ]);
  // The evaluation page shows the reference controls of each stage.
  assert.deepEqual(
    (await evaluationControls(root, revisions[0]!.id))?.map((check) => check.batchId),
    [first.result!.batchId, second.result!.batchId],
  );
  // A benchmark binds the checked record of each stage.
  const benchmark = await quoteSelectionRun(
    root,
    {
      revisionIds: [revisions[0]!.id],
      builderModelIds: [BUILDER],
      harnessIds: ["thin"],
      repetitions: 1,
      capturePasses: 1,
      gradingModelId: JUDGE,
      judgeSettings: DEFAULT_JUDGE_SETTINGS,
    },
    adapters,
  );
  const files = new RepositoryFiles(root);
  assert.deepEqual(
    await Promise.all(
      benchmark.componentQuoteIds.map(
        async (id) =>
          (await files.json<SavedEvalRunQuote>(`.basalt-evals/eval-run-quotes/${id}.json`))
            .selection.validationRecordHash,
      ),
    ),
    records,
  );
});

test("a reference test of a staged evaluation sends no request for a stage after a failed gate", async () => {
  // The working control of stage 1 never meets its check, so stage 1 is not checked.
  const { root, revisions, reference, controls } = await referenceTest({ failGate: 1 });
  assert.equal(reference.interrupted, null);
  const [first, second] = reference.stages as [
    (typeof reference.stages)[0],
    (typeof reference.stages)[0],
  ];
  assert.equal(first.reached, true);
  assert.notEqual(first.result?.checkStatus, "checked");
  assert.deepEqual(second, {
    revisionId: revisions[1]!.id,
    reached: false,
    parentSourceId: null,
    gate: [],
    result: null,
  });
  assert.ok(controls.length > 0);
  assert.deepEqual(
    controls.filter((item) => item.content.builderPrompt === PROMPTS[1]),
    [],
    "stage 2 sends no control request",
  );
  // A reference test that does not check every stage saves no checked record.
  assert.equal(reference.validationRecordHash, null);
  assert.equal((await evaluationSummary(root, revisions[0]!.id))?.readiness, "ready");
  assert.equal(await evaluationControls(root, revisions[0]!.id), null);
});
