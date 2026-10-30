import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { HoldoutAccess } from "../../contracts/src/comparisons.js";
import type { EvalRunSelection, RunOperationManifest } from "../../contracts/src/execution.js";
import { hashJson, type CriterionResult } from "../../contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS, type JudgeSettings } from "../../contracts/src/judge-settings.js";
import {
  recheckSelection,
  type RecheckAction,
  type RecheckAnswer,
  type RecheckCell,
  type RecheckCodeRecord,
  type RecheckGate,
  type RecheckPreview,
  type RecheckReason,
  type RecheckSelection,
} from "../../contracts/src/recheck.js";
import { hash, identity } from "../../contracts/src/validation.js";
import {
  gateCheckIds,
  publicEvalRevisionView,
  type EvalRevision,
} from "../../eval-authoring/src/compiler.js";
import { pairCriteria } from "../../eval-authoring/src/criterion-pairing.js";
import {
  cellAction,
  cellHashes,
  revisionHashes,
  type RevisionHashes,
} from "../../eval-authoring/src/revision-delta.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { previewAssessment } from "./assessment.js";
import { catalogStageRecords } from "./evaluation-detail.js";
import { recordHoldoutLook } from "./holdout-access.js";
import { assertRegisteredModels, buildName, readModelRegistry } from "./model-registry.js";
import { finishedRecheckAnswers, recheckLaunches, savedAnswers } from "./recheck-results.js";
import { originBuild, registerSavedSubject } from "./replay.js";
import { mapInOrder } from "./concurrency.js";
import { frozenRunStatus } from "./run-builder.js";
import { frozenRunRecords, type FrozenRunReader } from "./run-records.js";
import { manifestHash, planCaptures, subjectEval } from "./run-manifest.js";
import { judgeCriteria } from "./run-plan.js";
import { savedCodeChecks } from "./saved-code-checks.js";
import { quoteSavedBuildRun } from "./stage-run.js";

/*
 * A recheck of saved builds against a revision of their evaluation. The preview classifies each
 * build, observation and criterion with the hash that changed. It runs the code checks now,
 * because they read only saved evidence and cost nothing, and it saves each result immutably.
 * It quotes the judge part and the observation part with the judge settings of the run. Each
 * paid part is its own launch.
 */

const RECHECKS = ".basalt-evals/rechecks";

/** One executable criterion of the run or of the target revision, under its authored criterion. */
interface CriterionRow {
  authoredCriterionId: string;
  fromAuthoredCriterionId: string | null;
  authoredText: string;
  from: string | null;
  to: string | null;
}

/**
 * The executable criteria of the two revisions, paired through their authored criteria. Text
 * pairs first, because a rubric edit can renumber the authored criteria. A row keeps only the
 * executable criteria that the hashes know: code checks and judge checks.
 */
function criterionRows(
  from: EvalRevision,
  to: EvalRevision,
  fromHashes: RevisionHashes,
  toHashes: RevisionHashes,
): CriterionRow[] {
  const pairing = pairCriteria(from, to);
  const text = (revision: EvalRevision, id: string) =>
    revision.authored.criteria.find((criterion) => criterion.id === id)!.text;
  const known = (hashes: RevisionHashes, id: string | null) =>
    id !== null && hashes.criteria[id] ? id : null;
  return [
    ...pairing.pairs.flatMap((pair) =>
      pair.executables.map((executable) => ({
        authoredCriterionId: pair.to.criterionId,
        fromAuthoredCriterionId: pair.from.criterionId,
        authoredText: text(to, pair.to.criterionId),
        from: known(fromHashes, executable.from),
        to: known(toHashes, executable.to),
      })),
    ),
    ...pairing.added.flatMap((side) =>
      side.executableIds.map((id) => ({
        authoredCriterionId: side.criterionId,
        fromAuthoredCriterionId: null,
        authoredText: text(to, side.criterionId),
        from: null,
        to: known(toHashes, id),
      })),
    ),
    ...pairing.removed.flatMap((side) =>
      side.executableIds.map((id) => ({
        authoredCriterionId: side.criterionId,
        fromAuthoredCriterionId: side.criterionId,
        authoredText: text(from, side.criterionId),
        from: known(fromHashes, id),
        to: null,
      })),
    ),
  ].filter((row) => row.from !== null || row.to !== null);
}

/** True when the run planned a check of the criterion on the observation. */
function checkedBy(manifest: RunOperationManifest, captureId: string, criterionId: string) {
  return (
    manifest.gradingCells.some(
      (cell) => cell.captureCellId === captureId && cell.criterionId === criterionId,
    ) ||
    manifest.judgmentBatches.some(
      (batch) => batch.captureCellId === captureId && batch.criterionIds.includes(criterionId),
    )
  );
}

/** The answer of one code check result, or null when the check has no result. */
export function codeAnswer(result: CriterionResult | undefined): RecheckAnswer | null {
  if (!result) return null;
  return result.outcome === "verified"
    ? "met"
    : result.outcome === "rejected"
      ? "not_met"
      : "insufficient";
}

/**
 * The code checks of the target revision on one saved observation, or the reason that they
 * cannot run. The first read saves the results under the identity of the observation and the
 * revision. A later preview reads the saved results, so it does not read the withheld evidence
 * again.
 */
async function codeRecord(
  root: string,
  manifest: RunOperationManifest,
  captureId: string,
  revision: EvalRevision,
): Promise<{ record: RecheckCodeRecord; first: boolean } | { issue: string }> {
  try {
    return await readCodeRecord(root, manifest, captureId, revision);
  } catch (error) {
    return { issue: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}

async function readCodeRecord(
  root: string,
  manifest: RunOperationManifest,
  captureId: string,
  revision: EvalRevision,
): Promise<{ record: RecheckCodeRecord; first: boolean } | { issue: string }> {
  const files = new RepositoryFiles(root);
  const index = `${RECHECKS}/code-index/${hashJson([manifest.id, captureId, revision.id])}.json`;
  const pointer = await files.optional<{ recordId: string }>(index);
  if (pointer) {
    const record = await files.json<RecheckCodeRecord>(
      `${RECHECKS}/code/${hash(pointer.recordId)}.json`,
    );
    const { id, ...body } = record;
    if (id !== pointer.recordId || hashJson(body) !== id)
      throw new Error("A saved code check of a recheck changed");
    return { record, first: false };
  }
  const checked = await savedCodeChecks({
    root,
    operationId: manifest.id,
    captureCellId: captureId,
    revision,
  });
  if (checked.status === "plan_changed")
    return {
      issue:
        "Studio observed this build with a different plan. Observe the build again with the new plan.",
    };
  const body: Omit<RecheckCodeRecord, "id"> = {
    schema: "basalt-evals/recheck-code-checks",
    operationId: manifest.id,
    manifestHash: manifestHash(manifest),
    subjectId: manifest.captureCells.find((cell) => cell.id === captureId)!.treatmentId,
    captureId,
    revisionId: revision.id,
    partition: checked.partition,
    candidateHash: checked.candidateHash,
    evidenceHash: checked.evidenceHash,
    results: checked.results,
  };
  const record = { ...body, id: hashJson(body) };
  await files.writeJsonOnce(`${RECHECKS}/code/${record.id}.json`, record);
  await files.writeJsonOnce(index, { recordId: record.id });
  return { record, first: true };
}

/**
 * The judge settings of the run for the selected builds. A run freezes one setting for all of
 * its judge requests. A run without judge requests uses the settings of every run until a person
 * changes them.
 */
function runJudgeSettings(manifest: RunOperationManifest, subjectIds: string[]): JudgeSettings {
  const batches = manifest.judgmentBatches.filter((batch) =>
    manifest.captureCells.some(
      (cell) => cell.id === batch.captureCellId && subjectIds.includes(cell.treatmentId),
    ),
  );
  if (!batches.length) return DEFAULT_JUDGE_SETTINGS;
  return {
    samples: Math.max(...batches.map((batch) => batch.sample)),
    grouping: batches[0]!.grouping,
  };
}

/**
 * Judge reuse needs every criterion of the request that made the answer to stay unchanged. If
 * one criterion of a saved shared request changes or leaves, the judge answers the other
 * criteria of that request again.
 */
function sharedRequests(cells: RecheckCell[], manifest: RunOperationManifest): void {
  for (const batch of manifest.judgmentBatches) {
    if (batch.grouping !== "shared") continue;
    const members = cells.filter(
      (cell) =>
        cell.captureId === batch.captureCellId &&
        cell.fromCriterionId !== null &&
        batch.criterionIds.includes(cell.fromCriterionId),
    );
    if (members.every((cell) => cell.action === "reuse")) continue;
    for (const cell of members)
      if (cell.action === "reuse") {
        cell.action = "judge_recheck";
        cell.reason = "shared_request_changed";
      }
  }
}

/**
 * Record one look at the holdout for each first read of a withheld observation. A look belongs
 * to the evaluation of the observed build in its own run.
 */
async function recordCodeLooks(
  root: string,
  reads: Array<{ evaluationId: string; record: RecheckCodeRecord }>,
  purpose: "recheck" | "known_build",
): Promise<void> {
  if (!reads.length) return;
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      for (const { evaluationId, record } of reads) {
        const looks = journal.read<HoldoutAccess>("holdout_access", evaluationId)?.looks ?? [];
        if (!looks.some((look) => look.recordId === record.id))
          recordHoldoutLook(journal, evaluationId, {
            at: new Date().toISOString(),
            purpose,
            recordId: record.id,
            operationId: record.operationId,
            subjectIds: [record.subjectId],
            captureIds: [record.captureId],
          });
      }
    });
  } finally {
    journal.close();
  }
}

/**
 * The hashes of the revision of one stage. A build of a later stage holds the work of each
 * earlier stage, so its public content covers the public content of the earlier stages.
 */
function stageHashes(stages: EvalRevision[], revision: EvalRevision): RevisionHashes {
  const hashes = revisionHashes(revision);
  if (revision.stage.index === 1) return hashes;
  return {
    ...hashes,
    publicContentHash: hashJson([
      ...stages
        .slice(0, revision.stage.index - 1)
        .map((stage) => publicEvalRevisionView(stage).publicContentHash),
      hashes.publicContentHash,
    ]),
  };
}

/** The gate checks of a stage and the Studio plan that observes them. */
function gateHash(revision: EvalRevision): string {
  const hashes = revisionHashes(revision);
  return hashJson({
    checks: gateCheckIds(revision).map((id) => [id, hashes.criteria[id]]),
    plan: hashes.studioPlanHash,
  });
}

interface RunBuild {
  manifest: RunOperationManifest;
  subjectId: string;
}

/**
 * The build of the stage before a build, in its own run. A build that starts from a saved build
 * of its own stage, as a replay or a repair, has the parent of that saved build. Null when the
 * saved source names no completed build of a run.
 */
async function stageParent(root: string, build: RunBuild): Promise<RunBuild | null> {
  const subject = build.manifest.subjects.find((item) => item.id === build.subjectId)!;
  if (subject.parentSubjectId)
    return { manifest: build.manifest, subjectId: subject.parentSubjectId };
  const sourceId = subject.sourceId ?? subject.parentSourceId;
  const origin = sourceId ? await originBuild(root, sourceId) : null;
  if (!origin || subjectEval(origin.manifest, origin.subjectId).stage.index !== subject.stageIndex)
    return null;
  return stageParent(root, origin);
}

/**
 * The gates of the earlier stages of one build in the target version. The build exists because
 * each build before it passed the gate of its stage. The target version keeps the answer of a
 * gate that it does not change. The code checks of a changed gate run again on the saved
 * observations with the private tests of the build of that stage. The first gate that fails or
 * that the saved observations cannot decide ends the walk, because no later stage starts.
 */
async function earlierGates(input: {
  root: string;
  build: RunBuild;
  fromStages: EvalRevision[];
  toStages: EvalRevision[];
  reads: Array<{ evaluationId: string; record: RecheckCodeRecord }>;
  records: RecheckCodeRecord[];
}): Promise<RecheckGate[]> {
  const store = new EvalDefinitionStore(input.root);
  const gates: RecheckGate[] = [];
  let build: RunBuild | null = input.build;
  for (let stage = subjectEval(build.manifest, build.subjectId).stage.index - 1; stage; stage--) {
    build = build && (await stageParent(input.root, build));
    const to = input.toStages[stage - 1]!;
    if (gateHash(input.fromStages[stage - 1]!) === gateHash(to)) continue;
    const gate: RecheckGate = {
      subjectId: input.build.subjectId,
      stage,
      parent: build && { operationId: build.manifest.id, subjectId: build.subjectId },
      checks: [],
      state: "passed",
      issue: null,
      reason: null,
    };
    gates.push(gate);
    const undecided = (issue: string) => {
      gate.state = "undecided";
      gate.issue = issue.slice(0, 500);
      gate.reason = `This version changes the gate of stage ${stage}, and the saved observations cannot decide it. ${gate.issue}`;
    };
    if (!build) {
      undecided(`Basalt cannot find the build of stage ${stage} that this build continues.`);
      break;
    }
    const parent: RunBuild = build;
    const evaluationId = subjectEval(parent.manifest, parent.subjectId).id;
    const captures = planCaptures(
      parent.manifest,
      parent.subjectId,
      (await store.readRevision(evaluationId)).privateEvaluator.studio,
    );
    if (!captures.length)
      undecided(`The build of stage ${stage} has no observation with the private tests.`);
    for (const capture of captures) {
      const checked = await codeRecord(input.root, parent.manifest, capture.id, to);
      if ("issue" in checked) {
        undecided(checked.issue);
        break;
      }
      input.records.push(checked.record);
      if (checked.first && checked.record.partition === "withheld")
        input.reads.push({ evaluationId, record: checked.record });
      for (const criterionId of gateCheckIds(to))
        gate.checks.push({
          captureId: capture.id,
          criterionId,
          answer:
            codeAnswer(
              checked.record.results.find((result) => result.criterionId === criterionId),
            ) ?? "insufficient",
        });
    }
    if (gate.state === "undecided") break;
    if (gate.checks.some((check) => check.answer !== "met")) {
      gate.state = "failed";
      gate.reason = `This version changes the gate of stage ${stage}, and the stage ${stage} build that this build continues does not pass it. This version never reaches the stage of this build.`;
      break;
    }
  }
  return gates;
}

/**
 * Classify the saved builds of a run against a target revision, and run the free code checks.
 * The first read of a withheld observation records one look at the holdout with the purpose of
 * the caller. The classification starts no paid work.
 */
export async function classifyRecheck(
  root: string,
  selection: RecheckSelection,
  purpose: "recheck" | "known_build",
) {
  const source = await frozenRunStatus(root, selection.operationId);
  const manifest = source.manifest;
  const origin = subjectEval(manifest, selection.subjectIds[0]!);
  const sourceRevisionId = origin.id;
  if (selection.subjectIds.some((id) => subjectEval(manifest, id).id !== sourceRevisionId))
    throw new Error(
      "The selected builds belong to different evaluations. Choose builds of one evaluation.",
    );
  const store = new EvalDefinitionStore(root);
  const [from, fromStages, toStages] = await Promise.all([
    store.readExecutableRevision(sourceRevisionId),
    store.readStageRevisions(origin.stage.firstRevisionId),
    store.readStageRevisions(selection.revisionId, true),
  ]);
  if (toStages.length !== origin.stage.count)
    throw new Error(
      "This version has another number of stages, so its stages do not pair with the stages of these builds. Run a new benchmark of this version.",
    );
  // A build of a later stage pairs with the same stage of the target version.
  const to = toStages[origin.stage.index - 1]!;
  const fromHashes = stageHashes(fromStages, from),
    toHashes = stageHashes(toStages, to);
  const rows = criterionRows(from, to, fromHashes, toHashes);
  const answers = savedAnswers(manifest, source.criterionOutcomes);
  const judgeSettings = runJudgeSettings(manifest, selection.subjectIds);
  const cells: RecheckCell[] = [];
  for (const subjectId of selection.subjectIds) {
    const captures = planCaptures(manifest, subjectId, from.privateEvaluator.studio);
    if (!captures.length)
      throw new Error(
        "A selected build has no observation with the private tests. Choose builds of a benchmark.",
      );
    for (const capture of captures) {
      const batches = manifest.judgmentBatches.filter(
        (batch) => batch.captureCellId === capture.id,
      );
      // The recheck judges with the samples and the grouping of the run, so only the model and
      // the presentation can change the judge.
      const judge = selection.judge;
      const judgeChanged =
        judge !== null &&
        batches.some(
          (batch) =>
            batch.configuration.modelId !== judge.modelId ||
            batch.presentation !== judge.presentation,
        );
      for (const row of rows) {
        const decision = cellAction(
          cellHashes(fromHashes, row.from),
          cellHashes(toHashes, row.to),
          judgeChanged,
        );
        let action = decision.action,
          reason: RecheckReason = decision.reason;
        if (action === "reuse" && !checkedBy(manifest, capture.id, row.from!)) {
          action = toHashes.criteria[row.to!]!.method === "code" ? "code_recheck" : "judge_recheck";
          reason = "not_checked";
        }
        cells.push({
          subjectId,
          captureId: capture.id,
          authoredCriterionId: row.authoredCriterionId,
          fromAuthoredCriterionId: row.fromAuthoredCriterionId,
          authoredText: row.authoredText,
          fromCriterionId: row.from,
          toCriterionId: row.to,
          action,
          reason,
          before: row.from ? (answers.get(`${capture.id}:${row.from}`) ?? null) : null,
          after: null,
          issue: null,
        });
      }
    }
  }
  // A changed gate of an earlier stage can leave the stage of a build unreached. The gates run
  // before the code checks of the builds, so a build that is not reached reads no evidence.
  const reads: Array<{ evaluationId: string; record: RecheckCodeRecord }> = [];
  const gateRecords: RecheckCodeRecord[] = [];
  const gates: RecheckGate[] = [];
  if (fromHashes.publicContentHash === toHashes.publicContentHash)
    for (const subjectId of selection.subjectIds) {
      const own = await earlierGates({
        root,
        build: { manifest, subjectId },
        fromStages,
        toStages,
        reads,
        records: gateRecords,
      });
      gates.push(...own);
      const ended = own.find((gate) => gate.state !== "passed");
      if (!ended) continue;
      const [action, reason]: [RecheckAction, RecheckReason] =
        ended.state === "failed"
          ? ["not_reached", "parent_gate_failed"]
          : ["new_build", "parent_gate_changed"];
      for (const cell of cells)
        if (cell.subjectId === subjectId) Object.assign(cell, { action, reason, after: null });
    }
  sharedRequests(cells, manifest);
  for (const cell of cells) if (cell.action === "reuse") cell.after = cell.before;
  // The code checks run now on the saved evidence. A failed read stays visible on its cells.
  const codeRecords: RecheckCodeRecord[] = [...gateRecords];
  for (const captureId of [
    ...new Set(
      cells.filter((cell) => cell.action === "code_recheck").map((cell) => cell.captureId),
    ),
  ]) {
    const own = cells.filter(
      (cell) => cell.captureId === captureId && cell.action === "code_recheck",
    );
    const checked = await codeRecord(root, manifest, captureId, to);
    if ("issue" in checked) {
      for (const cell of own) cell.issue = checked.issue;
      continue;
    }
    codeRecords.push(checked.record);
    if (checked.first && checked.record.partition === "withheld")
      reads.push({ evaluationId: sourceRevisionId, record: checked.record });
    for (const cell of own)
      cell.after = codeAnswer(
        checked.record.results.find((result) => result.criterionId === cell.toCriterionId),
      );
  }
  await recordCodeLooks(root, reads, purpose);
  return {
    manifest,
    sourceRevisionId,
    judgeSettings,
    to,
    toHashes,
    cells,
    gates,
    codeRecords,
  };
}

/**
 * The preview of a recheck. It classifies the builds, runs the free code checks and quotes the
 * paid parts. It starts no paid work.
 */
export async function previewRecheck(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<RecheckPreview> {
  const selection = recheckSelection(value);
  if (selection.judge)
    assertRegisteredModels(await readModelRegistry(root), [selection.judge.modelId]);
  const { manifest, sourceRevisionId, judgeSettings, to, cells, gates, codeRecords } =
    await classifyRecheck(root, selection, "recheck");
  // The answers of finished paid parts complete the other cells.
  const journal = await OperationJournal.open(root);
  let finished: Awaited<ReturnType<typeof finishedRecheckAnswers>>;
  try {
    finished = await finishedRecheckAnswers(
      root,
      journal,
      recheckLaunches(journal, selection.revisionId, manifest.id),
    );
  } finally {
    journal.close();
  }
  for (const cell of cells) {
    if (cell.toCriterionId === null) continue;
    const latest = finished.filter(
      (answer) =>
        answer.subjectId === cell.subjectId &&
        answer.criterionId === cell.toCriterionId &&
        ((cell.action === "judge_recheck" &&
          answer.part === "judge" &&
          answer.captureId === cell.captureId) ||
          (cell.action === "new_observation" && answer.part === "observation")),
    );
    if (latest.length) cell.after = latest.at(-1)!.answer;
  }
  const unavailable: RecheckPreview["unavailable"] = [];
  const rebuilt = new Set(
    cells.filter((cell) => cell.action === "new_build").map((cell) => cell.reason),
  );
  if (rebuilt.size)
    unavailable.push({
      part: "build",
      reason: [
        ...(rebuilt.has("public_content_changed")
          ? ["The prompt or the starting files changed, so these builds answer a different task."]
          : []),
        ...(rebuilt.has("parent_gate_changed")
          ? ["A gate of an earlier stage changed, and the saved observations can’t decide it."]
          : []),
        "Run a new benchmark for the new version.",
      ].join(" "),
    });
  // The judge part checks every saved observation of the builds that need it, with the judge
  // settings of the run.
  const judged = cells.filter((cell) => cell.action === "judge_recheck");
  let judge: RecheckPreview["judge"] = null;
  if (judged.length && !selection.judge)
    unavailable.push({
      part: "judge",
      reason: "Choose a judge to check the judge criteria that need a new answer.",
    });
  else if (judged.length)
    try {
      const criterionIds = new Set(judged.map((cell) => cell.toCriterionId!));
      judge = await previewAssessment(
        root,
        {
          operationId: manifest.id,
          revisionId: to.id,
          subjectIds: selection.subjectIds.filter((id) =>
            judged.some((cell) => cell.subjectId === id),
          ),
          modelId: selection.judge!.modelId,
          presentation: selection.judge!.presentation,
          conditions: ["original"],
          sensitivity: null,
        },
        adapters,
        {
          criterionIds: judgeCriteria(to)
            .map((criterion) => criterion.id)
            .filter((id) => criterionIds.has(id)),
          judgeSettings,
        },
      );
    } catch (error) {
      unavailable.push({
        part: "judge",
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  const observed = cells.filter((cell) => cell.action === "new_observation");
  let observation: RecheckPreview["observation"] = null;
  if (observed.length)
    try {
      const subjectIds = selection.subjectIds.filter((id) =>
        observed.some((cell) => cell.subjectId === id),
      );
      const sourceIds: string[] = [];
      for (const subjectId of subjectIds)
        sourceIds.push(
          (await registerSavedSubject({ root, operationId: manifest.id, subjectId })).saved.id,
        );
      const chain = await catalogStageRecords(root, selection.revisionId);
      if (!chain)
        throw new Error(
          "This version of the evaluation is not ready to run. Complete its preparation first.",
        );
      const judgeModel = selection.judge && judgeCriteria(to).length ? selection.judge : null;
      // The new observation repeats the number of observations that the run made of a build.
      const passes = Math.min(
        3,
        Math.max(
          ...subjectIds.map(
            (id) =>
              new Set(
                observed.filter((cell) => cell.subjectId === id).map((cell) => cell.captureId),
              ).size,
          ),
        ),
      );
      const replay: EvalRunSelection = {
        captureScope: "final",
        publicFeedbackId: null,
        sourceIds,
        parentSourceId: null,
        gradingMode: judgeModel ? "all" : "code",
        continuingOperationId: null,
        revisionId: to.id,
        validationRecordHash: chain.records[to.stage.index - 1]!,
        builderModelIds: [],
        gradingModelId: judgeModel?.modelId ?? null,
        judgeSettings,
        harnessIds: [],
        repetitions: 0,
        nativeCaptureRepetitions: passes,
      };
      observation = await quoteSavedBuildRun({
        root,
        adapters,
        stage: { firstRevisionId: selection.revisionId, count: to.stage.count },
        selections: [replay],
      });
    } catch (error) {
      unavailable.push({
        part: "observation",
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  const body: Omit<RecheckPreview, "id"> = {
    schema: "basalt-evals/recheck-preview",
    selection,
    sourceRevisionId,
    judgeSettings,
    title: to.publicTask.title,
    cells,
    gates,
    codeRecordIds: codeRecords.map((record) => record.id),
    judge,
    observation,
    unavailable,
    holdoutCaptureIds: codeRecords
      .filter((record) => record.partition === "withheld")
      .map((record) => record.captureId),
  };
  const preview = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJsonOnce(`${RECHECKS}/previews/${preview.id}.json`, preview);
  return preview;
}

/**
 * The runs among the given runs that hold saved builds of an evaluation with the given title,
 * with each finished build and its evaluation. A recheck can select these builds. Other runs, for
 * example reassessments, have no saved builds and are left out.
 */
export async function savedBuildRuns(
  root: string,
  operationIds: string[],
  title: string,
  runRecords: FrozenRunReader = frozenRunRecords(root),
) {
  const files = new RepositoryFiles(root);
  const store = new EvalDefinitionStore(root);
  const titles = new Map<string, Promise<string>>();
  const titleOf = (revisionId: string) => {
    if (!titles.has(revisionId))
      titles.set(
        revisionId,
        store.readRevision(revisionId).then((revision) => revision.publicTask.title),
      );
    return titles.get(revisionId)!;
  };
  type SavedBuildRun = {
    operationId: string;
    /**
     * `modelId` is null for a saved build without a builder model. `stage` is the stage of the
     * evaluation of the build, from 1.
     */
    builds: Array<{
      id: string;
      title: string;
      modelId: string | null;
      revisionId: string;
      stage: number;
    }>;
  };
  // The runs are independent, so Basalt reads them at the same time, in the order of the runs.
  const runs = await mapInOrder(operationIds, 8, async (operationId) => {
    const manifest = await files.optional<RunOperationManifest>(
      `.basalt-evals/eval-operations/${identity(operationId, "run identity")}/manifest.json`,
    );
    if (!manifest || manifest.protocol) return null;
    const { status } = await runRecords(operationId);
    const builds = manifest.subjects
      .filter(
        (subject) =>
          status.completedUnits.includes(
            `${subject.sourceId ? "seal" : "builder"}:${subject.id}`,
          ) &&
          manifest.captureCells.some(
            (cell) =>
              cell.treatmentId === subject.id &&
              status.completedUnits.includes(`final_capture:${cell.id}`),
          ),
      )
      .map((subject) => ({
        id: subject.id,
        title: buildName(manifest, subject.id),
        modelId: subject.builder?.model.id ?? null,
        revisionId: subjectEval(manifest, subject.id).id,
        stage: subject.stageIndex,
      }));
    const kept = [];
    for (const build of builds) if ((await titleOf(build.revisionId)) === title) kept.push(build);
    return kept.length ? { operationId, builds: kept } : null;
  });
  return runs.filter((run): run is SavedBuildRun => run !== null);
}
