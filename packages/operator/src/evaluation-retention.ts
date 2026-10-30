import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type {
  EvaluationLibraryEntry,
  EvaluationSummary,
  RunSummary,
} from "../../contracts/src/catalog.js";
import type { RunStart } from "../../contracts/src/execution.js";
import type { EvaluationSuite } from "../../contracts/src/suites.js";
import type { WorkingCopy } from "../../contracts/src/working-copy.js";
import { evaluationIdentity } from "../../eval-authoring/src/library.js";
import { RunRetentionConflict } from "./run-retention.js";

/** The authored snapshots of one library entry: its current draft and each prepared revision. */
function snapshots(journal: OperationJournal, entry: EvaluationLibraryEntry) {
  const ids = new Set([entry.draftId, ...(entry.revisionId ? [entry.revisionId] : [])]);
  for (const reference of journal.recordsContaining(entry.draftId, 1000))
    if (
      reference.namespace === "catalog_evaluations" &&
      journal.read<EvaluationSummary>("catalog_evaluations", reference.id)?.draftId ===
        entry.draftId
    )
      ids.add(reference.id);
  return [...ids];
}

/** Runs that only a saved quote binds to an evaluation, before the run has a frozen plan. */
async function quotedRuns(root: string) {
  const journal = await OperationJournal.open(root);
  const starts: Array<{ id: string; quoteId: string }> = [];
  try {
    let after = "";
    for (;;) {
      const page = journal.recordPage("run_starts", after);
      if (!page.length) break;
      for (const row of page)
        if (!journal.read("operations", row.id))
          starts.push({ id: row.id, quoteId: (row.value as RunStart).request.quoteId });
      after = page.at(-1)!.id;
    }
  } finally {
    journal.close();
  }
  const files = new RepositoryFiles(root);
  return Promise.all(
    starts.map(async (start) => ({
      id: start.id,
      text: await files
        .bytes(`.basalt-evals/eval-run-quotes/${start.quoteId}.json`)
        .then((bytes) => bytes.toString("utf8"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        }),
    })),
  );
}

/**
 * Remove one library entry. Its immutable authored snapshots stay, because other entries and
 * saved records can share them. Refuse while a run, a suite, a saved example or an anchor build
 * choice uses the snapshots and no other library entry keeps them.
 */
export async function deleteEvaluation(root: string, id: string) {
  evaluationIdentity(id);
  const quoted = await quotedRuns(root);
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const entry = journal.read<EvaluationLibraryEntry>("evaluation_library", id);
      if (!entry) throw new Error("Basalt cannot find this evaluation.");
      const title =
        journal.read<EvaluationSummary>("catalog_evaluations", entry.revisionId ?? entry.draftId)
          ?.title ?? "Evaluation";
      const members = journal.read<string[]>("evaluation_draft_members", entry.draftId) ?? [];
      const others = members.filter((member) => member !== id);
      if (!others.length) {
        const runs = new Map<string, string>(),
          other = new Map<string, string>();
        const suites = new Map<string, string>();
        let after = "";
        for (;;) {
          const page = journal.recordPage("suites", after);
          if (!page.length) break;
          for (const row of page) {
            const suite = row.value as EvaluationSuite;
            suites.set(suite.snapshotId, suite.title);
          }
          after = page.at(-1)!.id;
        }
        for (const snapshot of snapshots(journal, entry)) {
          for (const reference of journal.recordsContaining(snapshot, 1000)) {
            const run = journal.read<RunSummary>("catalog_runs", reference.id.split(":")[0]!);
            if (run) runs.set(run.id, `run "${run.title}" (${run.id})`);
            else if (reference.namespace === "suite_snapshots" && suites.has(reference.id))
              other.set(`suite:${reference.id}`, `suite "${suites.get(reference.id)}"`);
            else if (reference.namespace === "regressions")
              other.set(
                `regression:${reference.id}`,
                `saved example "${journal.read<{ title: string }>("regressions", reference.id)?.title ?? reference.id.slice(0, 12)}"`,
              );
            else if (reference.namespace === "exemplar_choices")
              other.set(
                `exemplar:${reference.id}`,
                `anchor build choice ${reference.id.slice(0, 12)}`,
              );
          }
          for (const start of quoted)
            if (start.text.includes(snapshot)) {
              const title = journal.read<RunSummary>("catalog_runs", start.id)?.title ?? "Run";
              runs.set(start.id, `run "${title}" (${start.id})`);
            }
        }
        if (runs.size || other.size)
          throw new RunRetentionConflict(
            [
              `Saved work uses this evaluation: ${[...runs.values(), ...other.values()].join("; ")}.`,
              runs.size ? "To delete the evaluation, delete these runs first." : "",
              "Archive the evaluation to remove it from the library.",
            ]
              .filter(Boolean)
              .join(" "),
          );
      }
      journal.remove("evaluation_library", id);
      journal.removeProjection("evaluations", id);
      if (others.length) journal.put("evaluation_draft_members", entry.draftId, others);
      else journal.remove("evaluation_draft_members", entry.draftId);
      for (const reference of journal.recordsContaining(`"${id}"`, 1000))
        if (
          reference.namespace === "working_copies" &&
          journal.read<WorkingCopy>("working_copies", reference.id)?.evaluationId === id
        )
          journal.remove("working_copies", reference.id);
      return { evaluationId: id, title, deletedAt: new Date().toISOString() };
    });
  } finally {
    journal.close();
  }
}
