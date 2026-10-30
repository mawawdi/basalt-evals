import { compareCodeUnits } from "../../contracts/src/index.js";
import type { ExpertLabel, SelectiveOutcome } from "./acceptance.js";
import { PIXEL_MEASURES, type EffectRegion, type PixelMeasure } from "./pixel-metrics.js";
import {
  PRESENTATIONS,
  type BaselinePlan,
  type ExperimentPlan,
  type Partition,
  type PixelRule,
  type Presentation,
} from "./protocols.js";
import { clopperPearsonInterval, exactMcNemar, exactShare, holmAdjust } from "./statistics.js";

/*
 * The baseline ladder. A judge has value only where it is more often correct than a
 * trivial rule or a deterministic pixel rule on the same units. A pixel measure is a
 * number. It gives a verdict only through the threshold of a human-authored criterion.
 */

type BaselineDecision = "satisfied" | "violated" | null;

/** The pixel measures of one capture for one criterion, computed offline from recorded frames. */
export interface CaptureMeasurement {
  captureId: string;
  criterionId: string;
  scope: "authored_region" | "whole_frame";
  /** A defect of the recorded frames, for example no pre-action frame. It gives no decision. */
  issue: string | null;
  values: Record<PixelMeasure, number | null>;
}

/** The authored effect region of one criterion in one view. A criterion region comes first. */
export function authoredRegion(
  ladder: BaselinePlan,
  evalId: string,
  viewId: string,
  criterionId: string,
): EffectRegion | null {
  const region =
    ladder.measurement.regions.find(
      (item) =>
        item.evalId === evalId && item.viewId === viewId && item.criterionId === criterionId,
    ) ??
    ladder.measurement.regions.find(
      (item) => item.evalId === evalId && item.viewId === viewId && item.criterionId === null,
    );
  return region
    ? {
        rectangle: region.rectangle,
        surroundMargin: region.surroundMargin,
        authority: region.criterionId === null ? "view" : "criterion",
      }
    : null;
}

function thresholdDecision(
  direction: PixelRule["direction"],
  threshold: number,
  value: number | null,
): BaselineDecision {
  if (value === null) return null;
  return (direction === "at_least" ? value >= threshold : value <= threshold)
    ? "satisfied"
    : "violated";
}

/**
 * The only path from a pixel measure to a verdict. The threshold must come from the
 * human-authored criterion. A threshold from calibration data or a model never gates.
 */
export function authoredPixelDecision(rule: PixelRule, value: number | null): BaselineDecision {
  if (rule.authoredThreshold === null)
    throw new Error(
      "A pixel measure without an authored threshold is a number. It cannot give a verdict.",
    );
  return thresholdDecision(rule.direction, rule.authoredThreshold.value, value);
}

/** One violation rejects the build. Each capture must satisfy for an acceptance. */
function buildDecision(decisions: BaselineDecision[]): BaselineDecision {
  if (decisions.includes("violated")) return "violated";
  return decisions.length && decisions.every((decision) => decision === "satisfied")
    ? "satisfied"
    : null;
}

/**
 * Choose the threshold of a pixel rule on the calibration split only. The candidates are
 * the measured values. The threshold with the most correct build decisions wins. If two
 * thresholds tie, the stricter threshold wins, because a false acceptance costs more than
 * a false rejection. A build decision is unanimous over its captures; an unknown value
 * gives no decision, and no decision is not correct.
 */
function chooseThreshold(
  direction: PixelRule["direction"],
  builds: Array<{ values: Array<number | null>; expert: ExpertLabel }>,
) {
  const candidates = [
    ...new Set(builds.flatMap((build) => build.values.filter((value) => value !== null))),
  ].sort((a, b) => a - b);
  if (candidates.some((value) => !Number.isFinite(value)))
    throw new Error("A calibration value must be a finite number");
  const labelled = builds.filter((build) => build.expert !== null).length;
  let best: { threshold: number; correct: number } | null = null;
  if (labelled)
    for (const threshold of direction === "at_least" ? [...candidates].reverse() : candidates) {
      const correct = builds.filter(
        (build) =>
          build.expert !== null &&
          buildDecision(
            build.values.map((value) => thresholdDecision(direction, threshold, value)),
          ) === build.expert,
      ).length;
      if (!best || correct > best.correct) best = { threshold, correct };
    }
  return {
    threshold: best?.threshold ?? null,
    candidates: candidates.length,
    builds: builds.length,
    labelled,
    correct: best?.correct ?? 0,
  };
}

/** One paired unit: one build and one criterion. */
interface IncrementPair {
  member: string;
  build: string;
  /** The judge decision equals the expert label. Null when the label is unknown. */
  judge: boolean | null;
  /** The baseline decision equals the expert label. Null when either one is unknown. */
  baseline: boolean | null;
}

/**
 * The incremental information of the judge over one baseline. Each pair is one build and
 * one criterion, so captures and frames never count as extra pairs. For each member, an
 * exact McNemar test counts the discordant builds. The test completes each unknown cell
 * against the judge: an unknown judge cell is wrong and an unknown baseline cell is
 * correct. Holm adjusts the p values across the members.
 */
export function judgeIncrement(pairs: IncrementPair[], confidence: number) {
  if (new Set(pairs.map((pair) => JSON.stringify([pair.member, pair.build]))).size !== pairs.length)
    throw new Error("A comparison takes one pair for each build and criterion");
  const members = [...new Set(pairs.map((pair) => pair.member))].sort(compareCodeUnits);
  const rows = members.map((member) => {
    const items = pairs.filter((pair) => pair.member === member);
    const observed = { both: 0, judgeOnly: 0, baselineOnly: 0, neither: 0, unresolved: 0 };
    let judgeOnly = 0,
      baselineOnly = 0;
    for (const item of items) {
      if (item.judge === null || item.baseline === null) observed.unresolved++;
      else if (item.judge && item.baseline) observed.both++;
      else if (item.judge) observed.judgeOnly++;
      else if (item.baseline) observed.baselineOnly++;
      else observed.neither++;
      const judge = item.judge ?? false,
        baseline = item.baseline ?? true;
      if (judge && !baseline) judgeOnly++;
      if (!judge && baseline) baselineOnly++;
    }
    return {
      member,
      builds: items.length,
      observed,
      test: exactMcNemar(judgeOnly, baselineOnly),
      judgeShareOfDiscordant: {
        numerator: judgeOnly,
        denominator: judgeOnly + baselineOnly,
        interval: clopperPearsonInterval(judgeOnly, judgeOnly + baselineOnly, confidence),
      },
      judgeCorrect: exactShare(
        items.map((item) => ({ member: true, event: item.judge })),
        confidence,
      ),
      baselineCorrect: exactShare(
        items.map((item) => ({ member: true, event: item.baseline })),
        confidence,
      ),
    };
  });
  const adjusted = holmAdjust(rows.map((row) => row.test.exactP));
  return {
    test: "exact_mcnemar" as const,
    adjustment: "holm" as const,
    cluster: "build" as const,
    confidence,
    members: rows.map((row, index) => ({
      ...row,
      adjustedP: adjusted[index]!,
      judgeAddsInformation:
        row.test.firstOnly > row.test.secondOnly && adjusted[index]! <= 1 - confidence,
    })),
  };
}

/** The judge rows of a detector calibration, as the analysis reports them. */
interface JudgeRow {
  presentation: Presentation;
  partition: Partition;
  builds: Array<{
    sourceId: string;
    criteria: Array<{ criterionId: string; outcome: SelectiveOutcome; expert: ExpertLabel }>;
  }>;
}

/**
 * Report the baseline ladder of a judge calibration. Pixel thresholds come from the
 * development partition only. Each comparison uses the withheld partition and the same
 * build and criterion units as the judge.
 */
export function analyzeBaselines(
  plan: ExperimentPlan,
  required: (evalId: string) => string[],
  rows: JudgeRow[],
  measurements: CaptureMeasurement[],
) {
  const ladder = plan.baselines;
  if (!ladder) throw new Error("This plan has no baseline ladder");
  const confidence = plan.analysis.confidence;
  const evalIds = [...new Set(plan.sources.map((source) => source.evalId))].sort(compareCodeUnits);
  for (const rule of ladder.rules)
    if (!required(rule.evalId).includes(rule.criterionId))
      throw new Error("A pixel rule must name a required criterion of its task");
  const captureOf = new Map(plan.captures.map((capture) => [capture.id, capture]));
  const ruled = (evalId: string) =>
    new Set(ladder.rules.filter((rule) => rule.evalId === evalId).map((rule) => rule.criterionId));
  const regionFor = (evalId: string, viewId: string, criterionId: string) =>
    authoredRegion(ladder, evalId, viewId, criterionId);
  const measureNames = [...PIXEL_MEASURES].sort().join();
  const records = new Map<string, CaptureMeasurement>();
  for (const record of measurements) {
    const capture = captureOf.get(record.captureId);
    if (!capture || !ruled(capture.evalId).has(record.criterionId))
      throw new Error("A pixel measurement is not planned");
    const key = JSON.stringify([record.captureId, record.criterionId]);
    if (records.has(key)) throw new Error("A pixel measurement occurs more than once");
    if (
      (regionFor(capture.evalId, capture.viewId, record.criterionId)
        ? "authored_region"
        : "whole_frame") !== record.scope
    )
      throw new Error("A pixel measurement scope differs from its authored region");
    if (
      Object.keys(record.values).sort().join() !== measureNames ||
      Object.values(record.values).some((value) => value !== null && !Number.isFinite(value)) ||
      (record.issue !== null && (typeof record.issue !== "string" || !record.issue))
    )
      throw new Error("A pixel measurement needs one finite or empty value for each measure");
    records.set(key, record);
  }
  const value = (captureId: string, rule: PixelRule) => {
    const record = records.get(JSON.stringify([captureId, rule.criterionId]));
    return !record || record.issue !== null ? null : record.values[rule.measure];
  };
  const sources = (evalId: string) => plan.sources.filter((source) => source.evalId === evalId);
  const captures = (sourceId: string, partition: Partition) =>
    plan.captures.filter(
      (capture) => capture.subjectId === sourceId && capture.partition === partition,
    );
  const experts = new Map<string, ExpertLabel>();
  for (const row of rows)
    for (const build of row.builds)
      for (const criterion of build.criteria)
        experts.set(
          JSON.stringify([row.partition, build.sourceId, criterion.criterionId]),
          criterion.expert,
        );
  const expert = (partition: Partition, sourceId: string, criterionId: string) => {
    const label = experts.get(JSON.stringify([partition, sourceId, criterionId]));
    if (label === undefined) throw new Error("A baseline unit lacks its judge row");
    return label;
  };
  const calibration = ladder.rules.map((rule) => ({
    ruleId: rule.id,
    evalId: rule.evalId,
    criterionId: rule.criterionId,
    measure: rule.measure,
    direction: rule.direction,
    authority: "calibration_split" as const,
    ...chooseThreshold(
      rule.direction,
      sources(rule.evalId).map((source) => ({
        values: captures(source.id, "development").map((capture) => value(capture.id, rule)),
        expert: expert("development", source.id, rule.criterionId),
      })),
    ),
  }));
  const thresholds = new Map(calibration.map((item) => [item.ruleId, item.threshold]));
  const pixelDecision = (rule: PixelRule, sourceId: string, authored: boolean) => {
    const threshold = thresholds.get(rule.id)!;
    return buildDecision(
      captures(sourceId, "withheld").map((capture) =>
        authored
          ? authoredPixelDecision(rule, value(capture.id, rule))
          : threshold === null
            ? null
            : thresholdDecision(rule.direction, threshold, value(capture.id, rule)),
      ),
    );
  };
  const holdout = PRESENTATIONS.map((presentation) => {
    const row = rows.find(
      (item) => item.presentation === presentation && item.partition === "withheld",
    );
    if (!row) throw new Error("A baseline comparison lacks its withheld judge row");
    const judged = (sourceId: string, criterionId: string) => {
      const outcome = row.builds
        .find((build) => build.sourceId === sourceId)
        ?.criteria.find((criterion) => criterion.criterionId === criterionId)?.outcome;
      if (!outcome) throw new Error("A baseline unit lacks its judge outcome");
      return outcome === "auto_accept"
        ? "satisfied"
        : outcome === "auto_reject"
          ? "violated"
          : null;
    };
    const pair = (
      member: string,
      sourceId: string,
      criterionId: string,
      baseline: BaselineDecision,
    ): IncrementPair => {
      const label = expert("withheld", sourceId, criterionId);
      return {
        member,
        build: sourceId,
        judge: label === null ? null : judged(sourceId, criterionId) === label,
        baseline: label === null || baseline === null ? null : baseline === label,
      };
    };
    const trivial = (decision: "satisfied" | "violated") =>
      evalIds.flatMap((evalId) =>
        required(evalId).flatMap((criterionId) =>
          sources(evalId).map((source) =>
            pair(JSON.stringify([evalId, criterionId]), source.id, criterionId, decision),
          ),
        ),
      );
    const rules = (authored: boolean) =>
      ladder.rules
        .filter((rule) => !authored || rule.authoredThreshold !== null)
        .flatMap((rule) =>
          sources(rule.evalId).map((source) =>
            pair(rule.id, source.id, rule.criterionId, pixelDecision(rule, source.id, authored)),
          ),
        );
    const describe = (member: string) => {
      const rule = ladder.rules.find((item) => item.id === member);
      if (rule) return { taskId: rule.evalId, criterionId: rule.criterionId, ruleId: rule.id };
      const [taskId, criterionId] = JSON.parse(member) as [string, string];
      return { taskId, criterionId, ruleId: null };
    };
    const family = (baseline: string, pairs: IncrementPair[]) => {
      const result = judgeIncrement(pairs, confidence);
      return {
        baseline,
        ...result,
        members: result.members.map((item) => ({ ...item, ...describe(item.member) })),
      };
    };
    return {
      presentation,
      partition: "withheld" as const,
      families: [
        family("always_pass", trivial("satisfied")),
        family("always_fail", trivial("violated")),
        family("pixel_rules", rules(false)),
        family("authored_rules", rules(true)),
      ],
    };
  });
  const planned = plan.captures.reduce((sum, capture) => sum + ruled(capture.evalId).size, 0);
  const recorded = [...records.values()].sort(
    (a, b) =>
      compareCodeUnits(a.captureId, b.captureId) || compareCodeUnits(a.criterionId, b.criterionId),
  );
  return {
    measurements: {
      planned,
      recorded: recorded.length,
      missing: planned - recorded.length,
      wholeFrame: recorded.filter((record) => record.scope === "whole_frame").length,
      withIssue: recorded.filter((record) => record.issue !== null).length,
      records: recorded,
    },
    calibration,
    holdout,
  };
}
