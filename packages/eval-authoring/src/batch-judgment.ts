import {
  ACTION_RECEIPT_SEMANTICS,
  DIAGNOSTIC_SEMANTICS,
} from "../../contracts/src/capabilities.js";
import {
  isEvidenceClass,
  isPolarity,
  stableJson,
  validRubricScore,
  type EvidenceClass,
  type Polarity,
  type RubricAnchor,
  type ScoreRange,
} from "../../contracts/src/index.js";
import type {
  ModelImage,
  ModelRequestReasoning,
  ModelSampling,
  ModelTurnRequest,
  ModelTurnResult,
} from "../../model-client/src/contracts.js";
import {
  ADDRESSED_TO_EVALUATOR_SCHEMA,
  answerVerdict,
  assertAnswerCapacity,
  BUILD_OUTPUT_GUARD,
  criterionAnswers,
  JUDGE_ANSWERS,
  MAX_RATIONALE_CHARS,
  parseAddressedToEvaluator,
  submittedJudgmentArguments,
  type AddressedToEvaluator,
  type JudgeAnswer,
  type JudgeVerdict,
} from "./criterion-response.js";
import type { actorCaptureViews } from "../../studio-runner/src/capture-view.js";
import { imageLabelPrefix } from "../../studio-runner/src/image-labels.js";
import type { CriterionMaterial } from "./criterion-material.js";
import { judgeEvidence } from "./judge-evidence.js";

export type JudgmentPresentation = "still" | "sequence" | "grounded-sequence";
export interface BatchCriterion {
  id: string;
  statement: string;
  authoredPassages: string[];
  required: boolean;
  /** The class that the rubric author set. Null for source review and fixed rules. */
  evidenceClass: EvidenceClass | null;
  /** The polarity that the rubric author set. Source review and fixed rules have presence. */
  polarity: Polarity;
  /** Fixed before/after questions for an appearance criterion tied to transitions. */
  comparisons: string[];
  anchors: RubricAnchor[] | null;
  scoreRange: ScoreRange | null;
  minimumPassingScore: number | null;
}
export interface BatchFrameContext {
  actors: string[];
  intervals: Array<{ frameId: string; actor: string; startMs: number; endMs: number }>;
  acquisition?: Awaited<ReturnType<typeof actorCaptureViews>>;
  /** The declared recorder cadence; null when no scenario sequence is presented. */
  samplingIntervalMs?: number | null;
  publicSeed?: unknown;
}
export interface GroundedObservation {
  observations: Array<{ frameIds: string[]; description: string }>;
  limitations: string[];
}
export interface BatchDecision {
  criterionId: string;
  /** The verdict of the answer. Present becomes violated and absent becomes satisfied. */
  verdict: JudgeVerdict;
  /** The exact answer word of the judge. */
  answer: JudgeAnswer;
  score: number | null;
  confidence: number;
  rationale: string;
}
/** One answer of the judge: a decision for each criterion and the report of the guard. */
interface BatchJudgment {
  decisions: BatchDecision[];
  addressedToEvaluator: AddressedToEvaluator;
}
export interface BatchRequestConfiguration {
  modelId: string;
  /** A best-effort provider seed. It does not make a judgment reproducible. */
  seed: number;
  maxOutputTokens: number;
  reasoning?: ModelRequestReasoning;
  /** The frozen sampling identity of the judge; see `recommendedRequestSampling`. */
  sampling: ModelSampling;
}

/**
 * Bounds of the grounded observation answer. For 64 frames, the longest answer is 47,701
 * characters, so it uses less than half of a 128k output limit and leaves room for reasoning.
 */
export const OBSERVATION_LIMITS = {
  observations: 32,
  frameIdsPerObservation: 64,
  limitations: 16,
  characters: 500,
} as const;

/**
 * The longest serialized observation in UTF-8 bytes, as a judgment request carries it. A
 * JSON escape can use six bytes for one character; a frame ID uses at most eleven bytes.
 */
export const MAX_OBSERVATION_JSON_BYTES =
  (OBSERVATION_LIMITS.observations + OBSERVATION_LIMITS.limitations) *
  (OBSERVATION_LIMITS.characters * 6 + OBSERVATION_LIMITS.frameIdsPerObservation * 11 + 64);

/** The label of each judge image must state its position in the request. */
export function assertImagePositions(images: ModelImage[]): void {
  images.forEach((image, index) => {
    if (!image.label.startsWith(imageLabelPrefix(index) + " "))
      throw new Error("A judge image label does not state its position in the request");
  });
}

export function assertCriteria(criteria: BatchCriterion[]) {
  if (!criteria.length || new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new Error("A judgment batch needs unique authored criteria");
  for (const criterion of criteria) {
    if (
      !criterion.statement.trim() ||
      !criterion.authoredPassages.length ||
      (criterion.evidenceClass !== null && !isEvidenceClass(criterion.evidenceClass)) ||
      !isPolarity(criterion.polarity) ||
      // A score cannot measure a thing that must be absent.
      (criterion.polarity === "absence" && criterion.anchors !== null) ||
      !Array.isArray(criterion.comparisons) ||
      (criterion.comparisons.length > 0 && criterion.evidenceClass !== "appearance") ||
      (criterion.anchors === null
        ? criterion.minimumPassingScore !== null || criterion.scoreRange !== null
        : (!criterion.scoreRange && !criterion.anchors.length) ||
          new Set(criterion.anchors.map((item) => item.score)).size !== criterion.anchors.length ||
          (criterion.minimumPassingScore !== null &&
            !validRubricScore(
              { anchors: criterion.anchors, scoreRange: criterion.scoreRange },
              criterion.minimumPassingScore,
            )))
    )
      throw new Error("Batch criteria must preserve authored scales and thresholds");
  }
}

/** This signature deliberately has no rubric, public task, evaluator outcome or source identity. */
export function observationRequest(
  configuration: BatchRequestConfiguration,
  context: BatchFrameContext,
  images: ModelImage[],
): ModelTurnRequest {
  assertImagePositions(images);
  return assertAnswerCapacity({
    model: configuration.modelId,
    seed: configuration.seed,
    maxOutputTokens: configuration.maxOutputTokens,
    ...(configuration.reasoning ? { reasoning: configuration.reasoning } : {}),
    sampling: configuration.sampling,
    system:
      "Describe only what is visible in the supplied frames, in the supplied order. A text label before each image states its image number, frame ID, player, selection roles, acquisition interval and offset from a transition anchor. Refer to frame IDs and acquisition intervals. Do not evaluate success or infer hidden state, intent, collision, or behavior between sampled frames. State ambiguity and unavailable information. Submit observations and limitations.",
    messages: [
      { role: "user", content: stableJson(context), ...(images.length ? { images } : {}) },
    ],
    tools: [
      {
        name: "submit_observations",
        description: "Record visible evidence before any rubric-based judgment.",
        parameters: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              maxItems: OBSERVATION_LIMITS.observations,
              items: {
                type: "object",
                properties: {
                  frameIds: {
                    type: "array",
                    minItems: 1,
                    maxItems: OBSERVATION_LIMITS.frameIdsPerObservation,
                    uniqueItems: true,
                    items: { type: "string", enum: context.intervals.map((item) => item.frameId) },
                  },
                  description: {
                    type: "string",
                    minLength: 1,
                    maxLength: OBSERVATION_LIMITS.characters,
                  },
                },
                required: ["frameIds", "description"],
                additionalProperties: false,
              },
            },
            limitations: {
              type: "array",
              maxItems: OBSERVATION_LIMITS.limitations,
              items: { type: "string", minLength: 1, maxLength: OBSERVATION_LIMITS.characters },
            },
          },
          required: ["observations", "limitations"],
          additionalProperties: false,
        },
      },
    ],
  });
}

/**
 * The pre-call gate. A criterion whose material has an unavailable reason never reaches a
 * model: its evidence cannot support its class, or required evidence was not acquired.
 */
export function judgedCriteria(
  criteria: BatchCriterion[],
  criterionEvidence: CriterionMaterial[],
): BatchCriterion[] {
  return criteria.filter(
    (criterion) =>
      !criterionEvidence.find((item) => item.criterionId === criterion.id)?.unavailable.length,
  );
}

interface BatchJudgmentInput {
  configuration: BatchRequestConfiguration;
  criteria: BatchCriterion[];
  publicTask: string;
  context: BatchFrameContext;
  images: ModelImage[];
  observation: GroundedObservation | null;
  criterionEvidence: CriterionMaterial[];
}

/** Validate the complete judgment input, gated criteria included. */
export function assertBatchJudgmentInput(input: BatchJudgmentInput): void {
  assertCriteria(input.criteria);
  if (
    input.criterionEvidence.length !== input.criteria.length ||
    new Set(input.criterionEvidence.map((item) => item.criterionId)).size !==
      input.criteria.length ||
    input.criteria.some(
      (criterion) => !input.criterionEvidence.some((item) => item.criterionId === criterion.id),
    )
  )
    throw new Error("Judgment requires an explicit evidence projection for every criterion");
  if (input.observation && input.images.length)
    throw new Error(
      "Grounded judgment consumes the retained observation, not another image presentation",
    );
}

/** Same request factory is used for quotes, dispatch and retained-response verification. */
export function batchJudgmentRequest(input: BatchJudgmentInput): ModelTurnRequest {
  assertBatchJudgmentInput(input);
  assertImagePositions(input.images);
  const criteria = judgedCriteria(input.criteria, input.criterionEvidence);
  if (!criteria.length)
    throw new Error("No criterion has evidence for its class; record insufficient without a call");
  const criterionEvidence = criteria.map((criterion) =>
    input.criterionEvidence.find((item) => item.criterionId === criterion.id)!,
  );
  return assertAnswerCapacity({
    model: input.configuration.modelId,
    seed: input.configuration.seed,
    maxOutputTokens: input.configuration.maxOutputTokens,
    ...(input.configuration.reasoning ? { reasoning: input.configuration.reasoning } : {}),
    sampling: input.configuration.sampling,
    system:
      "Judge every exact authored criterion independently against the supplied evidence. Preserve wording, conditions, exceptions, scales and thresholds. Do not invent aggregate scores, success deadlines, or implementation restrictions. A text label before each image states its image number, frame ID, player, selection roles, acquisition interval and offset from a transition anchor. A sampled frame cannot establish behavior between samples or finer timing; capture states the declared sampling interval. The capture field is Basalt's own record of the recording: players, frame intervals, camera views and the sampling interval. It is not build output. An action receipt describes input execution, not its effect. A successful move_to means the movement request was issued, not that the avatar arrived or caused the outcome; combine it with observations and sealed source. A failed action is observed input failure, not automatically an authored criterion violation. Use each criterion's signed observations, action receipts and sealed source for claims the pixels cannot establish, including object identity and runtime behavior. buildOutput.criterionEvidence names the evidence of each criterion by reference: O refers to buildOutput.signedObservations, A refers to buildOutput.signedActions, a path refers to buildOutput.sealedSources, and runtime true refers to buildOutput.signedRuntime. Each item appears one time, also when more than one criterion uses it. A motion trace gives its samples as a table. A constant column has one value for all samples. A row whose elapsedMs is [firstMs, lastMs, count] stands for count samples with the same values. Basalt writes each 32-bit value in the shortest decimal form that gives the same 32-bit value. Basalt calculates the summary of each column from the signed samples. A binding failure is an observed contract problem, never a default false, zero, or empty value; its timing and the authored wording determine whether it supports a violation or insufficient evidence. An earlier absent binding does not disprove a later valid outcome when the author supplied no deadline. Missing, unrelated or inadequate evidence requires insufficient. A numerical score without an authored passing threshold has unresolved acceptance. Return each criterion exactly once. The rubric author set the polarity of each criterion. For a presence criterion, answer satisfied, violated or insufficient. An absence criterion names a thing that the build must not show. For an absence criterion, report the presence of that thing: answer present when the evidence shows it, absent when the evidence shows that the build does not show it, or insufficient. Never answer satisfied or violated for an absence criterion, and never answer present or absent for a presence criterion. The rubric author set each evidenceClass. Use images only for an appearance criterion. Judge a timing, motion or causality criterion only from its signed runtime facts, action receipts and sealed source, because frames at two per second cannot establish timing, motion or causality. A role in an image label tells why the fixed selection chose the frame for a transition: before is the last frame before the transition starts, effect is inside the authored effect window, after-effect is the first frame after an observed state change, after-hold is the first frame after the declared hold, horizon-end is the last recorded frame of an effect that the recording never observed, end is the last frame of an actor, and uniform fills the frame budget. An action anchor is the action start. A state anchor is the observed effect. Answer the comparisons of a criterion from the frames that they name before you give its verdict. " +
      BUILD_OUTPUT_GUARD +
      " " +
      ACTION_RECEIPT_SEMANTICS +
      " " +
      DIAGNOSTIC_SEMANTICS,
    messages: [
      {
        role: "user",
        // All output of the build is in one data field. Basalt's own record of the recording is
        // apart from it, so the guard never reports Basalt's text as text of the build.
        content: stableJson({
          publicTask: input.publicTask,
          criteria,
          capture: input.context,
          buildOutput: {
            ...judgeEvidence(criterionEvidence),
            ...(input.observation ? { observation: input.observation } : {}),
          },
        }),
        ...(input.images.length ? { images: input.images } : {}),
      },
    ],
    tools: [
      {
        name: "submit_judgment_batch",
        description: "Judge each original human criterion, retaining independent uncertainty.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            addressedToEvaluator: ADDRESSED_TO_EVALUATOR_SCHEMA,
            decisions: {
              type: "array",
              minItems: criteria.length,
              maxItems: criteria.length,
              items: {
                type: "object",
                properties: {
                  criterionId: { type: "string", enum: criteria.map((item) => item.id) },
                  // Present and absent are only for an absence criterion.
                  verdict: {
                    type: "string",
                    enum: JUDGE_ANSWERS.filter((answer) =>
                      criteria.some((criterion) =>
                        criterionAnswers(criterion.polarity).includes(answer),
                      ),
                    ),
                  },
                  // An unscaled criterion has no score; only a scaled batch admits numbers.
                  score: criteria.every((criterion) => criterion.anchors === null)
                    ? { type: "null" }
                    : { anyOf: [{ type: "number" }, { type: "null" }] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  rationale: { type: "string", minLength: 1, maxLength: MAX_RATIONALE_CHARS },
                },
                required: ["criterionId", "verdict", "score", "confidence", "rationale"],
                additionalProperties: false,
              },
            },
          },
          required: ["addressedToEvaluator", "decisions"],
          additionalProperties: false,
        },
      },
    ],
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function parseObservation(
  response: ModelTurnResult,
  context: BatchFrameContext,
): GroundedObservation {
  const value = submittedJudgmentArguments(response, "submit_observations");
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "limitations,observations" ||
    !Array.isArray(value.observations) ||
    value.observations.length > OBSERVATION_LIMITS.observations ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > OBSERVATION_LIMITS.limitations ||
    value.limitations.some(
      (item) =>
        typeof item !== "string" || !item.trim() || item.length > OBSERVATION_LIMITS.characters,
    )
  )
    throw new Error("The judge model wrote sequence notes that do not have the required form.");
  for (const item of value.observations)
    if (
      !record(item) ||
      Object.keys(item).sort().join(",") !== "description,frameIds" ||
      typeof item.description !== "string" ||
      !item.description.trim() ||
      item.description.length > OBSERVATION_LIMITS.characters ||
      !Array.isArray(item.frameIds) ||
      !item.frameIds.length ||
      item.frameIds.length > OBSERVATION_LIMITS.frameIdsPerObservation ||
      new Set(item.frameIds).size !== item.frameIds.length ||
      item.frameIds.some((id) => !context.intervals.some((frame) => frame.frameId === id))
    )
      throw new Error(
        "The sequence notes name a frame that is not available, or name a frame more than one time.",
      );
  return value as unknown as GroundedObservation;
}
/** The guard report never changes a decision. It only sends the unit to a person. */
export function parseBatchJudgment(
  response: ModelTurnResult,
  criteria: BatchCriterion[],
): BatchJudgment {
  assertCriteria(criteria);
  const value = submittedJudgmentArguments(response, "submit_judgment_batch");
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "addressedToEvaluator,decisions" ||
    !Array.isArray(value.decisions) ||
    value.decisions.length !== criteria.length
  )
    throw new Error("The judge did not give exactly one answer for each criterion.");
  const addressedToEvaluator = parseAddressedToEvaluator(value.addressedToEvaluator);
  const seen = new Set<string>();
  const decisions: BatchDecision[] = [];
  for (const item of value.decisions) {
    if (
      !record(item) ||
      Object.keys(item).sort().join(",") !== "confidence,criterionId,rationale,score,verdict"
    )
      throw new Error("An answer from the judge does not have the required form.");
    const criterion = criteria.find((criterion) => criterion.id === item.criterionId);
    if (
      !criterion ||
      seen.has(criterion.id) ||
      !criterionAnswers(criterion.polarity).includes(item.verdict as JudgeAnswer) ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      typeof item.rationale !== "string" ||
      !item.rationale.trim() ||
      item.rationale.length > MAX_RATIONALE_CHARS
    )
      throw new Error(
        "An answer from the judge names an unknown criterion, repeats a criterion or has a value that is not valid, for example an answer word of the other polarity.",
      );
    seen.add(criterion.id);
    // The raw answer stays. The verdict of an absence answer is the verdict of the criterion.
    const answer = item.verdict as JudgeAnswer;
    const verdict = answerVerdict(answer);
    if (criterion.anchors === null) {
      if (item.score !== null)
        throw new Error("The judge gave a score for a criterion that has no score scale.");
    } else if (
      item.score === null
        ? verdict !== "insufficient"
        : !validRubricScore(
            { anchors: criterion.anchors, scoreRange: criterion.scoreRange },
            item.score,
          ) ||
          verdict !==
            (criterion.minimumPassingScore === null
              ? "insufficient"
              : (item.score as number) >= criterion.minimumPassingScore
                ? "satisfied"
                : "violated")
    )
      throw new Error(
        "The judge gave a score or an answer that does not agree with the score scale of the criterion or its minimum score for Met.",
      );
    decisions.push({
      criterionId: criterion.id,
      verdict,
      answer,
      score: item.score as number | null,
      confidence: item.confidence,
      rationale: item.rationale,
    });
  }
  return { decisions, addressedToEvaluator };
}
