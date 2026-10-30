import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { money } from "../../contracts/src/validation.js";
import type { SpendLedgerState } from "../../contracts/src/execution.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { assertOperationOwnerStopped, processAlive } from "./process-owner.js";
import { savedLifecycle } from "./lifecycle.js";
import { workflowRecord, increaseWorkflowBudget } from "./workflow.js";

export async function increaseOperationBudget(root: string, id: string, ceilingUsd: number) {
  money(ceilingUsd);
  await assertOperationOwnerStopped(root, id);
  if (!(await savedLifecycle(root, id)).capabilities.budget.allowed)
    throw new Error("Basalt cannot change the spending limit of this run now.");
  if (await workflowRecord(root, id)) return increaseWorkflowBudget(root, id, { ceilingUsd });
  const journal = await OperationJournal.open(root);
  let state: SpendLedgerState | null;
  try {
    state = journal.read<SpendLedgerState>("spending", id);
  } finally {
    journal.close();
  }
  if (!state || ceilingUsd <= state.authorizations.at(-1)!.ceilingUsd)
    throw new Error("Choose a spending limit that is higher than the current limit.");
  const amendment = {
    operationId: id,
    previousAuthorization: hashJson(state.authorizations),
    ceilingUsd,
  };
  const amendmentHash = hashJson(amendment),
    files = new RepositoryFiles(root);
  const path = `.basalt-evals/eval-operations/${id}/budget-authorizations/${amendmentHash}.json`;
  await files.writeJsonOnce(path, amendment);
  const ledger = new DurableSpendLedger(root, id, state.contextHash);
  await ledger.authorize({ quoteHash: amendmentHash, ceilingUsd }, (current) => {
    const owner = current.read<{ active: boolean; pid: number }>("drivers", id);
    if (owner?.active && processAlive(owner.pid))
      throw new Error("Stop the run before you change its spending limit.");
    const next = current.read<SpendLedgerState>("spending", id)!;
    if (hashJson(next.authorizations) !== amendment.previousAuthorization)
      throw new Error("The spending limit changed while Basalt saved the new limit. Try again.");
  });
  return { operationId: id, ceilingUsd };
}
