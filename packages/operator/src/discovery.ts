import { OperationJournal } from "../../artifact-store/src/journal.js";
import type {
  EvaluationSummary,
  RunSummary,
  ResultSummary,
  Page,
  EvaluationLibraryEntry,
} from "../../contracts/src/catalog.js";
import { evaluationIdentity } from "../../eval-authoring/src/library.js";
import { readModelRegistry } from "./model-registry.js";
import { readHarnessRegistry } from "./config.js";
import { processAlive } from "./process-owner.js";
import { projectRun } from "./catalog-projection.js";
import { LISTED_RESULT_STATES, LISTED_RUN_STATES } from "./run-visibility.js";

/** Without a status filter, a list leaves out archived entries. The results of one run stay complete. */
const listed: Record<string, string[]> = {
  evaluations: ["draft", "needs_validation", "ready", "checked"],
  runs: LISTED_RUN_STATES,
  results: LISTED_RESULT_STATES,
};
async function page<T>(root: string, namespace: string, query: URLSearchParams): Promise<Page<T>> {
  const journal = await OperationJournal.open(root);
  const status = query.get("status") ?? "";
  try {
    return journal.page<T>(namespace, {
      q: query.get("q") ?? "",
      ...(namespace === "evaluations" && status === "runnable"
        ? { statuses: ["ready", "checked"] }
        : (!status || status === "all") && listed[namespace] && !query.has("operation")
          ? { statuses: listed[namespace] }
          : { status }),
      page: Number(query.get("page") ?? 1),
      limit: Number(query.get("limit") ?? 20),
      ...(query.has("operation") ? { operationId: query.get("operation")! } : {}),
    });
  } finally {
    journal.close();
  }
}
export const evaluationCatalog = (root: string, query = new URLSearchParams()) =>
  page<EvaluationSummary>(root, "evaluations", query);
export async function resultCatalog(root: string, query = new URLSearchParams()) {
  await refreshInterruptedRuns(root);
  return page<ResultSummary>(root, "results", query);
}
async function refreshInterruptedRuns(root: string) {
  const journal = await OperationJournal.open(root);
  try {
    // Only active projections need liveness checks, never historical artifacts.
    // Reclassify before filtering so stopped workers cannot disappear from the
    // attention filter or inflate the active count. Preserve their ownership data.
    journal.transaction(() => {
      const interrupted: string[] = [];
      let pages = 1;
      for (let number = 1; number <= pages; number++) {
        const active = journal.page<RunSummary>("runs", {
          status: "active",
          limit: 50,
          page: number,
        });
        pages = active.pages;
        for (const row of active.items) {
          const owner = journal.read<{ active: boolean; pid: number }>("drivers", row.id);
          if (owner?.active && !processAlive(owner.pid)) interrupted.push(row.id);
        }
      }
      for (const id of interrupted) {
        const owner = journal.read<{ active: boolean; pid: number }>("drivers", id)!;
        journal.put("drivers", id, {
          ...owner,
          error:
            "The Basalt worker stopped unexpectedly. Select Resume to continue. Basalt examines the saved requests and evidence first.",
        });
        projectRun(journal, id);
      }
    });
  } finally {
    journal.close();
  }
}
export async function runCatalog(root: string, query = new URLSearchParams()) {
  await refreshInterruptedRuns(root);
  return page<RunSummary>(root, "runs", query);
}
function summaryFromJournal(journal: OperationJournal, id: string): EvaluationSummary | null {
  if (id.startsWith("eval-")) {
    const entry = journal.read<EvaluationLibraryEntry>("evaluation_library", id);
    if (!entry) return null;
    const snapshot = journal.read<EvaluationSummary>(
      "catalog_evaluations",
      entry.revisionId ?? entry.draftId,
    );
    if (!snapshot || snapshot.draftId !== entry.draftId)
      throw new Error("Evaluation library snapshot is missing or changed");
    return {
      ...snapshot,
      evaluationId: id,
      archived: entry.archived,
      updatedAt: entry.updatedAt,
    };
  }
  const snapshot = journal.read<EvaluationSummary>("catalog_evaluations", id);
  if (!snapshot) return null;
  const members = journal.read<string[]>("evaluation_draft_members", snapshot.draftId) ?? [];
  const entry =
    members.length === 1
      ? journal.read<EvaluationLibraryEntry>("evaluation_library", members[0]!)
      : null;
  return entry && (entry.revisionId ?? entry.draftId) === id
    ? { ...snapshot, evaluationId: entry.id, archived: entry.archived }
    : snapshot;
}
export async function evaluationSummary(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/u.test(id)) evaluationIdentity(id);
  const journal = await OperationJournal.open(root);
  try {
    return summaryFromJournal(journal, id);
  } finally {
    journal.close();
  }
}
/** Compare selected immutable inputs to the library without rewriting the selection. */
export async function currentEvaluationSummaries(root: string, ids: string[]) {
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
    throw new Error("Choose 1 to 50 different evaluations.");
  ids.forEach(evaluationIdentity);
  const journal = await OperationJournal.open(root);
  try {
    return Object.fromEntries(ids.map((id) => [id, summaryFromJournal(journal, id)]));
  } finally {
    journal.close();
  }
}
/** Retain an explicit library identity only when it is bound to these exact authored inputs. */
export async function selectedEvaluationSummary(root: string, id: string, evaluationId?: string) {
  const snapshot = await evaluationSummary(root, id);
  if (!snapshot || !evaluationId) return snapshot;
  evaluationIdentity(evaluationId);
  const current = await evaluationSummary(root, evaluationId);
  if (!current || current.draftId !== snapshot.draftId)
    return { ...snapshot, evaluationId: null, archived: false };
  return { ...snapshot, evaluationId, archived: current.archived };
}
/** A bounded chooser. The library provides full server-side search. */
export async function launchCatalog(root: string, selectedId?: string) {
  const available = await evaluationCatalog(root, new URLSearchParams({ status: "runnable" }));
  const selected = selectedId ? await evaluationSummary(root, selectedId) : null;
  return {
    models: (await readModelRegistry(root)).models.map(({ id, name }) => ({ id, name })),
    harnesses: (await readHarnessRegistry(root)).harnesses,
    evals:
      selected && !available.items.some((item) => item.id === selected.id)
        ? [selected, ...available.items.slice(0, 19)]
        : available.items,
  };
}
