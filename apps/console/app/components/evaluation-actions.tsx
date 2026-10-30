"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { action, message } from "./api";
import { Dialog, Notice } from "./ui";
import s from "./workbench.module.css";

export function EvaluationActions({
  evaluationId,
  archived,
}: {
  evaluationId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function archive() {
    setBusy(true);
    setError("");
    try {
      await action(`/api/evaluations/${evaluationId}/archive`, "archive_evaluation", {
        archived: !archived,
      });
      setDialog(null);
      router.refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await action(`/api/evaluations/${evaluationId}/delete`, "delete_evaluation", {});
      router.push("/evaluations");
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  }
  const close = () => {
    if (busy) return;
    setDialog(null);
    setError("");
  };
  return (
    <>
      {!archived && (
        <Link className={s.secondary} href={`/evaluations/new?evaluation=${evaluationId}`}>
          Edit evaluation
        </Link>
      )}
      <details>
        <summary>More actions</summary>
        <div className={s.row}>
          <Link className={s.textButton} href={`/evaluations/new?duplicate=${evaluationId}`}>
            Duplicate
          </Link>
          <button className={s.textButton} onClick={() => setDialog("archive")}>
            {archived ? "Restore evaluation" : "Archive evaluation"}
          </button>
          <button className={s.textButton} onClick={() => setDialog("delete")}>
            Delete evaluation
          </button>
        </div>
      </details>
      <Dialog
        open={dialog === "archive"}
        onClose={close}
        title={archived ? "Restore evaluation?" : "Archive evaluation?"}
      >
        <p>
          {archived
            ? "This evaluation will be back in your library and available for new runs."
            : "Archiving hides this evaluation from the library and from new runs. Saved setups, runs and suites keep their exact inputs, and you can restore it from the Archived filter."}
        </p>
        {error && <Notice>{error}</Notice>}
        <div className={s.row}>
          <button className={s.primary} disabled={busy} onClick={() => void archive()}>
            {busy ? "Saving…" : archived ? "Restore evaluation" : "Archive evaluation"}
          </button>
          <button className={s.secondary} disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Dialog open={dialog === "delete"} onClose={close} title="Delete evaluation?">
        <p>
          This permanently removes the evaluation and its unsaved edits from the library. You cannot
          undo this action.
        </p>
        <p>
          You cannot delete this evaluation if a run, suite, saved example or anchor build uses it.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className={s.row}>
          <button className={s.primary} disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete evaluation"}
          </button>
          <button className={s.secondary} disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
    </>
  );
}
