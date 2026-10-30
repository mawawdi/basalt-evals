import {
  AGREEMENT_GATE,
  REVIEW_REPEATS,
  type AgreementGateResult,
  type AuditAcceptance,
  type AuditQuantity,
  type AuditRater,
  type AuditRatio,
  type AuditRating,
  type AuditReliability,
  type AuditShare,
  type ExpertAnswerView,
  type ExpertComparison,
  type ExpertDisagreement,
  type ExpertStratum,
  type RaterAgreement,
  type RaterScaleAgreement,
  type RepeatAgreement,
  type ReviewAnswer,
  type ReviewCriterion,
  type ReviewDecision,
  type ReviewPopulation,
  type ReviewPurpose,
  type ReviewUnit,
  type ReviewVerdict,
} from "../../contracts/src/review.js";
import { compareCodeUnits } from "../../contracts/src/index.js";
import { acceptanceMonitor } from "./acceptance.js";
import { seededRandom } from "./protocols.js";
import {
  exactShare,
  krippendorffAlpha,
  pairedRatingStatistics,
  shareCounts,
  type RatedValue,
  type RatingPair,
} from "./statistics.js";

/** A fixed simple random sample; ending a session never calls this function again. */
export function sampleWithoutReplacement(ids: string[], limit: number, seed: string): string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    new Set(ids).size !== ids.length ||
    !/^[a-f0-9]{64}$/u.test(seed)
  )
    throw new Error("Invalid finite population sample");
  const values = [...ids].sort();
  const random = seededRandom(Number.parseInt(seed.slice(0, 8), 16));
  for (let index = 0; index < Math.min(limit, values.length); index++) {
    const chosen = index + Math.floor(random() * (values.length - index));
    [values[index], values[chosen]] = [values[chosen]!, values[index]!];
  }
  return values.slice(0, limit);
}

/** Equal-tail inversion of the hypergeometric distribution, including finite-population correction.
 * The returned integer totals include every hypothesis whose two one-sided tails exceed 2.5%.
 */
export function finitePopulationInterval(population: number, sampled: number, successes: number) {
  if (
    ![population, sampled, successes].every(Number.isSafeInteger) ||
    population < 1 ||
    sampled < 0 ||
    sampled > population ||
    successes < 0 ||
    successes > sampled
  )
    throw new Error("Invalid hypergeometric counts");
  if (!sampled) return { lower: 0, upper: 1, confidence: 0.95 as const };
  if (sampled === population)
    return {
      lower: successes / population,
      upper: successes / population,
      confidence: 0.95 as const,
    };
  const logFactorial = new Float64Array(population + 1);
  for (let i = 2; i <= population; i++) logFactorial[i] = logFactorial[i - 1]! + Math.log(i);
  const choose = (n: number, k: number) =>
    k < 0 || k > n ? -Infinity : logFactorial[n]! - logFactorial[k]! - logFactorial[n - k]!;
  const denominator = choose(population, sampled);
  const tail = (total: number, upper: boolean) => {
    const minimum = Math.max(0, sampled - (population - total));
    const maximum = Math.min(sampled, total);
    const from = upper ? Math.max(minimum, successes) : minimum;
    const to = upper ? maximum : Math.min(maximum, successes);
    let probability = 0;
    for (let k = from; k <= to; k++)
      probability += Math.exp(
        choose(total, k) + choose(population - total, sampled - k) - denominator,
      );
    return Math.min(1, probability);
  };
  let low = successes,
    high = population - sampled + successes;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tail(middle, true) >= 0.025 - 1e-12) high = middle;
    else low = middle + 1;
  }
  const lower = low / population;
  low = successes;
  high = population - sampled + successes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tail(middle, false) >= 0.025 - 1e-12) low = middle;
    else high = middle - 1;
  }
  return { lower, upper: low / population, confidence: 0.95 as const };
}

/** Unknown sampled labels remain in the sample. Consider both extreme completions. */
export function auditQuantity(
  population: number,
  values: Array<0 | 1 | null>,
  random: boolean,
): AuditQuantity {
  if (
    !Number.isSafeInteger(population) ||
    population < values.length ||
    population < 0 ||
    values.some((value) => value !== null && value !== 0 && value !== 1)
  )
    throw new Error("Invalid audit denominator");
  const numerator = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const unresolved = values.filter((value) => value === null).length;
  const selected = values.length;
  return {
    population,
    selected,
    numerator,
    denominator: selected - unresolved,
    unresolved,
    estimate: selected && !unresolved ? numerator / selected : null,
    interval:
      random && population
        ? {
            lower: finitePopulationInterval(population, selected, numerator).lower,
            upper: finitePopulationInterval(population, selected, numerator + unresolved).upper,
            confidence: 0.95,
          }
        : null,
  };
}

const BOOTSTRAP_RESAMPLES = 10_000;
type Binary = "satisfied" | "violated";
const binary = (value: string | null | undefined): value is Binary =>
  value === "satisfied" || value === "violated";

/**
 * The sequence of one reviewer: a seeded order of the units and delayed repeats of about one
 * unit in ten. A repeat comes after its first occurrence, with at least one other question
 * between them. Only the units in `repeatable` can repeat. Null gives no repeats.
 */
export function reviewSequence(
  unitIds: string[],
  seed: string,
  repeatable: ReadonlySet<string> | null,
): Array<{ unitId: string; repeat: boolean }> {
  const order = sampleWithoutReplacement(unitIds, unitIds.length, seed);
  const sequence = order.map((unitId) => ({ unitId, repeat: false }));
  if (!repeatable || order.length < 3) return sequence;
  // The last unit has no later question, so it cannot repeat after a gap.
  const candidates = order.slice(0, -1).filter((id) => repeatable.has(id));
  const count = Math.min(candidates.length, Math.round(order.length * REVIEW_REPEATS.share));
  const random = seededRandom(Number.parseInt(seed.slice(8, 16), 16));
  for (let index = 0; index < count; index++) {
    const chosen = index + Math.floor(random() * (candidates.length - index));
    [candidates[index], candidates[chosen]] = [candidates[chosen]!, candidates[index]!];
  }
  const position = new Map(order.map((id, index) => [id, index]));
  for (const unitId of candidates
    .slice(0, count)
    .sort((a, b) => position.get(a)! - position.get(b)!)) {
    const first = sequence.findIndex((entry) => entry.unitId === unitId && !entry.repeat);
    const later = sequence.length - 1 - first;
    const lowest = first + 1 + Math.min(REVIEW_REPEATS.between, later);
    sequence.splice(lowest + Math.floor(random() * (sequence.length - lowest + 1)), 0, {
      unitId,
      repeat: true,
    });
  }
  return sequence;
}

/** The authored scale of a criterion. A position is the step index on that scale. */
function authoredScale(criterion: ReviewCriterion): {
  kind: AuditReliability["kind"];
  position: (score: number) => number | null;
} {
  const range = criterion.scoreRange;
  if (range && range.step === null) return { kind: "continuous", position: (score) => score };
  if (range && range.step !== null) {
    const step = range.step;
    return {
      kind: "ordinal",
      position: (score) => {
        const units = (score - range.minimum) / step;
        return Math.abs(units - Math.round(units)) < 1e-8 ? Math.round(units) : null;
      },
    };
  }
  if (criterion.anchors?.length) {
    const scores = [...new Set(criterion.anchors.map((anchor) => anchor.score))].sort(
      (a, b) => a - b,
    );
    return {
      kind: "ordinal",
      position: (score) => (scores.includes(score) ? scores.indexOf(score) : null),
    };
  }
  return { kind: "categorical", position: () => null };
}

/** A criterion has an acceptance meaning when it is categorical or has an authored pass mark. */
const acceptanceMeaning = (criterion: ReviewCriterion) =>
  (criterion.anchors === null && criterion.scoreRange === null) ||
  criterion.minimumPassingScore !== null;

/** Index a frozen population once: each unit with its item, authored criterion and scale. */
function populationIndex(population: ReviewPopulation) {
  if (!/^[a-f0-9]{64}$/u.test(population.id))
    throw new Error("Audit population needs a content identity");
  const units = new Map(population.units.map((unit) => [unit.id, unit]));
  const items = new Map(
    population.evidence.flatMap((evidence) =>
      evidence.items.map(
        (item) => [JSON.stringify([evidence.operationId, item.id]), item] as const,
      ),
    ),
  );
  const binding = (unit: ReviewUnit) => {
    const item = items.get(JSON.stringify([unit.operationId, unit.itemId]));
    const criterion = item?.criteria.find((criterion) => criterion.id === unit.criterionId);
    if (!item || !criterion) throw new Error("Audit unit lacks its authored criterion");
    const scale = JSON.stringify({
      criterionId: criterion.id,
      statement: criterion.statement,
      rubricHash: item.rubricHash,
      anchors: criterion.anchors,
      range: criterion.scoreRange,
      threshold: criterion.minimumPassingScore,
    });
    return {
      item,
      criterion,
      scale,
      authored: authoredScale(criterion),
      candidate: JSON.stringify([unit.operationId, item.subjectId]),
    };
  };
  const unit = (id: string) => {
    const value = units.get(id);
    if (!value) throw new Error("Audit observation is not in the population");
    return value;
  };
  const populationByScale = new Map<string, number>();
  for (const member of population.units) {
    const { scale } = binding(member);
    populationByScale.set(scale, (populationByScale.get(scale) ?? 0) + 1);
  }
  // The bootstrap seed comes from the frozen population, so a report is reproducible.
  return { unit, binding, populationByScale, seed: Number.parseInt(population.id.slice(0, 8), 16) };
}

/** A rating on the authored scale, or null when the rating has no position on it. */
function ratedValue(
  authored: ReturnType<typeof authoredScale>,
  verdict: string | null,
  score: number | null,
): RatedValue | null {
  if (authored.kind === "categorical")
    return verdict === "satisfied"
      ? { score: 1, position: 1 }
      : verdict === "violated"
        ? { score: 0, position: 0 }
        : null;
  const position = score === null ? null : authored.position(score);
  return score === null || position === null ? null : { score, position };
}

/** Pure scientific interpretation, separate from persistence and session orchestration. */
export function summarizeAudit(
  population: ReviewPopulation,
  observations: Array<{ unitId: string; reviewer: string; answer: ReviewAnswer | null }>,
  purpose: ReviewPurpose,
): { acceptance: AuditAcceptance; reliability: AuditReliability[]; ratings: AuditRating[] } {
  const index = populationIndex(population);
  const random = purpose === "audit";
  const sampled = observations.map(({ unitId, reviewer, answer }) => {
    const unit = index.unit(unitId);
    const human: Binary | null =
      !answer || answer.blindingIssue || !binary(answer.verdict) ? null : answer.verdict;
    return { unit, reviewer, answer, human };
  });

  const quantity = (automatic: Binary | null, agreement: boolean) => {
    const members = population.units.filter((unit) =>
      automatic === null ? binary(unit.automatic) : unit.automatic === automatic,
    );
    const ids = new Set(members.map((unit) => unit.id));
    const values = sampled
      .filter((item) => ids.has(item.unit.id))
      .map((item) =>
        item.human === null
          ? null
          : (item.human === item.unit.automatic) === agreement
            ? (1 as const)
            : (0 as const),
      );
    return auditQuantity(members.length, values, random);
  };
  const decided = sampled.filter(
    (item) => item.unit.automatic !== null && item.unit.automatic !== "scored",
  );
  const removed = population.units.filter((unit) => binary(unit.automatic)).length;
  const scored = population.units.filter((unit) => unit.automatic === "scored").length;
  const ratio = (numerator: number, denominator: number): AuditRatio => ({
    numerator,
    denominator,
    unresolved: 0,
    estimate: denominator ? numerator / denominator : null,
  });
  const monitor = acceptanceMonitor(
    sampled
      .filter((item) => binary(item.unit.automatic))
      .map((item) => ({
        unitId: item.unit.id,
        outcome: item.unit.automatic === "satisfied" ? "auto_accept" : "auto_reject",
        expert: item.human,
      })),
  );
  const acceptance: AuditAcceptance = {
    agreement: quantity(null, true),
    falseAcceptanceShare: quantity("satisfied", false),
    falseRejectionShare: quantity("violated", false),
    missRate: shareCounts(
      decided.map((item) => ({
        member: item.human === null ? null : item.human === "violated",
        event: item.unit.automatic === "satisfied",
      })),
    ),
    falseRejectionRate: shareCounts(
      decided.map((item) => ({
        member: item.human === null ? null : item.human === "satisfied",
        event: item.unit.automatic === "violated",
      })),
    ),
    removalShare: ratio(removed, population.plannedOutcomes),
    escalationShare: ratio(
      population.plannedOutcomes - removed - scored,
      population.plannedOutcomes,
    ),
    monitor: { state: monitor.state, falsePassUnitIds: monitor.falsePassUnitIds },
  };

  const ratings: AuditRating[] = [];
  const groups = new Map<
    string,
    {
      statement: string;
      kind: AuditReliability["kind"];
      rows: Array<{ answer: ReviewAnswer | null; pair: RatingPair }>;
    }
  >();
  for (const { unit, reviewer, answer } of sampled) {
    const { criterion, scale, authored, candidate } = index.binding(unit);
    const humanScore = answer?.decision.kind === "score" ? answer.decision.value : null;
    ratings.push(
      {
        unitId: unit.id,
        candidate,
        scale,
        rater: { kind: "human", id: reviewer },
        decision: answer?.verdict ?? null,
        score: humanScore,
        flagged: !!answer?.blindingIssue,
      },
      {
        unitId: unit.id,
        candidate,
        scale,
        rater: { kind: "automatic", id: unit.treatmentId },
        decision: unit.automatic,
        score: unit.automaticScore,
        flagged: false,
      },
    );
    const group = groups.get(scale) ?? {
      statement: criterion.statement,
      kind: authored.kind,
      rows: [],
    };
    group.rows.push({
      answer,
      pair: {
        cluster: candidate,
        human: answer?.blindingIssue
          ? null
          : ratedValue(authored, answer?.verdict ?? null, humanScore),
        automatic: ratedValue(authored, unit.automatic, unit.automaticScore),
      },
    });
    groups.set(scale, group);
  }
  const reliability = [...groups.entries()].map(([scale, group]): AuditReliability => {
    const scaleAgreement = agreementOnScale(
      group.rows.map((row) => row.pair),
      index.populationByScale.get(scale)!,
      group.kind,
      index.seed,
      random,
    );
    return {
      scale,
      statement: group.statement,
      kind: group.kind,
      selected: group.rows.length,
      unanswered: group.rows.filter((row) => !row.answer).length,
      abstained: group.rows.filter((row) => row.answer?.decision.kind === "abstain").length,
      flagged: group.rows.filter((row) => row.answer?.blindingIssue).length,
      automaticMissing: scaleAgreement.automaticMissing,
      exactAgreement: scaleAgreement.exactAgreement,
      withinOne: scaleAgreement.withinOne,
      meanAbsoluteError: scaleAgreement.meanAbsoluteError,
      signedBias: scaleAgreement.signedBias,
      quadraticKappa: scaleAgreement.quadraticKappa,
      ordinalAlpha: scaleAgreement.ordinalAlpha,
      bootstrap: scaleAgreement.bootstrap,
    };
  });
  return { acceptance, reliability, ratings };
}

/** Paired agreement on one authored scale. The first rater is `human`, the second `automatic`. */
function agreementOnScale(
  pairs: RatingPair[],
  members: number,
  kind: AuditReliability["kind"],
  seed: number,
  random: boolean,
) {
  const agreement = (steps: number) =>
    auditQuantity(
      members,
      pairs.map((pair) =>
        pair.human && pair.automatic
          ? Math.abs(pair.human.position - pair.automatic.position) <= steps
            ? 1
            : 0
          : null,
      ),
      random,
    );
  const statistics = pairedRatingStatistics(pairs, {
    seed,
    resamples: BOOTSTRAP_RESAMPLES,
    confidence: 0.95,
  });
  return {
    compared: statistics.compared,
    automaticMissing: statistics.automaticMissing,
    exactAgreement: agreement(0),
    withinOne: kind === "ordinal" ? agreement(1) : null,
    meanAbsoluteError: kind === "categorical" ? null : statistics.meanAbsoluteError,
    signedBias: statistics.signedBias,
    quadraticKappa: statistics.quadraticKappa,
    ordinalAlpha: statistics.ordinalAlpha,
    bootstrap: {
      method: "candidate_cluster_bootstrap" as const,
      seed,
      resamples: BOOTSTRAP_RESAMPLES,
      confidence: 0.95 as const,
      clusters: statistics.bootstrap.clusters,
    },
  };
}

/** The label of one rater for one unit. A flagged label is unresolved in every statistic. */
interface RaterLabel {
  verdict: ReviewVerdict | null;
  score: number | null;
  flagged: boolean;
}
export function answerLabel(answer: ReviewAnswer | null): RaterLabel {
  return {
    verdict: answer?.verdict ?? null,
    score: answer?.decision.kind === "score" ? answer.decision.value : null,
    flagged: !!answer?.blindingIssue,
  };
}
export function automaticLabels(population: ReviewPopulation): Map<string, RaterLabel> {
  return new Map(
    population.units.map((unit) => [
      unit.id,
      { verdict: unit.automatic, score: unit.automaticScore, flagged: false },
    ]),
  );
}
const acceptanceOf = (label: RaterLabel | undefined): Binary | null =>
  !label || label.flagged || !binary(label.verdict) ? null : label.verdict;
const decisionValue = (decision: ReviewDecision | null) =>
  decision === null
    ? null
    : decision.kind === "abstain"
      ? "abstain"
      : `${decision.kind}:${decision.value}`;
/** True when two answers are the same decision. Cannot tell equals only Cannot tell. */
export function sameDecision(left: ReviewDecision | null, right: ReviewDecision | null) {
  return left !== null && right !== null && decisionValue(left) === decisionValue(right);
}

/**
 * The agreement of two raters on identical items: criterion acceptance with exact bounds,
 * nominal alpha, candidate acceptance under the build rule and each authored scale.
 */
export function compareRaters(
  population: ReviewPopulation,
  input: {
    pair: RaterAgreement["pair"];
    raters: [AuditRater, AuditRater];
    unitIds: string[];
    labels: [ReadonlyMap<string, RaterLabel>, ReadonlyMap<string, RaterLabel>];
    random: boolean;
  },
): RaterAgreement {
  const index = populationIndex(population);
  const [first, second] = input.labels;
  const identical = [...new Set(input.unitIds)].map(index.unit);
  const meaning = (unit: ReviewUnit) => acceptanceMeaning(index.binding(unit).criterion);
  const members = population.units.filter(meaning).length;
  const accepted = identical.filter(meaning).map((unit) => {
    const a = acceptanceOf(first.get(unit.id)),
      b = acceptanceOf(second.get(unit.id));
    return { a, b };
  });
  const code = (value: Binary | null) =>
    value === "satisfied" ? 1 : value === "violated" ? 0 : null;
  // The build rule: one required criterion not met rejects; all required criteria met accept.
  const candidates = new Map<string, ReviewUnit[]>();
  for (const unit of population.units) {
    const { criterion, candidate } = index.binding(unit);
    if (!criterion.required || !acceptanceMeaning(criterion)) continue;
    candidates.set(candidate, [...(candidates.get(candidate) ?? []), unit]);
  }
  const decide = (labels: ReadonlyMap<string, RaterLabel>, units: ReviewUnit[]) => {
    const values = units.map((unit) => acceptanceOf(labels.get(unit.id)));
    return values.includes("violated")
      ? "reject"
      : values.every((value) => value === "satisfied")
        ? "accept"
        : null;
  };
  const candidateCells = [...new Set(identical.map((unit) => index.binding(unit).candidate))]
    .sort(compareCodeUnits)
    .flatMap((candidate) => {
      const units = candidates.get(candidate);
      if (!units) return [];
      const a = decide(first, units),
        b = decide(second, units);
      return [{ member: true, event: a && b ? a === b : null }];
    });
  const groups = new Map<
    string,
    { statement: string; kind: AuditReliability["kind"]; pairs: RatingPair[] }
  >();
  for (const unit of identical) {
    const { criterion, scale, authored, candidate } = index.binding(unit);
    const rated = (label: RaterLabel | undefined) =>
      !label || label.flagged ? null : ratedValue(authored, label.verdict, label.score);
    const group = groups.get(scale) ?? {
      statement: criterion.statement,
      kind: authored.kind,
      pairs: [],
    };
    group.pairs.push({
      cluster: candidate,
      human: rated(first.get(unit.id)),
      automatic: rated(second.get(unit.id)),
    });
    groups.set(scale, group);
  }
  return {
    pair: input.pair,
    raters: input.raters,
    acceptance: auditQuantity(
      members,
      accepted.map(({ a, b }) => (a && b ? (a === b ? 1 : 0) : null)),
      input.random,
    ),
    acceptanceAlpha: krippendorffAlpha(
      accepted.map(({ a, b }) => [code(a), code(b)]),
      "nominal",
    ),
    candidateAcceptance: exactShare(candidateCells),
    scales: [...groups.entries()].map(([scale, group]): RaterScaleAgreement => {
      const { automaticMissing: _missing, ...agreement } = agreementOnScale(
        group.pairs,
        index.populationByScale.get(scale)!,
        group.kind,
        index.seed,
        input.random,
      );
      return {
        scale,
        statement: group.statement,
        kind: group.kind,
        ...agreement,
        missing: group.pairs.length - agreement.compared,
      };
    }),
  };
}

/** Within-reviewer agreement of each delayed repeat with its first occurrence. */
export function repeatAgreement(
  pairs: Array<{ unitId: string; first: ReviewAnswer | null; repeat: ReviewAnswer | null }>,
): RepeatAgreement {
  const definite = (answer: ReviewAnswer | null) =>
    answer && !answer.blindingIssue && answer.decision.kind !== "abstain" ? answer.decision : null;
  const rows = pairs.map(({ unitId, first, repeat }) => {
    const a = definite(first),
      b = definite(repeat);
    return {
      unitId,
      first: first?.decision ?? null,
      repeat: repeat?.decision ?? null,
      agreed: a && b ? sameDecision(a, b) : null,
    };
  });
  return {
    pairs: rows,
    agreement: exactShare(rows.map((row) => ({ member: true, event: row.agreed }))),
  };
}

/** One reviewer in an independent review by two reviewers. */
interface ExpertRound {
  batchId: string;
  reviewer: string;
  answered: number;
  assigned: number;
  /** The first answer of round 1 for each identical item. */
  answers: ReadonlyMap<string, ReviewAnswer | null>;
}

/**
 * Two independent reviewers and the judge on identical items. Strata separate the items where
 * the reviewers gave the same round 1 answer. Round 2 settles or keeps each disagreement.
 */
export function summarizeExperts(
  population: ReviewPopulation,
  input: {
    pairId: string;
    first: ExpertRound;
    second: ExpertRound;
    roundTwo: {
      firstBatchId: string;
      secondBatchId: string;
      unitIds: string[];
      first: ReadonlyMap<string, ReviewAnswer | null>;
      second: ReadonlyMap<string, ReviewAnswer | null>;
    } | null;
    unitIds: string[];
    random: boolean;
  },
): ExpertComparison {
  const index = populationIndex(population);
  const unitIds = [...new Set(input.unitIds)];
  const automatic = automaticLabels(population);
  const labels = (round: ExpertRound) =>
    new Map(unitIds.map((id) => [id, answerLabel(round.answers.get(id) ?? null)]));
  const firstLabels = labels(input.first),
    secondLabels = labels(input.second);
  const treatments = [...new Set(unitIds.map((id) => index.unit(id).treatmentId))];
  const judge: AuditRater = {
    kind: "automatic",
    id: treatments.length === 1 ? treatments[0]! : null,
  };
  const firstRater: AuditRater = { kind: "human", id: input.first.reviewer },
    secondRater: AuditRater = { kind: "human", id: input.second.reviewer };
  const compare = (
    pair: RaterAgreement["pair"],
    raters: [AuditRater, AuditRater],
    pairLabels: [ReadonlyMap<string, RaterLabel>, ReadonlyMap<string, RaterLabel>],
  ) =>
    compareRaters(population, { pair, raters, unitIds, labels: pairLabels, random: input.random });
  const answered = unitIds.filter(
    (id) => input.first.answers.get(id) && input.second.answers.get(id),
  );
  const agreed = new Set(
    answered.filter((id) =>
      sameDecision(input.first.answers.get(id)!.decision, input.second.answers.get(id)!.decision),
    ),
  );
  const judgeShare = (ids: string[], expert: ReadonlyMap<string, RaterLabel>) =>
    exactShare(
      ids
        .filter((id) => acceptanceMeaning(index.binding(index.unit(id)).criterion))
        .map((id) => {
          const a = acceptanceOf(automatic.get(id)),
            b = acceptanceOf(expert.get(id));
          return { member: true, event: a && b ? a === b : null };
        }),
    );
  const strata = (["agreed", "disagreed"] as const).map((stratum): ExpertStratum => {
    const ids = answered.filter((id) => agreed.has(id) === (stratum === "agreed"));
    return {
      stratum,
      units: ids.length,
      judgeFirst: judgeShare(ids, firstLabels),
      judgeSecond: judgeShare(ids, secondLabels),
    };
  });
  const view = (answer: ReviewAnswer | null | undefined): ExpertAnswerView => ({
    answerId: answer?.id ?? null,
    decision: answer?.decision ?? null,
    verdict: answer?.verdict ?? null,
    reason: answer?.reason ?? null,
    flagged: !!answer?.blindingIssue,
  });
  const disagreements = answered
    .filter((id) => !agreed.has(id))
    .map((id): ExpertDisagreement => {
      const unit = index.unit(id);
      const { item, criterion } = index.binding(unit);
      const pass = item.passes.find((pass) => pass.id === unit.passId);
      const roundTwo = input.roundTwo?.unitIds.includes(id) ? input.roundTwo : null;
      const firstFinal = roundTwo ? (roundTwo.first.get(id) ?? null) : null,
        secondFinal = roundTwo ? (roundTwo.second.get(id) ?? null) : null;
      return {
        unitId: id,
        operationId: unit.operationId,
        candidateId: item.subjectId,
        criterionId: unit.criterionId,
        statement: criterion.statement,
        pass: pass?.number ?? 0,
        automatic: { verdict: unit.automatic, score: unit.automaticScore },
        first: view(input.first.answers.get(id)),
        second: view(input.second.answers.get(id)),
        firstRoundTwo: roundTwo ? view(firstFinal) : null,
        secondRoundTwo: roundTwo ? view(secondFinal) : null,
        status: !roundTwo
          ? "awaiting_round_two"
          : !firstFinal || !secondFinal
            ? "round_two_open"
            : sameDecision(firstFinal.decision, secondFinal.decision)
              ? "resolved"
              : "contested",
      };
    });
  return {
    pairId: input.pairId,
    first: {
      batchId: input.first.batchId,
      reviewer: input.first.reviewer,
      answered: input.first.answered,
      assigned: input.first.assigned,
    },
    second: {
      batchId: input.second.batchId,
      reviewer: input.second.reviewer,
      answered: input.second.answered,
      assigned: input.second.assigned,
    },
    roundTwo: input.roundTwo
      ? {
          firstBatchId: input.roundTwo.firstBatchId,
          secondBatchId: input.roundTwo.secondBatchId,
          questions: input.roundTwo.unitIds.length,
        }
      : null,
    items: unitIds.length,
    unanswered: unitIds.length - answered.length,
    agreements: [
      compare("judge_first", [judge, firstRater], [automatic, firstLabels]),
      compare("judge_second", [judge, secondRater], [automatic, secondLabels]),
      compare("first_second", [firstRater, secondRater], [firstLabels, secondLabels]),
    ],
    strata,
    disagreements,
    contested: disagreements
      .filter((item) => item.status === "contested")
      .map((item) => item.unitId),
    claim:
      "The two reviewers give one measure of agreement between experts. A test that shows if the judge can replace a reviewer needs three or more reviewers. This report has only two reviewers, so it does not make that test. Round 2 answers are not independent, so they never count in an agreement.",
  };
}

/**
 * The acceptance gate relative to the expert ceiling. It is met when each judge–expert
 * estimate is at least the minimum and at most the maximum shortfall below the expert–expert
 * estimate. The shares keep their exact lower bounds for the report.
 */
export function agreementGate(input: {
  applicable: boolean;
  judgeFirst: AuditShare | null;
  judgeSecond: AuditShare | null;
  experts: AuditShare | null;
}): AgreementGateResult {
  const base = {
    metric: AGREEMENT_GATE.metric,
    minimum: AGREEMENT_GATE.minimum,
    maximumShortfall: AGREEMENT_GATE.maximumShortfall,
    judgeFirst: input.judgeFirst,
    judgeSecond: input.judgeSecond,
    experts: input.experts,
  };
  if (!input.applicable) return { ...base, shortfall: null, state: "not_applicable" };
  if (!input.judgeFirst || !input.judgeSecond || !input.experts)
    return { ...base, shortfall: null, state: "needs_second_reviewer" };
  const first = input.judgeFirst.estimate,
    second = input.judgeSecond.estimate,
    experts = input.experts.estimate;
  if (first === null || second === null || experts === null)
    return { ...base, shortfall: null, state: "unresolved" };
  const worst = Math.min(first, second),
    shortfall = experts - worst;
  return {
    ...base,
    shortfall,
    state:
      worst >= AGREEMENT_GATE.minimum - 1e-12 &&
      shortfall <= AGREEMENT_GATE.maximumShortfall + 1e-12
        ? "met"
        : "not_met",
  };
}
