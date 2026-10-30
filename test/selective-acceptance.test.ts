import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceMonitor,
  acceptanceShares,
  buildOutcome,
  certifyAcceptance,
  chooseRuleSequence,
  deployedRule,
  selectiveOutcome,
  type AcceptanceRule,
  type AcceptanceSample,
  type AcceptanceUnit,
  type EscalationReason,
  type LabelledOutcome,
} from "../packages/experiments/src/acceptance.js";
import { analyzeExperiment } from "../packages/experiments/src/analysis.js";
import { calibrationEvidence, calibrationPlan } from "./judge-fixture.js";

const rule: AcceptanceRule = {
  id: "two-captures-two-repeats",
  captures: 2,
  repeats: 2,
  families: 1,
};
const sample = (
  captureId: string,
  repeat: number,
  decision: AcceptanceSample["decision"],
  overrides: Partial<AcceptanceSample> = {},
): AcceptanceSample => ({
  captureId,
  repeat,
  family: "family-a",
  decision,
  score: null,
  truncated: false,
  ...overrides,
});
const unit = (samples: AcceptanceSample[], overrides: Partial<AcceptanceUnit> = {}) => ({
  id: "unit",
  buildId: "build",
  criterionId: "criterion",
  threshold: null,
  samples,
  integrityIssue: false,
  evidenceUseFailed: false,
  expertsDisagree: false,
  ...overrides,
});
const unanimous = (decision: AcceptanceSample["decision"]) =>
  ["c1", "c2"].flatMap((capture) => [1, 2].map((repeat) => sample(capture, repeat, decision)));

test("selective acceptance gives one outcome and escalates every unsafe unit", () => {
  assert.equal(selectiveOutcome(unit(unanimous("satisfied")), rule).outcome, "auto_accept");
  assert.equal(selectiveOutcome(unit(unanimous("violated")), rule).outcome, "auto_reject");
  const reasons = (samples: AcceptanceSample[], overrides: Partial<AcceptanceUnit> = {}) => {
    const result = selectiveOutcome(unit(samples, overrides), rule);
    assert.equal(result.outcome, "escalate");
    return result.reasons;
  };
  const accepted = unanimous("satisfied");
  assert.deepEqual(reasons(accepted, { integrityIssue: true }), ["integrity_issue"]);
  assert.deepEqual(reasons(accepted, { evidenceUseFailed: true }), ["evidence_use_failed"]);
  assert.deepEqual(reasons(accepted, { expertsDisagree: true }), ["expert_disagreement"]);
  assert.deepEqual(reasons([...accepted.slice(1), sample("c1", 1, "insufficient")]), [
    "insufficient_answer",
  ]);
  assert.deepEqual(
    reasons([...accepted.slice(1), sample("c1", 1, "satisfied", { truncated: true })]),
    ["insufficient_answer"],
  );
  assert.deepEqual(reasons(accepted.slice(1)), ["missing_samples"]);
  assert.deepEqual(reasons(accepted.slice(0, 2)), ["missing_samples"]);
  assert.deepEqual(reasons([...accepted.slice(1), sample("c1", 1, "violated")]), [
    "repeat_disagreement",
    "capture_disagreement",
  ]);
  assert.deepEqual(
    reasons([...accepted.slice(0, 2), sample("c2", 1, "violated"), sample("c2", 2, "violated")]),
    ["capture_disagreement"],
  );
  assert.deepEqual(reasons([...accepted, sample("c1", 1, "violated", { family: "family-b" })]), [
    "family_disagreement",
  ]);
  assert.deepEqual(
    selectiveOutcome(unit(accepted), null).reasons,
    ["no_certified_rule"],
    "Without a certified rule every unit escalates",
  );
  const scored = (score: number) =>
    ["c1", "c2"].flatMap((capture) =>
      [1, 2].map((repeat) => sample(capture, repeat, "satisfied", { score })),
    );
  assert.equal(selectiveOutcome(unit(scored(7), { threshold: 7 }), rule).outcome, "auto_accept");
  assert.deepEqual(reasons(scored(6), { threshold: 7 }), ["threshold_conflict"]);
  // A stated judge confidence is not an input. Extra fields cannot change the outcome.
  const confident = accepted.map((item) => ({ ...item, confidence: 0.01 }));
  assert.equal(selectiveOutcome(unit(confident), rule).outcome, "auto_accept");
  assert.throws(
    () => selectiveOutcome(unit([...accepted, sample("c1", 1, "satisfied")]), rule),
    /more than once/,
  );
});

test("build outcomes combine criteria and every share names its denominator", () => {
  const outcome = (
    value: "auto_accept" | "auto_reject" | "escalate",
    reasons: EscalationReason[] = [],
  ) => ({ unitId: value, buildId: "build", criterionId: value, outcome: value, reasons });
  assert.equal(buildOutcome([outcome("auto_accept"), outcome("auto_accept")]), "auto_accept");
  assert.equal(buildOutcome([outcome("auto_accept"), outcome("escalate")]), "escalate");
  assert.equal(buildOutcome([outcome("auto_reject"), outcome("escalate")]), "auto_reject");
  assert.equal(
    buildOutcome([outcome("auto_reject"), outcome("escalate", ["integrity_issue"])]),
    "escalate",
  );
  assert.equal(buildOutcome([]), "escalate");
  const rows: LabelledOutcome[] = [
    { outcome: "auto_accept", expert: "satisfied" },
    { outcome: "auto_accept", expert: "violated" },
    { outcome: "auto_accept", expert: null },
    { outcome: "auto_reject", expert: "violated" },
    { outcome: "escalate", expert: "violated" },
    { outcome: "escalate", expert: "satisfied" },
  ];
  const shares = acceptanceShares(rows);
  const counts = (key: keyof typeof shares) => [
    shares[key].numerator,
    shares[key].denominator,
    shares[key].unresolved,
  ];
  assert.deepEqual(counts("missRate"), [1, 3, 1]);
  assert.deepEqual(counts("falseRejectionRate"), [0, 2, 1]);
  assert.deepEqual(counts("falseAcceptanceShare"), [1, 2, 1]);
  assert.deepEqual(counts("falseRejectionShare"), [0, 1, 0]);
  assert.deepEqual(counts("removalShare"), [4, 6, 0]);
  assert.deepEqual(counts("escalationShare"), [2, 6, 0]);
  assert.equal(shares.missRate.estimate, null, "No complete-case estimate with unresolved labels");
  assert.equal(shares.removalShare.estimate, 4 / 6);
});

test("calibration chooses the sequence, the holdout certifies it, and one audited false pass stops the stream", () => {
  const rules: AcceptanceRule[] = [
    { id: "strict", captures: 3, repeats: 3, families: 2 },
    { id: "middle", captures: 3, repeats: 1, families: 1 },
    { id: "loose", captures: 1, repeats: 1, families: 1 },
  ];
  const builds = (caught: number, missed: number, unresolvedAccepted = 0): LabelledOutcome[] => [
    ...Array.from({ length: caught }, () => ({
      outcome: "escalate" as const,
      expert: "violated" as const,
    })),
    ...Array.from({ length: missed }, () => ({
      outcome: "auto_accept" as const,
      expert: "violated" as const,
    })),
    ...Array.from({ length: unresolvedAccepted }, () => ({
      outcome: "auto_accept" as const,
      expert: null,
    })),
    ...Array.from({ length: 5 }, () => ({
      outcome: "auto_accept" as const,
      expert: "satisfied" as const,
    })),
  ];
  const sequence = chooseRuleSequence(
    rules,
    [
      { ruleId: "strict", builds: builds(10, 0) },
      { ruleId: "middle", builds: builds(10, 0) },
      { ruleId: "loose", builds: builds(8, 2) },
    ],
    0.1,
  );
  assert.deepEqual(sequence.ruleIds, ["strict", "middle"]);
  assert.equal(sequence.chosenRuleId, "middle");
  const certificate = certifyAcceptance(
    rules,
    sequence.ruleIds,
    [
      { ruleId: "strict", builds: builds(29, 0) },
      { ruleId: "middle", builds: builds(29, 0, 1) },
      { ruleId: "loose", builds: builds(29, 0) },
    ],
    0.1,
    0.95,
  );
  assert.equal(certificate.certifiedRuleId, "strict", "An unresolved accepted label is a miss");
  assert.deepEqual(certificate.tests[1]!.unresolved, 1);
  const active = acceptanceMonitor([
    { unitId: "a", outcome: "auto_accept", expert: "satisfied" },
    { unitId: "b", outcome: "auto_reject", expert: "satisfied" },
  ]);
  assert.equal(deployedRule(rules, certificate, active)!.id, "strict");
  const stopped = acceptanceMonitor([
    { unitId: "a", outcome: "auto_accept", expert: "satisfied" },
    { unitId: "c", outcome: "auto_accept", expert: "violated" },
  ]);
  assert.deepEqual(stopped, { audited: 2, falsePassUnitIds: ["c"], state: "escalate_all" });
  assert.equal(deployedRule(rules, certificate, stopped), null);
  assert.equal(deployedRule(rules, { certifiedRuleId: null }, active), null);
  assert.throws(() => chooseRuleSequence(rules, [], 0.1), /evaluation/);
});

test("judge samples of one request give a repeat disagreement and a measurable flip rate", () => {
  const plan = calibrationPlan(2);
  const capture = (unit: { captureId: string }) =>
    plan.captures.find((capture) => capture.id === unit.captureId)!;
  // The second sample of one still request of gate-0 changes its answer.
  const flipped = plan.judgments.find(
    (unit) =>
      unit.presentation === "still" &&
      !unit.substitution &&
      unit.sample === 2 &&
      capture(unit).subjectId === "gate-0" &&
      capture(unit).partition === "development",
  )!;
  const report = analyzeExperiment(
    plan,
    calibrationEvidence(plan, (unit) => (unit.id === flipped.id ? "violated" : "satisfied")),
    [],
    [],
  );
  assert.ok("treatments" in report);
  const still = report.treatments.find(
    (row) => row.presentation === "still" && row.partition === "development",
  )!;
  assert.equal(still.rule.repeats, 2);
  const unit = (sourceId: string) =>
    still.builds.find((build) => build.sourceId === sourceId)!.criteria[0]!;
  // The changed sample also differs from the samples of the other captures of the build.
  assert.deepEqual(unit("gate-0").reasons, ["repeat_disagreement", "capture_disagreement"]);
  assert.equal(unit("gate-1").outcome, "auto_accept");
  // Twelve builds have six development captures each, and each capture has one sample group.
  assert.deepEqual(
    [still.identicalRequestFlips.numerator, still.identicalRequestFlips.denominator],
    [1, 72],
  );
  assert.ok(still.identicalRequestFlips.estimate! > 0);
});
