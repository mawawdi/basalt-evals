import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import type {
  BenchmarkMark,
  BenchmarkReport,
  BenchmarkTreatmentReport,
} from "../../contracts/src/benchmarks.js";
import { OUTCOME_CAUSE_ORDER } from "../../contracts/src/failure.js";
import {
  BUILD_STOPS,
  EVIDENCE_GROUPS,
  MODEL_SIDE_STOPS,
  PATTERN_FAMILIES,
  compareFamilyKeys,
  familyScope,
  familyShares,
  type BuildFacts,
  type BuildStop,
  type ClassComparison,
  type CriterionComparison,
  type CriterionOutcome,
  type CriterionOutcomeCounts,
  type EvidenceGroup,
  type FailurePatterns,
  type ModelReport,
  type ModelReportCriterion,
  type ModelReportModel,
  type ModelVerdict,
  type PairComparison,
  type PatternComparison,
  type PatternShare,
  type PatternVerdict,
} from "../../contracts/src/model-report.js";
import {
  clopperPearsonInterval,
  clusterBootstrap,
  fisherExact,
  fisherMinimumP,
  holmAdjust,
  permutationSize,
  stratifiedPermutationTest,
} from "./statistics.js";

/**
 * The single rule that gives one build one outcome for one criterion. A model-side stop is a
 * failure of the model, so it is not met. A stop outside the model, and an answer that is
 * neither met nor not met, leave the outcome unresolved. The console shows this text, so it
 * uses the console words, for example "local checks" for the local gate.
 */
export const CRITERION_OUTCOME_RULE = {
  met: "The build passed the local checks and finished, and every observation of the build met the criterion.",
  notMet:
    "An observation of the build did not meet the criterion. Or the model stopped the build: the build did not pass the local checks, Basalt refused the tool calls of the model, the model refused the task, or the model used all of its turns, context or output.",
  unresolved:
    "Any other build. An answer is not enough evidence, split, a score without a passing threshold or unavailable. Or the build stopped for a cause outside the model: a provider error, the spending limit, a stop, local checks that could not run, unfinished work or a stage that the run did not reach.",
} as const;
export const CRITERION_OUTCOME_RULE_HASH = hashJson(CRITERION_OUTCOME_RULE);

/** The family-wise error rate of each family of tests. */
const ALPHA = 0.05;
/** The random relabellings of a pooled test with more than 100,000 relabellings. */
const PERMUTATION_DRAWS = 20_000;
/** A bootstrap interval needs more than this count of builds for each model. */
const BOOTSTRAP_MINIMUM_BUILDS = 40;
const BOOTSTRAP_RESAMPLES = 2_000;
const CONFIDENCE = 0.95;

/** The outcome of one build for one criterion, from `CRITERION_OUTCOME_RULE`. */
export function criterionOutcome(stop: BuildStop, marks: BenchmarkMark[]): CriterionOutcome {
  if (stop !== "delivered") return MODEL_SIDE_STOPS.includes(stop) ? "not_met" : "unresolved";
  if (marks.some((mark) => mark.outcome === "rejected")) return "not_met";
  return marks.length && marks.every((mark) => mark.outcome === "met") ? "met" : "unresolved";
}

const verdictOf = (direction: "more" | "less" | null, adjustedP: number): ModelVerdict =>
  direction && adjustedP <= ALPHA
    ? direction === "more"
      ? "meets_more_often"
      : "meets_less_often"
    : "not_enough_builds";
const patternVerdictOf = (direction: "more" | "less" | null, adjustedP: number): PatternVerdict =>
  direction && adjustedP <= ALPHA
    ? direction === "more"
      ? "happens_more_often"
      : "happens_less_often"
    : "not_enough_builds";

const countOf = (outcomes: CriterionOutcome[]): CriterionOutcomeCounts => ({
  met: outcomes.filter((outcome) => outcome === "met").length,
  notMet: outcomes.filter((outcome) => outcome === "not_met").length,
  unresolved: outcomes.filter((outcome) => outcome === "unresolved").length,
});
const sizeOf = (counts: CriterionOutcomeCounts) => counts.met + counts.notMet + counts.unresolved;

/**
 * The direction that every completion of the unresolved builds shows, and the two-sided Fisher p
 * under the completion that is least favourable to it. For "more", every unresolved build of the
 * model is not met and every unresolved build of the other model is met.
 */
export function conservativeFisher(model: CriterionOutcomeCounts, other: CriterionOutcomeCounts) {
  const first = sizeOf(model),
    second = sizeOf(other);
  // Integer cross products compare the shares of the two extreme completions exactly.
  const more = model.met * second > (other.met + other.unresolved) * first,
    less = (model.met + model.unresolved) * second < other.met * first;
  if (!first || !second || (!more && !less)) return { direction: null, p: 1 };
  const a = more ? model.met : model.met + model.unresolved,
    c = more ? other.met + other.unresolved : other.met;
  return {
    direction: more ? ("more" as const) : ("less" as const),
    p: fisherExact(a, first - a, c, second - c).twoSidedP,
  };
}

function shareOf(key: string, builds: number, of: number, events: number | null): PatternShare {
  const interval = clopperPearsonInterval(builds, of, CONFIDENCE);
  return {
    key,
    builds,
    of,
    events,
    interval: { lower: interval.lower, upper: interval.upper, confidence: CONFIDENCE },
  };
}

/**
 * The two-sided Fisher exact test of each failure pattern of two rows: the builds with the
 * pattern against the builds without it. A build that the family cannot measure is in
 * `excluded`, not in `of`. A pattern that no build of either row shows has no test, and a family
 * without a measured build in a row has no test. Holm covers all patterns of the pair.
 */
export function patternComparisons(
  model: FailurePatterns,
  other: FailurePatterns,
): PatternComparison[] {
  const tests = PATTERN_FAMILIES.flatMap((family) => {
    const left = familyScope(model, family),
      right = familyScope(other, family);
    if (!left.of || !right.of) return [];
    const count = (patterns: FailurePatterns) =>
      new Map(familyShares(patterns, family).map((share) => [share.key, share.builds]));
    const own = count(model),
      theirs = count(other);
    return [...new Set([...own.keys(), ...theirs.keys()])]
      .sort(compareFamilyKeys(family))
      .map((key) => {
        const a = own.get(key) ?? 0,
          c = theirs.get(key) ?? 0;
        // Integer cross products compare the two shares exactly.
        const more = a * right.of > c * left.of,
          less = a * right.of < c * left.of;
        return {
          family,
          key,
          model: { builds: a, ...left },
          other: { builds: c, ...right },
          direction: more ? ("more" as const) : less ? ("less" as const) : null,
          p: more || less ? fisherExact(a, left.of - a, c, right.of - c).twoSidedP : 1,
          minimumAchievableP: fisherMinimumP(left.of, right.of),
        };
      });
  });
  const adjusted = holmAdjust(tests.map((item) => item.p));
  return tests.map((item, index) => ({
    ...item,
    adjustedP: adjusted[index]!,
    verdict: patternVerdictOf(item.direction, adjusted[index]!),
  }));
}

/** The keys of a list of builds, each counted one time for each build, in code unit order. */
function keyShares(lists: string[][], of: number): PatternShare[] {
  const builds = new Map<string, number>();
  for (const keys of lists)
    for (const key of new Set(keys)) builds.set(key, (builds.get(key) ?? 0) + 1);
  return [...builds.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, count]) => shareOf(key, count, of, null));
}

function failurePatterns(row: BenchmarkTreatmentReport, facts: BuildFacts[]): FailurePatterns {
  const recorded = facts.flatMap((fact) => (fact.run ? [fact.run] : []));
  const tools = new Map<string, { builds: number; calls: number }>();
  for (const run of recorded)
    for (const { tool, calls } of run.failedToolCalls) {
      const entry = tools.get(tool) ?? { builds: 0, calls: 0 };
      entry.builds += calls > 0 ? 1 : 0;
      entry.calls += calls;
      tools.set(tool, entry);
    }
  // A build without a complete analysis is not a build without findings, so it stays out.
  const analyzed = facts.flatMap((fact) => (fact.lint ? [fact.lint] : []));
  const findings = new Map<string, { builds: number; events: number }>();
  for (const lint of analyzed)
    for (const [code, count] of Object.entries(lint))
      if (count) {
        const entry = findings.get(code) ?? { builds: 0, events: 0 };
        entry.builds += 1;
        entry.events += count;
        findings.set(code, entry);
      }
  const measured = facts.flatMap((fact) => (fact.scriptErrors ? [fact.scriptErrors] : []));
  const withErrors = (origin: "build" | "unknown") =>
    shareOf(origin, measured.filter((counts) => counts[origin] > 0).length, measured.length, null);
  return {
    builds: facts.length,
    recordedBuilds: recorded.length,
    stops: BUILD_STOPS.flatMap((stop) => {
      const count = facts.filter((fact) => fact.stop === stop).length;
      return count ? [shareOf(stop, count, facts.length, null)] : [];
    }),
    gateFailures: keyShares(
      recorded.map((run) => run.gateFailures),
      recorded.length,
    ),
    failedToolCalls: [...tools.entries()]
      .filter(([, entry]) => entry.builds > 0)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([tool, entry]) => shareOf(tool, entry.builds, recorded.length, entry.calls)),
    refusedBatches: shareOf(
      "refused_batches",
      recorded.filter((run) => run.refusedBatches > 0).length,
      recorded.length,
      recorded.reduce((sum, run) => sum + run.refusedBatches, 0),
    ),
    causes: OUTCOME_CAUSE_ORDER.flatMap((cause) => {
      const units = row.causes.find((item) => item.cause === cause)?.units ?? [];
      const builds = new Set(units.flatMap((unit) => (unit.subjectId ? [unit.subjectId] : [])));
      return builds.size ? [shareOf(cause, builds.size, facts.length, null)] : [];
    }),
    lint: {
      codes: [...findings.entries()]
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([code, entry]) => shareOf(code, entry.builds, analyzed.length, entry.events)),
      analyzed: analyzed.length,
      unanalyzed: facts.length - analyzed.length,
    },
    scriptErrors: {
      build: withErrors("build"),
      unknown: withErrors("unknown"),
      measured: measured.length,
      unmeasured: facts.length - measured.length,
    },
  };
}

/** The outcomes of each build of a row for each criterion, by evaluation and criterion. */
type OutcomeTable = Map<
  string,
  Map<string, Array<{ subjectId: string; outcome: CriterionOutcome }>>
>;

function seedOf(value: unknown) {
  return Number.parseInt(hashJson(value).slice(0, 8), 16);
}

/** Swap the two sides of a comparison, so that it reads from the other row. */
function mirrored(pair: PairComparison): PairComparison {
  const verdict = (value: ModelVerdict): ModelVerdict =>
    value === "meets_more_often"
      ? "meets_less_often"
      : value === "meets_less_often"
        ? "meets_more_often"
        : value;
  const patternVerdict = (value: PatternVerdict): PatternVerdict =>
    value === "happens_more_often"
      ? "happens_less_often"
      : value === "happens_less_often"
        ? "happens_more_often"
        : value;
  const direction = (value: "more" | "less" | null) =>
    value === "more" ? "less" : value === "less" ? "more" : null;
  return {
    rowId: pair.otherRowId,
    otherRowId: pair.rowId,
    criteria: pair.criteria.map((item) => ({
      ...item,
      model: item.other,
      other: item.model,
      direction: direction(item.direction),
      verdict: verdict(item.verdict),
    })),
    classes: pair.classes.map((item) => ({
      ...item,
      model: item.other,
      other: item.model,
      difference: { lower: -item.difference.upper, upper: -item.difference.lower },
      direction: direction(item.direction),
      verdict: verdict(item.verdict),
      interval: item.interval && {
        ...item.interval,
        lower: -item.interval.upper,
        upper: -item.interval.lower,
      },
    })),
    patterns: pair.patterns.map((item) => ({
      ...item,
      model: item.other,
      other: item.model,
      direction: direction(item.direction),
      verdict: patternVerdict(item.verdict),
    })),
    decisionPossible: pair.decisionPossible,
  };
}

/**
 * The model report of one run. A model pair has two models of one tool set, and a tool-set pair
 * has two tool sets of one model. For each criterion of a pair, an exact test asks if one row
 * meets the criterion more often. Unresolved builds count against the direction under test.
 * For each failure pattern of a pair, an exact test asks if one row shows it more often. Holm
 * corrects the criteria, the groups and the patterns of each pair as separate families. The
 * report has no score, no rank and no winner.
 */
export function modelReport(input: {
  report: BenchmarkReport;
  builds: BuildFacts[];
  /** The judge models of the run. A builder of the same family gets a mark. */
  judgeModelIds: string[];
}): ModelReport {
  const { report } = input;
  const facts = new Map(input.builds.map((fact) => [fact.subjectId, fact]));
  const issues: string[] = [];
  // A criterion with no planned check in any build of the run has no measurement here.
  const measured = new Map<string, Map<string, EvidenceGroup>>();
  for (const row of report.rows)
    for (const item of row.cases)
      for (const build of item.builds)
        for (const mark of build.marks) {
          const groups = measured.get(item.evaluationId) ?? new Map<string, EvidenceGroup>();
          if (!groups.has(mark.criterionId)) {
            const definition = report.criteria.find(
              (criterion) =>
                criterion.evaluationId === item.evaluationId &&
                criterion.criterionId === mark.criterionId,
            );
            groups.set(
              mark.criterionId,
              mark.method === "deterministic"
                ? "code"
                : (definition?.evidenceClass ?? "unclassified"),
            );
          }
          measured.set(item.evaluationId, groups);
        }
  const evaluations: ModelReport["evaluations"] = report.evaluations.map((evaluation) => {
    const definitions = report.criteria.filter(
      (criterion) => criterion.evaluationId === evaluation.evaluationId,
    );
    const groups = measured.get(evaluation.evaluationId);
    return {
      evaluationId: evaluation.evaluationId,
      title: evaluation.title,
      stage: { index: evaluation.stage.index, count: evaluation.stage.count },
      criteria: definitions.flatMap((definition, index): ModelReportCriterion[] => {
        const group = groups?.get(definition.criterionId);
        return group
          ? [
              {
                criterionId: definition.criterionId,
                number: index + 1,
                statement: definition.statement,
                required: definition.required,
                group,
              },
            ]
          : [];
      }),
    };
  });
  const stopOf = (subjectId: string, notReached: boolean): BuildStop => {
    if (notReached) return "not_reached";
    const fact = facts.get(subjectId);
    if (!fact) issues.push(`Basalt has no saved facts of build ${subjectId}.`);
    return fact?.stop ?? "unrecorded";
  };
  const tables = new Map<string, OutcomeTable>();
  for (const row of report.rows) {
    const table: OutcomeTable = new Map();
    for (const evaluation of evaluations) {
      const builds = row.cases.find(
        (item) => item.evaluationId === evaluation.evaluationId,
      )?.builds;
      const byCriterion = new Map<
        string,
        Array<{ subjectId: string; outcome: CriterionOutcome }>
      >();
      for (const criterion of evaluation.criteria)
        byCriterion.set(
          criterion.criterionId,
          (builds ?? []).map((build) => ({
            subjectId: build.subjectId,
            outcome: criterionOutcome(
              stopOf(build.subjectId, build.notReached),
              build.marks.filter((mark) => mark.criterionId === criterion.criterionId),
            ),
          })),
        );
      table.set(evaluation.evaluationId, byCriterion);
    }
    tables.set(row.id, table);
  }
  const family = (modelId: string) => modelId.split("/")[0] ?? modelId;
  const judgeFamilies = new Set(input.judgeModelIds.map(family));
  const models: ModelReportModel[] = report.rows.map((row) => {
    const table = tables.get(row.id)!;
    const subjects = row.cases.flatMap((item) => item.builds);
    return {
      rowId: row.id,
      modelId: row.modelId,
      modelName: row.modelName,
      harnessId: row.harnessId,
      harnessTitle: row.harnessTitle,
      builds: subjects.length,
      judgeFamily: judgeFamilies.has(family(row.modelId)),
      outcomes: evaluations.flatMap((evaluation) =>
        evaluation.criteria.map((criterion) => ({
          evaluationId: evaluation.evaluationId,
          criterionId: criterion.criterionId,
          ...countOf(
            table
              .get(evaluation.evaluationId)!
              .get(criterion.criterionId)!
              .map((item) => item.outcome),
          ),
        })),
      ),
      patterns: failurePatterns(
        row,
        subjects.map(
          (build): BuildFacts =>
            facts.get(build.subjectId) ?? {
              subjectId: build.subjectId,
              stop: stopOf(build.subjectId, build.notReached),
              run: null,
              lint: null,
              scriptErrors: null,
            },
        ),
      ),
    };
  });
  const patternsOf = new Map(models.map((model) => [model.rowId, model.patterns]));
  const compare = (
    first: BenchmarkTreatmentReport,
    second: BenchmarkTreatmentReport,
  ): PairComparison => {
    const left = tables.get(first.id)!,
      right = tables.get(second.id)!;
    const criteria = evaluations.flatMap((evaluation) =>
      evaluation.criteria.flatMap((criterion) => {
        const model = countOf(
            left
              .get(evaluation.evaluationId)!
              .get(criterion.criterionId)!
              .map((item) => item.outcome),
          ),
          other = countOf(
            right
              .get(evaluation.evaluationId)!
              .get(criterion.criterionId)!
              .map((item) => item.outcome),
          );
        if (!sizeOf(model) || !sizeOf(other)) return [];
        return [
          {
            evaluationId: evaluation.evaluationId,
            criterionId: criterion.criterionId,
            model,
            other,
            ...conservativeFisher(model, other),
            minimumAchievableP: fisherMinimumP(sizeOf(model), sizeOf(other)),
          },
        ];
      }),
    );
    const adjusted = holmAdjust(criteria.map((item) => item.p));
    const classes = EVIDENCE_GROUPS.flatMap((group) => {
      const comparison = classComparison(group, first, second, left, right, evaluations, {
        manifestHash: report.manifestHash,
      });
      return comparison ? [comparison] : [];
    });
    const classAdjusted = holmAdjust(classes.map((item) => item.p));
    // Every Holm adjustment is at least the count of tests times the smallest p.
    const smallest = Math.min(1, ...criteria.map((item) => item.minimumAchievableP));
    return {
      rowId: first.id,
      otherRowId: second.id,
      criteria: criteria.map((item, index): CriterionComparison => ({
        ...item,
        adjustedP: adjusted[index]!,
        verdict: verdictOf(item.direction, adjusted[index]!),
      })),
      classes: classes.map((item, index) => ({
        ...item,
        adjustedP: classAdjusted[index]!,
        verdict: verdictOf(item.direction, classAdjusted[index]!),
      })),
      patterns: patternComparisons(patternsOf.get(first.id)!, patternsOf.get(second.id)!),
      decisionPossible: criteria.length > 0 && criteria.length * smallest <= ALPHA,
    };
  };
  type Row = BenchmarkTreatmentReport;
  // Each pair is tested one time, and its mirror reads it from the other row.
  const pairs = (related: (first: Row, second: Row) => boolean) => {
    const tested = new Map<string, PairComparison>();
    report.rows.forEach((first, index) => {
      for (const second of report.rows.slice(index + 1))
        if (related(first, second)) {
          const pair = compare(first, second);
          tested.set(`${first.id}:${second.id}`, pair);
          tested.set(`${second.id}:${first.id}`, mirrored(pair));
        }
    });
    return report.rows.flatMap((row) =>
      report.rows.flatMap((other) => {
        const pair = tested.get(`${row.id}:${other.id}`);
        return pair ? [pair] : [];
      }),
    );
  };
  return {
    operationId: report.operationId,
    manifestHash: report.manifestHash,
    title: report.title,
    finished: report.finished || report.stopped,
    outcomeRule: { text: { ...CRITERION_OUTCOME_RULE }, hash: CRITERION_OUTCOME_RULE_HASH },
    alpha: ALPHA,
    evaluations,
    models,
    modelPairs: pairs((first, second) => first.harnessId === second.harnessId),
    // A row is one model with one tool set, so these rows differ only in the tool set.
    toolSetPairs: pairs(
      (first, second) => first.modelId === second.modelId && first.harnessId !== second.harnessId,
    ),
    issues: [...new Set(issues)],
  };
}

/**
 * The pooled test of one evidence group. Each build gets the share of the criteria of the group
 * that it meets. A permutation test compares the shares of the two models inside each
 * evaluation, under the completion of the unresolved answers that is least favourable to the
 * direction. Null when no evaluation has criteria of the group and builds of both models.
 */
function classComparison(
  group: EvidenceGroup,
  first: BenchmarkTreatmentReport,
  second: BenchmarkTreatmentReport,
  left: OutcomeTable,
  right: OutcomeTable,
  evaluations: ModelReport["evaluations"],
  seedInput: { manifestHash: string },
): Omit<ClassComparison, "adjustedP" | "verdict"> | null {
  type BuildShare = { subjectId: string; met: number; unresolved: number; criteria: number };
  const sharesOf = (table: OutcomeTable, evaluationId: string, criterionIds: string[]) => {
    const builds = new Map<string, BuildShare>();
    for (const criterionId of criterionIds)
      for (const { subjectId, outcome } of table.get(evaluationId)!.get(criterionId)!) {
        const share = builds.get(subjectId) ?? { subjectId, met: 0, unresolved: 0, criteria: 0 };
        share.criteria++;
        if (outcome === "met") share.met++;
        if (outcome === "unresolved") share.unresolved++;
        builds.set(subjectId, share);
      }
    return [...builds.values()];
  };
  const strata = evaluations.flatMap((evaluation) => {
    const criterionIds = evaluation.criteria
      .filter((criterion) => criterion.group === group)
      .map((criterion) => criterion.criterionId);
    if (!criterionIds.length) return [];
    const model = sharesOf(left, evaluation.evaluationId, criterionIds),
      other = sharesOf(right, evaluation.evaluationId, criterionIds);
    return model.length && other.length
      ? [{ evaluationId: evaluation.evaluationId, model, other }]
      : [];
  });
  if (!strata.length) return null;
  const low = (share: BuildShare) => share.met / share.criteria,
    high = (share: BuildShare) => (share.met + share.unresolved) / share.criteria;
  // The completion least favourable to "more" is low for the model and high for the other.
  const completion = (model: (share: BuildShare) => number, other: typeof model) =>
    strata.map((stratum) => ({
      first: stratum.model.map(model),
      second: stratum.other.map(other),
    }));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const difference = (values: Array<{ first: number[]; second: number[] }>) =>
    mean(values.map((stratum) => mean(stratum.first) - mean(stratum.second)));
  const against = completion(low, high),
    toward = completion(high, low);
  const lower = difference(against),
    upper = difference(toward);
  const direction = lower > 0 ? ("more" as const) : upper < 0 ? ("less" as const) : null;
  const seed = seedOf({ ...seedInput, rows: [first.id, second.id], group });
  // Without a direction, p is 1, so only the size of the test is needed.
  const test = direction
    ? stratifiedPermutationTest(direction === "less" ? toward : against, {
        seed,
        draws: PERMUTATION_DRAWS,
      })
    : {
        ...permutationSize(
          against.map((stratum) => ({
            first: stratum.first.length,
            second: stratum.second.length,
          })),
          PERMUTATION_DRAWS,
        ),
        twoSidedP: 1,
      };
  const totals = (side: "model" | "other") => {
    const shares = strata.flatMap((stratum) => stratum[side]);
    const met = shares.reduce((sum, share) => sum + share.met, 0),
      unresolved = shares.reduce((sum, share) => sum + share.unresolved, 0),
      all = shares.reduce((sum, share) => sum + share.criteria, 0);
    return { builds: shares.length, met, notMet: all - met - unresolved, unresolved };
  };
  const model = totals("model"),
    other = totals("other");
  // An exact test is better at 40 builds or fewer, so only larger samples get an interval.
  const bootstrap = (values: Array<{ first: number[]; second: number[] }>) => {
    const items = values.flatMap((stratum, index) => [
      ...stratum.first.map((value, build) => ({ index, side: 0, build, value })),
      ...stratum.second.map((value, build) => ({ index, side: 1, build, value })),
    ]);
    return clusterBootstrap(
      items,
      (item) => `${item.index}:${item.side}:${item.build}`,
      (sample) => {
        // Each stratum keeps its size, so each side of each evaluation has builds.
        const sums = values.map(() => ({ sum: [0, 0], count: [0, 0] }));
        for (const item of sample) {
          sums[item.index]!.sum[item.side]! += item.value;
          sums[item.index]!.count[item.side]! += 1;
        }
        return [mean(sums.map(({ sum, count }) => sum[0]! / count[0]! - sum[1]! / count[1]!))];
      },
      {
        seed,
        resamples: BOOTSTRAP_RESAMPLES,
        confidence: CONFIDENCE,
        stratum: (item) => `${item.index}:${item.side}`,
      },
    ).intervals[0]!;
  };
  const interval =
    model.builds > BOOTSTRAP_MINIMUM_BUILDS && other.builds > BOOTSTRAP_MINIMUM_BUILDS
      ? (() => {
          const pessimistic = bootstrap(against),
            optimistic = bootstrap(toward);
          return pessimistic && optimistic
            ? {
                lower: pessimistic.lower,
                upper: optimistic.upper,
                confidence: CONFIDENCE,
                resamples: BOOTSTRAP_RESAMPLES,
              }
            : null;
        })()
      : null;
  return {
    group,
    evaluations: strata.length,
    model,
    other,
    difference: { lower, upper },
    direction,
    p: test.twoSidedP,
    minimumAchievableP: test.minimumP,
    test: {
      method: test.method,
      relabellings: test.relabellings,
      draws: test.draws,
      seed,
    },
    interval,
  };
}
