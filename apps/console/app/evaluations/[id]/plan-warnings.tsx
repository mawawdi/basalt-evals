import type { BenchmarkPlanWarning } from "../../../../../dist/packages/contracts/src/benchmarks.js";
import type { EmptyBuildCheckRecord } from "../../../../../dist/packages/operator/src/empty-build-check.js";
import { ScrollRegion, Status } from "../../components/ui";
import { statementText } from "../../components/result-display";
import {
  buildPattern,
  planWarningDetail,
  planWarningLabels,
} from "../../components/plan-warning-text";
import s from "../../components/workbench.module.css";

/**
 * The plan warnings of an evaluation. A required code check that passes on the empty build
 * can't tell a good build from no build. After benchmark runs, a check that every build fails or
 * meets may not tell builds apart either. That row is neutral and comes after the other
 * warnings, because an easy or a hard check also gives it. A warning never changes an answer.
 */
export function PlanWarnings({
  check,
  warnings,
  runs,
  checks,
  knownBuildNames,
}: {
  /** Null until a run saves the empty build check of the evaluation. */
  check: EmptyBuildCheckRecord | null;
  /** The warnings of the empty build and of every benchmark run of the evaluation. */
  warnings: BenchmarkPlanWarning[];
  /** The benchmark runs of the evaluation that Basalt read. */
  runs: number;
  checks: Array<{ id: string; statement: string }>;
  /** The name of each known build, by its ID. */
  knownBuildNames: Record<string, string>;
}) {
  const strong = warnings.filter((warning) => !buildPattern(warning.kind));
  const patterns = warnings.filter((warning) => buildPattern(warning.kind));
  return (
    <details
      id="plan-warnings"
      className={s.section}
      open={strong.length > 0 || check?.state === "incomplete"}
    >
      <summary>
        Plan warnings
        {strong.length > 0 && (
          <>
            {" "}
            <Status tone="warning">
              {strong.length === 1 ? "1 warning" : `${strong.length} warnings`}
            </Status>
          </>
        )}
        {patterns.length > 0 && (
          <>
            {" "}
            <Status>
              {patterns.length === 1
                ? "1 same in every build"
                : `${patterns.length} same in every build`}
            </Status>
          </>
        )}
        {/* An incomplete empty build check can hide warnings, also beside known warnings. */}
        {check?.state === "incomplete" ? (
          <>
            {" "}
            <Status>Incomplete</Status>
          </>
        ) : warnings.length === 0 && (check || runs > 0) ? (
          <>
            {" "}
            <Status tone="good">No warnings</Status>
          </>
        ) : null}
      </summary>
      <p className={s.small}>
        Basalt plays the empty build, the starting files with no changes, with the private checks. A
        required code check that passes there can’t tell a working build from no build. After
        benchmarks, a check that every build fails, or every build meets, gets a neutral row. That’s
        normal for an easy or a hard check, but look again if the builds differ a lot. Warnings
        don’t change any answer.
      </p>
      {!check ? (
        <p className={s.small}>
          The empty build hasn’t been checked yet. Basalt checks it right after it prepares the
          evaluation.
        </p>
      ) : check.state === "incomplete" ? (
        <p className={s.small}>
          Basalt couldn’t finish the empty build check, so this evaluation may have warnings that
          aren’t shown. Reason: {check.reason}
        </p>
      ) : null}
      {warnings.length === 0 ? (
        check?.state === "complete" && (
          <p className={s.small}>No required code check passes on the empty build.</p>
        )
      ) : (
        <ScrollRegion className={s.tableWrap} label="Plan warnings">
          <table>
            <thead>
              <tr>
                <th scope="col">Private check</th>
                <th scope="col">Warning</th>
                <th scope="col">What Basalt saw</th>
              </tr>
            </thead>
            <tbody>
              {[...strong, ...patterns].map((warning) => (
                <tr key={`${warning.criterionId}:${warning.kind}`}>
                  <th scope="row">
                    {statementText(
                      checks.find((item) => item.id === warning.criterionId)?.statement ??
                        warning.criterionId,
                    )}
                  </th>
                  <td>
                    <Status tone={buildPattern(warning.kind) ? "neutral" : "warning"}>
                      {planWarningLabels[warning.kind]}
                    </Status>
                  </td>
                  <td>
                    {planWarningDetail(warning, (id) => knownBuildNames[id] ?? "A known build")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {runs > 0 && (
        <p className={s.small}>
          These warnings come from the builds of {runs === 1 ? "1 benchmark" : `${runs} benchmarks`}
          . A check gets a warning only when at least two builds have an answer in every
          observation.
        </p>
      )}
    </details>
  );
}
