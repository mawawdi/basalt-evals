import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson, validRubricScore } from "../../contracts/src/index.js";
import {
  REVIEW_SESSION_LIMITS,
  reviewReasonProblem,
  type ReviewAnswer,
  type ReviewAssignment,
  type ReviewBatch,
  type ReviewCriterion,
  type ReviewDecision,
  type ReviewPair,
  type ReviewPopulation,
  type ReviewPreview,
  type ReviewProgress,
  type ReviewReason,
  type ReviewVerdict,
  type EvidenceItem,
  type EvidencePass,
} from "../../contracts/src/review.js";

export class ReviewConflict extends Error {}
function reviewId(id: string): void {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid review identity");
}
export async function saveReviewArtifact(root: string, kind: string, value: { id: string }) {
  reviewId(value.id);
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/review-batches/${kind}/${value.id}.json`;
  try {
    await files.writeJson(path, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(value))
      throw new Error("Immutable review artifact changed");
  }
}
export async function readReviewArtifact<T extends { id: string }>(
  root: string,
  kind: string,
  id: string,
): Promise<T> {
  reviewId(id);
  const value = await new RepositoryFiles(root).json<T>(
    `.basalt-evals/review-batches/${kind}/${id}.json`,
  );
  const { id: saved, ...body } = value;
  if (saved !== id || hashJson(body) !== id) throw new Error("Immutable review artifact changed");
  return value;
}
export const readReviewPopulation = (root: string, id: string) =>
  readReviewArtifact<ReviewPopulation>(root, "populations", id);
export const readReviewPreview = (root: string, id: string) =>
  readReviewArtifact<ReviewPreview>(root, "previews", id);
export const readReviewAnswer = (root: string, id: string) =>
  readReviewArtifact<ReviewAnswer>(root, "answers", id);

export function requireBatch(journal: OperationJournal, id: string): ReviewBatch {
  reviewId(id);
  const batch = journal.read<ReviewBatch>("review_batches", id);
  if (!batch || batch.id !== id) throw new Error("Basalt cannot find this review.");
  return batch;
}
export function requireAssignment(
  journal: OperationJournal,
  batch: ReviewBatch,
  id: string,
): ReviewAssignment {
  if (!batch.assignmentIds.includes(id)) throw new Error("Question is not assigned in this batch");
  const assignment = journal.read<ReviewAssignment>("review_assignments", id);
  if (!assignment || assignment.batchId !== batch.id || assignment.reviewer !== batch.reviewer)
    throw new Error("Question ownership changed");
  return assignment;
}
export function decisionVerdict(
  criterion: ReviewCriterion,
  decision: ReviewDecision,
): ReviewVerdict {
  if (!decision || typeof decision !== "object" || Array.isArray(decision))
    throw new Error("Choose an answer or Cannot tell.");
  const keys = Object.keys(decision).sort().join(",");
  if (decision.kind === "abstain" && keys === "kind") return "insufficient";
  if (keys !== "kind,value") throw new Error("Invalid answer fields");
  if (criterion.anchors !== null || criterion.scoreRange !== null) {
    if (
      decision.kind !== "score" ||
      !validRubricScore(
        { anchors: criterion.anchors ?? [], scoreRange: criterion.scoreRange },
        decision.value,
      )
    )
      throw new Error("Choose a score on the scale of this criterion.");
    return criterion.minimumPassingScore === null
      ? "scored"
      : decision.value >= criterion.minimumPassingScore
        ? "satisfied"
        : "violated";
  }
  if (decision.kind !== "categorical" || !["satisfied", "violated"].includes(decision.value))
    throw new Error("Choose one of the two answers or Cannot tell.");
  return decision.value;
}
export function reviewEvidenceBinding(
  item: EvidenceItem,
  pass: EvidencePass,
  criterion: ReviewCriterion,
) {
  return hashJson({
    criterion,
    rubricHash: item.rubricHash,
    sources: item.sources.map(({ path, hash }) => ({ path, hash })),
    evidenceHash: pass.evidenceHash,
    observations: pass.observations,
    images: pass.images.map(({ hash, mediaType, context, startedAt, endedAt }) => ({
      hash,
      mediaType,
      context,
      startedAt,
      endedAt,
    })),
  });
}
export function reviewBinding(population: ReviewPopulation, unitId: string) {
  const unit = population.units.find((unit) => unit.id === unitId);
  const evidence = population.evidence.find(
    (evidence) => evidence.operationId === unit?.operationId,
  );
  const item = evidence?.items.find((item) => item.id === unit?.itemId);
  const pass = item?.passes.find((pass) => pass.id === unit?.passId);
  const criterion = item?.criteria.find((criterion) => criterion.id === unit?.criterionId);
  if (
    !unit ||
    !evidence ||
    !item ||
    !pass ||
    !criterion ||
    unit.binding !== reviewEvidenceBinding(item, pass, criterion)
  )
    throw new Error("Question is not bound to its original rubric, source and evidence");
  return { unit, evidence, item, pass, criterion };
}
/** A saved answer needs a reason that fits its decision. */
export function requireReviewReason(decision: ReviewDecision, reason: unknown): ReviewReason {
  const problem = reviewReasonProblem(decision, reason);
  if (problem) throw new Error(problem);
  return reason as ReviewReason;
}
export function readReviewPair(journal: OperationJournal, pairId: string): ReviewPair | null {
  const pair = journal.read<ReviewPair>("review_pairs", pairId);
  return pair && pair.id === pairId ? pair : null;
}
export function reviewProgress(journal: OperationJournal, batch: ReviewBatch): ReviewProgress {
  const assignments = batch.assignmentIds.map((id) => requireAssignment(journal, batch, id));
  const answered = assignments.filter((item) => item.answerId !== null);
  const progress: ReviewProgress = {
    id: batch.id,
    reviewer: batch.reviewer,
    purpose: batch.purpose,
    state: batch.state,
    assigned: assignments.length,
    answered: answered.length,
    abstained: answered.filter((item) => item.submittedVerdict === "insufficient").length,
    reused: answered.filter((item) => item.reusedFrom !== null).length,
    remaining: assignments.length - answered.length,
    repeats: assignments.filter((item) => item.repeatOf !== null).length,
    activeMs: batch.sessions.reduce((sum, session) => sum + session.activeMs, 0),
    session: batch.sessions.at(-1) ?? null,
    sessionLimits: { ...REVIEW_SESSION_LIMITS },
    expert: batch.expert,
    createdAt: batch.createdAt,
    nextAssignmentId: assignments.find((item) => item.answerId === null)?.id ?? null,
  };
  return progress;
}
export function projectReviewProgress(
  journal: OperationJournal,
  batch: ReviewBatch,
): ReviewProgress {
  const progress = reviewProgress(journal, batch);
  journal.project("review_progress", batch.id, {
    search: `${batch.purpose} ${batch.reviewer} ${batch.operationIds.join(" ")} ${batch.operationIds
      .map(
        (id) =>
          journal.read<{ evaluationId: string | null }>("catalog_runs", id)?.evaluationId ?? "",
      )
      .join(" ")}`,
    status: batch.purpose,
    sort: batch.createdAt,
    body: progress,
  });
  journal.put("review_progress_snapshot", batch.id, progress);
  return progress;
}

/** Protocol consumption is purpose-scoped. Optional audits cannot satisfy a research gate. */
export async function operationReviews(
  root: string,
  operationId: string,
  manifestHash: string,
  recordIds?: readonly string[],
) {
  const journal = await OperationJournal.open(root);
  try {
    const refs =
      journal.read<Array<{ answerId: string; populationId: string; unitId: string }>>(
        "protocol_answers",
        operationId,
      ) ?? [];
    const result = [];
    const populations = new Map<string, ReviewPopulation>();
    const batches = new Map<string, ReviewBatch>();
    const selected = recordIds ? new Set(recordIds) : null;
    for (const ref of refs) {
      // A frozen gate consumes its exact answers, never unrelated later labels.
      // Selected records still undergo all immutable binding and release checks.
      if (selected && !selected.has(ref.answerId)) continue;
      const record = await readReviewAnswer(root, ref.answerId);
      let population = populations.get(ref.populationId);
      if (!population) {
        population = await readReviewPopulation(root, ref.populationId);
        populations.set(ref.populationId, population);
      }
      const binding = reviewBinding(population, ref.unitId);
      const batch = batches.get(record.batchId) ?? requireBatch(journal, record.batchId);
      batches.set(batch.id, batch);
      const assignment = requireAssignment(journal, batch, record.assignmentId);
      const release = await readReviewArtifact<{
        id: string;
        batchId: string;
        unitId: string;
        binding: string;
      }>(root, "releases", assignment.releaseHash);
      if (
        record.purpose !== "protocol" ||
        batch.purpose !== "protocol" ||
        record.repeatOf !== null ||
        record.peerAnswerId !== null ||
        record.binding !== binding.unit.binding ||
        binding.unit.operationId !== operationId ||
        binding.unit.manifestHash !== manifestHash ||
        record.reviewer !== batch.reviewer ||
        release.unitId !== binding.unit.id ||
        release.batchId !== batch.id ||
        release.binding !== record.binding ||
        decisionVerdict(binding.criterion, record.decision) !== record.verdict
      )
        throw new Error("Protocol answer lost its immutable binding or release");
      result.push({ record, ...binding });
    }
    return result;
  } finally {
    journal.close();
  }
}

/** A single expert's decisions only. Different experts must never become manufactured consensus. */
export function consolidatedReviewLabels(
  records: Awaited<ReturnType<typeof operationReviews>>,
  reviewer: string,
) {
  const decisions = new Map<
    string,
    {
      criterionId: string;
      verdict: "satisfied" | "violated" | "insufficient";
      recordId: string;
      blindingIssue: string | null;
    }
  >();
  for (const { record, unit, item } of records.filter(({ record }) => record.reviewer === reviewer))
    decisions.set(`${item.rubricHash}:${unit.passId}:${unit.criterionId}`, {
      criterionId: unit.criterionId,
      verdict: record.verdict === "scored" ? "insufficient" : record.verdict,
      recordId: record.id,
      blindingIssue: record.blindingIssue,
    });
  return decisions;
}
