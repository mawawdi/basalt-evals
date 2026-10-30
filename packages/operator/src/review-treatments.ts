import type { ReviewTreatmentCatalog } from "../../contracts/src/console.js";
import { assessmentProgress } from "./assessment.js";
import { assessmentTreatments } from "./assessment-review.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import type { ReviewTreatment } from "../../contracts/src/review.js";
import { EVIDENCE_CONDITION_LABELS } from "../../contracts/src/assessments.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import type { JudgeSettings } from "../../contracts/src/judge-settings.js";
import { judgeSampleGroups } from "../../experiments/src/judge-samples.js";

import { frozenRunStatus } from "./run-builder.js";

/** The judge settings in the words of a treatment label. The default adds no words. */
function judgeSettingsLabel(settings: JudgeSettings) {
  return [
    settings.grouping === "per_criterion" ? " · one criterion per request" : "",
    settings.samples > 1 ? ` · ${settings.samples} judge samples` : "",
  ].join("");
}

/**
 * Frozen configuration, never a display-name heuristic or a live model lookup. A unit is one
 * capture, criterion and sample group. The samples of a group share one treatment, and a review
 * binds their combined answer, so the map has one record for each sample group.
 */
export function operationReviewTreatments(manifest: RunOperationManifest) {
  const byRecord = new Map<string, ReviewTreatment | null>();
  const treatments = new Map<string, ReviewTreatment>();
  const add = (
    recordId: string,
    configuration: ReviewTreatment["configuration"],
    judgeSettings: JudgeSettings,
    methods: string[],
    presentation: string,
    evidenceCondition: ReviewTreatment["evidenceCondition"],
  ) => {
    const model = manifest.modelSnapshots.find((model) => model.id === configuration.modelId);
    if (!model) throw new Error("Grader treatment has no frozen provider identity");
    const body = {
      componentIds: [] as string[],
      modelIdentity: modelTreatmentIdentity(model),
      configuration,
      judgeSettings,
      methods: [...methods].sort(),
      presentation,
      evidenceCondition,
    };
    const treatment = {
      ...body,
      id: hashJson(body),
      label: `${model.name} · ${presentation} · ${EVIDENCE_CONDITION_LABELS[evidenceCondition]}${judgeSettingsLabel(judgeSettings)}`,
    };
    treatments.set(treatment.id, treatment);
    byRecord.set(recordId, treatment);
  };
  // A grading cell is a code check, so it has no judge treatment.
  for (const cell of manifest.gradingCells) byRecord.set(cell.id, null);
  const groups = judgeSampleGroups(manifest.judgmentBatches);
  for (const group of groups) {
    const batch = group.batches[0]!;
    add(
      group.id,
      {
        modelId: batch.configuration.modelId,
        maxOutputTokens: batch.configuration.maxOutputTokens,
        ...(batch.configuration.reasoning ? { reasoning: batch.configuration.reasoning } : {}),
        sampling: batch.configuration.sampling,
      },
      { samples: group.batches.length, grouping: batch.grouping },
      ["visual"],
      batch.presentation,
      batch.substitution?.kind ?? "original",
    );
  }
  // A normal run's source/code and rendered checks are complementary parts of one
  // grading stream. Requiring an either/or choice would silently drop coverage.
  if (manifest.protocol === null && treatments.size > 1) {
    const units = groups.flatMap(({ batches: [batch] }) =>
      batch!.criterionIds.map((id) => `${batch!.captureCellId}:${id}`),
    );
    if (new Set(units).size === units.length) {
      const components = [...treatments.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
      const body = {
        componentIds: components.map((c) => c.id),
        modelIdentity: hashJson(components.map((c) => c.modelIdentity)),
        methods: [...new Set(components.flatMap((c) => c.methods))].sort(),
        presentation: "authored source and rendered evidence",
        evidenceCondition: "original" as const,
        configuration: components[0]!.configuration,
        judgeSettings: components[0]!.judgeSettings,
      };
      const combined = {
        ...body,
        id: hashJson(body),
        label: "Selected judge · authored source and rendered evidence",
      };
      treatments.clear();
      treatments.set(combined.id, combined);
      for (const [id, treatment] of byRecord) if (treatment) byRecord.set(id, combined);
    }
  }
  return { treatments: [...treatments.values()], byRecord };
}
export async function reviewTreatmentCatalog(
  root: string,
  operationIds: string[],
): Promise<ReviewTreatmentCatalog> {
  if (
    !Array.isArray(operationIds) ||
    operationIds.length > 1000 ||
    !operationIds.length ||
    new Set(operationIds).size !== operationIds.length
  )
    throw new Error("Choose 1 to 1,000 different runs.");
  const items = [];
  for (const operationId of operationIds) {
    if (typeof operationId !== "string" || !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId))
      throw new Error("Invalid run identity");
    const assessment = await assessmentProgress(root, operationId);
    const treatments = assessment
      ? await assessmentTreatments(root, operationId)
      : operationReviewTreatments((await frozenRunStatus(root, operationId, false)).manifest)
          .treatments;
    const journal = await OperationJournal.open(root);
    let title: string;
    try {
      title =
        journal.read<{ title: string }>("catalog_runs", operationId)?.title ?? "Evaluation run";
    } finally {
      journal.close();
    }
    items.push({ operationId, title, treatments });
  }
  return { items };
}
