"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { LaunchCatalog } from "../../../../dist/packages/contracts/src/console.js";
import type { EvaluationSummary, Page } from "../../../../dist/packages/contracts/src/catalog.js";
import { evaluationLaunchSource } from "../../../../dist/packages/contracts/src/catalog.js";
import type { LaunchAuthorizationStatus } from "../../../../dist/packages/contracts/src/launch.js";
import {
  RunOptions,
  LaunchBudget,
  LaunchSummary,
  launchPreferences,
  rememberLaunch,
  validLaunchOptions,
  type Options,
} from "./run-configuration";
import { action, read, message, formatMoney } from "./api";
import { useLaunchPreview } from "./launch-preview";
import { isLaunchAttempt, startLaunchAttempt, type LaunchAttempt } from "./launch-attempt";
import { PageHeading, Notice, EmptyState, ProblemText } from "./ui";
import { counted, problemSummary } from "./result-display";
import { draftMemory } from "./draft-memory";
import s from "./workbench.module.css";
import r from "./run-experience.module.css";
import { ArrowDown } from "@phosphor-icons/react";
type Setup = { selected: EvaluationSummary[]; options: Options; ceiling: string };
type LibrarySource = { current: EvaluationSummary | null; error: string | null };
const authorizationKey = (id: string) => "basalt-run-authorization:" + id;
function pendingLaunch(id: string): LaunchAttempt | null {
  try {
    const saved = JSON.parse(localStorage.getItem(authorizationKey(id)) ?? "null");
    return isLaunchAttempt(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function RunSetup({
  catalog,
  defaults,
  initial = [],
  added,
  amendment,
  prerequisites = [],
  suites = [],
}: {
  suites?: import("../../../../dist/packages/contracts/src/suites.js").EvaluationSuite[];
  catalog: LaunchCatalog;
  defaults: Options;
  initial?: EvaluationSummary[];
  prerequisites?: import("../../../../dist/packages/contracts/src/console.js").LocalReadinessCheck[];
  added?: EvaluationSummary;
  amendment?:
    import("../../../../dist/packages/contracts/src/execution.js").EvaluationWorkflow | null;
}) {
  const router = useRouter(),
    params = useSearchParams();
  const [setup, setSetup] = useState<Setup>({ selected: initial, options: defaults, ceiling: "" });
  const [intent, setIntent] = useState(""),
    [ready, setReady] = useState(false);
  const query = params.get("q") ?? "",
    page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const [library, setLibrary] = useState<Page<EvaluationSummary> | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [chooserOpen, setChooserOpen] = useState<boolean | null>(null);
  const [libraryError, setLibraryError] = useState(""),
    [remembered, setRemembered] = useState(false);
  const [deviceRetained, setDeviceRetained] = useState(true),
    [invalidSettings, setInvalidSettings] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [selectedLibrary, setSelectedLibrary] = useState<Record<string, LibrarySource>>({});
  const [selectedQuery, setSelectedQuery] = useState(""),
    [selectedPage, setSelectedPage] = useState(1);
  const selectedRows = setup.selected.filter((item) =>
    item.title.toLowerCase().includes(selectedQuery.toLowerCase()),
  );
  const selectedPageCount = Math.max(1, Math.ceil(selectedRows.length / 20)),
    visibleSelectedPage = Math.min(selectedPage, selectedPageCount);
  const [recovering, setRecovering] = useState<"checking" | "authorized" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const launching = useRef(false);
  const key = (id: string) => "basalt-run-setup:" + id;
  function retain(id: string, next: Setup) {
    draftMemory.set(key(id), next);
    try {
      localStorage.setItem(key(id), JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }
  function retainSnapshot(id: string, snapshot: string) {
    const indexKey = "basalt-setup-snapshots:" + id;
    let previous = draftMemory.get(indexKey);
    try {
      previous ??= JSON.parse(localStorage.getItem(indexKey) ?? "[]");
    } catch {}
    const index = Array.isArray(previous)
      ? previous.filter((entry): entry is string => typeof entry === "string")
      : [];
    const retained = [...index.filter((entry) => entry !== snapshot), snapshot];
    for (const stale of retained.slice(0, -40)) {
      if (stale === id) continue;
      draftMemory.delete(key(stale));
      try {
        localStorage.removeItem(key(stale));
      } catch {}
    }
    const bounded = retained.slice(-40);
    draftMemory.set(indexKey, bounded);
    try {
      localStorage.setItem(indexKey, JSON.stringify(bounded));
      return true;
    } catch {
      return false;
    }
  }
  useEffect(() => {
    let alive = true;
    setReady(false);
    setRecovering(null);
    const id = params.get("intent") ?? crypto.randomUUID();
    const recover = () => {
      const prefs = launchPreferences(defaults, catalog.models, catalog.harnesses);
      setRemembered(prefs.remembered);
      const savedKey = key(new URLSearchParams(window.location.search).get("state") ?? id);
      let saved = (draftMemory.get(savedKey) as Setup | undefined) ?? null;
      try {
        saved ??= JSON.parse(localStorage.getItem(savedKey) ?? "null");
      } catch {}
      if (
        saved &&
        (!Array.isArray(saved.selected) ||
          !saved.selected.every(
            (item) =>
              item &&
              typeof item.id === "string" &&
              typeof item.draftId === "string" &&
              typeof item.title === "string" &&
              Number.isSafeInteger(item.stages) &&
              item.stages >= 1 &&
              (item.kind === "draft" || item.kind === "evaluation") &&
              (item.evaluationId === null || typeof item.evaluationId === "string"),
          ) ||
          typeof saved.ceiling !== "string")
      )
        saved = null;
      const unsupported =
        !!saved && !validLaunchOptions(saved.options, catalog.models, catalog.harnesses);
      setInvalidSettings(!amendment && unsupported);
      if (unsupported) setRemembered(false);
      const next = amendment
        ? {
            selected: saved?.selected ?? [...initial],
            options: defaults,
            ceiling: String(amendment.ceilingUsd),
          }
        : saved
          ? {
              ...saved,
              options: unsupported ? { ...defaults, builderModelIds: [] } : saved.options,
            }
          : { selected: [...initial], options: prefs.selection, ceiling: prefs.ceiling };
      // A new setup opened from a model starts with exactly that model chosen.
      const requestedModel = new URLSearchParams(window.location.search).get("model");
      const model = catalog.models.find((item) => item.id === requestedModel);
      if (!saved && !amendment && model)
        next.options = { ...next.options, builderModelIds: [model.id] };
      if (!saved || new URLSearchParams(window.location.search).has("add")) {
        const replaced = new URLSearchParams(window.location.search).get("replace");
        if (replaced) next.selected = next.selected.filter((selected) => selected.id !== replaced);
        for (const item of saved && added ? [added] : initial) {
          next.selected = next.selected.filter(
            (selected) =>
              selected.id !== item.id &&
              (!item.evaluationId || selected.evaluationId !== item.evaluationId),
          );
          next.selected.push(item);
        }
      }
      setSetup(next);
      setIntent(id);
      let durable = retain(id, next);
      const address = new URL(window.location.href);
      if (!address.searchParams.has("state") || address.searchParams.has("add")) {
        const snapshot = crypto.randomUUID();
        durable = retain(snapshot, next) && durable;
        durable = retainSnapshot(id, snapshot) && durable;
        address.searchParams.set("state", snapshot);
        for (const name of ["add", "eval", "collection", "replace", "library", "model"])
          address.searchParams.delete(name);
        window.history.replaceState(null, "", address);
      }
      setDeviceRetained(durable);
    };
    const url = new URL(window.location.href);
    url.searchParams.set("intent", id);
    window.history.replaceState(null, "", url);
    recover();
    const pending = !amendment ? pendingLaunch(id) : null;
    if (pending) setRecovering("authorized");
    if (amendment) setReady(true);
    else
      void read<LaunchAuthorizationStatus | null>("/api/launch-authorizations/" + id)
        .then(async (authorized) => {
          if (!alive) return;
          if (authorized || pending) {
            setRecovering("authorized");
            const original = authorized ?? pending!;
            const result = authorized?.operationId
              ? { kind: "started" as const, operationId: authorized.operationId }
              : await startLaunchAttempt(id, original);
            if (result.kind === "rejected") {
              if (!alive) return;
              try {
                localStorage.removeItem(authorizationKey(id));
              } catch {}
              setRecovering(null);
              setReady(true);
              setError(
                "The start didn’t complete, so no run was created. You can change this setup and try again. " +
                  result.error,
              );
              return;
            }
            if (alive) router.replace("/runs/" + result.operationId);
          } else setReady(true);
        })
        .catch((cause) => {
          if (alive) {
            setError(message(cause));
            setRecovering(pending ? "authorized" : "checking");
          }
        });
    window.addEventListener("popstate", recover);
    return () => {
      alive = false;
      window.removeEventListener("popstate", recover);
    };
  }, [params.get("intent")]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (!amendment && event.key === authorizationKey(intent) && pendingLaunch(intent)) {
        launching.current = true;
        setReady(false);
        setRecovering("authorized");
        setError("Another tab already started this setup. Open that run to continue.");
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [intent, amendment]);
  useEffect(() => {
    const refresh = () => setLibraryRefresh((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const selectedSources = JSON.stringify(
    setup.selected.map(({ id, evaluationId }) => ({ id, evaluationId })),
  );
  useEffect(() => {
    const controller = new AbortController();
    const selected = JSON.parse(selectedSources) as Array<{ evaluationId: string | null }>;
    const ids = [
      ...new Set(selected.map((item) => item.evaluationId).filter((id): id is string => !!id)),
    ];
    setSelectedLibrary({});
    if (!ready || !ids.length) return;
    const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
      ids.slice(index * 50, (index + 1) * 50),
    );
    void Promise.all(
      batches.map(async (batch) => {
        let values: Record<string, LibrarySource>;
        try {
          const current = await read<Record<string, EvaluationSummary | null>>(
            "/api/evaluations/current?" + new URLSearchParams({ ids: batch.join(",") }),
            controller.signal,
          );
          values = Object.fromEntries(
            batch.map((id) => [id, { current: current[id] ?? null, error: null }]),
          );
        } catch (cause) {
          values = Object.fromEntries(
            batch.map((id) => [id, { current: null, error: message(cause) }]),
          );
        }
        if (!controller.signal.aborted) setSelectedLibrary((prior) => ({ ...prior, ...values }));
      }),
    );
    return () => controller.abort();
  }, [ready, selectedSources, libraryRefresh]);
  const libraryQuery = useRef<string | null>(null);
  function update(next: Setup) {
    if (launching.current) return;
    setSetup(next);
    if (!next.selected.length) setChooserOpen(true);
    if (JSON.stringify(next.options) !== JSON.stringify(setup.options)) setInvalidSettings(false);
    const meaningful =
      JSON.stringify(next.selected) !== JSON.stringify(setup.selected) ||
      JSON.stringify(next.options) !== JSON.stringify(setup.options);
    const snapshot = meaningful
      ? crypto.randomUUID()
      : (new URLSearchParams(location.search).get("state") ?? intent);
    const intentRetained = retain(intent, next);
    const snapshotRetained = retain(snapshot, next);
    const indexRetained = retainSnapshot(intent, snapshot);
    setDeviceRetained(intentRetained && snapshotRetained && indexRetained);
    const url = new URL(window.location.href);
    url.searchParams.set("state", snapshot);
    url.searchParams.delete("add");
    url.searchParams.delete("eval");
    url.searchParams.delete("collection");
    url.searchParams.delete("replace");
    url.searchParams.delete("library");
    url.searchParams.delete("model");
    window.history[meaningful ? "pushState" : "replaceState"](null, "", url);
    rememberLaunch(next.options, next.ceiling);
  }
  function filter(value: string, number: number, replace = false) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    if (number > 1) url.searchParams.set("page", String(number));
    else url.searchParams.delete("page");
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  useEffect(() => {
    const controller = new AbortController();
    const currentQuery = JSON.stringify({ query, page });
    if (libraryQuery.current !== currentQuery) {
      libraryQuery.current = currentQuery;
      setLibrary(null);
      setLibraryError("");
    }
    setLibraryLoading(true);
    const timer = setTimeout(() => {
      void read<Page<EvaluationSummary>>(
        "/api/evaluations?" + new URLSearchParams({ q: query, page: String(page), limit: "20" }),
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) {
            setLibrary(value);
            setLibraryError("");
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setLibraryError(message(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLibraryLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, page, libraryRefresh]);
  const {
    preview,
    loading: previewing,
    error: previewError,
    retry,
  } = useLaunchPreview(
    ready &&
      setup.selected.length &&
      setup.options.builderModelIds.length &&
      setup.options.harnessIds.length
      ? {
          kind: "evaluation",
          selection: {
            ...setup.options,
            sources: setup.selected.map(({ id, kind }) => ({ id, kind })),
          },
        }
      : null,
  );
  async function start() {
    if (!preview || launching.current || reason) return;
    launching.current = true;
    setBusy(true);
    setError("");
    let attempted = false;
    try {
      if (amendment) {
        await action("/api/operations/" + amendment.id + "/commands", "command_operation", {
          kind: "amend",
          previewId: preview.id,
        });
        router.push("/runs/" + amendment.id);
        return;
      }
      const pending = pendingLaunch(intent);
      const original = pending ?? { previewId: preview.id, ceilingUsd: Number(setup.ceiling) };
      try {
        localStorage.setItem(authorizationKey(intent), JSON.stringify(original));
      } catch {
        throw new Error(
          "This browser couldn’t save the run for recovery. Allow site storage and try again.",
        );
      }
      attempted = true;
      if (pending) setRecovering("authorized");
      const result = await startLaunchAttempt(intent, original);
      if (result.kind === "rejected") {
        localStorage.removeItem(authorizationKey(intent));
        setError(result.error);
        setBusy(false);
        launching.current = false;
        return;
      }
      router.push("/runs/" + result.operationId);
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
      if (attempted) setRecovering("authorized");
      else launching.current = false;
    }
  }
  // Each stage of a staged evaluation has its own builds.
  const stageCount = setup.selected.reduce((sum, item) => sum + item.stages, 0);
  const builds =
    stageCount *
    setup.options.builderModelIds.length *
    setup.options.harnessIds.length *
    setup.options.repetitions;
  const reason = !ready
    ? "Restoring your selection…"
    : !setup.selected.length
      ? "Choose at least one evaluation."
      : amendment && setup.selected.length !== amendment.selection.sources.length
        ? `Keep the ${amendment.selection.sources.length} evaluations already approved for this run.`
        : amendment &&
            preview?.evaluation &&
            !preview.evaluation.evaluations.some((item) => item.preparation)
          ? "These evaluations are already prepared. Edit one that still needs preparation, or start a new run with them."
          : !setup.options.builderModelIds.length
            ? "Choose at least one model."
            : !setup.options.harnessIds.length
              ? "Choose tools in More options."
              : !setup.ceiling.trim() ||
                  !Number.isFinite(Number(setup.ceiling)) ||
                  Number(setup.ceiling) < 0
                ? "Enter a spending limit."
                : previewing
                  ? "Checking selection…"
                  : !preview
                    ? previewError
                      ? problemSummary(previewError)
                      : "The run needs a preview before it can start."
                    : "";
  const selectedModels = catalog.models.filter((model) =>
    setup.options.builderModelIds.includes(model.id),
  );
  const preparationCount = preview?.evaluation?.evaluations.filter(
    (item) => item.preparation,
  ).length;
  const showLibrary = !setup.selected.length || (chooserOpen ?? true);
  if (recovering)
    return (
      <main>
        <PageHeading
          title={recovering === "authorized" ? "Opening your run" : "Checking saved launch"}
        />
        <p role="status">
          {recovering === "authorized"
            ? "Restoring the selection and spending limit you already approved…"
            : "Checking whether this setup already started a run before you change it…"}
        </p>
        {error && (
          <Notice>
            {error}
            <button className={s.secondary} onClick={() => location.reload()}>
              Open again
            </button>
          </Notice>
        )}
      </main>
    );
  return (
    <main>
      <PageHeading
        title={amendment ? "Update this run" : "Run a benchmark"}
        description={
          amendment
            ? "Change the evaluations. The models, amount of work and spending limit stay as approved."
            : "Choose evaluations and models, set a spending limit, and the builds and checks run automatically."
        }
        action={
          !amendment && (
            <button
              type="button"
              className={s.textButton}
              disabled={busy || !ready}
              onClick={() => {
                update({ selected: [], options: defaults, ceiling: "" });
                setRemembered(false);
                filter("", 1, true);
                setError("");
              }}
            >
              Reset setup
            </button>
          )
        }
      />
      {prerequisites.some((check) => !check.ready) && (
        <Notice kind="info">
          Finish setting up{" "}
          {prerequisites
            .filter((check) => !check.ready)
            .map((check) => check.name)
            .join(", ")
            .replace(/, ([^,]*)$/u, " and $1")}{" "}
          in Settings before you start. Your selections and spending limit will stay here.
          <Link
            className={s.secondary}
            href={`/settings?return=${encodeURIComponent("/runs/new?" + params.toString())}`}
          >
            Open Settings
          </Link>
        </Notice>
      )}
      {remembered && (
        <p className={`${s.small} ${s.setupNote}`}>
          Your saved models, options and spending limit are loaded. Check them before you start.
        </p>
      )}
      {!deviceRetained && (
        <p className={`${s.small} ${s.setupNote}`} role="status">
          Browser storage is unavailable, so your setup stays only in this tab. Reloading or closing
          it loses your changes.
        </p>
      )}
      <p className={r.setupJump}>
        <a className={s.action} href="#run-spending">
          <ArrowDown size={16} aria-hidden />
          Skip to confirm & start
        </a>
      </p>
      {(error || previewError) && (
        <Notice>
          {error || <ProblemText text={previewError} />}
          {previewError && (
            <button className={s.secondary} onClick={retry}>
              Check again
            </button>
          )}
        </Notice>
      )}
      <div className={s.launchLayout}>
        <div className={s.form}>
          <section className={`${s.panel} ${s.step}`} id="run-evaluations" aria-busy={busy}>
            <div className={s.sectionHeading}>
              <h2>Evaluations</h2>
              {!amendment && (
                <Link
                  className={s.secondary}
                  href={
                    "/evaluations/new?" +
                    new URLSearchParams({ run: intent, state: params.get("state") ?? intent })
                  }
                  aria-disabled={busy || !ready}
                  onClick={(event) => {
                    if (busy || !ready) event.preventDefault();
                  }}
                >
                  Create evaluation
                </Link>
              )}
            </div>
            <p className={s.small}>Each model makes a build for every selected evaluation.</p>
            {setup.selected.length > 0 && (
              <>
                <div className={r.selectionHeading}>
                  <strong aria-live="polite">{setup.selected.length} selected</strong>
                  <button
                    type="button"
                    className={s.textButton}
                    disabled={busy}
                    onClick={() => update({ ...setup, selected: [] })}
                  >
                    Clear evaluations
                  </button>
                </div>
                {setup.selected.length > 20 && (
                  <div className={s.field}>
                    <label htmlFor="selected-run-search">Find selected evaluations</label>
                    <input
                      id="selected-run-search"
                      type="search"
                      value={selectedQuery}
                      onChange={(event) => {
                        setSelectedQuery(event.target.value);
                        setSelectedPage(1);
                      }}
                    />
                  </div>
                )}
                <div className={r.selectedList} role="group" aria-label="Selected evaluations">
                  {selectedRows
                    .slice((visibleSelectedPage - 1) * 20, visibleSelectedPage * 20)
                    .map((item) => {
                      const check = item.evaluationId ? selectedLibrary[item.evaluationId] : null;
                      const current = check?.current ? evaluationLaunchSource(check.current) : null;
                      const changed = current && current.id !== item.id;
                      const planned = preview?.evaluation?.evaluations.find(
                        (entry) => entry.draftId === item.draftId,
                      );
                      return (
                        <div className={r.selectionRow} key={item.id}>
                          <div>
                            <strong>{item.title}</strong>
                            <p className={s.small}>
                              {planned
                                ? planned.preparation
                                  ? "Prepared when you start"
                                  : "Prepared checks ready to reuse"
                                : item.kind === "draft"
                                  ? "Checking whether preparation is needed"
                                  : "Prepared checks selected"}
                            </p>
                            {item.evaluationId &&
                              check &&
                              (check.error || !current || current.archived || changed) && (
                                <p className={s.small} role="status">
                                  {check.error
                                    ? "Couldn’t check the library. Your selection stays the same."
                                    : !current
                                      ? "This evaluation is no longer in the library. Your selection stays the same."
                                      : current.archived
                                        ? "This evaluation was archived. Your selection stays the same."
                                        : changed
                                          ? current.draftId === item.draftId
                                            ? "Its prepared checks changed. Your selection stays the same."
                                            : "A newer saved version exists. Your selection keeps the earlier one."
                                          : ""}
                                </p>
                              )}
                            {changed && !current.archived && (
                              <button
                                type="button"
                                className={s.textButton}
                                disabled={busy || !ready}
                                onClick={() =>
                                  update({
                                    ...setup,
                                    selected: setup.selected.flatMap((selected) =>
                                      selected.id === item.id
                                        ? [current]
                                        : selected.id === current.id ||
                                            selected.evaluationId === current.evaluationId
                                          ? []
                                          : [selected],
                                    ),
                                  })
                                }
                              >
                                Use current saved evaluation
                              </button>
                            )}
                            {check?.error && (
                              <button
                                type="button"
                                className={s.textButton}
                                disabled={busy}
                                onClick={() => setLibraryRefresh((value) => value + 1)}
                              >
                                Check library again
                              </button>
                            )}
                          </div>
                          <div className={s.row}>
                            <Link
                              className={s.textButton}
                              href={
                                item.evaluationId
                                  ? `/evaluations/new?${new URLSearchParams({ evaluation: item.evaluationId, run: intent, state: params.get("state") ?? intent, replace: item.id, ...(amendment ? { workflow: amendment.id } : {}) })}`
                                  : `/evaluations/${item.id}`
                              }
                              aria-label={`${item.evaluationId ? (changed ? "Edit current saved evaluation for" : "Edit") : "View"} ${item.title}`}
                              aria-disabled={busy}
                              onClick={(event) => {
                                if (busy) event.preventDefault();
                              }}
                            >
                              {item.evaluationId ? (changed ? "Edit current" : "Edit") : "View"}
                            </Link>
                            {changed && (
                              <Link className={s.textButton} href={`/evaluations/${item.id}`}>
                                View selection
                              </Link>
                            )}
                            <button
                              type="button"
                              className={s.textButton}
                              disabled={busy}
                              onClick={() =>
                                update({
                                  ...setup,
                                  selected: setup.selected.filter(
                                    (selected) => selected.id !== item.id,
                                  ),
                                })
                              }
                              aria-label={"Remove " + item.title}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
                {selectedRows.length > 20 && (
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
              </>
            )}
            {setup.selected.length > 0 && (
              <button
                id="evaluation-chooser"
                type="button"
                className={s.textButton}
                aria-expanded={showLibrary}
                aria-controls="evaluation-library"
                onClick={() => setChooserOpen(!showLibrary)}
              >
                {showLibrary ? "Hide evaluation library" : "Add evaluations"}
              </button>
            )}
            {showLibrary && (
              <div id="evaluation-library">
                {libraryError && (
                  <Notice>
                    {libraryError}{" "}
                    {library
                      ? "The list shows the evaluations from the last successful search."
                      : "This search shows no results."}{" "}
                    <button
                      className={s.secondary}
                      onClick={() => setLibraryRefresh((value) => value + 1)}
                    >
                      Retry search
                    </button>
                  </Notice>
                )}
                <div className={s.field}>
                  <label htmlFor="evaluation-search">Search evaluations</label>
                  <input
                    id="evaluation-search"
                    type="search"
                    value={query}
                    disabled={busy}
                    onChange={(e) => filter(e.target.value, 1, true)}
                  />
                </div>
                <div className={r.selectionHeading}>
                  <p className={s.small} role="status">
                    {libraryLoading
                      ? "Finding evaluations…"
                      : `${library?.total ?? 0} ${library?.total === 1 ? "evaluation" : "evaluations"} ${query ? "found" : "available"}`}
                  </p>
                  {query && (
                    <button
                      type="button"
                      className={s.textButton}
                      disabled={busy}
                      onClick={() => filter("", 1)}
                    >
                      Clear search
                    </button>
                  )}
                </div>
                <div className={s.smallStack} aria-busy={libraryLoading}>
                  {library?.items.map((entry) => {
                    const item = evaluationLaunchSource(entry);
                    return (
                      <label className={s.choice} key={item.evaluationId ?? item.id}>
                        <input
                          type="checkbox"
                          disabled={busy || !ready}
                          checked={setup.selected.some(
                            (selected) =>
                              selected.id === item.id &&
                              selected.evaluationId === item.evaluationId,
                          )}
                          onChange={(e) =>
                            update({
                              ...setup,
                              selected: e.target.checked
                                ? [
                                    ...setup.selected.filter(
                                      (selected) =>
                                        selected.id !== item.id &&
                                        (!item.evaluationId ||
                                          selected.evaluationId !== item.evaluationId),
                                    ),
                                    item,
                                  ]
                                : setup.selected.filter((s) => s.id !== item.id),
                            })
                          }
                        />
                        <span>
                          {item.title}
                          <small>
                            {item.kind === "draft" ? "Draft · prepared when you start" : "Ready"}
                          </small>
                          {item.description && (
                            <small className={r.choiceDescription}>{item.description}</small>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {!libraryLoading && library?.total === 0 && (
                  <EmptyState
                    title={query ? "No evaluations match" : "Create your first evaluation"}
                  >
                    {query
                      ? "Clear the search or try a different title."
                      : "Add a prompt and private success criteria. You can save and edit freely before you start a run."}
                  </EmptyState>
                )}
                {library && library.pages > 1 && (
                  <div className={s.toolbar}>
                    <button
                      className={s.secondary}
                      disabled={busy || libraryLoading || page <= 1}
                      onClick={() => filter(query, page - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      {page} of {library.pages}
                    </span>
                    <button
                      className={s.secondary}
                      disabled={busy || libraryLoading || page >= library.pages}
                      onClick={() => filter(query, page + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            )}
            {!amendment && suites.length > 0 && (
              <details>
                <summary>Use a saved suite</summary>
                <p className={s.small}>Use the suite’s saved evaluations in a new benchmark.</p>
                {suites.map((suite) => (
                  <p key={suite.id}>
                    <Link className={s.action} href={`/runs/new?collection=${suite.snapshotId}`}>
                      {suite.title} · {suite.memberCount} evaluations
                    </Link>
                  </p>
                ))}
              </details>
            )}
          </section>
          <section className={`${s.panel} ${s.step}`}>
            {invalidSettings && (
              <p className={s.small} role="status">
                Saved model or tool settings are no longer available. Choose your models again.
              </p>
            )}
            <RunOptions
              value={setup.options}
              onChange={(options) => update({ ...setup, options })}
              models={catalog.models}
              harnesses={catalog.harnesses}
              disabled={busy || !ready || !!amendment}
            />
          </section>
        </div>
        <aside className={s.launchAside}>
          <section className={`${s.panel} ${s.slab}`} id="run-spending">
            <h2>Confirm & start</h2>
            <LaunchBudget
              value={setup.ceiling}
              onChange={(ceiling) => update({ ...setup, ceiling })}
              disabled={busy || !!amendment}
            />
            <p className={`${s.section} ${s.equation}`}>
              {setup.selected.length} {setup.selected.length === 1 ? "evaluation" : "evaluations"}
              {stageCount > setup.selected.length ? ` (${stageCount} stages)` : ""} ×{" "}
              {setup.options.builderModelIds.length}{" "}
              {setup.options.builderModelIds.length === 1 ? "model" : "models"}
              {setup.options.repetitions > 1
                ? " × " + setup.options.repetitions + " repetitions"
                : ""}
              {setup.options.harnessIds.length > 1
                ? " × " + setup.options.harnessIds.length + " tool sets"
                : ""}{" "}
              ={" "}
              <strong>
                {builds} {builds === 1 ? "build" : "builds"}
              </strong>
              .
            </p>
            <p className={s.small}>
              {counted(setup.options.capturePasses, "observation")} per build.
            </p>
            <dl className={r.scope}>
              <div className={r.readinessRow}>
                <dt>Models</dt>
                <dd>{selectedModels.map((model) => model.name).join(", ") || "None selected"}</dd>
              </div>
              <div className={r.readinessRow}>
                <dt>Tools</dt>
                <dd>
                  {setup.options.harnessIds
                    .map(
                      (id) => catalog.harnesses.find((harness) => harness.id === id)?.title ?? id,
                    )
                    .join(", ") || "None selected"}
                </dd>
              </div>
              <div className={r.readinessRow}>
                <dt>Preparation</dt>
                <dd>
                  {preparationCount
                    ? `${preparationCount} ${preparationCount === 1 ? "evaluation" : "evaluations"} to prepare`
                    : setup.selected.length
                      ? preparationCount === 0
                        ? "Reuse prepared checks"
                        : previewing
                          ? "Checking selection…"
                          : "Not checked yet"
                      : "Choose evaluations first"}
                </dd>
              </div>
            </dl>
            {preview ? (
              <LaunchSummary
                description=""
                budget={preview.budget}
                timeLimits={preview.timeLimits}
              />
            ) : (
              <p className={s.small}>The preview is free and does not start models or Studio.</p>
            )}
            <button
              className={s.primary}
              disabled={busy || !!reason}
              onClick={start}
              aria-describedby="start-explanation"
            >
              {busy
                ? "Starting…"
                : (amendment ? "Save changes & continue · limit " : "Run benchmark · limit ") +
                  (setup.ceiling.trim() ? formatMoney(Number(setup.ceiling)) : "—")}
            </button>
            <p
              id="start-explanation"
              className={s.small}
              role="status"
              style={{ overflowWrap: "anywhere" }}
            >
              {reason ||
                (prerequisites.some((check) => !check.ready)
                  ? "Finish setup in Settings before you start. The preview is free."
                  : setup.ceiling.trim() && Number(setup.ceiling) === 0
                    ? "With a $0.00 limit, the run pauses before the first paid request."
                    : "The preview is free. When you start, the run can cost up to this limit.")}
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
