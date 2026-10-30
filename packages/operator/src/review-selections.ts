import type { ReviewSelectionView } from "../../contracts/src/console.js";
import { randomUUID } from "node:crypto";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { ReviewRunSelection } from "../../contracts/src/review.js";
import type { RunSummary } from "../../contracts/src/catalog.js";

/** Identifier-only snapshots: no evidence access, release, assignment or execution. */
export async function createReviewSelection(root: string, operationIds: string[]) {
  if (
    !Array.isArray(operationIds) ||
    operationIds.length > 1000 ||
    operationIds.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(id)) ||
    new Set(operationIds).size !== operationIds.length
  )
    throw new Error("Select 1,000 or fewer different runs.");
  const selection: ReviewRunSelection = {
    id: randomUUID(),
    operationIds: [...operationIds].sort(),
    createdAt: new Date().toISOString(),
  };
  const journal = await OperationJournal.open(root);
  try {
    journal.put("review_run_selections", selection.id, selection);
    return selection;
  } finally {
    journal.close();
  }
}
export async function readReviewSelection(
  root: string,
  id: string,
  params = new URLSearchParams(),
): Promise<ReviewSelectionView> {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/u.test(id))
    throw new Error("This run selection is not valid. Select Clear selection.");
  const journal = await OperationJournal.open(root);
  try {
    const selection = journal.read<ReviewRunSelection>("review_run_selections", id);
    if (!selection)
      throw new Error("Basalt cannot find this saved run selection. Select Clear selection.");
    const limit = Math.min(50, Math.max(1, Math.floor(Number(params.get("limit")) || 20)));
    const pages = Math.max(1, Math.ceil(selection.operationIds.length / limit));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get("page")) || 1)));
    return {
      ...selection,
      total: selection.operationIds.length,
      page,
      pages,
      limit,
      items: selection.operationIds.slice((page - 1) * limit, page * limit).map((operationId) => {
        const row = journal.read<RunSummary>("catalog_runs", operationId);
        return {
          operationId,
          title: row?.title ?? operationId,
          state: row?.state ?? "unavailable",
          unavailable: row
            ? null
            : "Basalt cannot find this run. Select Remove to take it out of the selection.",
        };
      }),
    };
  } finally {
    journal.close();
  }
}
