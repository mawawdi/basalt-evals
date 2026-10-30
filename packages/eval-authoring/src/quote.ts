import { criterionImageDimensions } from "./rendered-selection.js";
import {
  createRunQuote,
  type RunQuote,
  type QuotedModelWork,
} from "../../model-client/src/quote.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import type { EvalDraft } from "./input.js";
import { combineNativeWork, nativeLaunchWork } from "../../studio-runner/src/workload.js";
import { controlSpecs } from "./control-specs.js";
import { type EvalRevision } from "./compiler.js";
import {
  preparationRequests,
  MAX_PREPARATION_PROPOSAL_BYTES,
  MAX_PREPARATION_DIAGNOSTIC_BYTES,
  PREPARATION_ATTEMPTS,
} from "./preparation-request.js";
import { controlSourceRequest } from "./control-request.js";
import { batchJudgmentRequest } from "./batch-judgment.js";
import { scoringCriteria, scoringConfiguration } from "./scoring.js";
import { criterionMaterialTextBound, pendingCriterionMaterial } from "./criterion-material.js";
import { MAX_CORRECTION_ENVELOPE_BYTES } from "./proposal-correction.js";
import { coverageRequest, coverageScopes, MAX_COVERAGE_PLAN_BYTES } from "./coverage-request.js";

/**
 * Per-role request factory also used while selecting eligible provider endpoints. With a base,
 * each stage first corrects the carried criteria on the plan of the base. If they fail, the stage
 * prepares a new plan and new criteria, so the quote covers both paths.
 */
export function preparationModelWork(
  draft: EvalDraft,
  snapshot: ModelSnapshot,
  publicPreparationReused = false,
  preparationBase = false,
): QuotedModelWork[] {
  const model = { id: snapshot.id, maxOutputTokens: modelLimits(snapshot).maxOutputTokens };
  const requests = preparationRequests({ publicModel: model, privateModel: model, seed: 0 });
  const work: QuotedModelWork[] = [];
  const add = (
    request: Parameters<typeof quoteRequest>[0]["request"],
    futureTextBytes: number,
    expectedFutureTextBytes: number,
  ) =>
    work.push(
      quoteRequest({
        stage: "preparation",
        snapshot,
        request,
        calls: 1,
        futureTextBytes,
        expectedFutureTextBytes,
        imageDimensions: [],
      }),
    );
  const stagePrompts = draft.stages.map((stage) => stage.prompt);
  // Public preparation runs one time for the whole evaluation. Its proposal holds each stage.
  for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS; attempt += 1) {
    const correction =
      attempt > 1
        ? MAX_PREPARATION_PROPOSAL_BYTES * draft.stages.length + MAX_PREPARATION_DIAGNOSTIC_BYTES
        : 0;
    if (!publicPreparationReused)
      add(
        requests.preparePublic({
          stagePrompts,
          title: draft.title,
          slug: draft.slug,
          attempt,
          diagnostics: [],
          previousProposal: null,
        }),
        correction + (attempt > 1 ? MAX_CORRECTION_ENVELOPE_BYTES : 0),
        attempt > 1 ? 12000 * draft.stages.length : 0,
      );
  }
  // Private preparation runs one time for each stage, against the frozen public setup.
  for (const [index, stage] of draft.stages.entries())
    for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS; attempt += 1) {
      const correction =
        attempt > 1 ? MAX_PREPARATION_PROPOSAL_BYTES + MAX_PREPARATION_DIAGNOSTIC_BYTES : 0;
      const sources = {
        builderPrompt: stage.prompt,
        rubric: stage.rubric,
        criteria: stage.criteria,
        evaluationStage: {
          index: index + 1,
          count: draft.stages.length,
          earlierPrompts: stagePrompts.slice(0, index),
          gateCriterionIds: stage.gateCriterionIds,
        },
        publicProposal: null,
        attempt,
        diagnostics: [],
      };
      // Each criteria request on the plan of the base is a correction of the carried proposal.
      if (preparationBase)
        add(
          requests.preparePrivateCriteria({
            ...sources,
            plan: null,
            previousPrivateProposal: null,
          }),
          3 * MAX_PREPARATION_PROPOSAL_BYTES +
            MAX_PREPARATION_DIAGNOSTIC_BYTES +
            MAX_CORRECTION_ENVELOPE_BYTES,
          36000,
        );
      add(
        requests.preparePrivatePlan({ ...sources, previousPlan: null }),
        MAX_PREPARATION_PROPOSAL_BYTES +
          correction +
          (attempt > 1 ? MAX_CORRECTION_ENVELOPE_BYTES : 0),
        attempt > 1 ? 24000 : 12000,
      );
      // The criteria stage also reads the frozen private plan.
      add(
        requests.preparePrivateCriteria({ ...sources, plan: null, previousPrivateProposal: null }),
        2 * MAX_PREPARATION_PROPOSAL_BYTES +
          correction +
          (attempt > 1 ? MAX_CORRECTION_ENVELOPE_BYTES : 0),
        attempt > 1 ? 36000 : 24000,
      );
    }
  return work;
}

/**
 * The requests that compare the prepared plan with the authored criteria and the private checks.
 * A large set of criteria repeats the plan in each request, and the quote shows that.
 */
export function coverageModelWork(draft: EvalDraft, snapshot: ModelSnapshot): QuotedModelWork[] {
  // Each stage gets its own coverage notes.
  return draft.stages.flatMap((stage) =>
    coverageScopes(stage.criteria).map((scope) =>
      quoteRequest({
        stage: "coverage",
        snapshot,
        request: coverageRequest(
          { id: snapshot.id, maxOutputTokens: modelLimits(snapshot).maxOutputTokens },
          0,
          {
            builderPrompt: stage.prompt,
            rubric: stage.rubric,
            criteria: stage.criteria,
            plan: null,
          },
          scope,
        ),
        calls: 1,
        futureTextBytes: MAX_COVERAGE_PLAN_BYTES,
        expectedFutureTextBytes: 48_000,
        imageDimensions: [],
      }),
    ),
  );
}

/** Each request uses the same instructions and output cap as its runtime action. */
export function quotePreparation(
  draft: EvalDraft,
  planner: ModelSnapshot,
  coverageModel: ModelSnapshot | null,
  publicPreparationReused = false,
  preparationBase = false,
): RunQuote {
  return createRunQuote(
    {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 0,
      ...combineNativeWork(),
      criterionOutcomes: 0,
      judgmentBatches: 0,
      modelWork: [
        ...preparationModelWork(draft, planner, publicPreparationReused, preparationBase),
        ...(coverageModel ? coverageModelWork(draft, coverageModel) : []),
      ],
    },
    [...new Map([planner, coverageModel ?? planner].map((model) => [model.id, model])).values()],
    draft.id,
  );
}

/**
 * The reference quote of an evaluation: one stage after another, with the stage revisions in
 * stage order. Unknown future sources and evidence have explicit material bounds, not invented
 * token counts. A later stage also bounds the starting files of each control request.
 */
export function quoteControlPreparation(
  stages: EvalRevision[],
  controlModel: ModelSnapshot,
  gradingModel: ModelSnapshot,
): RunQuote {
  const workloads = stages.map((revision) => controlWorkload(revision, controlModel, gradingModel));
  const sum = (field: "criterionOutcomes" | "judgmentBatches") =>
    workloads.reduce((total, work) => total + work[field], 0);
  return createRunQuote(
    {
      independentBuilderTrials: 0,
      nativeCaptureRepetitions: 1,
      ...combineNativeWork(...workloads),
      criterionOutcomes: sum("criterionOutcomes"),
      judgmentBatches: sum("judgmentBatches"),
      modelWork: workloads.flatMap((work) => work.modelWork),
    },
    [...new Map([controlModel, gradingModel].map((model) => [model.id, model])).values()],
    stages[0]!.id,
  );
}

/** The reference work of one stage. */
function controlWorkload(
  revision: EvalRevision,
  controlModel: ModelSnapshot,
  gradingModel: ModelSnapshot,
) {
  const specs = controlSpecs(revision);
  const attempts = specs.length * 3;
  const later = revision.stage.index > 1;
  const work: QuotedModelWork[] = specs.flatMap((spec) =>
    [1, 2, 3].map((attempt) =>
      quoteRequest({
        stage: "controls",
        snapshot: controlModel,
        request: controlSourceRequest(
          {
            model: controlModel.id,
            seed: 0,
            maxOutputTokens: modelLimits(controlModel).maxOutputTokens,
          },
          {
            revision,
            spec,
            attempt,
            diagnostics: [],
            workingFiles: null,
            startingFiles: later ? [] : null,
          },
        ),
        calls: 1,
        futureTextBytes:
          (spec.kind === "working" ? 0 : 4 * 1024 * 1024) +
          (attempt > 1 ? 64 * 1024 : 0) +
          (later ? 4 * 1024 * 1024 : 0),
        expectedFutureTextBytes:
          (spec.kind === "working" ? 0 : 16_384) + (attempt > 1 ? 4096 : 0) + (later ? 16_384 : 0),
        imageDimensions: [],
      }),
    ),
  );
  const qualitative = [
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
  if (qualitative.length) {
    const imageDimensions = criterionImageDimensions(qualitative, revision.privateEvaluator);
    if (imageDimensions.length && !gradingModel.inputModalities.includes("image"))
      throw new Error("Reference scorer lacks image capability");
    const criteria = scoringCriteria(
      revision,
      qualitative.map((item) => item.id),
    );
    work.push(
      quoteRequest({
        stage: "grading",
        snapshot: gradingModel,
        request: batchJudgmentRequest({
          configuration: scoringConfiguration(revision, gradingModel),
          criteria,
          criterionEvidence: criteria.map((item) => pendingCriterionMaterial(item.id)),
          publicTask: revision.publicTask.prompt,
          context: { actors: [], intervals: [] },
          images: [],
          observation: null,
        }),
        // Reference judging asks one request per qualitative criterion; the batch shape bounds each.
        calls: attempts * qualitative.length,
        futureTextBytes:
          65536 +
          Buffer.byteLength(JSON.stringify(revision.seed.project), "utf8") +
          qualitative.reduce(
            (sum, item) => sum + criterionMaterialTextBound(item, revision.privateEvaluator.studio),
            0,
          ),
        expectedFutureTextBytes: 16_384,
        imageDimensions,
      }),
    );
  }
  return {
    ...nativeLaunchWork(revision.privateEvaluator.studio, attempts),
    criterionOutcomes: attempts * qualitative.length,
    judgmentBatches: qualitative.length ? attempts : 0,
    modelWork: work,
  };
}
