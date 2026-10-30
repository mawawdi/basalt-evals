"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Page, RunSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import type { LaunchAuthorizationStatus } from "../../../../dist/packages/contracts/src/launch.js";
import { read, formatMoney } from "./api";
import { Notice } from "./ui";
import s from "./workbench.module.css";
type Inbox = { attentionCount: number; active: Page<RunSummary> };
type Unfinished = {
  key: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  /** Device keys forgotten by Discard; empty while a launch is still being confirmed. */
  owned: string[];
};
const list = (items: string[]) =>
  items.length > 2
    ? `${items.slice(0, 2).join(", ")} and ${items.length - 2} more`
    : items.join(", ");
function ResumeRow({
  entry,
  discard,
}: {
  entry: Unfinished;
  discard: (entry: Unfinished) => void;
}) {
  return (
    <li>
      <Link
        className={s.resumeRow}
        href={entry.href}
        aria-label={`Continue ${entry.kind.toLowerCase()}: ${entry.title}${entry.detail ? `, ${entry.detail}` : ""}`}
      >
        <span className={s.resumeKind}>{entry.kind}</span>
        <span className={s.resumeTitle}>{entry.title}</span>
        {entry.detail && <span className={s.resumeDetail}>{entry.detail}</span>}
        <span className={s.resumeGo}>Continue</span>
      </Link>
      {entry.owned.length > 0 && (
        <button
          type="button"
          className={`${s.textButton} ${s.resumeDiscard}`}
          aria-label={`Discard ${entry.kind.toLowerCase()}: ${entry.title}`}
          onClick={() => discard(entry)}
        >
          Discard
        </button>
      )}
    </li>
  );
}
function signature(value: Inbox) {
  return JSON.stringify([
    value.attentionCount,
    value.active.total,
    value.active.items.map(({ id, state, phase, blocker, billedUsd, reservedUsd }) => [
      id,
      state,
      phase,
      blocker,
      billedUsd,
      reservedUsd,
    ]),
  ]);
}
// A stable default: the recovery effect depends on it and must not rerun every render.
const noModels: Array<{ id: string; name: string }> = [];
// Records reuse the live refresh; only Benchmarks, the desk, lists unfinished work.
export function HomeRecovery({
  initial,
  models = noModels,
  resume = false,
}: {
  initial: Inbox;
  models?: Array<{ id: string; name: string }>;
  resume?: boolean;
}) {
  const router = useRouter();
  const [disconnected, setDisconnected] = useState(false),
    [unfinished, setUnfinished] = useState<Unfinished[]>([]),
    [discarded, setDiscarded] = useState<{ label: string; values: Array<[string, string]> } | null>(
      null,
    );
  // Discarding forgets only this device's copy; Undo restores the exact stored values.
  const discard = (entry: Unfinished) => {
    try {
      const values = entry.owned.flatMap((key): Array<[string, string]> => {
        const value = localStorage.getItem(key);
        return value === null ? [] : [[key, value]];
      });
      entry.owned.forEach((key) => localStorage.removeItem(key));
      setDiscarded({ label: `${entry.kind} discarded: ${entry.title}.`, values });
      window.dispatchEvent(new StorageEvent("storage"));
    } catch {
      /* Device storage is unavailable; nothing was removed. */
    }
  };
  const undo = () => {
    try {
      discarded?.values.forEach(([key, value]) => localStorage.setItem(key, value));
      setDiscarded(null);
      window.dispatchEvent(new StorageEvent("storage"));
    } catch {
      /* Device storage is unavailable. */
    }
  };
  useEffect(() => {
    let active = true,
      polling = false,
      previous = signature(initial),
      failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      try {
        const next = await read<Inbox>("/api/run-inbox");
        if (!active) return;
        failures = 0;
        setDisconnected(false);
        if (signature(next) !== previous) {
          previous = signature(next);
          router.refresh();
        }
      } catch {
        if (active) {
          failures += 1;
          setDisconnected(true);
        }
      } finally {
        polling = false;
        schedule();
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer =
        active && initial.active.total > 0
          ? setTimeout(() => void refresh(), Math.min(30000, 2000 * 2 ** Math.min(failures, 4)))
          : null;
    };
    const recover = () => {
      const entries: Unfinished[] = [];
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("basalt-run-setup:")) {
            const id = key.slice("basalt-run-setup:".length);
            if (localStorage.getItem("basalt-setup-snapshots:" + id)) {
              const setup = JSON.parse(localStorage.getItem(key)!);
              const titles: string[] = (setup.selected ?? []).map(
                (item: { title: string }) => item.title,
              );
              // Setups for the same evaluations differ by models and limit, so the row says which.
              const names: string[] = (setup.options?.builderModelIds ?? []).map(
                (model: string) => models.find((item) => item.id === model)?.name ?? model,
              );
              const limit = Number(setup.ceiling);
              // A start that was sent but never confirmed may already be running, so it
              // cannot be discarded and says why.
              const starting = !!localStorage.getItem("basalt-run-authorization:" + id);
              if (titles.length || starting)
                entries.push({
                  key,
                  kind: "Benchmark setup",
                  title: titles.length ? list(titles) : "Started setup",
                  detail: [
                    names.length ? list(names) : "",
                    setup.ceiling?.trim() && Number.isFinite(limit) && limit > 0
                      ? `${formatMoney(limit)} limit`
                      : "no spending limit yet",
                    starting ? "start not confirmed yet" : "",
                  ]
                    .filter(Boolean)
                    .join(", "),
                  href: "/runs/new?intent=" + encodeURIComponent(id),
                  owned: starting ? [] : [key, "basalt-setup-snapshots:" + id],
                });
            }
          } else if (key.startsWith("basalt-editor-buffer:")) {
            const copy = localStorage.getItem(key);
            const context = key.slice("basalt-editor-buffer:".length);
            const session = sessionStorage.getItem("basalt-editor-session");
            const retained =
              copy && session
                ? JSON.parse(
                    localStorage.getItem(`basalt-editor-recovery:${copy}:${session}`) ?? "null",
                  )
                : null;
            if (copy)
              entries.push({
                key,
                kind: "Evaluation draft",
                title: retained?.title || "Untitled evaluation",
                detail:
                  context === "new"
                    ? "New evaluation"
                    : context.startsWith("duplicate-")
                      ? "Copy of a saved evaluation"
                      : "Changes to a saved evaluation",
                href:
                  "/evaluations/new?" +
                  new URLSearchParams({
                    copy,
                    ...(context !== "new" && !context.startsWith("duplicate-")
                      ? { evaluation: context }
                      : {}),
                  }),
                owned: [
                  key,
                  ...(copy && session ? [`basalt-editor-recovery:${copy}:${session}`] : []),
                ],
              });
          }
        }
      } catch {
        /* Server evidence remains available when device storage is denied. */
      }
      // Identical setups would offer the same choice twice.
      const identity = (entry: Unfinished) => `${entry.kind}\n${entry.title}\n${entry.detail}`;
      setUnfinished(
        entries
          .filter(
            (entry, index) =>
              entries.findIndex((item) => identity(item) === identity(entry)) === index,
          )
          // Unconfirmed starts lead: they are the only entries that may already be spending.
          .sort((a, b) => Number(!b.owned.length) - Number(!a.owned.length))
          .slice(0, 20),
      );
    };
    // A start the server confirms is a run, not unfinished work: forget this device's copy,
    // which reopening would only redirect to that run.
    const settle = async () => {
      let ids: string[] = [];
      try {
        ids = Object.keys(localStorage)
          .filter((key) => key.startsWith("basalt-run-authorization:"))
          .map((key) => key.slice("basalt-run-authorization:".length));
      } catch {
        return;
      }
      let settled = false;
      for (const id of ids) {
        const status = await read<LaunchAuthorizationStatus | null>(
          "/api/launch-authorizations/" + encodeURIComponent(id),
        ).catch(() => null);
        if (!active || !status?.operationId) continue;
        try {
          for (const key of [
            "basalt-run-authorization:" + id,
            "basalt-run-setup:" + id,
            "basalt-setup-snapshots:" + id,
          ])
            localStorage.removeItem(key);
          settled = true;
        } catch {
          /* Device storage is unavailable; the entry still opens its run. */
        }
      }
      if (settled && active) recover();
    };
    recover();
    void settle();
    const focused = () => {
      recover();
      void refresh();
    };
    window.addEventListener("focus", focused);
    window.addEventListener("storage", recover);
    document.addEventListener("visibilitychange", focused);
    schedule();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", focused);
      window.removeEventListener("storage", recover);
      document.removeEventListener("visibilitychange", focused);
    };
  }, [router, initial, models]);
  return (
    <>
      {disconnected && (
        <Notice>
          The connection stopped. This page shows runs from the last successful load, so work and
          charges may have changed. Basalt keeps trying to reconnect.
        </Notice>
      )}
      {resume && discarded && (
        <p className={s.resumeUndo} role="status">
          {discarded.label}{" "}
          <button type="button" className={s.textButton} onClick={undo}>
            Undo
          </button>
        </p>
      )}
      {resume && !!unfinished.length && (
        <section className={s.resume} aria-labelledby="unfinished-work">
          <div className={s.sectionHeading}>
            <h2 id="unfinished-work">Unfinished work</h2>
            <span className={s.small}>Saved on this device</span>
          </div>
          <ul>
            {unfinished.slice(0, 3).map((entry) => (
              <ResumeRow key={entry.key} entry={entry} discard={discard} />
            ))}
          </ul>
          {unfinished.length > 3 && (
            <details>
              <summary>{unfinished.length - 3} more</summary>
              <ul>
                {unfinished.slice(3).map((entry) => (
                  <ResumeRow key={entry.key} entry={entry} discard={discard} />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}
