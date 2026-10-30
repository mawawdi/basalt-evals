import { hashJson } from "../../contracts/src/index.js";
import type {
  AuditReport,
  ReviewAnswer,
  ReviewAssignment,
  ReviewBatch,
  ReviewPopulation,
} from "../../contracts/src/review.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import {
  agreementGate,
  answerLabel,
  automaticLabels,
  compareRaters,
  repeatAgreement,
  summarizeAudit,
  summarizeExperts,
} from "../../experiments/src/audit.js";
import {
  readReviewAnswer,
  readReviewPair,
  readReviewPopulation,
  requireAssignment,
  requireBatch,
  reviewBinding,
  saveReviewArtifact,
  reviewProgress,
} from "./review-store.js";

function snapshot(journal: OperationJournal, batch: ReviewBatch) {
  return {
    batch,
    assignments: batch.assignmentIds.map((id) => requireAssignment(journal, batch, id)),
    progress: reviewProgress(journal, batch),
  };
}
type Snapshot = ReturnType<typeof snapshot>;

/** Read the answer of an assignment and check its binding and its reviewer. */
async function answerOf(
  root: string,
  population: ReviewPopulation,
  batch: ReviewBatch,
  assignment: ReviewAssignment,
): Promise<ReviewAnswer | null> {
  if (!assignment.answerId) return null;
  const answer = await readReviewAnswer(root, assignment.answerId);
  const { unit } = reviewBinding(population, assignment.unitId);
  if (answer.binding !== unit.binding || answer.reviewer !== batch.reviewer)
    throw new Error("Audit label binding changed");
  return answer;
}
/** The first answer of each unit. A delayed repeat is not a first answer. */
async function firstAnswers(root: string, population: ReviewPopulation, value: Snapshot) {
  const answers = new Map<string, ReviewAnswer | null>();
  for (const assignment of value.assignments.filter((item) => item.repeatOf === null))
    answers.set(assignment.unitId, await answerOf(root, population, value.batch, assignment));
  return answers;
}

export async function reviewAuditReport(root: string, batchId: string): Promise<AuditReport> {
  const journal = await OperationJournal.open(root);
  try {
    // Freeze answer references and counters of every batch in the pair together before
    // asynchronous artifact reads. A concurrent answer belongs to the next report snapshot.
    const frozen = journal.transaction(() => {
      const batch = requireBatch(journal, batchId);
      const pair = batch.expert ? readReviewPair(journal, batch.expert.pairId) : null;
      return {
        own: snapshot(journal, batch),
        group: pair?.second
          ? {
              pair,
              first: snapshot(journal, requireBatch(journal, pair.first)),
              second: snapshot(journal, requireBatch(journal, pair.second)),
              roundTwo: pair.roundTwo
                ? {
                    first: snapshot(journal, requireBatch(journal, pair.roundTwo.first)),
                    second: snapshot(journal, requireBatch(journal, pair.roundTwo.second)),
                    unitIds: pair.roundTwo.unitIds,
                  }
                : null,
            }
          : null,
      };
    });
    const { batch, assignments, progress } = frozen.own;
    const population = await readReviewPopulation(root, batch.populationId);
    const random = batch.purpose === "audit";
    // Only the first answers of round 1 count. Training, repeats and round 2 do not.
    const counted = batch.purpose !== "training" && batch.expert?.round !== 2;
    const own = await firstAnswers(root, population, frozen.own);
    const observations = counted
      ? [...own.entries()].map(([unitId, answer]) => ({
          unitId,
          reviewer: batch.reviewer,
          answer,
        }))
      : [];
    const byId = new Map(assignments.map((item) => [item.id, item]));
    const repeats = [];
    for (const assignment of assignments.filter((item) => item.repeatOf !== null))
      repeats.push({
        unitId: assignment.unitId,
        first: await answerOf(root, population, batch, byId.get(assignment.repeatOf!)!),
        repeat: await answerOf(root, population, batch, assignment),
      });
    const group = frozen.group;
    const firstExpert = group ? await firstAnswers(root, population, group.first) : null;
    const experts = group
      ? summarizeExperts(population, {
          pairId: group.pair.id,
          first: {
            batchId: group.first.batch.id,
            reviewer: group.first.batch.reviewer,
            answered: group.first.progress.answered,
            assigned: group.first.progress.assigned,
            answers: firstExpert!,
          },
          second: {
            batchId: group.second.batch.id,
            reviewer: group.second.batch.reviewer,
            answered: group.second.progress.answered,
            assigned: group.second.progress.assigned,
            answers: await firstAnswers(root, population, group.second),
          },
          roundTwo: group.roundTwo
            ? {
                firstBatchId: group.roundTwo.first.batch.id,
                secondBatchId: group.roundTwo.second.batch.id,
                unitIds: group.roundTwo.unitIds,
                first: await firstAnswers(root, population, group.roundTwo.first),
                second: await firstAnswers(root, population, group.roundTwo.second),
              }
            : null,
          unitIds: [...firstExpert!.keys()],
          random,
        })
      : null;
    const share = (pair: string) =>
      experts?.agreements.find((item) => item.pair === pair)?.candidateAcceptance ?? null;
    const judgeOwn =
      counted && !experts
        ? compareRaters(population, {
            pair: "judge_first",
            raters: [
              { kind: "automatic", id: null },
              { kind: "human", id: batch.reviewer },
            ],
            unitIds: [...own.keys()],
            labels: [
              automaticLabels(population),
              new Map([...own.entries()].map(([unitId, answer]) => [unitId, answerLabel(answer)])),
            ],
            random,
          }).candidateAcceptance
        : null;
    const body: Omit<AuditReport, "id"> = {
      batchId,
      populationId: population.id,
      purpose: batch.purpose,
      sampling:
        batch.purpose === "audit"
          ? "uniform_without_replacement"
          : batch.purpose === "diagnostic"
            ? "targeted"
            : batch.purpose === "training"
              ? "training"
              : "registered_protocol",
      progress,
      plannedOutcomes: population.plannedOutcomes,
      sourcePlannedOutcomes: population.sourcePlannedOutcomes,
      eligible: population.units.length,
      exclusions: population.exclusions,
      treatments: population.treatments.map((treatment) => {
        const units = population.units.filter(
          (unit) =>
            (unit.automaticDecision?.operationId ?? unit.operationId) === treatment.operationId &&
            unit.treatmentId === (treatment.treatment?.id ?? null),
        );
        const ids = new Set(units.map((unit) => unit.id));
        const selected = observations.filter((item) => ids.has(item.unitId));
        const { acceptance, reliability } = summarizeAudit(
          { ...population, units, plannedOutcomes: treatment.plannedOutcomes },
          selected,
          batch.purpose,
        );
        return {
          ...treatment,
          eligible: units.length,
          excluded: population.exclusions.filter(
            (item) =>
              item.operationId === treatment.operationId &&
              item.treatmentId === (treatment.treatment?.id ?? null),
          ).length,
          reused: assignments.filter((a) => a.reusedFrom !== null && ids.has(a.unitId)).length,
          acceptance,
          reliability,
        };
      }),
      decisions: population.units.map(({ id: unitId, treatmentId, automaticDecision }) => ({
        unitId,
        treatmentId,
        automaticDecision,
      })),
      ...summarizeAudit(population, observations, batch.purpose),
      answerIds: assignments.flatMap((item) => (item.answerId ? [item.answerId] : [])),
      evidence: assignments.map((assignment) => {
        const { unit, item, pass } = reviewBinding(population, assignment.unitId);
        return {
          operationId: unit.operationId,
          candidateId: item.subjectId,
          criterionId: unit.criterionId,
          pass: pass.number,
          answered: assignment.answerId !== null,
          repeat: assignment.repeatOf !== null,
        };
      }),
      repeats: repeatAgreement(repeats),
      experts,
      gate: agreementGate({
        applicable: random,
        judgeFirst: experts ? share("judge_first") : judgeOwn,
        judgeSecond: share("judge_second"),
        experts: share("first_second"),
      }),
      claim:
        batch.purpose === "training"
          ? "Training answers use separate questions. They never count in an agreement."
          : batch.expert?.round === 2
            ? "Round 2 answers are not independent. They resolve or keep each disagreement. They never count in an agreement."
            : batch.purpose === "audit"
              ? "These estimates describe only the checks in this sample. Sampled questions without a clear answer stay in the ranges. They do not show that a build is acceptable or that future runs and game mechanics are reliable. They do not measure the calibration of the judge."
              : "These findings describe only the selected questions. They do not measure the overall accuracy or calibration of the judge.",
    };
    const report = { ...body, id: hashJson(body) };
    await saveReviewArtifact(root, "reports", report);
    journal.put("review_reports", batchId, { id: report.id });
    return report;
  } finally {
    journal.close();
  }
}
