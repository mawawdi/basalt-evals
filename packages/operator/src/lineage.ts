import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { LineageSpending, OperationContext } from "../../contracts/src/launch.js";
import type { DeletedRun } from "../../contracts/src/catalog.js";

/** Unique ancestors count once, even when several paths share a paid parent. */
export function lineageSpending(journal: OperationJournal, operationId: string): LineageSpending {
  const seen = new Set<string>();
  const operations: LineageSpending["operations"] = [];
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("Operation lineage contains a cycle");
    if (seen.has(id)) return;
    if (seen.size >= 1000) throw new Error("Operation lineage exceeds its inspection bound");
    seen.add(id);
    const spending = journal.read<{ billedUsd: number; reservedUsd: number }>(
      "spending_progress",
      id,
    );
    // A deleted run keeps its permanent spending record. Delete refuses pending charges.
    const deleted = journal.read<DeletedRun>("deleted_runs", id);
    operations.push({
      operationId: id,
      billedUsd: deleted?.billedUsd ?? spending?.billedUsd ?? null,
      reservedUsd: deleted ? 0 : (spending?.reservedUsd ?? null),
      deleted: !!deleted,
    });
    const context = journal.read<OperationContext>("operation_context", id);
    for (const parent of context?.parentOperationIds ?? []) visit(parent, new Set([...path, id]));
  };
  visit(operationId, new Set());
  return {
    operations,
    billedUsd: operations.reduce((sum, item) => sum + (item.billedUsd ?? 0), 0),
    reservedUsd: operations.reduce((sum, item) => sum + (item.reservedUsd ?? 0), 0),
    unavailable: operations.filter((item) => item.billedUsd === null || item.reservedUsd === null)
      .length,
  };
}
