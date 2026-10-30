"use client";
import type { BenchmarkReport } from "../../../../dist/packages/contracts/src/benchmarks.js";
import {
  costCoverage,
  valueRange,
  type CostCoverageBuild,
  type CostCoverageRow,
} from "../../../../dist/packages/contracts/src/cost-coverage.js";
import { formatMoney } from "./api";
import { counted } from "./result-display";
import b from "./benchmark.module.css";

const percent = (share: number) => `${Math.round(share * 100)}%`;
const duration = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

/** A build on one strip: its point and, for an open answer or a pending charge, how far it can move. */
type Point = { at: number; to: number | null };
interface Strip {
  key: "met" | "charge" | "time";
  title: string;
  /** The highest value of the axis. Every model shares it. */
  max: number;
  label: (value: number) => string;
  point: (build: CostCoverageBuild) => Point | null;
  /** Why a build has no point, for the count under the strip. */
  missing: string;
  note: string;
}

function strips(rows: CostCoverageRow[]): Strip[] {
  const builds = rows.flatMap((row) => row.builds);
  const highest = (values: number[]) => Math.max(0, ...values) || 1;
  return [
    {
      key: "met",
      title: "Criteria met",
      max: 1,
      label: percent,
      point: (build) =>
        build.met && {
          at: build.met.lower,
          to: build.met.upper > build.met.lower ? build.met.upper : null,
        },
      missing: "without an answer that can be met",
      note: "A dashed line shows how far missing and split answers can move a build. Not enough evidence counts as not met.",
    },
    {
      key: "charge",
      title: "Confirmed charge",
      max: highest(builds.map((build) => (build.chargeUsd ?? 0) + build.pendingUsd)),
      label: (value) => formatMoney(value),
      point: (build) =>
        build.chargeUsd === null
          ? null
          : {
              at: build.chargeUsd,
              to: build.pendingUsd > 0 ? build.chargeUsd + build.pendingUsd : null,
            },
      missing: "without a confirmed charge",
      note: "A dashed line shows pending charges. Shared preparation and charges that match no build aren’t in any build, so the dots don’t add up to the run total in Details.",
    },
    {
      key: "time",
      title: "Build time",
      max: highest(builds.flatMap((build) => (build.buildMs === null ? [] : [build.buildMs]))),
      label: duration,
      point: (build) => (build.buildMs === null ? null : { at: build.buildMs, to: null }),
      missing: "without a recorded build time",
      note: "Active build time. Paused time doesn’t count.",
    },
  ];
}

function StripCell({ strip, row }: { strip: Strip; row: CostCoverageRow }) {
  const place = (value: number) => `${Math.min(100, (value / strip.max) * 100)}%`;
  const points = row.builds.map((build) => ({ build, point: strip.point(build) }));
  const range = valueRange(points.map(({ point }) => point?.at ?? null));
  const absent = points.filter(({ point }) => !point).length;
  return (
    <div className={b.stripCell} data-label={strip.title} data-strip={strip.key}>
      <div
        className={b.strip}
        role="img"
        aria-label={`${row.modelName}, ${strip.title.toLowerCase()}: ${
          range
            ? `${counted(points.length - absent, "build")} from ${strip.label(range.low)} to ${strip.label(range.high)}`
            : "no builds to show"
        }`}
      >
        {range && (
          <span
            className={b.stripRange}
            style={{
              left: place(range.low),
              width: `calc(${place(range.high)} - ${place(range.low)})`,
            }}
            data-range
          />
        )}
        {points.map(({ build, point }) =>
          point ? (
            <span key={build.subjectId}>
              {point.to !== null && (
                <span
                  className={b.stripBracket}
                  style={{
                    left: place(point.at),
                    width: `calc(${place(point.to)} - ${place(point.at)})`,
                  }}
                  data-bracket
                />
              )}
              <span className={b.stripDot} style={{ left: place(point.at) }} data-dot />
            </span>
          ) : null,
        )}
      </div>
      <span className={b.stripScale} aria-hidden>
        <span>{strip.label(0)}</span>
        <span>{strip.label(strip.max)}</span>
      </span>
      {absent > 0 && (
        <small className={b.stripMissing}>
          {counted(absent, "build")} {strip.missing}
        </small>
      )}
    </div>
  );
}

/**
 * Criteria met, confirmed charge and build time of each build, as three aligned strips for each
 * model. The strips share one axis for all models. Nothing joins the strips, sorts the models,
 * marks a best model or draws a frontier.
 */
export function CostCoverage({ report, harness }: { report: BenchmarkReport; harness: string }) {
  const rows = costCoverage(report).filter((row) => harness === "all" || row.harnessId === harness);
  const toolSets = new Set(rows.map((row) => row.harnessId)).size > 1;
  const titles = new Map(
    report.evaluations.map((evaluation, index) => [
      evaluation.evaluationId,
      evaluation.title ?? `Evaluation ${index + 1}`,
    ]),
  );
  const staged = report.evaluations.some((evaluation) => evaluation.stage.index > 1);
  if (!rows.some((row) => row.builds.length))
    return <p className={b.support}>No build of this benchmark has started yet.</p>;
  const all = strips(rows);
  return (
    <section className={b.group} aria-labelledby="cost-coverage">
      <h2 id="cost-coverage">Cost and coverage</h2>
      <p className={b.support}>
        Each dot is one build. The band shows the range of a model’s builds. The three strips stay
        separate: a build that meets more criteria isn’t better or worse for its charge or its time
        on this chart.
        {staged &&
          " Builds of a later stage passed the stages before it, so they are a selection of the builds."}
      </p>
      <div className={b.costCoverage} data-cost-coverage>
        <div className={b.coverageHead} aria-hidden>
          <span>Model</span>
          {all.map((strip) => (
            <span key={strip.key}>
              {strip.title}
              <span className={b.coverageScale}>
                <span>{strip.label(0)}</span>
                <span>{strip.label(strip.max)}</span>
              </span>
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.rowId} className={b.coverageRow} data-coverage-row>
            <div className={b.coverageModel}>
              <strong>{row.modelName}</strong>
              <small>
                {toolSets && `${row.harnessTitle} · `}
                {counted(row.builds.length, "build")}
              </small>
            </div>
            {all.map((strip) => (
              <StripCell key={strip.key} strip={strip} row={row} />
            ))}
          </div>
        ))}
        <div className={b.coverageFoot}>
          <span />
          {all.map((strip) => (
            <small key={strip.key} data-note={strip.key} data-label={strip.title}>
              {strip.note}
            </small>
          ))}
        </div>
      </div>
      <details className={b.coverageFigures}>
        <summary>Figures for each build</summary>
        <table className={b.table}>
          <caption className={b.visuallyHidden}>
            Criteria met, charge and time of each build
          </caption>
          <thead>
            <tr>
              {["Build", "Evaluation", "Criteria met", "Confirmed charge", "Build time"].map(
                (label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row) =>
              row.builds.map((build) => (
                <tr key={build.subjectId} data-figure-row>
                  <th scope="row" data-label="Build">
                    {row.modelName} · Build {build.number}
                    {toolSets && <small>{row.harnessTitle}</small>}
                  </th>
                  <td data-label="Evaluation">{titles.get(build.evaluationId) ?? "Evaluation"}</td>
                  <td data-label="Criteria met">
                    {build.met ? (
                      <>
                        <strong>
                          {build.answers.met} of {build.answers.planned} met
                        </strong>
                        <small>
                          {build.answers.open
                            ? `${build.answers.open} open · ${percent(build.met.lower)} to ${percent(build.met.upper)}`
                            : percent(build.met.lower)}
                        </small>
                      </>
                    ) : (
                      <strong className={b.words}>No answer that can be met</strong>
                    )}
                  </td>
                  <td data-label="Confirmed charge">
                    <strong className={build.chargeUsd === null ? b.words : undefined}>
                      {build.chargeUsd === null ? "Not confirmed" : formatMoney(build.chargeUsd)}
                    </strong>
                    {build.pendingUsd > 0 && <small>{formatMoney(build.pendingUsd)} pending</small>}
                  </td>
                  <td data-label="Build time">
                    <strong className={build.buildMs === null ? b.words : undefined}>
                      {build.buildMs === null ? "Not recorded" : duration(build.buildMs)}
                    </strong>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </details>
    </section>
  );
}
