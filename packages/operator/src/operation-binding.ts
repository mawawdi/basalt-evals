import type { EvaluationWorkflow, SpendAuthorization } from "../../contracts/src/execution.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";

import { DurableSpendLedger } from "../../model-client/src/ledger.js";

/** Input amendments share one budget identity but retain separately bound preparation evidence. */
export async function operationInputHash(root: string, id: string, draftId: string) {
  const journal = await OperationJournal.open(root);
  try {
    const workflow = journal.read<EvaluationWorkflow>("workflows", id);
    if (!workflow) return draftId;
    if (!workflow.draftIds.includes(draftId) && draftId !== workflow.inputHash)
      throw new Error("Input is not authorized in this workflow");
    return workflow.inputHash;
  } finally {
    journal.close();
  }
}
export function preparationPath(id: string, draftId: string) {
  return `.basalt-evals/eval-operations/${id}/preparations/${draftId}/receipt.json`;
}

export async function authorizePreparation(
  root: string,
  ledger: DurableSpendLedger,
  authorization: SpendAuthorization,
) {
  const journal = await OperationJournal.open(root);
  let exists: boolean;
  try {
    exists = journal.read("spending", ledger.operationId) !== null;
  } finally {
    journal.close();
  }
  if (!exists) {
    await ledger.initialize(authorization);
    return;
  }
  const state = await ledger.read();
  const retained = state.authorizations.find((item) => item.quoteHash === authorization.quoteHash);
  if (retained) {
    if (retained.ceilingUsd !== authorization.ceilingUsd)
      throw new Error("Preparation quote already has a different authorization");
    return;
  }
  await ledger.authorize(authorization);
}
