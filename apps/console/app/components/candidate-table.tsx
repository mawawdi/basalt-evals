"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { CaretDown } from "@phosphor-icons/react";
import type { ResultSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import { ScrollRegion, EmptyState, Status } from "./ui";
import {
  buildCostLabel,
  buildOrder,
  buildStateLabel,
  buildTimeLabel,
  observationLabel,
  outcomeAvailability,
  outcomeCount,
  counted,
  evaluationOrder,
} from "./result-display";
import s from "./workbench.module.css";
import h from "./build-history.module.css";
import r from "./run-experience.module.css";
type Capture = ResultSummary["captures"][number];
// A compact mark per observation, in the order of observationLabel(), so the mark and its
// words always agree.
function captureMark(capture: Capture, active: boolean) {
  if (capture.state === "planned" || capture.state === "collecting") return s.markPending;
  if (capture.state === "incomplete") return s.markMissing;
  if (!capture.planned) return s.markPending;
  if (capture.unavailable) return active ? s.markPending : s.markMissing;
  if (capture.rejected) return s.markFailed;
  if (capture.split) return s.markSplit;
  if (capture.insufficient) return s.markInsufficient;
  if (capture.scored) return s.markScored;
  return s.markMet;
}
/** A model build with a build history. A build that the run did not reach never started. */
function built(build: ResultSummary) {
  return (
    (build.kind === "generated" || build.kind === "repair") && build.buildState !== "not_reached"
  );
}
/** Why a build never started: the build that it continues, and the gate check that failed. */
export function NotReachedReason({
  cause,
  operationId,
}: {
  cause: NonNullable<ResultSummary["notReached"]>;
  operationId: string;
}) {
  const check = cause.failedGateChecks[0];
  if (!check)
    return (
      <>{`${cause.parentTitle} didn’t finish stage ${cause.parentStage}, so this build never started.`}</>
    );
  return (
    <>
      {`${cause.parentTitle} didn’t pass the stage ${cause.parentStage} gate, so this build never started.`}{" "}
      <Link
        href={`/runs/${operationId}?tab=evidence&candidate=${encodeURIComponent(cause.parentCandidateId)}&criterion=${encodeURIComponent(check.cellId)}&pass=${check.pass}`}
      >
        {cause.failedGateChecks.length > 1
          ? "See the first failed gate check"
          : "See the gate check"}
      </Link>
    </>
  );
}
function NotReachedNote({ build }: { build: ResultSummary }) {
  if (!build.notReached) return null;
  return (
    <p className={s.small} data-not-reached>
      <NotReachedReason cause={build.notReached} operationId={build.operationId} />
    </p>
  );
}
function CaptureMarks({ build }: { build: ResultSummary }) {
  if (build.buildState === "not_reached") return null;
  return (
    <span className={s.markRow} aria-hidden>
      {build.captures.map((capture) => (
        <span
          key={capture.number}
          className={`${s.mark} ${captureMark(capture, build.state === "active")}`}
        >
          {capture.number}
        </span>
      ))}
    </span>
  );
}
export function CandidateTable({
  candidates,
  inspect,
  history,
}: {
  candidates: ResultSummary[];
  inspect: (candidate: ResultSummary, pass?: number) => void;
  /** Open how a build was built. Saved source has no model turns. */
  history?: (candidate: ResultSummary) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]),
    [tools, setTools] = useState(false),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("default");
  const visible = candidates
    .filter((build) =>
      `${build.evaluationTitle} ${build.candidateTitle} ${build.model}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "model"
        ? evaluationOrder(a, b) || a.model.localeCompare(b.model)
        : sort === "cost"
          ? evaluationOrder(a, b) || (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity)
          : sort === "time"
            ? evaluationOrder(a, b) || (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity)
            : buildOrder(a, b),
    );
  // A kind of check no build here uses would only repeat "No criteria" on every row.
  const showCode = candidates.some((build) => build.functional.planned > 0),
    showJudge = candidates.some((build) => build.qualitative.planned > 0),
    columns = 4 + Number(showCode) + Number(showJudge) + Number(tools);
  // A build that the run did not reach never started, so nothing checked it.
  const counts = (build: ResultSummary, value: ResultSummary["functional"]) =>
    build.buildState === "not_reached" ? (
      "Not checked"
    ) : (
      <>
        {outcomeCount(value)}
        <span className={s.tableMeta}>{outcomeAvailability(value, build.state === "active")}</span>
      </>
    );
  const toolCalls = (build: ResultSummary) =>
    build.toolCalls ?? (build.buildState === "not_reached" ? "Not started" : "Unavailable");
  return (
    <div>
      {candidates.length > 1 && (
        <div className={r.filterRow}>
          <div className={s.field}>
            <label htmlFor="build-search">Find a build on this page</label>
            <input
              id="build-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className={s.field}>
            <label htmlFor="build-order">Order within each evaluation</label>
            <select id="build-order" value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="default">Build order</option>
              <option value="model">Model name</option>
              <option value="cost">Lowest build cost</option>
              <option value="time">Shortest build time</option>
            </select>
          </div>
          {(query || sort !== "default") && (
            <button
              className={s.secondary}
              onClick={() => {
                setQuery("");
                setSort("default");
              }}
            >
              Reset
            </button>
          )}
        </div>
      )}
      {!visible.length && (
        <EmptyState title={query ? "No builds match this search" : "No build results yet"}>
          {query
            ? "Try a different model, or clear the search."
            : "Progress shows the current work and any interruption."}
        </EmptyState>
      )}
      {visible.length > 0 && (
        <>
          <details>
            <summary>Columns</summary>
            <label className={s.choice}>
              <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />
              Tool calls
            </label>
          </details>
          <div className={s.comparisonCards}>
            {visible.map((build, index) => (
              <Fragment key={build.id}>
                {(index === 0 || visible[index - 1]!.evaluationId !== build.evaluationId) && (
                  <h3 className={s.cardGroup}>{build.evaluationTitle}</h3>
                )}
                <article className={`${s.panel} ${s.panelBody} ${s.buildCard}`}>
                  <button className={s.tableTitle} onClick={() => inspect(build)}>
                    {build.model} · {build.candidateTitle}
                  </button>
                  <Status>{buildStateLabel(build.buildState, build.kind)}</Status>
                  <NotReachedNote build={build} />
                  {build.buildState !== "not_reached" && (
                    <div className={s.cardMarks} role="group" aria-label="Observations">
                      {build.captures.map((capture) => (
                        <button
                          key={capture.number}
                          className={`${s.mark} ${captureMark(capture, build.state === "active")}`}
                          aria-label={`Observation ${capture.number}: ${observationLabel(capture, build.state === "active")}`}
                          onClick={() => inspect(build, capture.number)}
                        >
                          {capture.number}
                        </button>
                      ))}
                    </div>
                  )}
                  {history && built(build) && (
                    <button
                      className={s.textButton}
                      aria-label={`How it was built: ${build.model} · ${build.candidateTitle}`}
                      onClick={() => history(build)}
                    >
                      How it was built
                    </button>
                  )}
                  <dl className={s.factList}>
                    {showCode && (
                      <div>
                        <dt>Code checks</dt>
                        <dd>{counts(build, build.functional)}</dd>
                      </div>
                    )}
                    {showJudge && (
                      <div>
                        <dt>Judge checks</dt>
                        <dd>{counts(build, build.qualitative)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Unavailable answers</dt>
                      <dd>{build.functional.unavailable + build.qualitative.unavailable}</dd>
                    </div>
                    <div>
                      <dt>Build cost</dt>
                      <dd>{buildCostLabel(build)}</dd>
                    </div>
                    <div>
                      <dt>Build time</dt>
                      <dd>{buildTimeLabel(build)}</dd>
                    </div>
                    {tools && (
                      <div>
                        <dt>Tool calls</dt>
                        <dd>{toolCalls(build)}</dd>
                      </div>
                    )}
                  </dl>
                </article>
              </Fragment>
            ))}
          </div>
          <div className={s.desktopComparison}>
            <ScrollRegion className={s.tableWrap} label="Build comparison">
              <table className={s.resultTable}>
                <thead>
                  <tr>
                    <th scope="col" aria-sort={sort === "model" ? "ascending" : "none"}>
                      Build / model
                    </th>
                    {showCode && <th scope="col">Code checks</th>}
                    {showJudge && <th scope="col">Judge checks</th>}
                    <th scope="col">Unavailable answers</th>
                    <th scope="col" aria-sort={sort === "cost" ? "ascending" : "none"}>
                      Build cost
                    </th>
                    <th scope="col" aria-sort={sort === "time" ? "ascending" : "none"}>
                      Build time
                    </th>
                    {tools && <th scope="col">Tool calls</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((build, index) => (
                    <Fragment key={build.id}>
                      {(index === 0 || visible[index - 1]!.evaluationId !== build.evaluationId) && (
                        <tr>
                          <th className={s.groupHeading} colSpan={columns} scope="rowgroup">
                            {build.evaluationTitle}
                          </th>
                        </tr>
                      )}
                      <tr>
                        <th scope="row">
                          <button className={s.tableTitle} onClick={() => inspect(build)}>
                            {build.model} · {build.candidateTitle}
                          </button>
                          {build.harness && <span className={s.tableMeta}>{build.harness}</span>}
                          <span className={s.buildState}>
                            <Status>{buildStateLabel(build.buildState, build.kind)}</Status>
                            <CaptureMarks build={build} />
                          </span>
                          <NotReachedNote build={build} />
                          {build.buildState !== "not_reached" && (
                            <button
                              className={s.textButton}
                              aria-expanded={expanded.includes(build.id)}
                              onClick={() =>
                                setExpanded(
                                  expanded.includes(build.id)
                                    ? expanded.filter((id) => id !== build.id)
                                    : [...expanded, build.id],
                                )
                              }
                            >
                              <CaretDown size={14} aria-hidden className={s.expandCaret} />
                              {counted(build.captures.length, "observation")}
                            </button>
                          )}
                          {history && built(build) && (
                            <button
                              className={`${s.textButton} ${h.entry}`}
                              aria-label={`How it was built: ${build.model} · ${build.candidateTitle}`}
                              onClick={() => history(build)}
                            >
                              How it was built
                            </button>
                          )}
                        </th>
                        {showCode && <td>{counts(build, build.functional)}</td>}
                        {showJudge && <td>{counts(build, build.qualitative)}</td>}
                        <td>{build.functional.unavailable + build.qualitative.unavailable}</td>
                        <td>{buildCostLabel(build)}</td>
                        <td>{buildTimeLabel(build)}</td>
                        {tools && <td>{toolCalls(build)}</td>}
                      </tr>
                      {expanded.includes(build.id) && (
                        <tr className={s.detailRow}>
                          <td colSpan={columns}>
                            <div className={s.row}>
                              {build.captures.map((capture) => (
                                <button
                                  className={s.secondary}
                                  key={capture.number}
                                  onClick={() => inspect(build, capture.number)}
                                >
                                  Observation {capture.number} ·{" "}
                                  {observationLabel(capture, build.state === "active")}
                                  {capture.rejected > 0 ? ` · ${capture.rejected} not met` : ""}
                                  {capture.insufficient > 0
                                    ? ` · ${capture.insufficient} not enough evidence`
                                    : ""}
                                  {capture.unavailable > 0
                                    ? ` · ${capture.unavailable} unavailable`
                                    : ""}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
        </>
      )}
    </div>
  );
}
