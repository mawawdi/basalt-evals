import type { HarnessDefinition, PublicTask } from "../../contracts/src/index.js";
import { priceForUsage, type ModelSnapshot } from "../../model-client/src/catalog.js";
import { imageTokenRule } from "../../model-client/src/image-tokens.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import type { QuotedModelWork } from "../../model-client/src/quote.js";
import type { ModelTurnRequest } from "../../model-client/src/contracts.js";
import { assertRequestReasoning } from "../../model-client/src/reasoning.js";
import {
  imageDimensions,
  promptCapacity,
  requestTextBound,
} from "../../model-client/src/request-workload.js";
import type { PublicRepairContext } from "../../development/src/repair-context.js";
import { compactionRequest } from "./compaction.js";
import {
  builderRequest,
  harnessRequestReasoning,
  MAX_CONVERSATION_BYTES,
  MAX_MODEL_MESSAGE_BYTES,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_RESULT_BYTES,
} from "./index.js";

/**
 * Every turn retains bounded prior outputs, tool results and development images. A harness that
 * summarizes its context adds its summaries. Each summary carries the largest conversation.
 */
export function quoteBuilderTurns(input: {
  task: PublicTask;
  harness: HarnessDefinition;
  snapshot: ModelSnapshot;
  trials: number;
  repairContext?: PublicRepairContext;
  /** The prompts of the earlier stages of a staged evaluation. The first message lists them. */
  earlierPrompts?: string[];
  /** The public scenarios of a harness with development runs, or null. */
  development: {
    publicScenarios: string[];
    width: number | null;
    height: number | null;
  } | null;
}): QuotedModelWork[] {
  // The preview refuses a reasoning effort that the frozen endpoint set rejects.
  try {
    assertRequestReasoning(harnessRequestReasoning(input.harness).reasoning, input.snapshot);
  } catch {
    throw new Error(
      `The tool set ${input.harness.title} asks for a reasoning effort that ${input.snapshot.id} does not support. Choose another tool set or model.`,
    );
  }
  const request = {
    ...builderRequest({
      task: input.task,
      harness: input.harness,
      model: input.snapshot.id,
      seed: 0,
      ...(input.development ? { development: input.development } : {}),
      ...(input.earlierPrompts ? { earlierPrompts: input.earlierPrompts } : {}),
    }),
    maxOutputTokens: modelLimits(input.snapshot).maxOutputTokens,
  };
  if (input.repairContext)
    request.messages.push({
      role: "user",
      content: input.repairContext.summary,
      images: input.repairContext.images,
    });
  const repairDimensions = input.repairContext?.images.map(imageDimensions) ?? [];
  const turnWork = (
    turn: number,
    base: Omit<ModelTurnRequest, "maxOutputTokens">,
    calls: number,
  ): QuotedModelWork => {
    const futureTextBytes = Math.min(
      MAX_CONVERSATION_BYTES * 2,
      turn *
        (MAX_MODEL_MESSAGE_BYTES + MAX_TOOL_CALLS_PER_TURN * (MAX_TOOL_RESULT_BYTES * 2 + 1024)),
    );
    // Runtime replaces earlier image bytes when development returns a new set.
    // Before then, the parent's public frames remain in each request.
    const dimensions =
      input.development && turn > 0
        ? Array.from({ length: Math.max(4, repairDimensions.length) }, (_, index) => ({
            width:
              input.development!.width === null
                ? null
                : Math.max(input.development!.width, repairDimensions[index]?.width ?? 0),
            height:
              input.development!.height === null
                ? null
                : Math.max(input.development!.height, repairDimensions[index]?.height ?? 0),
          }))
        : repairDimensions;
    const sent = { ...base, maxOutputTokens: request.maxOutputTokens };
    const work = quoteRequest({
      stage: "builder",
      snapshot: input.snapshot,
      request: sent,
      calls,
      futureTextBytes,
      expectedFutureTextBytes: Math.min(futureTextBytes, turn * 4096),
      imageDimensions: dimensions,
    });
    return {
      ...work,
      upper: costliestSplit(input.snapshot, work, dimensions.length > 0, {
        largestInput: requestTextBound(sent) + futureTextBytes,
      }),
    };
  };
  const turns = Array.from({ length: input.harness.maxTurns }, (_, turn) =>
    turnWork(turn, request, input.trials),
  );
  const compaction = input.harness.compaction;
  if (compaction.kind === "none") return turns;
  // A summary replaces the conversation, so later turns stay inside their own bounds. Each
  // summary request carries at most the conversation of the last turn.
  const summary = compactionRequest({
    model: input.snapshot.id,
    seed: 0,
    messages: request.messages,
    reasoning: harnessRequestReasoning(input.harness),
  });
  return [
    ...turns,
    turnWork(input.harness.maxTurns - 1, summary, input.trials * compaction.maxSummaries),
  ];
}

/**
 * A builder request fits its output allowance to the context that remains. Thus its input can
 * grow past the room that the full output limit leaves, with less output. The upper bound
 * uses the costliest split: the largest input, or the start of a price tier.
 */
function costliestSplit(
  snapshot: ModelSnapshot,
  quoted: QuotedModelWork,
  images: boolean,
  bound: { largestInput: number },
): QuotedModelWork["upper"] {
  const upper = quoted.upper;
  // Without an image token rule, the images use the remaining context and no fit occurs.
  if (images && !imageTokenRule(snapshot)) return upper;
  const limits = modelLimits(snapshot);
  const room = limits.contextLength - upper.imageInputTokens;
  // The expected output stays inside the upper bound.
  const largest = Math.min(
    bound.largestInput,
    promptCapacity(snapshot, 1) - upper.imageInputTokens,
    room - (quoted.expected?.outputTokens ?? 1),
  );
  const starts = snapshot.endpoints.flatMap((endpoint) =>
    endpoint.tiers.map((tier) => tier.minPromptTokens - upper.imageInputTokens),
  );
  return [largest, ...starts]
    .filter((inputTokens) => inputTokens > upper.inputTokens && inputTokens <= largest)
    .map((inputTokens) => ({
      ...upper,
      inputTokens,
      outputTokens: Math.min(limits.maxOutputTokens, room - inputTokens),
    }))
    .reduce(
      (costliest, usage) =>
        priceForUsage(snapshot, usage) > priceForUsage(snapshot, costliest) ? usage : costliest,
      upper,
    );
}
