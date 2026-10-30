import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { EvaluationLibraryEntry, EvaluationSummary } from "../../contracts/src/catalog.js";
import { projectLibraryEntry } from "./library.js";
import { hashJson } from "../../contracts/src/index.js";

export async function projectEvaluation(root: string, row: EvaluationSummary) {
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const current = journal.read<EvaluationSummary>("catalog_evaluations", row.id);
      // Reusing compilation must not erase separately established reference evidence.
      const value =
        current?.validationRecordHash &&
        (!row.validationRecordHash ||
          (current.readiness === "checked" && row.readiness === "ready"))
          ? {
              ...row,
              readiness: current.readiness,
              validationRecordHash: current.validationRecordHash,
              reason: current.reason,
            }
          : row;
      if (current && hashJson({ ...value, updatedAt: current.updatedAt }) === hashJson(current))
        return;
      journal.put("catalog_evaluations", row.id, value);
      if (row.kind === "evaluation")
        journal.put("evaluation_prepared_drafts", row.draftId, { revisionId: row.id });
      const members = journal.read<string[]>("evaluation_draft_members", row.draftId) ?? [];
      for (const id of members) {
        const entry = journal.read<EvaluationLibraryEntry>("evaluation_library", id);
        if (!entry || entry.draftId !== row.draftId) continue;
        // A delayed draft write or old preparation can never replace newer authored inputs.
        if (row.kind === "draft" && entry.revisionId) continue;
        const next = {
          ...entry,
          revisionId: row.kind === "evaluation" ? row.id : null,
          updatedAt: value.updatedAt,
        };
        journal.put("evaluation_library", id, next);
        projectLibraryEntry(journal, next);
      }
    });
  } finally {
    journal.close();
  }
}
export async function projectRegisteredEvaluation(
  root: string,
  id: string,
  validationRecordHash: string,
  referenceChecked: boolean,
) {
  const journal = await OperationJournal.open(root);
  let row: EvaluationSummary | null;
  try {
    row = journal.read<EvaluationSummary>("catalog_evaluations", id);
  } finally {
    journal.close();
  }
  if (!row) throw new Error("Evaluation catalog row is missing at registration");
  await projectEvaluation(root, {
    ...row,
    readiness: referenceChecked ? "checked" : "ready",
    validationRecordHash,
    reason: null,
    updatedAt: new Date().toISOString(),
  });
}
