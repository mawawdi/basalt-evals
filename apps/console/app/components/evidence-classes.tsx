"use client";
import Link from "next/link";
import type {
  BenchmarkOutcomeCounts,
  BenchmarkReport,
  BenchmarkSlice,
  BenchmarkTreatmentReport,
} from "../../../../dist/packages/contracts/src/benchmarks.js";
import { Answers } from "./outcome-grid";
import { countList, counted, evidenceClassNames } from "./result-display";
import b from "./benchmark.module.css";

type Group = {
  key: string;
  title: string;
  slice: (row: BenchmarkTreatmentReport) => BenchmarkSlice | undefined;
};

// "Not enough evidence" is an answer, so it counts as checked.
const answered = (a: BenchmarkOutcomeCounts) =>
  a.met + a.rejected + a.split + a.scored + a.insufficient;
const coverage = (a: BenchmarkOutcomeCounts) =>
  a.planned ? `${answered(a)} of ${a.planned} answers` : "No planned answers";

/**
 * The answers of each model by the evidence class of each judge criterion, then the code checks
 * as their own group. Each group keeps the coverage of each evaluation. Nothing adds the groups
 * up, and nothing sorts or ranks the models.
 */
export function EvidenceClasses({ report, harness }: { report: BenchmarkReport; harness: string }) {
  const settled = report.finished || report.stopped;
  const rows = report.rows.filter((row) => harness === "all" || row.harnessId === harness);
  const toolSets = new Set(rows.map((row) => row.harnessId)).size > 1;
  const titles = new Map(
    report.evaluations.map((evaluation, index) => [
      evaluation.evaluationId,
      evaluation.title ?? `Evaluation ${index + 1}`,
    ]),
  );
  // Every row lists the same classes, so the first row names the groups.
  const groups: Group[] = [
    ...(report.rows[0]?.classes ?? []).map((item) => ({
      key: item.evidenceClass ?? "none",
      title: item.evidenceClass ? evidenceClassNames[item.evidenceClass] : "No evidence class",
      slice: (row: BenchmarkTreatmentReport) =>
        row.classes.find((other) => other.evidenceClass === item.evidenceClass),
    })),
    ...(report.rows.some((row) => row.methods.deterministic.cases.length)
      ? [
          {
            key: "code",
            title: "Code checks",
            slice: (row: BenchmarkTreatmentReport) => row.methods.deterministic,
          },
        ]
      : []),
  ];
  if (!groups.length)
    return <p className={b.support}>This benchmark has no planned checks to group.</p>;
  return (
    <>
      <p className={b.support}>
        Each judge check counts under the evidence class that the author of its criterion set. Code
        checks have no evidence class, so they have their own group. Results count each criterion in
        each observation, and the groups don’t add up to an overall score.
      </p>
      {groups.map((group) => {
        const evaluations = new Set(
          rows.flatMap((row) => group.slice(row)?.cases.map((item) => item.evaluationId) ?? []),
        );
        return (
          <section key={group.key} className={b.group} data-evidence-class={group.key}>
            <h2>{group.title}</h2>
            <table className={b.table}>
              <caption className={b.visuallyHidden}>{group.title} results for each model</caption>
              <thead>
                <tr>
                  {["Model", "Results", "Checked", "Evaluations"].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const slice = group.slice(row);
                  if (!slice) return null;
                  const list = (
                    <ul className={b.coverage}>
                      {slice.cases.map((item) => (
                        <li key={item.evaluationId}>
                          <span>{titles.get(item.evaluationId) ?? item.evaluationId}</span>
                          <small>
                            {countList([
                              coverage(item.answers),
                              item.answers.met > 0 && `${item.answers.met} met`,
                              item.answers.rejected > 0 && `${item.answers.rejected} not met`,
                            ])}
                          </small>
                        </li>
                      ))}
                    </ul>
                  );
                  return (
                    <tr key={row.id}>
                      <th scope="row" data-label="Model">
                        <Link
                          href={
                            row.subjectIds.length === 1
                              ? `/runs/${report.operationId}?tab=results&candidate=${row.subjectIds[0]}`
                              : `/runs/${report.operationId}?tab=results`
                          }
                        >
                          {row.modelName}
                        </Link>
                        {toolSets && <small>{row.harnessTitle}</small>}
                      </th>
                      <td data-label="Results">
                        <Answers answers={slice.answers} settled={settled} />
                      </td>
                      <td data-label="Checked">
                        <strong className={b.words}>{coverage(slice.answers)}</strong>
                      </td>
                      <td data-label="Evaluations">
                        {slice.cases.length > 3 ? (
                          <details className={b.providers}>
                            <summary>{counted(slice.cases.length, "evaluation")}</summary>
                            {list}
                          </details>
                        ) : (
                          list
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className={b.support}>
              {group.key === "code" ? "Code checks" : "Judge checks"} in {evaluations.size} of{" "}
              {counted(report.evaluations.length, "evaluation")}.
            </p>
          </section>
        );
      })}
    </>
  );
}
