"use client";
import Link from "next/link";
import type { ComparisonGrid } from "../../../../../dist/packages/experiments/src/comparisons.js";
import type { ComparisonCell } from "../../../../../dist/packages/contracts/src/comparisons.js";
import { OutcomeBar, OutcomeLegend, markClass } from "../../components/ui";
import { statementText } from "../../components/result-display";
import s from "../../components/workbench.module.css";
import g from "../../components/outcome-grid.module.css";
import c from "../comparison.module.css";

export interface ComparedRun {
  operationId: string;
  /** The run that holds the evidence: the source run of a reassessment. */
  evidenceRun: string;
  label: string;
  models: string;
}

const answer = (cell: ComparisonCell) =>
  cell.outcome === "met"
    ? "Met"
    : cell.outcome === "rejected"
      ? "Not met"
      : cell.outcome === "split"
        ? "Split"
        : cell.outcome === "insufficient"
          ? "Not enough evidence"
          : cell.outcome === "scored"
            ? `Score ${cell.score ?? ""}`.trim()
            : "Unavailable";

/**
 * One table for each evaluation: a row for each criterion in authored order and a column for
 * each run in the order of the comparison. Every column has the same neutral style.
 */
export function ComparisonGridView({ grid, runs }: { grid: ComparisonGrid; runs: ComparedRun[] }) {
  const shown = (count: "scored" | "split" | "insufficient") =>
    grid.evaluations.some((evaluation) =>
      evaluation.rows.some((row) => row.cells.some((cell) => cell[count] > 0)),
    );
  return (
    <section className={c.gridSection} aria-labelledby="comparison-answers">
      <h2 id="comparison-answers">Answers by criterion</h2>
      <p className={s.small}>
        Each mark is one answer for one observation. Select a mark to open its evidence.
      </p>
      <OutcomeLegend
        scored={shown("scored")}
        split={shown("split")}
        insufficient={shown("insufficient")}
      />
      {grid.evaluations.map((evaluation, index) => {
        const title = evaluation.title ?? `Evaluation ${index + 1}`;
        return (
          <section className={c.evaluation} key={evaluation.evaluationId}>
            <h3>{title}</h3>
            <table className={g.grid} aria-label={`Answers for ${title}`}>
              <thead>
                <tr>
                  <th scope="col">Criteria</th>
                  {runs.map((run) => (
                    <th scope="col" key={run.operationId} className={c.columnHead}>
                      {run.label}
                      <small>{run.models}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evaluation.rows.map((row) => {
                  const statement = statementText(row.statement);
                  return (
                    <tr key={row.criterionId}>
                      <th scope="row">{statement}</th>
                      {row.cells.map((cell, column) => {
                        const run = runs[column]!;
                        return (
                          <td key={cell.operationId} data-label={`${run.label} · ${run.models}`}>
                            {cell.planned === 0 ? (
                              <span className={g.none}>Not in this run</span>
                            ) : (
                              <>
                                <OutcomeBar
                                  met={cell.met}
                                  failed={cell.rejected}
                                  split={cell.split}
                                  scored={cell.scored}
                                  insufficient={cell.insufficient}
                                  unavailable={cell.unavailable}
                                />
                                <p className={g.counts}>
                                  {cell.met} met · {cell.rejected} not met
                                  {cell.split > 0 && ` · ${cell.split} split`}
                                  {cell.scored > 0 && ` · ${cell.scored} scored`}
                                  {cell.insufficient > 0 &&
                                    ` · ${cell.insufficient} not enough evidence`}
                                  {cell.unavailable > 0 && ` · ${cell.unavailable} unavailable`}
                                </p>
                                <div className={g.builds}>
                                  {cell.builds.map((build) => (
                                    <div className={g.build} key={build.candidateId}>
                                      <span className={g.buildName} aria-hidden>
                                        Build {build.number}
                                      </span>
                                      <span className={g.marks}>
                                        {build.marks.map((mark) => (
                                          <Link
                                            key={`${mark.captureId}:${mark.criterionId}`}
                                            data-mark=""
                                            className={`${s.mark} ${markClass(mark.outcome === "met" ? "verified" : mark.outcome)}`}
                                            href={`/runs/${run.evidenceRun}?tab=evidence&candidate=${encodeURIComponent(mark.candidateId)}&criterion=${encodeURIComponent(mark.evidenceCellId ?? mark.criterionId)}&pass=${mark.pass}`}
                                            aria-label={`${statement}, ${run.label}, build ${build.number}, observation ${mark.pass}: ${answer(mark)}`}
                                            title={`Build ${build.number}, observation ${mark.pass}: ${answer(mark)}`}
                                          >
                                            {mark.pass}
                                          </Link>
                                        ))}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </section>
  );
}
