import Link from "next/link";
import type { BenchmarkReport } from "../../../../dist/packages/contracts/src/benchmarks.js";
import { buildPattern } from "./plan-warning-text";
import { Notice } from "./ui";
import s from "./workbench.module.css";

/**
 * A compact note on the benchmark page: the plan warnings of this run, with a link to each
 * evaluation that has them. The evaluation page lists the warnings and explains them.
 */
export function PlanWarningNote({ report }: { report: BenchmarkReport }) {
  const count = report.planWarnings.length;
  if (!count) return null;
  const patterns = report.planWarnings.filter((warning) => buildPattern(warning.kind)).length;
  const warnings = count - patterns;
  const evaluations = report.evaluations.filter((evaluation) =>
    report.planWarnings.some((warning) => warning.evaluationId === evaluation.evaluationId),
  );
  const checks = (n: number) => (n === 1 ? "1 check" : `${n} checks`);
  return (
    <Notice kind="info">
      {warnings > 0 ? (
        <>
          <strong>{warnings === 1 ? "1 plan warning" : `${warnings} plan warnings`}</strong>: some
          private checks may not tell builds apart.
          {patterns > 0 && ` ${checks(patterns)} more gave every build the same answer.`}
        </>
      ) : (
        <>
          <strong>{checks(patterns)}</strong> gave every build the same answer, so{" "}
          {patterns === 1 ? "it doesn’t" : "they don’t"} tell these builds apart yet. That’s normal
          for an easy or a hard check.
        </>
      )}{" "}
      Warnings don’t change any answer.{" "}
      {evaluations.map((evaluation, index) => (
        <span key={evaluation.evaluationId}>
          {index > 0 && " · "}
          <Link className={s.action} href={`/evaluations/${evaluation.evaluationId}#plan-warnings`}>
            {evaluations.length === 1
              ? "See plan warnings"
              : `See ${evaluation.title ?? `evaluation ${report.evaluations.indexOf(evaluation) + 1}`}`}
          </Link>
        </span>
      ))}
    </Notice>
  );
}
