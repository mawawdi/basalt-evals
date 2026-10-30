import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { resolveExecutionFailures } from "../../artifact-store/src/failures.js";
import { RecordRepository } from "../../artifact-store/src/records.js";
import { hashJson, type StudioEvidence } from "../../contracts/src/index.js";
import {
  decodeAssessmentProgress,
  type AssessmentProgress,
} from "../../contracts/src/assessments.js";
import type { HoldoutLook } from "../../contracts/src/comparisons.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";
import {
  COMPARISON_ORDERS,
  EXEMPLAR_COMPARISON_STREAM,
  exemplarVerdict,
  type ExemplarChoice,
  type ExemplarComparisonRunPlan,
  type ExemplarComparisonPreview,
  type ExemplarComparisonReport,
  type ExemplarComparisonResult,
  type ExemplarComparisonUnit,
  type FrozenBuildEvidence,
  type PairOutcome,
} from "../../contracts/src/exemplars.js";
import { fields, hash, identity, launchIdentity, money } from "../../contracts/src/validation.js";
import type { ExecutableCriterion } from "../../eval-authoring/src/criterion-material.js";
import {
  buildComparisonRequest,
  exemplarComparisonGaps,
} from "../../eval-authoring/src/exemplar-comparison.js";
import { scoringConfiguration, scoringCriteria } from "../../eval-authoring/src/scoring.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { ExemplarComparisonRecord } from "../../experiments/src/exemplar-comparison.js";
import { runExemplarComparison } from "../../agent-runtime/src/exemplar-comparison.js";
import { modelTreatmentIdentity, type ModelSnapshot } from "../../model-client/src/catalog.js";
import {
  DurableSpendLedger,
  SpendingCeilingError,
  spendingProjection,
} from "../../model-client/src/ledger.js";
import { createRunQuote, type QuotedModelWork } from "../../model-client/src/quote.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import { retainedResponseClient } from "../../model-client/src/recovery.js";
import { imageDimensions } from "../../model-client/src/request-workload.js";
import {
  alignBuildFrames,
  PAIRED_BUILD_ROOM,
  pairedPresentation,
  type BuildEvidence,
} from "../../studio-runner/src/paired-evidence.js";
import { renderedEvidence } from "../../studio-runner/src/rendered-evidence.js";
import { assertRegisteredModels, readModelRegistry } from "./model-registry.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { projectAssessment } from "./assessment-projection.js";
import { releasedCapture } from "./assessment-evidence.js";
import { budgetSummary } from "./budget-summary.js";
import { assertExecutionImplementation, bindOperationImplementation } from "./execution-guard.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import {
  assertPinnedComparison,
  criterionIdentity,
  currentExemplarChoice,
  readExemplarChoice,
} from "./exemplars.js";
import { recordHoldoutLook } from "./holdout-access.js";
import { renderedGaps, renderedRequestSelection } from "./judgment-material.js";
import { lineageSpending } from "./lineage.js";
import { judgeCriteria } from "./run-plan.js";
import { frozenRunStatus } from "./run-builder.js";
import { captureView, manifestHash, pairingToleranceMs, subjectEval } from "./run-manifest.js";
import { operationSource } from "./sources.js";

/*
 * The exemplar comparison run. It judges retained evidence, so it makes no build and no Studio
 * run. A preview freezes each unit with the content identity of both evidence sets and quotes
 * each request before spend. The shared driver then asks both orders of each unit through one
 * bounded client and the one ledger of the run.
 */

const PROGRESS = "comparison_progress";

/**
 * The rendered evidence of one observation for one criterion, with half of the image room of a
 * request. It uses the selection rule of every other grading stream.
 */
async function comparisonBuildEvidence(
  root: string,
  operationId: string,
  captureId: string,
  criterionId: string,
): Promise<{
  frozen: FrozenBuildEvidence;
  build: BuildEvidence | null;
  toleranceMs: number;
  partition: "development" | "withheld";
}> {
  const { status, capture, receipt } = await releasedCapture(root, operationId, captureId);
  const manifest = status.manifest;
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    subjectEval(manifest, capture.treatmentId).id,
  );
  const criterion = judgeCriteria(revision).find((item) => item.id === criterionId);
  if (!criterion)
    throw new Error("The criterion is not a judge criterion of the evaluation of this observation");
  const source = await operationSource(root, manifest, capture.treatmentId);
  const files = new RepositoryFiles(root);
  const base = `.basalt-evals/eval-operations/${manifest.id}/capture/${capture.id}/studio`;
  const evidence = await files.json<StudioEvidence>(`${base}/evidence.json`);
  // The frozen view names the Studio plan that recorded this observation.
  const view = captureView(manifest, capture.id);
  const { sequence, captureIds } = renderedRequestSelection(
    manifest,
    capture.id,
    source.candidate.rootHash,
    [criterion],
  );
  const rendered = await renderedEvidence({
    files,
    base,
    evidence,
    plan: view.plan,
    captureIds,
    sequence,
    presentation: "sequence",
    requestRoom: PAIRED_BUILD_ROOM,
  });
  const unavailable = renderedGaps(manifest, criterion, rendered.unavailable);
  if (!unavailable.length && !rendered.images.length)
    unavailable.push("The observation has no rendered evidence for this criterion");
  if (rendered.images.length > PAIRED_BUILD_ROOM)
    unavailable.push(
      `The observation has more than ${PAIRED_BUILD_ROOM} images for this criterion, the room of one build`,
    );
  const build: BuildEvidence | null = unavailable.length
    ? null
    : {
        frames: rendered.labelled,
        transitions: rendered.transitions,
        images: rendered.images,
        samplingIntervalMs: rendered.context.samplingIntervalMs,
      };
  return {
    frozen: {
      operationId,
      captureId,
      evidenceHash: hashJson({
        receiptHash: hashJson(receipt),
        sourceHash: source.candidate.rootHash,
        frames: rendered.labelled,
        transitions: rendered.transitions,
        images: rendered.images.map((image) => ({ hash: image.hash, label: image.label })),
        samplingIntervalMs: rendered.context.samplingIntervalMs,
        unavailable,
      }),
      unavailable,
    },
    build,
    toleranceMs: pairingToleranceMs(manifest, capture.id),
    partition: capture.partition,
  };
}

function unavailableEvidence(operationId: string, captureId: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    frozen: {
      operationId,
      captureId,
      evidenceHash: hashJson({ unavailable: [reason] }),
      unavailable: [reason.slice(0, 500)],
    },
    build: null,
    toleranceMs: 0,
  };
}

/** The two requests of one unit, in the order of `COMPARISON_ORDERS`. */
function unitRequests(
  configuration: ExemplarComparisonPreview["configuration"],
  criterion: ReturnType<typeof scoringCriteria>[number],
  publicTask: string,
  candidate: BuildEvidence,
  exemplar: BuildEvidence,
  toleranceMs: number,
) {
  const alignment = alignBuildFrames(candidate, exemplar, toleranceMs);
  return COMPARISON_ORDERS.map((order) =>
    buildComparisonRequest({
      configuration,
      criterion,
      publicTask,
      ...pairedPresentation(candidate, exemplar, alignment, order),
    }),
  );
}

/**
 * Freeze and quote the exemplar comparison of one build before any spend. Each unit binds the
 * content identity of both evidence sets. The quote uses the request factory of dispatch and
 * the image limits of the endpoint. Two exemplars need four calls for each observation.
 */
export async function previewExemplarComparison(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<ExemplarComparisonPreview> {
  const input = fields(
    value,
    ["operationId", "subjectId", "modelId", "criterionIds", "analysisPlanId"],
    "Exemplar comparison selection",
  );
  const operationId = identity(input.operationId);
  const subjectId = identity(input.subjectId);
  if (typeof input.modelId !== "string") throw new Error("Select a model");
  assertRegisteredModels(await readModelRegistry(root), [input.modelId]);
  const modelId = input.modelId;
  if (
    !Array.isArray(input.criterionIds) ||
    !input.criterionIds.length ||
    input.criterionIds.length > 64 ||
    new Set(input.criterionIds).size !== input.criterionIds.length
  )
    throw new Error("Select 1 to 64 distinct criteria");
  const criterionIds = input.criterionIds.map(criterionIdentity);
  const analysisPlanId =
    input.analysisPlanId === null ? null : hash(input.analysisPlanId, "analysis plan identity");
  const source = await frozenRunStatus(root, operationId, false);
  const manifest = source.manifest;
  const evaluation = subjectEval(manifest, subjectId);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
  const executable = judgeCriteria(revision);
  const notApplicable: ExemplarComparisonPreview["notApplicable"] = [];
  const applicable: ExecutableCriterion[] = [];
  for (const id of criterionIds) {
    const criterion = executable.find((item) => item.id === id);
    if (!criterion)
      throw new Error(
        "A selected criterion is not a judge criterion of this evaluation. Choose a criterion that the judge checks.",
      );
    const reasons = exemplarComparisonGaps(criterion);
    if (reasons.length) notApplicable.push({ criterionId: id, reasons });
    else applicable.push(criterion);
  }
  if (!applicable.length) throw new Error("No selected criterion can use anchor build pairs");
  const choices: ExemplarChoice[] = [];
  for (const criterion of applicable) {
    const choice = await currentExemplarChoice(root, evaluation.id, criterion.id);
    if (!choice)
      throw new Error(`Choose anchor builds for criterion ${criterion.id} before the preview.`);
    choices.push(choice);
  }
  const candidateHash = (await operationSource(root, manifest, subjectId)).candidate.rootHash;
  if (choices.some((choice) => choice.exemplars.some((item) => item.sourceHash === candidateHash)))
    throw new Error("Choose another anchor build. A build cannot be compared with itself.");
  const captures = manifest.captureCells.filter((cell) => cell.treatmentId === subjectId);
  assertPinnedComparison({
    manifest,
    withheldCaptureIds: captures
      .filter((cell) => cell.partition !== "development")
      .map((cell) => cell.id),
    analysisPlanId,
    plan: analysisPlanId ? (await readRegisteredExperiment(root, analysisPlanId)).plan : null,
    evaluationId: evaluation.id,
    choices,
  });
  // Each evidence set is read once. A read that fails makes its units insufficient.
  const evidence = new Map<string, Awaited<ReturnType<typeof comparisonBuildEvidence>>>();
  const read = async (operation: string, captureId: string, criterionId: string) => {
    const key = JSON.stringify([operation, captureId, criterionId]);
    if (!evidence.has(key))
      evidence.set(
        key,
        await comparisonBuildEvidence(root, operation, captureId, criterionId).catch((error) => ({
          ...unavailableEvidence(operation, captureId, error),
          partition: "development" as const,
        })),
      );
    return evidence.get(key)!;
  };
  const units: ExemplarComparisonUnit[] = [];
  const materials = new Map<string, { candidate: BuildEvidence; exemplar: BuildEvidence }>();
  for (const capture of captures)
    for (const choice of choices) {
      const candidate = await read(operationId, capture.id, choice.criterionId);
      for (const [index, exemplar] of choice.exemplars.entries()) {
        const exemplarManifest = (await frozenRunStatus(root, exemplar.operationId, false))
          .manifest;
        if (manifestHash(exemplarManifest) !== exemplar.manifestHash)
          throw new Error("The run of an anchor build changed after the choice");
        const other = await read(exemplar.operationId, exemplar.captureId, choice.criterionId);
        const body = {
          captureId: capture.id,
          partition: capture.partition,
          criterionId: choice.criterionId,
          choiceId: choice.id,
          exemplar: index,
          toleranceMs: pairingToleranceMs(manifest, capture.id),
          candidate: candidate.frozen,
          exemplarEvidence: other.frozen,
        };
        const unit = { ...body, id: `comparison-${hashJson(body).slice(0, 24)}` };
        units.push(unit);
        if (candidate.build && other.build)
          materials.set(unit.id, { candidate: candidate.build, exemplar: other.build });
      }
    }
  if (!materials.size) {
    const reason = units.flatMap((unit) => [
      ...unit.candidate.unavailable,
      ...unit.exemplarEvidence.unavailable,
    ])[0];
    throw new Error(
      "Choose another build or other anchor builds. No pair has usable evidence." +
        (reason ? ` ${reason.replace(/\.?$/u, ".")}` : ""),
    );
  }
  const workFor = (snapshot: ModelSnapshot): QuotedModelWork[] => {
    const configuration = scoringConfiguration(revision, snapshot);
    return units.flatMap((unit) => {
      const material = materials.get(unit.id);
      if (!material) return [];
      return unitRequests(
        configuration,
        scoringCriteria(revision, [unit.criterionId])[0]!,
        revision.publicTask.prompt,
        material.candidate,
        material.exemplar,
        unit.toleranceMs,
      ).map((request) =>
        quoteRequest({
          stage: "grading",
          snapshot,
          request,
          calls: 1,
          futureTextBytes: 0,
          expectedFutureTextBytes: 0,
          imageDimensions: (request.messages[0]!.role === "user"
            ? (request.messages[0]!.images ?? [])
            : []
          ).map(imageDimensions),
        }),
      );
    });
  };
  const models = await adapters.catalog([
    {
      id: modelId,
      requirement: {
        tools: true,
        images: true,
        quoteWorkload: (snapshot) =>
          workFor(snapshot).map((work) => ({ calls: work.calls, usage: work.upper })),
      },
    },
  ]);
  const model = models[0];
  if (!model)
    throw new Error("The selected judge model is not available. Choose another judge model.");
  if (!model.inputModalities.includes("image"))
    throw new Error(
      "The selected judge model does not read images. Choose a judge model that reads images.",
    );
  const selection = { operationId, subjectId, modelId, criterionIds, analysisPlanId };
  const calls = materials.size * COMPARISON_ORDERS.length;
  const quote = createRunQuote(
    {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 0,
      capturePasses: 0,
      nativeRootLaunches: 0,
      nativeClientLaunches: 0,
      startupRecoveryRootLaunches: 0,
      startupRecoveryClientLaunches: 0,
      criterionOutcomes: units.length,
      judgmentBatches: calls,
      modelWork: workFor(model),
    },
    models,
    hashJson({ selection, units }),
  );
  const body: Omit<ExemplarComparisonPreview, "id"> = {
    stream: EXEMPLAR_COMPARISON_STREAM,
    selection,
    sourceManifestHash: manifestHash(manifest),
    title: `${revision.publicTask.title} · anchor build pairs`,
    configuration: scoringConfiguration(revision, model),
    choiceIds: choices.map((choice) => choice.id),
    notApplicable,
    units,
    calls,
    quote,
    budget: budgetSummary(),
  };
  const preview = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/exemplar-comparison-previews/${preview.id}.json`,
    preview,
  );
  return preview;
}

async function readExemplarComparisonPreview(root: string, id: string) {
  hash(id);
  const preview = await new RepositoryFiles(root).json<ExemplarComparisonPreview>(
    `.basalt-evals/exemplar-comparison-previews/${id}.json`,
  );
  const { id: savedId, ...body } = preview;
  if (savedId !== id || hashJson(body) !== id) throw new Error("Comparison preview changed");
  return preview;
}

export async function exemplarComparisonProgress(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return new RecordRepository(journal, PROGRESS, decodeAssessmentProgress).get(id);
  } finally {
    journal.close();
  }
}

export async function updateExemplarComparison(
  root: string,
  id: string,
  change: Partial<AssessmentProgress>,
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AssessmentProgress>(PROGRESS, id);
      if (!prior) throw new Error("No saved exemplar comparison");
      const next = decodeAssessmentProgress({ ...prior, ...change });
      if (
        next.operationId !== prior.operationId ||
        next.previewId !== prior.previewId ||
        next.startedAt !== prior.startedAt ||
        next.sourceOperationId !== prior.sourceOperationId ||
        hashJson(next.subjectIds) !== hashJson(prior.subjectIds) ||
        next.planned !== prior.planned
      )
        throw new Error("Comparison identity and workload are immutable");
      journal.put(PROGRESS, id, next);
      projectAssessment(journal, next);
      return next;
    });
  } finally {
    journal.close();
  }
}

/** The look at the holdout of one comparison, or null when it judges no withheld observation. */
export function comparisonHoldoutLook(
  preview: ExemplarComparisonPreview,
  operationId: string,
  at: string,
): HoldoutLook | null {
  const captureIds = [
    ...new Set(
      preview.units
        .filter((unit) => unit.partition !== "development")
        .map((unit) => unit.captureId),
    ),
  ].sort();
  return captureIds.length
    ? {
        at,
        purpose: "exemplar_comparison",
        recordId: operationId,
        operationId: preview.selection.operationId,
        subjectIds: [preview.selection.subjectId],
        captureIds,
      }
    : null;
}

/** The units of a comparison that a pinned analysis counts: one per observation, criterion and exemplar. */
function analysisKeys(preview: ExemplarComparisonPreview) {
  return preview.units.map((unit) => `${unit.captureId}:${unit.criterionId}:${unit.exemplar}`);
}

/** Refuse a pinned unit that another comparison already answers for the same analysis. */
function assertUnitsFree(
  journal: OperationJournal,
  preview: ExemplarComparisonPreview,
  id: string,
) {
  if (!preview.selection.analysisPlanId) return {};
  const owners =
    journal.read<Record<string, string>>(
      "exemplar_comparison_units",
      preview.selection.operationId,
    ) ?? {};
  if (analysisKeys(preview).some((key) => owners[key] && owners[key] !== id))
    throw new Error(
      "Open the earlier run. It already compares these observations with these anchor builds for this analysis.",
    );
  return owners;
}

/**
 * Start a previewed comparison with an explicit spending limit. The plan binds the preview,
 * the model and the implementation. A comparison bound to an analysis plan owns its units, so
 * a second comparison cannot answer the same unit for that analysis. Each withheld unit is a
 * look at the holdout, and the queue records it.
 */
export async function queueExemplarComparison(
  root: string,
  input: { previewId: string; ceilingUsd: number; idempotencyKey: string },
) {
  const preview = await readExemplarComparisonPreview(root, input.previewId);
  money(input.ceilingUsd);
  launchIdentity(input.idempotencyKey);
  const id = `run-${hashJson(input.idempotencyKey).slice(0, 32)}`,
    inputHash = preview.id;
  // A first check before any file is written. The journal transaction below decides.
  const owners = await OperationJournal.open(root);
  try {
    if (!owners.read(PROGRESS, id)) assertUnitsFree(owners, preview, id);
  } finally {
    owners.close();
  }
  const beforeRequest = await bindOperationImplementation(root, id, hashJson({ inputHash }));
  await beforeRequest();
  const files = new RepositoryFiles(root);
  const implementation = await files.json<{
    implementationCommit: string;
    buildIdentityHash: string;
  }>(`.basalt-evals/eval-operations/${id}/implementation.json`);
  const planPath = `.basalt-evals/eval-operations/${id}/comparison.json`;
  const priorPlan = await files.optional<ExemplarComparisonRunPlan>(planPath);
  if (
    priorPlan &&
    (priorPlan.previewId !== preview.id || priorPlan.ceilingUsd !== input.ceilingUsd)
  )
    throw new Error("Comparison authorization differs from its immutable plan");
  let plan: ExemplarComparisonRunPlan = priorPlan ?? {
    createdAt: new Date().toISOString(),
    id,
    previewId: preview.id,
    inputHash,
    implementationCommit: implementation.implementationCommit,
    buildIdentityHash: implementation.buildIdentityHash,
    model: preview.quote.models[0]!,
    ceilingUsd: input.ceilingUsd,
  };
  try {
    await files.writeJson(planPath, plan);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const published = await files.json<ExemplarComparisonRunPlan>(planPath);
    const { createdAt: _attemptedAt, ...expected } = plan;
    const { createdAt, ...retained } = published;
    // Concurrent identical authorizations share the first publisher's clock and plan.
    if (
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt)) ||
      hashJson(retained) !== hashJson(expected)
    )
      throw error;
    plan = published;
  }
  const source = (await frozenRunStatus(root, preview.selection.operationId, false)).manifest;
  if (manifestHash(source) !== preview.sourceManifestHash)
    throw new Error("The run of the build under judgment changed after the preview");
  const look = comparisonHoldoutLook(preview, id, plan.createdAt);
  // The holdout rule again, with the frozen choices: only a pinned plan opens a withheld unit.
  if (look || preview.selection.analysisPlanId)
    assertPinnedComparison({
      manifest: source,
      withheldCaptureIds: look?.captureIds ?? [],
      analysisPlanId: preview.selection.analysisPlanId,
      plan: preview.selection.analysisPlanId
        ? (await readRegisteredExperiment(root, preview.selection.analysisPlanId)).plan
        : null,
      evaluationId: subjectEval(source, preview.selection.subjectId).id,
      choices: await Promise.all(
        preview.choiceIds.map((choiceId) => readExemplarChoice(root, choiceId)),
      ),
    });
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash }));
  await ledger.initialize({ quoteHash: hashJson(preview.quote), ceilingUsd: input.ceilingUsd });
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AssessmentProgress>(PROGRESS, id);
      const binding = journal.read<{ hash: string }>("comparison_plans", id);
      if (binding && binding.hash !== hashJson(plan))
        throw new Error("Comparison plan differs from its authorization");
      if (prior) return prior;
      if (
        journal.read("run_starts", id) ||
        journal.read("workflows", id) ||
        journal.read("assessment_progress", id)
      )
        throw new Error("Launch identity already belongs to different work");
      if (preview.selection.analysisPlanId) {
        const sourceId = preview.selection.operationId;
        const owners = assertUnitsFree(journal, preview, id);
        journal.put(
          "exemplar_comparison_units",
          sourceId,
          Object.fromEntries([
            ...Object.entries(owners),
            ...analysisKeys(preview).map((key) => [key, id]),
          ]),
        );
        const runs = journal.read<{ operationIds: string[] }>("exemplar_comparisons", sourceId);
        journal.put("exemplar_comparisons", sourceId, {
          operationIds: [...(runs?.operationIds ?? []), id],
        });
      }
      const progress: AssessmentProgress = {
        operationId: id,
        previewId: preview.id,
        title: preview.title,
        startedAt: new Date().toISOString(),
        sourceOperationId: preview.selection.operationId,
        subjectIds: [preview.selection.subjectId],
        planned: preview.units.length,
        completed: 0,
        incomplete: 0,
        inFlight: null,
        finished: false,
        stopped: false,
        error: null,
      };
      journal.put("comparison_plans", id, { hash: hashJson(plan) });
      journal.put(PROGRESS, id, progress);
      projectAssessment(journal, progress);
      if (look)
        recordHoldoutLook(journal, subjectEval(source, preview.selection.subjectId).id, look);
      return progress;
    });
  } finally {
    journal.close();
  }
}

export async function exemplarComparisonPlan(root: string, id: string) {
  identity(id);
  const plan = await new RepositoryFiles(root).json<ExemplarComparisonRunPlan>(
    `.basalt-evals/eval-operations/${id}/comparison.json`,
  );
  if (plan.id !== id || plan.inputHash !== plan.previewId)
    throw new Error("Comparison identity changed");
  const journal = await OperationJournal.open(root);
  try {
    if (journal.read<{ hash: string }>("comparison_plans", id)?.hash !== hashJson(plan))
      throw new Error("Comparison plan changed after authorization");
  } finally {
    journal.close();
  }
  const preview = await readExemplarComparisonPreview(root, plan.previewId);
  if (hashJson(preview.quote.models[0]) !== hashJson(plan.model))
    throw new Error("Comparison model is outside the frozen preview");
  return plan;
}

/**
 * Read both evidence sets of one unit again and check them against the preview. The answer
 * of a unit always rests on the evidence that the person authorized.
 */
async function unitEvidence(root: string, unit: ExemplarComparisonUnit) {
  const [candidate, exemplar] = await Promise.all([
    comparisonBuildEvidence(
      root,
      unit.candidate.operationId,
      unit.candidate.captureId,
      unit.criterionId,
    ),
    comparisonBuildEvidence(
      root,
      unit.exemplarEvidence.operationId,
      unit.exemplarEvidence.captureId,
      unit.criterionId,
    ),
  ]);
  if (
    candidate.frozen.evidenceHash !== unit.candidate.evidenceHash ||
    exemplar.frozen.evidenceHash !== unit.exemplarEvidence.evidenceHash
  )
    throw new Error("The evidence of a build changed after the preview. Make a new preview.");
  return { candidate, exemplar };
}

async function judgeUnit(input: {
  root: string;
  id: string;
  plan: ExemplarComparisonRunPlan;
  preview: ExemplarComparisonPreview;
  unit: ExemplarComparisonUnit;
  client: Parameters<typeof runExemplarComparison>[0]["client"];
  ledger: DurableSpendLedger;
  replayOnly?: boolean;
  beforeRequest?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<ExemplarComparisonResult> {
  const { unit, preview, plan } = input;
  const base = {
    operationId: input.id,
    unitId: unit.id,
    treatmentIdentity: modelTreatmentIdentity(plan.model),
    candidateEvidenceHash: unit.candidate.evidenceHash,
    exemplarEvidenceHash: unit.exemplarEvidence.evidenceHash,
  };
  const unavailable = [...unit.candidate.unavailable, ...unit.exemplarEvidence.unavailable];
  // Evidence that cannot support the criterion gives an insufficient outcome without a call.
  if (unavailable.length)
    return {
      ...base,
      answers: [],
      outcome: "insufficient",
      unavailable,
      responseHashes: [],
      costUsd: 0,
    };
  const { candidate, exemplar } = await unitEvidence(input.root, unit);
  const source = await frozenRunStatus(input.root, preview.selection.operationId, false);
  const revision = await new EvalDefinitionStore(input.root).readExecutableRevision(
    subjectEval(source.manifest, preview.selection.subjectId).id,
  );
  const response = await runExemplarComparison({
    client: input.client,
    ledger: input.ledger,
    snapshot: plan.model,
    stage: `comparison:${unit.id}`,
    configuration: preview.configuration,
    criterion: scoringCriteria(revision, [unit.criterionId])[0]!,
    publicTask: revision.publicTask.prompt,
    candidate: candidate.build!,
    exemplar: exemplar.build!,
    toleranceMs: unit.toleranceMs,
    ...(input.beforeRequest ? { beforeRequest: input.beforeRequest } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.replayOnly ? { replayOnly: true } : {}),
  });
  return {
    ...base,
    answers: response.answers,
    outcome: response.outcome,
    unavailable: [],
    responseHashes: response.responseHashes,
    costUsd: response.responses.some((item) => item.usage.costUsd === null)
      ? null
      : response.responses.reduce((sum, item) => sum + item.usage.costUsd!, 0),
  };
}

function decided(outcome: PairOutcome) {
  return outcome === "win" || outcome === "loss";
}

/**
 * Invoked only by the shared owned driver. Each request reserves its full cost first. A
 * request without a known result stays incomplete, and the bounded client never sends it again.
 */
export async function executeExemplarComparison(
  root: string,
  id: string,
  token: string,
  signal: AbortSignal,
  adapters: ExecutionAdapters,
) {
  const plan = await exemplarComparisonPlan(root, id),
    preview = await readExemplarComparisonPreview(root, plan.previewId);
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash: plan.inputHash }));
  const beforeRequest = async () => {
    signal.throwIfAborted();
    await assertExecutionImplementation(root, plan);
    const journal = await OperationJournal.open(root);
    try {
      const owner = journal.read<{ token: string; pid: number; active: boolean }>("drivers", id);
      if (
        !owner?.active ||
        owner.token !== token ||
        owner.pid !== process.pid ||
        journal.read<AssessmentProgress>(PROGRESS, id)?.stopped
      )
        throw new Error("The run is stopped or no longer owned by this driver");
    } finally {
      journal.close();
    }
  };
  await beforeRequest();
  const files = new RepositoryFiles(root);
  for (const unit of preview.units) {
    if (signal.aborted || (await exemplarComparisonProgress(root, id))?.stopped) return;
    const journal = await OperationJournal.open(root);
    let done: boolean;
    try {
      done = journal.read("comparison_units", `${id}:${unit.id}`) !== null;
    } finally {
      journal.close();
    }
    if (done) continue;
    await updateExemplarComparison(root, id, { inFlight: unit.id, error: null });
    let result: ExemplarComparisonResult | null = null,
      error: string | null = null;
    try {
      result = await judgeUnit({
        root,
        id,
        plan,
        preview,
        unit,
        client: adapters.model([plan.model]),
        ledger,
        beforeRequest,
        signal,
      });
      await files.writeJsonOnce(
        `.basalt-evals/eval-operations/${id}/comparisons/${unit.id}.json`,
        result,
      );
    } catch (caught) {
      if (signal.aborted || (await exemplarComparisonProgress(root, id))?.stopped) return;
      error = String(caught).slice(0, 1000);
      const spending = spendingProjection(await ledger.read());
      // A pending charge or the spending limit stops the run. Resume never sends the request again.
      if (spending.pendingBilling || caught instanceof SpendingCeilingError) {
        await updateExemplarComparison(root, id, { error });
        return;
      }
    }
    const records = await OperationJournal.open(root);
    try {
      records.transaction(() => {
        const key = `${id}:${unit.id}`;
        if (records.read("comparison_units", key)) return;
        records.put("comparison_units", key, {
          resultHash: result ? hashJson(result) : null,
          error,
        });
        if (result) resolveExecutionFailures(records, id, "comparison", unit.id);
        const progress = records.read<AssessmentProgress>(PROGRESS, id)!;
        const complete = result !== null && decided(result.outcome);
        const next = {
          ...progress,
          completed: progress.completed + (complete ? 1 : 0),
          incomplete: progress.incomplete + (complete ? 0 : 1),
          inFlight: null,
          error: null,
        };
        records.put(PROGRESS, id, next);
        projectAssessment(records, next);
      });
    } finally {
      records.close();
    }
  }
  await updateExemplarComparison(root, id, { finished: true, inFlight: null });
}

/**
 * The verified report. Each stored answer is checked against its retained billed responses:
 * Basalt builds both requests again and compares them, so no stored answer can change.
 */
export async function exemplarComparisonReport(
  root: string,
  id: string,
): Promise<ExemplarComparisonReport> {
  const plan = await exemplarComparisonPlan(root, id),
    preview = await readExemplarComparisonPreview(root, plan.previewId);
  const source = await frozenRunStatus(root, preview.selection.operationId, false);
  if (manifestHash(source.manifest) !== preview.sourceManifestHash)
    throw new Error("The run of the build under judgment changed after the preview");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    subjectEval(source.manifest, preview.selection.subjectId).id,
  );
  const choices = await Promise.all(
    preview.choiceIds.map((choiceId) => readExemplarChoice(root, choiceId)),
  );
  const files = new RepositoryFiles(root);
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash: plan.inputHash }));
  const results: ExemplarComparisonReport["results"] = [];
  const journal = await OperationJournal.open(root);
  try {
    for (const unit of preview.units) {
      const receipt = journal.read<{ resultHash: string | null; error: string | null }>(
        "comparison_units",
        `${id}:${unit.id}`,
      );
      let result: ExemplarComparisonResult | null = null,
        error = receipt?.error ?? null;
      if (receipt?.resultHash) {
        try {
          result = await files.json<ExemplarComparisonResult>(
            `.basalt-evals/eval-operations/${id}/comparisons/${unit.id}.json`,
          );
          const replay = await judgeUnit({
            root,
            id,
            plan,
            preview,
            unit,
            client: retainedResponseClient([plan.model]),
            ledger,
            replayOnly: true,
          });
          if (hashJson(result) !== receipt.resultHash || hashJson(result) !== hashJson(replay))
            throw new Error(
              "The judge answers in this run do not match the provider responses that Basalt saved. Start a new run.",
            );
        } catch (caught) {
          result = null;
          error = String(caught).slice(0, 500);
        }
      }
      results.push({
        unitId: unit.id,
        captureId: unit.captureId,
        partition: unit.partition,
        pass: source.manifest.captureCells.find((cell) => cell.id === unit.captureId)!.pass,
        criterionId: unit.criterionId,
        exemplar: unit.exemplar,
        result,
        error,
      });
    }
    const verdicts = [
      ...new Set(preview.units.map((unit) => JSON.stringify([unit.captureId, unit.criterionId]))),
    ].map((key) => {
      const [captureId, criterionId] = JSON.parse(key) as [string, string];
      const outcomes = results
        .filter((item) => item.captureId === captureId && item.criterionId === criterionId)
        .map((item) => item.result?.outcome ?? null);
      return {
        captureId,
        criterionId,
        verdict: outcomes.every((outcome) => outcome !== null)
          ? exemplarVerdict(outcomes as PairOutcome[])
          : null,
      };
    });
    return {
      plan,
      selection: preview.selection,
      criteria: choices.map((choice) => ({
        id: choice.criterionId,
        statement: judgeCriteria(revision).find((item) => item.id === choice.criterionId)!
          .statement,
        choiceId: choice.id,
        exemplars: choice.exemplars.length,
      })),
      planned: preview.units.length,
      results,
      verdicts,
      spending: spendingProjection(await ledger.read()),
      lineage: lineageSpending(journal, id),
      limitation:
        "This run checks saved evidence. It makes no new builds and no Studio runs. A person reviews each order change and each answer without enough evidence.",
    };
  } finally {
    journal.close();
  }
}

/**
 * The answers of one report as analysis records. A unit without evidence for the criterion
 * is insufficient in both orders. A unit without a result has no record, so it stays absent.
 */
export function comparisonRecords(report: ExemplarComparisonReport): ExemplarComparisonRecord[] {
  return report.results.flatMap((item) => {
    const result = item.result;
    if (!result) return [];
    return COMPARISON_ORDERS.map((order) => {
      const answer = result.answers.find((answer) => answer.order === order);
      return {
        captureId: item.captureId,
        criterionId: item.criterionId,
        exemplar: item.exemplar,
        order,
        preference: answer ? answer.preference : ("insufficient" as const),
        integrityIssue: answer?.addressedToEvaluator.found ?? false,
      };
    });
  });
}

/** The stored answers of the comparisons that the registered plan of a protocol run pins. */
export async function pinnedComparisonRecords(root: string, manifest: RunOperationManifest) {
  if (!manifest.protocol) return [];
  const journal = await OperationJournal.open(root);
  let operationIds: string[];
  try {
    operationIds =
      journal.read<{ operationIds: string[] }>("exemplar_comparisons", manifest.id)?.operationIds ??
      [];
  } finally {
    journal.close();
  }
  const records: ExemplarComparisonRecord[] = [];
  for (const operationId of operationIds) {
    const report = await exemplarComparisonReport(root, operationId);
    if (report.selection.analysisPlanId !== manifest.protocol.registrationId)
      throw new Error("A pinned comparison belongs to another analysis plan");
    records.push(...comparisonRecords(report));
  }
  return records;
}
