import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import {
  fields,
  hash,
  identifiers,
  identity,
  money,
  launchIdentity,
} from "../../contracts/src/validation.js";
import {
  ASSESSMENT_CONDITIONS,
  type AssessmentPlan,
  type AssessmentPreview,
  type AssessmentProgress,
  type AssessmentResult,
  type AssessmentSelection,
  type AssessmentUnit,
  type AssessmentReport,
  type EvidenceCondition,
} from "../../contracts/src/assessments.js";
import type { EvidenceSubstitutionKind, RunJudgmentBatch } from "../../contracts/src/execution.js";
import { DEFAULT_JUDGE_SETTINGS, type JudgeSettings } from "../../contracts/src/judge-settings.js";
import { evidenceUseReport } from "../../experiments/src/evidence-use.js";
import { assessmentUnits, MAX_POOLED_BUILDS, sensitivityPlan } from "./sensitivity-plan.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { scoringConfiguration } from "../../eval-authoring/src/scoring.js";
import {
  batchJudgmentRequest,
  MAX_OBSERVATION_JSON_BYTES,
  observationRequest,
} from "../../eval-authoring/src/batch-judgment.js";
import { runJudgmentBatch } from "../../agent-runtime/src/batch-grading.js";
import {
  DurableSpendLedger,
  spendingProjection,
  SpendingCeilingError,
} from "../../model-client/src/ledger.js";
import { createRunQuote, type QuotedModelWork } from "../../model-client/src/quote.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import { imageDimensions } from "../../model-client/src/request-workload.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { retainedResponseClient } from "../../model-client/src/recovery.js";
import { frozenRunStatus } from "./run-builder.js";
import { subjectEval, manifestHash } from "./run-manifest.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { assertRegisteredModels, buildName, readModelRegistry } from "./model-registry.js";
import {
  readAssessmentEvidence,
  resolveAssessmentEvidence,
  saveEvidenceSet,
} from "./assessment-evidence.js";
import { bindOperationImplementation, assertExecutionImplementation } from "./execution-guard.js";
import { projectAssessment } from "./assessment-projection.js";
import { lineageSpending } from "./lineage.js";
import { resolveExecutionFailures } from "../../artifact-store/src/failures.js";
import { RecordRepository } from "../../artifact-store/src/records.js";
import { decodeAssessmentProgress } from "../../contracts/src/assessments.js";
import { budgetSummary } from "./budget-summary.js";
import { recordHoldoutLook } from "./holdout-access.js";
import { judgmentMaterial } from "./judgment-material.js";
import { EVIDENCE_PACKET_POLICY_HASH } from "../../studio-runner/src/evidence-packet.js";
import { judgmentGroups } from "../../eval-authoring/src/rendered-selection.js";

/** Distinct supported evidence conditions, in canonical order. */
export function assessmentConditions(value: unknown): EvidenceCondition[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    new Set(value).size !== value.length ||
    value.some((item) => !(ASSESSMENT_CONDITIONS as readonly unknown[]).includes(item))
  )
    throw new Error(`Choose distinct evidence conditions from ${ASSESSMENT_CONDITIONS.join(", ")}`);
  return ASSESSMENT_CONDITIONS.filter((condition) => value.includes(condition));
}

/**
 * Original evidence is the retest baseline each diagnostic control is compared with. A region
 * removal always runs with its sham, and the black fill only beside the pre-action fill.
 */
export function sensitivityConditions(value: unknown): EvidenceCondition[] {
  const conditions = assessmentConditions(value);
  if (conditions[0] !== "original" || conditions.length < 2)
    throw new Error(
      "A sensitivity test needs the evidence as recorded and at least one control. Choose a control.",
    );
  if (conditions.includes("region_removed") !== conditions.includes("region_sham"))
    throw new Error(
      "The Region removed control needs the Sham region removed control. Choose both controls or neither.",
    );
  if (conditions.includes("region_black") && !conditions.includes("region_removed"))
    throw new Error(
      "The Region in black control checks the Region removed control. If you choose Region in black, also choose Region removed.",
    );
  return conditions;
}

/** The revision of the run that saved the builds. An assessment checks the builds with it. */
export async function sourceRevisionId(
  root: string,
  operationId: unknown,
  subjectIds: unknown,
): Promise<string> {
  const [subjectId] = identifiers(subjectIds, MAX_POOLED_BUILDS, "Assessment builds");
  const source = await frozenRunStatus(root, identity(operationId), false);
  return subjectEval(source.manifest, subjectId!).id;
}

/**
 * The free preview of a reassessment or a sensitivity test. A reassessment judges with shared
 * requests and one sample. A sensitivity test uses shared requests and the repeats of its plan.
 * A recheck and a grader regression give a `scope`: the criteria to judge and the judge
 * settings. A recheck uses the judge settings of its source run.
 */
export async function previewAssessment(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
  scope?: { criterionIds: string[]; judgeSettings: JudgeSettings },
): Promise<AssessmentPreview> {
  const input = fields(
    value,
    [
      "operationId",
      "revisionId",
      "subjectIds",
      "modelId",
      "presentation",
      "conditions",
      "sensitivity",
    ],
    "Assessment selection",
  );
  identity(input.operationId);
  hash(input.revisionId, "Assessment evaluation");
  const subjectIds = identifiers(input.subjectIds, MAX_POOLED_BUILDS, "Assessment builds");
  if (
    typeof input.modelId !== "string" ||
    !["still", "sequence", "grounded-sequence"].includes(String(input.presentation))
  )
    throw new Error("Select a model and a supported evidence presentation");
  assertRegisteredModels(await readModelRegistry(root), [input.modelId]);
  const conditions = assessmentConditions(input.conditions);
  const diagnostic = conditions.some((condition) => condition !== "original");
  if (diagnostic) sensitivityConditions(conditions);
  if (diagnostic === (input.sensitivity === null))
    throw new Error("A sensitivity test needs a plan, and a reassessment has none");
  const source = await frozenRunStatus(root, String(input.operationId), false);
  // A diagnostic checks the evaluation of its run. A reassessment can check the criteria of
  // another revision, and each judgment refuses an observation with a different Studio plan.
  if (diagnostic && input.revisionId !== subjectEval(source.manifest, subjectIds[0]!).id)
    throw new Error(
      "A sensitivity test checks saved evidence only with the evaluation of its run. Choose that evaluation.",
    );
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    String(input.revisionId),
  );
  const qualitative = [
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
  const available = qualitative.map((item) => item.id);
  if (scope?.criterionIds.some((id) => !available.includes(id)))
    throw new Error("Selected model assessment criteria are unavailable");
  const criterionIds = scope?.criterionIds ?? available;
  const settings = scope?.judgeSettings ?? DEFAULT_JUDGE_SETTINGS;
  if (!criterionIds.length)
    throw new Error(
      "This evaluation has only code checks. The judge has no criteria to check again.",
    );
  // Criteria without rendered evidence get their own request with no images. A control
  // replaces only images, so it runs only on the request with images. A sensitivity test uses
  // shared requests, so it has at most one request with images.
  const groups = judgmentGroups(
    qualitative.filter((criterion) => criterionIds.includes(criterion.id)),
    settings.grouping,
  ).map((group) => ({
    images: group.images,
    criterionIds: group.criteria.map((criterion) => criterion.id),
  }));
  const imageCriterionIds = groups.find((group) => group.images)?.criterionIds ?? [];
  if (diagnostic && !imageCriterionIds.length)
    throw new Error(
      "The selected criteria use no images, and Basalt applies controls only to criteria that use images. Start a reassessment instead.",
    );
  const selection = {
    ...input,
    subjectIds,
    conditions,
    sensitivity: diagnostic
      ? sensitivityPlan(input.sensitivity, imageCriterionIds, subjectIds)
      : null,
  } as unknown as AssessmentSelection;
  const plannedUnits = await assessmentUnits({
    root,
    manifest: source.manifest,
    subjectIds,
    presentation: selection.presentation,
    conditions: selection.conditions,
    plan: selection.sensitivity,
    judgeSettings: settings,
    groups,
  });
  // The judge reads the criteria of the selected revision.
  const planned = {
    ...plannedUnits,
    units: plannedUnits.units.map((unit) => ({
      ...unit,
      batch: { ...unit.batch, revisionId: selection.revisionId },
    })),
  };
  const materials: Array<Awaited<ReturnType<typeof resolveAssessmentEvidence>>["material"]> = [];
  const proposedMaterials: typeof materials = [];
  const packetReports: AssessmentPreview["evidencePackets"] = [];
  const pendingUnits: Array<
    Omit<AssessmentUnit, "batch"> & { batch: Omit<RunJudgmentBatch, "configuration"> }
  > = [];
  for (const { batch, ...planUnit } of planned.units) {
    let evidenceSetId: string | null = null,
      unavailable: string | null = null;
    try {
      const resolved = await resolveAssessmentEvidence(root, source.manifest.id, batch);
      await saveEvidenceSet(root, resolved.set);
      evidenceSetId = resolved.set.id;
      materials.push(resolved.material);
      // Packet policy is inspected on original evidence only; controls replace that evidence.
      if (planUnit.condition === "original" && planUnit.repeat === 1)
        try {
          const proposed = await judgmentMaterial(root, source.manifest, batch, true);
          proposedMaterials.push(proposed);
          packetReports.push({
            captureId: planUnit.captureId,
            evidenceSetId,
            dispatchedImages: resolved.material.images.length,
            proposedImages: proposed.images.length,
            manifest: proposed.packetManifest ?? null,
            error: null,
          });
        } catch (error) {
          packetReports.push({
            captureId: planUnit.captureId,
            evidenceSetId,
            dispatchedImages: resolved.material.images.length,
            proposedImages: null,
            manifest: null,
            error: String(error).slice(0, 500),
          });
        }
    } catch (error) {
      unavailable = String(error).slice(0, 500);
    }
    pendingUnits.push({ ...planUnit, evidenceSetId, unavailable, batch });
  }
  if (!materials.length)
    throw new Error(
      "Basalt found no complete evidence that the judge can check. Choose a build with complete evidence.",
    );
  const workFor = (
    snapshot: Parameters<typeof quoteRequest>[0]["snapshot"],
    selectedMaterials = materials,
  ): QuotedModelWork[] =>
    selectedMaterials.flatMap((material) => {
      if (material.criterionEvidence.every((item) => item.unavailable.length)) return [];
      const configuration = scoringConfiguration(revision, snapshot);
      const grounded = selection.presentation === "grounded-sequence" && material.images.length > 0;
      const shared = {
        stage: "grading" as const,
        snapshot,
        calls: 1,
        futureTextBytes: 0,
        expectedFutureTextBytes: 0,
      };
      return [
        ...(grounded
          ? [
              quoteRequest({
                ...shared,
                request: observationRequest(configuration, material.context, material.images),
                imageDimensions: material.images.map(imageDimensions),
              }),
            ]
          : []),
        quoteRequest({
          ...shared,
          request: batchJudgmentRequest({
            ...material,
            configuration,
            images: grounded ? [] : material.images,
            observation: null,
          }),
          futureTextBytes: grounded ? MAX_OBSERVATION_JSON_BYTES : 0,
          expectedFutureTextBytes: grounded ? 4096 : 0,
          imageDimensions: grounded ? [] : material.images.map(imageDimensions),
        }),
      ];
    });
  const models = await adapters.catalog([
    {
      id: selection.modelId,
      requirement: {
        tools: true,
        images: materials.some((item) => item.images.length > 0),
        quoteWorkload: (snapshot) =>
          workFor(snapshot).map((work) => ({ calls: work.calls, usage: work.upper })),
      },
    },
  ]);
  const model = models[0];
  if (!model)
    throw new Error("The selected judge model is not available. Choose another judge model.");
  const configuration = scoringConfiguration(revision, model);
  const units: AssessmentUnit[] = pendingUnits.map((unit) => ({
    ...unit,
    batch: { ...unit.batch, configuration },
  }));
  const quote = createRunQuote(
    {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 0,
      capturePasses: 0,
      nativeRootLaunches: 0,
      nativeClientLaunches: 0,
      startupRecoveryRootLaunches: 0,
      startupRecoveryClientLaunches: 0,
      criterionOutcomes: units.reduce((sum, unit) => sum + unit.criterionIds.length, 0),
      judgmentBatches: units.length,
      modelWork: workFor(model),
    },
    models,
    hashJson({ selection, units }),
  );
  const budget = budgetSummary();
  const body = {
    sourceJudgingSetups: [
      ...new Map(
        source.manifest.judgmentBatches
          .filter((batch) =>
            source.manifest.captureCells.some(
              (capture) =>
                capture.id === batch.captureCellId &&
                selection.subjectIds.includes(capture.treatmentId),
            ),
          )
          .map((batch) => [
            `${batch.configuration.modelId}:${batch.presentation}`,
            { modelId: batch.configuration.modelId, presentation: batch.presentation },
          ]),
      ).values(),
    ],
    evidencePackets: packetReports,
    packetPolicyHash: EVIDENCE_PACKET_POLICY_HASH,
    proposedPacketWork: workFor(model, proposedMaterials),
    selection,
    unavailableControls: planned.unavailable,
    excludedCaptureIds: planned.excluded,
    sourceManifestHash: manifestHash(source.manifest),
    title: revision.publicTask.title,
    configuration,
    units,
    quote,
    budget,
  };
  const preview = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/assessment-previews/${preview.id}.json`,
    preview,
  );
  return preview;
}

/** A sensitivity test adds diagnostic controls to its original-evidence baseline. */
export function sensitivityTest(preview: AssessmentPreview) {
  return preview.selection.conditions.some((condition) => condition !== "original");
}

export async function readAssessmentPreview(root: string, id: string) {
  hash(id);
  const preview = await new RepositoryFiles(root).json<AssessmentPreview>(
    `.basalt-evals/assessment-previews/${id}.json`,
  );
  const { id: savedId, ...body } = preview;
  if (savedId !== id || hashJson(body) !== id) throw new Error("Assessment preview changed");
  return preview;
}

export async function assessmentProgress(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return new RecordRepository(journal, "assessment_progress", decodeAssessmentProgress).get(id);
  } finally {
    journal.close();
  }
}

export async function updateAssessment(
  root: string,
  id: string,
  change: Partial<AssessmentProgress>,
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AssessmentProgress>("assessment_progress", id);
      if (!prior) throw new Error("No saved assessment");
      const next = decodeAssessmentProgress({ ...prior, ...change });
      if (
        next.operationId !== prior.operationId ||
        next.previewId !== prior.previewId ||
        next.startedAt !== prior.startedAt ||
        next.sourceOperationId !== prior.sourceOperationId ||
        hashJson(next.subjectIds) !== hashJson(prior.subjectIds) ||
        next.planned !== prior.planned
      )
        throw new Error("Assessment identity and workload are immutable");
      journal.put("assessment_progress", id, next);
      projectAssessment(journal, next);
      return next;
    });
  } finally {
    journal.close();
  }
}

export async function queueAssessment(
  root: string,
  input: { previewId: string; ceilingUsd: number; idempotencyKey: string },
) {
  const preview = await readAssessmentPreview(root, input.previewId);
  money(input.ceilingUsd);
  launchIdentity(input.idempotencyKey);
  const id = `run-${hashJson(input.idempotencyKey).slice(0, 32)}`,
    inputHash = preview.id;
  const beforeRequest = await bindOperationImplementation(root, id, hashJson({ inputHash }));
  await beforeRequest();
  const files = new RepositoryFiles(root);
  const implementation = await files.json<{
    implementationCommit: string;
    buildIdentityHash: string;
  }>(`.basalt-evals/eval-operations/${id}/implementation.json`);
  const planPath = `.basalt-evals/eval-operations/${id}/assessment.json`;
  const priorPlan = await files.optional<AssessmentPlan>(planPath);
  if (
    priorPlan &&
    (priorPlan.previewId !== preview.id || priorPlan.ceilingUsd !== input.ceilingUsd)
  )
    throw new Error("Assessment authorization differs from its immutable plan");
  let plan: AssessmentPlan = priorPlan ?? {
    createdAt: new Date().toISOString(),
    id,
    previewId: preview.id,
    inputHash,
    implementationCommit: implementation.implementationCommit,
    buildIdentityHash: implementation.buildIdentityHash,
    model: preview.quote.models[0]!,
    ceilingUsd: input.ceilingUsd,
    gradingSemanticsHash: hashJson({
      implementation,
      harness: "batch-criterion-assessment",
      inputHash,
      dispatchedSelection: "endpoints-and-authored-pre-post-anchors",
      dryRunPolicyHash: preview.packetPolicyHash,
    }),
  };
  try {
    await files.writeJson(planPath, plan);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const published = await files.json<AssessmentPlan>(planPath);
    const { createdAt: _attemptedAt, ...expected } = plan;
    const { createdAt, ...retained } = published;
    // Concurrent identical authorizations share the first publisher's clock and hash.
    // Work, ceiling, model and implementation identity must still match exactly.
    if (
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt)) ||
      hashJson(retained) !== hashJson(expected)
    )
      throw error;
    plan = published;
  }
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash }));
  await ledger.initialize({ quoteHash: hashJson(preview.quote), ceilingUsd: input.ceilingUsd });
  const source = (await frozenRunStatus(root, preview.selection.operationId, false)).manifest;
  // A donor or twin capture that the judge sees is a look at the holdout too.
  const withheldCaptureIds = [
    ...new Set(
      preview.units
        .flatMap((unit) => [
          unit.captureId,
          ...(unit.batch.substitution?.donorCaptureCellId
            ? [unit.batch.substitution.donorCaptureCellId]
            : []),
        ])
        .filter(
          (captureId) =>
            source.captureCells.find((cell) => cell.id === captureId)?.partition !== "development",
        ),
    ),
  ].sort();
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AssessmentProgress>("assessment_progress", id);
      const binding = journal.read<{ hash: string }>("assessment_plans", id);
      if (binding && binding.hash !== hashJson(plan))
        throw new Error("Assessment plan differs from its authorization");
      if (prior) return prior;
      if (journal.read("run_starts", id) || journal.read("workflows", id))
        throw new Error("Launch identity already belongs to different work");
      const progress: AssessmentProgress = {
        operationId: id,
        previewId: preview.id,
        title: `${preview.title} · ${sensitivityTest(preview) ? "sensitivity test" : "reassessment"}`,
        startedAt: new Date().toISOString(),
        sourceOperationId: preview.selection.operationId,
        subjectIds: preview.selection.subjectIds,
        planned: preview.quote.workload.criterionOutcomes,
        completed: 0,
        incomplete: 0,
        inFlight: null,
        finished: false,
        stopped: false,
        error: null,
      };
      journal.put("assessment_plans", id, { hash: hashJson(plan) });
      journal.put("assessment_progress", id, progress);
      projectAssessment(journal, progress);
      // A grader that judges withheld evidence again is a look at the holdout. A sensitivity
      // test reaches withheld evidence only when its plan authorizes one look.
      if (withheldCaptureIds.length)
        recordHoldoutLook(journal, subjectEval(source, preview.selection.subjectIds[0]!).id, {
          at: plan.createdAt ?? new Date().toISOString(),
          purpose: sensitivityTest(preview) ? "sensitivity_test" : "reassessment",
          recordId: id,
          operationId: preview.selection.operationId,
          subjectIds: [
            ...new Set(
              withheldCaptureIds.map(
                (captureId) =>
                  source.captureCells.find((cell) => cell.id === captureId)!.treatmentId,
              ),
            ),
          ].sort(),
          captureIds: withheldCaptureIds,
        });
      return progress;
    });
  } finally {
    journal.close();
  }
}

export async function assessmentPlan(root: string, id: string) {
  identity(id);
  const plan = await new RepositoryFiles(root).json<AssessmentPlan>(
    `.basalt-evals/eval-operations/${id}/assessment.json`,
  );
  if (plan.id !== id || plan.inputHash !== plan.previewId)
    throw new Error("Assessment identity changed");
  const journal = await OperationJournal.open(root);
  try {
    if (journal.read<{ hash: string }>("assessment_plans", id)?.hash !== hashJson(plan))
      throw new Error("Assessment plan changed after authorization");
  } finally {
    journal.close();
  }
  const preview = await readAssessmentPreview(root, plan.previewId);
  if (hashJson(preview.quote.models[0]) !== hashJson(plan.model))
    throw new Error("Assessment model is outside the frozen preview");
  return plan;
}

/** Invoked only by the shared owned driver. Receipts and reservations prevent duplicate requests. */
export async function executeAssessment(
  root: string,
  id: string,
  token: string,
  signal: AbortSignal,
  adapters: ExecutionAdapters,
) {
  const plan = await assessmentPlan(root, id),
    preview = await readAssessmentPreview(root, plan.previewId);
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
        journal.read<AssessmentProgress>("assessment_progress", id)?.stopped
      )
        throw new Error("Assessment is stopped or no longer owned by this driver");
    } finally {
      journal.close();
    }
  };
  await beforeRequest();
  for (const unit of preview.units) {
    if (signal.aborted || (await assessmentProgress(root, id))?.stopped) return;
    const journal = await OperationJournal.open(root);
    let done: boolean;
    try {
      done = journal.read("assessment_units", `${id}:${unit.id}`) !== null;
    } finally {
      journal.close();
    }
    if (done) continue;
    await updateAssessment(root, id, { inFlight: unit.id, error: null });
    let result: AssessmentResult | null = null,
      error = unit.unavailable;
    try {
      if (!unit.evidenceSetId)
        throw new Error(unit.unavailable ?? "The evidence is not available.");
      const { material, set } = await readAssessmentEvidence(root, unit.evidenceSetId, unit.batch);
      if (
        set.manifestHash !== preview.sourceManifestHash ||
        set.operationId !== preview.selection.operationId ||
        set.subjectId !== unit.subjectId ||
        !preview.selection.subjectIds.includes(set.subjectId)
      )
        throw new Error("Assessment evidence differs from its authorized source");
      const response = await runJudgmentBatch({
        ...material,
        client: adapters.model([plan.model]),
        ledger,
        snapshot: plan.model,
        stage: `assessment:${unit.id}`,
        configuration: preview.configuration,
        presentation: preview.selection.presentation,
        beforeRequest,
        signal,
      });
      result = {
        operationId: id,
        unitId: unit.id,
        evidenceSetId: unit.evidenceSetId,
        treatmentIdentity: modelTreatmentIdentity(plan.model),
        decisions: response.decisions,
        addressedToEvaluator: response.addressedToEvaluator,
        responseHashes: response.responseHashes,
        costUsd: response.responses.some((item) => item.usage.costUsd === null)
          ? null
          : response.responses.reduce((sum, item) => sum + item.usage.costUsd!, 0),
      };
      await new RepositoryFiles(root).writeJsonOnce(
        `.basalt-evals/eval-operations/${id}/assessments/${unit.id}.json`,
        result,
      );
    } catch (caught) {
      if (signal.aborted || (await assessmentProgress(root, id))?.stopped) return;
      error = String(caught).slice(0, 1000);
      const spending = spendingProjection(await ledger.read());
      if (spending.pendingBilling || caught instanceof SpendingCeilingError) {
        await updateAssessment(root, id, { error });
        return;
      }
    }
    const records = await OperationJournal.open(root);
    try {
      records.transaction(() => {
        const key = `${id}:${unit.id}`;
        if (records.read("assessment_units", key)) return;
        records.put("assessment_units", key, {
          resultHash: result ? hashJson(result) : null,
          error,
        });
        if (result) resolveExecutionFailures(records, id, "assessment", unit.id);
        const progress = records.read<AssessmentProgress>("assessment_progress", id)!;
        // Under a diagnostic control, insufficient evidence is the answer being tested.
        const incomplete = result
          ? unit.condition === "original"
            ? result.decisions.filter((item) => item.verdict === "insufficient").length
            : 0
          : unit.criterionIds.length;
        const next = {
          ...progress,
          completed: progress.completed + unit.criterionIds.length - incomplete,
          incomplete: progress.incomplete + incomplete,
          inFlight: null,
          error: null,
        };
        records.put("assessment_progress", id, next);
        projectAssessment(records, next);
      });
    } finally {
      records.close();
    }
  }
  const reportPath = `.basalt-evals/eval-operations/${id}/assessment-report.json`;
  const records = await OperationJournal.open(root);
  try {
    const published = records.read<{ hash: string }>("assessment_reports", id);
    if (published) {
      if (hashJson(await new RepositoryFiles(root).json(reportPath)) !== published.hash)
        throw new Error("Published assessment report changed");
    } else {
      let report: AssessmentReport;
      try {
        report = await new RepositoryFiles(root).json<AssessmentReport>(reportPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        report = await assessmentReport(root, id);
        await new RepositoryFiles(root).writeJsonOnce(reportPath, report);
      }
      if (hashJson(report.plan) !== hashJson(plan))
        throw new Error("Assessment report belongs to another plan");
      records.put("assessment_reports", id, { hash: hashJson(report) });
    }
  } finally {
    records.close();
  }
  await updateAssessment(root, id, { finished: true, inFlight: null });
}

export async function assessmentReport(root: string, id: string): Promise<AssessmentReport> {
  const plan = await assessmentPlan(root, id),
    preview = await readAssessmentPreview(root, plan.previewId);
  const source = await frozenRunStatus(root, preview.selection.operationId, false);
  if (manifestHash(source.manifest) !== preview.sourceManifestHash)
    throw new Error("Assessment source manifest changed");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    preview.selection.revisionId,
  );
  const criteria = [
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ].map(({ id, statement }) => ({ id, statement }));
  const files = new RepositoryFiles(root),
    results = [];
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash: plan.inputHash }));
  const journal = await OperationJournal.open(root);
  try {
    for (const unit of preview.units) {
      const receipt = journal.read<{ resultHash: string | null; error: string | null }>(
        "assessment_units",
        `${id}:${unit.id}`,
      );
      let result: AssessmentResult | null = null,
        error = receipt?.error ?? unit.unavailable;
      if (receipt?.resultHash && unit.evidenceSetId) {
        try {
          const { material } = await readAssessmentEvidence(root, unit.evidenceSetId, unit.batch);
          result = await files.json<AssessmentResult>(
            `.basalt-evals/eval-operations/${id}/assessments/${unit.id}.json`,
          );
          const replay = await runJudgmentBatch({
            ...material,
            client: retainedResponseClient([plan.model]),
            ledger,
            snapshot: plan.model,
            stage: `assessment:${unit.id}`,
            configuration: preview.configuration,
            presentation: preview.selection.presentation,
            replayOnly: true,
          });
          if (
            result.operationId !== id ||
            result.unitId !== unit.id ||
            result.evidenceSetId !== unit.evidenceSetId ||
            result.treatmentIdentity !== modelTreatmentIdentity(plan.model) ||
            hashJson(result) !== receipt.resultHash ||
            hashJson(result.decisions) !== hashJson(replay.decisions) ||
            hashJson(result.addressedToEvaluator) !== hashJson(replay.addressedToEvaluator) ||
            hashJson(result.responseHashes) !== hashJson(replay.responseHashes)
          )
            throw new Error(
              "The judge answers in this run do not match the provider response that Basalt saved. Start a new run.",
            );
        } catch (caught) {
          result = null;
          error = String(caught).slice(0, 500);
        }
      }
      results.push({
        unitId: unit.id,
        subjectId: unit.subjectId,
        captureId: unit.captureId,
        condition: unit.condition,
        repeat: unit.repeat,
        substitution: unit.batch.substitution,
        pass: source.manifest.captureCells.find((capture) => capture.id === unit.captureId)!.pass,
        criterionIds: unit.criterionIds,
        result,
        error,
      });
    }
    const sensitivity = preview.selection.sensitivity;
    return {
      plan,
      criteria,
      selection: preview.selection,
      builds: preview.selection.subjectIds.map((subjectId) => ({
        id: subjectId,
        title: buildName(source.manifest, subjectId),
      })),
      planned: preview.quote.workload.criterionOutcomes,
      results,
      spending: spendingProjection(await ledger.read()),
      lineage: lineageSpending(journal, id),
      limitation:
        "This run checks saved evidence again. It makes no new builds and no new observations in Studio. The results of the code checks stay in the original run.",
      // The build of each unit is the cluster of the exact tests.
      evidenceUse: sensitivity
        ? evidenceUseReport({
            criterionIds: criteria.map((criterion) => criterion.id),
            controls: preview.selection.conditions.filter(
              (condition): condition is EvidenceSubstitutionKind => condition !== "original",
            ),
            plan: {
              originalRepeats: sensitivity.originalRepeats,
              labelRule: sensitivity.labelRule,
              requestedVerdict: sensitivity.canary?.requestedVerdict ?? null,
            },
            units: results.map((unit, index) => ({
              build: unit.subjectId,
              observation: unit.captureId,
              condition: unit.condition,
              repeat: unit.repeat,
              criterionIds: unit.criterionIds,
              decisions: unit.result?.decisions ?? null,
              expert: preview.units[index]!.expert,
            })),
            unavailable: preview.unavailableControls,
          })
        : null,
    };
  } finally {
    journal.close();
  }
}
