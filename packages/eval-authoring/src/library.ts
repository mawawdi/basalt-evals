import { randomUUID } from "node:crypto";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { EvaluationLibraryEntry, EvaluationSummary } from "../../contracts/src/catalog.js";
import { hash } from "../../contracts/src/validation.js";

export class EvaluationEditConflict extends Error {}

export function evaluationIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^eval-[a-z0-9-]{16,64}$/u.test(value))
    throw new Error("Invalid evaluation library identity");
  return value;
}

export function projectLibraryEntry(journal: OperationJournal, entry: EvaluationLibraryEntry) {
  const snapshot = journal.read<EvaluationSummary>(
    "catalog_evaluations",
    entry.revisionId ?? entry.draftId,
  );
  if (!snapshot || snapshot.draftId !== entry.draftId)
    throw new Error("Evaluation library snapshot is missing or changed");
  const summary: EvaluationSummary = {
    ...snapshot,
    evaluationId: entry.id,
    archived: entry.archived,
    updatedAt: entry.updatedAt,
  };
  journal.project("evaluations", entry.id, {
    search: `${summary.title} ${summary.description} ${entry.id} ${summary.id} ${entry.draftId}`,
    status: entry.archived ? "archived" : summary.readiness,
    sort: entry.updatedAt,
    body: summary,
  });
  return summary;
}

/** Update one library identity; immutable authored text and run bindings never change. */
export function saveLibraryDraft(
  journal: OperationJournal,
  input: { id: string; draftId: string; expectedDraftId: string | null },
): EvaluationLibraryEntry {
  evaluationIdentity(input.id);
  hash(input.draftId);
  const prior = journal.read<EvaluationLibraryEntry>("evaluation_library", input.id);
  if ((prior?.draftId ?? null) !== input.expectedDraftId)
    throw new EvaluationEditConflict(
      "Another editor saved a newer version of this evaluation. Basalt keeps your text. Open the current version, or apply your text to it.",
    );
  if (prior?.archived)
    throw new Error("This evaluation is in the archive. Restore it before you edit it.");
  if (prior?.draftId === input.draftId) return prior;
  const now = new Date().toISOString();
  const entry: EvaluationLibraryEntry = {
    id: input.id,
    draftId: input.draftId,
    revisionId:
      journal.read<{ revisionId: string }>("evaluation_prepared_drafts", input.draftId)
        ?.revisionId ?? null,
    archived: false,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  if (prior) {
    const owners = journal.read<string[]>("evaluation_draft_members", prior.draftId) ?? [];
    journal.put(
      "evaluation_draft_members",
      prior.draftId,
      owners.filter((id) => id !== prior.id),
    );
  }
  const members = journal.read<string[]>("evaluation_draft_members", input.draftId) ?? [];
  journal.put("evaluation_draft_members", input.draftId, [...new Set([...members, input.id])]);
  journal.put("evaluation_library", entry.id, entry);
  projectLibraryEntry(journal, entry);
  return entry;
}

export async function createLibraryEvaluation(root: string, draftId: string) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() =>
      saveLibraryDraft(journal, {
        id: "eval-" + randomUUID(),
        draftId,
        expectedDraftId: null,
      }),
    );
  } finally {
    journal.close();
  }
}

export async function readLibraryEvaluation(root: string, id: string) {
  evaluationIdentity(id);
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<EvaluationLibraryEntry>("evaluation_library", id);
  } finally {
    journal.close();
  }
}

export async function libraryEvaluationForDraft(root: string, draftId: string) {
  hash(draftId);
  const journal = await OperationJournal.open(root);
  try {
    const members = journal.read<string[]>("evaluation_draft_members", draftId) ?? [];
    // Identical deliberate copies have independent identities. Never choose one by guesswork.
    return members.length === 1
      ? journal.read<EvaluationLibraryEntry>("evaluation_library", members[0]!)
      : null;
  } finally {
    journal.close();
  }
}

export async function setEvaluationArchived(root: string, id: string, archived: boolean) {
  evaluationIdentity(id);
  if (typeof archived !== "boolean") throw new Error("Choose archive or restore");
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const entry = journal.read<EvaluationLibraryEntry>("evaluation_library", id);
      if (!entry) throw new Error("Basalt cannot find this evaluation.");
      const next = { ...entry, archived, updatedAt: new Date().toISOString() };
      journal.put("evaluation_library", id, next);
      projectLibraryEntry(journal, next);
      return next;
    });
  } finally {
    journal.close();
  }
}
