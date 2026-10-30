import { hashJson } from "../../contracts/src/index.js";
import type {
  ReviewSelection,
  ReviewPopulation,
  ReviewUnit,
  ReviewTreatment,
} from "../../contracts/src/review.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import {
  assessmentPlan,
  readAssessmentPreview,
  assessmentReport,
  sensitivityTest,
} from "./assessment.js";
import { readOperationEvidence, releasedEvidenceItems } from "./evidence.js";
import { frozenRunStatus } from "./run-builder.js";
import { subjectEval } from "./run-manifest.js";
import type { AssessmentPreview } from "../../contracts/src/assessments.js";
import { reviewEvidenceBinding } from "./review-store.js";

/**
 * Reviews and comparisons bind one build and the evaluation of its run. A reassessment of more
 * builds, or of the criteria of another revision, is a recheck. It offers no treatment.
 */
async function singleBuildReassessment(root: string, preview: AssessmentPreview) {
  if (preview.selection.subjectIds.length !== 1) return false;
  const source = await frozenRunStatus(root, preview.selection.operationId, false);
  return (
    subjectEval(source.manifest, preview.selection.subjectIds[0]!).id ===
    preview.selection.revisionId
  );
}

export async function assessmentTreatment(root: string, id: string): Promise<ReviewTreatment> {
  const plan = await assessmentPlan(root, id),
    preview = await readAssessmentPreview(root, plan.previewId);
  if (sensitivityTest(preview))
    throw new Error(
      "You cannot use a sensitivity test in a review or a comparison. Choose a different run.",
    );
  if (!(await singleBuildReassessment(root, preview)))
    throw new Error(
      "You cannot use a recheck of several builds or of another evaluation version in a review or a comparison. Choose a different run.",
    );
  const body = {
    executionIdentityHash: plan.gradingSemanticsHash,
    componentIds: [] as string[],
    modelIdentity: modelTreatmentIdentity(plan.model),
    configuration: {
      modelId: plan.model.id,
      maxOutputTokens: preview.configuration.maxOutputTokens,
      ...(preview.configuration.reasoning ? { reasoning: preview.configuration.reasoning } : {}),
      sampling: preview.configuration.sampling,
    },
    // An assessment sends one sample of each request, with shared requests.
    judgeSettings: DEFAULT_JUDGE_SETTINGS,
    methods: ["batch criterion assessment"],
    presentation: preview.selection.presentation,
    evidenceCondition: "original" as const,
  };
  return {
    ...body,
    id: hashJson(body),
    label: `${plan.model.name} · ${body.presentation} · retained evidence`,
  };
}

/** The treatments an assessment offers to reviews and comparisons; a diagnostic offers none. */
export async function assessmentTreatments(root: string, id: string) {
  const plan = await assessmentPlan(root, id);
  const preview = await readAssessmentPreview(root, plan.previewId);
  return sensitivityTest(preview) || !(await singleBuildReassessment(root, preview))
    ? []
    : [await assessmentTreatment(root, id)];
}

export async function assessmentReviewPopulation(
  root: string,
  id: string,
  selection: ReviewSelection,
) {
  if (selection.purpose === "protocol")
    throw new Error("Optional reassessments cannot satisfy registered research gates");
  const report = await assessmentReport(root, id),
    treatment = await assessmentTreatment(root, id);
  const requested = selection.treatments.find((item) => item.operationId === id);
  if (requested && requested.treatmentId !== treatment.id)
    throw new Error("Assessment treatment changed");
  const operationId = report.selection.operationId;
  const status = await frozenRunStatus(root, operationId, false);
  // A reassessment has exactly one build; assessmentTreatment refuses a sensitivity test.
  const [subjectId] = report.selection.subjectIds;
  const evidence = await readOperationEvidence(root, operationId, { subjectId: subjectId! });
  const released = await releasedEvidenceItems(root, evidence);
  const units: ReviewUnit[] = [],
    exclusions: ReviewPopulation["exclusions"] = [];
  for (const result of report.results) {
    const capture = status.manifest.captureCells.find((cell) => cell.id === result.captureId)!;
    const item = released.find(
      (item) => item.viewId === capture.viewId && item.partition === capture.partition,
    );
    const pass = item?.passes.find((pass) => pass.number === capture.pass);
    for (const criterionId of result.criterionIds) {
      const decision = result.result?.decisions.find((item) => item.criterionId === criterionId);
      const criterion = item?.criteria.find((item) => item.id === criterionId);
      const automatic =
        decision && criterion
          ? decision.score !== null &&
            criterion.minimumPassingScore === null &&
            (criterion.anchors || criterion.scoreRange)
            ? ("scored" as const)
            : decision.verdict
          : null;
      if (
        !item ||
        !pass ||
        !criterion ||
        (selection.purpose === "audit" && (!automatic || automatic === "insufficient"))
      ) {
        exclusions.push({
          operationId: id,
          unitId: `${result.unitId}:${criterionId}`,
          treatmentId: treatment.id,
          reason: !item || !pass ? "unavailable_evidence" : "missing_outcome",
        });
        continue;
      }
      const body = {
        operationId,
        manifestHash: evidence.manifestHash,
        itemId: item.id,
        passId: pass.id,
        criterionId,
        binding: reviewEvidenceBinding(item, pass, criterion),
        automatic,
        automaticScore: decision?.score ?? null,
        method: "retained evidence assessment",
        treatmentId: treatment.id,
        automaticDecision: {
          operationId: id,
          recordId: result.unitId,
          criterionId,
          artifactHash: result.result ? hashJson(result.result) : null,
          configurationHash: hashJson(report.plan),
        },
      };
      units.push({ ...body, id: hashJson(body) });
    }
  }
  return { evidence, units, exclusions, treatment, plannedOutcomes: report.planned };
}
