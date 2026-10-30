"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { statusLabel } from "../../../../dist/packages/contracts/src/catalog.js";
import type {
  BenchmarkReport,
  BenchmarkCatalogEntry,
  BenchmarkRoleTelemetry,
  BenchmarkTreatmentReport,
} from "../../../../dist/packages/contracts/src/benchmarks.js";
import { read, formatMoney, message } from "./api";
import { OutcomeBar } from "./ui";
import { OutcomeGrid, gridMeasures, type GridMeasure } from "./outcome-grid";
import { EvidenceClasses } from "./evidence-classes";
import { CostCoverage } from "./cost-coverage";
import { PlanWarningNote } from "./plan-warning-note";
import { CauseList, mergeCauses } from "./cause-list";
import s from "./workbench.module.css";
import b from "./benchmark.module.css";
import { countList, stageLabel, statementText } from "./result-display";
// A finished benchmark that has no time for a part will not get one later.
const elapsed = (ms: number | null, settled: boolean) =>
  ms === null
    ? settled
      ? "Not recorded"
      : "Not timed yet"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${(ms / 60000).toFixed(1)} min`;
const amount = (n: number | null) => (n === null ? "Not confirmed yet" : formatMoney(n));
const roleNames: Record<BenchmarkRoleTelemetry["role"], string> = {
  builder: "Builder",
  grader: "Judge",
  preparation: "Test preparation",
  other: "Other work",
};
// inputTokens reads as "Input tokens".
const tokenLabel = (key: string) => {
  const words = key.replace(/([A-Z])/gu, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const role = (row: BenchmarkTreatmentReport, key: BenchmarkRoleTelemetry["role"]) =>
  row.telemetry.roles.find((item) => item.role === key)!;
// Figures stay mono; words standing in for a missing figure read in the interface face.
function Figure({ children }: { children: string }) {
  return <strong className={/^[<$\d]/u.test(children) ? undefined : b.words}>{children}</strong>;
}
function Tokens({ row }: { row: BenchmarkTreatmentReport }) {
  const builder = role(row, "builder"),
    input = builder.tokens.inputTokens,
    output = builder.tokens.outputTokens;
  if (input.knownTotal === null && output.knownTotal === null)
    return (
      <>
        <Figure>Not counted yet</Figure>
        {input.eligibleRequests > 0 && (
          <small>No counts for {input.eligibleRequests} requests</small>
        )}
      </>
    );
  return (
    <>
      <strong>
        {input.knownTotal === null ? "Not counted" : input.knownTotal.toLocaleString()} in ·{" "}
        {output.knownTotal === null ? "Not counted" : output.knownTotal.toLocaleString()} out
      </strong>
      <small>
        {input.knownRequests === output.knownRequests &&
        input.eligibleRequests === output.eligibleRequests
          ? input.knownRequests === input.eligibleRequests
            ? `Counted for all ${input.eligibleRequests} ${input.eligibleRequests === 1 ? "request" : "requests"}`
            : `Counted for ${input.knownRequests} of ${input.eligibleRequests} requests`
          : `Input ${input.knownRequests}/${input.eligibleRequests} requests · output ${output.knownRequests}/${output.eligibleRequests}`}
      </small>
    </>
  );
}
function Answer({ row, settled }: { row: BenchmarkTreatmentReport; settled: boolean }) {
  const a = row.answers;
  return (
    <>
      <Figure>
        {a.met + a.rejected + a.split + a.scored + a.insufficient > 0
          ? countList([`${a.met} met`, `${a.rejected} not met`])
          : settled
            ? "No answers"
            : "No results yet"}
      </Figure>
      {a.split > 0 && <small>{a.split} split, a person decides</small>}
      {a.scored > 0 && <small>{a.scored} scored, no pass mark</small>}
    </>
  );
}
/** A long list of providers folds into a count, so the model column stays short. */
function Providers({ names, builds }: { names: string[]; builds: number }) {
  const planned = `${builds} planned ${builds === 1 ? "build" : "builds"}`;
  if (names.length <= 3)
    return (
      <small>
        {names.length ? `${names.join(", ")} · ` : ""}
        {planned}
      </small>
    );
  return (
    <>
      <small>{planned}</small>
      <details className={b.providers}>
        <summary>{names.length} providers</summary>
        <small>{names.join(", ")}</small>
      </details>
    </>
  );
}
export function BenchmarkDashboard({
  initialCatalog,
  initialReport,
  initialError,
}: {
  initialCatalog: BenchmarkCatalogEntry[];
  initialReport: BenchmarkReport | null;
  initialError: string;
}) {
  const [catalog, setCatalog] = useState(initialCatalog),
    [report, setReport] = useState(initialReport),
    [error, setError] = useState(initialError),
    [loading, setLoading] = useState(false);
  const params = useSearchParams();
  const selected =
    params.get("campaign") ?? initialReport?.operationId ?? initialCatalog[0]?.id ?? "";
  const requestedView = params.get("benchmarkView");
  const view = ["models", "cases", "classes", "coverage", "details"].includes(requestedView ?? "")
    ? requestedView!
    : "models";
  const harness = params.get("harness") ?? "all";
  const measure: GridMeasure =
    gridMeasures.find(([id]) => id === params.get("benchmarkShow"))?.[0] ?? "answers";
  const open = (params.get("open") ?? "").split(",").filter(Boolean);
  function choose(key: string, value: string) {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    window.history.pushState(null, "", url);
  }
  const sequence = useRef(0);
  const previousSelection = useRef(selected);
  // The run state when the shown report was read. A report changes only while its run is
  // active, so the dashboard reads it again only then, or once when the state changes.
  const reportState = useRef(
    initialReport && {
      id: initialReport.operationId,
      state: initialCatalog.find((row) => row.id === initialReport.operationId)?.state ?? "",
    },
  );
  useEffect(() => {
    // A message about another benchmark must not survive switching to this one.
    if (previousSelection.current !== selected) {
      previousSelection.current = selected;
      setError("");
    }
    let alive = true,
      inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const ticket = ++sequence.current;
      setLoading(true);
      try {
        const rows = await read<BenchmarkCatalogEntry[]>("/api/benchmarks");
        if (!alive || ticket !== sequence.current) return;
        setCatalog(rows);
        const entry = rows.find((row) => row.id === selected);
        if (entry?.frozen) {
          const shown = reportState.current;
          if (shown?.id === entry.id && shown.state === entry.state && entry.state !== "active") {
            setError("");
            return;
          }
          const next = await read<BenchmarkReport>("/api/benchmarks/" + selected);
          if (alive && ticket === sequence.current) {
            reportState.current = { id: entry.id, state: entry.state };
            setReport(next);
            setError("");
          }
        } else if (alive) {
          reportState.current = null;
          setReport(null);
          setError(
            selected && !entry
              ? "This benchmark is unavailable. Choose another saved benchmark."
              : "",
          );
        }
      } catch (cause) {
        if (alive && ticket === sequence.current) setError(message(cause));
      } finally {
        inFlight = false;
        if (alive && ticket === sequence.current) setLoading(false);
      }
    };
    // The server read the report of this selection with the page. The next read waits.
    if (reportState.current?.id !== selected) void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      alive = false;
      sequence.current++;
      clearInterval(timer);
    };
  }, [selected]);
  const entry = catalog.find((row) => row.id === selected),
    current = report?.operationId === selected ? report : null;
  const harnesses = [...new Set(current?.rows.map((row) => row.harnessId) ?? [])];
  const harnessTitles = new Map(current?.rows.map((row) => [row.harnessId, row.harnessTitle]));
  const selectedHarness = harnesses.find((id) => id === harness) ?? "all";
  return (
    <section className={b.dashboard} aria-labelledby="benchmark-heading">
      <h2 id="benchmark-heading" className={b.visuallyHidden}>
        Saved benchmark results
      </h2>
      <div className={b.context}>
        {catalog.length > 0 && (
          <div className={s.field}>
            <label htmlFor="benchmark-campaign">Benchmark</label>
            <select
              id="benchmark-campaign"
              value={selected}
              onChange={(event) => choose("campaign", event.target.value)}
            >
              {!catalog.length && <option value="">No saved benchmarks</option>}
              {catalog.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title} ·{" "}
                  {new Date(row.at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </option>
              ))}
            </select>
          </div>
        )}
        {current && (
          <dl className={b.scope}>
            <div>
              <dt>{current.caseCount === 1 ? "Evaluation" : "Evaluations"}</dt>
              <dd>{current.caseCount}</dd>
            </div>
            <div>
              <dt>Planned {current.plannedBuilds === 1 ? "build" : "builds"}</dt>
              <dd>{current.plannedBuilds}</dd>
            </div>
            <div>
              <dt>Observations</dt>
              <dd>{current.plannedCaptures}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd className={b.scopeState}>
                {current.stopped
                  ? "Stopped"
                  : current.finished
                    ? "Finished automatically"
                    : entry?.state === "attention"
                      ? statusLabel(entry.state)
                      : current.activeUnits.length
                        ? `In progress: ${[
                            ...new Set(current.activeUnits.map((unit) => stageLabel(unit.stage))),
                          ].join(", ")}`
                        : "In progress"}
                {entry?.state === "attention" && !current.stopped && !current.finished && (
                  <Link className={s.action} href={`/runs/${current.operationId}?tab=progress`}>
                    See what needs attention
                  </Link>
                )}
              </dd>
            </div>
          </dl>
        )}
      </div>
      {loading && !current && (
        <p className={b.support} role="status">
          Loading results…
        </p>
      )}
      {error && (
        <p className={b.support} role="status">
          Results unavailable: {error}{" "}
          {selected && (
            <Link className={s.action} href={`/runs/${selected}`}>
              Inspect this run
            </Link>
          )}
        </p>
      )}
      {!current && !error && !loading && (
        <section className={b.empty}>
          <h2>{entry ? "Preparing this benchmark" : "Run your first benchmark"}</h2>
          {entry ? (
            <p>Results appear here as the builds and checks finish.</p>
          ) : (
            <ol className={b.journey}>
              <li>
                <strong>Choose evaluations</strong>
                <span>
                  Each evaluation has a prompt for the model and private success criteria to check
                  the build.
                </span>
              </li>
              <li>
                <strong>Select models</strong>
                <span>Every model builds the same evaluations.</span>
              </li>
              <li>
                <strong>Set a spending limit</strong>
                <span>Builds, observations and checks then run automatically.</span>
              </li>
            </ol>
          )}
          {entry ? (
            <Link className={s.secondary} href={`/runs/${entry.id}?tab=progress`}>
              Open progress
            </Link>
          ) : (
            <div className={s.row}>
              <Link className={s.primary} href="/runs/new">
                Run a benchmark
              </Link>
              <Link className={s.secondary} href="/evaluations/new">
                Create an evaluation
              </Link>
            </div>
          )}
        </section>
      )}
      {current && (
        <>
          <nav className={b.tabs} aria-label="Benchmark views">
            {[
              ["models", "Model comparison"],
              ["cases", "By evaluation"],
              ["classes", "By evidence class"],
              ["coverage", "Cost and coverage"],
              ["details", "Details"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => choose("benchmarkView", id!)}
              >
                {label}
              </button>
            ))}
          </nav>
          <PlanWarningNote report={current} />
          {view !== "details" && (harnesses.length > 1 || view === "cases") && (
            <div className={b.controls}>
              {harnesses.length > 1 && (
                <div className={s.field}>
                  <label htmlFor="benchmark-harness">Tool set</label>
                  <select
                    id="benchmark-harness"
                    value={selectedHarness}
                    onChange={(event) => choose("harness", event.target.value)}
                  >
                    <option value="all">All tool sets</option>
                    {harnesses.map((id) => (
                      <option key={id} value={id}>
                        {harnessTitles.get(id)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {view === "cases" && (
                <div className={s.field}>
                  <label htmlFor="benchmark-show">Show</label>
                  <select
                    id="benchmark-show"
                    value={measure}
                    onChange={(event) => choose("benchmarkShow", event.target.value)}
                  >
                    {gridMeasures.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {view === "models" &&
            harnesses
              .filter((id) => selectedHarness === "all" || selectedHarness === id)
              .map((id) => (
                <section key={id} className={b.group}>
                  <h2>{harnessTitles.get(id)}</h2>
                  <table className={b.table}>
                    <caption className={b.visuallyHidden}>
                      Model comparison with {harnessTitles.get(id)}
                    </caption>
                    <thead>
                      <tr>
                        {[
                          "Model",
                          "Results",
                          "Checked",
                          "Charged",
                          "Median build time",
                          "Tokens used",
                        ].map((label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {current.rows
                        .filter((row) => row.harnessId === id)
                        .map((row) => {
                          const timing = row.timing.find((item) => item.stage === "builder")!,
                            a = row.answers;
                          return (
                            <tr key={row.id}>
                              <th scope="row" data-label="Model">
                                <Link
                                  href={
                                    row.subjectIds.length === 1
                                      ? `/runs/${current.operationId}?tab=results&candidate=${row.subjectIds[0]}`
                                      : `/runs/${current.operationId}?tab=results`
                                  }
                                >
                                  {row.modelName}
                                </Link>
                                <Providers names={row.providers} builds={row.plannedBuilds} />
                              </th>
                              <td data-label="Results">
                                <OutcomeBar
                                  met={a.met}
                                  failed={a.rejected}
                                  split={a.split}
                                  scored={a.scored}
                                  insufficient={a.insufficient}
                                  unavailable={current.finished || current.stopped ? a.missing : 0}
                                  pending={current.finished || current.stopped ? 0 : a.missing}
                                />
                                <Answer row={row} settled={current.finished || current.stopped} />
                              </td>
                              <td data-label="Checked">
                                {/* "Not enough evidence" is an answer, so it counts as checked. */}
                                <strong>
                                  {a.met + a.rejected + a.split + a.scored + a.insufficient} /{" "}
                                  {a.planned}
                                </strong>
                                <small>
                                  {countList([
                                    a.insufficient > 0 && `${a.insufficient} not enough evidence`,
                                    a.missing > 0 &&
                                      `${a.missing} ${current.finished || current.stopped ? "unavailable" : "not checked yet"}`,
                                  ]) || "All checked"}
                                </small>
                              </td>
                              <td data-label="Charged">
                                <Figure>{amount(row.telemetry.knownChargeUsd)}</Figure>
                                <small>
                                  {row.telemetry.activeReservedUsd > 0
                                    ? `${formatMoney(row.telemetry.activeReservedUsd)} pending`
                                    : ""}
                                </small>
                              </td>
                              <td data-label="Median build time">
                                <Figure>
                                  {elapsed(
                                    timing.elapsedMs.median,
                                    current.finished || current.stopped,
                                  )}
                                </Figure>
                                <small>
                                  {timing.elapsedMs.count} of {timing.elapsedMs.eligible}{" "}
                                  {timing.elapsedMs.eligible === 1 ? "build" : "builds"} timed
                                  {timing.failedUnits > 0 && ` · ${timing.failedUnits} failed`}
                                  {timing.censoredUnits > 0 &&
                                    ` · ${timing.censoredUnits} unfinished`}
                                </small>
                              </td>
                              <td data-label="Tokens used">
                                <Tokens row={row} />
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  <CauseList
                    causes={mergeCauses(current.rows.filter((row) => row.harnessId === id))}
                    operationId={current.operationId}
                    buildTitle={(subjectId) => {
                      const row = current.rows.find((item) => item.subjectIds.includes(subjectId));
                      const number = row?.cases
                        .flatMap((item) => item.builds)
                        .find((build) => build.subjectId === subjectId)?.number;
                      return row && number ? `${row.modelName} · Build ${number}` : null;
                    }}
                  />
                </section>
              ))}
          {view === "cases" && (
            <OutcomeGrid
              report={current}
              harness={selectedHarness}
              measure={measure}
              open={open}
              onToggle={(id) => {
                const url = new URL(window.location.href);
                const next = open.includes(id) ? open.filter((item) => item !== id) : [...open, id];
                if (next.length) url.searchParams.set("open", next.join(","));
                else url.searchParams.delete("open");
                window.history.replaceState(null, "", url);
              }}
            />
          )}
          {view === "classes" && <EvidenceClasses report={current} harness={selectedHarness} />}
          {view === "coverage" && <CostCoverage report={current} harness={selectedHarness} />}
          {view === "details" && (
            <section className={b.group}>
              <h2>Spending and timing</h2>
              <dl className={b.facts}>
                <div>
                  <dt>Charged</dt>
                  <dd>{amount(current.telemetry.knownChargeUsd)}</dd>
                </div>
                <div>
                  <dt>Pending charges for active work</dt>
                  <dd>{formatMoney(current.telemetry.activeReservedUsd)}</dd>
                </div>
                <div>
                  <dt>Test preparation and shared work</dt>
                  <dd>
                    {/* A run that reuses prepared tests has no shared requests to price. */}
                    {current.sharedTelemetry.roles.some((item) => item.requests.retained > 0)
                      ? `${amount(current.sharedTelemetry.knownChargeUsd)} · counted once`
                      : "None"}
                  </dd>
                </div>
                <div>
                  {/* The first recorded event of a run is its first build, after the Studio check
                      and test preparation, so this is shorter than the total time on Progress. */}
                  <dt>From first build to results</dt>
                  <dd>{elapsed(current.campaignWallMs, current.finished || current.stopped)}</dd>
                </div>
                <div>
                  <dt>Waiting for Studio</dt>
                  <dd>
                    {current.queueWaitMs === null
                      ? "Not recorded"
                      : elapsed(current.queueWaitMs, true)}
                  </dd>
                </div>
                <div>
                  <dt>Build pass rate</dt>
                  <dd>Not available: these evaluations have no overall pass rule</dd>
                </div>
              </dl>
              <p className={b.support}>
                Scores use the scale in each evaluation. This page counts met criteria for each
                observation, so the count is not a build pass rate. Builds that share an attempt
                number are still separate builds.
              </p>
              <details className={b.disclosure}>
                <summary>Charges and tokens by model role</summary>
                {current.telemetry.roles
                  .filter((item) => item.requests.retained > 0)
                  .map((item) => (
                    <section className={b.group} key={item.role}>
                      <h3>
                        {roleNames[item.role]} · {item.requests.retained}{" "}
                        {item.requests.retained === 1 ? "request" : "requests"}
                      </h3>
                      <p>
                        {item.requests.dispatched} sent · {item.requests.dispatchUnknown} possibly
                        sent · {item.requests.notDispatched} not sent · {item.knownFailedRequests}{" "}
                        failed
                      </p>
                      <dl className={b.facts}>
                        <div>
                          <dt>Confirmed charges</dt>
                          <dd>
                            {amount(item.charges.knownUsd)} · {item.charges.settledRequests} of{" "}
                            {item.charges.retainedRequests} requests priced
                          </dd>
                        </div>
                        {Object.entries(item.tokens).map(([key, counter]) => (
                          <div key={key}>
                            <dt>{tokenLabel(key)}</dt>
                            <dd>
                              {counter.knownTotal === null
                                ? "Not counted"
                                : counter.knownTotal.toLocaleString()}{" "}
                              · {counter.knownRequests}/{counter.eligibleRequests} requests
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <p className={b.support}>
                        Reasoning and cached tokens are already part of the input and output counts,
                        so this page does not add them again.
                      </p>
                    </section>
                  ))}
              </details>
              <details className={b.disclosure}>
                <summary>Saved settings and technical IDs</summary>
                <dl className={b.facts}>
                  <div>
                    <dt>Evaluation set ID</dt>
                    <dd>{current.suiteHash}</dd>
                  </div>
                  <div>
                    <dt>Run plan ID</dt>
                    <dd>{current.manifestHash}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>
                      This page uses the run’s saved log and original answers. It does not check the
                      results again.
                    </dd>
                  </div>
                </dl>
                <pre className={b.code}>{JSON.stringify(current.conditions, null, 2)}</pre>
              </details>
              {current.rows.some((row) => row.scores.length > 0) && (
                <details className={b.disclosure}>
                  <summary>Scores by criterion</summary>
                  {current.rows.flatMap((row) =>
                    row.scores.map((group) => (
                      <div
                        className={b.case}
                        key={`${row.id}:${group.evaluationId}:${group.criterionId}`}
                      >
                        <div>
                          <h3>
                            {row.modelName} · {row.harnessTitle}
                          </h3>
                          <p>{statementText(group.statement)}</p>
                          <small>
                            {group.values.length} of {group.planned} scores
                          </small>
                          <p>{group.values.join(", ") || "No scores"}</p>
                          <pre className={b.code}>{group.scale}</pre>
                        </div>
                      </div>
                    )),
                  )}
                </details>
              )}
              {current.issues.length > 0 && (
                <details className={b.disclosure}>
                  <summary>Limitations ({current.issues.length})</summary>
                  <ul>
                    {current.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <footer className={b.footer}>
            <div>
              <span>
                {current.telemetry.knownChargeUsd === null ? (
                  "No charges confirmed yet"
                ) : (
                  <>
                    Total confirmed charges{" "}
                    <strong className={s.numeric}>
                      {formatMoney(current.telemetry.knownChargeUsd)}
                    </strong>
                  </>
                )}
              </span>
              {view === "models" && (
                <p className={b.support}>
                  Results count each criterion in each observation, not whole builds that passed.
                </p>
              )}
            </div>
            <div className={s.row}>
              <Link className={s.action} href="/?view=activity">
                All runs
              </Link>
              <Link className={s.secondary} href={`/runs/${current.operationId}`}>
                Open this run
              </Link>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
