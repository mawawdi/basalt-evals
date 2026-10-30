"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AssessmentProgress } from "../../../../../dist/packages/contracts/src/assessments.js";
import type { ExemplarComparisonReport } from "../../../../../dist/packages/contracts/src/exemplars.js";
import type { OperationLifecycle } from "../../../../../dist/packages/contracts/src/lifecycle.js";
import { action, read, message, formatMoney } from "../../components/api";
import { PageHeading, Notice, Loading, Status, ProblemText } from "../../components/ui";
import s from "../../components/workbench.module.css";
import { decisionAnswer, statementText } from "../../components/result-display";
import { ArchivedNotice, RunActions, settledRun } from "../../components/run-actions";

type View = {
  status: AssessmentProgress;
  lifecycle: OperationLifecycle;
  spending: ExemplarComparisonReport["spending"];
};
const lifecycleNames: Record<string, string> = {
  queued: "Waiting to start",
  running: "Comparing",
  blocked: "Needs attention",
  stopping: "Stopping",
  stopped: "Stopped",
  completed: "Finished",
};
const pairNames: Record<string, string> = {
  win: "Better in both orders",
  loss: "Worse in both orders",
  flip: "Order change",
  insufficient: "Not enough evidence",
};

/** The progress and the answers of one run of anchor build pairs. It keeps to saved evidence. */
export function ComparisonConsole({
  operationId,
  archived,
}: {
  operationId: string;
  archived: boolean;
}) {
  const [view, setView] = useState<View | null>(null),
    [report, setReport] = useState<ExemplarComparisonReport | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `/api/operations/${operationId}`;
  useEffect(() => {
    let active = true;
    const refresh = () =>
      read<View>(`${base}/progress`)
        .then((next) => active && setView(next))
        .catch((cause) => active && setError(message(cause)));
    void refresh();
    const timer = setInterval(() => void refresh(), 1800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base]);
  const settled =
    !!view && (view.status.finished || ["blocked", "stopped"].includes(view.lifecycle.state));
  const answered = view ? view.status.completed + view.status.incomplete : 0;
  useEffect(() => {
    let active = true;
    if (answered > 0 || settled)
      void read<ExemplarComparisonReport>(`${base}/comparison`)
        .then((value) => active && setReport(value))
        .catch((cause) => active && setError(message(cause)));
    return () => {
      active = false;
    };
  }, [base, answered, settled]);
  async function command(input: unknown) {
    setBusy(true);
    setError("");
    try {
      await action(`${base}/commands`, "command_operation", input);
      setView(await read<View>(`${base}/progress`));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return <main>{error ? <Notice>{error}</Notice> : <Loading label="Loading run…" />}</main>;
  const ceiling = view.spending.billedUsd + view.spending.reservedUsd + view.spending.availableUsd;
  return (
    <main>
      <PageHeading
        title={view.status.title}
        description="This run compares each observation of a build with the anchor builds for each criterion. The judge answers twice, once with the builds in each order. It doesn’t make new builds or run Studio."
      />
      <div className={s.sectionHeading}>
        <div className={s.runSummary}>
          <Status live tone={view.lifecycle.blocker ? "warning" : "neutral"}>
            {lifecycleNames[view.lifecycle.state] ?? view.lifecycle.state}
          </Status>
          <div className={s.ledger}>
            <strong>
              {formatMoney(view.spending.billedUsd)} charged / {formatMoney(ceiling)} limit
            </strong>
            {view.spending.reservedUsd > 0 && (
              <span className={s.small}>
                {formatMoney(view.spending.reservedUsd)} pending charges
              </span>
            )}
          </div>
          <div className={s.ledger} role="status">
            <strong>
              {view.status.completed} of {view.status.planned} pairs decided
            </strong>
            {view.status.incomplete > 0 && (
              <span className={s.small}>
                {view.status.incomplete} with an order change or not enough evidence
              </span>
            )}
          </div>
        </div>
        <div className={s.row}>
          {(["stop", "resume", "reconcile"] as const)
            .filter((kind) => view.lifecycle.capabilities[kind].allowed)
            .map((kind) => (
              <button
                key={kind}
                className={kind === "resume" ? s.primary : s.secondary}
                disabled={busy}
                onClick={() =>
                  void command(
                    kind === "stop" ? { kind, reason: "Stopped from the console" } : { kind },
                  )
                }
              >
                {kind === "stop" ? "Stop" : kind === "resume" ? "Resume" : "Check payment status"}
              </button>
            ))}
          <Link
            className={s.secondary}
            href={`/runs/${view.status.sourceOperationId}?tab=evidence&candidate=${view.status.subjectIds[0]}`}
          >
            View original evidence
          </Link>
          <RunActions
            operationId={operationId}
            archived={archived}
            settled={settledRun(view.lifecycle.state)}
          />
        </div>
      </div>
      {archived && <ArchivedNotice />}
      {error && <Notice>{error}</Notice>}
      {view.lifecycle.blocker && (
        <Notice>
          <ProblemText text={view.lifecycle.blocker} />
        </Notice>
      )}
      {report && (
        <section className={s.section} aria-labelledby="comparison-results">
          <div className={s.sectionHeading}>
            <h2 id="comparison-results">Results</h2>
          </div>
          <div className={s.criterionList}>
            <div className={s.criterionCount}>
              <p className={s.small}>{report.limitation}</p>
            </div>
            {report.criteria.map((criterion) => (
              <section key={criterion.id} className={s.judgmentGroup}>
                <h3>{statementText(criterion.statement)}</h3>
                <ol className={s.judgments}>
                  {report.verdicts
                    .filter((item) => item.criterionId === criterion.id)
                    .map((item) => {
                      const pairs = report.results.filter(
                        (unit) =>
                          unit.captureId === item.captureId && unit.criterionId === criterion.id,
                      );
                      const answer = decisionAnswer(
                        item.verdict ? { verdict: item.verdict, score: null } : undefined,
                        false,
                      );
                      return (
                        <li key={item.captureId}>
                          <span className={s.judgmentPass}>Observation {pairs[0]?.pass}</span>
                          <Status tone={answer.tone}>{answer.text}</Status>
                          <p>
                            {pairs
                              .map((unit) => {
                                const pairName = unit.result
                                  ? pairNames[unit.result.outcome]
                                  : null;
                                return `Anchor build ${unit.exemplar + 1}: ${pairName ?? (unit.error ? "No answer" : "Not checked yet")}`;
                              })
                              .join(" · ")}
                          </p>
                        </li>
                      );
                    })}
                </ol>
              </section>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
