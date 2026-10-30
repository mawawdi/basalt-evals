"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AssessmentProgress,
  AssessmentReport,
  EvidenceCondition,
} from "../../../../../dist/packages/contracts/src/assessments.js";
import type { OperationLifecycle } from "../../../../../dist/packages/contracts/src/lifecycle.js";
import { assessmentOutcomeCounts } from "../../../../../dist/packages/contracts/src/assessments.js";
import { action, read, message, formatMoney, ApiError } from "../../components/api";
import { PageHeading, Notice, Loading, Status, Dialog, ProblemText } from "../../components/ui";
import { ArchivedNotice, RunActions, settledRun } from "../../components/run-actions";
import { LaunchBudget } from "../../components/run-configuration";
import { AuditLauncher } from "../../components/audit-launcher";
import s from "../../components/workbench.module.css";
import { decisionAnswer, statementText, testConditionLabel } from "../../components/result-display";
import { SensitivityResults } from "./sensitivity-results";

const lifecycleNames: Record<string, string> = {
  queued: "Waiting to start",
  running: "Checking",
  blocked: "Needs attention",
  stopping: "Stopping",
  stopped: "Stopped",
  completed: "Finished",
};
type View = {
  status: AssessmentProgress;
  lifecycle: OperationLifecycle;
  spending: AssessmentReport["spending"];
};
// A report reads only saved material, so a saved shape the current code rejects was written by an
// earlier Basalt. Elsewhere the same validator also checks requests, so this wording stays here.
function savedShapeProblem(error: string) {
  return /\bInvalid [^:]+: missing \[[^\]]*\]; unexpected \[/u.test(error)
    ? "An earlier version of Basalt saved this run, and this version can’t read it. Nothing was deleted. Start a new run to get current results."
    : undefined;
}

export function AssessmentConsole({
  operationId,
  conditions,
  archived,
}: {
  operationId: string;
  conditions: EvidenceCondition[];
  archived: boolean;
}) {
  // A sensitivity test adds controls to the original evidence; a reassessment has none.
  const sensitivity = conditions.length > 1,
    work = sensitivity ? "sensitivity test" : "reassessment";
  const [view, setView] = useState<View | null>(null),
    [report, setReport] = useState<AssessmentReport | null>(null),
    [error, setError] = useState(""),
    [connection, setConnection] = useState(""),
    [reportError, setReportError] = useState(""),
    [reportAttempt, setReportAttempt] = useState(0),
    [busy, setBusy] = useState(false),
    [budgetOpen, setBudgetOpen] = useState(false),
    [budget, setBudget] = useState("");
  const base = `/api/operations/${operationId}`;
  const requests = useRef(0);
  const commanding = useRef(false);
  useEffect(() => {
    let active = true;
    let polling = false;
    const refresh = async () => {
      if (polling || commanding.current) return;
      polling = true;
      const ticket = ++requests.current;
      try {
        const next = await read<View>(`${base}/progress`);
        if (active && ticket === requests.current) {
          setView(next);
          setConnection("");
        }
      } catch {
        if (active && ticket === requests.current)
          setConnection(
            "The connection stopped. The page shows the last saved progress and will reconnect automatically.",
          );
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1800);
    return () => {
      active = false;
      requests.current++;
      clearInterval(timer);
    };
  }, [base]);
  useEffect(() => {
    let active = true;
    if (
      view &&
      (view.status.completed > 0 ||
        view.status.finished ||
        ["blocked", "stopped"].includes(view.lifecycle.state))
    )
      void read<AssessmentReport>(`${base}/assessment`)
        .then((value) => {
          if (active) {
            setReport(value);
            setReportError("");
          }
        })
        .catch((cause) => active && setReportError(message(cause)));
    return () => {
      active = false;
    };
  }, [base, view?.status.finished, view?.status.completed, view?.lifecycle.state, reportAttempt]);
  async function command(input: unknown) {
    if (commanding.current) return;
    commanding.current = true;
    requests.current++;
    setBusy(true);
    setError("");
    let acknowledged = false;
    try {
      await action(`${base}/commands`, "command_operation", input);
      acknowledged = true;
      setView(await read<View>(`${base}/progress`));
      setBudgetOpen(false);
    } catch (cause) {
      // A failed command may still have changed the assessment, so reload its actual progress.
      if (!acknowledged)
        await read<View>(`${base}/progress`)
          .then(setView)
          .catch(() => undefined);
      setError(
        (acknowledged
          ? "Basalt saved the action, but the page could not refresh the progress. "
          : cause instanceof ApiError && cause.status >= 400 && cause.status < 500
            ? "The action didn’t go through. The current progress is shown below. "
            : "Basalt couldn’t confirm whether the action went through. Check the current progress before you try again. ") +
          message(cause),
      );
    } finally {
      setBusy(false);
      commanding.current = false;
    }
  }
  if (!view)
    return (
      <main>
        {connection && <Notice>{connection}</Notice>}
        <Loading label="Loading assessment…" />
      </main>
    );
  const ceiling = view.spending.billedUsd + view.spending.reservedUsd + view.spending.availableUsd;
  const outcomes = assessmentOutcomeCounts(view.status);
  // Observations that produced no answers explain themselves once, above the criteria.
  const missing = (report?.results ?? []).filter((unit) => !unit.result);
  // A recheck judges each observation once for each judge sample of its run.
  const sampled = !sensitivity && (report?.results ?? []).some((unit) => unit.repeat > 1);
  const unitName = (unit: { pass: number; repeat: number }) =>
    `Observation ${unit.pass}${sampled ? ` · judge sample ${unit.repeat}` : ""}`;
  // Checks that failed the same way explain themselves once, naming every affected check.
  const missingGroups = [
    ...Map.groupBy(missing, (unit) =>
      unit.error
        ? unit.error
        : view.status.stopped
          ? unit.unitId === view.status.inFlight
            ? `The ${work} stopped during this check. Its pending charge stays until the provider confirms the cost.`
            : `The ${work} stopped before the check.`
          : "Waiting for the judge's answers.",
    ),
  ];
  const state =
    view.status.finished && view.status.planned === 0
      ? "Nothing to check"
      : view.status.finished
        ? `${sensitivity ? "Sensitivity test" : "Reassessment"} complete${view.status.incomplete ? " · Some results missing" : ""}`
        : (lifecycleNames[view.lifecycle.state] ?? view.lifecycle.state);
  const evidenceHref = (subjectId: string, criterionId?: string, pass?: number) =>
    `/runs/${view.status.sourceOperationId}?tab=evidence&candidate=${subjectId}` +
    (criterionId ? `&criterion=${criterionId}&pass=${pass}` : "");
  return (
    <main>
      <PageHeading
        title={view.status.title}
        description={
          sensitivity
            ? "This sensitivity test checks saved evidence as recorded and with parts of it replaced or removed, to show whether the answers depend on that evidence. It doesn’t make new builds or run Studio."
            : "This reassessment checks saved evidence again with a different judge. It doesn’t make new builds or run Studio."
        }
      />
      <div className={s.sectionHeading}>
        <div className={s.runSummary}>
          <Status
            live
            tone={
              view.lifecycle.blocker || view.status.incomplete
                ? "warning"
                : view.status.finished && view.status.planned > 0
                  ? "good"
                  : view.status.finished || view.lifecycle.state === "stopped"
                    ? "neutral"
                    : "active"
            }
          >
            {state}
          </Status>
          <div className={s.ledger}>
            <strong>
              {formatMoney(view.spending.billedUsd)} charged / {formatMoney(ceiling)} limit
            </strong>
            <span className={s.meter} aria-hidden>
              <span
                style={{
                  width: `${ceiling ? Math.min(100, (100 * view.spending.billedUsd) / ceiling) : 0}%`,
                }}
              />
              <i
                style={{
                  width: `${ceiling ? Math.min(100, (100 * view.spending.reservedUsd) / ceiling) : 0}%`,
                }}
              />
            </span>
            {(view.spending.reservedUsd > 0 || report) && (
              <span className={s.small}>
                {[
                  view.spending.reservedUsd > 0 &&
                    `${formatMoney(view.spending.reservedUsd)} pending charges`,
                  report &&
                    `${formatMoney(report.lineage.billedUsd)} with the original run` +
                      (report.lineage.reservedUsd > 0
                        ? `, ${formatMoney(report.lineage.reservedUsd)} pending`
                        : "") +
                      (report.lineage.unavailable > 0
                        ? `, ${report.lineage.unavailable} cost ${report.lineage.unavailable === 1 ? "record" : "records"} unavailable`
                        : ""),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
          <div className={s.ledger} role="status">
            <strong>
              {view.status.completed} of {view.status.planned}{" "}
              {view.status.planned === 1 ? "answer" : "answers"}{" "}
              {sensitivity ? "recorded" : "decided"}
            </strong>
            <span className={s.small}>
              {[
                outcomes.incomplete > 0 &&
                  `${outcomes.incomplete} ${sensitivity ? "unavailable" : "undecided or unavailable"}`,
                outcomes.remaining > 0 &&
                  `${outcomes.remaining} ${view.status.stopped ? "stopped before the check" : "waiting for answers"}`,
              ]
                .filter(Boolean)
                .join(" · ") || `Every planned answer ${sensitivity ? "recorded" : "decided"}`}
            </span>
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
          {view.lifecycle.capabilities.budget.allowed && (
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => {
                setBudget(String(ceiling));
                setBudgetOpen(true);
              }}
            >
              Increase spending limit
            </button>
          )}
          <Link className={s.secondary} href={evidenceHref(view.status.subjectIds[0]!)}>
            View original evidence
          </Link>
          {view.status.finished && !sensitivity && <AuditLauncher operationIds={[operationId]} />}
          <RunActions
            operationId={operationId}
            archived={archived}
            settled={settledRun(view.lifecycle.state)}
          />
        </div>
      </div>
      {archived && <ArchivedNotice />}
      {connection && <Notice>{connection}</Notice>}
      {error && <Notice>{error}</Notice>}
      {reportError && (
        <Notice>
          <ProblemText text={reportError} />
          <button className={s.secondary} onClick={() => setReportAttempt((value) => value + 1)}>
            Reload results
          </button>
        </Notice>
      )}
      {view.lifecycle.blocker && (
        <Notice>
          <ProblemText text={view.lifecycle.blocker} />
        </Notice>
      )}
      {!report && !reportError && (view.status.finished || view.status.completed > 0) && (
        <Loading label="Loading results" />
      )}
      {report && (
        <section className={s.section} aria-labelledby="assessment-results">
          <div className={s.sectionHeading}>
            <h2 id="assessment-results">Results</h2>
          </div>
          {missingGroups.map(([message, units]) => (
            <Notice key={units[0]!.unitId} kind={units[0]!.error ? undefined : "info"}>
              <strong>
                {units
                  .slice(0, 4)
                  .map(
                    (unit) =>
                      `${unitName(unit)}${testConditionLabel(unit.condition) ? ` with ${testConditionLabel(unit.condition)}` : ""}`,
                  )
                  .join(", ")}
                {units.length > 4 && ` and ${units.length - 4} more`}:{" "}
              </strong>
              {units[0]!.error ? (
                <ProblemText text={units[0]!.error} summary={savedShapeProblem(units[0]!.error)} />
              ) : (
                message
              )}
            </Notice>
          ))}
          {sensitivity ? (
            <SensitivityResults report={report} evidenceHref={evidenceHref} />
          ) : (
            <div className={s.criterionList}>
              <div className={s.criterionCount}>
                <p className={s.small}>{report.limitation}</p>
              </div>
              {report.criteria.map((criterion) => (
                <section key={criterion.id} className={s.judgmentGroup}>
                  <h3>{statementText(criterion.statement)}</h3>
                  <ol className={s.judgments}>
                    {report.results.map((unit) => {
                      if (!unit.criterionIds.includes(criterion.id)) return null;
                      const decision = unit.result?.decisions.find(
                          (item) => item.criterionId === criterion.id,
                        ),
                        answer = decisionAnswer(decision, Boolean(unit.result || unit.error));
                      return (
                        <li key={unit.unitId}>
                          <span className={s.judgmentPass}>{unitName(unit)}</span>
                          <Status tone={answer.tone}>{answer.text}</Status>
                          <p>{decision?.rationale}</p>
                          <Link
                            className={s.action}
                            href={evidenceHref(unit.subjectId, criterion.id, unit.pass)}
                            aria-label={`Evidence for ${unitName(unit).toLowerCase()}: ${statementText(criterion.statement)}`}
                          >
                            Evidence
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </section>
      )}
      <Dialog
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        title="Increase the spending limit"
      >
        {error && <Notice>{error}</Notice>}
        <p className={s.small}>
          Current limit: {formatMoney(ceiling)}. Earlier charges and pending charges count toward
          the new total.
        </p>
        <LaunchBudget value={budget} onChange={setBudget} disabled={busy} scope="assessment" />
        <button
          className={s.primary}
          disabled={
            busy || !budget.trim() || !Number.isFinite(Number(budget)) || Number(budget) <= ceiling
          }
          onClick={() => void command({ kind: "budget", ceilingUsd: Number(budget) })}
        >
          Set new limit
        </button>
      </Dialog>
    </main>
  );
}
