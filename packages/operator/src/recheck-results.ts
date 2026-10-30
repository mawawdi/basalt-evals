import type { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { AssessmentReport } from "../../contracts/src/assessments.js";
import type {
  RunOperationManifest,
  RunOperationReport,
  RunOperationStatus,
} from "../../contracts/src/execution.js";
import { hashJson } from "../../contracts/src/index.js";
import type { RecheckAnswer, RecheckLaunch } from "../../contracts/src/recheck.js";
import {
  combineSamples,
  outcomeVote,
  type SampleVote,
} from "../../experiments/src/judge-samples.js";
import { manifestHash } from "./run-manifest.js";

/*
 * The paid parts of a recheck run as an ordinary reassessment or an ordinary run. Authorization
 * records each launch by its target revision and the run of the saved builds. A later read finds
 * the answers of the finished launches through this record. It reads only immutable reports.
 */

const NAMESPACE = "recheck_launches";

function launchKey(revisionId: string, sourceOperationId: string) {
  return `${revisionId}:${sourceOperationId}`;
}

/** Call inside the journal transaction that authorizes the launch. */
export function recordRecheckLaunch(
  journal: OperationJournal,
  revisionId: string,
  sourceOperationId: string,
  launch: RecheckLaunch,
): void {
  const key = launchKey(revisionId, sourceOperationId);
  const prior = journal.read<RecheckLaunch[]>(NAMESPACE, key) ?? [];
  if (prior.some((item) => item.operationId === launch.operationId)) return;
  journal.put(NAMESPACE, key, [...prior, launch]);
}

/** The recorded launches for the builds of one run and one target revision. */
export function recheckLaunches(
  journal: OperationJournal,
  revisionId: string,
  sourceOperationId: string,
): RecheckLaunch[] {
  return journal.read<RecheckLaunch[]>(NAMESPACE, launchKey(revisionId, sourceOperationId)) ?? [];
}

/** One answer of a finished launch. A new observation has no saved observation of the run. */
export interface RecheckLaunchAnswer {
  operationId: string;
  part: RecheckLaunch["part"];
  subjectId: string;
  /** The observation of the run that the judge checked again, or null for a new observation. */
  captureId: string | null;
  criterionId: string;
  answer: RecheckAnswer;
}

/** The word of a combined vote, as a recheck answer. Each vote is a sample with an answer. */
export function recheckAnswer(votes: SampleVote[]): RecheckAnswer {
  const { answer } = combineSamples(votes);
  if (answer === "missing") throw new Error("A recheck answer needs an answer of each sample");
  return answer;
}

/** The vote of one judge decision, with the rule of the run outcomes. */
function decisionVote(decision: {
  verdict: "satisfied" | "violated" | "insufficient";
  score: number | null;
}): SampleVote {
  return decision.verdict === "satisfied"
    ? "met"
    : decision.verdict === "violated"
      ? "not_met"
      : decision.score !== null
        ? "scored"
        : "insufficient";
}

/**
 * The answers of the finished launches, in launch sequence. A launch without its sealed report
 * has no answers yet. A changed report is an error, because a report is immutable.
 */
export async function finishedRecheckAnswers(
  root: string,
  journal: OperationJournal,
  launches: RecheckLaunch[],
): Promise<RecheckLaunchAnswer[]> {
  const files = new RepositoryFiles(root);
  const answers: RecheckLaunchAnswer[] = [];
  for (const launch of launches) {
    const base = `.basalt-evals/eval-operations/${launch.operationId}`;
    if (launch.part === "judge") {
      const sealed = journal.read<{ hash: string }>("assessment_reports", launch.operationId);
      if (!sealed) continue;
      const report = await files.json<AssessmentReport>(`${base}/assessment-report.json`);
      if (hashJson(report) !== sealed.hash)
        throw new Error("The report of a recheck changed after Basalt sealed it");
      // Each unit is one judge sample of the original evidence. The samples of one observation
      // and criterion combine into one answer, like the samples of the run.
      const votes = new Map<
        string,
        { subjectId: string; captureId: string; criterionId: string; votes: SampleVote[] }
      >();
      for (const unit of report.results)
        for (const criterionId of unit.criterionIds) {
          const decision = unit.result?.decisions.find((item) => item.criterionId === criterionId);
          const key = `${unit.captureId}:${criterionId}`;
          const entry = votes.get(key) ?? {
            subjectId: unit.subjectId,
            captureId: unit.captureId,
            criterionId,
            votes: [],
          };
          // A sample without a decision has not enough evidence.
          entry.votes.push(decision ? decisionVote(decision) : "insufficient");
          votes.set(key, entry);
        }
      for (const { votes: list, ...entry } of votes.values())
        answers.push({
          operationId: launch.operationId,
          part: launch.part,
          ...entry,
          answer: recheckAnswer(list),
        });
      continue;
    }
    const report = await files.optional<RunOperationReport>(`${base}/report.json`);
    if (!report) continue;
    const manifest = await files.json<RunOperationManifest>(`${base}/manifest.json`);
    if (
      report.schema !== "basalt-evals/run-operation-report" ||
      report.operationId !== launch.operationId ||
      report.manifestHash !== manifestHash(manifest)
    )
      throw new Error("The report of a recheck does not match its run");
    // A new observation of a saved build is a subject of a registered source.
    const subjectOf = new Map(
      manifest.subjects
        .filter((subject) => subject.sourceId)
        .map((subject) => [
          subject.id,
          launch.subjects.find((item) => item.sourceId === subject.sourceId)?.subjectId ?? null,
        ]),
    );
    const captureOf = new Map<string, string>([
      ...manifest.gradingCells.map((cell) => [cell.id, cell.captureCellId] as const),
      ...manifest.judgmentBatches.map((batch) => [batch.id, batch.captureCellId] as const),
    ]);
    const votes = new Map<
      string,
      { subjectId: string; criterionId: string; votes: SampleVote[] }
    >();
    for (const outcome of report.criterionOutcomes) {
      const capture = manifest.captureCells.find(
        (cell) => cell.id === captureOf.get(outcome.cellId),
      );
      const subjectId = capture ? subjectOf.get(capture.treatmentId) : null;
      const vote = outcomeVote(outcome.outcome);
      if (!subjectId || !vote) continue;
      const key = `${subjectId}:${outcome.criterionId}`;
      const entry = votes.get(key) ?? { subjectId, criterionId: outcome.criterionId, votes: [] };
      entry.votes.push(vote);
      votes.set(key, entry);
    }
    // A planned check without an outcome stays in the denominator as a vote without an answer.
    for (const capture of manifest.captureCells) {
      const subjectId = subjectOf.get(capture.treatmentId);
      if (!subjectId) continue;
      const planned = [
        ...manifest.gradingCells
          .filter((cell) => cell.captureCellId === capture.id)
          .map((cell) => ({ id: cell.id, criterionIds: [cell.criterionId] })),
        ...manifest.judgmentBatches
          .filter((batch) => batch.captureCellId === capture.id)
          .map((batch) => ({ id: batch.id, criterionIds: batch.criterionIds })),
      ];
      for (const cell of planned)
        for (const criterionId of cell.criterionIds)
          if (
            !report.criterionOutcomes.some(
              (outcome) => outcome.cellId === cell.id && outcome.criterionId === criterionId,
            )
          ) {
            const key = `${subjectId}:${criterionId}`;
            const entry = votes.get(key) ?? { subjectId, criterionId, votes: [] };
            entry.votes.push("insufficient");
            votes.set(key, entry);
          }
    }
    for (const entry of votes.values())
      answers.push({
        operationId: launch.operationId,
        part: launch.part,
        subjectId: entry.subjectId,
        captureId: null,
        criterionId: entry.criterionId,
        answer: recheckAnswer(entry.votes),
      });
  }
  return answers;
}

/**
 * The saved answer of each observation and criterion of a run. The judge samples of one
 * criterion combine into one answer. A planned check with a sample without an outcome has no
 * answer.
 */
export function savedAnswers(
  manifest: Pick<RunOperationManifest, "gradingCells" | "judgmentBatches">,
  outcomes: RunOperationStatus["criterionOutcomes"],
): Map<string, RecheckAnswer> {
  const recorded = new Map(
    outcomes.map((outcome) => [`${outcome.cellId}:${outcome.criterionId}`, outcome.outcome]),
  );
  const votes = new Map<string, Array<SampleVote | null>>();
  const add = (captureId: string, cellId: string, criterionId: string) => {
    const key = `${captureId}:${criterionId}`;
    votes.set(key, [
      ...(votes.get(key) ?? []),
      outcomeVote(recorded.get(`${cellId}:${criterionId}`)),
    ]);
  };
  for (const cell of manifest.gradingCells) add(cell.captureCellId, cell.id, cell.criterionId);
  for (const batch of manifest.judgmentBatches)
    for (const criterionId of batch.criterionIds) add(batch.captureCellId, batch.id, criterionId);
  return new Map(
    [...votes].flatMap(([key, list]) =>
      list.every((vote): vote is SampleVote => vote !== null)
        ? [[key, recheckAnswer(list)] as const]
        : [],
    ),
  );
}
