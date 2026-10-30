import { OperationJournal } from "../../artifact-store/src/journal.js";

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid operation owner process");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** An elapsed lease is never evidence that an owned process stopped. */
export async function assertOperationOwnerStopped(
  root: string,
  operationId: string,
): Promise<void> {
  const journal = await OperationJournal.open(root);
  try {
    const owner = journal.read<{ active: boolean; pid: number }>("drivers", operationId);
    if (owner?.active && processAlive(owner.pid))
      throw new Error("The run did not stop yet. Wait until it stops. Then try again.");
  } finally {
    journal.close();
  }
}
