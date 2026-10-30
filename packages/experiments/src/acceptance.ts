import {
  certifyRuleSequence,
  exactShare,
  type ExactShare,
  type FailingBuildOutcome,
} from "./statistics.js";

/*
 * Certified selective acceptance. Each unit gets exactly one outcome: auto_accept,
 * auto_reject or escalate. The policy has no input for the stated confidence of a judge,
 * so that value cannot gate, rank or filter a unit.
 */

export type SelectiveOutcome = "auto_accept" | "auto_reject" | "escalate";
const ESCALATION_REASONS = [
  "no_certified_rule",
  "integrity_issue",
  "evidence_use_failed",
  "expert_disagreement",
  "insufficient_answer",
  "missing_samples",
  "threshold_conflict",
  "repeat_disagreement",
  "capture_disagreement",
  "family_disagreement",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];
export type ExpertLabel = "satisfied" | "violated" | null;

/** One automatic answer for one criterion of one build. */
export interface AcceptanceSample {
  captureId: string;
  /** The judge sample number of one identical request, from 1. */
  repeat: number;
  /** The model family of the judge. */
  family: string;
  decision: "satisfied" | "violated" | "insufficient";
  score: number | null;
  /** The answer stopped at an output limit. */
  truncated: boolean;
}
/** One criterion of one build with all of its automatic samples. */
export interface AcceptanceUnit {
  id: string;
  buildId: string;
  criterionId: string;
  /** The authored minimum passing score. Null for a categorical criterion. */
  threshold: number | null;
  samples: AcceptanceSample[];
  integrityIssue: boolean;
  /** The evidence-use gate of this criterion failed or has no result. */
  evidenceUseFailed: boolean;
  /** The experts gave different labels for this criterion. */
  expertsDisagree: boolean;
}
/** A preregistered rule: the minimum evidence for an automatic decision. */
export interface AcceptanceRule {
  id: string;
  /** Minimum distinct captures. */
  captures: number;
  /** Minimum identical-request repeats for each capture and judge family. */
  repeats: number;
  /** Minimum judge families for each capture. Each family needs the minimum repeats. */
  families: number;
}
export interface UnitOutcome {
  unitId: string;
  buildId: string;
  criterionId: string;
  outcome: SelectiveOutcome;
  reasons: EscalationReason[];
}

function validateRule(rule: AcceptanceRule) {
  if (
    typeof rule.id !== "string" ||
    !rule.id ||
    ![rule.captures, rule.repeats, rule.families].every(
      (value) => Number.isSafeInteger(value) && value >= 1,
    )
  )
    throw new Error("An acceptance rule needs an identity and positive minimum counts");
}

type Vote = "accept" | "reject" | "none" | "conflict";
function vote(sample: AcceptanceSample, threshold: number | null): Vote {
  if (sample.decision === "insufficient") return "none";
  const atThreshold = threshold === null || (sample.score !== null && sample.score >= threshold);
  if (sample.decision === "satisfied") return atThreshold ? "accept" : "conflict";
  return threshold !== null && sample.score !== null && sample.score >= threshold
    ? "conflict"
    : "reject";
}

/**
 * Give one unit its outcome under a rule. A null rule means that no rule is certified or
 * that the audit monitor stopped the stream: the unit escalates.
 */
export function selectiveOutcome(unit: AcceptanceUnit, rule: AcceptanceRule | null): UnitOutcome {
  if (rule) validateRule(rule);
  const reasons = new Set<EscalationReason>();
  if (!rule) reasons.add("no_certified_rule");
  if (unit.integrityIssue) reasons.add("integrity_issue");
  if (unit.evidenceUseFailed) reasons.add("evidence_use_failed");
  if (unit.expertsDisagree) reasons.add("expert_disagreement");
  const samples = unit.samples;
  if (samples.some((sample) => sample.decision === "insufficient" || sample.truncated))
    reasons.add("insufficient_answer");
  const coverage = new Map<string, Map<string, Set<number>>>();
  for (const sample of samples) {
    const families = coverage.get(sample.captureId) ?? new Map<string, Set<number>>();
    const repeats = families.get(sample.family) ?? new Set<number>();
    if (repeats.has(sample.repeat)) throw new Error("A sample identity occurs more than once");
    repeats.add(sample.repeat);
    families.set(sample.family, repeats);
    coverage.set(sample.captureId, families);
  }
  if (
    !samples.length ||
    (rule &&
      (coverage.size < rule.captures ||
        [...coverage.values()].some(
          (families) =>
            [...families.values()].filter((repeats) => repeats.size >= rule.repeats).length <
            rule.families,
        )))
  )
    reasons.add("missing_samples");
  const votes = samples.map((sample) => vote(sample, unit.threshold));
  if (votes.includes("conflict")) reasons.add("threshold_conflict");
  for (let i = 0; i < samples.length; i++)
    for (let j = i + 1; j < samples.length; j++) {
      const a = votes[i]!,
        b = votes[j]!;
      if (a === b || (a !== "accept" && a !== "reject") || (b !== "accept" && b !== "reject"))
        continue;
      const first = samples[i]!,
        second = samples[j]!;
      reasons.add(
        first.family !== second.family
          ? "family_disagreement"
          : first.captureId !== second.captureId
            ? "capture_disagreement"
            : "repeat_disagreement",
      );
    }
  const outcome: SelectiveOutcome = reasons.size
    ? "escalate"
    : votes.every((value) => value === "accept")
      ? "auto_accept"
      : votes.every((value) => value === "reject")
        ? "auto_reject"
        : "escalate";
  return {
    unitId: unit.id,
    buildId: unit.buildId,
    criterionId: unit.criterionId,
    outcome,
    reasons: ESCALATION_REASONS.filter((reason) => reasons.has(reason)),
  };
}

/**
 * Combine the criterion outcomes of one build. One certified rejection rejects the build.
 * All criteria must accept for an acceptance. An integrity issue or an absent rule
 * escalates the build.
 */
export function buildOutcome(units: UnitOutcome[]): SelectiveOutcome {
  if (new Set(units.map((unit) => unit.buildId)).size > 1)
    throw new Error("A build outcome combines units of one build");
  if (
    !units.length ||
    units.some(
      (unit) =>
        unit.reasons.includes("integrity_issue") || unit.reasons.includes("no_certified_rule"),
    )
  )
    return "escalate";
  if (units.some((unit) => unit.outcome === "auto_reject")) return "auto_reject";
  return units.every((unit) => unit.outcome === "auto_accept") ? "auto_accept" : "escalate";
}

/** One independent unit, for example one build, with its outcome and its expert label. */
export interface LabelledOutcome {
  outcome: SelectiveOutcome;
  expert: ExpertLabel;
}

/**
 * The shares of one policy over independent units. Each share names its denominator.
 * missRate and falseRejectionRate condition on the expert label, so they do not depend
 * on prevalence. falseAcceptanceShare and falseRejectionShare condition on the automatic
 * outcome, so they need a representative sample.
 */
export function acceptanceShares(
  rows: LabelledOutcome[],
  confidence = 0.95,
): Record<
  | "missRate"
  | "falseRejectionRate"
  | "falseAcceptanceShare"
  | "falseRejectionShare"
  | "removalShare"
  | "escalationShare",
  ExactShare
> {
  const failing = (row: LabelledOutcome) =>
    row.expert === null ? null : row.expert === "violated";
  const passing = (row: LabelledOutcome) =>
    row.expert === null ? null : row.expert === "satisfied";
  return {
    missRate: exactShare(
      rows.map((row) => ({ member: failing(row), event: row.outcome === "auto_accept" })),
      confidence,
    ),
    falseRejectionRate: exactShare(
      rows.map((row) => ({ member: passing(row), event: row.outcome === "auto_reject" })),
      confidence,
    ),
    falseAcceptanceShare: exactShare(
      rows.map((row) => ({ member: row.outcome === "auto_accept", event: failing(row) })),
      confidence,
    ),
    falseRejectionShare: exactShare(
      rows.map((row) => ({ member: row.outcome === "auto_reject", event: passing(row) })),
      confidence,
    ),
    removalShare: exactShare(
      rows.map((row) => ({ member: true, event: row.outcome !== "escalate" })),
      confidence,
    ),
    escalationShare: exactShare(
      rows.map((row) => ({ member: true, event: row.outcome === "escalate" })),
      confidence,
    ),
  };
}

/**
 * Miss outcomes over independent failing builds. An accepted build with an unresolved
 * expert label counts as a failing build that the rule missed.
 */
export function failingBuildOutcomes(builds: LabelledOutcome[]): FailingBuildOutcome[] {
  return builds.flatMap((build) =>
    build.expert === "violated"
      ? [build.outcome === "auto_accept"]
      : build.expert === null && build.outcome === "auto_accept"
        ? [null]
        : [],
  );
}

/** The build outcomes of one rule on one split. */
interface RuleEvaluation {
  ruleId: string;
  builds: LabelledOutcome[];
}

function evaluations(rules: AcceptanceRule[], split: RuleEvaluation[]) {
  rules.forEach(validateRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
    throw new Error("Rule identities must be unique");
  const map = new Map(split.map((item) => [item.ruleId, item]));
  if (map.size !== split.length) throw new Error("Each rule needs one evaluation");
  return rules.map((rule) => {
    const evaluation = map.get(rule.id);
    if (!evaluation) throw new Error("Each preregistered rule needs an evaluation");
    return { rule, builds: evaluation.builds };
  });
}

/**
 * Choose the test sequence on the calibration split. Keep the preregistered order, from
 * the most conservative rule. Stop before the first rule that has no failing build or a
 * calibration miss rate above the maximum. The last rule in the sequence is the choice.
 */
export function chooseRuleSequence(
  rules: AcceptanceRule[],
  calibration: RuleEvaluation[],
  maxMissRate: number,
) {
  const results = evaluations(rules, calibration).map(({ rule, builds }) => {
    const outcomes = failingBuildOutcomes(builds);
    return {
      ruleId: rule.id,
      builds: builds.length,
      removed: builds.filter((build) => build.outcome !== "escalate").length,
      failingBuilds: outcomes.length,
      countedMisses: outcomes.filter((outcome) => outcome !== false).length,
    };
  });
  const ruleIds: string[] = [];
  for (const result of results) {
    if (!result.failingBuilds || result.countedMisses / result.failingBuilds > maxMissRate) break;
    ruleIds.push(result.ruleId);
  }
  return { ruleIds, chosenRuleId: ruleIds.at(-1) ?? null, calibration: results };
}

/** Certify the chosen sequence on the holdout split with the exact fixed-sequence test. */
export function certifyAcceptance(
  rules: AcceptanceRule[],
  sequence: string[],
  holdout: RuleEvaluation[],
  maxMissRate: number,
  confidence: number,
) {
  const tested = evaluations(rules, holdout);
  return certifyRuleSequence(
    sequence.map((id) => {
      const evaluation = tested.find((item) => item.rule.id === id);
      if (!evaluation) throw new Error("The sequence names an unknown rule");
      return { id, outcomes: failingBuildOutcomes(evaluation.builds) };
    }),
    maxMissRate,
    confidence,
  );
}

/**
 * The random audit is a monitor. One audited false pass sends the stream back to
 * escalate-all.
 */
export function acceptanceMonitor(
  audited: Array<{ unitId: string; outcome: SelectiveOutcome; expert: ExpertLabel }>,
) {
  const falsePassUnitIds = audited
    .filter((item) => item.outcome === "auto_accept" && item.expert === "violated")
    .map((item) => item.unitId);
  return {
    audited: audited.length,
    falsePassUnitIds,
    state: falsePassUnitIds.length ? ("escalate_all" as const) : ("active" as const),
  };
}

/** The rule that a stream can use now. No certificate or a stopped monitor gives no rule. */
export function deployedRule(
  rules: AcceptanceRule[],
  certification: { certifiedRuleId: string | null },
  monitor: { state: "active" | "escalate_all" },
): AcceptanceRule | null {
  if (monitor.state === "escalate_all" || certification.certifiedRuleId === null) return null;
  const rule = rules.find((item) => item.id === certification.certifiedRuleId);
  if (!rule) throw new Error("The certified rule is not in the preregistered list");
  return rule;
}
