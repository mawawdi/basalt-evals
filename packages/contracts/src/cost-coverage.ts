import type { BenchmarkReport } from "./benchmarks.js";

/** One build in the cost and coverage chart. Null is a figure that Basalt did not record. */
export interface CostCoverageBuild {
  subjectId: string;
  /** "Build n" in the evidence. */
  number: number;
  evaluationId: string;
  /**
   * The answers of the build that can be met. A scored answer has no pass mark, so it stays
   * out. Open answers are missing or split: their answer is not known yet.
   */
  answers: { met: number; open: number; planned: number };
  /**
   * The share of the answers that are met. The lower bound counts every open answer as not
   * met, and the upper bound as met. Null for a build with no answer that can be met.
   */
  met: { lower: number; upper: number } | null;
  /**
   * The confirmed builder and judge charges together. A part with no confirmed charge, for
   * example a run with no judge checks, adds nothing. Null when neither part has one.
   */
  chargeUsd: number | null;
  /** Charges that requests hold until the provider confirms them. */
  pendingUsd: number;
  /** The active build time. Paused time does not count. */
  buildMs: number | null;
}

export interface CostCoverageRow {
  rowId: string;
  modelName: string;
  harnessId: string;
  harnessTitle: string;
  builds: CostCoverageBuild[];
}

/**
 * The builds of each model and tool set, for three aligned strips: criteria met, confirmed
 * charge and build time. Each build is one point. A build that the run did not reach is left
 * out, because it never started. Nothing adds the strips together or ranks the rows.
 */
export function costCoverage(report: Pick<BenchmarkReport, "rows">): CostCoverageRow[] {
  return report.rows.map((row) => ({
    rowId: row.id,
    modelName: row.modelName,
    harnessId: row.harnessId,
    harnessTitle: row.harnessTitle,
    builds: row.cases.flatMap((item) =>
      item.builds
        .filter((build) => !build.notReached)
        .map((build) => {
          const outcomes = build.marks.map((mark) => mark.outcome);
          // "Not enough evidence" is an answer, so it counts as not met in both bounds.
          const answers = {
            met: outcomes.filter((outcome) => outcome === "met").length,
            open: outcomes.filter((outcome) => outcome === "missing" || outcome === "split").length,
            planned: outcomes.filter((outcome) => outcome !== "scored").length,
          };
          const { builderUsd, judgeUsd, pendingUsd } = build.breakdown.charge;
          return {
            subjectId: build.subjectId,
            number: build.number,
            evaluationId: item.evaluationId,
            answers,
            met: answers.planned
              ? {
                  lower: answers.met / answers.planned,
                  upper: (answers.met + answers.open) / answers.planned,
                }
              : null,
            chargeUsd:
              builderUsd === null && judgeUsd === null ? null : (builderUsd ?? 0) + (judgeUsd ?? 0),
            pendingUsd,
            buildMs: build.breakdown.time.buildMs,
          };
        }),
    ),
  }));
}

/** The lowest and the highest value, or null without a value. */
export function valueRange(values: Array<number | null>): { low: number; high: number } | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? { low: Math.min(...known), high: Math.max(...known) } : null;
}
