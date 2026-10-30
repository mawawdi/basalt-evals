import { assessmentProgress } from "./assessment.js";
import { assessmentReviewPopulation } from "./assessment-review.js";
import { operationReviewTreatments } from "./review-treatments.js";
import { reviewerProfile } from "./reviewers.js";
import { randomBytes } from "node:crypto";
import { hashJson } from "../../contracts/src/index.js";
import {
  REVIEW_TRAINING_QUESTION_LIMIT,
  type ReviewPopulation,
  type ReviewPreview,
  type ReviewSelection,
  type ReviewUnit,
  type ReviewVerdict,
  type ReviewAutomaticDecision,
} from "../../contracts/src/review.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { sampleWithoutReplacement } from "../../experiments/src/audit.js";
import { operatorEvidence } from "./evidence-view.js";
import { readOperationEvidence, releasedEvidenceItems } from "./evidence.js";
import { frozenRunStatus } from "./run-builder.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import {
  readReviewAnswer,
  saveReviewArtifact,
  reviewBinding,
  reviewEvidenceBinding,
} from "./review-store.js";

function validateReviewSelection(value: ReviewSelection) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "operationIds,purpose,questionLimit,reviewer,treatments,unitIds" ||
    !["audit", "diagnostic", "protocol", "training"].includes(value.purpose) ||
    !Array.isArray(value.operationIds) ||
    !value.operationIds.length ||
    value.operationIds.length > 1000 ||
    new Set(value.operationIds).size !== value.operationIds.length ||
    value.operationIds.some((id) => !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(id)) ||
    typeof value.reviewer !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.reviewer) ||
    !Number.isSafeInteger(value.questionLimit) ||
    value.questionLimit < 1 ||
    value.questionLimit > 100000 ||
    !Array.isArray(value.treatments) ||
    value.treatments.length > value.operationIds.length ||
    value.treatments.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join(",") !== "operationId,treatmentId" ||
        !value.operationIds.includes(item.operationId) ||
        (item.treatmentId !== null && !/^[a-f0-9]{64}$/u.test(item.treatmentId)),
    ) ||
    new Set(value.treatments.map((item) => item.operationId)).size !== value.treatments.length ||
    !Array.isArray(value.unitIds) ||
    value.unitIds.length > 100000 ||
    new Set(value.unitIds).size !== value.unitIds.length ||
    value.unitIds.some((id) => !/^[a-f0-9]{64}$/u.test(id)) ||
    (value.purpose !== "diagnostic" && value.unitIds.length)
  )
    throw new Error("Invalid review selection");
  if (value.purpose === "protocol" && value.operationIds.length !== 1)
    throw new Error("A research review belongs to one frozen protocol");
  if (
    value.purpose === "training" &&
    (value.questionLimit > REVIEW_TRAINING_QUESTION_LIMIT || value.treatments.length)
  )
    throw new Error(
      `A training review can have ${REVIEW_TRAINING_QUESTION_LIMIT} questions or fewer. Do not choose a judge for a training review.`,
    );
}

/** Bindings that a training review used, or that a review that counts used. */
function usedBindings(
  journal: OperationJournal,
  kind: "training" | "labelling",
  bindings: string[],
) {
  return new Set(
    bindings.filter((binding) => journal.read(`review_${kind}_bindings`, binding) !== null),
  );
}

/**
 * Training items come only from released development evidence of ordinary runs. A review
 * that counts never uses them, and training never uses an item of a review that counts.
 */
async function trainingPopulation(root: string, selection: ReviewSelection) {
  const evidence: ReviewPopulation["evidence"] = [],
    units: ReviewUnit[] = [],
    exclusions: ReviewPopulation["exclusions"] = [];
  let plannedOutcomes = 0;
  for (const operationId of [...selection.operationIds].sort()) {
    if (await assessmentProgress(root, operationId))
      throw new Error(
        "A reassessment does not have its own evidence. Choose its source run for a training review.",
      );
    const status = await frozenRunStatus(root, operationId, false);
    if (status.manifest.protocol)
      throw new Error(
        "A training review cannot use a run from registered research. Choose a different run.",
      );
    const retained = await readOperationEvidence(root, operationId);
    const released = new Set((await releasedEvidenceItems(root, retained)).map((item) => item.id));
    evidence.push(retained);
    for (const item of retained.items)
      for (const pass of item.passes)
        for (const criterion of item.criteria) {
          plannedOutcomes++;
          const binding = reviewEvidenceBinding(item, pass, criterion);
          const body = {
            operationId,
            manifestHash: retained.manifestHash,
            itemId: item.id,
            passId: pass.id,
            criterionId: criterion.id,
            binding,
            automatic: null,
            automaticScore: null,
            method: "training",
            treatmentId: null,
            automaticDecision: null,
          };
          const id = hashJson(body);
          if (item.partition !== "development" || !released.has(item.id)) {
            exclusions.push({
              operationId,
              unitId: id,
              treatmentId: null,
              reason: item.partition === "development" ? "unavailable_evidence" : "withheld",
            });
            continue;
          }
          units.push({ ...body, id });
        }
  }
  return {
    evidence,
    units,
    exclusions,
    treatments: [] as ReviewPopulation["treatments"],
    plannedOutcomes,
    sourcePlannedOutcomes: plannedOutcomes,
  };
}

/** Explicit preview verifies and freezes a population. It creates no assignments or releases. */
export async function previewReviewBatch(
  root: string,
  selection: ReviewSelection,
): Promise<ReviewPreview> {
  validateReviewSelection(selection);
  await reviewerProfile(root, selection.reviewer);
  const evidence: ReviewPopulation["evidence"] = [],
    units: ReviewUnit[] = [],
    exclusions: ReviewPopulation["exclusions"] = [],
    treatments: ReviewPopulation["treatments"] = [];
  let plannedOutcomes = 0,
    sourcePlannedOutcomes = 0;
  if (selection.purpose === "training") {
    const training = await trainingPopulation(root, selection);
    evidence.push(...training.evidence);
    units.push(...training.units);
    exclusions.push(...training.exclusions);
    plannedOutcomes = training.plannedOutcomes;
    sourcePlannedOutcomes = training.sourcePlannedOutcomes;
  }
  for (const operationId of selection.purpose === "training"
    ? []
    : [...selection.operationIds].sort()) {
    if (await assessmentProgress(root, operationId)) {
      const projected = await assessmentReviewPopulation(root, operationId, selection);
      const existing = evidence.find((item) => item.operationId === projected.evidence.operationId);
      if (existing) {
        for (const item of projected.evidence.items)
          if (!existing.items.some((prior) => prior.id === item.id)) existing.items.push(item);
      } else evidence.push(projected.evidence);
      for (const unit of projected.units) {
        if (
          units.some(
            (prior) =>
              prior.operationId === unit.operationId &&
              prior.passId === unit.passId &&
              prior.criterionId === unit.criterionId,
          )
        )
          throw new Error(
            "Two selected runs have answers for the same criterion and observation. Remove one of these runs.",
          );
        units.push(unit);
      }
      exclusions.push(...projected.exclusions);
      plannedOutcomes += projected.plannedOutcomes;
      sourcePlannedOutcomes += projected.plannedOutcomes;
      treatments.push({
        operationId,
        treatment: projected.treatment,
        plannedOutcomes: projected.plannedOutcomes,
      });
      continue;
    }
    const status = await frozenRunStatus(root, operationId, false);
    if (selection.purpose === "protocol") {
      if (!status.manifest.protocol)
        throw new Error("Research assignments require a registered protocol");
      const registered = await readRegisteredExperiment(
        root,
        status.manifest.protocol.registrationId,
      );
      if (registered.reviewer !== selection.reviewer)
        throw new Error("Research review must use its registered reviewer authority");
    }
    const catalog = operationReviewTreatments(status.manifest);
    const choices = catalog.treatments.filter(
      (t) => selection.purpose !== "audit" || t.evidenceCondition === "original",
    );
    const requested = selection.treatments.find((t) => t.operationId === operationId);
    if (selection.purpose !== "protocol" && !requested && choices.length > 1)
      throw new Error("Choose one judge for each run. Then select Preview sample.");
    const chosen =
      selection.purpose === "protocol"
        ? null
        : requested
          ? choices.find((t) => t.id === requested.treatmentId)
          : choices.length === 1
            ? choices[0]
            : null;
    if (
      selection.purpose !== "protocol" &&
      requested &&
      ((requested.treatmentId !== null && !chosen) ||
        (requested.treatmentId === null && choices.length))
    )
      throw new Error(
        "The selected judge is not available for this review. Choose a different judge.",
      );
    const retained = await readOperationEvidence(root, operationId);
    const released = await releasedEvidenceItems(root, retained);
    const existing = evidence.find((item) => item.operationId === retained.operationId);
    if (existing) {
      for (const item of retained.items)
        if (!existing.items.some((prior) => prior.id === item.id)) existing.items.push(item);
    } else evidence.push(retained);
    const tally = { operationId, treatment: chosen ?? null, plannedOutcomes: 0 };
    treatments.push(tally);
    const deterministic = chosen ? { operationId, treatment: null, plannedOutcomes: 0 } : tally;
    if (selection.purpose === "protocol") {
      const status = await frozenRunStatus(root, operationId, false);
      if (!status.manifest.protocol)
        throw new Error("Research assignments require a registered protocol");
      const registered = await readRegisteredExperiment(
        root,
        status.manifest.protocol.registrationId,
      );
      if (registered.reviewer !== selection.reviewer)
        throw new Error("Research review must use its registered reviewer authority");
      const { plan } = registered;
      for (const group of plan.reviewGroups) {
        const subjectId =
          status.manifest.protocol.subjectBindings[group.subjectId] ?? group.subjectId;
        const item = retained.items.find(
          (item) =>
            item.subjectId === subjectId &&
            item.viewId === group.viewId &&
            item.partition === group.partition,
        );
        const evaluation = status.manifest.evals.find((evaluation) =>
          plan.captures.some(
            (capture) => group.captureIds.includes(capture.id) && capture.evalId === evaluation.id,
          ),
        );
        if (!evaluation) throw new Error("Protocol review lacks an evaluation binding");
        for (const captureId of group.captureIds)
          for (const criterionId of evaluation.requiredCriterionIds) {
            plannedOutcomes++;
            sourcePlannedOutcomes++;
            tally.plannedOutcomes++;
            const capture = plan.captures.find((capture) => capture.id === captureId)!;
            const pass = item?.passes.find((pass) => pass.number === capture.pass);
            if (!item || !pass || !released.some((released) => released.id === item.id)) {
              exclusions.push({
                operationId,
                treatmentId: null,
                unitId: `${captureId}:${criterionId}`,
                reason: item && pass ? "withheld" : "unavailable_evidence",
              });
              continue;
            }
            add(item.id, pass.id, criterionId, null, null, "registered_protocol", null, null);
          }
      }
    } else {
      const projected = await operatorEvidence(root, operationId, retained);
      sourcePlannedOutcomes += projected.candidates.reduce(
        (sum, candidate) => sum + candidate.cells.length,
        0,
      );
      for (const candidate of projected.candidates)
        for (const cell of candidate.cells) {
          if (cell.treatment && cell.treatment.id !== chosen?.id) {
            if (selection.purpose === "audit" && cell.treatment.evidenceCondition !== "original")
              exclusions.push({
                operationId,
                unitId: cell.id,
                treatmentId: cell.treatment.id,
                reason: "diagnostic_control",
              });
            continue;
          }
          plannedOutcomes++;
          if (cell.treatment) tally.plannedOutcomes++;
          else {
            if (deterministic !== tally && deterministic.plannedOutcomes === 0)
              treatments.push(deterministic);
            deterministic.plannedOutcomes++;
          }
          const item = retained.items.find((item) => item.id === cell.itemId);
          if (!item || !cell.passId) {
            exclusions.push({
              operationId,
              unitId: cell.id,
              treatmentId: cell.treatment?.id ?? null,
              reason: "unavailable_evidence",
            });
            continue;
          }
          const criterion = item.criteria.find((criterion) => criterion.id === cell.criterionId)!;
          const automatic: ReviewVerdict | null =
            cell.score !== null &&
            criterion.minimumPassingScore === null &&
            (criterion.anchors || criterion.scoreRange)
              ? "scored"
              : (cell.verdict ??
                (cell.outcome === "verified"
                  ? "satisfied"
                  : cell.outcome === "rejected"
                    ? "violated"
                    : null));
          if (selection.purpose === "audit" && (!automatic || automatic === "insufficient")) {
            exclusions.push({
              operationId,
              unitId: cell.id,
              treatmentId: cell.treatment?.id ?? null,
              reason: "missing_outcome",
            });
            continue;
          }
          add(
            item.id,
            cell.passId,
            cell.criterionId,
            automatic,
            cell.score,
            cell.method,
            cell.treatment?.id ?? null,
            cell.automaticDecision,
          );
        }
    }
    function add(
      itemId: string,
      passId: string,
      criterionId: string,
      automatic: ReviewVerdict | null,
      automaticScore: number | null,
      method: string,
      treatmentId: string | null,
      automaticDecision: ReviewAutomaticDecision | null,
    ) {
      const item = retained.items.find((item) => item.id === itemId)!,
        pass = item.passes.find((pass) => pass.id === passId)!;
      const criterion = item.criteria.find((criterion) => criterion.id === criterionId);
      if (!criterion) throw new Error("Question lacks its human-authored criterion");
      const binding = reviewEvidenceBinding(item, pass, criterion);
      const body = {
        operationId,
        manifestHash: retained.manifestHash,
        itemId,
        passId,
        criterionId,
        binding,
        automatic,
        automaticScore,
        method,
        treatmentId,
        automaticDecision,
      };
      const previous = units.find(
        (unit) =>
          unit.operationId === operationId &&
          unit.passId === passId &&
          unit.criterionId === criterionId,
      );
      if (previous)
        throw new Error(
          "The selection has two answers for the same criterion and observation. Remove a run or choose a different judge.",
        );
      units.push({ ...body, id: hashJson(body) });
    }
  }
  // Training and the reviews that count never share an item, so training cannot teach answers.
  const separated = await OperationJournal.open(root);
  try {
    const kind = selection.purpose === "training" ? "labelling" : "training";
    const used = usedBindings(
      separated,
      kind,
      units.map((unit) => unit.binding),
    );
    for (const unit of units.filter((unit) => used.has(unit.binding)))
      exclusions.push({
        operationId: unit.automaticDecision?.operationId ?? unit.operationId,
        unitId: unit.id,
        treatmentId: unit.treatmentId,
        reason: kind,
      });
    units.splice(0, units.length, ...units.filter((unit) => !used.has(unit.binding)));
  } finally {
    separated.close();
  }
  const populationBody = {
    operations: evidence.map((item) => ({ id: item.operationId, manifestHash: item.manifestHash })),
    evidence,
    treatments,
    units,
    plannedOutcomes,
    sourcePlannedOutcomes,
    exclusions,
  };
  const population: ReviewPopulation = { ...populationBody, id: hashJson(populationBody) };
  // Visible candidate text can instruct a judge. It routes the unit to a person; the
  // automatic decision stays unchanged.
  const routedPass = (unit: ReviewUnit) =>
    evidence
      .find((item) => item.operationId === unit.operationId)
      ?.items.find((item) => item.id === unit.itemId)
      ?.passes.find((pass) => pass.id === unit.passId)?.reviewRoute === "scene_text";
  await saveReviewArtifact(root, "populations", population);
  const seed = randomBytes(32).toString("hex");
  if (
    selection.purpose === "diagnostic" &&
    selection.unitIds.some((id) => !units.some((unit) => unit.id === id))
  )
    throw new Error("A diagnostic requires explicit questions from the available population");
  const selectedUnitIds =
    selection.purpose === "audit" || selection.purpose === "training"
      ? sampleWithoutReplacement(
          units.map((unit) => unit.id),
          selection.questionLimit,
          seed,
        )
      : selection.purpose === "diagnostic"
        ? (selection.unitIds.length
            ? selection.unitIds
            : units
                .filter(
                  (unit) =>
                    unit.automatic === "violated" || unit.automatic === null || routedPass(unit),
                )
                .map((unit) => unit.id)
          ).slice(0, selection.questionLimit)
        : units.map((unit) => unit.id);
  if (selection.purpose === "protocol" && selection.questionLimit < selectedUnitIds.length)
    throw new Error(
      `The frozen protocol requires ${selectedUnitIds.length} available questions; its workload cannot be reduced`,
    );
  const journal = await OperationJournal.open(root);
  let reusable = 0;
  try {
    // Training answers are never reused.
    for (const unitId of selection.purpose === "training" ? [] : selectedUnitIds) {
      const { unit } = reviewBinding(population, unitId);
      const ref = journal.read<{ id: string }>(
        "review_labels",
        hashJson({ reviewer: selection.reviewer, binding: unit.binding }),
      );
      if (ref) {
        const answer = await readReviewAnswer(root, ref.id);
        if (
          answer.reviewer === selection.reviewer &&
          answer.binding === unit.binding &&
          (selection.purpose !== "protocol" || answer.purpose === "protocol")
        )
          reusable++;
      }
    }
  } finally {
    journal.close();
  }
  const body = {
    populationId: population.id,
    selection,
    seed,
    selectedUnitIds,
    eligible: units.length,
    plannedOutcomes,
    excluded: exclusions.length,
    reusable,
    createdAt: new Date().toISOString(),
  };
  const preview = { ...body, id: hashJson(body) };
  await saveReviewArtifact(root, "previews", preview);
  return preview;
}
