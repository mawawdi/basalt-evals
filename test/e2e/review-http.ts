import { randomUUID } from "node:crypto";
import { OperationJournal } from "../../packages/artifact-store/src/journal.js";
import {
  readReviewPopulation,
  requireAssignment,
  requireBatch,
  reviewBinding,
} from "../../packages/operator/src/review-store.js";
import type {
  BlindReviewProgress,
  BlindReviewQuestion,
  ReviewDecision,
  ReviewPreview,
  ReviewProgress,
  ReviewReason,
} from "../../packages/contracts/src/review.js";

type Request = (
  path: string,
  action?: string,
  value?: unknown,
  expected?: number,
) => Promise<unknown>;
/** A fixed reason that fits the decision. Every saved answer needs one. */
function syntheticReason(decision: ReviewDecision): ReviewReason {
  return decision.kind === "abstain"
    ? { code: "evidence_unclear", sentence: "The shown evidence does not settle the criterion." }
    : { code: "other", sentence: "The synthetic reviewer answers from the shown evidence." };
}
/** Test oracle stays outside blind HTTP responses. Actual questions and answers use HTTP. */
export async function reviewAvailable(input: {
  request: Request;
  root: string;
  operationId: string;
  purpose?: "audit" | "protocol";
  reviewerId?: string;
  /** An existing batch, for example of a second reviewer or of round 2. */
  batch?: ReviewProgress;
  decide?: (
    question: BlindReviewQuestion,
    binding: ReturnType<typeof reviewBinding>,
  ) => ReviewDecision;
  inspect?: (question: BlindReviewQuestion) => void;
}) {
  const { request, root, operationId } = input;
  let batch: ReviewProgress;
  if (input.batch) batch = input.batch;
  else if (input.purpose === "protocol") {
    const listing = (await request(`/api/review-batches?purpose=protocol&q=${operationId}`)) as {
      items: ReviewProgress[];
    };
    if (!listing.items[0])
      throw new Error("Owned experiment driver did not assign its registered review");
    batch = listing.items[0];
  } else {
    const reviewer = input.reviewerId
      ? { id: input.reviewerId }
      : ((await request(
          "/api/reviewers",
          "create_reviewer",
          { displayName: "Synthetic reviewer" },
          201,
        )) as { id: string });
    const preview = (await request(
      "/api/review-batches/preview",
      "preview_review_batch",
      {
        purpose: "audit",
        operationIds: [operationId],
        reviewer: reviewer.id,
        questionLimit: 40,
        unitIds: [],
        treatments: [],
      },
      201,
    )) as ReviewPreview;
    batch = (await request(
      "/api/review-batches/create",
      "create_review_batch",
      { previewId: preview.id, idempotencyKey: randomUUID() },
      201,
    )) as ReviewProgress;
  }
  const journal = await OperationJournal.open(root);
  const saved = requireBatch(journal, batch.id);
  const assignments = saved.assignmentIds.map((id) => requireAssignment(journal, saved, id));
  journal.close();
  const population = await readReviewPopulation(root, saved.populationId);
  const sessionId = randomUUID();
  const progress = (await request(
    `/api/reviews/${batch.id}?reviewer=${batch.reviewer}`,
  )) as BlindReviewProgress;
  const items = new Set(
    assignments.map((assignment) => reviewBinding(population, assignment.unitId).item.id),
  );
  for (const assigned of progress.questions.filter((question) => !question.answered)) {
    const question = (await request(
      `/api/reviews/${batch.id}/questions/${assigned.id}/claim`,
      "claim_review_question",
      { sessionId, reviewer: batch.reviewer },
    )) as BlindReviewQuestion;
    input.inspect?.(question);
    const binding = reviewBinding(
      population,
      assignments.find((item) => item.id === assigned.id)!.unitId,
    );
    const decision = input.decide?.(question, binding) ?? {
      kind: "categorical",
      value: "satisfied",
    };
    await request(
      `/api/reviews/${batch.id}/questions/${assigned.id}/answer`,
      "answer_review_question",
      {
        sessionId,
        reviewer: batch.reviewer,
        revision: question.draft.revision,
        decision,
        reason: syntheticReason(decision),
        blindingIssue: null,
      },
      201,
    );
  }
  return {
    batch,
    itemCount: items.size,
    progress: (await request(
      `/api/reviews/${batch.id}?reviewer=${batch.reviewer}`,
    )) as BlindReviewProgress,
  };
}
