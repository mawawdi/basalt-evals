import assert from "node:assert/strict";
import test from "node:test";
import {
  agreementGate,
  repeatAgreement,
  reviewSequence,
  summarizeExperts,
} from "../packages/experiments/src/audit.js";
import { krippendorffAlpha } from "../packages/experiments/src/statistics.js";
import {
  REVIEW_REASON_CODES,
  reviewReasonProblem,
  type AuditShare,
  type ReviewAnswer,
  type ReviewPopulation,
} from "../packages/contracts/src/review.js";

const seed = (letter: string) => letter.repeat(64);

test("every saved answer needs a fixed reason code that fits the answer and one sentence", () => {
  const met = { kind: "categorical", value: "satisfied" } as const;
  const cannotTell = { kind: "abstain" } as const;
  assert.equal(
    reviewReasonProblem(met, { code: "images_show", sentence: "The beacon is blue." }),
    null,
  );
  assert.equal(
    reviewReasonProblem(cannotTell, { code: "evidence_missing", sentence: "No image loads." }),
    null,
  );
  assert.equal(
    reviewReasonProblem(cannotTell, { code: "criterion_unclear", sentence: "Blue is vague." }),
    null,
  );
  assert.match(
    reviewReasonProblem(cannotTell, { code: "images_show", sentence: "It is blue." })!,
    /definite answer/,
  );
  assert.match(
    reviewReasonProblem(met, { code: "evidence_missing", sentence: "No image." })!,
    /only works with Cannot tell/,
  );
  assert.match(reviewReasonProblem(met, null)!, /Choose a reason/);
  assert.match(reviewReasonProblem(met, { code: "guess", sentence: "Yes." })!, /Choose a reason/);
  assert.match(reviewReasonProblem(met, { code: "other", sentence: "  " })!, /one sentence/);
  assert.match(
    reviewReasonProblem(met, { code: "other", sentence: "It is blue. It also glows." })!,
    /only one sentence/,
  );
  assert.match(
    reviewReasonProblem(met, { code: "other", sentence: " It is blue." })!,
    /Remove the extra spaces/,
  );
  assert.match(
    reviewReasonProblem(met, { code: "other", sentence: "x".repeat(301) })!,
    /300 characters/,
  );
  assert.match(
    reviewReasonProblem(met, { code: "other", sentence: "Blue.", note: "" })!,
    /Invalid reason fields/,
  );
  assert.equal(new Set(REVIEW_REASON_CODES).size, REVIEW_REASON_CODES.length);
});

test("each reviewer gets a seeded order and delayed repeats of about one question in ten", () => {
  const ids = Array.from({ length: 40 }, (_, index) => `unit-${index}`);
  const sequence = reviewSequence(ids, seed("a"), new Set(ids));
  assert.deepEqual(reviewSequence(ids, seed("a"), new Set(ids)), sequence, "The seed fixes it");
  const other = reviewSequence(ids, seed("b"), new Set(ids));
  assert.notDeepEqual(
    other.map((entry) => entry.unitId),
    sequence.map((entry) => entry.unitId),
    "A second reviewer gets a different order",
  );
  const first = sequence.filter((entry) => !entry.repeat).map((entry) => entry.unitId);
  assert.deepEqual([...first].sort(), [...ids].sort(), "Each unit occurs once before repeats");
  const repeats = sequence.flatMap((entry, index) => (entry.repeat ? [index] : []));
  assert.equal(repeats.length, 4);
  for (const index of repeats) {
    const unitId = sequence[index]!.unitId;
    const earlier = sequence.findIndex((entry) => entry.unitId === unitId);
    assert.ok(earlier < index, "A repeat comes after the first occurrence");
    assert.ok(index - earlier - 1 >= 3, "At least three other questions come between");
  }
  assert.equal(reviewSequence(ids, seed("a"), null).length, 40, "No repeats when disabled");
  assert.equal(reviewSequence(["x", "y"], seed("a"), new Set(["x", "y"])).length, 2);
  const five = ["a", "b", "c", "d", "e"];
  for (const letter of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    const short = reviewSequence(five, seed(letter), new Set(five));
    assert.equal(short.length, 6);
    const index = short.findIndex((entry) => entry.repeat);
    const earlier = short.findIndex((entry) => entry.unitId === short[index]!.unitId);
    assert.ok(index - earlier >= 2, "A repeat is never next to its first occurrence");
  }
  const repeatable = new Set(["unit-3", "unit-4"]);
  const only = reviewSequence(ids, seed("c"), repeatable).filter((entry) => entry.repeat);
  assert.ok(only.length >= 1, "The last unit alone cannot repeat");
  assert.ok(
    only.every((entry) => repeatable.has(entry.unitId)),
    "Only repeatable units repeat",
  );
});

const criteria = ["opens", "visible"].map((id) => ({
  id,
  statement: `The gate ${id}`,
  required: true,
  anchors: null,
  scoreRange: null,
  minimumPassingScore: null,
}));
const automatic: Record<string, "satisfied" | "violated"> = {
  "a:opens": "satisfied",
  "a:visible": "satisfied",
  "b:opens": "satisfied",
  "b:visible": "violated",
};
const units = Object.entries(automatic).map(([id, value]) => ({
  id,
  operationId: "run",
  itemId: id.split(":")[0]!,
  passId: "pass",
  criterionId: id.split(":")[1]!,
  automatic: value,
  automaticScore: null,
  treatmentId: "judge",
}));
const population = {
  id: "c".repeat(64),
  plannedOutcomes: 4,
  units,
  evidence: [
    {
      operationId: "run",
      items: ["a", "b"].map((id) => ({
        id,
        subjectId: `candidate-${id}`,
        rubricHash: "rubric",
        criteria,
        passes: [{ id: "pass", number: 1 }],
      })),
    },
  ],
} as unknown as ReviewPopulation;
const answer = (
  id: string,
  value: "satisfied" | "violated" | "abstain",
  blindingIssue: string | null = null,
) =>
  ({
    id,
    decision: value === "abstain" ? { kind: "abstain" } : { kind: "categorical", value },
    verdict: value === "abstain" ? "insufficient" : value,
    reason: { code: "other", sentence: `Reason ${id}.` },
    blindingIssue,
  }) as ReviewAnswer;
const answers = (prefix: string, values: Record<string, "satisfied" | "violated">) =>
  new Map(
    Object.entries(values).map(([unitId, value]) => [unitId, answer(prefix + unitId, value)]),
  );

test("two reviewers and the judge compare on identical items, stratified by expert agreement", () => {
  const first = answers("first-", { ...automatic });
  const second = answers("second-", { ...automatic, "a:visible": "violated" });
  const round = (roundTwo: Parameters<typeof summarizeExperts>[1]["roundTwo"]) =>
    summarizeExperts(population, {
      pairId: "pair",
      first: { batchId: "one", reviewer: "first", answered: 4, assigned: 4, answers: first },
      second: { batchId: "two", reviewer: "second", answered: 4, assigned: 4, answers: second },
      roundTwo,
      unitIds: units.map((unit) => unit.id),
      random: true,
    });
  const experts = round(null);
  assert.equal(experts.items, 4);
  const pairs = Object.fromEntries(experts.agreements.map((item) => [item.pair, item]));
  assert.deepEqual(
    Object.values(pairs).map((item) => [
      item.pair,
      item.acceptance.numerator,
      item.acceptance.denominator,
      item.candidateAcceptance.numerator,
      item.candidateAcceptance.denominator,
    ]),
    [
      ["judge_first", 4, 4, 2, 2],
      ["judge_second", 3, 4, 1, 2],
      ["first_second", 3, 4, 1, 2],
    ],
  );
  assert.deepEqual(pairs.first_second!.raters, [
    { kind: "human", id: "first" },
    { kind: "human", id: "second" },
  ]);
  assert.deepEqual(pairs.judge_first!.raters[0], { kind: "automatic", id: "judge" });
  assert.equal(
    pairs.first_second!.acceptanceAlpha,
    krippendorffAlpha(
      [
        [1, 1],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      "nominal",
    ),
    "Nominal alpha comes from the shared statistics function",
  );
  assert.ok(pairs.judge_first!.candidateAcceptance.interval!.lower < 1);
  assert.equal(pairs.judge_first!.scales.length, 2);
  assert.deepEqual(
    experts.strata.map((item) => [
      item.stratum,
      item.units,
      item.judgeFirst.numerator,
      item.judgeFirst.denominator,
      item.judgeSecond.numerator,
      item.judgeSecond.denominator,
    ]),
    [
      ["agreed", 3, 3, 3, 3, 3],
      ["disagreed", 1, 1, 1, 0, 1],
    ],
  );
  assert.deepEqual(
    experts.disagreements.map((item) => [
      item.unitId,
      item.first.verdict,
      item.second.verdict,
      item.first.reason?.sentence,
      item.status,
    ]),
    [["a:visible", "satisfied", "violated", "Reason first-a:visible.", "awaiting_round_two"]],
  );
  const settled = round({
    firstBatchId: "three",
    secondBatchId: "four",
    unitIds: ["a:visible"],
    first: answers("final-first-", { "a:visible": "violated" }),
    second: answers("final-second-", { "a:visible": "violated" }),
  });
  assert.equal(settled.disagreements[0]!.status, "resolved");
  assert.deepEqual(settled.contested, []);
  const contested = round({
    firstBatchId: "three",
    secondBatchId: "four",
    unitIds: ["a:visible"],
    first: answers("final-first-", { "a:visible": "satisfied" }),
    second: answers("final-second-", { "a:visible": "violated" }),
  });
  assert.deepEqual(contested.contested, ["a:visible"]);
  const open = round({
    firstBatchId: "three",
    secondBatchId: "four",
    unitIds: ["a:visible"],
    first: new Map([["a:visible", null]]),
    second: answers("final-second-", { "a:visible": "violated" }),
  });
  assert.equal(open.disagreements[0]!.status, "round_two_open");
  assert.match(experts.claim, /needs three or more reviewers/);
});

test("a flagged or missing expert answer stays unresolved and keeps both completions", () => {
  const first = answers("first-", { ...automatic });
  first.set("a:opens", answer("first-flagged", "satisfied", "The name of the model is visible"));
  const second = new Map<string, ReviewAnswer | null>(answers("second-", { ...automatic }));
  second.set("b:visible", null);
  const experts = summarizeExperts(population, {
    pairId: "pair",
    first: { batchId: "one", reviewer: "first", answered: 4, assigned: 4, answers: first },
    second: { batchId: "two", reviewer: "second", answered: 3, assigned: 4, answers: second },
    roundTwo: null,
    unitIds: units.map((unit) => unit.id),
    random: true,
  });
  assert.equal(experts.unanswered, 1);
  const pair = experts.agreements.find((item) => item.pair === "first_second")!;
  assert.deepEqual(
    [pair.acceptance.numerator, pair.acceptance.denominator, pair.acceptance.unresolved],
    [2, 2, 2],
  );
  assert.equal(pair.acceptance.estimate, null);
  assert.equal(pair.candidateAcceptance.unresolved, 2);
});

test("the acceptance gate names its metric and stays relative to the expert ceiling", () => {
  const share = (estimate: number | null): AuditShare => ({
    numerator: 0,
    denominator: 0,
    unresolved: estimate === null ? 1 : 0,
    estimate,
    interval: { lower: 0.4, upper: 1, confidence: 0.95, method: "clopper_pearson" },
  });
  const gate = (first: number | null, second: number | null, experts: number | null) =>
    agreementGate({
      applicable: true,
      judgeFirst: share(first),
      judgeSecond: share(second),
      experts: share(experts),
    });
  assert.equal(gate(0.9, 0.85, 0.9).state, "met");
  assert.equal(gate(0.9, 0.85, 0.9).metric, "candidate_acceptance_agreement");
  assert.ok(Math.abs(gate(0.9, 0.85, 0.9).shortfall! - 0.05) < 1e-12);
  assert.equal(gate(0.85, 0.85, 0.97).state, "not_met", "More than 0.10 below the experts");
  assert.equal(gate(0.75, 0.75, 0.8).state, "not_met", "Below 0.80 even near the ceiling");
  assert.equal(gate(0.9, null, 0.9).state, "unresolved");
  assert.equal(
    agreementGate({ applicable: true, judgeFirst: share(1), judgeSecond: null, experts: null })
      .state,
    "needs_second_reviewer",
  );
  assert.equal(
    agreementGate({ applicable: false, judgeFirst: null, judgeSecond: null, experts: null }).state,
    "not_applicable",
  );
});

test("delayed repeats report within-reviewer agreement separately", () => {
  const result = repeatAgreement([
    { unitId: "a", first: answer("1", "satisfied"), repeat: answer("2", "satisfied") },
    { unitId: "b", first: answer("3", "satisfied"), repeat: answer("4", "violated") },
    { unitId: "c", first: answer("5", "abstain"), repeat: answer("6", "satisfied") },
    { unitId: "d", first: answer("7", "violated"), repeat: null },
  ]);
  assert.deepEqual(
    result.pairs.map((pair) => pair.agreed),
    [true, false, null, null],
  );
  assert.deepEqual(
    [result.agreement.numerator, result.agreement.denominator, result.agreement.unresolved],
    [1, 2, 2],
  );
  assert.ok(result.agreement.interval);
});
