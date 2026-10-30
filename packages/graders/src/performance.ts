import type { PerformanceAggregate, PerformanceMetric } from "../../contracts/src/capabilities.js";
import type { PerformanceSample, StudioObservation } from "../../contracts/src/index.js";

/*
 * The fixed check of one performance_trace observation. The values come from one Studio
 * process on one machine, so a verdict is a relative signal for that machine only.
 */

export type PerformanceTraceObservation = Extract<StudioObservation, { kind: "performance_trace" }>;

export interface PerformanceVerdict {
  outcome: "verified" | "rejected" | "incomplete";
  reason: string;
  /** The aggregate and the count of samples, or null when the check read no value. */
  observed: [aggregate: number, samples: number] | null;
}

/** The sample field of each metric. */
const METRIC_FIELDS = {
  max_frame_ms: "maxFrameMs",
  mean_frame_ms: "meanFrameMs",
  instance_count: "instanceCount",
  memory_mb: "memoryMb",
} as const satisfies Record<PerformanceMetric, keyof PerformanceSample>;

const METRIC_UNITS: Record<PerformanceMetric, string> = {
  max_frame_ms: " ms",
  mean_frame_ms: " ms",
  instance_count: " instances",
  memory_mb: " MB",
};

/**
 * Basalt rounds a growth to this count of decimals. Thus the error of a float subtraction does
 * not change a verdict at the bound.
 */
const GROWTH_DECIMALS = 6;

/** The nearest-rank percentile p of the values, with p from 0 to 100. */
export function nearestRank(values: readonly number[], p: number): number {
  if (!values.length) throw new Error("A percentile needs at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

/** One aggregate of the values in sample order. growth is the last value minus the first. */
export function aggregateValues(
  values: readonly number[],
  aggregate: PerformanceAggregate,
): number {
  if (!values.length) throw new Error("An aggregate needs at least one value");
  if (aggregate === "max") return Math.max(...values);
  if (aggregate === "p95") return nearestRank(values, 95);
  return Number((values.at(-1)! - values[0]!).toFixed(GROWTH_DECIMALS));
}

/**
 * Grade one aggregate of one metric against an authored maximum. An absent trace, a trace with
 * fewer samples than the plan or a metric that Studio did not let the runner read makes the
 * check incomplete.
 */
export function checkPerformance(
  observation: PerformanceTraceObservation | null,
  plannedSamples: number,
  metric: PerformanceMetric,
  aggregate: PerformanceAggregate,
  maximum: number,
): PerformanceVerdict {
  if (!observation)
    return {
      outcome: "incomplete",
      reason: "The bound performance_trace fact is absent",
      observed: null,
    };
  const samples = observation.samples;
  if (samples.length < plannedSamples)
    return {
      outcome: "incomplete",
      reason: `The trace has ${samples.length} of the ${plannedSamples} samples of the plan`,
      observed: null,
    };
  const field = METRIC_FIELDS[metric];
  const values = samples.map((sample) => sample[field]);
  if (values.some((value) => value === undefined))
    return {
      outcome: "incomplete",
      reason: `Studio did not let the runner read ${field}, so the trace has no value of it`,
      observed: null,
    };
  const value = aggregateValues(values as number[], aggregate);
  const unit = METRIC_UNITS[metric];
  const measured = `The ${aggregate} of ${field} over ${samples.length} samples is ${formatted(value)}${unit}`;
  return value <= maximum
    ? {
        outcome: "verified",
        reason: `${measured}, at most the authored maximum of ${formatted(maximum)}${unit}`,
        observed: [value, samples.length],
      }
    : {
        outcome: "rejected",
        reason: `${measured}, above the authored maximum of ${formatted(maximum)}${unit}`,
        observed: [value, samples.length],
      };
}

/** A number with at most three decimals and without a negative zero. */
function formatted(value: number): string {
  return String(Number(value.toFixed(3)) + 0);
}
