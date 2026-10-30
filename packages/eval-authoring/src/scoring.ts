import type { EvalRevision } from "./compiler.js";
import { criterionAuthoredPassages } from "./compiler.js";
import { modelRoute, type ModelSnapshot } from "../../model-client/src/catalog.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import type { ModelRequestReasoning } from "../../model-client/src/contracts.js";
import { recommendedRequestSampling } from "../../model-client/src/sampling.js";
import type { QuotedModelWork } from "../../model-client/src/quote.js";
import { hashJson, type StudioSequenceView } from "../../contracts/src/index.js";
import { renderedSelection } from "./rendered-selection.js";
import type {
  BatchCriterion,
  BatchRequestConfiguration,
  JudgmentPresentation,
} from "./batch-judgment.js";

export function qualitativeCriteria(revision: EvalRevision) {
  return [
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
}
/** Fixed before/after questions. Code writes them from the view; no model chooses them. */
export function transitionComparisons(view: StudioSequenceView): string[] {
  return view.requiredTransitions.map(
    ({ id }) =>
      `Transition ${id}: compare the image with role before:${id} with the images with roles effect:${id}, after-effect:${id} and after-hold:${id}, or horizon-end:${id} if the recording never observed the effect. What does each actor see before the transition, and what does each actor see after it? Does that change satisfy this criterion?`,
  );
}

export function scoringCriteria(revision: EvalRevision, ids: string[]): BatchCriterion[] {
  const all = [...revision.privateEvaluator.deterministic, ...qualitativeCriteria(revision)];
  const view = revision.privateEvaluator.sequence;
  return ids.map((id) => {
    const criterion = all.find((item) => item.id === id);
    if (!criterion) throw new Error("Scoring criterion is absent from the frozen evaluation");
    const evidenceClass = "evidenceClass" in criterion ? criterion.evidenceClass : null;
    return {
      id,
      statement: criterion.statement,
      required: criterion.required,
      evidenceClass,
      // A code quality criterion and a fixed rule have no authored polarity.
      polarity: "polarity" in criterion ? criterion.polarity : "presence",
      comparisons:
        evidenceClass === "appearance" && view && renderedSelection(criterion).sequence
          ? transitionComparisons(view)
          : [],
      authoredPassages: criterionAuthoredPassages(revision, id),
      anchors: "anchors" in criterion ? criterion.anchors : null,
      scoreRange: "scoreRange" in criterion ? criterion.scoreRange : null,
      minimumPassingScore:
        "minimumPassingScore" in criterion ? criterion.minimumPassingScore : null,
    };
  });
}
export function scoringConfiguration(
  revision: EvalRevision,
  model: ModelSnapshot,
): BatchRequestConfiguration {
  return gradingConfiguration(model, Number.parseInt(revision.id.slice(0, 8), 16));
}

/** One policy for every grader, frozen before quoting and reused by request factories. */
export function gradingConfiguration(
  model: ModelSnapshot,
  seed: number,
): BatchRequestConfiguration {
  // Output is bounded only by the provider's own limit for the frozen endpoint; reasoning
  // keeps the endpoint's advertised effort or the provider default. Sampling sends the catalog
  // recommendation that the endpoint accepts, and records each value that it leaves unsent.
  const effort = modelRoute(model).reasoningEffort;
  const reasoning: ModelRequestReasoning = effort
    ? { kind: "effort", effort }
    : { kind: "provider_default" };
  return {
    modelId: model.id,
    seed,
    maxOutputTokens: modelLimits(model).maxOutputTokens,
    reasoning,
    sampling: recommendedRequestSampling(model),
  };
}

/** A saved quote cannot silently acquire a different grading allowance, reasoning or sampling. */
export function assertGradingQuote(
  configuration: BatchRequestConfiguration,
  work: QuotedModelWork[],
): void {
  const grading = work.filter(
    (item) => item.stage === "grading" && item.modelId === configuration.modelId,
  );
  if (
    !grading.length ||
    grading.some(
      (item) =>
        item.upper.outputTokens !== configuration.maxOutputTokens ||
        hashJson(item.reasoning ?? null) !== hashJson(configuration.reasoning ?? null) ||
        hashJson(item.sampling ?? null) !== hashJson(configuration.sampling),
    )
  )
    throw new Error("The judge settings differ from the saved preview. Make a new preview.");
}
export function scoringPresentation(revision: EvalRevision): JudgmentPresentation {
  return revision.privateEvaluator.sequence ? "sequence" : "still";
}
