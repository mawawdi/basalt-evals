import type { AnswerCounts } from "../../contracts/src/catalog.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import {
  combinedOutcome,
  combineSamples,
  judgeSampleGroups,
  outcomeVote,
} from "../../experiments/src/judge-samples.js";
import { notReachedSubjects } from "./stage-reach.js";

/** One planned check of a run: a code check, or one criterion of one judge sample group. */
interface PlannedCheck {
  captureCellId: string;
  method: string;
  /** The combined outcome. Undefined while no sample of the check has an answer. */
  outcome: string | undefined;
}

/**
 * The planned checks of a run, each with its combined outcome. The samples of a judge sample
 * group combine into one outcome, so a check counts one time and not one time for each sample.
 */
export function plannedChecks(
  status: Pick<RunOperationStatus, "manifest" | "criterionOutcomes">,
): PlannedCheck[] {
  const { manifest } = status;
  const outcomes = new Map(
    status.criterionOutcomes.map((item) => [`${item.cellId}:${item.criterionId}`, item.outcome]),
  );
  return [
    ...manifest.gradingCells.map((cell) => ({
      captureCellId: cell.captureCellId,
      method: cell.method,
      outcome: outcomes.get(`${cell.id}:${cell.criterionId}`),
    })),
    ...judgeSampleGroups(manifest.judgmentBatches).flatMap(({ batches }) =>
      batches[0]!.criterionIds.map((criterionId) => {
        const votes = batches.map((batch) =>
          outcomeVote(outcomes.get(`${batch.id}:${criterionId}`)),
        );
        return {
          captureCellId: batches[0]!.captureCellId,
          method: "visual",
          outcome: votes.every((vote) => vote === null)
            ? undefined
            : combinedOutcome(combineSamples(votes)),
        };
      }),
    ),
  ];
}

/** Count the answers of a set of checks. A check without an answer is unavailable. */
export function answerCounts(checks: ReadonlyArray<Pick<PlannedCheck, "outcome">>): AnswerCounts {
  const counts: AnswerCounts = {
    planned: checks.length,
    met: 0,
    rejected: 0,
    split: 0,
    scored: 0,
    insufficient: 0,
    unavailable: 0,
  };
  for (const { outcome } of checks)
    if (outcome === "verified") counts.met++;
    else if (outcome === "rejected") counts.rejected++;
    else if (outcome === "split") counts.split++;
    else if (outcome === "scored") counts.scored++;
    else if (outcome === "insufficient") counts.insufficient++;
    else counts.unavailable++;
  return counts;
}

/**
 * The answers of a run. The checks of a build that the run did not reach are outside the
 * measurement, so they do not count.
 */
export function runAnswerCounts(
  status: Pick<RunOperationStatus, "manifest" | "events" | "criterionOutcomes">,
): AnswerCounts {
  const notReached = notReachedSubjects(status.events);
  const outside = new Set(
    status.manifest.captureCells
      .filter((capture) => notReached.has(capture.treatmentId))
      .map((capture) => capture.id),
  );
  return answerCounts(plannedChecks(status).filter((check) => !outside.has(check.captureCellId)));
}
