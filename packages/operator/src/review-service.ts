import { answerReviewQuestion, type ReviewDraftInput } from "./review-session.js";
import { requireBatch } from "./review-store.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { frozenRunStatus } from "./run-builder.js";
import { experimentReviewReady } from "./experiment-controller.js";
import { continueSavedOperation } from "./service.js";

/** Only registered protocol answers can release a research gate. Ordinary reviews make no paid calls. */
export async function submitOperationReview(
  root: string,
  batchId: string,
  assignmentId: string,
  value: ReviewDraftInput,
  workerModule?: string,
) {
  const saved = await answerReviewQuestion(root, batchId, assignmentId, value);
  const journal = await OperationJournal.open(root);
  let batch;
  try {
    batch = requireBatch(journal, batchId);
  } finally {
    journal.close();
  }
  if (batch.purpose === "protocol" && saved.progress.state === "completed")
    for (const operationId of batch.operationIds) {
      const status = await frozenRunStatus(root, operationId, false);
      if (
        status.manifest.protocol &&
        !status.finished &&
        !status.stopped &&
        (await experimentReviewReady(root, operationId))
      )
        await continueSavedOperation(root, operationId, workerModule);
    }
  return saved;
}
