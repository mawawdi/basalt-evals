import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hash } from "../../contracts/src/validation.js";
import type { HoldoutAccess, HoldoutLook } from "../../contracts/src/comparisons.js";

/** Call inside the journal transaction that admits the look. */
export function recordHoldoutLook(
  journal: OperationJournal,
  evaluationId: string,
  look: HoldoutLook,
): void {
  const current = journal.read<HoldoutAccess>("holdout_access", evaluationId);
  const access: HoldoutAccess = {
    evaluationId,
    looks: [...(current?.looks ?? []), look],
  };
  journal.put("holdout_access", evaluationId, access);
}

/** Every recorded look at the withheld material of one evaluation. */
export async function readHoldoutAccess(
  root: string,
  evaluationId: string,
): Promise<HoldoutAccess> {
  hash(evaluationId, "evaluation identity");
  const journal = await OperationJournal.open(root);
  try {
    return (
      journal.read<HoldoutAccess>("holdout_access", evaluationId) ?? { evaluationId, looks: [] }
    );
  } finally {
    journal.close();
  }
}
