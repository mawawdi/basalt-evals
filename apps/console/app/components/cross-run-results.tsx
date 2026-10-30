"use client";
import { Fragment, useState, useTransition, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReviewSelectionView } from "../../../../dist/packages/contracts/src/console.js";
import type { ReviewRunSelection } from "../../../../dist/packages/contracts/src/review.js";
import type { ResultSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import { statusLabel } from "../../../../dist/packages/contracts/src/catalog.js";
import { AuditLauncher } from "./audit-launcher";
import { ScrollRegion, EmptyState, Dialog, Notice, Status } from "./ui";
import { action, read, message } from "./api";
import {
  buildCostLabel,
  buildStateLabel,
  buildTimeLabel,
  observationLabel,
  outcomeAvailability,
  outcomeCount,
} from "./result-display";
import s from "./workbench.module.css";
type Selection = ReviewSelectionView;
/** The tone of the words of observationLabel(), in the same order, so both agree. */
function captureTone(capture: ResultSummary["captures"][number]) {
  if (capture.state !== "collected" || !capture.planned || capture.unavailable)
    return s.captureMissing;
  if (capture.rejected) return s.captureFailed;
  if (capture.split) return s.captureMet;
  if (capture.insufficient) return s.captureInsufficient;
  return s.captureMet;
}
export function CrossRunResults({
  rows,
  selection,
  selectionError = "",
  filtered = false,
}: {
  rows: ResultSummary[];
  selection: Selection | null;
  selectionError?: string;
  filtered?: boolean;
}) {
  const router = useRouter(),
    params = useSearchParams();
  const [saving, setBusy] = useState(false),
    [error, setError] = useState("");
  const [navigating, startTransition] = useTransition();
  const busy = saving || navigating;
  const [inspecting, setInspecting] = useState(false),
    [inspection, setInspection] = useState<Selection | null>(null);
  const [showTools, setShowTools] = useState(false);
  const inspectionRequest = useRef(0);
  const [inspectionLoading, setInspectionLoading] = useState(false),
    [inspectionPage, setInspectionPage] = useState(1);
  useEffect(() => {
    inspectionRequest.current++;
    setInspection(null);
    setInspectionPage(1);
  }, [selection?.id]);
  const selected = selection?.operationIds ?? [];
  const order = params.get("order") ?? "recent";
  const orderedRows = [...rows].sort(
    (a, b) =>
      a.evaluationTitle.localeCompare(b.evaluationTitle) ||
      a.evaluationId.localeCompare(b.evaluationId) ||
      (order === "model"
        ? a.model.localeCompare(b.model)
        : order === "cost"
          ? (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity)
          : order === "time"
            ? (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity)
            : 0),
  );
  const inspected = inspection?.id === selection?.id ? inspection : selection;
  async function change(operationIds: string[]) {
    setBusy(true);
    setError("");
    try {
      const value = await action<ReviewRunSelection>(
        "/api/review-batches/selections",
        "create_review_selection",
        { operationIds },
      );
      const query = new URLSearchParams(params.toString());
      query.set("selection", value.id);
      startTransition(() => router.push(`/?${query}`, { scroll: false }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(page = 1) {
    if (!selection) return;
    setInspecting(true);
    setError("");
    const ticket = ++inspectionRequest.current;
    setInspectionLoading(true);
    setInspectionPage(page);
    try {
      const value = await read<Selection>(
        `/api/review-batches/selections/${selection.id}?page=${page}`,
      );
      if (ticket === inspectionRequest.current) setInspection(value);
    } catch (cause) {
      if (ticket === inspectionRequest.current)
        setError(`Selected runs, page ${page}: ${message(cause)}`);
    } finally {
      if (ticket === inspectionRequest.current) setInspectionLoading(false);
    }
  }
  function clear() {
    const query = new URLSearchParams(params.toString());
    query.delete("selection");
    startTransition(() => router.push(`/?${query}`, { scroll: false }));
    setInspecting(false);
  }
  const captures = [
    ...new Set(rows.flatMap((row) => row.captures.map((capture) => capture.number))),
  ].sort((a, b) => a - b);
  const target = (row: ResultSummary) =>
    `/runs/${row.operationId}?tab=evidence&candidate=${row.candidateId}`;
  return (
    <>
      {!!rows.length && (
        <div className={s.sectionHeading}>
          <p className={s.small}>
            {rows.length} build {rows.length === 1 ? "record" : "records"} on this page
          </p>
          {!!rows.length && (
            <div className={s.row}>
              <div className={s.field}>
                <label htmlFor="result-order">Order this page</label>
                <select
                  id="result-order"
                  value={order}
                  onChange={(event) => {
                    const next = new URLSearchParams(params.toString());
                    if (event.target.value === "recent") next.delete("order");
                    else next.set("order", event.target.value);
                    window.history.pushState(null, "", `/?${next}`);
                  }}
                >
                  <option value="recent">Most recent within evaluation</option>
                  <option value="model">Model name within evaluation</option>
                  <option value="cost">Lowest build cost within evaluation</option>
                  <option value="time">Shortest build time within evaluation</option>
                </select>
              </div>
              <details>
                <summary>Columns</summary>
                <label className={s.acknowledge}>
                  <input
                    type="checkbox"
                    checked={showTools}
                    onChange={(event) => setShowTools(event.target.checked)}
                  />
                  Tool calls
                </label>
              </details>
            </div>
          )}
        </div>
      )}
      {(error || selectionError) && (
        <Notice>
          {error || selectionError}
          <button className={s.secondary} onClick={clear}>
            Clear selection
          </button>
        </Notice>
      )}
      {selected.length > 0 && (
        <section className={`${s.panel} ${s.panelBody}`} aria-label="Selected runs">
          <div className={s.row}>
            <strong role="status">
              {selected.length} {selected.length === 1 ? "run" : "runs"} selected
            </strong>
            <button className={s.secondary} disabled={busy} onClick={() => void inspect()}>
              Inspect selection
            </button>
            <button className={s.secondary} disabled={busy} onClick={clear}>
              Clear
            </button>
            <AuditLauncher key={selection!.id} operationIds={selected} />
            {selected.length >= 2 && selected.length <= 6 && (
              <Link
                className={s.secondary}
                href={`/?view=comparisons&${selected.map((id) => `compare=${id}`).join("&")}&selection=${selection!.id}`}
              >
                Compare selected runs
              </Link>
            )}
          </div>
          <p className={s.small}>
            The selection includes every build in each selected run, across all result pages.
          </p>
        </section>
      )}
      <Dialog
        open={inspecting && !!selection}
        onClose={() => {
          inspectionRequest.current++;
          setInspecting(false);
        }}
        title="Selected runs"
      >
        {error && (
          <Notice>
            {error}
            <button className={s.secondary} onClick={() => void inspect(inspectionPage)}>
              Retry selected runs
            </button>
          </Notice>
        )}
        {inspectionLoading && <p role="status">Loading selected runs, page {inspectionPage}…</p>}
        {inspected && inspected.page !== inspectionPage && (
          <p className={s.small}>Showing page {inspected.page} until the requested page loads.</p>
        )}
        {inspected?.items.map((item) => (
          <div key={item.operationId} className={s.sectionHeading}>
            <div>
              {item.unavailable ? (
                <strong>{item.title}</strong>
              ) : (
                <Link className={s.tableTitle} href={`/runs/${item.operationId}`}>
                  {item.title}
                </Link>
              )}
              <p className={s.small}>{item.unavailable ?? statusLabel(item.state)}</p>
            </div>
            <button
              className={s.secondary}
              disabled={busy || inspectionLoading}
              onClick={() => void change(selected.filter((id) => id !== item.operationId))}
              aria-label={`Remove ${item.title}`}
            >
              Remove
            </button>
          </div>
        ))}
        {inspected && inspected.pages > 1 && (
          <div className={s.row}>
            <button
              className={s.secondary}
              disabled={inspectionPage === 1}
              onClick={() => void inspect(inspectionPage - 1)}
            >
              Previous runs
            </button>
            <span>
              {inspectionPage} / {inspected.pages}
            </span>
            <button
              className={s.secondary}
              disabled={inspectionPage >= inspected.pages}
              onClick={() => void inspect(inspectionPage + 1)}
            >
              More runs
            </button>
          </div>
        )}
      </Dialog>
      {!rows.length && (
        <EmptyState
          title={
            filtered ? "No results match these filters" : "Your first results will appear here"
          }
          href={
            filtered
              ? `/?${params.get("selection") ? `selection=${encodeURIComponent(params.get("selection")!)}` : ""}`
              : "/runs/new"
          }
          label={filtered ? "Clear filters" : "Run a benchmark"}
        >
          {filtered
            ? "Try a different evaluation, model or status. Your selected runs stay selected."
            : "Create or choose an evaluation, pick a model and set a spending limit to get started."}
        </EmptyState>
      )}
      <div className={s.comparisonCards}>
        {orderedRows.map((row) => (
          <article key={row.id} className={`${s.panel} ${s.panelBody}`}>
            <p className={s.small}>{row.evaluationTitle}</p>
            <h3>
              <Link className={s.tableTitle} href={target(row)}>
                {row.candidateTitle}
              </Link>
            </h3>
            <p>
              <Status>{buildStateLabel(row.buildState, row.kind)}</Status>
            </p>
            <p className={s.small}>
              {row.model} · {row.harness && `${row.harness} · `}
              {row.kind === "generated"
                ? "Model build"
                : row.kind === "retained"
                  ? "Reused build"
                  : row.kind === "repair"
                    ? "Repair attempt"
                    : "Control"}
            </p>
            <div className={s.row}>
              {row.captures.map((capture) => (
                <Link
                  key={capture.number}
                  className={s.secondary}
                  href={`${target(row)}&pass=${capture.number}`}
                >
                  Observation {capture.number} · {observationLabel(capture, row.state === "active")}
                </Link>
              ))}
            </div>
            <dl className={s.factList}>
              <div>
                <dt>Code checks</dt>
                <dd>
                  {outcomeCount(row.functional)}
                  <span className={s.tableMeta}>
                    {outcomeAvailability(row.functional, row.state === "active")}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Judge checks</dt>
                <dd>
                  {outcomeCount(row.qualitative)}
                  <span className={s.tableMeta}>
                    {outcomeAvailability(row.qualitative, row.state === "active")}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Build cost</dt>
                <dd>{buildCostLabel(row)}</dd>
              </div>
              {showTools && (
                <div>
                  <dt>Tool calls</dt>
                  <dd>{row.toolCalls ?? "Unknown"}</dd>
                </div>
              )}
              <div>
                <dt>Build time</dt>
                <dd>{buildTimeLabel(row)}</dd>
              </div>
            </dl>
            <label className={s.acknowledge}>
              <input
                type="checkbox"
                disabled={busy || !!selectionError}
                checked={selected.includes(row.operationId)}
                onChange={(event) =>
                  void change(
                    event.target.checked
                      ? [...selected, row.operationId]
                      : selected.filter((id) => id !== row.operationId),
                  )
                }
              />
              Select this run for comparison or review
            </label>
          </article>
        ))}
      </div>
      {!!rows.length && (
        <ScrollRegion
          className={`${s.tableWrap} ${s.desktopComparison}`}
          label="Results across evaluations"
        >
          <table className={s.resultTable}>
            <thead>
              <tr>
                <th scope="col">Select</th>
                <th scope="col" aria-sort={order === "model" ? "ascending" : "none"}>
                  Build
                </th>
                {captures.map((number) => (
                  <th scope="col" key={number}>
                    Observation {number}
                  </th>
                ))}
                <th scope="col">Code checks</th>
                <th scope="col">Judge checks</th>
                <th scope="col" aria-sort={order === "cost" ? "ascending" : "none"}>
                  Build cost
                </th>
                {showTools && <th scope="col">Tool calls</th>}
                <th scope="col" aria-sort={order === "time" ? "ascending" : "none"}>
                  Build time
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedRows.map((row, index) => (
                <Fragment key={row.id}>
                  {orderedRows[index - 1]?.evaluationId !== row.evaluationId && (
                    <tr className={s.groupHeading}>
                      <th scope="rowgroup" colSpan={6 + captures.length + Number(showTools)}>
                        <Link className={s.tableTitle} href={`/evaluations/${row.evaluationId}`}>
                          {row.evaluationTitle}
                        </Link>
                      </th>
                    </tr>
                  )}
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include whole run for ${row.candidateTitle} from ${row.evaluationTitle}`}
                        disabled={busy || !!selectionError}
                        checked={selected.includes(row.operationId)}
                        onChange={(event) =>
                          void change(
                            event.target.checked
                              ? [...selected, row.operationId]
                              : selected.filter((id) => id !== row.operationId),
                          )
                        }
                      />
                    </td>
                    <th scope="row">
                      <Link className={s.tableTitle} href={target(row)}>
                        {row.candidateTitle}
                      </Link>
                      <span className={s.tableMeta}>
                        <Status>{buildStateLabel(row.buildState, row.kind)}</Status>
                      </span>
                      <span className={s.tableMeta}>
                        {row.model} · {row.harness && `${row.harness} · `}
                        {row.kind === "generated"
                          ? "Model build"
                          : row.kind === "retained"
                            ? "Reused build"
                            : row.kind === "repair"
                              ? "Repair attempt"
                              : "Control"}
                      </span>
                    </th>
                    {captures.map((number) => {
                      const capture = row.captures.find((capture) => capture.number === number);
                      return (
                        <td key={number}>
                          {capture ? (
                            <Link
                              className={`${s.captureCell} ${captureTone(capture)}`}
                              href={`${target(row)}&pass=${number}`}
                            >
                              <span>{observationLabel(capture, row.state === "active")}</span>
                              <small>{outcomeCount(capture)}</small>
                            </Link>
                          ) : (
                            "Not planned"
                          )}
                        </td>
                      );
                    })}
                    {[row.functional, row.qualitative].map((counts, i) => (
                      <td key={i}>
                        {outcomeCount(counts)}
                        <span className={s.tableMeta}>
                          {outcomeAvailability(counts, row.state === "active")}
                        </span>
                      </td>
                    ))}
                    <td className={s.numeric}>{buildCostLabel(row)}</td>
                    {showTools && <td className={s.numeric}>{row.toolCalls ?? "Unknown"}</td>}
                    <td className={s.numeric}>{buildTimeLabel(row)}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </>
  );
}
