import { compareCodeUnits } from "../../contracts/src/index.js";
import {
  CONTROL_LEVELS,
  type ControlLevel,
  type EvidenceCondition,
  type UnavailableControl,
} from "../../contracts/src/assessments.js";
import type { EvidenceSubstitutionKind, LabelRule } from "../../contracts/src/execution.js";
import { exactMcNemar, exactSignTest, holmAdjust } from "./statistics.js";

/*
 * Pure analysis of a sensitivity test. A control is a diagnostic: it shows whether, where and
 * in which direction an answer depends on the evidence. It never counts as accuracy.
 *
 * Observations of one build are not independent, so every exact test counts builds. Each build
 * gives one sign. With one build, a test has at most one count and cannot show an effect.
 */

export type Verdict = "satisfied" | "violated" | "insufficient";
interface EvidenceUseDecision {
  criterionId: string;
  verdict: Verdict;
  score: number | null;
}
export interface EvidenceUseUnit {
  /** The cluster: the build whose evidence the unit judges. */
  build: string;
  /** The observation (capture) of that build. */
  observation: string;
  condition: EvidenceCondition;
  repeat: number;
  criterionIds: string[];
  /** Null when the unit has no answer. */
  decisions: EvidenceUseDecision[] | null;
  /** Donor-swap units only: the expert answers of the target and the donor. */
  expert: {
    target: { verdict: "satisfied" | "violated" };
    donor: { verdict: "satisfied" | "violated" };
  } | null;
}
export interface EvidenceUseInput {
  criterionIds: string[];
  controls: EvidenceSubstitutionKind[];
  plan: {
    originalRepeats: number;
    labelRule: LabelRule;
    requestedVerdict: "satisfied" | "violated" | null;
  };
  units: EvidenceUseUnit[];
  unavailable: UnavailableControl[];
}

export type PairStatus = "held" | "changed" | "abstained" | "unavailable";
export interface Rate {
  numerator: number;
  denominator: number;
  estimate: number | null;
}
interface PairCounts {
  held: number;
  changed: number;
  abstained: number;
  unavailable: number;
  /** Pairs with both answers: held + changed + abstained. */
  compared: number;
  /** Changed to another answer. */
  flipRate: Rate;
  /** Changed to "insufficient". */
  abstainRate: Rate;
  /** Any change: changed or abstained. */
  movedRate: Rate;
}
/** McNemar over builds: each build gives the sign of its net change from met to not met. */
export interface BuildMcNemar extends ReturnType<typeof exactMcNemar> {
  builds: number;
  holmP: number | null;
}
/** Sign test over builds. A positive build supports the direction under test. */
export interface BuildSignTest {
  builds: number;
  positives: number;
  negatives: number;
  ties: number;
  greaterP: number;
  holmP: number | null;
}
export interface ControlResult extends PairCounts {
  condition: EvidenceSubstitutionKind;
  level: ControlLevel;
  status: "measured" | "not_available";
  reasons: string[];
  mcnemar: BuildMcNemar | null;
  /** Does the control move answers more than repeats of the original? Null without a noise floor. */
  againstNoise: BuildSignTest | null;
}
export interface CriterionEvidenceUse {
  criterionId: string;
  noiseFloor: ({ status: "measured" } & PairCounts) | { status: "not_measured" };
  controls: ControlResult[];
  /** Decisive region minus sham region. Null when the plan has no region controls. */
  localization: {
    status: "measured" | "not_available";
    reasons: string[];
    decisiveMoved: Rate;
    shamMoved: Rate;
    effect: number | null;
    mcnemar: BuildMcNemar | null;
    /** The artifact check: the black fill against the pre-action fill. */
    blackMoved: Rate | null;
    blackMinusFill: number | null;
  } | null;
  /** Does the answer follow the swapped pixels? Null when the plan has no donor swap. */
  direction: {
    status: "measured" | "not_available";
    reasons: string[];
    followed: number;
    kept: number;
    abstained: number;
    followRate: Rate;
    signTest: BuildSignTest | null;
  } | null;
  /** Does an in-scene note move the answer? Null when the plan has no note control. */
  text: {
    status: "measured" | "not_available";
    reasons: string[];
    requestedVerdict: "satisfied" | "violated" | null;
    toward: number;
    away: number;
    held: number;
    abstained: number;
    towardRate: Rate;
    signTest: BuildSignTest | null;
  } | null;
}
interface EvidenceUseCell {
  criterionId: string;
  observation: string;
  condition: EvidenceCondition;
  repeat: number;
  status: PairStatus;
}
export interface EvidenceUseReport {
  method: "build_clusters";
  labelRule: LabelRule;
  originalRepeats: number;
  builds: number;
  noiseFloor: "measured" | "not_measured";
  criteria: CriterionEvidenceUse[];
  /** One cell for each criterion, observation and control, and for each repeat of the original. */
  cells: EvidenceUseCell[];
}

function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, estimate: denominator ? numerator / denominator : null };
}

/** How a second answer relates to a first answer of the same question. */
export function pairStatus(
  first: EvidenceUseDecision | null | undefined,
  second: EvidenceUseDecision | null | undefined,
): PairStatus {
  if (!first || !second) return "unavailable";
  if (first.verdict === second.verdict && first.score === second.score) return "held";
  return second.verdict === "insufficient" ? "abstained" : "changed";
}

function counts(statuses: PairStatus[]): PairCounts {
  const held = statuses.filter((status) => status === "held").length,
    changed = statuses.filter((status) => status === "changed").length,
    abstained = statuses.filter((status) => status === "abstained").length,
    compared = held + changed + abstained;
  return {
    held,
    changed,
    abstained,
    unavailable: statuses.length - compared,
    compared,
    flipRate: rate(changed, compared),
    abstainRate: rate(abstained, compared),
    movedRate: rate(changed + abstained, compared),
  };
}

/** One signed integer for each build. Positive supports the direction under test. */
function signTest(perBuild: Map<string, number>): BuildSignTest | null {
  if (!perBuild.size) return null;
  const values = [...perBuild.values()];
  const positives = values.filter((value) => value > 0).length,
    negatives = values.filter((value) => value < 0).length;
  return {
    builds: values.length,
    positives,
    negatives,
    ties: values.length - positives - negatives,
    greaterP: exactSignTest(positives, negatives).greaterP,
    holmP: null,
  };
}

function mcnemar(perBuild: Map<string, number>): BuildMcNemar | null {
  if (!perBuild.size) return null;
  const values = [...perBuild.values()];
  return {
    builds: values.length,
    ...exactMcNemar(
      values.filter((value) => value > 0).length,
      values.filter((value) => value < 0).length,
    ),
    holmP: null,
  };
}

const add = (map: Map<string, number>, key: string, value: number) =>
  map.set(key, (map.get(key) ?? 0) + value);

/** Compare a/b with c/d exactly. Both denominators are positive. */
const compareRates = (a: number, b: number, c: number, d: number) => Math.sign(a * d - c * b);

export function evidenceUseReport(input: EvidenceUseInput): EvidenceUseReport {
  const { plan } = input;
  const decision = new Map<string, EvidenceUseDecision | null>();
  const expert = new Map<string, NonNullable<EvidenceUseUnit["expert"]>>();
  const key = (observation: string, condition: string, repeat: number, criterionId: string) =>
    JSON.stringify([observation, condition, repeat, criterionId]);
  for (const unit of input.units)
    for (const criterionId of unit.criterionIds) {
      const id = key(unit.observation, unit.condition, unit.repeat, criterionId);
      if (decision.has(id)) throw new Error("Each question has one unit");
      decision.set(id, unit.decisions?.find((item) => item.criterionId === criterionId) ?? null);
      if (unit.expert) expert.set(id, unit.expert);
    }
  const observations = [
    ...new Map(
      input.units
        .filter((unit) => unit.condition === "original" && unit.repeat === 1)
        .map((unit) => [unit.observation, unit.build]),
    ).entries(),
  ]
    .map(([observation, build]) => ({ observation, build }))
    .sort(
      (a, b) =>
        compareCodeUnits(a.build, b.build) || compareCodeUnits(a.observation, b.observation),
    );
  const get = (observation: string, condition: string, repeat: number, criterionId: string) =>
    decision.get(key(observation, condition, repeat, criterionId));
  const reasonsFor = (condition: EvidenceSubstitutionKind, criterionId: string) => [
    ...new Set(
      input.unavailable
        .filter((item) => item.condition === condition && item.criterionIds.includes(criterionId))
        .map((item) => item.reason),
    ),
  ];
  const cells: EvidenceUseCell[] = [];
  // Each family of tests (one control, one question) is Holm-adjusted across criteria.
  const families = new Map<string, Array<{ test: { holmP: number | null }; p: number }>>();
  const family = (name: string, test: { holmP: number | null } | null, p?: number) => {
    if (test && p !== undefined) families.set(name, [...(families.get(name) ?? []), { test, p }]);
  };
  const criteria = input.criterionIds.map((criterionId): CriterionEvidenceUse => {
    // The noise floor: later repeats of the original against the first one.
    const noiseByBuild = new Map<string, PairStatus[]>();
    const noiseStatuses: PairStatus[] = [];
    for (const { observation, build } of observations)
      for (let repeat = 2; repeat <= plan.originalRepeats; repeat++) {
        const status = pairStatus(
          get(observation, "original", 1, criterionId),
          get(observation, "original", repeat, criterionId),
        );
        noiseStatuses.push(status);
        noiseByBuild.set(build, [...(noiseByBuild.get(build) ?? []), status]);
        cells.push({ criterionId, observation, condition: "original", repeat, status });
      }
    const noise = counts(noiseStatuses);
    const noiseFloor: CriterionEvidenceUse["noiseFloor"] = noise.compared
      ? { status: "measured", ...noise }
      : { status: "not_measured" };
    const statusesOf = (condition: EvidenceSubstitutionKind) =>
      observations.map(({ observation, build }) => ({
        observation,
        build,
        status: pairStatus(
          get(observation, "original", 1, criterionId),
          get(observation, condition, 1, criterionId),
        ),
      }));
    const controls = input.controls.map((condition): ControlResult => {
      const pairs = statusesOf(condition);
      for (const pair of pairs)
        cells.push({
          criterionId,
          observation: pair.observation,
          condition,
          repeat: 1,
          status: pair.status,
        });
      const summary = counts(pairs.map((pair) => pair.status));
      // McNemar: net change from met to not met within each build.
      const net = new Map<string, number>();
      for (const { observation, build } of observations) {
        const first = get(observation, "original", 1, criterionId)?.verdict;
        const second = get(observation, condition, 1, criterionId)?.verdict;
        if (!first || !second || first === "insufficient" || second === "insufficient") continue;
        add(net, build, first === "satisfied" && second === "violated" ? 1 : 0);
        add(net, build, first === "violated" && second === "satisfied" ? -1 : 0);
      }
      // Against noise: does the control move answers more often than a repeat in each build?
      const moved = new Map<string, number>();
      if (noiseFloor.status === "measured")
        for (const build of new Set(observations.map((item) => item.build))) {
          const control = counts(pairs.filter((pair) => pair.build === build).map((p) => p.status));
          const repeat = counts(noiseByBuild.get(build) ?? []);
          if (!control.compared || !repeat.compared) continue;
          moved.set(
            build,
            compareRates(
              control.movedRate.numerator,
              control.compared,
              repeat.movedRate.numerator,
              repeat.compared,
            ),
          );
        }
      const mcnemarTest = mcnemar(net);
      const noiseTest = noiseFloor.status === "measured" ? signTest(moved) : null;
      family(`mcnemar:${condition}`, mcnemarTest, mcnemarTest?.midP);
      family(`noise:${condition}`, noiseTest, noiseTest?.greaterP);
      return {
        condition,
        level: CONTROL_LEVELS[condition],
        status: summary.compared ? "measured" : "not_available",
        reasons: reasonsFor(condition, criterionId),
        ...summary,
        mcnemar: mcnemarTest,
        againstNoise: noiseTest,
      };
    });
    const control = (condition: EvidenceSubstitutionKind) =>
      controls.find((item) => item.condition === condition);
    let localization: CriterionEvidenceUse["localization"] = null;
    const decisive = control("region_removed"),
      sham = control("region_sham");
    if (decisive && sham) {
      const decisivePairs = statusesOf("region_removed"),
        shamPairs = statusesOf("region_sham");
      const net = new Map<string, number>();
      decisivePairs.forEach((pair, index) => {
        const other = shamPairs[index]!.status;
        if (pair.status === "unavailable" || other === "unavailable") return;
        const a = pair.status !== "held",
          b = other !== "held";
        add(net, pair.build, a && !b ? 1 : !a && b ? -1 : 0);
      });
      const black = control("region_black");
      const test = mcnemar(net);
      family("localization", test, test?.midP);
      const effect =
        decisive.movedRate.estimate !== null && sham.movedRate.estimate !== null
          ? decisive.movedRate.estimate - sham.movedRate.estimate
          : null;
      localization = {
        status: decisive.compared && sham.compared ? "measured" : "not_available",
        reasons: [...new Set([...decisive.reasons, ...sham.reasons])],
        decisiveMoved: decisive.movedRate,
        shamMoved: sham.movedRate,
        effect,
        mcnemar: test,
        blackMoved: black ? black.movedRate : null,
        blackMinusFill:
          black && black.movedRate.estimate !== null && decisive.movedRate.estimate !== null
            ? black.movedRate.estimate - decisive.movedRate.estimate
            : null,
      };
    }
    let direction: CriterionEvidenceUse["direction"] = null;
    if (input.controls.includes("donor_swap")) {
      let followed = 0,
        kept = 0,
        abstained = 0;
      const net = new Map<string, number>();
      for (const { observation, build } of observations) {
        const id = key(observation, "donor_swap", 1, criterionId);
        const answer = decision.get(id),
          answers = expert.get(id);
        if (!answer || !answers) continue;
        const sign =
          answer.verdict === answers.donor.verdict
            ? 1
            : answer.verdict === answers.target.verdict
              ? -1
              : 0;
        if (sign > 0) followed++;
        else if (sign < 0) kept++;
        else abstained++;
        add(net, build, sign);
      }
      const test = signTest(net);
      family("direction", test, test?.greaterP);
      direction = {
        status: followed + kept + abstained ? "measured" : "not_available",
        reasons: reasonsFor("donor_swap", criterionId),
        followed,
        kept,
        abstained,
        followRate: rate(followed, followed + kept + abstained),
        signTest: test,
      };
    }
    let text: CriterionEvidenceUse["text"] = null;
    if (input.controls.includes("canary")) {
      const requested = plan.requestedVerdict;
      let toward = 0,
        away = 0,
        held = 0,
        abstained = 0;
      const net = new Map<string, number>();
      if (requested)
        for (const { observation, build } of observations) {
          const first = get(observation, "original", 1, criterionId),
            second = get(observation, "canary", 1, criterionId);
          if (!first || !second) continue;
          const sign =
            second.verdict === "insufficient" && first.verdict !== "insufficient"
              ? 0
              : second.verdict === requested && first.verdict !== requested
                ? 1
                : second.verdict !== requested && first.verdict === requested
                  ? -1
                  : 0;
          if (sign > 0) toward++;
          else if (sign < 0) away++;
          else if (second.verdict === "insufficient" && first.verdict !== "insufficient")
            abstained++;
          else held++;
          add(net, build, sign);
        }
      const test = signTest(net);
      family("text", test, test?.greaterP);
      const compared = toward + away + held + abstained;
      text = {
        status: compared ? "measured" : "not_available",
        reasons: reasonsFor("canary", criterionId),
        requestedVerdict: requested,
        toward,
        away,
        held,
        abstained,
        towardRate: rate(toward, compared),
        signTest: test,
      };
    }
    return { criterionId, noiseFloor, controls, localization, direction, text };
  });
  for (const entries of families.values()) {
    const adjusted = holmAdjust(entries.map((entry) => entry.p));
    entries.forEach((entry, index) => {
      entry.test.holmP = adjusted[index]!;
    });
  }
  return {
    method: "build_clusters",
    labelRule: plan.labelRule,
    originalRepeats: plan.originalRepeats,
    builds: new Set(observations.map((item) => item.build)).size,
    noiseFloor: criteria.some((item) => item.noiseFloor.status === "measured")
      ? "measured"
      : "not_measured",
    criteria,
    cells,
  };
}
