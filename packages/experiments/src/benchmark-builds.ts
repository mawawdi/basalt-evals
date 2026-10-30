import type {
  BenchmarkBuild,
  BenchmarkBuildBreakdown,
  BenchmarkCriterionOutcome,
  BenchmarkMark,
  BenchmarkRequestTelemetry,
  BenchmarkStudioSession,
} from "../../contracts/src/benchmarks.js";
import type { RunOperationEvent, RunOperationManifest } from "../../contracts/src/execution.js";
import { stageActiveMs } from "./benchmarks.js";
import { combineSamples, judgeSampleGroups, type SampleVote } from "./judge-samples.js";

/** The saved records of one run that the marks of its builds read. */
interface BenchmarkMarkRecords {
  manifest: Pick<
    RunOperationManifest,
    "subjects" | "captureCells" | "gradingCells" | "judgmentBatches"
  >;
  events: RunOperationEvent[];
  outcomes: BenchmarkCriterionOutcome[];
}

/** The saved records of one run that its builds read, with the charges and the Studio times. */
export interface BenchmarkBuildRecords extends BenchmarkMarkRecords {
  requests: BenchmarkRequestTelemetry[];
  studioSessions: BenchmarkStudioSession[];
}

/** A build with its marks, without the charges and the times of its breakdown. */
export type BenchmarkBuildMarks = Omit<BenchmarkBuild, "breakdown">;

type Capture = RunOperationManifest["captureCells"][number];
type GradingCell = RunOperationManifest["gradingCells"][number];
type Batch = RunOperationManifest["judgmentBatches"][number];
/** The samples of one judge request for one observation. */
interface SampleGroup {
  id: string;
  captureCellId: string;
  criterionIds: string[];
}

interface MarkIndex {
  number: Map<string, number>;
  /** One answer for each code check and each judge sample group. */
  answers: Map<string, BenchmarkCriterionOutcome>;
  captures: Map<string, Capture[]>;
  grading: Map<string, GradingCell[]>;
  groups: Map<string, SampleGroup[]>;
  notReached: Set<string>;
}

interface BreakdownIndex {
  captures: Map<string, Capture[]>;
  batches: Map<string, Batch[]>;
  requests: Map<string, BenchmarkRequestTelemetry[]>;
  sessions: Map<string, BenchmarkStudioSession[]>;
  events: Map<string, RunOperationEvent[]>;
}

/** The judge sample groups of a run, in the sequence of their first batch. */
export function sampleGroups(
  manifest: Pick<RunOperationManifest, "judgmentBatches">,
): SampleGroup[] {
  return judgeSampleGroups(manifest.judgmentBatches).map(({ id, batches }) => ({
    id,
    captureCellId: batches[0]!.captureCellId,
    criterionIds: batches[0]!.criterionIds,
  }));
}

const vote = (answer: BenchmarkCriterionOutcome | undefined): SampleVote | null =>
  !answer
    ? null
    : answer.outcome === "met"
      ? "met"
      : answer.outcome === "rejected"
        ? "not_met"
        : answer.outcome === "scored"
          ? "scored"
          : "insufficient";

/**
 * One answer for each code check and each judge sample group. The samples of a group combine
 * into one answer: every sample met gives met, every sample not met gives not met, samples that
 * disagree give split, and an insufficient sample gives insufficient. A group with a sample
 * without a saved answer has no answer, so its mark is `missing`. A combined score is known only
 * when every sample gave it.
 */
export function combinedOutcomes(
  manifest: Pick<RunOperationManifest, "gradingCells" | "judgmentBatches">,
  outcomes: BenchmarkCriterionOutcome[],
): BenchmarkCriterionOutcome[] {
  const saved = new Map(
    outcomes.map((answer) => [`${answer.cellId}:${answer.criterionId}`, answer]),
  );
  const code = new Set(manifest.gradingCells.map((cell) => cell.id));
  return [
    ...outcomes.filter((answer) => code.has(answer.cellId)),
    ...judgeSampleGroups(manifest.judgmentBatches).flatMap(({ id, batches }) =>
      batches[0]!.criterionIds.flatMap((criterionId): BenchmarkCriterionOutcome[] => {
        const samples = batches.map((batch) => saved.get(`${batch.id}:${criterionId}`));
        const combined = combineSamples(samples.map(vote));
        if (combined.answer === "missing") return [];
        const scores = new Set(samples.map((answer) => answer?.score ?? null));
        return [
          {
            cellId: id,
            criterionId,
            method: samples[0]!.method,
            outcome: {
              met: "met" as const,
              not_met: "rejected" as const,
              split: "split" as const,
              scored: "scored" as const,
              insufficient: "insufficient" as const,
            }[combined.answer],
            score: scores.size === 1 ? [...scores][0]! : null,
            samples: { met: combined.met, of: combined.of },
            observed: null,
          },
        ];
      }),
    ),
  ];
}

function group<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(row);
  }
  return groups;
}

// A projection asks for the builds of each case, so it indexes the records of a run one time.
const markIndexes = new WeakMap<BenchmarkMarkRecords, MarkIndex>();
function markIndexOf(records: BenchmarkMarkRecords): MarkIndex {
  let index = markIndexes.get(records);
  if (!index) {
    index = {
      number: new Map(records.manifest.subjects.map((subject, i) => [subject.id, i + 1])),
      answers: new Map(
        combinedOutcomes(records.manifest, records.outcomes).map((answer) => [
          `${answer.cellId}:${answer.criterionId}`,
          answer,
        ]),
      ),
      captures: group(records.manifest.captureCells, (capture) => capture.treatmentId),
      grading: group(records.manifest.gradingCells, (cell) => cell.captureCellId),
      groups: group(sampleGroups(records.manifest), (sampleGroup) => sampleGroup.captureCellId),
      notReached: new Set(
        records.events
          .filter(
            (event) =>
              event.stage === "builder" &&
              event.kind === "not_dispatched" &&
              event.reason === "stage_not_reached",
          )
          .map((event) => event.unitId!),
      ),
    };
    markIndexes.set(records, index);
  }
  return index;
}

const breakdownIndexes = new WeakMap<BenchmarkBuildRecords, BreakdownIndex>();
function breakdownIndexOf(records: BenchmarkBuildRecords): BreakdownIndex {
  let index = breakdownIndexes.get(records);
  if (!index) {
    index = {
      captures: markIndexOf(records).captures,
      batches: group(records.manifest.judgmentBatches, (batch) => batch.captureCellId),
      requests: group(records.requests, (request) => request.stage),
      sessions: group(records.studioSessions, (session) => `${session.stage}:${session.unitId}`),
      events: group(records.events, (event) => `${event.stage}:${event.unitId}`),
    };
    breakdownIndexes.set(records, index);
  }
  return index;
}

/** A sum is known only when each part is known. No parts is a known zero. */
function knownSum(values: Array<number | null>): number | null {
  return values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value!, 0)
    : null;
}

/** Confirmed charges only. Null when no request has a confirmed charge, or one has no amount. */
function confirmedUsd(requests: BenchmarkRequestTelemetry[]): number | null {
  const settled = requests.filter((request) => request.status === "billed");
  return settled.length ? knownSum(settled.map((request) => request.billedUsd)) : null;
}

/** The charges and times of one build. Its parts are separate and Basalt never adds them. */
export function buildBreakdown(
  records: BenchmarkBuildRecords,
  subjectId: string,
): BenchmarkBuildBreakdown {
  const index = breakdownIndexOf(records);
  const captures = index.captures.get(subjectId) ?? [];
  const batches = captures.flatMap((capture) => index.batches.get(capture.id) ?? []);
  const builder = index.requests.get(`builder:${subjectId}`) ?? [];
  const judge = batches.flatMap((batch) => index.requests.get(`judgment:${batch.id}`) ?? []);
  const active = (stage: "builder" | "final_capture" | "judgment", unitId: string) =>
    stageActiveMs(index.events.get(`${stage}:${unitId}`) ?? [], stage, unitId);
  const built = index.sessions.get(`builder:${subjectId}`) ?? [];
  const observed = captures.flatMap(
    (capture) => index.sessions.get(`final_capture:${capture.id}`) ?? [],
  );
  const buildMs = active("builder", subjectId);
  // No Studio session is a known zero only after the stage ends; before that it is unrecorded.
  const studio = (
    sessions: BenchmarkStudioSession[],
    ended: boolean,
    key: "queueMs" | "activeMs",
  ) => (sessions.length || ended ? knownSum(sessions.map((session) => session[key])) : null);
  const observedAll = captures.every((capture) => active("final_capture", capture.id) !== null);
  // A turn time is known only when each sent request recorded its latency.
  const sent = builder.filter((request) => request.dispatched !== false);
  return {
    charge: {
      builderUsd: confirmedUsd(builder),
      judgeUsd: confirmedUsd(judge),
      pendingUsd: [...builder, ...judge]
        .filter((request) => request.status === "pending")
        .reduce((sum, request) => sum + request.reservedUsd, 0),
    },
    time: {
      buildMs,
      builderTurnsMs: sent.length ? knownSum(sent.map((request) => request.latencyMs)) : null,
      builderStudioWaitMs: studio(built, buildMs !== null, "queueMs"),
      builderStudioMs: studio(built, buildMs !== null, "activeMs"),
      observationStudioWaitMs: studio(observed, observedAll, "queueMs"),
      observationStudioMs: studio(observed, observedAll, "activeMs"),
      judgeMs: knownSum(batches.map((batch) => active("judgment", batch.id))),
    },
  };
}

/**
 * One build for each subject in manifest order, with one mark for each planned answer. A planned
 * answer without a saved record is a missing mark, not a failure.
 */
export function caseBuildMarks(
  records: BenchmarkMarkRecords,
  subjectIds: string[],
): BenchmarkBuildMarks[] {
  const index = markIndexOf(records);
  const wanted = new Set(subjectIds);
  for (const id of wanted)
    if (!index.number.has(id)) throw new Error("A benchmark build is absent from the run plan");
  const mark = (
    subjectId: string,
    pass: number,
    criterionId: string,
    method: BenchmarkMark["method"],
    evidenceCellId: string,
    answer: BenchmarkCriterionOutcome | undefined,
  ): BenchmarkMark => ({
    subjectId,
    pass,
    criterionId,
    method,
    evidenceCellId,
    outcome: answer?.outcome ?? "missing",
    score: answer?.score ?? null,
    samples: answer?.samples ?? null,
    observed: answer?.observed ?? null,
  });
  return records.manifest.subjects
    .filter((subject) => wanted.has(subject.id))
    .map((subject) => ({
      subjectId: subject.id,
      number: index.number.get(subject.id)!,
      marks: [...(index.captures.get(subject.id) ?? [])]
        .sort((a, b) => a.pass - b.pass)
        .flatMap((capture) => [
          // A code check reads its evidence by its grading cell.
          ...(index.grading.get(capture.id) ?? []).map((cell) =>
            mark(
              subject.id,
              capture.pass,
              cell.criterionId,
              "deterministic",
              cell.id,
              index.answers.get(`${cell.id}:${cell.criterionId}`),
            ),
          ),
          // A judge check has one mark for each sample group. It reads its evidence by the
          // sample group and its criterion.
          ...(index.groups.get(capture.id) ?? []).flatMap((sampleGroup) =>
            sampleGroup.criterionIds.map((criterionId) =>
              mark(
                subject.id,
                capture.pass,
                criterionId,
                "model",
                `${sampleGroup.id}:${criterionId}`,
                index.answers.get(`${sampleGroup.id}:${criterionId}`),
              ),
            ),
          ),
        ]),
      parentSubjectId: subject.parentSubjectId,
      notReached: index.notReached.has(subject.id),
    }));
}

/** The builds of `caseBuildMarks`, each with the charges and the times of its breakdown. */
export function caseBuilds(records: BenchmarkBuildRecords, subjectIds: string[]): BenchmarkBuild[] {
  return caseBuildMarks(records, subjectIds).map((build) => ({
    subjectId: build.subjectId,
    number: build.number,
    marks: build.marks,
    breakdown: buildBreakdown(records, build.subjectId),
    parentSubjectId: build.parentSubjectId,
    notReached: build.notReached,
  }));
}
