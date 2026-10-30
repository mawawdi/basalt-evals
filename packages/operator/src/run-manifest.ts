import {
  assertEvidenceSubstitution,
  type RunEvalReference,
  type RunOperationManifest,
  type RunSubject,
  type RunUnit,
  type RunView,
} from "../../contracts/src/execution.js";
import {
  assertStudioCollectionPlan,
  assertStudioSequenceView,
  assertTreatment,
  hashJson,
  type StudioCollectionPlan,
  type Treatment,
} from "../../contracts/src/index.js";
import { assertSequencePlan, type SequencePlan } from "../../studio-runner/src/sequence.js";
import { assertRequestReasoning } from "../../model-client/src/reasoning.js";
import { recommendedRequestSampling } from "../../model-client/src/sampling.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import { JUDGE_GROUPINGS, MAX_JUDGE_SAMPLES } from "../../contracts/src/judge-settings.js";
import { isModelConcurrency } from "../../contracts/src/execution-limits.js";

const manifestHashes = new WeakMap<RunOperationManifest, string>();

/**
 * A frozen manifest's identity, computed once per object. The first call deep-freezes
 * the manifest, so any later mutation throws instead of leaving a stale identity.
 */
export function manifestHash(manifest: RunOperationManifest): string {
  let hash = manifestHashes.get(manifest);
  if (hash === undefined) {
    hash = hashJson(manifest);
    deepFreeze(manifest);
    manifestHashes.set(manifest, hash);
  }
  return hash;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

export function generatedSubjects(manifest: RunOperationManifest): RunSubject[] {
  return manifest.subjects.filter(
    (subject) => subject.kind === "generated" || subject.kind === "repair",
  );
}

export function operationTreatments(manifest: RunOperationManifest): Treatment[] {
  return generatedSubjects(manifest).map((subject) => {
    if (!subject.builder) throw new Error("Generated subject lacks a builder treatment");
    return subject.builder;
  });
}

/**
 * The model of the paid requests of a unit, or null for a unit without model requests. A build
 * uses the model of its treatment. A judgment uses the model of its batch.
 */
export function unitModelId(
  manifest: RunOperationManifest,
  unit: Pick<RunUnit, "stage" | "unitId">,
): string | null {
  if (unit.stage === "builder") {
    const treatment = operationTreatments(manifest).find((item) => item.id === unit.unitId);
    if (!treatment) throw new Error("Build is absent from the frozen operation");
    return treatment.model.id;
  }
  if (unit.stage === "judgment") {
    const batch = manifest.judgmentBatches.find((item) => item.id === unit.unitId);
    if (!batch) throw new Error("Judgment is absent from the frozen operation");
    return batch.configuration.modelId;
  }
  return null;
}

/**
 * The build that a unit belongs to: the build itself, or the build of its observation. A unit of
 * the whole run, such as preparation, has none.
 */
export function unitSubjectId(
  manifest: RunOperationManifest,
  unit: Pick<RunUnit, "stage" | "unitId">,
): string | null {
  if (manifest.subjects.some((subject) => subject.id === unit.unitId)) return unit.unitId;
  const captureCellId =
    unit.stage === "final_capture"
      ? unit.unitId
      : unit.stage === "judgment"
        ? manifest.judgmentBatches.find((batch) => batch.id === unit.unitId)?.captureCellId
        : unit.stage === "grading"
          ? manifest.gradingCells.find((cell) => cell.id === unit.unitId)?.captureCellId
          : undefined;
  return manifest.captureCells.find((cell) => cell.id === captureCellId)?.treatmentId ?? null;
}

export function operationSubject(manifest: RunOperationManifest, id: string): RunSubject {
  const subject = manifest.subjects.find((item) => item.id === id);
  if (!subject) throw new Error("Subject is absent from the frozen operation");
  return subject;
}

export function subjectEval(manifest: RunOperationManifest, id: string): RunEvalReference {
  const subject = operationSubject(manifest, id);
  const evaluation = manifest.evals.find((item) => item.id === subject.evalId);
  if (!evaluation) throw new Error("Subject has no frozen evaluation");
  return evaluation;
}

export function capturePlan(manifest: RunOperationManifest, cellId: string): StudioCollectionPlan {
  return captureView(manifest, cellId).plan;
}

export function captureView(manifest: RunOperationManifest, cellId: string): RunView {
  const cell = manifest.captureCells.find((item) => item.id === cellId);
  if (!cell) throw new Error("Capture is absent from the frozen operation");
  const view = subjectEval(manifest, cell.treatmentId).views.find(
    (item) => item.id === cell.viewId && item.partition === cell.partition,
  );
  if (!view) throw new Error("Capture has no frozen view");
  return view;
}

/**
 * The pairing tolerance of an observation: two frames of two builds pair when their offsets
 * from one anchor differ by at most the largest unrecorded gap of its sequence view.
 */
export function pairingToleranceMs(manifest: RunOperationManifest, captureId: string): number {
  return captureView(manifest, captureId).sequence?.maximumGapMs ?? 0;
}

/**
 * The observation of one check: the grading cell of a code check, or the sample group of a
 * judge check with its criterion. Evidence cells and benchmark marks name a check this way.
 */
export function checkCapture(manifest: RunOperationManifest, checkId: string, criterionId: string) {
  const id =
    manifest.gradingCells.find((cell) => cell.id === checkId)?.captureCellId ??
    manifest.judgmentBatches.find((batch) => `${batch.sampleGroupId}:${criterionId}` === checkId)
      ?.captureCellId;
  return manifest.captureCells.find((cell) => cell.id === id) ?? null;
}

/** The observations of a build with a Studio plan, by pass. */
export function planCaptures(
  manifest: RunOperationManifest,
  subjectId: string,
  plan: RunView["plan"],
): RunOperationManifest["captureCells"] {
  const planHash = hashJson(plan);
  return manifest.captureCells
    .filter(
      (cell) =>
        cell.treatmentId === subjectId &&
        hashJson(captureView(manifest, cell.id).plan) === planHash,
    )
    .sort((a, b) => a.pass - b.pass);
}

export function frozenSequencePlan(
  manifest: RunOperationManifest,
  cellId: string,
  sourceHash: string,
): SequencePlan | null {
  const view = captureView(manifest, cellId);
  if (!view.sequence) return null;
  return {
    schema: "basalt-evals/sequence-plan",
    suiteHash: manifestHash(manifest),
    sourceHash,
    implementationCommit: manifest.implementationCommit,
    viewId: view.id,
    ...view.sequence,
  };
}

/** Each model snapshot of the run has exactly one request concurrency in the limits. */
function validConcurrency(manifest: RunOperationManifest): boolean {
  const concurrency = manifest.modelConcurrency as unknown;
  if (!concurrency || typeof concurrency !== "object" || Array.isArray(concurrency)) return false;
  const models = new Set(manifest.modelSnapshots.map((snapshot) => snapshot.id));
  const entries = Object.entries(concurrency);
  return (
    entries.length === models.size &&
    entries.every(([model, value]) => models.has(model) && isModelConcurrency(value))
  );
}

export function assertManifest(manifest: RunOperationManifest): void {
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const id = (value: unknown) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,100}$/u.test(value);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    manifest.schema !== "basalt-evals/run-operation-manifest" ||
    !id(manifest.id) ||
    !hash(manifest.inputHash) ||
    ![
      manifest.quoteId,
      manifest.quoteHash,
      manifest.buildIdentityHash,
      manifest.connectorArtifactHash,
    ].every(hash) ||
    (manifest.quoteSelectionId !== null && !hash(manifest.quoteSelectionId)) ||
    !/^[a-f0-9]{40,64}$/u.test(manifest.implementationCommit) ||
    !Number.isFinite(manifest.ceilingUsd) ||
    manifest.ceilingUsd < 0 ||
    !Number.isFinite(manifest.workloadCeilingUsd) ||
    manifest.workloadCeilingUsd < 0 ||
    !Number.isFinite(manifest.checkingCeilingUsd) ||
    manifest.checkingCeilingUsd < 0 ||
    !manifest.evals.length ||
    !["all", "code", "none"].includes(manifest.gradingMode) ||
    (manifest.gradingMode === "none" &&
      (generatedSubjects(manifest).length > 0 || manifest.gradingCells.length > 0)) ||
    (manifest.gradingMode !== "all" && manifest.judgmentBatches.length > 0) ||
    !unique(manifest.evals.map((item) => item.id)) ||
    !unique(manifest.subjects.map((item) => item.id)) ||
    !unique(manifest.selectedModelIds) ||
    !unique(manifest.selectedHarnessIds) ||
    manifest.selectedModelIds.some(
      (model) => !manifest.modelSnapshots.some((snapshot) => snapshot.id === model),
    ) ||
    !validConcurrency(manifest) ||
    Object.values(manifest.planned).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    generatedSubjects(manifest).length !== manifest.planned.independentBuilderTrials ||
    manifest.gradingCells.length +
      manifest.judgmentBatches.reduce((sum, batch) => sum + batch.criterionIds.length, 0) !==
      manifest.planned.criterionOutcomes ||
    manifest.judgmentBatches.length !== manifest.planned.judgmentBatches ||
    !unique(manifest.judgmentBatches.map((batch) => batch.id)) ||
    !unique(manifest.captureCells.map((item) => item.id)) ||
    !unique(manifest.gradingCells.map((item) => item.id)) ||
    !unique(manifest.gates.map((gate) => gate.id)) ||
    !Array.isArray(manifest.unreviewedClaims) ||
    (manifest.protocol !== null &&
      (!hash(manifest.protocol.hash) ||
        !hash(manifest.protocol.registrationId) ||
        Object.values(manifest.protocol.subjectBindings).some(
          (id) => !manifest.subjects.some((subject) => subject.id === id),
        ) ||
        ![
          "detector_calibration",
          "repair_discovery",
          "matched_repair",
          "harness_effectiveness",
        ].includes(manifest.protocol.kind)))
  )
    throw new Error("Invalid frozen run operation manifest");
  for (const evaluation of manifest.evals) {
    if (
      ![
        evaluation.id,
        evaluation.draftId,
        evaluation.publicContentHash,
        evaluation.rubricHash,
        evaluation.validationRecordHash,
      ].every(hash) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{12}$/u.test(evaluation.taskId) ||
      !unique(evaluation.requiredCriterionIds) ||
      evaluation.requiredCriterionIds.some((value) => !id(value)) ||
      !evaluation.views.length ||
      !unique(evaluation.views.map((view) => view.id))
    )
      throw new Error("Invalid frozen eval reference");
    if (evaluation.controlSetHash !== null && !hash(evaluation.controlSetHash))
      throw new Error("Invalid optional reference-test identity");
    const stage = evaluation.stage;
    if (
      !stage ||
      typeof stage !== "object" ||
      Object.keys(stage).sort().join(",") !==
        "count,earlierPrompts,firstRevisionId,gateCriterionIds,index" ||
      !hash(stage.firstRevisionId) ||
      !Number.isSafeInteger(stage.index) ||
      !Number.isSafeInteger(stage.count) ||
      stage.index < 1 ||
      stage.index > stage.count ||
      stage.count > 6 ||
      (stage.index === 1) !== (stage.firstRevisionId === evaluation.id) ||
      !Array.isArray(stage.earlierPrompts) ||
      stage.earlierPrompts.length !== stage.index - 1 ||
      stage.earlierPrompts.some((prompt) => typeof prompt !== "string" || !prompt.trim()) ||
      !Array.isArray(stage.gateCriterionIds) ||
      !unique(stage.gateCriterionIds) ||
      (stage.index === stage.count && stage.gateCriterionIds.length > 0) ||
      stage.gateCriterionIds.some((id) => !evaluation.requiredCriterionIds.includes(id))
    )
      throw new Error("Invalid frozen evaluation stage");
    for (const view of evaluation.views) {
      if (!id(view.id) || !["development", "withheld"].includes(view.partition))
        throw new Error("Invalid frozen evaluation view");
      assertStudioCollectionPlan(view.plan);
      if (view.sequence) {
        assertSequencePlan({
          schema: "basalt-evals/sequence-plan",
          suiteHash: manifestHash(manifest),
          sourceHash: "0".repeat(64),
          implementationCommit: manifest.implementationCommit,
          viewId: view.id,
          ...view.sequence,
        });
        assertStudioSequenceView(view.sequence, view.plan);
      }
    }
  }
  // A run holds consecutive stages of a staged evaluation, each one time and in stage order. A run
  // from saved builds can start at a later stage, because its first builds start from saved sources.
  const stagedEvaluations = new Map<string, RunEvalReference[]>();
  for (const evaluation of manifest.evals) {
    const stages = stagedEvaluations.get(evaluation.stage.firstRevisionId) ?? [];
    stages.push(evaluation);
    stagedEvaluations.set(evaluation.stage.firstRevisionId, stages);
  }
  for (const stages of stagedEvaluations.values())
    if (
      stages.some(
        (stage, index) =>
          stage.stage.index !== stages[0]!.stage.index + index ||
          stage.stage.count !== stages[0]!.stage.count,
      )
    )
      throw new Error("A staged evaluation lacks a stage or has its stages out of order");
  const children = new Set<string>();
  for (const subject of manifest.subjects) {
    const evaluation = subjectEval(manifest, subject.id);
    if (!Number.isSafeInteger(subject.stageIndex) || subject.stageIndex !== evaluation.stage.index)
      throw new Error("A subject has another stage than its evaluation");
    // A repair starts from its saved parent source, so it needs no build of the stage before it.
    if (subject.parentSubjectId === null) {
      if (subject.stageIndex > 1 && subject.kind === "generated")
        throw new Error("A build of a later stage needs the build of the stage before it");
      continue;
    }
    const parent = manifest.subjects.find((item) => item.id === subject.parentSubjectId);
    const parentEvaluation = parent ? subjectEval(manifest, parent.id) : null;
    if (
      subject.kind !== "generated" ||
      !parent ||
      !["generated", "repair"].includes(parent.kind) ||
      children.has(parent.id) ||
      parent.stageIndex !== subject.stageIndex - 1 ||
      parentEvaluation!.stage.firstRevisionId !== evaluation.stage.firstRevisionId ||
      parent.builder!.model.id !== subject.builder!.model.id ||
      parent.builder!.harness.id !== subject.builder!.harness.id ||
      parent.builder!.repetition !== subject.builder!.repetition
    )
      throw new Error("A later stage must continue the build of its own model and repetition");
    children.add(parent.id);
  }
  for (const subject of manifest.subjects) {
    if (subject.builder) assertTreatment(subject.builder);
    const evaluation = subjectEval(manifest, subject.id);
    const generated = subject.kind === "generated" || subject.kind === "repair";
    if (
      !id(subject.id) ||
      (generated
        ? !subject.builder ||
          subject.id !== subject.builder.id ||
          evaluation.taskId !== subject.builder.task.id
        : subject.builder !== null) ||
      !["generated", "retained", "control", "repair"].includes(subject.kind) ||
      (generated ? subject.sourceId !== null : !hash(subject.sourceId)) ||
      (subject.kind === "repair"
        ? !hash(subject.parentSourceId)
        : subject.parentSourceId !== null) ||
      (subject.publicFeedbackId !== null &&
        (subject.kind !== "repair" || !hash(subject.publicFeedbackId))) ||
      (generated &&
        (!manifest.selectedModelIds.includes(subject.builder!.model.id) ||
          !manifest.selectedHarnessIds.includes(subject.builder!.harness.id)))
    )
      throw new Error("Invalid frozen subject source or treatment");
  }
  const gateIds = new Set(manifest.gates.map((gate) => gate.id));
  const visiting = new Set<string>();
  const checked = new Set<string>();
  const checkGate = (gateId: string) => {
    if (visiting.has(gateId)) throw new Error("Operation gates contain a cycle");
    if (checked.has(gateId)) return;
    const gate = manifest.gates.find((item) => item.id === gateId);
    if (
      !gate ||
      !id(gate.id) ||
      !["review", "selection"].includes(gate.kind) ||
      !unique(gate.requires)
    )
      throw new Error("Invalid operation gate");
    visiting.add(gateId);
    for (const dependency of gate.requires) checkGate(dependency);
    visiting.delete(gateId);
    checked.add(gateId);
  };
  for (const gate of manifest.gates) checkGate(gate.id);
  if (
    !unique(
      manifest.captureCells.map((cell) =>
        JSON.stringify([cell.treatmentId, cell.viewId, cell.partition, cell.pass]),
      ),
    )
  )
    throw new Error("Duplicate capture pass");
  // Indexed once: these checks run on every verified read of a large frozen manifest.
  const captures = new Map(manifest.captureCells.map((cell) => [cell.id, cell]));
  const models = new Map<string, RunOperationManifest["modelSnapshots"][number]>();
  for (const model of manifest.modelSnapshots)
    if (!models.has(model.id)) models.set(model.id, model);
  const coverage = new Set<string>();
  const codeChecks = new Set(manifest.gradingCells.map((grade) => grade.criterionId));
  for (const grade of manifest.gradingCells)
    coverage.add(JSON.stringify([grade.captureCellId, grade.criterionId]));
  for (const batch of manifest.judgmentBatches)
    if (batch.substitution === null)
      for (const criterionId of batch.criterionIds)
        coverage.add(JSON.stringify([batch.captureCellId, criterionId]));
  for (const cell of manifest.captureCells) {
    capturePlan(manifest, cell.id);
    if (
      !id(cell.id) ||
      !Number.isSafeInteger(cell.pass) ||
      cell.pass < 1 ||
      !unique(cell.requires) ||
      cell.requires.some((gate) => !gateIds.has(gate))
    )
      throw new Error("Invalid frozen capture");
    // A run with only code checks covers each required code check that it plans.
    const required = subjectEval(manifest, cell.treatmentId).requiredCriterionIds;
    for (const criterionId of manifest.gradingMode === "none"
      ? []
      : manifest.gradingMode === "code"
        ? required.filter((id) => codeChecks.has(id))
        : required)
      if (!coverage.has(JSON.stringify([cell.id, criterionId])))
        throw new Error("Capture lacks required criterion coverage");
  }
  for (const cell of manifest.gradingCells)
    if (
      !id(cell.id) ||
      !id(cell.criterionId) ||
      cell.method !== "deterministic" ||
      !captures.has(cell.captureCellId)
    )
      throw new Error("Invalid frozen grading cell");
  for (const batch of manifest.judgmentBatches) {
    const capture = captures.get(batch.captureCellId);
    const model = models.get(batch.configuration.modelId);
    if (
      !id(batch.id) ||
      !capture ||
      !model ||
      !id(batch.sampleGroupId) ||
      !Number.isSafeInteger(batch.sample) ||
      batch.sample < 1 ||
      batch.sample > MAX_JUDGE_SAMPLES ||
      !(JUDGE_GROUPINGS as readonly string[]).includes(batch.grouping) ||
      (batch.grouping === "per_criterion" && batch.criterionIds.length !== 1) ||
      batch.revisionId !== subjectEval(manifest, capture.treatmentId).id ||
      !batch.criterionIds.length ||
      !unique(batch.criterionIds) ||
      batch.criterionIds.some((value) => !id(value)) ||
      !["still", "sequence", "grounded-sequence"].includes(batch.presentation) ||
      !Number.isSafeInteger(batch.configuration.seed) ||
      batch.configuration.maxOutputTokens !== modelLimits(model).maxOutputTokens ||
      !modelLimits(model).supportedParameters.includes("tools") ||
      !model.inputModalities.includes("image")
    )
      throw new Error("Invalid frozen judgment batch");
    assertRequestReasoning(batch.configuration.reasoning, model);
    if (hashJson(batch.configuration.sampling) !== hashJson(recommendedRequestSampling(model)))
      throw new Error("Frozen judgment sampling differs from its frozen model recommendation");
    if (batch.substitution) {
      assertEvidenceSubstitution(batch.substitution);
      const donor =
        batch.substitution.donorCaptureCellId === null
          ? undefined
          : captures.get(batch.substitution.donorCaptureCellId);
      if (
        batch.substitution.donorCaptureCellId !== null &&
        (!donor ||
          donor.partition !== capture.partition ||
          donor.treatmentId === capture.treatmentId ||
          (batch.substitution.kind !== "unrelated" && donor.viewId !== capture.viewId))
      )
        throw new Error("Invalid presentation substitution provenance");
    }
  }
  // The samples of one group are identical requests, numbered from 1 without a gap.
  const sampleGroups = new Map<string, RunOperationManifest["judgmentBatches"]>();
  for (const batch of manifest.judgmentBatches)
    sampleGroups.set(batch.sampleGroupId, [
      ...(sampleGroups.get(batch.sampleGroupId) ?? []),
      batch,
    ]);
  for (const group of sampleGroups.values()) {
    const request = ({ id: _id, sample: _sample, ...rest }: (typeof group)[number]) =>
      hashJson(rest);
    if (
      group.some((batch) => request(batch) !== request(group[0]!)) ||
      group
        .map((batch) => batch.sample)
        .sort((a, b) => a - b)
        .some((sample, index) => sample !== index + 1)
    )
      throw new Error("Invalid frozen judge sample group");
  }
}
