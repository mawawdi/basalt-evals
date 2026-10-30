"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { action, message, request } from "./api";
import { Dialog, Notice } from "./ui";
import s from "./workbench.module.css";

/** Archive, restore, export and delete for one run. An active run shows no actions. */
export function RunActions({
  operationId,
  archived,
  settled,
  exportable = false,
}: {
  operationId: string;
  archived: boolean;
  /** No driver works and no work starts without a person: complete, stopped or interrupted. */
  settled: boolean;
  /** A benchmark run can be exported. */
  exportable?: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!settled && !archived) return null;
  async function archive() {
    setBusy(true);
    setError("");
    try {
      await action(`/api/operations/${operationId}/archive`, "archive_run", {
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
      await action(`/api/operations/${operationId}/delete`, "delete_run", {});
      router.push("/?view=activity");
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
      <details>
        <summary>Run actions</summary>
        <div className={s.row}>
          <button className={s.textButton} onClick={() => setDialog("archive")}>
            {archived ? "Restore run" : "Archive run"}
          </button>
          {exportable && settled && (
            <ExportAction
              href={`/api/operations/${operationId}/export`}
              subject="run"
              buttonClass={s.textButton}
            />
          )}
          <button className={s.textButton} onClick={() => setDialog("delete")}>
            Delete run
          </button>
        </div>
      </details>
      <Dialog
        open={dialog === "archive"}
        onClose={close}
        title={archived ? "Restore run?" : "Archive run?"}
      >
        <p>
          {archived
            ? "The run will show in Benchmarks, Records, notifications and comparison choices again."
            : "Archive removes this run from Benchmarks, Records, notifications and comparison choices. Its results, evidence and charges stay on this page. You can restore the run from the Archived filter in Records."}
        </p>
        {error && <Notice>{error}</Notice>}
        <div className={s.row}>
          <button className={s.primary} disabled={busy} onClick={() => void archive()}>
            {busy ? "Saving…" : archived ? "Restore run" : "Archive run"}
          </button>
          <button className={s.secondary} disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Dialog open={dialog === "delete"} onClose={close} title="Delete run?">
        <p>
          This permanently removes the run’s results, evidence, builds and activity, and any saved
          previews that no other run uses.
        </p>
        <p>
          You cannot undo this action. Basalt keeps the run’s title and charges so that spending
          totals stay correct.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className={s.row}>
          <button className={s.primary} disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete run"}
          </button>
          <button className={s.secondary} disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Dialog>
    </>
  );
}

/** Archive or restore from a run list. Archive is reversible, so the row acts at once. */
export function RunArchiveButton({
  operationId,
  title,
  archived,
}: {
  operationId: string;
  title: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label = archived ? "Restore" : "Archive";
  return (
    <>
      <button
        className={s.secondary}
        disabled={busy}
        aria-label={`${label}: ${title}`}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await action(`/api/operations/${operationId}/archive`, "archive_run", {
              archived: !archived,
            });
            router.refresh();
          } catch (cause) {
            setError(message(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : label}
      </button>
      {error && (
        <span className={s.tableMeta} role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** In these lifecycle states no driver works and no work starts without a person. */
export const settledRun = (state: string) => ["completed", "stopped", "blocked"].includes(state);

export function ArchivedNotice() {
  return (
    <Notice kind="info">
      This run is archived. It does not show in Benchmarks, Records or notifications until you
      restore it.
    </Notice>
  );
}

/**
 * Export a settled run or a saved comparison as a .tar file. The default export names criteria
 * only by number; a person must choose to include the private criteria and judge reasons.
 */
export function ExportAction({
  href,
  subject,
  buttonClass = s.secondary,
}: {
  href: string;
  subject: "run" | "comparison";
  buttonClass?: string;
}) {
  const [open, setOpen] = useState(false),
    [privateScope, setPrivateScope] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const close = () => {
    if (busy) return;
    setOpen(false);
    setError("");
  };
  async function download() {
    setBusy(true);
    setError("");
    try {
      const response = await request(`${href}?scope=${privateScope ? "private" : "public"}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof value?.error === "string"
            ? value.error
            : "Basalt couldn’t make the export. Try again.",
        );
      }
      const name =
        /filename="([^"]+)"/u.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
        "basalt-export.tar";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setOpen(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className={buttonClass} onClick={() => setOpen(true)}>
        Export
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={subject === "run" ? "Export run" : "Export comparison"}
      >
        <p>You get one .tar file with:</p>
        <ul className={s.contentsList}>
          <li>a report that opens in any browser</li>
          <li>the results as JSON</li>
          {subject === "run" && <li>how each build was built, as an ATIF trajectory</li>}
          <li>a checksum for every file</li>
        </ul>
        <p className={s.small}>
          It never includes screen recordings, judge requests or images of withheld observations.
        </p>
        <div className={s.form}>
          <label className={s.choice}>
            <input
              type="checkbox"
              checked={privateScope}
              disabled={busy}
              onChange={(event) => setPrivateScope(event.target.checked)}
            />
            <span>
              Include private criteria and judge reasons
              <small>
                Without this, the export calls each criterion “Criterion 1”, “Criterion 2” and so
                on, and it has no judge reasons, scales or images.
              </small>
            </span>
          </label>
          {error && <Notice>{error}</Notice>}
          <div className={s.row}>
            <button className={s.primary} disabled={busy} onClick={() => void download()}>
              {busy ? "Preparing export…" : "Download export"}
            </button>
            <button className={s.secondary} disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
