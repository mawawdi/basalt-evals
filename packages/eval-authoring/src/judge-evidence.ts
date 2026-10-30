import {
  hashJson,
  stableJson,
  type StudioActionBinding,
  type StudioEvidence,
  type StudioObservation,
  type StudioObservationBinding,
} from "../../contracts/src/index.js";
import type { CriterionMaterial } from "./criterion-material.js";

/** A motion trace as the judge reads it. Basalt makes it from the signed samples. */
interface SampleTable {
  count: number;
  firstMs: number | null;
  lastMs: number | null;
  maxGapMs: number;
  /** A column with one value in all samples. */
  constant: Record<string, number>;
  /** elapsedMs first, then the columns that change. */
  columns: string[];
  /** A cell of elapsedMs is [firstMs, lastMs, count] for a run of samples with equal values. */
  rows: Array<Array<number | [number, number, number]>>;
  summary: Record<
    string,
    {
      first: number;
      last: number;
      min: number;
      max: number;
      firstChangeMs: number;
      lastChangeMs: number;
      largestStep: number;
      largestStepAtMs: number;
    }
  >;
}

interface JudgeEvidence {
  criterionEvidence: Array<{
    criterionId: string;
    observations: string[];
    actions: string[];
    sources: string[];
    absentSourcePaths: string[];
    runtime: boolean;
  }>;
  signedObservations: Array<{
    ref: string;
    binding: StudioObservationBinding;
    hash: string | null;
    observation: unknown;
  }>;
  signedActions: Array<{
    ref: string;
    binding: StudioActionBinding;
    hash: string | null;
    receipt: unknown;
  }>;
  sealedSources: Array<{ path: string; hash: string; text: string }>;
  signedRuntime: StudioEvidence | null;
}

/**
 * Roblox keeps positions as 32-bit floats. The shortest decimal that rounds to the same 32-bit
 * value is exact for the reader that rounds it again, and it is half the length.
 */
export function shortestFloat32(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value) || Math.fround(value) !== value)
    return value;
  for (let digits = 1; digits < 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return Number(value.toPrecision(9));
}

/**
 * Thirteen key names in each of 320 samples made one elevator trace 54 KB. A column table keeps
 * every value and the time of every change. It omits the inner times of a run of equal samples.
 */
export function sampleTable(samples: Array<Record<string, number>>): SampleTable {
  const empty = { constant: {}, columns: ["elapsedMs"], rows: [], summary: {} };
  if (!samples.length) return { count: 0, firstMs: null, lastMs: null, maxGapMs: 0, ...empty };
  const shape = Object.keys(samples[0]!).sort().join(",");
  if (
    !Object.hasOwn(samples[0]!, "elapsedMs") ||
    samples.some((sample) => Object.keys(sample).sort().join(",") !== shape)
  )
    throw new Error("The samples of a motion trace do not have one shape");
  const keys = shape.split(",").filter((key) => key !== "elapsedMs");
  const constant: Record<string, number> = {};
  const varying: string[] = [];
  for (const key of keys)
    if (samples.every((sample) => sample[key] === samples[0]![key]))
      constant[key] = shortestFloat32(samples[0]![key]!);
    else varying.push(key);
  const rows: SampleTable["rows"] = [];
  let maxGapMs = 0;
  let start = 0;
  for (let index = 1; index <= samples.length; index++) {
    if (index < samples.length) {
      maxGapMs = Math.max(maxGapMs, samples[index]!.elapsedMs! - samples[index - 1]!.elapsedMs!);
      if (varying.every((key) => samples[index]![key] === samples[start]![key])) continue;
    }
    const first = samples[start]!.elapsedMs!;
    const last = samples[index - 1]!.elapsedMs!;
    rows.push([
      index - start === 1 ? first : [first, last, index - start],
      ...varying.map((key) => shortestFloat32(samples[start]![key]!)),
    ]);
    start = index;
  }
  const summary: SampleTable["summary"] = {};
  for (const key of varying) {
    const values = samples.map((sample) => sample[key]!);
    const changes = values.flatMap((value, index) =>
      index > 0 && value !== values[index - 1] ? [index] : [],
    );
    let largest = changes[0]!;
    for (const index of changes)
      if (
        Math.abs(values[index]! - values[index - 1]!) >
        Math.abs(values[largest]! - values[largest - 1]!)
      )
        largest = index;
    summary[key] = {
      first: shortestFloat32(values[0]!),
      last: shortestFloat32(values.at(-1)!),
      min: shortestFloat32(Math.min(...values)),
      max: shortestFloat32(Math.max(...values)),
      firstChangeMs: samples[changes[0]!]!.elapsedMs!,
      lastChangeMs: samples[changes.at(-1)!]!.elapsedMs!,
      largestStep: shortestFloat32(Math.abs(values[largest]! - values[largest - 1]!)),
      largestStepAtMs: samples[largest]!.elapsedMs!,
    };
  }
  return {
    count: samples.length,
    firstMs: samples[0]!.elapsedMs!,
    lastMs: samples.at(-1)!.elapsedMs!,
    maxGapMs,
    constant,
    columns: ["elapsedMs", ...varying],
    rows,
    summary,
  };
}

function presentedObservation(observation: StudioObservation | null): unknown {
  if (!observation || !("samples" in observation)) return observation;
  const { samples, ...rest } = observation;
  return { ...rest, samples: sampleTable(samples as unknown as Array<Record<string, number>>) };
}

/**
 * Each signed item appears one time. A criterion names its items by reference. Before this, one
 * elevator request repeated a 54 KB trace two times and one source file seven times.
 */
export function judgeEvidence(material: CriterionMaterial[]): JudgeEvidence {
  const observations = new Map<string, JudgeEvidence["signedObservations"][number]>();
  const actions = new Map<string, JudgeEvidence["signedActions"][number]>();
  const sources = new Map<string, JudgeEvidence["sealedSources"][number]>();
  let signedRuntime: StudioEvidence | null = null;
  const criterionEvidence = material.map((item) => {
    const observationRefs = item.signedObservations.map((entry) => {
      const key = stableJson(entry.binding);
      if (!observations.has(key))
        observations.set(key, {
          ref: `O${observations.size + 1}`,
          binding: entry.binding,
          hash: entry.hash,
          observation: presentedObservation(entry.observation),
        });
      else if (observations.get(key)!.hash !== entry.hash)
        throw new Error("Two criteria received different observations for one binding");
      return observations.get(key)!.ref;
    });
    const actionRefs = item.signedActions.map((entry) => {
      const key = stableJson(entry.binding);
      if (!actions.has(key))
        actions.set(key, {
          ref: `A${actions.size + 1}`,
          binding: entry.binding,
          hash: entry.hash,
          receipt: entry.receipt,
        });
      else if (actions.get(key)!.hash !== entry.hash)
        throw new Error("Two criteria received different action receipts for one binding");
      return actions.get(key)!.ref;
    });
    for (const source of item.sealedSources) {
      if (sources.has(source.path) && sources.get(source.path)!.hash !== source.hash)
        throw new Error("Two criteria received different sealed source for one path");
      sources.set(source.path, source);
    }
    if (item.signedRuntime) {
      if (signedRuntime && hashJson(signedRuntime) !== hashJson(item.signedRuntime))
        throw new Error("Two criteria received different Studio evidence");
      signedRuntime = item.signedRuntime;
    }
    return {
      criterionId: item.criterionId,
      observations: observationRefs,
      actions: actionRefs,
      sources: item.sealedSources.map((source) => source.path),
      absentSourcePaths: item.absentSourcePaths,
      runtime: item.signedRuntime !== null,
    };
  });
  return {
    criterionEvidence,
    signedObservations: [...observations.values()],
    signedActions: [...actions.values()],
    sealedSources: [...sources.values()],
    signedRuntime,
  };
}
