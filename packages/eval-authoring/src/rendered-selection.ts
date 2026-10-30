import {
  MAXIMUM_PRESENTED_FRAMES,
  type EvaluatorSpec,
  type StudioCollectionPlan,
  type StudioSequenceView,
} from "../../contracts/src/index.js";
import type { ExecutableCriterion } from "./criterion-material.js";
import type { JudgeGrouping } from "../../contracts/src/judge-settings.js";
import { sequenceFrameBudget } from "../../studio-runner/src/presentation.js";

export function renderedSelection(criterion: ExecutableCriterion) {
  return "captureIds" in criterion
    ? { captureIds: criterion.captureIds, sequence: criterion.sequence }
    : "evidence" in criterion
      ? { captureIds: criterion.evidence.captureIds, sequence: criterion.evidence.sequence }
      : { captureIds: [], sequence: false };
}

export function requiresImages(criterion: ExecutableCriterion): boolean {
  const selected = renderedSelection(criterion);
  return selected.sequence || selected.captureIds.length > 0;
}

/**
 * The judgment requests of one capture. With `shared` requests, the criteria that select
 * rendered evidence share one request with images. The other criteria share one request with
 * no images, so they never see the images of another criterion. The compiler gives timing,
 * motion and causality criteria no rendered evidence, so they are always in the request with no
 * images. With `per_criterion`, each criterion has its own request, in the authored sequence.
 */
export function judgmentGroups<T extends ExecutableCriterion>(
  criteria: T[],
  grouping: JudgeGrouping,
): Array<{ images: boolean; criteria: T[] }> {
  if (grouping === "per_criterion")
    return criteria.map((criterion) => ({
      images: requiresImages(criterion),
      criteria: [criterion],
    }));
  return [
    { images: true, criteria: criteria.filter((criterion) => requiresImages(criterion)) },
    { images: false, criteria: criteria.filter((criterion) => !requiresImages(criterion)) },
  ].filter((group) => group.criteria.length > 0);
}

/**
 * Upper bound from the same fixed selection and frame budget that dispatch uses, not a model
 * context maximum. A still keeps one frame per transition and one end frame for each actor. A
 * sequence holds at most the frame budget. More frames give insufficient evidence, not a cut.
 */
export function sequenceImageDimensions(
  view: StudioSequenceView,
  plan: StudioCollectionPlan,
  presentation: "still" | "sequence" | "grounded-sequence",
  phaseCaptureCount = 0,
) {
  const scenario = plan.scenarios.find((scenario) => scenario.id === view.scenarioId);
  if (!scenario) throw new Error("Rendered workload references an unknown scenario");
  const budget = sequenceFrameBudget(view, phaseCaptureCount);
  const count =
    presentation === "still"
      ? Math.min(budget, plan.actors.length * (view.requiredTransitions.length + 1))
      : budget;
  return Array.from({ length: count }, () => ({
    width: view.viewport?.width ?? null,
    height: view.viewport?.height ?? null,
  }));
}

export function criterionImageDimensions(
  criteria: ExecutableCriterion[],
  evaluator: EvaluatorSpec,
) {
  const selections = criteria.map(renderedSelection);
  const phases = [...new Set(selections.flatMap((selection) => selection.captureIds))].map(() => ({
    width: null,
    height: null,
  }));
  if (phases.length > MAXIMUM_PRESENTED_FRAMES)
    throw new Error(
      "The criteria select more than 64 images for one judge request. Edit the evaluation so that its criteria select fewer images.",
    );
  if (!selections.some((selection) => selection.sequence)) return phases;
  if (!evaluator.sequence) throw new Error("Sequence evidence has no frozen acquisition view");
  const dimensions = [
    ...sequenceImageDimensions(evaluator.sequence, evaluator.studio, "sequence", phases.length),
    ...phases,
  ];
  if (dimensions.length > MAXIMUM_PRESENTED_FRAMES)
    throw new Error(
      "The criteria select more than 64 images for one judge request. Edit the evaluation so that its criteria select fewer images.",
    );
  return dimensions;
}
