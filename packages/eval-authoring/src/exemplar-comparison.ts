import { stableJson } from "../../contracts/src/index.js";
import type { BuildAnswer } from "../../contracts/src/exemplars.js";
import type {
  ModelImage,
  ModelTurnRequest,
  ModelTurnResult,
} from "../../model-client/src/contracts.js";
import {
  MAX_PAIRED_CONTEXT_BYTES,
  type PairedFrameContext,
} from "../../studio-runner/src/paired-evidence.js";
import {
  assertCriteria,
  assertImagePositions,
  type BatchCriterion,
  type BatchRequestConfiguration,
} from "./batch-judgment.js";
import { evidenceClassGaps, type ExecutableCriterion } from "./criterion-material.js";
import {
  ADDRESSED_TO_EVALUATOR_SCHEMA,
  assertAnswerCapacity,
  BUILD_OUTPUT_GUARD,
  MAX_RATIONALE_CHARS,
  parseAddressedToEvaluator,
  submittedJudgmentArguments,
  type AddressedToEvaluator,
} from "./criterion-response.js";

/*
 * The exemplar comparison stream. It is a grading treatment of its own, separate from the
 * evidence presentations of the absolute judge. One request compares the build under
 * judgment with one exemplar for one appearance criterion. The request never says which
 * build is the exemplar.
 */

const BUILD_COMPARISON_TOOL = "submit_build_comparison";

export const BUILD_COMPARISON_SYSTEM =
  "Compare two builds of one task against one exact authored criterion. The builds have the neutral names Build A and Build B. Neither build is a correct answer, and the order of the builds has no meaning. A text label before each image states its image number, its build, frame ID, player, selection roles, acquisition interval and offset from a transition anchor. buildOutput pairs the images of the two builds that have the same player, recorded phase and time. A frame index never pairs two images. Compare each pair, then examine the unpaired images. Judge only the appearance and perceptibility that the images show. Sampled frames cannot show timing, motion or causality between samples, so do not judge them. Preserve the wording, conditions, exceptions and thresholds of the criterion. Answer the comparisons of the criterion for each build from the frames that they name. Then name the build that satisfies the criterion better. If the evidence of either build is missing, unrelated or inadequate for the criterion, or if you cannot tell which build satisfies it better, answer insufficient. Submit one answer. " +
  BUILD_OUTPUT_GUARD;

/** One answer of the comparison judge. */
interface BuildComparisonAnswer {
  rationale: string;
  better: BuildAnswer;
  addressedToEvaluator: AddressedToEvaluator;
}

/**
 * Reasons that a criterion cannot use the exemplar comparison. Only an appearance criterion
 * with presence, rendered evidence and an acceptance meaning can use it. No model call follows a
 * reason.
 */
export function exemplarComparisonGaps(criterion: ExecutableCriterion): string[] {
  if (!("evidenceClass" in criterion) || criterion.evidenceClass !== "appearance")
    return ["Only an appearance criterion can use anchor build pairs."];
  // "Which build shows it better" is not a valid question for a thing that must be absent.
  if (criterion.polarity === "absence")
    return ["An absence criterion cannot use anchor build pairs."];
  // An appearance criterion without rendered frames has a gap here too.
  const gaps = evidenceClassGaps(criterion);
  if (gaps.length) return gaps;
  if ("anchors" in criterion && criterion.minimumPassingScore === null)
    return [
      "This criterion has a score but no minimum score for Met. An anchor build cannot show the lowest level that meets it.",
    ];
  return [];
}

function pairedImageCount(context: PairedFrameContext): number {
  return context.pairs.length * 2 + context.unpaired.length;
}

/** The same request factory serves the quote, dispatch and the check of a retained response. */
export function buildComparisonRequest(input: {
  configuration: BatchRequestConfiguration;
  criterion: BatchCriterion;
  publicTask: string;
  context: PairedFrameContext;
  images: ModelImage[];
}): ModelTurnRequest {
  assertCriteria([input.criterion]);
  if (input.criterion.evidenceClass !== "appearance")
    throw new Error("Only an appearance criterion can use anchor build pairs.");
  assertImagePositions(input.images);
  if (
    input.context.builds.join() !== "A,B" ||
    pairedImageCount(input.context) !== input.images.length ||
    Buffer.byteLength(stableJson(input.context), "utf8") > MAX_PAIRED_CONTEXT_BYTES
  )
    throw new Error("A build comparison needs its exact paired images and bounded context");
  return assertAnswerCapacity({
    model: input.configuration.modelId,
    seed: input.configuration.seed,
    maxOutputTokens: input.configuration.maxOutputTokens,
    ...(input.configuration.reasoning ? { reasoning: input.configuration.reasoning } : {}),
    sampling: input.configuration.sampling,
    system: BUILD_COMPARISON_SYSTEM,
    messages: [
      {
        role: "user",
        // The paired frame context of both builds is build output, so it is only data.
        content: stableJson({
          publicTask: input.publicTask,
          criterion: input.criterion,
          buildOutput: input.context,
        }),
        ...(input.images.length ? { images: input.images } : {}),
      },
    ],
    tools: [
      {
        name: BUILD_COMPARISON_TOOL,
        description:
          "Name the build that satisfies the authored criterion better, or answer insufficient.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            addressedToEvaluator: ADDRESSED_TO_EVALUATOR_SCHEMA,
            rationale: { type: "string", minLength: 1, maxLength: MAX_RATIONALE_CHARS },
            better: { type: "string", enum: ["A", "B", "insufficient"] },
          },
          required: ["addressedToEvaluator", "rationale", "better"],
          additionalProperties: false,
        },
      },
    ],
  });
}

export function parseBuildComparison(response: ModelTurnResult): BuildComparisonAnswer {
  const value = submittedJudgmentArguments(response, BUILD_COMPARISON_TOOL);
  if (Object.keys(value).sort().join(",") !== "addressedToEvaluator,better,rationale")
    throw new Error(
      "The build comparison answer does not have exactly the fields addressedToEvaluator, better and rationale.",
    );
  const { better, rationale } = value;
  if (!["A", "B", "insufficient"].includes(String(better)))
    throw new Error("The build comparison answer names a build that is not A, B or insufficient.");
  if (typeof rationale !== "string" || !rationale.trim() || rationale.length > MAX_RATIONALE_CHARS)
    throw new Error(
      `The build comparison answer needs a rationale of 1 to ${MAX_RATIONALE_CHARS} characters.`,
    );
  return {
    better: better as BuildAnswer,
    rationale,
    addressedToEvaluator: parseAddressedToEvaluator(value.addressedToEvaluator),
  };
}
