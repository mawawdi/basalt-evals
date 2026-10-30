import { compareCodeUnits } from "../../contracts/src/index.js";
import { seededRandom } from "./protocols.js";

/*
 * Pure exact statistics. Each function returns its numerator and denominator with the
 * result. No function reads model confidence, files, clocks or provider data.
 */

function nonnegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative integer`);
}
function binomialCounts(successes: number, trials: number) {
  nonnegativeInteger(successes, "Successes");
  nonnegativeInteger(trials, "Trials");
  if (successes > trials) throw new Error("Successes cannot be more than trials");
}
function confidenceLevel(confidence: number) {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1)
    throw new Error("Confidence must be between 0 and 1");
}
function openRate(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1)
    throw new Error(`${label} must be between 0 and 1`);
}

const logFactorials = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++)
    logFactorials.push(logFactorials[i - 1]! + Math.log(i));
  return logFactorials[n]!;
}
function binomialMass(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(
    logFactorial(n) -
      logFactorial(k) -
      logFactorial(n - k) +
      k * Math.log(p) +
      (n - k) * Math.log1p(-p),
  );
}
/** P(X <= k) for X ~ Binomial(n, p), summed directly. */
function lowerTail(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += binomialMass(i, n, p);
  return Math.min(1, sum);
}
/** P(X >= k) for X ~ Binomial(n, p), summed directly. */
function upperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i++) sum += binomialMass(i, n, p);
  return Math.min(1, sum);
}

/** One-sided exact (Clopper–Pearson) upper bound of a binomial proportion. */
export function clopperPearsonUpper(successes: number, trials: number, confidence: number) {
  binomialCounts(successes, trials);
  confidenceLevel(confidence);
  if (trials === 0 || successes === trials) return 1;
  const alpha = 1 - confidence;
  if (successes === 0) return 1 - alpha ** (1 / trials);
  // P(X <= x | p) decreases in p. Keep the high side so that the bound stays conservative.
  let low = successes / trials,
    high = 1;
  for (let step = 0; step < 200 && high - low > 1e-15; step++) {
    const middle = (low + high) / 2;
    if (lowerTail(successes, trials, middle) > alpha) low = middle;
    else high = middle;
  }
  return high;
}

/** One-sided exact (Clopper–Pearson) lower bound of a binomial proportion. */
export function clopperPearsonLower(successes: number, trials: number, confidence: number) {
  binomialCounts(successes, trials);
  confidenceLevel(confidence);
  if (trials === 0 || successes === 0) return 0;
  const alpha = 1 - confidence;
  if (successes === trials) return alpha ** (1 / trials);
  // P(X >= x | p) increases in p. Keep the low side so that the bound stays conservative.
  let low = 0,
    high = successes / trials;
  for (let step = 0; step < 200 && high - low > 1e-15; step++) {
    const middle = (low + high) / 2;
    if (upperTail(successes, trials, middle) < alpha) low = middle;
    else high = middle;
  }
  return low;
}

/** Two-sided equal-tail exact (Clopper–Pearson) interval. */
export function clopperPearsonInterval(successes: number, trials: number, confidence = 0.95) {
  confidenceLevel(confidence);
  const tail = (1 + confidence) / 2;
  return {
    lower: clopperPearsonLower(successes, trials, tail),
    upper: clopperPearsonUpper(successes, trials, tail),
    confidence,
  };
}

/** One cell of a share: membership in the denominator and the counted event. Null is unknown. */
interface ShareCell {
  member: boolean | null;
  event: boolean | null;
}
/** Known counts of a share. An unresolved cell has an unknown membership or event. */
interface ShareCounts {
  numerator: number;
  denominator: number;
  unresolved: number;
  /** Null when the denominator is zero or a cell is unresolved: no complete-case estimate. */
  estimate: number | null;
}
export interface ExactShare extends ShareCounts {
  interval: { lower: number; upper: number; confidence: number; method: "clopper_pearson" } | null;
}

/** Count a share without an interval. */
export function shareCounts(cells: ShareCell[]): ShareCounts {
  let numerator = 0,
    denominator = 0,
    unresolved = 0;
  for (const cell of cells) {
    if (cell.member === false) continue;
    if (cell.member === null || cell.event === null) {
      unresolved++;
      continue;
    }
    denominator++;
    if (cell.event) numerator++;
  }
  return {
    numerator,
    denominator,
    unresolved,
    estimate: denominator && !unresolved ? numerator / denominator : null,
  };
}

/**
 * A share with a two-sided exact interval over independent cells. The interval covers
 * every completion of the unknown cells. The lower bound uses the completion with the
 * lowest share. The upper bound uses the completion with the highest share.
 */
export function exactShare(cells: ShareCell[], confidence = 0.95): ExactShare {
  confidenceLevel(confidence);
  const counts = shareCounts(cells);
  let lowEvents = 0,
    lowMembers = 0,
    highEvents = 0,
    highMembers = 0;
  for (const { member, event } of cells) {
    if (member === false) continue;
    if (member === true) {
      lowMembers++;
      highMembers++;
      if (event === true) lowEvents++;
      if (event !== false) highEvents++;
      continue;
    }
    if (event !== true) lowMembers++;
    if (event !== false) {
      highMembers++;
      highEvents++;
    }
  }
  const tail = (1 + confidence) / 2;
  return {
    ...counts,
    interval:
      lowMembers || highMembers
        ? {
            lower: lowMembers ? clopperPearsonLower(lowEvents, lowMembers, tail) : 0,
            upper: highMembers ? clopperPearsonUpper(highEvents, highMembers, tail) : 1,
            confidence,
            method: "clopper_pearson",
          }
        : null,
  };
}

/** The smallest count of independent failing builds that certifies a miss rate with zero misses. */
export function requiredFailingBuilds(maxMissRate: number, confidence: number) {
  openRate(maxMissRate, "Maximum miss rate");
  confidenceLevel(confidence);
  const alpha = 1 - confidence;
  let builds = Math.max(1, Math.ceil(Math.log(alpha) / Math.log1p(-maxMissRate)));
  while (builds > 1 && lowerTail(0, builds - 1, maxMissRate) <= alpha) builds--;
  while (lowerTail(0, builds, maxMissRate) > alpha) builds++;
  return builds;
}

/** One independent failing build: true if the rule accepted it, false if not, null if unresolved. */
export type FailingBuildOutcome = boolean | null;

/** One-sided exact upper bound of a miss rate. An unresolved failing build counts as a miss. */
export function missRateBound(outcomes: FailingBuildOutcome[], confidence = 0.95) {
  confidenceLevel(confidence);
  if (outcomes.some((value) => value !== true && value !== false && value !== null))
    throw new Error("A failing build outcome must be true, false or unresolved");
  const misses = outcomes.filter((value) => value === true).length,
    unresolved = outcomes.filter((value) => value === null).length;
  return {
    failingBuilds: outcomes.length,
    misses,
    unresolved,
    countedMisses: misses + unresolved,
    upperBound: clopperPearsonUpper(misses + unresolved, outcomes.length, confidence),
    confidence,
  };
}

/** Exact binomial certificate: is the miss rate at or below the maximum at this confidence? */
export function certifyMissRate(
  outcomes: FailingBuildOutcome[],
  maxMissRate: number,
  confidence: number,
) {
  openRate(maxMissRate, "Maximum miss rate");
  const bound = missRateBound(outcomes, confidence);
  const pValue = lowerTail(bound.countedMisses, bound.failingBuilds, maxMissRate);
  return {
    ...bound,
    maxMissRate,
    pValue,
    certified: bound.failingBuilds > 0 && pValue <= 1 - confidence,
  };
}

/**
 * Fixed-sequence test of a preregistered, ordered rule list (learn then test). Test the
 * rules in order at the full level and stop at the first rule that does not certify.
 * The last certified rule is the result. The family-wise error stays at 1 - confidence.
 */
export function certifyRuleSequence(
  rules: Array<{ id: string; outcomes: FailingBuildOutcome[] }>,
  maxMissRate: number,
  confidence: number,
) {
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
    throw new Error("Rule identities must be unique");
  const tests: Array<{ ruleId: string } & ReturnType<typeof certifyMissRate>> = [];
  let certifiedRuleId: string | null = null;
  for (const rule of rules) {
    const test = { ruleId: rule.id, ...certifyMissRate(rule.outcomes, maxMissRate, confidence) };
    tests.push(test);
    if (!test.certified) break;
    certifiedRuleId = rule.id;
  }
  return {
    method: "fixed_sequence" as const,
    maxMissRate,
    confidence,
    tests,
    untestedRuleIds: rules.slice(tests.length).map((rule) => rule.id),
    certifiedRuleId,
  };
}

/** Exact sign test. Ties are not counts. greaterP is P(X >= positives) under p = 0.5. */
export function exactSignTest(positives: number, negatives: number) {
  nonnegativeInteger(positives, "Positive count");
  nonnegativeInteger(negatives, "Negative count");
  const n = positives + negatives;
  const greaterP = upperTail(positives, n, 0.5),
    lessP = lowerTail(positives, n, 0.5);
  return {
    positives,
    negatives,
    n,
    greaterP,
    lessP,
    twoSidedP: Math.min(1, 2 * Math.min(greaterP, lessP)),
  };
}

/** Exact conditional McNemar test and its mid-p value over the discordant pairs. */
export function exactMcNemar(firstOnly: number, secondOnly: number) {
  nonnegativeInteger(firstOnly, "Discordant count");
  nonnegativeInteger(secondOnly, "Discordant count");
  const discordant = firstOnly + secondOnly,
    smaller = Math.min(firstOnly, secondOnly);
  const tail = lowerTail(smaller, discordant, 0.5);
  return {
    firstOnly,
    secondOnly,
    discordant,
    exactP: Math.min(1, 2 * tail),
    midP: Math.min(1, 2 * tail - binomialMass(smaller, discordant, 0.5)),
  };
}

function logChoose(n: number, k: number) {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * Fisher's exact test of a 2 × 2 table with the rows [a, b] and [c, d]. The two-sided p adds
 * the probability of each table with the same margins that is not more probable than the
 * observed table. A relative tolerance of 1e-7 keeps tables of equal probability together.
 */
export function fisherExact(a: number, b: number, c: number, d: number) {
  for (const value of [a, b, c, d]) nonnegativeInteger(value, "A table count");
  const first = a + b,
    second = c + d,
    column = a + c;
  const low = Math.max(0, column - second),
    high = Math.min(column, first);
  const total = logChoose(first + second, column);
  const probability = (x: number) =>
    Math.exp(logChoose(first, x) + logChoose(second, column - x) - total);
  const observed = probability(a);
  let twoSided = 0,
    less = 0,
    greater = 0;
  for (let x = low; x <= high; x++) {
    const value = probability(x);
    if (value <= observed * (1 + 1e-7)) twoSided += value;
    if (x <= a) less += value;
    if (x >= a) greater += value;
  }
  return {
    table: [
      [a, b],
      [c, d],
    ] as const,
    twoSidedP: Math.min(1, twoSided),
    lessP: Math.min(1, less),
    greaterP: Math.min(1, greater),
  };
}

const smallestFisherP = new Map<string, number>();
/**
 * The smallest two-sided Fisher p of any table with these row totals. No answers of these
 * builds can give a smaller p, so a test cannot decide when it is above the level.
 */
export function fisherMinimumP(first: number, second: number) {
  nonnegativeInteger(first, "A row total");
  nonnegativeInteger(second, "A row total");
  const key = `${first}:${second}`;
  let smallest = smallestFisherP.get(key);
  if (smallest === undefined) {
    smallest = 1;
    for (let a = 0; a <= first; a++)
      for (let c = 0; c <= second; c++)
        smallest = Math.min(smallest, fisherExact(a, first - a, c, second - c).twoSidedP);
    smallestFisherP.set(key, smallest);
  }
  return smallest;
}

/** The relabellings that a stratified permutation test enumerates before it samples. */
const EXACT_RELABELLINGS = 100_000;

/**
 * The size of a stratified permutation test from the group sizes of each stratum. If the
 * relabellings are at most 100,000, the test is exact. `minimumP` is the smallest p that any
 * values can give. With equal groups in each stratum, each assignment of labels has a mirror
 * that is as extreme, so it is 2 / relabellings.
 */
export function permutationSize(strata: Array<{ first: number; second: number }>, draws: number) {
  if (!strata.length) throw new Error("A permutation test needs at least one stratum");
  if (!Number.isSafeInteger(draws) || draws < 1)
    throw new Error("Permutation draws must be a positive integer");
  for (const { first, second } of strata) {
    nonnegativeInteger(first, "A group size");
    nonnegativeInteger(second, "A group size");
    if (!first || !second) throw new Error("Each stratum needs values in both groups");
  }
  const relabellings = Math.round(
    strata.reduce(
      (product, { first, second }) => product * Math.exp(logChoose(first + second, first)),
      1,
    ),
  );
  const balanced = strata.every(({ first, second }) => first === second);
  return relabellings <= EXACT_RELABELLINGS
    ? {
        method: "exact" as const,
        relabellings,
        draws: null,
        minimumP: Math.min(1, (balanced ? 2 : 1) / relabellings),
      }
    : // More than 100,000 relabellings: the exact count can be too large for a number.
      { method: "monte_carlo" as const, relabellings: null, draws, minimumP: 1 / (1 + draws) };
}

/**
 * A two-sided permutation test of two groups inside strata, for example builds of two models
 * inside evaluations. Labels move only inside a stratum. The statistic is the sum over strata
 * of the difference of the group means. If the relabellings are at most 100,000, the test
 * enumerates all of them. Otherwise it draws seeded random relabellings, and p is
 * (1 + extreme draws) / (1 + draws).
 */
export function stratifiedPermutationTest(
  strata: Array<{ first: number[]; second: number[] }>,
  options: { seed: number; draws: number },
) {
  const size = permutationSize(
    strata.map(({ first, second }) => ({ first: first.length, second: second.length })),
    options.draws,
  );
  for (const stratum of strata)
    if (![...stratum.first, ...stratum.second].every(Number.isFinite))
      throw new Error("Permutation values must be finite numbers");
  const shapes = strata.map(({ first, second }) => {
    const values = [...first, ...second];
    return {
      values,
      size: first.length,
      sum: values.reduce((total, value) => total + value, 0),
    };
  });
  const contribution = (shape: (typeof shapes)[number], chosen: number) =>
    chosen / shape.size - (shape.sum - chosen) / (shape.values.length - shape.size);
  const statistic = shapes.reduce(
    (total, shape, index) =>
      total +
      contribution(
        shape,
        strata[index]!.first.reduce((sum, value) => sum + value, 0),
      ),
    0,
  );
  // A relative tolerance keeps the observed statistic among the relabellings that equal it.
  const extreme = (value: number) =>
    Math.abs(value) >= Math.abs(statistic) - 1e-9 * Math.max(1, Math.abs(statistic));
  if (size.method === "exact") {
    let sums = [0];
    for (const shape of shapes) {
      const contributions: number[] = [];
      const indexes = Array.from({ length: shape.size }, (_, index) => index);
      const n = shape.values.length;
      for (;;) {
        contributions.push(
          contribution(
            shape,
            indexes.reduce((sum, index) => sum + shape.values[index]!, 0),
          ),
        );
        let position = shape.size - 1;
        while (position >= 0 && indexes[position] === n - shape.size + position) position--;
        if (position < 0) break;
        indexes[position]!++;
        for (let next = position + 1; next < shape.size; next++)
          indexes[next] = indexes[next - 1]! + 1;
      }
      sums = sums.flatMap((sum) => contributions.map((value) => sum + value));
    }
    return {
      ...size,
      statistic,
      twoSidedP: Math.min(1, sums.filter(extreme).length / sums.length),
    };
  }
  const random = seededRandom(options.seed);
  const orders = shapes.map((shape) => shape.values.map((_, index) => index));
  let count = 0;
  for (let draw = 0; draw < options.draws; draw++) {
    let sum = 0;
    shapes.forEach((shape, index) => {
      const order = orders[index]!;
      let chosen = 0;
      for (let position = 0; position < shape.size; position++) {
        const swap = position + Math.floor(random() * (order.length - position));
        [order[position], order[swap]] = [order[swap]!, order[position]!];
        chosen += shape.values[order[position]!]!;
      }
      sum += contribution(shape, chosen);
    });
    if (extreme(sum)) count++;
  }
  return { ...size, statistic, twoSidedP: (1 + count) / (1 + options.draws) };
}

/** Holm step-down adjustment. The result keeps the input order. */
export function holmAdjust(pValues: number[]): number[] {
  if (pValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
    throw new Error("A p value must be between 0 and 1");
  const order = pValues
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ value, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * value));
    adjusted[index] = running;
  });
  return adjusted;
}

type AlphaMetric = "nominal" | "ordinal" | "interval";

/**
 * Krippendorff's alpha for any count of raters with missing values (Krippendorff 2011).
 * Each unit lists one value per rater; null is a missing value. A unit with fewer than two
 * values is not pairable. The result is null when the expected disagreement is zero.
 */
export function krippendorffAlpha(
  units: Array<Array<number | null>>,
  metric: AlphaMetric,
): number | null {
  const coincidence = new Map<number, Map<number, number>>();
  const add = (first: number, second: number, weight: number) => {
    const row = coincidence.get(first) ?? new Map<number, number>();
    row.set(second, (row.get(second) ?? 0) + weight);
    coincidence.set(first, row);
  };
  for (const unit of units) {
    const values = unit.filter((value): value is number => value !== null);
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error("Alpha values must be finite numbers or missing");
    if (values.length < 2) continue;
    const weight = 1 / (values.length - 1);
    for (let i = 0; i < values.length; i++)
      for (let j = 0; j < values.length; j++) if (i !== j) add(values[i]!, values[j]!, weight);
  }
  const categories = [...coincidence.keys()].sort((a, b) => a - b);
  const totals = categories.map((category) =>
    [...coincidence.get(category)!.values()].reduce((sum, value) => sum + value, 0),
  );
  const pairable = totals.reduce((sum, value) => sum + value, 0);
  if (pairable < 2) return null;
  const cumulative: number[] = [];
  totals.forEach((value, index) => cumulative.push((index ? cumulative[index - 1]! : 0) + value));
  const distance = (i: number, j: number) => {
    if (i === j) return 0;
    if (metric === "nominal") return 1;
    if (metric === "interval") return (categories[i]! - categories[j]!) ** 2;
    const low = Math.min(i, j),
      high = Math.max(i, j);
    const between = cumulative[high]! - (low ? cumulative[low - 1]! : 0);
    return (between - (totals[i]! + totals[j]!) / 2) ** 2;
  };
  let observed = 0,
    expected = 0;
  for (let i = 0; i < categories.length; i++)
    for (let j = 0; j < categories.length; j++) {
      const d = distance(i, j);
      if (!d) continue;
      observed += (coincidence.get(categories[i]!)!.get(categories[j]!) ?? 0) * d;
      expected += totals[i]! * totals[j]! * d;
    }
  expected /= pairable - 1;
  return expected > 0 ? 1 - observed / expected : null;
}

/** Quadratic weighted kappa on scale positions. Null when the expected disagreement is zero. */
export function quadraticWeightedKappa(pairs: Array<[number, number]>): number | null {
  if (!pairs.length) return null;
  if (pairs.some((pair) => !pair.every(Number.isFinite)))
    throw new Error("Kappa positions must be finite numbers");
  const first = new Map<number, number>(),
    second = new Map<number, number>();
  let observed = 0;
  for (const [a, b] of pairs) {
    observed += (a - b) ** 2;
    first.set(a, (first.get(a) ?? 0) + 1);
    second.set(b, (second.get(b) ?? 0) + 1);
  }
  let expected = 0;
  for (const [a, countA] of first)
    for (const [b, countB] of second) expected += countA * countB * (a - b) ** 2;
  expected /= pairs.length;
  return expected > 0 ? 1 - observed / expected : null;
}

function percentileInterval(values: number[], confidence: number) {
  values.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    lower: values[Math.floor(tail * (values.length - 1))]!,
    upper: values[Math.ceil((1 - tail) * (values.length - 1))]!,
  };
}

/**
 * Percentile intervals from a seeded resample of whole clusters with replacement. With a
 * stratum, each resample draws the clusters of each stratum only from that stratum, so each
 * stratum keeps its count of clusters. All items of a cluster must have one stratum. A
 * statistic that is undefined in any resample has no interval. Fewer than two clusters give
 * no interval.
 */
export function clusterBootstrap<T>(
  items: T[],
  cluster: (item: T) => string,
  statistics: (sample: T[]) => Array<number | null>,
  options: {
    seed: number;
    resamples: number;
    confidence: number;
    stratum?: (item: T) => string;
  },
) {
  confidenceLevel(options.confidence);
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1)
    throw new Error("Bootstrap resamples must be a positive integer");
  const map = new Map<string, { stratum: string; members: T[] }>();
  for (const item of items) {
    const id = cluster(item),
      stratum = options.stratum?.(item) ?? "";
    const entry = map.get(id) ?? { stratum, members: [] };
    if (entry.stratum !== stratum) throw new Error("A bootstrap cluster must have one stratum");
    entry.members.push(item);
    map.set(id, entry);
  }
  const strataMap = new Map<string, T[][]>();
  for (const [, entry] of [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b)))
    strataMap.set(entry.stratum, [...(strataMap.get(entry.stratum) ?? []), entry.members]);
  const strata = [...strataMap.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, clusters]) => clusters);
  const width = statistics(items).length;
  if (map.size < 2)
    return { clusters: map.size, intervals: Array.from({ length: width }, () => null) };
  const random = seededRandom(options.seed);
  const draws = Array.from({ length: width }, () => [] as number[]);
  const undefinedDraws = new Array<boolean>(width).fill(false);
  for (let iteration = 0; iteration < options.resamples; iteration++) {
    const sample: T[] = [];
    for (const clusters of strata)
      for (let index = 0; index < clusters.length; index++)
        sample.push(...clusters[Math.floor(random() * clusters.length)]!);
    statistics(sample).forEach((value, index) => {
      if (value === null) undefinedDraws[index] = true;
      else draws[index]!.push(value);
    });
  }
  return {
    clusters: map.size,
    intervals: draws.map((values, index) =>
      undefinedDraws[index] ? null : percentileInterval(values, options.confidence),
    ),
  };
}

/** One rating on an authored scale: the authored score and its position on the scale. */
export interface RatedValue {
  score: number;
  position: number;
}
export interface RatingPair {
  cluster: string;
  human: RatedValue | null;
  automatic: RatedValue | null;
}
interface RatingEstimate {
  value: number | null;
  interval: { lower: number; upper: number } | null;
}

/** Additive counts of one cluster. The bootstrap sums them, so a resample stays cheap. */
interface RatingSummary {
  id: string;
  n: number;
  absolute: number;
  signed: number;
  /** Counts of (human position, automatic position) on the shared position index. */
  joint: Float64Array;
}

function ratingValues(summaries: RatingSummary[], positions: number[]): Array<number | null> {
  const size = positions.length;
  const joint = new Float64Array(size * size);
  let n = 0,
    absolute = 0,
    signed = 0;
  for (const summary of summaries) {
    n += summary.n;
    absolute += summary.absolute;
    signed += summary.signed;
    for (let cell = 0; cell < joint.length; cell++) joint[cell]! += summary.joint[cell]!;
  }
  if (!n) return [null, null, null, null];
  const rows = new Float64Array(size),
    columns = new Float64Array(size);
  let observed = 0;
  for (let i = 0; i < size; i++)
    for (let j = 0; j < size; j++) {
      const count = joint[i * size + j]!;
      rows[i]! += count;
      columns[j]! += count;
      observed += count * (positions[i]! - positions[j]!) ** 2;
    }
  let expected = 0;
  for (let i = 0; i < size; i++)
    for (let j = 0; j < size; j++)
      expected += rows[i]! * columns[j]! * (positions[i]! - positions[j]!) ** 2;
  expected /= n;
  // Two raters: each complete pair is one pairable unit with weight 1 / (2 - 1).
  const totals = rows.map((value, index) => value + columns[index]!);
  const cumulative: number[] = [];
  totals.forEach((value, index) => cumulative.push((index ? cumulative[index - 1]! : 0) + value));
  let disagreement = 0,
    chance = 0;
  for (let i = 0; i < size; i++)
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      const low = Math.min(i, j),
        high = Math.max(i, j);
      const distance =
        (cumulative[high]! - (low ? cumulative[low - 1]! : 0) - (totals[i]! + totals[j]!) / 2) ** 2;
      disagreement += (joint[i * size + j]! + joint[j * size + i]!) * distance;
      chance += totals[i]! * totals[j]! * distance;
    }
  return [
    absolute / n,
    signed / n,
    expected > 0 ? 1 - observed / expected : null,
    chance > 0 ? 1 - ((2 * n - 1) * disagreement) / chance : null,
  ];
}

/**
 * Agreement between a human and an automatic rater on one authored scale. A pair with a
 * missing value stays in the counts. With two raters, alpha drops it as unpairable. The
 * other statistics use complete pairs. Intervals resample whole clusters.
 */
export function pairedRatingStatistics(
  pairs: RatingPair[],
  options: { seed: number; resamples: number; confidence: number },
) {
  const complete = pairs.filter(
    (pair): pair is RatingPair & { human: RatedValue; automatic: RatedValue } =>
      pair.human !== null && pair.automatic !== null,
  );
  if (
    complete.some(
      (pair) =>
        ![
          pair.human.score,
          pair.human.position,
          pair.automatic.score,
          pair.automatic.position,
        ].every(Number.isFinite),
    )
  )
    throw new Error("Rating scores and positions must be finite numbers");
  const positions = [
    ...new Set(complete.flatMap((pair) => [pair.human.position, pair.automatic.position])),
  ].sort((a, b) => a - b);
  const index = new Map(positions.map((position, order) => [position, order]));
  const clusters = new Map<string, RatingSummary>();
  for (const { cluster, human, automatic } of complete) {
    const summary = clusters.get(cluster) ?? {
      id: cluster,
      n: 0,
      absolute: 0,
      signed: 0,
      joint: new Float64Array(positions.length ** 2),
    };
    summary.n++;
    summary.absolute += Math.abs(automatic.score - human.score);
    summary.signed += automatic.score - human.score;
    summary.joint[
      index.get(human.position)! * positions.length + index.get(automatic.position)!
    ]! += 1;
    clusters.set(cluster, summary);
  }
  const summaries = [...clusters.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  const values = (sample: RatingSummary[]) => ratingValues(sample, positions);
  const point = values(summaries);
  const bootstrap = clusterBootstrap(summaries, (summary) => summary.id, values, options);
  const estimate = (index: number): RatingEstimate => ({
    value: point[index]!,
    interval: point[index] === null ? null : bootstrap.intervals[index]!,
  });
  return {
    pairs: pairs.length,
    compared: complete.length,
    humanMissing: pairs.filter((pair) => pair.human === null).length,
    automaticMissing: pairs.filter((pair) => pair.automatic === null).length,
    meanAbsoluteError: estimate(0),
    signedBias: estimate(1),
    quadraticKappa: estimate(2),
    ordinalAlpha: estimate(3),
    bootstrap: {
      method: "cluster_percentile_bootstrap" as const,
      seed: options.seed,
      resamples: options.resamples,
      confidence: options.confidence,
      clusters: bootstrap.clusters,
    },
  };
}

/**
 * Two separate sources of automatic disagreement. An identical-request flip is a change
 * between repeats of one identical request: judge variance only. A cross-capture
 * disagreement is a change between captures of one group. It uses only captures whose
 * repeats agree, so a flip never counts twice.
 */
export function disagreementRates(
  samples: Array<{ group: string; capture: string; request: string; decision: string | null }>,
) {
  const requests = new Map<string, typeof samples>();
  for (const sample of samples)
    requests.set(sample.request, [...(requests.get(sample.request) ?? []), sample]);
  for (const repeats of requests.values())
    if (new Set(repeats.map((sample) => JSON.stringify([sample.group, sample.capture]))).size !== 1)
      throw new Error("An identical request must belong to one capture and one group");
  let flips = 0,
    repeated = 0,
    unresolvedRepeats = 0;
  const captureDecision = new Map<string, string | null>();
  for (const repeats of requests.values()) {
    const resolved = repeats.flatMap((sample) =>
      sample.decision === null ? [] : [sample.decision],
    );
    const distinct = new Set(resolved);
    if (repeats.length > 1) {
      if (resolved.length < repeats.length) unresolvedRepeats++;
      else {
        repeated++;
        if (distinct.size > 1) flips++;
      }
    }
    const key = JSON.stringify([repeats[0]!.group, repeats[0]!.capture]);
    const stable = resolved.length === repeats.length && distinct.size === 1 ? resolved[0]! : null;
    const prior = captureDecision.get(key);
    captureDecision.set(
      key,
      prior === undefined ? stable : prior !== null && prior === stable ? prior : null,
    );
  }
  const groups = new Map<string, Array<string | null>>();
  for (const [key, decision] of captureDecision) {
    const [group] = JSON.parse(key) as [string, string];
    groups.set(group, [...(groups.get(group) ?? []), decision]);
  }
  let disagreements = 0,
    compared = 0,
    unresolvedGroups = 0;
  for (const decisions of groups.values()) {
    if (decisions.length < 2) continue;
    if (decisions.includes(null)) {
      unresolvedGroups++;
      continue;
    }
    compared++;
    if (new Set(decisions).size > 1) disagreements++;
  }
  const rate = (numerator: number, denominator: number, unresolved: number) => ({
    numerator,
    denominator,
    unresolved,
    estimate: denominator && !unresolved ? numerator / denominator : null,
  });
  return {
    identicalRequestFlips: rate(flips, repeated, unresolvedRepeats),
    crossCaptureDisagreement: rate(disagreements, compared, unresolvedGroups),
  };
}

type Outcome = 0 | 1 | null;

/**
 * Compare two arms inside blocks, for example task × model. Builds inside a block are
 * independent; a repetition index never pairs them. Each block gives one difference of
 * acceptance rates with bounds over unresolved builds. An exact sign test counts the
 * blocks. An unresolved block counts against the direction under test.
 */
export function blockedComparison(
  items: Array<{ block: string; arm: "baseline" | "treatment"; outcome: Outcome }>,
) {
  if (!items.length) throw new Error("A blocked comparison needs planned builds");
  if (items.some((item) => item.outcome !== 0 && item.outcome !== 1 && item.outcome !== null))
    throw new Error("Outcome must be binary or explicitly unresolved");
  const map = new Map<string, typeof items>();
  for (const item of items) map.set(item.block, [...(map.get(item.block) ?? []), item]);
  const arm = (members: typeof items, name: "baseline" | "treatment") => {
    const outcomes = members.filter((item) => item.arm === name).map((item) => item.outcome);
    if (!outcomes.length) throw new Error("Each block needs builds in both arms");
    return {
      intended: outcomes.length,
      accepted: outcomes.filter((value) => value === 1).length,
      rejected: outcomes.filter((value) => value === 0).length,
      unresolved: outcomes.filter((value) => value === null).length,
    };
  };
  const blocks = [...map.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([block, members]) => {
      const baseline = arm(members, "baseline"),
        treatment = arm(members, "treatment");
      // Integer cross products keep the direction exact.
      const lowSign =
        treatment.accepted * baseline.intended -
        (baseline.accepted + baseline.unresolved) * treatment.intended;
      const highSign =
        (treatment.accepted + treatment.unresolved) * baseline.intended -
        baseline.accepted * treatment.intended;
      return {
        block,
        baseline,
        treatment,
        lower:
          treatment.accepted / treatment.intended -
          (baseline.accepted + baseline.unresolved) / baseline.intended,
        upper:
          (treatment.accepted + treatment.unresolved) / treatment.intended -
          baseline.accepted / baseline.intended,
        observed:
          treatment.unresolved || baseline.unresolved
            ? null
            : treatment.accepted / treatment.intended - baseline.accepted / baseline.intended,
        direction:
          lowSign > 0
            ? ("treatment" as const)
            : highSign < 0
              ? ("baseline" as const)
              : lowSign === 0 && highSign === 0
                ? ("tie" as const)
                : ("unresolved" as const),
      };
    });
  const count = (direction: (typeof blocks)[number]["direction"]) =>
    blocks.filter((block) => block.direction === direction).length;
  const treatmentBetter = count("treatment"),
    baselineBetter = count("baseline"),
    ties = count("tie"),
    unresolved = count("unresolved");
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    method: "blocked_sign_test" as const,
    blocks,
    meanDifference: {
      lower: mean(blocks.map((block) => block.lower)),
      upper: mean(blocks.map((block) => block.upper)),
      observed: blocks.every((block) => block.observed !== null)
        ? mean(blocks.map((block) => block.observed!))
        : null,
    },
    signTest: {
      treatmentBetter,
      baselineBetter,
      ties,
      unresolved,
      treatmentBetterP: exactSignTest(treatmentBetter, baselineBetter + unresolved).greaterP,
      baselineBetterP: exactSignTest(baselineBetter, treatmentBetter + unresolved).greaterP,
    },
  };
}
