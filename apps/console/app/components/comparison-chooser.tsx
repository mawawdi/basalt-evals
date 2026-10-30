"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Page, RunSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import { statusLabel } from "../../../../dist/packages/contracts/src/catalog.js";
import type { RunComparison } from "../../../../dist/packages/contracts/src/comparisons.js";
import type { ReviewTreatment } from "../../../../dist/packages/contracts/src/review.js";
import { read, action, message } from "./api";
import { Notice } from "./ui";
import { checkerLabel, comparisonReason } from "./result-display";
import s from "./workbench.module.css";
import c from "../comparisons/comparison.module.css";

/** A comparison has two to six runs. */
const MAXIMUM_COMPARED_RUNS = 6;
const verdict = (value: RunComparison["compatibility"]) =>
  value === "direct"
    ? "Same test conditions"
    : value === "descriptive"
      ? "Conditions differ"
      : "Cannot compare";

export function ComparisonChooser() {
  const router = useRouter(),
    params = useSearchParams();
  // The URL keeps the runs in the order that the person chose them.
  const chosen = [...new Set(params.getAll("compare"))].slice(0, MAXIMUM_COMPARED_RUNS),
    q = params.get("compareQuery") ?? "",
    number = Math.max(1, Math.floor(Number(params.get("comparePage")) || 1));
  const requested = Object.fromEntries(
    chosen.map((id) => [id, params.get(`treatment.${id}`) ?? ""]),
  );
  const [page, setPage] = useState<Page<RunSummary> | null>(null),
    [known, setKnown] = useState<Record<string, RunSummary>>({}),
    [catalog, setCatalog] = useState<Array<{ operationId: string; treatments: ReviewTreatment[] }>>(
      [],
    ),
    [treatments, setTreatments] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<RunComparison | null>(null),
    [previewKey, setPreviewKey] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // The runs and judge choices that the loaded judges belong to. Until they match the current
  // choice, the judges are still loading, so a preview can't start from a stale choice.
  const [catalogFor, setCatalogFor] = useState("");
  const [catalogError, setCatalogError] = useState(""),
    [catalogAttempt, setCatalogAttempt] = useState(0),
    [searchAttempt, setSearchAttempt] = useState(0);
  const selectionKey = JSON.stringify(chosen.map((id) => [id, treatments[id] ?? ""]));
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const activePreview = previewKey === selectionKey ? preview : null;
  const chosenKey = chosen.join(",");
  const requestedKey = JSON.stringify(requested);
  const loadKey = `${chosenKey}|${requestedKey}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPage(null);
    void read<Page<RunSummary>>(
      `/api/runs?q=${encodeURIComponent(q)}&page=${number}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setPage(value);
        setError("");
        setKnown((current) => ({
          ...current,
          ...Object.fromEntries(value.items.map((item) => [item.id, item])),
        }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [q, number, searchAttempt]);
  useEffect(() => {
    setPreview(null);
    setCatalog([]);
    setTreatments({});
    setError("");
    if (chosen.length < 2) return;
    let active = true;
    void action<{ items: Array<{ operationId: string; treatments: ReviewTreatment[] }> }>(
      "/api/review-batches/treatments",
      "review_treatments",
      { operationIds: chosen },
    )
      .then((value) => {
        if (!active) return;
        setCatalog(value.items);
        setCatalogFor(loadKey);
        setCatalogError("");
        setTreatments(
          Object.fromEntries(
            value.items.map((item) => {
              const available = item.treatments.filter((t) => t.evidenceCondition === "original");
              const wanted = requested[item.operationId] ?? "";
              return [
                item.operationId,
                available.some((t) => t.id === wanted)
                  ? wanted
                  : available.length === 1
                    ? available[0]!.id
                    : "",
              ];
            }),
          ),
        );
      })
      .catch((cause) => active && setCatalogError(message(cause)));
    return () => {
      active = false;
    };
  }, [chosenKey, requestedKey, catalogAttempt]);
  function write(next: URLSearchParams, replace = false) {
    next.set("view", "comparisons");
    if (replace) window.history.replaceState(null, "", `/?${next}`);
    else window.history.pushState(null, "", `/?${next}`);
  }
  function toggle(id: string, checked: boolean) {
    if (busy) return;
    const next = new URLSearchParams(params.toString());
    const runs = checked ? [...chosen, id] : chosen.filter((item) => item !== id);
    next.delete("compare");
    for (const run of runs.slice(0, MAXIMUM_COMPARED_RUNS)) next.append("compare", run);
    if (!checked) next.delete(`treatment.${id}`);
    write(next);
  }
  function search(key: "compareQuery" | "comparePage", value: string) {
    if (busy) return;
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "compareQuery") next.delete("comparePage");
    write(next, key === "compareQuery");
  }
  const runLabel = (id: string) => {
    const run = known[id];
    return run ? `${run.title} · ${run.models.join(", ") || "saved build"}` : "Selected run";
  };
  const reason =
    chosen.length < 2
      ? "Choose two to six runs to compare their recorded conditions and results."
      : !catalog.length || catalogFor !== loadKey
        ? catalogError
          ? "Couldn’t load the judges. Try again."
          : "Loading judges…"
        : catalog.some(
              (item) =>
                item.treatments.some((t) => t.evidenceCondition === "original") &&
                !treatments[item.operationId],
            )
          ? "Choose a judge for each run."
          : "";
  const full = chosen.length >= MAXIMUM_COMPARED_RUNS;
  return (
    <section className={`${s.panel} ${s.panelBody}`}>
      <div className={s.sectionHeading}>
        <h2>Compare saved runs</h2>
        {(chosen.length > 0 || q) && (
          <button
            className={s.secondary}
            disabled={busy}
            onClick={() => {
              const next = new URLSearchParams(params.toString());
              for (const key of [...next.keys()])
                if (
                  key === "compare" ||
                  key.startsWith("treatment.") ||
                  key === "compareQuery" ||
                  key === "comparePage"
                )
                  next.delete(key);
              setPreview(null);
              write(next);
            }}
          >
            Clear comparison
          </button>
        )}
      </div>
      <p className={s.small}>
        Choose two to six runs and preview the differences before you save a report. Comparing saved
        evidence doesn’t run models or Studio.
      </p>
      {error && (
        <Notice>
          {error}
          <button className={s.secondary} onClick={() => setSearchAttempt((value) => value + 1)}>
            Find runs again
          </button>
        </Notice>
      )}
      {catalogError && (
        <Notice>
          {catalogError}
          <button className={s.secondary} onClick={() => setCatalogAttempt((value) => value + 1)}>
            Reload judges
          </button>
        </Notice>
      )}
      <div className={s.form}>
        <div className={s.field}>
          <label htmlFor="comparison-search">Find runs</label>
          <input
            id="comparison-search"
            type="search"
            disabled={busy}
            value={q}
            onChange={(event) => search("compareQuery", event.target.value)}
          />
        </div>
        {chosen.length > 0 && (
          <ol className={c.chosen} aria-label="Runs to compare">
            {chosen.map((id, index) => (
              <li key={id}>
                <span className={c.runNumber}>Run {index + 1}</span>
                <span>{runLabel(id)}</span>
                <button
                  className={s.textButton}
                  disabled={busy}
                  aria-label={`Remove run ${index + 1}: ${runLabel(id)}`}
                  onClick={() => toggle(id, false)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <fieldset className={c.runChoices} disabled={busy}>
          <legend>Runs</legend>
          {page?.items.map((item) => {
            const checked = chosen.includes(item.id);
            return (
              <label className={s.choice} key={item.id}>
                <input
                  type="checkbox"
                  value={item.id}
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(event) => toggle(item.id, event.target.checked)}
                />
                <span>
                  {item.title}
                  <small>
                    {item.models.join(", ") || "Saved build"} · {statusLabel(item.state)} ·{" "}
                    {new Date(item.startedAt ?? item.updatedAt).toLocaleString()}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className={s.small} role="status">
          {loading
            ? "Finding runs…"
            : page?.total
              ? `${page.total} runs available · ${chosen.length} of ${MAXIMUM_COMPARED_RUNS} chosen`
              : q
                ? "No runs match this search. Clear the search to see available runs."
                : "No saved runs yet. Run a benchmark to collect evidence for comparison."}
        </p>
        <div className={s.row}>
          <button
            className={s.secondary}
            disabled={busy || loading || number <= 1}
            onClick={() => search("comparePage", String(number - 1))}
          >
            Previous page
          </button>
          <span>
            {page?.page ?? 1} / {page?.pages ?? 1}
          </span>
          <button
            className={s.secondary}
            disabled={busy || loading || !page || number >= page.pages}
            onClick={() => search("comparePage", String(number + 1))}
          >
            Next page
          </button>
        </div>
        {catalog.map((item) => {
          const available = item.treatments.filter((t) => t.evidenceCondition === "original");
          const position = chosen.indexOf(item.operationId) + 1;
          return available.length > 1 ? (
            <div className={s.field} key={item.operationId}>
              <label htmlFor={`treatment-${item.operationId}`}>Judge for run {position}</label>
              <select
                id={`treatment-${item.operationId}`}
                value={treatments[item.operationId] ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setTreatments({ ...treatments, [item.operationId]: event.target.value });
                  const next = new URLSearchParams(params.toString());
                  if (event.target.value)
                    next.set(`treatment.${item.operationId}`, event.target.value);
                  else next.delete(`treatment.${item.operationId}`);
                  write(next);
                  setPreview(null);
                }}
              >
                <option value="">Choose a judge</option>
                {available.map((treatment) => (
                  <option key={treatment.id} value={treatment.id}>
                    {checkerLabel(treatment)}
                  </option>
                ))}
              </select>
            </div>
          ) : null;
        })}
        {activePreview && (
          <Notice kind="info">
            <strong>{verdict(activePreview.compatibility)}</strong>
            {activePreview.pairs
              .filter((pair) => pair.compatibility !== "direct")
              .slice(0, 3)
              .map((pair) => (
                <p key={`${pair.left}:${pair.right}`}>
                  Run {chosen.indexOf(pair.left) + 1} and run {chosen.indexOf(pair.right) + 1}:{" "}
                  {comparisonReason(pair.reasons[0]!)}
                </p>
              ))}
          </Notice>
        )}
        <button
          className={s.primary}
          disabled={busy || !!reason}
          aria-describedby="comparison-readiness"
          onClick={() => {
            setBusy(true);
            setError("");
            const key = selectionKey;
            void (async () => {
              if (!activePreview) {
                const value = await action<RunComparison>(
                  "/api/comparisons/preview",
                  "preview_comparison",
                  {
                    populations: chosen.map((id) => ({
                      operationId: id,
                      treatmentId: treatments[id] || null,
                    })),
                  },
                );
                if (currentSelection.current === key) {
                  setPreview(value);
                  setPreviewKey(key);
                }
              } else {
                const saved = await action<{ id: string }>(
                  "/api/comparisons",
                  "create_comparison",
                  { previewId: activePreview.id },
                );
                if (currentSelection.current === key) router.push(`/comparisons/${saved.id}`);
              }
            })()
              .catch((cause) => {
                if (currentSelection.current === key) setError(message(cause));
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy
            ? activePreview
              ? "Saving report…"
              : "Checking conditions…"
            : activePreview
              ? "Save comparison report"
              : "Preview comparison"}
        </button>
        <p id="comparison-readiness" className={s.small} role="status">
          {reason ||
            (activePreview
              ? "Save this report to return to the same comparison later."
              : "Preview checks the recorded test conditions and costs nothing.")}
        </p>
      </div>
    </section>
  );
}
