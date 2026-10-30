import type { AssessmentProgress } from "../../contracts/src/assessments.js";
import type { AuthoringProgress, RunOperationManifest } from "../../contracts/src/execution.js";
import { operationInputHash } from "./operation-binding.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { reconcileSavedModelBilling } from "../../model-client/src/recovery.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { assertOperationOwnerStopped } from "./process-owner.js";

import { OperationJournal } from "../../artifact-store/src/journal.js";

export async function reconcileOperationBilling(
  root: string,
  operationId: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId))
    throw new Error("Invalid operation identity");
  await assertOperationOwnerStopped(root, operationId);
  const journal = await OperationJournal.open(root);
  let draftId: string;
  try {
    const assessment =
      journal.read<AssessmentProgress>("assessment_progress", operationId) ??
      journal.read<AssessmentProgress>("comparison_progress", operationId);
    if (assessment) {
      draftId = assessment.previewId;
    } else if (journal.read("operation_progress", operationId)) {
      const manifest = await new RepositoryFiles(root).json<RunOperationManifest>(
        `.basalt-evals/eval-operations/${operationId}/manifest.json`,
      );
      if (manifest.id !== operationId) throw new Error("Operation identity changed");
      draftId = manifest.inputHash;
    } else {
      const authoring = journal.read<AuthoringProgress>("authoring_progress", operationId);
      if (!authoring || authoring.action.operationId !== operationId)
        throw new Error("No saved operation");
      draftId = authoring.action.draftId;
    }
  } finally {
    journal.close();
  }
  const ledger = new DurableSpendLedger(
    root,
    operationId,
    hashJson({ inputHash: await operationInputHash(root, operationId, draftId) }),
  );
  return reconcileSavedModelBilling(ledger, (generationId) => adapters.billing(generationId));
}
