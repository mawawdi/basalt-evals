import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAnswerCapacity,
  submittedJudgmentArguments,
  JudgmentTruncationError,
  MAX_RATIONALE_CHARS,
  maximumAnswerCharacters,
} from "../packages/eval-authoring/src/criterion-response.js";
import type { ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { outputLimitCut } from "../packages/model-client/src/output-limit.js";
import {
  batchJudgmentRequest,
  OBSERVATION_LIMITS,
  observationRequest,
  parseBatchJudgment,
} from "../packages/eval-authoring/src/batch-judgment.js";
import { combineSamples, sampleVote } from "../packages/experiments/src/judge-samples.js";
import { pendingCriterionMaterial } from "../packages/eval-authoring/src/criterion-material.js";
import { catalogRecommendedSampling } from "../packages/model-client/src/sampling.js";

const judgment = {
  criterionId: "visible-beacon",
  verdict: "violated",
  confidence: 0.95,
  rationale: "The signed observation says the required role is absent.",
};

test("an output-limited response cannot become a judgment even when its visible JSON looks complete", () => {
  for (const [item, truncation] of [
    [response(""), "reasoning_exhausted"],
    [response("   "), "reasoning_exhausted"],
    [response(JSON.stringify(judgment)), "answer_truncated"],
    [
      response("", [{ id: "one", name: "submit_unscaled_judgment", arguments: judgment }]),
      "answer_truncated",
    ],
  ] as const) {
    assert.equal(item.kind, "assistant");
    if (item.kind !== "assistant") continue;
    item.stopReason = "max_tokens";
    item.responseFacts.finishReason = "length";
    assert.equal(outputLimitCut(item), truncation);
    assert.throws(
      () => submittedJudgmentArguments(item, "submit_unscaled_judgment"),
      (error: unknown) =>
        error instanceof JudgmentTruncationError &&
        error.truncation === truncation &&
        error.message.includes(`(${truncation})`) &&
        /stays incomplete for review/.test(error.message),
    );
  }
  assert.equal(outputLimitCut(response(JSON.stringify(judgment))), null);
});

test("a judge request needs an output limit that holds the longest answer of its tool", () => {
  const tool = {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            criterionId: { type: "string", enum: ["a", "bb"] },
            score: { anyOf: [{ type: "number" }, { type: "null" }] },
            rationale: { type: "string", maxLength: 10 },
            frames: {
              type: "array",
              maxItems: 64,
              uniqueItems: true,
              items: { type: "string", enum: ["frame-1", "frame-2"] },
            },
          },
        },
      },
    },
  };
  // {"decisions":[item,item]} with item = {"criterionId":"bb","score":<24>,"rationale":"<10>","frames":["frame-1","frame-2"]}
  const item = 2 + (15 + 4) + (9 + 24) + (13 + 12) + (10 + 2 + 2 * 10);
  assert.equal(maximumAnswerCharacters(tool), 2 + 13 + 2 + 2 * (item + 1));
  assert.equal(maximumAnswerCharacters({ type: "string" }), Infinity);
  assert.equal(maximumAnswerCharacters({ type: "array", items: { type: "null" } }), Infinity);
  const request = {
    model: "test/model",
    seed: 1,
    system: "Judge.",
    messages: [{ role: "user" as const, content: "Evidence." }],
    tools: [{ name: "submit", description: "Submit.", parameters: tool }],
    maxOutputTokens: maximumAnswerCharacters(tool),
  };
  assert.equal(assertAnswerCapacity(request), request);
  assert.throws(
    () => assertAnswerCapacity({ ...request, maxOutputTokens: request.maxOutputTokens - 1 }),
    /cannot|admits an answer of \d+ characters/,
  );
});

test("the longest judge answers for 64 frames or 64 criteria use at most half of a 128k output limit", () => {
  const configuration = {
    modelId: "test/model",
    seed: 1,
    maxOutputTokens: 131072,
    sampling: catalogRecommendedSampling(null),
  };
  const context = (frames: number) => ({
    actors: ["player"],
    intervals: Array.from({ length: frames }, (_, index) => ({
      frameId: `frame-${index + 1}`,
      actor: "player",
      startMs: index * 500,
      endMs: index * 500 + 500,
    })),
  });
  const answer = (frames: number) =>
    maximumAnswerCharacters(
      observationRequest(configuration, context(frames), []).tools![0]!.parameters,
    );
  assert.deepEqual(OBSERVATION_LIMITS, {
    observations: 32,
    frameIdsPerObservation: 64,
    limitations: 16,
    characters: 500,
  });
  assert.equal(answer(0), 25_173);
  assert.equal(answer(20), 32_213);
  assert.equal(answer(64), 47_701);
  assert.ok(answer(64) <= 64_000);
  // A judgment batch has 368 characters of frame: 351 of them are the guard report with its
  // quote of 300 characters. An unscaled batch adds 909 characters and the longest JSON
  // criterion ID for each criterion. A scaled batch adds 20 more characters for each score.
  assert.equal(MAX_RATIONALE_CHARS, 800);
  const ids = Array.from({ length: 64 }, (_, index) => `criterion-${index + 1}`);
  const batch = (scaled: boolean) =>
    maximumAnswerCharacters(
      batchJudgmentRequest({
        configuration,
        criteria: ids.map((id) => ({
          id,
          statement: "A beacon exists.",
          authoredPassages: ["A beacon exists."],
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          comparisons: [],
          anchors: scaled
            ? [
                { score: 0, label: "Absent", description: "No beacon exists." },
                { score: 1, label: "Present", description: "A beacon exists." },
              ]
            : null,
          scoreRange: null,
          minimumPassingScore: null,
        })),
        publicTask: "Build a beacon.",
        context: context(0),
        images: [],
        observation: null,
        criterionEvidence: ids.map(pendingCriterionMaterial),
      }).tools![0]!.parameters,
    );
  const longestId = JSON.stringify("criterion-64").length;
  assert.equal(batch(false), 368 + ids.length * (909 + longestId));
  assert.equal(batch(false), 59_440);
  assert.equal(batch(true), 368 + ids.length * (929 + longestId));
  assert.equal(batch(true), 60_720);
  assert.ok(batch(true) <= 64_000);
});

function response(
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [],
): ModelTurnResult {
  return {
    kind: "assistant",
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    stopReason: toolCalls.length ? "tool_calls" : "end_turn",
    message: { role: "assistant", content, toolCalls },
    responseFacts: {
      requestedModel: "test/model",
      resolvedModel: "test/model",
      servingProvider: "Test",
      requestedServiceTier: null,
      servingServiceTier: null,
      responseId: "generation-test",
      latencyMs: 1,
      retryCount: 0,
      finishReason: "stop",
      continuationHash: null,
      continuationBytes: null,
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
    },
  };
}

test("grader accepts a single structured tool call or exact JSON text", () => {
  assert.deepEqual(
    submittedJudgmentArguments(response(JSON.stringify(judgment)), "submit_unscaled_judgment"),
    judgment,
  );
  assert.deepEqual(
    submittedJudgmentArguments(
      response("", [{ id: "one", name: "submit_unscaled_judgment", arguments: judgment }]),
      "submit_unscaled_judgment",
    ),
    judgment,
  );
});

test("grader accepts a JSON text answer of any length", () => {
  const long = { ...judgment, rationale: "The signed observation names the beacon. ".repeat(500) };
  assert.ok(JSON.stringify(long).length > 16_384);
  assert.deepEqual(
    submittedJudgmentArguments(response(JSON.stringify(long)), "submit_unscaled_judgment"),
    long,
  );
});

test("grader refuses prose, fenced JSON, and ambiguous tool submissions with their cause", () => {
  assert.throws(
    () => submittedJudgmentArguments(response("The beacon is absent."), "submit_unscaled_judgment"),
    /The judge wrote text that is not one JSON object/,
  );
  assert.throws(
    () =>
      submittedJudgmentArguments(
        response(`\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\``),
        "submit_unscaled_judgment",
      ),
    /The judge wrote text that is not one JSON object/,
  );
  assert.throws(
    () =>
      submittedJudgmentArguments(
        response("", [
          { id: "one", name: "submit_unscaled_judgment", arguments: judgment },
          { id: "two", name: "submit_unscaled_judgment", arguments: judgment },
        ]),
        "submit_unscaled_judgment",
      ),
    /The judge did not call submit_unscaled_judgment one time\. The response stopped with tool_calls and has 2 tool calls/,
  );
  assert.throws(
    () =>
      submittedJudgmentArguments(
        response("", [{ id: "one", name: "submit_unscaled_judgment", arguments: "[]" }]),
        "submit_unscaled_judgment",
      ),
    /The judge called submit_unscaled_judgment with arguments that are not one JSON object/,
  );
});

test("An absence answer of present becomes Not met.", () => {
  const configuration = {
    modelId: "test/model",
    seed: 1,
    maxOutputTokens: 131072,
    sampling: catalogRecommendedSampling(null),
  };
  const criterion = (id: string, polarity: "presence" | "absence") => ({
    id,
    statement: polarity === "absence" ? "An error message appears." : "A beacon exists.",
    authoredPassages: ["The authored passage."],
    required: true,
    evidenceClass: null,
    polarity,
    comparisons: [],
    anchors: null,
    scoreRange: null,
    minimumPassingScore: null,
  });
  const request = (criteria: ReturnType<typeof criterion>[]) =>
    batchJudgmentRequest({
      configuration,
      criteria,
      publicTask: "Build a beacon.",
      context: { actors: [], intervals: [] },
      images: [],
      observation: null,
      criterionEvidence: criteria.map((item) => pendingCriterionMaterial(item.id)),
    });
  const verdicts = (criteria: ReturnType<typeof criterion>[]) =>
    (
      (request(criteria).tools![0]!.parameters as { properties: Record<string, unknown> })
        .properties.decisions as { items: { properties: { verdict: { enum: string[] } } } }
    ).items.properties.verdict.enum;
  // A batch without an absence criterion offers no absence words.
  assert.deepEqual(verdicts([criterion("beacon", "presence")]), [
    "satisfied",
    "violated",
    "insufficient",
  ]);
  const criteria = [criterion("beacon", "presence"), criterion("error", "absence")];
  assert.deepEqual(verdicts(criteria), [
    "satisfied",
    "violated",
    "present",
    "absent",
    "insufficient",
  ]);
  assert.match(request(criteria).system, /For an absence criterion, report the presence/);
  assert.match(request(criteria).messages[0]!.content, /"polarity":"absence"/);
  const answer = (beacon: string, error: string) =>
    response("", [
      {
        id: "one",
        name: "submit_judgment_batch",
        arguments: {
          addressedToEvaluator: { found: false, quote: null },
          decisions: [
            {
              criterionId: "beacon",
              verdict: beacon,
              score: null,
              confidence: 0.9,
              rationale: "A.",
            },
            { criterionId: "error", verdict: error, score: null, confidence: 0.9, rationale: "B." },
          ],
        },
      },
    ]);
  const present = parseBatchJudgment(answer("satisfied", "present"), criteria).decisions[1]!;
  assert.deepEqual([present.verdict, present.answer], ["violated", "present"]);
  assert.equal(sampleVote(present, null), "not_met");
  assert.equal(combineSamples([sampleVote(present, null)]).answer, "not_met");
  const absent = parseBatchJudgment(answer("satisfied", "absent"), criteria).decisions[1]!;
  assert.deepEqual([absent.verdict, absent.answer], ["satisfied", "absent"]);
  const unknown = parseBatchJudgment(answer("satisfied", "insufficient"), criteria).decisions[1]!;
  assert.deepEqual([unknown.verdict, unknown.answer], ["insufficient", "insufficient"]);
  // The parser and the samples read the raw answer word with the same rule.
  assert.equal(sampleVote({ answer: "absent", score: null }, null), "met");
  assert.equal(sampleVote({ answer: "insufficient", score: null }, null), "insufficient");
  // Each polarity accepts only its own answer words.
  for (const [beacon, error] of [
    ["satisfied", "violated"],
    ["present", "absent"],
  ])
    assert.throws(
      () => parseBatchJudgment(answer(beacon!, error!), criteria),
      /an answer word of the other polarity/,
    );
});
