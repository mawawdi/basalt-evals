export const metadata = { title: "Comparison report · Basalt" };
import Link from "next/link";
import { comparisonReport, readModelRegistry } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { Arrow, PageHeading, Notice, ReadableTime } from "../../components/ui";
import { ExportAction } from "../../components/run-actions";
import { elapsedDuration } from "../../../../../dist/packages/contracts/src/display.js";
import { formatMoney } from "../../components/api";
import s from "../../components/workbench.module.css";
import c from "../comparison.module.css";
import { checkerStream, comparisonReason, statementText } from "../../components/result-display";
import { ComparisonGridView, type ComparedRun } from "./comparison-grid";
export const dynamic = "force-dynamic";

const verdicts = {
  direct: "Same test conditions",
  descriptive: "Conditions differ",
  incompatible: "Cannot compare",
} as const;

export default async function ComparisonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    report = await comparisonReport(repositoryRoot(), id);
  const registry = await readModelRegistry(repositoryRoot());
  const runs: ComparedRun[] = report.populations.map((population, index) => ({
    operationId: population.operationId,
    evidenceRun: population.sourceOperationId ?? population.operationId,
    label: `Run ${index + 1}`,
    models:
      (population.conditions.builders as Array<{ model: string }>)
        .map(
          (builder) =>
            registry.models.find((model) => model.id === builder.model)?.name ?? builder.model,
        )
        .join(", ") || "Saved build",
  }));
  const runOf = (operationId: string) => runs.find((run) => run.operationId === operationId)!.label;
  const titles = [...new Set(report.populations.map((population) => population.title))];
  const differing = report.pairs.filter((pair) => pair.compatibility !== "direct");
  // A direct pair explains how its runs relate, for example the same saved evidence.
  const relations = [
    ...new Set(
      report.pairs
        .filter((pair) => pair.compatibility === "direct")
        .flatMap((pair) => pair.reasons.map(comparisonReason)),
    ),
  ];
  const excluded = report.scope.filter((item) => item.decisionsExcluded > 0);
  const answer = (cell: (typeof report.populations)[number]["cells"][number]) =>
    ({
      met: "Met",
      rejected: "Not met",
      split: "Split",
      scored: "Scored",
      insufficient: "Not enough evidence",
      incomplete: "Unavailable",
    })[cell.outcome] + (cell.score === null ? "" : ` · ${cell.score} on the authored scale`);
  return (
    <main>
      <PageHeading
        title={
          // Runs of the same evaluation share a title; name the count instead of repeating it.
          titles.length === 1
            ? `${titles[0]}: ${runs.length} runs`
            : runs.length === 2
              ? titles.join(" and ")
              : `Comparison of ${runs.length} runs`
        }
        description={`Compare results, unavailable answers and spending across ${runs.length} runs.`}
        action={<ExportAction href={`/api/comparisons/${id}/export`} subject="comparison" />}
      />
      <Notice kind="info">
        <strong>{verdicts[report.compatibility]}</strong>
        <p>
          {report.compatibility === "direct"
            ? `All ${runs.length} runs used the same recorded test conditions.`
            : report.compatibility === "descriptive"
              ? `Some recorded test conditions differ between ${differing.length === 1 ? "two runs" : "the runs"}. Each difference is listed under Differences between runs.`
              : "Some runs checked different evaluations or criteria. They are listed under Differences between runs."}
        </p>
        {relations.map((relation) => (
          <p key={relation}>{relation}</p>
        ))}
      </Notice>
      <details className={c.differences} open={report.compatibility !== "direct"}>
        <summary>Differences between runs</summary>
        {!differing.length ? (
          <p className={s.small}>Basalt found no differences in the recorded test conditions.</p>
        ) : (
          differing.map((pair) => (
            <section key={`${pair.left}:${pair.right}`}>
              <h3>
                {runOf(pair.left)} and {runOf(pair.right).toLowerCase()}:{" "}
                {verdicts[pair.compatibility]}
              </h3>
              <ul>
                {pair.reasons.map((reason) => (
                  <li key={reason}>{comparisonReason(reason)}</li>
                ))}
              </ul>
            </section>
          ))
        )}
      </details>
      {excluded.length > 0 && (
        <p className={s.scopeNote}>
          A reassessment checked only part of the saved evidence, so every run shows only the
          criteria that it checked again, and a run and its reassessment show only the same
          observations. Not included:{" "}
          {excluded
            .map(
              (item) =>
                `${item.decisionsExcluded} ${item.decisionsExcluded === 1 ? "answer" : "answers"} of ${runOf(item.operationId).toLowerCase()}`,
            )
            .join(", ")}
          . Cost and build totals cover each whole run.
        </p>
      )}
      <div className={c.runs}>
        {report.populations.map((population, index) => {
          const summary = report.summaries[index]!,
            provenance = report.provenance[index]!,
            run = runs[index]!;
          const assessment = population.kind === "assessment";
          const grader = provenance.grader;
          return (
            <section
              className={`${s.panel} ${s.panelBody}`}
              key={population.operationId}
              aria-label={run.label}
            >
              <span className={c.runNumber}>
                {run.label} · {assessment ? "Reassessment" : "Run"}
              </span>
              <h3>{population.title}</h3>
              <p>{run.models}</p>
              <p className={s.small}>
                {assessment ? "Source run started " : "Recorded "}
                {provenance.sourceOperationStartedAt ? (
                  <ReadableTime value={String(provenance.sourceOperationStartedAt)} />
                ) : (
                  "time unavailable"
                )}{" "}
                · {checkerStream(String(population.conditions.gradingStream))}
              </p>
              {assessment && (
                <p className={s.small}>
                  Checked again{" "}
                  {grader ? (
                    <ReadableTime value={grader.assessmentCreatedAt} />
                  ) : (
                    "at an unknown time"
                  )}{" "}
                  with Basalt code version {grader?.implementationCommit.slice(0, 7) ?? "unknown"}.
                </p>
              )}
              <details>
                <summary>Models, tools and recorded conditions</summary>
                <pre className={s.code}>{JSON.stringify(provenance, null, 2)}</pre>
                <pre className={s.code}>{JSON.stringify(population.conditions, null, 2)}</pre>
              </details>
              <Link className={s.action} href={`/runs/${population.operationId}`}>
                Open {run.label.toLowerCase()}
              </Link>
              <dl className={s.definitionList}>
                <div>
                  <dt>What ran</dt>
                  <dd>
                    {assessment
                      ? "Saved evidence checked again · No new builds or observations"
                      : `${summary.independentBuilds} ${summary.independentBuilds === 1 ? "build" : "builds"} planned · ${summary.captures} ${summary.captures === 1 ? "observation" : "observations"} planned`}
                  </dd>
                </div>
                {(["functional", "qualitative"] as const).map((kind) => (
                  <div key={kind}>
                    <dt>{kind === "functional" ? "Code checks" : "Judge checks"}</dt>
                    <dd>
                      {summary[kind].planned > 0
                        ? `${summary[kind].met} / ${summary[kind].planned} met · ${summary[kind].rejected} not met${summary[kind].split ? ` · ${summary[kind].split} split` : ""} · ${summary[kind].scored} scored${summary[kind].insufficient ? ` · ${summary[kind].insufficient} not enough evidence` : ""} · ${summary[kind].unavailable} unavailable`
                        : "This run has no criteria of this type."}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Spending</dt>
                  <dd
                    title={`${summary.billedUsd} USD charged; ${summary.reservedUsd} USD pending`}
                  >
                    {formatMoney(summary.billedUsd)} charged
                    {summary.reservedUsd > 0 && ` · ${formatMoney(summary.reservedUsd)} pending`}
                  </dd>
                </div>
                {!assessment && (
                  <div>
                    <dt>Build effort</dt>
                    <dd>
                      {summary.toolCalls ?? "Unknown"} tool calls ·{" "}
                      {summary.elapsedMs === null
                        ? "Time unavailable"
                        : `${elapsedDuration(summary.elapsedMs)} of build time`}
                    </dd>
                  </div>
                )}
              </dl>
              {summary.scores.map((scale) => (
                <details key={scale.scale}>
                  <summary>
                    {statementText(scale.statement)}: {scale.values.length} of {scale.planned}{" "}
                    scores available
                  </summary>
                  <p>{scale.values.join(", ") || "No scores available"}</p>
                  <pre className={s.code}>{JSON.stringify(JSON.parse(scale.scale), null, 2)}</pre>
                </details>
              ))}
            </section>
          );
        })}
      </div>
      <ComparisonGridView grid={report.grid} runs={runs} />
      {report.transitions.map((transitions) => (
        <details
          className={c.changes}
          key={`${transitions.left}:${transitions.right}`}
          aria-label={`Changed answers between ${runOf(transitions.left).toLowerCase()} and ${runOf(transitions.right).toLowerCase()}`}
        >
          <summary>
            Changed answers on the same saved evidence: {runOf(transitions.left)} and{" "}
            {runOf(transitions.right).toLowerCase()}
          </summary>
          <dl className={s.changeCounts}>
            <div>
              <dt>Now available</dt>
              <dd>{transitions.newlyAvailable}</dd>
            </div>
            <div>
              <dt>Newly unavailable</dt>
              <dd>{transitions.newlyUnavailable}</dd>
            </div>
            <div>
              <dt>Changed answers or scores</dt>
              <dd>{transitions.changed}</dd>
            </div>
            <div>
              <dt>Unchanged</dt>
              <dd>{transitions.unchanged}</dd>
            </div>
          </dl>
          <p className={s.small}>
            Basalt checked the same build and observations again, so a changed answer doesn’t mean
            the build improved.
          </p>
          {transitions.rows
            .filter((row) => row.change !== "unchanged")
            .map(({ before, after }) => (
              <article className={s.changeRow} key={`${before.captureId}:${before.criterionId}`}>
                <h3>
                  {statementText(before.statement)} · Observation {before.pass}
                </h3>
                <p>
                  {answer(before)} <Arrow />
                  <span className={s.visuallyHidden}>changed to</span> {answer(after)}
                </p>
                <Link
                  className={s.action}
                  href={`/runs/${runs.find((run) => run.operationId === transitions.left)!.evidenceRun}?tab=evidence&candidate=${encodeURIComponent(before.candidateId)}&criterion=${encodeURIComponent(before.evidenceCellId ?? before.criterionId)}&pass=${before.pass}`}
                >
                  See the evidence for this changed answer
                </Link>
              </article>
            ))}
        </details>
      ))}
      <p className={s.small}>{report.limitation}</p>
    </main>
  );
}
