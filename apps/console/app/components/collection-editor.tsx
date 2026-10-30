"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { Page, EvaluationSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import type {
  SuiteMember,
  SuiteSnapshot,
  EvaluationSuite,
} from "../../../../dist/packages/contracts/src/suites.js";
import { action, read, message, ApiError } from "./api";
import { draftMemory, useUnsavedGuard } from "./draft-memory";
import { Dialog, Notice } from "./ui";
import s from "./workbench.module.css";

type CollectionEditorProps = {
  suite?: EvaluationSuite;
  memberNames?: Record<string, string>;
};
export function CollectionEditor(props: CollectionEditorProps) {
  return <CollectionForm key={props.suite?.id ?? "new"} {...props} />;
}
function CollectionForm({ suite, memberNames = {} }: CollectionEditorProps) {
  const router = useRouter(),
    params = useSearchParams();
  const mounted = useRef(true);
  const saving = useRef(false);
  const actionId = useRef("");
  const [session, setSession] = useState<string | null>(null);
  const pending = useRef<{
    actionId: string;
    title: string;
    description: string;
    members: SuiteMember[];
    expectedSnapshotId: string | null;
  } | null>(null);
  const [conflict, setConflict] = useState(false),
    [currentSaved, setCurrentSaved] = useState<{
      suite: EvaluationSuite;
      description: string;
      memberNames: Record<string, string>;
      members: Page<SuiteMember>;
    } | null>(null);
  const [retainedConflict, setRetainedConflict] = useState<{
    title: string;
    description: string;
    members: SuiteMember[];
  } | null>(null);
  const [searchError, setSearchError] = useState(""),
    [searchRetry, setSearchRetry] = useState(0),
    [selectedQuery, setSelectedQuery] = useState(""),
    [selectedPage, setSelectedPage] = useState(1);
  const [deviceRetained, setDeviceRetained] = useState(false);
  const routeOpen = params.get("suite-edit") === (suite?.id ?? "new");
  const recoveryKey = `basalt-collection-draft:${suite?.id ?? "new"}:${session}`;
  const [ready, setReady] = useState(false),
    [reload, setReload] = useState(0),
    [loading, setLoading] = useState(false),
    [expectedSnapshotId, setExpected] = useState(suite?.snapshotId ?? null),
    [names, setNames] = useState<Record<string, string>>(memberNames),
    [inspectSelected, setInspectSelected] = useState(true);
  const [navigating, setNavigating] = useState(false),
    [title, setTitle] = useState(suite?.title ?? ""),
    [description, setDescription] = useState(""),
    [members, setMembers] = useState<SuiteMember[]>([]),
    [page, setPage] = useState<Page<EvaluationSummary> | null>(null),
    [q, setQ] = useState(""),
    [number, setNumber] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const open = routeOpen && !navigating;
  useEffect(() => {
    mounted.current = true;
    try {
      const id = sessionStorage.getItem("basalt-collection-session") ?? crypto.randomUUID();
      sessionStorage.setItem("basalt-collection-session", id);
      setSession(id);
    } catch {
      setSession(crypto.randomUUID());
    }
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (routeOpen || !navigating) return;
    saving.current = false;
    setNavigating(false);
    setBusy(false);
  }, [routeOpen, navigating]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void read<Page<EvaluationSummary>>(
      `/api/evaluations?status=runnable&q=${encodeURIComponent(q)}&page=${number}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setPage(value);
        setSearchError("");
        setNames((current) => ({
          ...current,
          ...Object.fromEntries(value.items.map((item) => [item.id, item.title])),
        }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setPage(null);
          setSearchError(message(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, q, number, searchRetry]);
  useEffect(() => {
    if (!open || ready || !session) return;
    let active = true;
    void (async () => {
      let retained: string | null = null;
      try {
        retained = draftMemory.has(recoveryKey)
          ? JSON.stringify(draftMemory.get(recoveryKey))
          : localStorage.getItem(recoveryKey);
      } catch {}
      if (retained) {
        const draft = JSON.parse(retained) as {
          title: string;
          description: string;
          members: SuiteMember[];
          names: Record<string, string>;
          expectedSnapshotId: string | null;
          q: string;
          number: number;
          actionId: string;
          pending: typeof pending.current;
        };
        if (
          typeof draft.title !== "string" ||
          typeof draft.description !== "string" ||
          typeof draft.q !== "string" ||
          !Number.isSafeInteger(draft.number) ||
          typeof draft.actionId !== "string" ||
          !/^[a-zA-Z0-9_-]{16,100}$/u.test(draft.actionId) ||
          (draft.pending !== null &&
            (!draft.pending ||
              draft.pending.actionId !== draft.actionId ||
              typeof draft.pending.title !== "string" ||
              typeof draft.pending.description !== "string" ||
              !Array.isArray(draft.pending.members))) ||
          draft.number < 1 ||
          !draft.names ||
          typeof draft.names !== "object" ||
          Array.isArray(draft.names) ||
          (draft.expectedSnapshotId !== null &&
            !/^[a-f0-9]{64}$/u.test(draft.expectedSnapshotId)) ||
          !Array.isArray(draft.members) ||
          draft.members.length > 1000 ||
          draft.members.some(
            (member) =>
              !/^[a-f0-9]{64}$/u.test(member.revisionId) ||
              !/^[a-f0-9]{64}$/u.test(member.validationRecordHash),
          )
        )
          throw new Error(
            "The suite draft on this device is not valid. Load the saved suite before you continue.",
          );
        if (active) {
          setTitle(draft.title);
          setDescription(draft.description);
          setMembers(draft.members);
          setNames(draft.names);
          setExpected(draft.expectedSnapshotId);
          setQ(draft.q);
          setNumber(draft.number);
          actionId.current = draft.actionId;
          pending.current = draft.pending;
          if (suite && draft.expectedSnapshotId !== suite.snapshotId) setConflict(true);
        }
      } else if (suite) {
        const snapshot = await read<SuiteSnapshot>(`/api/suites/snapshots/${suite.snapshotId}`);
        if (active) {
          setMembers(snapshot.members);
          setDescription(snapshot.description);
          setTitle(snapshot.title);
          setExpected(snapshot.id);
        }
      }
      actionId.current ||= crypto.randomUUID();
      if (active) setReady(true);
    })().catch((cause) => {
      if (active) setError(message(cause));
    });
    return () => {
      active = false;
    };
  }, [open, suite?.id, suite?.snapshotId, recoveryKey, ready, reload, session]);
  useEffect(() => {
    if (!ready || saving.current) return;
    const retained = {
      title,
      description,
      members,
      names,
      expectedSnapshotId,
      q,
      number,
      actionId: actionId.current,
      pending: pending.current,
    };
    draftMemory.set(recoveryKey, retained);
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(retained));
      setDeviceRetained(true);
    } catch {
      setDeviceRetained(false);
      setError(
        "This browser cannot keep a backup of the draft, so keep this page open until you save the suite.",
      );
    }
  }, [
    ready,
    recoveryKey,
    title,
    description,
    members,
    names,
    expectedSnapshotId,
    q,
    number,
    busy,
    conflict,
  ]);
  useUnsavedGuard(
    () => open && ready && !deviceRetained,
    () =>
      setError(
        "The server does not have these changes, and this browser cannot keep a backup. Save or copy them before you leave.",
      ),
  );
  useEffect(() => {
    if (!conflict || !suite) return;
    let active = true;
    void read<NonNullable<typeof currentSaved>>(`/api/suites/${suite.id}?limit=50`)
      .then((value) => {
        if (active) setCurrentSaved(value);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [conflict, suite?.id]);
  function show(visible: boolean) {
    if (saving.current) return;
    const next = new URLSearchParams(params.toString());
    if (visible) next.set("suite-edit", suite?.id ?? "new");
    else next.delete("suite-edit");
    router.push(`${location.pathname}?${next}`, { scroll: false });
  }
  async function loadCurrent(reapply: boolean) {
    if (!suite) return;
    setBusy(true);
    try {
      const current = await read<NonNullable<typeof currentSaved>>(
        `/api/suites/${suite.id}?limit=50`,
      );
      const snapshot = await read<SuiteSnapshot>(
        `/api/suites/snapshots/${current.suite.snapshotId}`,
      );
      setCurrentSaved(current);
      if (!reapply) {
        setRetainedConflict({ title, description, members });
        try {
          localStorage.setItem(
            recoveryKey + ":retained",
            JSON.stringify({ title, description, members }),
          );
        } catch {}
        setTitle(snapshot.title);
        setDescription(snapshot.description);
        setMembers(snapshot.members);
      }
      setNames((names) => ({ ...names, ...current.memberNames }));
      setExpected(snapshot.id);
      setConflict(false);
      setError("");
      pending.current = null;
      actionId.current = crypto.randomUUID();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const selectedMembers = members.filter((member) =>
    (names[member.revisionId] ?? member.revisionId)
      .toLowerCase()
      .includes(selectedQuery.toLowerCase()),
  );
  // Removing the last item on a page must fall back to a page that still has items.
  const selectedPageCount = Math.max(1, Math.ceil(selectedMembers.length / 20)),
    visibleSelectedPage = Math.min(selectedPage, selectedPageCount);
  return (
    <>
      <button className={s.secondary} onClick={() => show(true)}>
        {suite ? "Edit suite" : "Create suite"}
      </button>
      <Dialog
        open={open}
        onClose={() => {
          if (!saving.current) show(false);
        }}
        title={suite ? "Edit suite" : "Create suite"}
      >
        <p className={s.small}>
          Choose prepared evaluations to run together. If you edit an evaluation later, the suite
          keeps the version you selected.
        </p>
        {error && (
          <Notice>
            {error}
            {ready && (
              <button
                className={s.secondary}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(JSON.stringify({ title, description, members }, null, 2))
                    .catch(() =>
                      setError(
                        "The browser could not copy the suite. Keep this dialog open and save the suite or try again.",
                      ),
                    )
                }
              >
                Copy unfinished suite
              </button>
            )}
            {!ready && (
              <button
                className={s.secondary}
                onClick={() => {
                  draftMemory.delete(recoveryKey);
                  actionId.current = crypto.randomUUID();
                  pending.current = null;
                  try {
                    localStorage.removeItem(recoveryKey);
                  } catch {}
                  setError("");
                  setMembers([]);
                  setReady(false);
                  setReload((value) => value + 1);
                }}
              >
                {suite ? "Load saved suite" : "Start a fresh suite"}
              </button>
            )}
          </Notice>
        )}
        {conflict && (
          <Notice>
            Another session changed this suite. Your unfinished changes are still here.{" "}
            <button className={s.secondary} disabled={busy} onClick={() => void loadCurrent(true)}>
              Reapply my changes to current suite
            </button>
            <button className={s.secondary} disabled={busy} onClick={() => void loadCurrent(false)}>
              Load current suite
            </button>
          </Notice>
        )}
        {currentSaved && (
          <details>
            <summary>Compare current saved suite</summary>
            <p>
              {currentSaved.suite.title} · {currentSaved.suite.memberCount}{" "}
              {currentSaved.suite.memberCount === 1 ? "evaluation" : "evaluations"}
            </p>
            <p>{currentSaved.description}</p>
            <ul>
              {Object.entries(currentSaved.memberNames).map(([id, title]) => (
                <li key={id}>
                  {title} <small>{id}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
        {retainedConflict && (
          <details>
            <summary>Your previous unfinished suite</summary>
            <pre className={s.code}>{JSON.stringify(retainedConflict, null, 2)}</pre>
            <button
              className={s.secondary}
              disabled={busy || !!pending.current}
              onClick={() => {
                setTitle(retainedConflict.title);
                setDescription(retainedConflict.description);
                setMembers(retainedConflict.members);
              }}
            >
              Restore this text and selection
            </button>
          </details>
        )}
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              saving.current ||
              conflict ||
              !ready ||
              !title.trim() ||
              !members.length ||
              members.length > 1000
            )
              return;
            saving.current = true;
            setBusy(true);
            setError("");
            const request = pending.current ?? {
              title,
              description,
              members,
              expectedSnapshotId,
              actionId: actionId.current,
            };
            pending.current = request;
            const submittedDraft = JSON.stringify({
              title,
              description,
              members,
              names,
              expectedSnapshotId,
              q,
              number,
              actionId: actionId.current,
              pending: request,
            });
            try {
              localStorage.setItem(recoveryKey, submittedDraft);
            } catch {
              /* The server save remains available. */
            }
            void action<EvaluationSuite>(
              `/api/suites${suite ? `/${suite.id}` : ""}`,
              "save_suite",
              request,
            )
              .then((saved) => {
                draftMemory.delete(recoveryKey);
                try {
                  if (localStorage.getItem(recoveryKey) === submittedDraft)
                    localStorage.removeItem(recoveryKey);
                } catch {}
                if (!mounted.current) return;
                setExpected(saved.snapshotId);
                setNavigating(true);
                setReady(false);
                router.replace(`/collections/${saved.id}`);
              })
              .catch((cause) => {
                saving.current = false;
                if (!mounted.current) return;
                setError(message(cause));
                if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
                  pending.current = null;
                if (/changed in another session/u.test(message(cause))) {
                  setConflict(true);
                  pending.current = null;
                }
                setBusy(false);
              });
          }}
        >
          <div className={s.field}>
            <label htmlFor="suite-title">Suite title</label>
            <input
              id="suite-title"
              required
              maxLength={160}
              value={title}
              disabled={!ready || busy || !!pending.current}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className={s.field}>
            <label htmlFor="suite-description">Description (optional)</label>
            <textarea
              id="suite-description"
              maxLength={2000}
              value={description}
              disabled={!ready || busy || !!pending.current}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className={s.field}>
            <label htmlFor="suite-search">Find ready evaluations</label>
            <input
              id="suite-search"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              type="search"
              value={q}
              disabled={!ready || busy || !!pending.current}
              onChange={(event) => {
                setQ(event.target.value);
                setNumber(1);
              }}
            />
          </div>
          <div className={s.row}>
            <p role="status">
              {members.length} {members.length === 1 ? "evaluation" : "evaluations"} selected
            </p>
            <button
              type="button"
              className={s.textButton}
              onClick={() => setInspectSelected(!inspectSelected)}
            >
              {inspectSelected ? "Hide selected" : "Inspect selected"}
            </button>
            {members.length > 0 && (
              <button
                type="button"
                className={s.textButton}
                disabled={busy || !!pending.current}
                onClick={() => setMembers([])}
              >
                Clear selection
              </button>
            )}
          </div>
          {inspectSelected && (
            <div className={s.form}>
              {members.length > 20 && (
                <>
                  <label htmlFor="selected-collection-search">Find selected evaluations</label>
                  <input
                    id="selected-collection-search"
                    type="search"
                    value={selectedQuery}
                    onChange={(event) => {
                      setSelectedQuery(event.target.value);
                      setSelectedPage(1);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.preventDefault();
                    }}
                  />
                </>
              )}
              {selectedMembers
                .slice((visibleSelectedPage - 1) * 20, visibleSelectedPage * 20)
                .map((member) => (
                  <div className={s.row} key={member.revisionId}>
                    <Link href={`/evaluations/${member.revisionId}`} target="_blank">
                      {names[member.revisionId] ??
                        `Saved evaluation ${member.revisionId.slice(0, 8)}`}
                    </Link>
                    <button
                      type="button"
                      className={s.textButton}
                      disabled={busy || !!pending.current}
                      aria-label={`Remove ${names[member.revisionId] ?? `saved evaluation ${member.revisionId}`} from suite`}
                      onClick={() =>
                        setMembers((current) =>
                          current.filter((item) => item.revisionId !== member.revisionId),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              {selectedMembers.length > 20 && (
                <div className={s.row}>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={visibleSelectedPage <= 1}
                    onClick={() => setSelectedPage(visibleSelectedPage - 1)}
                  >
                    Previous selected
                  </button>
                  <span>
                    {visibleSelectedPage} / {selectedPageCount}
                  </span>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={visibleSelectedPage >= selectedPageCount}
                    onClick={() => setSelectedPage(visibleSelectedPage + 1)}
                  >
                    Next selected
                  </button>
                </div>
              )}
            </div>
          )}
          {searchError && (
            <Notice>
              {searchError}
              <button
                type="button"
                className={s.secondary}
                onClick={() => setSearchRetry(searchRetry + 1)}
              >
                Retry evaluation search
              </button>
            </Notice>
          )}
          {!loading &&
            page?.items.map((item) => (
              <label className={s.acknowledge} key={item.evaluationId ?? item.id}>
                <input
                  type="checkbox"
                  checked={members.some((member) => member.revisionId === item.id)}
                  disabled={!ready || busy || loading || !!pending.current}
                  onChange={(event) =>
                    setMembers((current) =>
                      event.target.checked
                        ? [
                            ...current,
                            {
                              revisionId: item.id,
                              validationRecordHash: item.validationRecordHash!,
                            },
                          ]
                        : current.filter((member) => member.revisionId !== item.id),
                    )
                  }
                />
                {item.title}
              </label>
            ))}
          {loading && <p role="status">Loading evaluations…</p>}
          {!loading && page && !page.total && (
            <p>
              {q
                ? "No ready evaluations match this search."
                : "Prepared evaluations will appear here after their first run."}{" "}
              <Link href="/evaluations">Open evaluations</Link>
            </p>
          )}
          {(page?.pages ?? 1) > 1 && (
            <div className={s.row}>
              <button
                type="button"
                className={s.secondary}
                disabled={number <= 1 || loading || busy}
                onClick={() => setNumber(number - 1)}
              >
                Previous page
              </button>
              <span>
                {page?.page ?? 1} / {page?.pages ?? 1}
              </span>
              <button
                type="button"
                className={s.secondary}
                disabled={!page || number >= page.pages || loading || busy}
                onClick={() => setNumber(number + 1)}
              >
                Next page
              </button>
            </div>
          )}
          <div className={s.row}>
            <button
              className={s.primary}
              disabled={
                !ready ||
                busy ||
                conflict ||
                !title.trim() ||
                !members.length ||
                members.length > 1000
              }
            >
              {busy ? "Saving…" : pending.current ? "Recover original save" : "Save suite"}
            </button>
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() => show(false)}
            >
              Close
            </button>
            <button
              type="button"
              className={s.textButton}
              disabled={busy || !!pending.current}
              onClick={() => {
                draftMemory.delete(recoveryKey);
                actionId.current = crypto.randomUUID();
                try {
                  localStorage.removeItem(recoveryKey);
                } catch {}
                setReady(false);
                setTitle(suite?.title ?? "");
                setDescription("");
                setMembers([]);
                show(false);
              }}
            >
              Discard unfinished changes
            </button>
            <span className={s.small}>
              {deviceRetained
                ? "Your unfinished changes stay on this device."
                : "This browser cannot keep a backup, so keep this dialog open until you save the suite."}
            </span>
          </div>
        </form>
      </Dialog>
    </>
  );
}
