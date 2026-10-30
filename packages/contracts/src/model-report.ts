// The console runs these functions in the browser, so this module has no runtime import of
// `index.js`, which needs Node.
import { EVIDENCE_CLASSES, type EvidenceClass } from "./evidence-class.js";
import { OUTCOME_CAUSE_ORDER } from "./failure.js";
import type { ScriptErrorCounts, SourceLintCounts } from "./source-analysis.js";

/*
 * The model report of one run. It has two families of comparisons. A model pair compares two
 * models of the same tool set. A tool-set pair compares two tool sets of the same model. A
 * comparison inside one run is controlled: the rows build the same evaluations under the same
 * plan, judge and limits. The report gives no score, no rank and no winner.
 */

/**
 * How the build stage of one build ended. `delivered` is a build that passed the local gate and
 * finished. The stops in `MODEL_SIDE_STOPS` come from the model. The other stops come from
 * outside the model.
 */
export const BUILD_STOPS = [
  "delivered",
  "local_gate_rejected",
  "invalid_tool_call",
  "refusal",
  "turn_limit",
  "context_limit",
  "output_limit",
  "provider_error",
  "spending_limit",
  "cancelled",
  "environment",
  "unrecorded",
  "not_reached",
  "not_finished",
] as const;
export type BuildStop = (typeof BUILD_STOPS)[number];

/** The stops that the model causes. A build with one of these stops meets no criterion. */
export const MODEL_SIDE_STOPS: readonly BuildStop[] = [
  "local_gate_rejected",
  "invalid_tool_call",
  "refusal",
  "turn_limit",
  "context_limit",
  "output_limit",
];

/**
 * The groups of the pooled comparison: each evidence class of the judge criteria, the judge
 * criteria without a class, and the code checks. A criterion is in exactly one group.
 */
export const EVIDENCE_GROUPS = [...EVIDENCE_CLASSES, "unclassified", "code"] as const;
export type EvidenceGroup = EvidenceClass | "unclassified" | "code";

/** The saved facts of one build that the model report reads. The operator collects them. */
export interface BuildFacts {
  subjectId: string;
  stop: BuildStop;
  /** The facts of the saved run of the build. Null when no saved run binds the build event. */
  run: {
    /** The names of the local checks that did not pass, for example "luau_parse". */
    gateFailures: string[];
    /** The tool calls whose result was not ok, for each tool, in tool name order. */
    failedToolCalls: Array<{ tool: string; calls: number }>;
    /** The batches of tool calls that Basalt refused. */
    refusedBatches: number;
  } | null;
  /**
   * The findings of each lint code in the complete source analysis of the sealed build. A code
   * without a finding has no key. Null when the build has no stored analysis or an unavailable
   * one.
   */
  lint: SourceLintCounts | null;
  /**
   * The script errors of the signed observations of the build, by origin. Null when the build
   * has no complete source analysis or no observation with a diagnostics fact.
   */
  scriptErrors: ScriptErrorCounts | null;
}

/** The outcome of one build for one criterion, from `CRITERION_OUTCOME_RULE`. */
export type CriterionOutcome = "met" | "not_met" | "unresolved";

export interface CriterionOutcomeCounts {
  met: number;
  notMet: number;
  unresolved: number;
}

/**
 * The answer of one criterion comparison. `not_enough_builds` means that the builds do not show
 * a difference after the correction for many tests. It never means that the rows are equal.
 */
export type ModelVerdict = "meets_more_often" | "meets_less_often" | "not_enough_builds";

/**
 * The answer of one failure pattern comparison. `not_enough_builds` means that the builds do not
 * show a difference after the correction for many tests. It never means that the shares are equal.
 */
export type PatternVerdict = "happens_more_often" | "happens_less_often" | "not_enough_builds";

/** One failure pattern of a model: the builds that show it, of the builds that can show it. */
export interface PatternShare {
  key: string;
  builds: number;
  of: number;
  /** The count of events in those builds, for example failed tool calls. Null for builds only. */
  events: number | null;
  /** The two-sided exact (Clopper–Pearson) interval of builds / of. */
  interval: { lower: number; upper: number; confidence: number };
}

export interface FailurePatterns {
  builds: number;
  /** The builds with a saved run. The patterns of the saved run use this denominator. */
  recordedBuilds: number;
  /** How each build stage ended, in the order of `BUILD_STOPS`. */
  stops: PatternShare[];
  /** The local checks that did not pass. */
  gateFailures: PatternShare[];
  /** The failed tool calls of each tool. `events` counts the calls. */
  failedToolCalls: PatternShare[];
  /** The builds with a refused batch of tool calls. `events` counts the batches. */
  refusedBatches: PatternShare;
  /** Why work did not finish, by recorded cause, in the fixed order of the causes. */
  causes: PatternShare[];
  /**
   * The lint codes of the builds with a complete source analysis. `of` counts these builds, and
   * `events` counts the findings. A build without a complete analysis is in `unanalyzed`. It
   * never counts as a build without findings.
   */
  lint: { codes: PatternShare[]; analyzed: number; unanalyzed: number };
  /**
   * The builds with a script error from a build script, and the builds with a script error of
   * unknown origin. `of` counts the builds with a complete source analysis and a diagnostics
   * fact. The other builds are in `unmeasured`. The pattern counts builds only, so `events` is
   * null.
   */
  scriptErrors: {
    build: PatternShare;
    unknown: PatternShare;
    measured: number;
    unmeasured: number;
  };
}

export interface ModelReportModel {
  /** The report row of the model and its tool set. */
  rowId: string;
  modelId: string;
  modelName: string;
  harnessId: string;
  harnessTitle: string;
  builds: number;
  /** True when the builder and a judge of the run come from one model family. */
  judgeFamily: boolean;
  /** The outcome counts of each criterion, in the order of `ModelReport.evaluations`. */
  outcomes: Array<{ evaluationId: string; criterionId: string } & CriterionOutcomeCounts>;
  patterns: FailurePatterns;
}

export interface ModelReportCriterion {
  criterionId: string;
  /** The authored number of the criterion in its evaluation, from 1. */
  number: number;
  statement: string;
  required: boolean;
  group: EvidenceGroup;
}

/** The test of one criterion for one ordered pair of rows. `model` is the first row. */
export interface CriterionComparison {
  evaluationId: string;
  criterionId: string;
  model: CriterionOutcomeCounts;
  other: CriterionOutcomeCounts;
  /** The direction that every completion of the unresolved builds shows, or null. */
  direction: "more" | "less" | null;
  /** The two-sided Fisher exact p under the least favourable completion. 1 without a direction. */
  p: number;
  /** The Holm adjustment over all criteria of the pair. */
  adjustedP: number;
  /** The smallest p that any answers of these builds can give. */
  minimumAchievableP: number;
  verdict: ModelVerdict;
}

/** The pooled test of one evidence group for one ordered pair of rows. */
export interface ClassComparison {
  group: EvidenceGroup;
  /** The evaluations with criteria of the group and builds of both models. */
  evaluations: number;
  model: CriterionOutcomeCounts & { builds: number };
  other: CriterionOutcomeCounts & { builds: number };
  /**
   * The mean over evaluations of the difference of the mean met shares of the builds. The
   * bounds take the completions of the unresolved answers that give the extremes.
   */
  difference: { lower: number; upper: number };
  direction: "more" | "less" | null;
  /** The two-sided stratified permutation p under the least favourable completion. */
  p: number;
  /** The Holm adjustment over all groups of the pair. */
  adjustedP: number;
  minimumAchievableP: number;
  verdict: ModelVerdict;
  test: {
    method: "exact" | "monte_carlo";
    /** All relabellings inside the evaluations of an exact test. Null for a Monte Carlo test. */
    relabellings: number | null;
    /** The random relabellings of a Monte Carlo test, or null for an exact test. */
    draws: number | null;
    seed: number;
  };
  /**
   * A stratified bootstrap interval of the difference. Null when a model has 40 builds or fewer,
   * because an exact test is better at that size.
   */
  interval: { lower: number; upper: number; confidence: number; resamples: number } | null;
}

/** The families of failure patterns, in the order of `FailurePatterns`. */
export const PATTERN_FAMILIES = [
  "stops",
  "gateFailures",
  "failedToolCalls",
  "refusedBatches",
  "causes",
  "lint",
  "scriptErrors",
] as const;
export type PatternFamily = (typeof PATTERN_FAMILIES)[number];

/** The builds of one row for one failure pattern test. */
export interface PatternCounts {
  /** The builds that show the pattern. */
  builds: number;
  /** The builds that can show the pattern. */
  of: number;
  /**
   * The builds that the family cannot measure, for example a build without a complete code
   * analysis. They are not in `of`.
   */
  excluded: number;
}

/** The test of one failure pattern for one ordered pair of rows. `model` is the first row. */
export interface PatternComparison {
  family: PatternFamily;
  key: string;
  model: PatternCounts;
  other: PatternCounts;
  /** "more" when the share of the first row is larger. Null when the shares are equal. */
  direction: "more" | "less" | null;
  /**
   * The two-sided Fisher exact p of the builds with and without the pattern. 1 without a
   * direction.
   */
  p: number;
  /** The Holm adjustment over all patterns of the pair. */
  adjustedP: number;
  /** The smallest p that any builds of these counts can give. */
  minimumAchievableP: number;
  verdict: PatternVerdict;
}

/**
 * All tests of one ordered pair of rows. In a model pair, the rows have the same tool set. In a
 * tool-set pair, the rows have the same model. Each pair has its own Holm families.
 */
export interface PairComparison {
  /** The row that the pair reads from. */
  rowId: string;
  otherRowId: string;
  criteria: CriterionComparison[];
  classes: ClassComparison[];
  /** The failure patterns that a build of either row shows, when both rows can show them. */
  patterns: PatternComparison[];
  /** False when no criterion can reach a decision with these build counts. */
  decisionPossible: boolean;
}

export interface ModelReport {
  operationId: string;
  manifestHash: string;
  title: string;
  /** False while the run can add answers. Unfinished builds stay unresolved. */
  finished: boolean;
  /** The rule that gives each build one outcome for each criterion, with its hash. */
  outcomeRule: { text: Record<"met" | "notMet" | "unresolved", string>; hash: string };
  /** The family-wise error rate of each family of tests. */
  alpha: number;
  /** The evaluations in plan order, with the measured criteria in authored order. */
  evaluations: Array<{
    evaluationId: string;
    title: string | null;
    stage: { index: number; count: number };
    criteria: ModelReportCriterion[];
  }>;
  models: ModelReportModel[];
  /** For each row, its pairs with each other model of its tool set, in row order. */
  modelPairs: PairComparison[];
  /** For each row, its pairs with each other tool set of its model, in row order. */
  toolSetPairs: PairComparison[];
  issues: string[];
}

/** The two families of comparisons of the model report. */
export type PairFamily = "models" | "toolSets";

/** The pairs of one row in one family, in row order. */
export function rowPairs(report: ModelReport, rowId: string, family: PairFamily) {
  return (family === "models" ? report.modelPairs : report.toolSetPairs).filter(
    (pair) => pair.rowId === rowId,
  );
}

/** The shares of one pattern family. A family without a pattern of the row gives none. */
export function familyShares(patterns: FailurePatterns, family: PatternFamily): PatternShare[] {
  const shares =
    family === "refusedBatches"
      ? [patterns.refusedBatches]
      : family === "lint"
        ? patterns.lint.codes
        : family === "scriptErrors"
          ? [patterns.scriptErrors.build, patterns.scriptErrors.unknown]
          : patterns[family];
  return shares.filter((share) => share.builds > 0);
}

/** The builds of a row that can show a pattern of the family, and the builds that it leaves out. */
export function familyScope(patterns: FailurePatterns, family: PatternFamily) {
  if (family === "stops" || family === "causes") return { of: patterns.builds, excluded: 0 };
  if (family === "lint") return { of: patterns.lint.analyzed, excluded: patterns.lint.unanalyzed };
  if (family === "scriptErrors")
    return { of: patterns.scriptErrors.measured, excluded: patterns.scriptErrors.unmeasured };
  return { of: patterns.recordedBuilds, excluded: patterns.builds - patterns.recordedBuilds };
}

/**
 * The order of the keys of one pattern family: the fixed order of the stops, the causes and the
 * script error origins, and code unit order for the other families.
 */
export function compareFamilyKeys(family: PatternFamily) {
  const fixed: readonly string[] | null =
    family === "stops"
      ? BUILD_STOPS
      : family === "causes"
        ? OUTCOME_CAUSE_ORDER
        : family === "scriptErrors"
          ? ["build", "unknown"]
          : null;
  return (left: string, right: string) =>
    fixed ? fixed.indexOf(left) - fixed.indexOf(right) : left < right ? -1 : left > right ? 1 : 0;
}

/** One row of the failure pattern table of a row: its own share and the test of each pair. */
export interface PatternTableRow {
  family: PatternFamily;
  key: string;
  /** The share of the row. Null when no build of the row shows the pattern. */
  own: PatternShare | null;
  /** The builds of the row that can show the pattern. */
  of: number;
  /** The test of each pair, in the order of the pairs. Null when the pair has no test of it. */
  comparisons: Array<PatternComparison | null>;
}

/**
 * The failure pattern table of a row with its pairs of one family. A pattern that only the other
 * row of a pair shows also gets a table row, so a share of zero stays visible.
 */
export function patternTable(
  patterns: FailurePatterns,
  pairs: readonly PairComparison[],
): PatternTableRow[] {
  return PATTERN_FAMILIES.flatMap((family) => {
    const own = new Map(familyShares(patterns, family).map((share) => [share.key, share]));
    const keys = new Set([
      ...own.keys(),
      ...pairs.flatMap((pair) =>
        pair.patterns.filter((item) => item.family === family).map((item) => item.key),
      ),
    ]);
    return [...keys].sort(compareFamilyKeys(family)).map((key) => ({
      family,
      key,
      own: own.get(key) ?? null,
      of: familyScope(patterns, family).of,
      comparisons: pairs.map(
        (pair) => pair.patterns.find((item) => item.family === family && item.key === key) ?? null,
      ),
    }));
  });
}
