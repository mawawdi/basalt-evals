import { stableJson, type JsonPrimitive } from "../../contracts/src/index.js";
import type { BenchmarkMark, BenchmarkPlanWarning } from "../../contracts/src/benchmarks.js";

/*
 * Plan warnings. A private check that every build fails, or that every build meets, may not
 * tell builds apart. A pass on the empty build and a known build that the check answers wrongly
 * are stronger signs. A warning is a sign for a person. It never changes an answer, a review or
 * a total.
 */

/** One answer for one criterion: an observation of a build, the empty build or a known build. */
export interface PlanWarningRow {
  evaluationId: string;
  criterionId: string;
  /** Only generated builds decide the kinds for every build. */
  origin: "generated" | "empty_build" | "known_build";
  /** One build. The observations of a build share the ID. */
  buildId: string;
  answer: BenchmarkMark["outcome"];
  /** The Studio values that a code check read. Null for a judge check. */
  observed: JsonPrimitive[] | null;
  /** The expected answer of a known build. Null for every other row. */
  expectation: "met" | "rejected" | null;
}

/**
 * The plan warnings of each criterion, in the sequence of the first row of each criterion.
 *
 * - The kinds for every build read only generated builds. They need at least `minimumBuilds`
 *   builds, and every answer must be met or not met. An insufficient, missing, split or scored
 *   answer gives no such warning.
 * - Every build fails with the same observed value, if each failure read a value. Otherwise
 *   every build fails.
 * - A met answer of the empty build is a pass on the empty build.
 * - A known build disagrees when its answer is met or not met and differs from its expectation.
 */
export function criterionWarnings(
  rows: PlanWarningRow[],
  minimumBuilds = 2,
): BenchmarkPlanWarning[] {
  const criteria = new Map<string, PlanWarningRow[]>();
  for (const row of rows) {
    const key = stableJson([row.evaluationId, row.criterionId]);
    if (!criteria.has(key)) criteria.set(key, []);
    criteria.get(key)!.push(row);
  }
  return [...criteria.values()].flatMap((group) => {
    const { evaluationId, criterionId } = group[0]!;
    const warning = (
      kind: BenchmarkPlanWarning["kind"],
      builds: number,
      observed: JsonPrimitive[] | null,
      knownBuildIds: string[] = [],
    ): BenchmarkPlanWarning => ({
      evaluationId,
      criterionId,
      kind,
      builds,
      observed,
      knownBuildIds,
    });
    const warnings: BenchmarkPlanWarning[] = [];
    const generated = group.filter((row) => row.origin === "generated");
    const builds = new Set(generated.map((row) => row.buildId)).size;
    const enough = builds > 0 && builds >= minimumBuilds;
    if (enough && generated.every((row) => row.answer === "rejected")) {
      const values = new Set(generated.map((row) => stableJson(row.observed)));
      const same = values.size === 1 && generated[0]!.observed !== null;
      warnings.push(
        same
          ? warning("same_observed_failure", builds, generated[0]!.observed)
          : warning("every_build_fails", builds, null),
      );
    }
    if (enough && generated.every((row) => row.answer === "met"))
      warnings.push(warning("every_build_meets", builds, null));
    const empty = group.find((row) => row.origin === "empty_build" && row.answer === "met");
    if (empty) warnings.push(warning("passes_empty_build", 0, empty.observed));
    const disagree = group.filter(
      (row) =>
        row.origin === "known_build" &&
        (row.answer === "met" || row.answer === "rejected") &&
        row.expectation !== null &&
        row.answer !== row.expectation,
    );
    if (disagree.length)
      warnings.push(
        warning("known_build_disagrees", 0, null, [...new Set(disagree.map((row) => row.buildId))]),
      );
    return warnings;
  });
}

/** One row for each mark of each generated build of a benchmark. */
export function benchmarkPlanRows(
  operationId: string,
  cases: Array<{
    evaluationId: string;
    builds: Array<{ subjectId: string; marks: BenchmarkMark[] }>;
  }>,
): PlanWarningRow[] {
  return cases.flatMap((item) =>
    item.builds.flatMap((build) =>
      build.marks.map((mark) => ({
        evaluationId: item.evaluationId,
        criterionId: mark.criterionId,
        origin: "generated" as const,
        buildId: `${operationId}/${build.subjectId}`,
        answer: mark.outcome,
        observed: mark.observed,
        expectation: null,
      })),
    ),
  );
}

/** Put warnings in the sequence of the authored criteria. A criterion without one goes last. */
export function authoredWarningOrder(
  warnings: BenchmarkPlanWarning[],
  criteria: Array<{ evaluationId: string; criterionId: string }>,
): BenchmarkPlanWarning[] {
  const position = new Map(
    criteria.map((row, index) => [stableJson([row.evaluationId, row.criterionId]), index]),
  );
  const at = (warning: BenchmarkPlanWarning) =>
    position.get(stableJson([warning.evaluationId, warning.criterionId])) ?? Infinity;
  return warnings
    .map((warning, index) => ({ warning, index }))
    .sort((a, b) => at(a.warning) - at(b.warning) || a.index - b.index)
    .map(({ warning }) => warning);
}
