import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { DeletedRun, RunSummary } from "../../contracts/src/catalog.js";

/** The journal record of an archived run. Restore removes it. */
export const RUN_ARCHIVE = "run_archive";
/** The tombstone and permanent spending record of a deleted run. */
export const DELETED_RUNS = "deleted_runs";

/** Default run lists show these states. An archived run has the list status "archived". */
export const LISTED_RUN_STATES: Array<RunSummary["state"]> = [
  "active",
  "attention",
  "stopped",
  "partial",
  "complete",
];
export const LISTED_RESULT_STATES = ["active", "complete", "incomplete"];

export function runArchived(journal: OperationJournal, id: string): boolean {
  return journal.read<{ archivedAt: string }>(RUN_ARCHIVE, id) !== null;
}

/** A deleted run never gets journal records again. Its identity stays used. */
export function assertRunNotDeleted(journal: OperationJournal, id: string): void {
  if (journal.read<DeletedRun>(DELETED_RUNS, id))
    throw new Error("A person deleted this run. Basalt cannot use its identity again.");
}

/** Check the tombstone before a run writes files under its identity. */
export async function assertRunIdentityFree(root: string, id: string): Promise<void> {
  const journal = await OperationJournal.open(root);
  try {
    assertRunNotDeleted(journal, id);
  } finally {
    journal.close();
  }
}

/** The status of a run row or a result row in the list projections. */
export function listStatus(journal: OperationJournal, id: string, state: string): string {
  return runArchived(journal, id) ? "archived" : state;
}
