import assert from "node:assert/strict";
import test from "node:test";
import {
  auditQuantity,
  finitePopulationInterval,
  sampleWithoutReplacement,
  summarizeAudit,
} from "../packages/experiments/src/audit.js";
import type {
  AuditQuantity,
  ReviewAnswer,
  ReviewPopulation,
} from "../packages/contracts/src/review.js";

test("fixed samples are reproducible, distinct, order-independent and bounded", () => {
  const ids = Array.from({ length: 15000 }, (_, index) => String(index));
  const sample = sampleWithoutReplacement(ids, 40, "a".repeat(64));
  assert.equal(sample.length, 40);
  assert.equal(new Set(sample).size, 40);
  assert.deepEqual(sampleWithoutReplacement([...ids].reverse(), 40, "a".repeat(64)), sample);
  assert.notDeepEqual(sampleWithoutReplacement(ids, 40, "b".repeat(64)), sample);
  assert.equal(sampleWithoutReplacement(["a", "b"], 40, "a".repeat(64)).length, 2);
});

test("paired ratings keep every sampled answer and score agreement stays inside one authored scale", () => {
  const criteria = ["Clarity", "Responsiveness"].map((statement, index) => ({
    id: String(index),
    statement,
    required: true,
    anchors: [
      { score: 0, label: "Absent", description: "Absent" },
      { score: 1, label: "Present", description: "Present" },
    ],
    scoreRange: null,
    minimumPassingScore: null,
  }));
  const units = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    operationId: "run",
    itemId: "item",
    criterionId: index === 4 ? "1" : "0",
    automatic: "scored",
    automaticScore: 1,
    treatmentId: null,
  }));
  const population = {
    id: "a".repeat(64),
    plannedOutcomes: 5,
    units,
    evidence: [
      {
        operationId: "run",
        items: [{ id: "item", subjectId: "candidate", rubricHash: "rubric", criteria }],
      },
    ],
  } as unknown as ReviewPopulation;
  const answers = [
    { decision: { kind: "score", value: 1 }, verdict: "scored", blindingIssue: null },
    { decision: { kind: "score", value: 0 }, verdict: "scored", blindingIssue: "Identity visible" },
    null,
    {
      decision: { kind: "abstain" },
      verdict: "insufficient",
      blindingIssue: null,
    },
    { decision: { kind: "score", value: 1 }, verdict: "scored", blindingIssue: null },
  ];
  const observations = units.map((unit, index) => ({
    unitId: unit.id,
    reviewer: "reviewer",
    answer: answers[index] as ReviewAnswer | null,
  }));
  const result = summarizeAudit(population, observations, "audit");
  assert.equal(result.reliability.length, 2, "Equal anchors do not pool different criteria");
  const clarity = result.reliability[0]!;
  assert.equal(clarity.statement, "Clarity");
  assert.equal(clarity.kind, "ordinal");
  assert.deepEqual(
    [clarity.selected, clarity.unanswered, clarity.abstained, clarity.flagged],
    [4, 1, 1, 1],
  );
  assert.deepEqual(
    [
      clarity.exactAgreement.population,
      clarity.exactAgreement.numerator,
      clarity.exactAgreement.denominator,
      clarity.exactAgreement.unresolved,
    ],
    [4, 1, 1, 3],
  );
  assert.equal(
    result.ratings.length,
    10,
    "Each sampled unit keeps a human and an automatic rating",
  );
  assert.deepEqual(
    result.ratings
      .filter((rating) => rating.rater.kind === "human")
      .map((rating) => [rating.decision, rating.score, rating.flagged]),
    [
      ["scored", 1, false],
      ["scored", 0, true],
      [null, null, false],
      ["insufficient", null, false],
      ["scored", 1, false],
    ],
  );
  assert.deepEqual(result.acceptance.escalationShare, {
    numerator: 0,
    denominator: 5,
    unresolved: 0,
    estimate: 0,
  });
});

test("acceptance measures name their denominators and one audited false pass stops the stream", () => {
  const criteria = [
    {
      id: "opens",
      statement: "The gate opens",
      required: true,
      anchors: null,
      scoreRange: null,
      minimumPassingScore: null,
    },
  ];
  const automatic = ["satisfied", "satisfied", "satisfied", "violated", "violated", "satisfied"];
  const unit = (id: string, value: string, itemId: string) => ({
    id,
    operationId: "run",
    itemId,
    criterionId: "opens",
    automatic: value,
    automaticScore: null,
    treatmentId: "stream",
  });
  const sampled = automatic.map((value, index) => unit(`u${index}`, value, index < 3 ? "a" : "b"));
  const population = {
    id: "b".repeat(64),
    plannedOutcomes: 10,
    units: [...sampled, unit("x1", "satisfied", "a"), unit("x2", "violated", "b")],
    evidence: [
      {
        operationId: "run",
        items: ["a", "b"].map((id) => ({
          id,
          subjectId: `candidate-${id}`,
          rubricHash: "rubric",
          criteria,
        })),
      },
    ],
  } as unknown as ReviewPopulation;
  const answer = (value: "satisfied" | "violated", blindingIssue: string | null = null) =>
    ({
      decision: { kind: "categorical", value },
      verdict: value,
      blindingIssue,
    }) as unknown as ReviewAnswer;
  const answers = [
    answer("satisfied"),
    answer("violated"),
    null,
    answer("violated"),
    answer("satisfied"),
    answer("satisfied", "Identity visible"),
  ];
  const observations = sampled.map((item, index) => ({
    unitId: item.id,
    reviewer: "reviewer",
    answer: answers[index]!,
  }));
  const result = summarizeAudit(population, observations, "audit");
  const quantity = (value: AuditQuantity) => [
    value.population,
    value.selected,
    value.numerator,
    value.denominator,
    value.unresolved,
  ];
  const { acceptance } = result;
  assert.deepEqual(quantity(acceptance.agreement), [8, 6, 2, 4, 2]);
  assert.deepEqual(quantity(acceptance.falseAcceptanceShare), [5, 4, 1, 2, 2]);
  assert.deepEqual(quantity(acceptance.falseRejectionShare), [3, 2, 1, 2, 0]);
  assert.ok(acceptance.falseAcceptanceShare.interval, "A random audit has an exact interval");
  const ratio = (value: { numerator: number; denominator: number; unresolved: number }) => [
    value.numerator,
    value.denominator,
    value.unresolved,
  ];
  assert.deepEqual(ratio(acceptance.missRate), [1, 2, 2]);
  assert.deepEqual(ratio(acceptance.falseRejectionRate), [1, 2, 2]);
  assert.deepEqual(ratio(acceptance.removalShare), [8, 10, 0]);
  assert.deepEqual(ratio(acceptance.escalationShare), [2, 10, 0]);
  assert.deepEqual(acceptance.monitor, { state: "escalate_all", falsePassUnitIds: ["u1"] });
  const [scale] = result.reliability;
  assert.equal(scale!.kind, "categorical");
  assert.equal(scale!.withinOne, null);
  assert.equal(scale!.meanAbsoluteError, null);
  assert.equal(scale!.signedBias.value, 0);
  assert.equal(scale!.bootstrap.clusters, 2);
  assert.deepEqual(quantity(scale!.exactAgreement), [8, 6, 2, 4, 2]);
  assert.deepEqual(result, summarizeAudit(population, observations, "audit"));
  assert.equal(
    summarizeAudit(population, observations, "diagnostic").acceptance.agreement.interval,
    null,
  );
});
test("finite population intervals retain census, no observations, all errors and unresolved labels", () => {
  assert.deepEqual(finitePopulationInterval(10, 10, 3), {
    lower: 0.3,
    upper: 0.3,
    confidence: 0.95,
  });
  assert.deepEqual(finitePopulationInterval(10, 0, 0), { lower: 0, upper: 1, confidence: 0.95 });
  assert.equal(finitePopulationInterval(100, 40, 0).lower, 0);
  assert.equal(finitePopulationInterval(100, 40, 40).upper, 1);
  const unresolved = auditQuantity(10, [1, null, 0], true);
  assert.equal(unresolved.selected, 3);
  assert.equal(unresolved.denominator, 2);
  assert.equal(unresolved.estimate, null);
  assert.equal(unresolved.interval!.lower, finitePopulationInterval(10, 3, 1).lower);
  assert.equal(unresolved.interval!.upper, finitePopulationInterval(10, 3, 2).upper);
  assert.equal(auditQuantity(10, [1, 0], false).interval, null);
  assert.equal(auditQuantity(0, [], true).interval, null);
});
test("exact intervals cover at least 95% under every enumerated small finite population", () => {
  const choose = (n: number, k: number) => {
    if (k < 0 || k > n) return 0;
    let value = 1;
    for (let i = 1; i <= k; i++) value *= (n - i + 1) / i;
    return value;
  };
  for (let population = 1; population <= 20; population++)
    for (let sampled = 0; sampled <= population; sampled++) {
      const intervals = Array.from({ length: sampled + 1 }, (_, observed) =>
        finitePopulationInterval(population, sampled, observed),
      );
      for (let total = 0; total <= population; total++) {
        let coverage = 0;
        for (let observed = 0; observed <= sampled; observed++) {
          const probability =
            (choose(total, observed) * choose(population - total, sampled - observed)) /
            choose(population, sampled);
          const bounds = intervals[observed]!;
          if (bounds.lower <= total / population && bounds.upper >= total / population)
            coverage += probability;
        }
        assert.ok(
          coverage >= 0.95 - 1e-12,
          `N=${population}, n=${sampled}, K=${total}: ${coverage}`,
        );
      }
    }
});
