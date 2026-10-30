"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CaretLeft, Check, LinkSimple } from "@phosphor-icons/react";
import { SaveRegression } from "../../components/regression-reference";
import { SavedSourceActions } from "./saved-source-actions";
import { SideBySide } from "./side-by-side";
import { ModelReportView } from "./model-report";
import { WorkloadLaunch } from "../../components/workload-launch";
import { AnalysisView, type Analysis } from "../../components/analysis-view";
import { EvidenceViewer } from "../../components/evidence-viewer";
import { AuditLauncher } from "../../components/audit-launcher";
import { CandidateTable, NotReachedReason } from "../../components/candidate-table";
import { ScreenRecordings } from "../../components/screen-recordings";
import { BuildHistoryView } from "../../components/build-history";
import { CauseList } from "../../components/cause-list";
import type { RunCauses } from "../../../../../dist/packages/contracts/src/failure.js";
import {
  BUILD_KEYS,
  CRITERION_KEYS,
  KeyHints,
  RESULTS_KEY,
  usePageKeys,
} from "../../components/evidence-keys";
import { ArchivedNotice, RunActions, settledRun } from "../../components/run-actions";
import { ProviderPauseNotice, UnitLogLink } from "./provider-pause";
import { UnclearCriteria } from "./unclear-criteria";
import {
  Tabs,
  PageHeading,
  Status,
  Notice,
  EmptyState,
  Loading,
  Dialog,
  LogTime,
  ScrollRegion,
  OutcomeLegend,
  markClass,
  ProblemText,
} from "../../components/ui";
import { elapsedDuration } from "../../../../../dist/packages/contracts/src/display.js";
import { action, read, message, formatMoney, ApiError } from "../../components/api";
import s from "../../components/workbench.module.css";
import r from "../../components/run-experience.module.css";
import {
  providerPauseSentence,
  type OperationView,
  type OperatorEvidence,
  type ActivityEvent,
  type AuthoringResult,
} from "../../../../../dist/packages/contracts/src/console.js";
import type { Page, ResultSummary } from "../../../../../dist/packages/contracts/src/catalog.js";
import { statusLabel } from "../../../../../dist/packages/contracts/src/catalog.js";
import {
  ADDRESSED_TO_JUDGE,
  addressedToJudge,
  buildOrder,
  counted,
  decisionAnswer,
  problemSummary,
  sampledAnswer,
  statementText,
  transitionLabel,
  checkExplanation,
  checkKind,
  judgeReads,
  observedValues,
} from "../../components/result-display";
type View = OperationView;
const criteriaCount = (cells: Array<{ criterionId: string }>) => {
  const count = new Set(cells.map((cell) => cell.criterionId)).size;
  return `${count} ${count === 1 ? "criterion" : "criteria"}`;
};
/** The answer of one check, with the combined answer of its judge samples when it has several. */
const cellAnswer = (cell: OperatorEvidence["candidates"][number]["cells"][number]) =>
  sampledAnswer(cell.samples) ?? statusLabel(cell.outcome);

type Evidence = OperatorEvidence;
export function OperationConsole({
  operationId,
  archived,
  modelNames,
  coverage,
}: {
  operationId: string;
  /** A person moved the run out of the default lists. */
  archived: boolean;
  /** Evaluations of the run whose coverage notes have notes to read. */
  coverage: Array<{ revisionId: string; title: string; href: string; notes: number }>;
  /** Display names for model routing IDs, so spending rows read like the rest of the run. */
  modelNames: Record<string, string>;
}) {
  const [endOpen, setEndOpen] = useState(false);
  const [view, setView] = useState<View | null>(null),
    [rows, setRows] = useState<Page<ResultSummary> | null>(null),
    [resultsPage, setResultsPage] = useState(1),
    [turnsPage, setTurnsPage] = useState(1),
    [evidence, setEvidence] = useState<Evidence | null>(null),
    [receipt, setReceipt] = useState<AuthoringResult | null>(null),
    [causes, setCauses] = useState<RunCauses | null>(null),
    [tab, setTab] = useState("progress"),
    [candidateId, setCandidate] = useState(""),
    [criterionId, setCriterion] = useState(""),
    [passId, setPass] = useState(""),
    [other, setOther] = useState(""),
    [modelRow, setModelRow] = useState(""),
    [against, setAgainst] = useState(""),
    [error, setError] = useState(""),
    [resultsError, setResultsError] = useState(""),
    [evidenceError, setEvidenceError] = useState(""),
    [detailsError, setDetailsError] = useState(""),
    [reload, setReload] = useState(0),
    [resultsLoading, setResultsLoading] = useState(false),
    [detailsLoading, setDetailsLoading] = useState(false),
    [copied, setCopied] = useState(false),
    [connection, setConnection] = useState(""),
    [busy, setBusy] = useState(false),
    [budgetOpen, setBudgetOpen] = useState(false),
    [budget, setBudget] = useState(""),
    [spendingDetails, setSpendingDetails] = useState<
      import("../../../../../dist/packages/contracts/src/console.js").SpendingDetail[]
    >([]),
    [activity, setActivity] = useState<Page<ActivityEvent> | null>(null),
    [activityPage, setActivityPage] = useState(1),
    [analysis, setAnalysis] = useState<Analysis | null>(null);
  const requests = useRef(0),
    evidenceRequest = useRef("");
  const contextHeading = useRef<HTMLHeadingElement>(null),
    focusEvidence = useRef(false),
    resultFocus = useRef(""),
    screen = useRef(tab);
  screen.current = tab;
  const base = `/api/operations/${operationId}`;
  const router = useRouter(),
    stage = view?.journey?.stage,
    shownStage = useRef(stage);
  useEffect(() => {
    // The server part of the page reads the coverage notes, which come after preparation.
    if (shownStage.current !== stage && shownStage.current !== undefined) router.refresh();
    shownStage.current = stage;
  }, [stage, router]);
  async function refresh() {
    const ticket = ++requests.current;
    const value = await read<View>(`/api/operations/${operationId}/progress`);
    if (ticket !== requests.current) return;
    setView(value);
    setConnection("");
  }
  useEffect(() => {
    let active = true;
    setView(null);
    setRows(null);
    setEvidence(null);
    evidenceRequest.current = "";
    const sync = () => {
      const p = new URLSearchParams(location.search);
      if (p.get("tab") === "evidence" && screen.current !== "evidence")
        focusEvidence.current = true;
      if (p.get("tab") === "results")
        resultFocus.current = p.get("criterion") ?? resultFocus.current;
      setTab(
        ["progress", "results", "models", "details", "evidence", "build", "compare"].includes(
          p.get("tab") ?? "",
        )
          ? p.get("tab")!
          : "progress",
      );
      setCandidate(p.get("candidate") ?? "");
      setCriterion(p.get("criterion") ?? "");
      setPass(p.get("pass") ?? "");
      setOther(p.get("other") ?? "");
      setModelRow(p.get("model") ?? "");
      setAgainst(p.get("against") ?? "");
      setResultsPage(Number(p.get("page")) || 1);
      setTurnsPage(Number(p.get("turns")) || 1);
      setActivityPage(Number(p.get("activityPage")) || 1);
    };
    sync();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const ticket = ++requests.current;
      try {
        const value = await read<View>(`/api/operations/${operationId}/progress`);
        if (active && ticket === requests.current) {
          setView(value);
          setConnection("");
          const params = new URLSearchParams(location.search);
          if (value.status.kind === "evaluation" && value.status.finished && !params.has("tab")) {
            params.set("tab", "results");
            setTab("results");
            history.replaceState(null, "", `${location.pathname}?${params}`);
          }
        }
      } catch {
        if (active && ticket === requests.current)
          setConnection(
            "The connection stopped. The page shows the last saved view and will reconnect automatically. Losing the connection doesn’t stop the run.",
          );
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1800);
    addEventListener("popstate", sync);
    return () => {
      active = false;
      requests.current++;
      clearInterval(interval);
      removeEventListener("popstate", sync);
    };
  }, [base]);
  const status = view?.status;
  const execution = status?.kind === "evaluation" ? status : null;
  const workflow = status?.workflow;
  const caps = view?.capabilities;
  const stopped = view?.lifecycle.state === "stopped";
  useEffect(() => {
    if (
      status?.kind === "authoring" &&
      (status.state === "completed" || status.state === "incomplete")
    )
      void read<AuthoringResult>(`${base}/authoring`)
        .then(setReceipt)
        .catch((cause) => setError(message(cause)));
  }, [base, status?.kind, status?.kind === "authoring" ? status.resultHash : null]);
  // Why work didn't finish loads only after a failure, so the progress poll stays small.
  const failedAt = view?.journey?.recentFailure?.at ?? null;
  useEffect(() => {
    if (!failedAt) return;
    const controller = new AbortController();
    void read<RunCauses>(`${base}/causes`, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCauses(value);
      })
      // The recent failure still shows its own reason, so a failed load only hides the list.
      .catch(() => {});
    return () => controller.abort();
  }, [base, failedAt]);
  useEffect(() => {
    if (!execution || !["results", "evidence", "build"].includes(tab)) return;
    const controller = new AbortController();
    setResultsLoading(true);
    setResultsError("");
    void read<Page<ResultSummary>>(`${base}/results?page=${resultsPage}`, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRows(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setResultsError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setResultsLoading(false);
      });
    return () => controller.abort();
  }, [
    base,
    tab,
    !!execution,
    resultsPage,
    execution?.answers.unavailable,
    execution?.completedStageCount,
    execution?.finished,
    execution?.stopped,
    view?.lifecycle.state,
    reload,
  ]);
  useEffect(() => {
    if (!execution || (tab !== "evidence" && !(tab === "results" && rows?.total === 1))) return;
    const selected = candidateId || rows?.items[0]?.candidateId;
    if (!selected) return;
    const controller = new AbortController();
    const key = [
      base,
      selected,
      execution.answers.unavailable,
      execution.completedStageCount,
      execution.finished,
      execution.stopped,
      view?.lifecycle.state,
      reload,
    ].join(":");
    if (evidenceRequest.current === key) return;
    if (!evidence?.candidates.some((item) => item.id === selected)) setEvidence(null);
    setEvidenceError("");
    void read<Evidence>(
      `${base}/evidence?candidate=${encodeURIComponent(selected)}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        evidenceRequest.current = key;
        setEvidence(value);
        if (!candidateId) {
          const params = new URLSearchParams(location.search);
          params.set("candidate", selected);
          history.replaceState(null, "", `${location.pathname}?${params}`);
          setCandidate(selected);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
            setEvidence(null);
          setEvidenceError(message(cause));
        }
      });
    return () => controller.abort();
  }, [
    base,
    tab,
    !!execution,
    candidateId,
    rows?.items[0]?.candidateId,
    rows?.total,
    execution?.answers.unavailable,
    execution?.completedStageCount,
    execution?.finished,
    execution?.stopped,
    view?.lifecycle.state,
    reload,
  ]);
  useEffect(() => {
    if (tab !== "details" || !view) return;
    const controller = new AbortController();
    setDetailsLoading(true);
    setDetailsError("");
    void read<import("../../../../../dist/packages/contracts/src/console.js").SpendingDetail[]>(
      `${base}/spending`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setSpendingDetails(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setDetailsError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    void read<Page<ActivityEvent>>(`${base}/activity?page=${activityPage}`, controller.signal)
      .then(setActivity)
      .catch((cause) => {
        if (!controller.signal.aborted) setDetailsError(message(cause));
      });
    return () => controller.abort();
  }, [
    base,
    tab,
    activityPage,
    !!view,
    execution?.finished,
    execution?.completedStageCount,
    view?.lifecycle.state,
    view?.spending.billedUsd,
    view?.spending.reservedUsd,
    reload,
  ]);
  function navigate(changes: Record<string, string>) {
    if (changes.tab === "evidence" && tab !== "evidence") focusEvidence.current = true;
    if (changes.tab === "results") resultFocus.current = criterionId;
    const p = new URLSearchParams(location.search);
    if ("criterion" in changes || "candidate" in changes) {
      for (const key of ["pass", "view", "frame", "source", "compare", "compareFrame"])
        p.delete(key);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value) p.set(key, value);
      else p.delete(key);
    }
    history.pushState(null, "", `${location.pathname}?${p}`);
    setTab(p.get("tab") ?? "progress");
    setCandidate(p.get("candidate") ?? "");
    setCriterion(p.get("criterion") ?? "");
    setPass(p.get("pass") ?? "");
    setOther(p.get("other") ?? "");
    setModelRow(p.get("model") ?? "");
    setAgainst(p.get("against") ?? "");
    setResultsPage(Number(p.get("page")) || 1);
    setTurnsPage(Number(p.get("turns")) || 1);
    setActivityPage(Number(p.get("activityPage")) || 1);
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    let acknowledged = false;
    try {
      await work();
      acknowledged = true;
      await refresh();
      if (budgetOpen) setBudgetOpen(false);
    } catch (cause) {
      // A failed command may still have changed the run, so show its actual state instead of
      // claiming the request was rejected.
      if (!acknowledged) await refresh().catch(() => undefined);
      setError(
        (acknowledged
          ? "The action is done, but the page could not refresh. Reload the page to see the latest state. "
          : cause instanceof ApiError && cause.status >= 400 && cause.status < 500
            ? "The action didn’t go through. The run below shows its current state. "
            : "Basalt couldn’t confirm whether the action went through. Check the run before you try again. ") +
          message(cause),
      );
    } finally {
      setBusy(false);
    }
  }
  const act = (kind: "stop" | "resume" | "reconcile", reason = "Stopped from the console") =>
    perform(async () => {
      await action(
        `/api/operations/${operationId}/commands`,
        "command_operation",
        kind === "stop" ? { kind, reason } : { kind },
      );
      setEvidence(null);
      evidenceRequest.current = "";
    });
  const candidate =
    evidence?.candidates.find((item) => item.id === candidateId) ?? evidence?.candidates[0];
  // A build that the run did not reach never started, so it has no evidence to show.
  const notReached = candidate?.notReached ?? null;
  const criterion =
    candidate?.cells.find((item) => item.id === criterionId) ??
    candidate?.cells.find(
      (item) =>
        item.criterionId === criterionId &&
        (!passId || item.pass === Number(passId) || item.passId === passId),
    ) ??
    candidate?.cells.find(
      (item) =>
        item.pass === Number(passId) &&
        ["rejected", "missing", "incomplete"].includes(item.outcome),
    ) ??
    candidate?.cells.find((item) => item.pass === Number(passId)) ??
    candidate?.cells[0];
  const observedValue = criterion?.criterion
    ? observedValues(criterion.criterion.explanation, criterion.criterion.observed)
    : null;
  // Evidence steps between criteria and keeps the observation being inspected.
  const criterionIds = [...new Set(candidate?.cells.map((cell) => cell.criterionId) ?? [])];
  const criterionPosition = criterion ? criterionIds.indexOf(criterion.criterionId) : -1;
  const cellFor = (id: string) =>
    candidate!.cells.find((cell) => cell.criterionId === id && cell.pass === criterion?.pass) ??
    candidate!.cells.find((cell) => cell.criterionId === id)!;
  const item = criterion
    ? candidate?.items.find((item) => item.id === criterion.itemId)
    : candidate?.items[0];
  // A cell is the authority for its observation. Contradictory URL state never
  // changes the evidence beside a recorded verdict, and unavailable stays unavailable.
  const boundPass = criterion?.passId ?? passId;
  const selectedPass = criterion
    ? criterion.passId === null
      ? undefined
      : item?.passes.find((p) => p.id === criterion.passId && p.number === criterion.pass)
    : boundPass
      ? item?.passes.find((p) => p.id === boundPass || p.number === Number(boundPass))
      : item?.passes[0];
  // The keys do what the buttons of Result navigation and Build navigation do. A build step
  // keeps the criterion, the observation and the evidence view.
  const builds = [...(rows?.items ?? [])].sort(buildOrder);
  // The other builds of the same evaluation can show this criterion side by side.
  const rivals = builds.filter(
    (row) => row.evaluationId === candidate?.evaluationId && row.candidateId !== candidate.id,
  );
  const buildPosition = builds.findIndex(
    (row) => row.candidateId === (tab === "build" ? candidateId : (candidate?.id ?? candidateId)),
  );
  usePageKeys(!!execution && (tab === "evidence" || tab === "build"), (command) => {
    if (command.kind === "results") {
      navigate(
        tab === "build"
          ? { tab: "results", candidate: "", turns: "" }
          : { tab: "results", criterion: "", pass: "" },
      );
      return true;
    }
    if (command.kind === "criterion") {
      const next =
        tab === "evidence" && criterion
          ? criterionIds[criterionPosition + command.step]
          : undefined;
      if (next === undefined) return false;
      navigate({ criterion: cellFor(next).id, pass: "" });
      return true;
    }
    const next = buildPosition < 0 ? undefined : builds[buildPosition + command.step];
    if (!next) return false;
    navigate(
      tab === "build"
        ? { candidate: next.candidateId, turns: "" }
        : {
            candidate: next.candidateId,
            criterion: criterion?.criterionId ?? criterionId,
            pass: criterion ? String(criterion.pass) : passId,
            view: new URLSearchParams(location.search).get("view") ?? "",
          },
    );
    return true;
  });
  useEffect(() => {
    if (tab !== "evidence" || !criterion) return;
    const params = new URLSearchParams(location.search);
    if (
      params.get("criterion") === criterion.id &&
      params.get("pass") === (criterion.passId ?? String(criterion.pass))
    )
      return;
    params.set("criterion", criterion.id);
    params.set("pass", criterion.passId ?? String(criterion.pass));
    history.replaceState(null, "", `${location.pathname}?${params}`);
    setCriterion(criterion.id);
    setPass(criterion.passId ?? String(criterion.pass));
  }, [tab, criterion?.id]);
  useEffect(() => {
    if (tab === "evidence" && focusEvidence.current && contextHeading.current) {
      contextHeading.current.focus();
      focusEvidence.current = false;
    }
    if (tab === "results" && resultFocus.current) {
      const target = document.querySelector<HTMLButtonElement>(
        `[data-criterion-cell="${resultFocus.current}"]`,
      );
      if (target) {
        target.focus();
        resultFocus.current = "";
      }
    }
  }, [tab, candidate?.id, criterion?.id, rows]);
  const finished = execution?.finished || workflow?.state === "complete";
  // One answer per check: the samples of a judge check combine. Not enough evidence is an answer.
  const unavailable = execution?.answers.unavailable ?? 0;
  const checksNotRequested = !!execution && execution.manifest.planned.criterionOutcomes === 0;
  const resultsIncomplete = !!execution && unavailable > 0;
  // A stopped preparation has no active work, so Stop closes the run: the console calls it End run.
  const preparationStopped = !!view?.preparationProblem && !view.lifecycle.ownerActive;
  // A failed preparation can succeed in a new run. Unclear criteria need an edit first.
  const preparationFailed =
    preparationStopped && view?.preparationProblem?.status === "preparation_failed";
  const criteriaUnclear =
    preparationStopped && view?.preparationProblem?.status === "needs_clarification";
  // A run of one library evaluation can send the person to edit that evaluation.
  const sources = workflow?.selection.sources ?? [];
  const editableEvaluation =
    sources.length === 1 && sources[0]!.kind === "evaluation" ? sources[0]!.id : null;
  // Work paused at the limit is recovered where the pause is reported.
  const spendingPaused =
    !!execution?.pausedAuthorizationHashes.length &&
    !!caps?.budget.allowed &&
    !view?.preparationProblem;
  // A provider pause has its own notice with Resume. The driver reports the same sentence.
  const providerPauses = execution?.providerPauses ?? [];
  const providerNotice = providerPauseSentence(providerPauses);
  const providerResume = !!providerNotice && !!caps?.resume.allowed;
  const blocker = view?.interruption ?? view?.lifecycle.blocker ?? null;
  const openBudget = () => {
    setBudget(String(ceiling));
    setBudgetOpen(true);
  };
  const hasCapturedEvidence = !!candidate?.sealed && candidate.captured > 0;
  const state =
    view?.preparationProblem?.status === "preparation_failed"
      ? "Preparation failed"
      : execution?.driver?.active && execution.driver.waiting === "studio"
        ? "Waiting for Studio"
        : // A stopped run reads as Stopped, as in Records, also when a failure came first.
          stopped
          ? "Stopped"
          : workflow?.state === "attention" || view?.interruption
            ? "Needs attention"
            : finished
              ? resultsIncomplete
                ? "Run complete · Some results missing"
                : checksNotRequested
                  ? "Run complete · Not checked"
                  : "Run complete"
              : "In progress";
  // A run without model builds and without judge checks sends no model request, for example a
  // Studio replay of a saved build. It has no charges and no use for a spending limit.
  const modelFree =
    !!execution &&
    execution.manifest.planned.independentBuilderTrials === 0 &&
    execution.manifest.planned.judgmentBatches === 0 &&
    !view?.spending.billedUsd &&
    !view?.spending.reservedUsd;
  const ceiling =
    view?.ceilingUsd ??
    workflow?.ceilingUsd ??
    (view?.spending.billedUsd ?? 0) +
      (view?.spending.reservedUsd ?? 0) +
      (view?.spending.availableUsd ?? 0);
  // Repeated builds of one evaluation and model read as one row with a build count.
  const spendingRows = [
    ...spendingDetails
      .reduce((groups, row) => {
        const build = row.id.startsWith("builder:");
        const split = build ? row.name.lastIndexOf(" · ") : -1;
        const group = groups.get(row.name) ?? {
          id: row.id,
          title: split < 0 ? row.name : row.name.slice(0, split),
          model:
            split < 0 ? "" : (modelNames[row.name.slice(split + 3)] ?? row.name.slice(split + 3)),
          builds: 0,
          chargedUsd: 0,
          pendingUsd: 0,
        };
        group.builds += build ? 1 : 0;
        group.chargedUsd += row.chargedUsd;
        group.pendingUsd += row.pendingUsd;
        return groups.set(row.name, group);
      }, new Map<string, { id: string; title: string; model: string; builds: number; chargedUsd: number; pendingUsd: number }>())
      .values(),
  ].map((row) => ({
    ...row,
    meta: [row.model, row.builds ? `${row.builds} ${row.builds === 1 ? "build" : "builds"}` : ""]
      .filter(Boolean)
      .join(" · "),
  }));
  return (
    <main className={s.runWorkspace}>
      <PageHeading
        title={workflow?.title ?? view?.context?.title ?? "Evaluation run"}
        action={
          <button
            className={`${s.textButton} ${s.copyLink}`}
            onClick={() => {
              void navigator.clipboard
                .writeText(window.location.href)
                .then(() => setCopied(true))
                .catch(() =>
                  setError(
                    "The link couldn’t be copied. Copy the address from your browser instead.",
                  ),
                );
            }}
          >
            {copied ? <Check size={18} aria-hidden /> : <LinkSimple size={18} aria-hidden />}
            <span>{copied ? "Link copied" : "Copy link"}</span>
          </button>
        }
      />
      {connection && <Notice kind="info">{connection}</Notice>}
      {error && <Notice>{error}</Notice>}
      {!view ? (
        <Loading label="Loading saved progress" />
      ) : (
        <>
          <div className={s.sectionHeading}>
            <div className={s.runSummary}>
              <Status
                live
                tone={
                  state === "Preparation failed"
                    ? "bad"
                    : state === "Needs attention"
                      ? "warning"
                      : state === "Stopped"
                        ? "neutral"
                        : finished
                          ? resultsIncomplete
                            ? "warning"
                            : checksNotRequested
                              ? "neutral"
                              : "good"
                          : "active"
                }
              >
                {state}
              </Status>
              {modelFree ? (
                <div className={s.ledger}>
                  <strong>No model requests</strong>
                </div>
              ) : (
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
                  {view.spending.reservedUsd > 0 && (
                    <span className={s.small}>
                      {formatMoney(view.spending.reservedUsd)} pending charges
                    </span>
                  )}
                </div>
              )}
              {view.testedModels.length > 0 && (
                <div className={s.ledger}>
                  <span className={s.small}>
                    {view.testedModels.length === 1 ? "Tested model" : "Tested models"}
                  </span>
                  <span className={s.modelNames}>{view.testedModels.join(", ")}</span>
                </div>
              )}
            </div>
            <div className={s.row}>
              {caps?.stop.allowed &&
                (preparationStopped ? (
                  <button className={s.secondary} disabled={busy} onClick={() => setEndOpen(true)}>
                    End run
                  </button>
                ) : (
                  <button className={s.secondary} disabled={busy} onClick={() => void act("stop")}>
                    Stop
                  </button>
                ))}
              {caps?.resume.allowed && !providerResume && (
                <button className={s.primary} disabled={busy} onClick={() => void act("resume")}>
                  Resume
                </button>
              )}
              {caps?.reconcile.allowed && (
                <button
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => void act("reconcile")}
                >
                  Check payment status
                </button>
              )}
              <RunActions
                operationId={operationId}
                archived={archived}
                settled={settledRun(view.lifecycle.state)}
                exportable={!!execution}
              />
            </div>
          </div>
          {archived && <ArchivedNotice />}
          <Dialog open={endOpen} onClose={() => !busy && setEndOpen(false)} title="End run?">
            <p>
              The run closes and leaves Needs attention. Its charges and records stay, and you can
              still open it from Records.
            </p>
            <div className={s.row}>
              <button
                className={s.primary}
                disabled={busy}
                onClick={() =>
                  void act("stop", "Ended from the console after preparation failed").then(() =>
                    setEndOpen(false),
                  )
                }
              >
                {busy ? "Ending…" : "End run"}
              </button>
              <button className={s.secondary} disabled={busy} onClick={() => setEndOpen(false)}>
                Cancel
              </button>
            </div>
          </Dialog>
          <ProviderPauseNotice
            pauses={providerPauses}
            canResume={providerResume}
            busy={busy}
            onResume={() => void act("resume")}
          />
          {blocker && blocker !== providerNotice && (
            <Notice>
              <ProblemText text={blocker} />
              {view.preparationProblem && (
                <>
                  {preparationFailed && (
                    <p>
                      Each run prepares the checks again, so a new run can succeed. If it fails the
                      same way again, edit the criterion that the details mention.
                    </p>
                  )}
                  {criteriaUnclear ? (
                    <UnclearCriteria base={base} />
                  ) : (
                    <details className={s.section}>
                      <summary>Technical details</summary>
                      <ul className={s.diagnostics}>
                        {view.preparationProblem.diagnostics.map((diagnostic, i) => (
                          <li key={i}>{diagnostic}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {workflow && (
                    <div className={`${s.row} ${s.noticeAction}`}>
                      {/* The editor shows each unclear criterion beside the text to change. */}
                      {criteriaUnclear ? (
                        <Link
                          className={s.primary}
                          href={`/evaluations/new?workflow=${operationId}`}
                        >
                          Edit evaluation
                        </Link>
                      ) : (
                        preparationFailed &&
                        editableEvaluation && (
                          <Link
                            className={s.secondary}
                            href={`/evaluations/new?evaluation=${editableEvaluation}`}
                          >
                            Edit evaluation
                          </Link>
                        )
                      )}
                      <Link
                        className={s.secondary}
                        href={
                          workflow.draftIds.length === 1
                            ? `/runs/new?eval=${workflow.draftIds[0]}`
                            : "/runs/new"
                        }
                      >
                        Set up a new run
                      </Link>
                    </div>
                  )}
                </>
              )}
              {caps?.setup.allowed && (
                <Link className={s.secondary} href="/settings">
                  Open Settings
                </Link>
              )}
              {spendingPaused && (
                <div className={s.noticeAction}>
                  <button className={s.primary} disabled={busy} onClick={openBudget}>
                    Increase spending limit
                  </button>
                </div>
              )}
            </Notice>
          )}
          {execution && resultsIncomplete && execution.finished && (
            <p className={s.runMissing} role="status">
              {unavailable} of {execution.answers.planned} answers unavailable.
            </p>
          )}
          <Tabs label="Run views">
            {["results", "models", "progress", "details"].map((value) => (
              <button
                key={value}
                aria-current={
                  tab === value ||
                  (["evidence", "build", "compare"].includes(tab) && value === "results")
                    ? "page"
                    : undefined
                }
                onClick={() => navigate({ tab: value })}
              >
                {value[0]!.toUpperCase() + value.slice(1)}
              </button>
            ))}
          </Tabs>
          {tab === "progress" ? (
            <div className={s.stack}>
              <section className={`${s.panel} ${s.panelBody}`}>
                <div className={s.sectionHeading}>
                  <h2>{finished ? "Run summary" : "Progress"}</h2>
                  {finished && execution && (
                    <button className={s.primary} onClick={() => navigate({ tab: "results" })}>
                      View results
                    </button>
                  )}
                </div>
                {(() => {
                  const stages: Array<[string, string, string]> = [
                    [
                      "readiness",
                      "Checking Studio",
                      "Makes sure Studio can open and record the game.",
                    ],
                    ...(!view.journey?.preparationSkipped
                      ? ([
                          [
                            "preparation",
                            "Preparing tests",
                            "Turns your success criteria into automatic checks.",
                          ],
                        ] as Array<[string, string, string]>)
                      : []),
                    ...(status?.kind === "authoring" && status.action.stage === "controls"
                      ? ([
                          [
                            "references",
                            "Testing reference builds",
                            "Tries the checks on reference builds before any model builds.",
                          ],
                        ] as Array<[string, string, string]>)
                      : status?.kind === "authoring" && status.action.stage === "explanation"
                        ? ([
                            [
                              "explanation",
                              "Explaining failures",
                              "A model writes hypotheses about the flagged criteria.",
                            ],
                          ] as Array<[string, string, string]>)
                        : workflow?.selection.objective === "prepare"
                          ? []
                          : ([
                              ...(view.journey?.plannedCandidates
                                ? [
                                    [
                                      "builder",
                                      "Building with selected models",
                                      view.journey
                                        ? `${view.journey.completedCandidates} of ${view.journey.plannedCandidates} ${view.journey.plannedCandidates === 1 ? "build" : "builds"} finished${view.journey.notReachedCandidates ? `, ${view.journey.notReachedCandidates} not reached` : ""}`
                                        : "Every model receives the same prompt, tools and limits.",
                                    ],
                                  ]
                                : []),
                              [
                                "capture",
                                "Collecting evidence",
                                view.journey?.plannedCaptures != null &&
                                view.journey.plannedCaptures > 0
                                  ? `${view.journey?.completedCaptures ?? 0} of ${counted(view.journey.plannedCaptures, "observation")} collected`
                                  : "Plays each finished build in Studio and records it.",
                              ],
                              ...(!checksNotRequested
                                ? [
                                    [
                                      "scoring",
                                      "Checking results",
                                      execution
                                        ? `${execution.answers.planned - execution.answers.unavailable} of ${execution.answers.planned} answers in`
                                        : "Code checks test the recorded facts, and the judge examines the evidence.",
                                    ],
                                  ]
                                : []),
                            ] as Array<[string, string, string]>)),
                    [
                      "complete",
                      workflow?.selection.objective === "prepare" ? "Ready to run" : "Results",
                      workflow?.selection.objective === "prepare"
                        ? "Saves the checks, so the evaluation can run in a benchmark."
                        : "Shows each result with its evidence.",
                    ],
                  ];
                  const reached = stages.findIndex(([key]) => key === view.journey?.stage);
                  const journey = view.journey;
                  // Builds, observations and checks can run at the same time. Each stage from
                  // the earliest unfinished stage to the latest active stage is current.
                  const lastActive = Math.max(
                    reached,
                    ...(journey?.activeStages ?? []).map((key) =>
                      stages.findIndex(([item]) => item === key),
                    ),
                  );
                  const until = (start: string) =>
                    elapsedDuration(
                      (journey?.endedAt ? Date.parse(journey.endedAt) : Date.now()) -
                        Date.parse(start),
                    );
                  const single = journey?.activity.length === 1 ? journey.activity[0]! : null;
                  const observationWindowMs =
                    journey?.activity.find((item) => item.observationWindowMs !== null)
                      ?.observationWindowMs ?? null;
                  const limitMs =
                    journey?.activity.find((item) => item.limitMs !== null)?.limitMs ?? null;
                  // A provider pause shows no clock, because nothing runs until Resume.
                  const paused =
                    !!providerNotice && !finished && view?.lifecycle.state === "blocked";
                  // The current step carries its own timing and explanation, so the
                  // timeline is the single place that says what is happening now.
                  const currentDetails = journey && (
                    <div className={s.currentStep}>
                      <p
                        role="status"
                        className={
                          !paused && stages[reached]?.[1] === journey.action
                            ? s.visuallyHidden
                            : undefined
                        }
                      >
                        <strong>{paused ? "Paused" : journey.action}</strong>
                      </p>
                      {!paused && (journey.startedAt || single) && (
                        <p className={s.elapsed}>
                          {journey.startedAt && (
                            <span>
                              {journey.endedAt && !finished
                                ? "Ran for:"
                                : finished
                                  ? "Total time:"
                                  : "Running for:"}{" "}
                              <strong>{until(journey.startedAt)}</strong>
                            </span>
                          )}
                          {single && (
                            <span>
                              This step: <strong>{until(single.startedAt)}</strong>
                            </span>
                          )}
                        </p>
                      )}
                      {journey.activity.length > 1 && (
                        <ul className={s.unitList} aria-label="Work in progress">
                          {journey.activity.map((item, index) => (
                            <li key={`${index}-${item.startedAt}`}>
                              <span>{item.action}</span>
                              <span>{until(item.startedAt)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {observationWindowMs !== null && (
                        <p className={s.small}>
                          Each observation records {elapsedDuration(observationWindowMs)} of
                          gameplay, plus the time to start Studio and save the evidence.
                        </p>
                      )}
                      {limitMs !== null && (
                        <details className={s.small}>
                          <summary>When Studio counts as stuck</summary>
                          <p className={s.small}>
                            If one Studio step runs longer than {elapsedDuration(limitMs)}, Basalt
                            treats it as stuck. This is not an estimate of how long the run takes,
                            and it is not a time limit for the model.
                          </p>
                        </details>
                      )}
                      {journey.recentFailure && (
                        <Notice kind="info">
                          <strong>
                            The {journey.recentFailure.action.toLowerCase()} did not complete.
                          </strong>{" "}
                          {/* A build says why it stopped. The category stays in Full error. */}
                          <ProblemText
                            text={journey.recentFailure.reason}
                            summary={view.buildStop ?? undefined}
                          />
                        </Notice>
                      )}
                      {journey.recentFailure && causes && (
                        <CauseList
                          causes={causes.causes}
                          operationId={operationId}
                          buildTitle={(subjectId) => causes.buildTitles[subjectId] ?? null}
                        />
                      )}
                      {!journey.evaluatedModelStarted && journey.plannedCandidates > 0 && (
                        <p>No model has started a build yet.</p>
                      )}
                      {journey.preparationSkipped && (
                        <p className={s.small}>This run reuses tests that were prepared earlier.</p>
                      )}
                    </div>
                  );
                  return (
                    <>
                      {reached < 0 && currentDetails}
                      <ol className={s.timeline}>
                        {stages.map(([key, title, description], i) => {
                          const here = reached === i;
                          const active = reached >= 0 && i > reached && i <= lastActive;
                          const state = here
                            ? finished
                              ? "done"
                              : journey?.endedAt
                                ? "stopped"
                                : "current"
                            : active && !finished && !journey?.endedAt
                              ? "current"
                              : reached > i || (finished && reached < 0)
                                ? "done"
                                : "upcoming";
                          return (
                            <li key={key} data-state={state}>
                              <span className={s.stageMark}>{i + 1}</span>
                              <div>
                                <h3>
                                  {title}{" "}
                                  {(here || state === "current") && (
                                    <Status
                                      tone={
                                        finished
                                          ? "neutral"
                                          : journey?.endedAt
                                            ? "warning"
                                            : "active"
                                      }
                                    >
                                      {finished
                                        ? "Done"
                                        : journey?.endedAt
                                          ? "Stopped here"
                                          : "Current"}
                                    </Status>
                                  )}
                                </h3>
                                <p>{description}</p>
                                {here && currentDetails}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    </>
                  );
                })()}
                {coverage.map((item) => (
                  <Notice kind="info" key={item.revisionId}>
                    The coverage notes for {item.title} have{" "}
                    {item.notes === 1 ? "1 note" : `${item.notes} notes`} to read.{" "}
                    <Link className={s.action} href={item.href}>
                      Read coverage notes
                    </Link>
                  </Notice>
                ))}
                {status?.kind === "authoring" &&
                  status.action.stage === "explanation" &&
                  status.state === "completed" && (
                    <Notice kind="info">
                      The hypotheses are on the evaluation page, beside its plan warnings.{" "}
                      <Link
                        className={s.action}
                        href={`/evaluations/${status.action.revisionId}#failure-hypotheses`}
                      >
                        Read hypotheses
                      </Link>
                    </Notice>
                  )}
                {receipt && (
                  <details className={s.section}>
                    <summary>Technical record of test preparation</summary>
                    <pre className={s.code}>{JSON.stringify(receipt.result, null, 2)}</pre>
                  </details>
                )}
              </section>
              <aside className={s.progressFooter}>
                {view.lifecycle.ownerActive && (
                  <p className={s.small}>
                    Closing this page won’t stop the run. You can find it on Benchmarks under
                    Running now.
                  </p>
                )}
                <div className={s.row}>
                  {caps?.amend.allowed &&
                    view.preparationProblem?.status !== "preparation_failed" && (
                      <Link
                        className={s.secondary}
                        href={`/evaluations/new?workflow=${operationId}`}
                      >
                        Edit evaluation
                      </Link>
                    )}
                  {Object.values(workflow?.revisions ?? {})[0] && (
                    <Link
                      className={s.action}
                      href={`/evaluations/${Object.values(workflow!.revisions)[0]}`}
                    >
                      Open evaluation
                    </Link>
                  )}
                </div>
              </aside>
            </div>
          ) : !execution && tab !== "details" ? (
            <>
              <EmptyState
                title={
                  view.interruption || stopped
                    ? "No builds started"
                    : "Results are not available yet"
                }
              >
                {view.interruption || stopped
                  ? "The run stopped before any model started building. Progress explains why and what to do next, and Details shows any charges so far."
                  : "Results appear here as each build is checked. Progress shows the current step."}
              </EmptyState>
              <div className={r.emptyActions}>
                <button className={s.secondary} onClick={() => navigate({ tab: "progress" })}>
                  Open progress
                </button>
              </div>
            </>
          ) : tab === "results" && execution ? (
            <>
              <div className={s.sectionHeading}>
                <div>
                  <h2>Build results</h2>
                  {rows?.total !== 1 && (
                    <p>Each row is one build. Expand a row to see its observations.</p>
                  )}
                </div>
                <details data-results-actions>
                  <summary>Result actions</summary>
                  <div className={s.row}>
                    {caps?.review.allowed && <AuditLauncher operationIds={[operationId]} />}
                    <button
                      className={s.textButton}
                      disabled={busy}
                      onClick={() =>
                        void perform(async () =>
                          setRows(
                            await read<Page<ResultSummary>>(`${base}/results?page=${resultsPage}`),
                          ),
                        )
                      }
                    >
                      Refresh results
                    </button>
                  </div>
                </details>
              </div>
              {resultsError && (
                <Notice>
                  <ProblemText text={resultsError} />
                  <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
                    Reload results
                  </button>
                </Notice>
              )}
              {evidenceError && rows?.total === 1 && (
                <Notice>
                  <ProblemText text={evidenceError} />
                  <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
                    Reload criteria
                  </button>
                </Notice>
              )}
              {!rows || (resultsLoading && rows.page !== resultsPage) ? (
                resultsError ? null : (
                  <Loading label="Loading build results" />
                )
              ) : rows.total === 1 ? (
                <div className={s.criterionList}>
                  {!candidate ? (
                    evidenceError ? null : (
                      <Loading label="Loading success criteria" />
                    )
                  ) : !candidate.cells.length ? (
                    <>
                      <EmptyState
                        title={
                          hasCapturedEvidence
                            ? "Recorded, not checked"
                            : checksNotRequested
                              ? "Not checked"
                              : "No results yet"
                        }
                      >
                        {(hasCapturedEvidence ||
                          candidate.items.some((item) => item.sources.length)) && (
                          <span>
                            {candidate.captured} of{" "}
                            {counted(candidate.plannedCaptures, "observation")} collected.{" "}
                          </span>
                        )}
                        {checksNotRequested
                          ? "This run did not include checks. You can still examine the recorded evidence or check it later."
                          : "Progress shows whether this build is still running or stopped before it was checked."}
                      </EmptyState>
                      <div className={r.emptyActions}>
                        {hasCapturedEvidence && (
                          <>
                            <button
                              className={s.primary}
                              onClick={() =>
                                navigate({
                                  tab: "evidence",
                                  candidate: candidate.id,
                                  criterion: "",
                                  pass: "",
                                })
                              }
                            >
                              View evidence
                            </button>
                            <WorkloadLaunch
                              kind="recheck"
                              operationId={operationId}
                              subjectId={candidate.id}
                              revisionId={candidate.evaluationId}
                            />
                          </>
                        )}
                        <button
                          className={s.secondary}
                          onClick={() => navigate({ tab: "progress" })}
                        >
                          Open progress
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={s.criterionCount}>
                        <p className={s.small}>
                          {criteriaCount(candidate.cells)}, {candidate.cells.length}{" "}
                          {candidate.cells.length === 1 ? "result" : "results"} from this build.
                          Choose a result to inspect its evidence.
                        </p>
                        <OutcomeLegend
                          pending={!execution.finished && !stopped}
                          split={candidate.cells.some((cell) => cell.outcome === "split")}
                          insufficient={candidate.cells.some(
                            (cell) => cell.outcome === "insufficient",
                          )}
                        />
                      </div>
                      {[...new Set(candidate.cells.map((cell) => cell.criterionId))].map((id) => {
                        const cells = candidate.cells.filter((cell) => cell.criterionId === id);
                        const count = (outcome: string) =>
                          cells.filter((cell) => cell.outcome === outcome).length;
                        const met = count("verified"),
                          notMet = count("rejected"),
                          split = count("split"),
                          scored = count("scored"),
                          insufficient = count("insufficient"),
                          other = cells.length - met - notMet - split - scored - insufficient;
                        // An answer that never arrived is not a failure; the tally names each kind.
                        const tally =
                          met === cells.length
                            ? `${met} of ${cells.length} met`
                            : [
                                met && `${met} met`,
                                notMet && `${notMet} not met`,
                                split && `${split} split`,
                                scored && `${scored} scored`,
                                insufficient && `${insufficient} not enough evidence`,
                                other &&
                                  `${other} ${!execution.finished && !stopped ? "not yet checked" : "unavailable"}`,
                              ]
                                .filter(Boolean)
                                .join(", ");
                        const addressed = cells.some((cell) =>
                          addressedToJudge(cell.addressedToEvaluator),
                        );
                        return (
                          <section key={id} className={s.criterionGroup}>
                            <div>
                              <h2>{statementText(cells[0]!.statement)}</h2>
                              <p className={s.small} data-check-kind>
                                {checkKind(cells)}
                              </p>
                            </div>
                            {addressed && <Status tone="warning">{ADDRESSED_TO_JUDGE}</Status>}
                            <div className={s.criterionObservations}>
                              {cells.map((cell) => (
                                <button
                                  className={`${s.mark} ${markClass(cell.outcome, !execution.finished && !stopped)}`}
                                  key={cell.id}
                                  data-criterion-cell={cell.id}
                                  aria-label={`Inspect ${statementText(cell.statement)}, observation ${cell.pass}, ${cellAnswer(cell)}`}
                                  title={`Observation ${cell.pass}: ${cellAnswer(cell)}`}
                                  onClick={() =>
                                    navigate({
                                      tab: "evidence",
                                      candidate: candidate.id,
                                      criterion: cell.id,
                                    })
                                  }
                                >
                                  {cell.pass}
                                </button>
                              ))}
                              <span className={s.criterionTally}>{tally}</span>
                            </div>
                          </section>
                        );
                      })}
                    </>
                  )}
                </div>
              ) : (
                <CandidateTable
                  candidates={rows?.items ?? []}
                  history={(build) =>
                    navigate({ tab: "build", candidate: build.candidateId, turns: "" })
                  }
                  inspect={(candidate, pass) =>
                    navigate({
                      tab: "evidence",
                      candidate: candidate.candidateId,
                      criterion: "",
                      pass: pass ? String(pass) : "",
                    })
                  }
                />
              )}
              {rows && rows.pages > 1 && (
                <div className={`${s.row} ${s.pager}`}>
                  <button
                    className={s.secondary}
                    disabled={rows.page <= 1}
                    onClick={() => navigate({ page: String(rows.page - 1) })}
                  >
                    Previous builds
                  </button>
                  <span>
                    {rows.page} / {rows.pages} · {rows.total} builds
                  </span>
                  <button
                    className={s.secondary}
                    disabled={rows.page >= rows.pages}
                    onClick={() => navigate({ page: String(rows.page + 1) })}
                  >
                    Next builds
                  </button>
                </div>
              )}
              <p className={`${s.small} ${s.section}`}>
                Build cost doesn’t include preparing tests or checking results. Details shows all
                spending.
              </p>
              {execution.manifest.protocolKind && (
                <section className={s.section}>
                  <h2>Benchmark analysis</h2>
                  <p className={s.lede}>See the planned comparison and how certain it is.</p>
                  <button
                    className={s.secondary}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () =>
                        setAnalysis(
                          await action<Analysis>(
                            `${base}/analysis`,
                            "seal_experiment_analysis",
                            {},
                          ),
                        ),
                      )
                    }
                  >
                    Inspect analysis
                  </button>
                  {analysis !== null && <AnalysisView value={analysis} />}
                </section>
              )}
            </>
          ) : tab === "models" && execution ? (
            <ModelReportView
              operationId={operationId}
              selected={modelRow}
              against={against}
              navigate={navigate}
              refresh={[
                execution.answers.unavailable,
                execution.completedStageCount,
                execution.finished,
                execution.stopped,
                reload,
              ].join(":")}
            />
          ) : tab === "compare" && execution ? (
            <SideBySide
              operationId={operationId}
              left={candidateId}
              right={other}
              criterionId={criterionId}
              observation={passId}
              navigate={navigate}
            />
          ) : tab === "build" && execution ? (
            <BuildHistoryView
              operationId={operationId}
              candidateId={candidateId}
              title={(() => {
                const row = rows?.items.find((item) => item.candidateId === candidateId);
                return row ? `${row.model} · ${row.candidateTitle}` : "Build";
              })()}
              page={turnsPage}
              navigate={navigate}
              hints={
                <KeyHints
                  hints={[
                    ...(buildPosition >= 0 && builds.length > 1 ? [BUILD_KEYS] : []),
                    RESULTS_KEY,
                  ]}
                />
              }
            />
          ) : tab === "evidence" ? (
            evidenceError && !evidence ? (
              <Notice>
                <ProblemText text={evidenceError} />
                <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
                  Reload evidence
                </button>
              </Notice>
            ) : !evidence ? (
              <Loading label="Loading evidence" />
            ) : candidate ? (
              <>
                {evidenceError && (
                  <Notice>
                    <ProblemText text={evidenceError} /> Showing the evidence loaded earlier for
                    this build.{" "}
                    <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
                      Reload evidence
                    </button>
                  </Notice>
                )}
                <nav className={r.evidenceBar} aria-label="Result navigation">
                  <button
                    className={s.textButton}
                    aria-keyshortcuts="Escape"
                    onClick={() => navigate({ tab: "results", criterion: "", pass: "" })}
                  >
                    <CaretLeft size={16} aria-hidden />
                    All results
                  </button>
                  {criterion && (
                    <div className={r.stepper}>
                      <button
                        className={s.secondary}
                        aria-keyshortcuts="ArrowLeft"
                        disabled={criterionPosition <= 0}
                        onClick={() =>
                          navigate({
                            criterion: cellFor(criterionIds[criterionPosition - 1]!).id,
                            pass: "",
                          })
                        }
                      >
                        Previous criterion
                      </button>
                      <span className={r.criteriaCount}>
                        {/* The authored number, as Activity and the analysis show it. Previous
                            and Next step only through the criteria of this run. */}
                        {criterion.number === null
                          ? "Unnamed criterion"
                          : `Criterion ${criterion.number} of ${candidate.criterionCount}`}
                      </span>
                      <button
                        className={s.secondary}
                        aria-keyshortcuts="ArrowRight"
                        disabled={criterionPosition >= criterionIds.length - 1}
                        onClick={() =>
                          navigate({
                            criterion: cellFor(criterionIds[criterionPosition + 1]!).id,
                            pass: "",
                          })
                        }
                      >
                        Next criterion
                      </button>
                    </div>
                  )}
                  {candidate.builder && !notReached && (
                    <button
                      className={s.textButton}
                      onClick={() => navigate({ tab: "build", candidate: candidate.id, turns: "" })}
                    >
                      How it was built
                    </button>
                  )}
                </nav>
                <KeyHints
                  hints={[
                    ...(criterion && criterionIds.length > 1 ? [CRITERION_KEYS] : []),
                    ...(buildPosition >= 0 && builds.length > 1 ? [BUILD_KEYS] : []),
                    RESULTS_KEY,
                  ]}
                />
                <div
                  className={`${r.pickers} ${criterion && rivals.length ? r.comparePickers : ""}`}
                >
                  <div className={s.field}>
                    <label htmlFor="candidate">Build</label>
                    <select
                      id="candidate"
                      value={candidate.id}
                      onChange={(e) =>
                        navigate({ candidate: e.target.value, criterion: "", pass: "" })
                      }
                    >
                      {candidateId &&
                        !rows?.items.some((row) => row.candidateId === candidateId) && (
                          <option value={candidateId}>{candidate.title}</option>
                        )}
                      {builds.map((item) => (
                        <option key={item.candidateId} value={item.candidateId}>
                          {item.model} · {item.candidateTitle}
                        </option>
                      ))}
                    </select>
                  </div>
                  {candidate.cells.length > 0 && (
                    <div className={s.field}>
                      <label htmlFor="criterion">Success criterion</label>
                      <select
                        id="criterion"
                        value={criterion?.criterionId ?? ""}
                        onChange={(e) =>
                          navigate({ criterion: cellFor(e.target.value).id, pass: "" })
                        }
                      >
                        {!criterion && <option value="">Choose a criterion</option>}
                        {criterionIds.map((id) => (
                          <option key={id} value={id}>
                            {statementText(cellFor(id).statement)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {criterion && rivals.length > 0 && (
                    <div className={s.field}>
                      <label htmlFor="compare-build">Compare with build</label>
                      <select
                        id="compare-build"
                        value=""
                        onChange={(e) =>
                          e.target.value &&
                          navigate({
                            tab: "compare",
                            other: e.target.value,
                            criterion: criterion.criterionId,
                            pass: String(criterion.pass),
                          })
                        }
                      >
                        <option value="">Choose a build</option>
                        {rivals.map((item) => (
                          <option key={item.candidateId} value={item.candidateId}>
                            {item.model} · {item.candidateTitle}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className={r.evidenceLayout}>
                  <section className={`${s.questionContext} ${r.evidenceHeading}`}>
                    {criterion && !notReached && (
                      <span
                        className={`${s.mark} ${markClass(criterion.outcome, !execution?.finished && !stopped)}`}
                        aria-hidden
                      >
                        {criterion.pass}
                      </span>
                    )}
                    <h2 ref={contextHeading} tabIndex={-1}>
                      {criterion ? statementText(criterion.statement) : "Collected evidence"}
                    </h2>
                    <p role="status" aria-live="polite" className={s.small}>
                      {candidate.title} ·{" "}
                      {notReached
                        ? "Not reached"
                        : criterion
                          ? `Observation ${criterion.pass} · ${cellAnswer(criterion)}`
                          : checksNotRequested
                            ? "These observations weren’t checked against the success criteria."
                            : "No result for this criterion"}
                    </p>
                    {criterion && (
                      <p className={s.small} data-check-kind>
                        {checkKind([criterion])}.
                        {criterion.method === "visual" &&
                          criterion.evidenceClass &&
                          ` ${judgeReads[criterion.evidenceClass]}`}
                      </p>
                    )}
                    {criterion && addressedToJudge(criterion.addressedToEvaluator) && (
                      <p>
                        <Status tone="warning">{ADDRESSED_TO_JUDGE}</Status>
                      </p>
                    )}
                    {/* A code check shows the values that it read beside its answer. */}
                    {criterion && !notReached && observedValue && (
                      <p className={s.small} data-observed>
                        {observedValue}
                      </p>
                    )}
                    {/* An answer that never arrived says why up front, not below the evidence. */}
                    {criterion &&
                      !notReached &&
                      (criterion.outcome === "missing" || criterion.outcome === "incomplete") &&
                      criterion.explanation && (
                        <p className={r.evidenceReason}>{problemSummary(criterion.explanation)}</p>
                      )}
                  </section>
                  <div>
                    {notReached ? (
                      <EmptyState title="This build never started">
                        <NotReachedReason cause={notReached} operationId={operationId} />
                      </EmptyState>
                    ) : item && (selectedPass || (item.sources.length && !criterion)) ? (
                      <EvidenceViewer
                        assetBase={`${base}/asset?candidate=${candidate.id}`}
                        preferred={
                          !selectedPass
                            ? "source"
                            : criterion?.method === "deterministic" ||
                                (criterion?.evidenceClass &&
                                  criterion.evidenceClass !== "appearance")
                              ? "observations"
                              : "images"
                        }
                        item={item}
                        passId={selectedPass?.id ?? ""}
                        onPass={(id) => {
                          const pass = item.passes.find((pass) => pass.id === id);
                          const next = candidate.cells.find(
                            (cell) =>
                              cell.criterionId === criterion?.criterionId &&
                              cell.pass === pass?.number &&
                              cell.itemId === item.id,
                          );
                          navigate({ pass: id, criterion: next?.id ?? criterionId });
                        }}
                      />
                    ) : (
                      <EmptyState title="No evidence for this observation">
                        This observation wasn’t recorded. Details shows why.
                      </EmptyState>
                    )}
                  </div>
                </div>
                {!notReached && (
                  <div className={r.evidenceFooter}>
                    <details className={r.evidenceResult}>
                      <summary>Why this result</summary>
                      <div className={s.section}>
                        <Status
                          tone={
                            !criterion && checksNotRequested
                              ? "neutral"
                              : criterion?.outcome === "verified"
                                ? "good"
                                : criterion?.outcome === "rejected"
                                  ? "bad"
                                  : "warning"
                          }
                        >
                          {criterion
                            ? cellAnswer(criterion)
                            : checksNotRequested
                              ? "Not checked"
                              : "No result"}
                        </Status>
                        <p className={s.lede}>
                          {!criterion && checksNotRequested
                            ? "These observations weren’t checked against the success criteria."
                            : criterion?.decisionAuthority
                              ? criterion.decisionAuthority === "model"
                                ? "Judged by a model"
                                : "Checked by code"
                              : "Not judged"}
                        </p>
                        {!criterion && (
                          <p>
                            {candidate.captured} of{" "}
                            {counted(candidate.plannedCaptures, "observation")} collected.
                          </p>
                        )}
                      </div>
                      {criterion?.explanation && (
                        <p className={s.section}>{checkExplanation(criterion.explanation)}</p>
                      )}
                      {criterion?.addressedToEvaluator?.found && (
                        <div className={s.section}>
                          <p>
                            The build’s output has text aimed at the judge. It didn’t change the
                            answer, but a person should check this result.
                          </p>
                          <blockquote className={s.quote}>
                            {criterion.addressedToEvaluator.quote}
                          </blockquote>
                        </div>
                      )}
                      {criterion?.samples && criterion.samples.of > 1 && (
                        <div className={s.section}>
                          <p className={s.small}>
                            The judge answered this check {criterion.samples.of} times from the same
                            evidence.
                            {criterion.samples.answer === "split" &&
                              " The answers disagree, so the check is neither met nor not met."}
                          </p>
                          <ol className={s.smallStack}>
                            {criterion.samples.decisions.map((decision, index) => (
                              <li key={index}>
                                <strong>
                                  Judge sample {index + 1}:{" "}
                                  {decisionAnswer(decision ?? undefined, true).text}
                                </strong>
                                {decision && <p className={s.small}>{decision.rationale}</p>}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                      {criterion?.score !== null && criterion?.score !== undefined && (
                        <p className={s.section}>
                          <strong>Score:</strong> {criterion.score}
                        </p>
                      )}
                      {criterion?.verdict && (
                        <p className={s.small}>
                          Judge’s answer:{" "}
                          {criterion.verdict === "satisfied"
                            ? "met"
                            : criterion.verdict === "violated"
                              ? "not met"
                              : "not enough evidence"}
                        </p>
                      )}
                      <details className={s.section}>
                        <summary>Limits and technical details</summary>
                        <p className={s.small}>{evidence.claims.join(" ")}</p>
                        <pre className={s.code}>
                          {JSON.stringify(
                            {
                              manifest: evidence.manifestHash,
                              criterion: criterion?.criterion,
                              judgment: criterion?.judgment,
                              evidence: criterion?.evidenceHashes,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      {!selectedPass && candidate.items.find((item) => item.sources.length) && (
                        <details className={s.section}>
                          <summary>View the build&apos;s code</summary>
                          <p className={s.small}>
                            Code alone doesn’t show how the game behaves in Studio, so it can’t
                            replace the missing observation.
                          </p>
                          <EvidenceViewer
                            assetBase={`${base}/asset?candidate=${candidate.id}`}
                            item={candidate.items.find((item) => item.sources.length)!}
                            passId=""
                            onPass={() => {}}
                            preferred="source"
                            showObservationNavigation={false}
                          />
                        </details>
                      )}
                    </details>
                    <details className={r.evidenceResult}>
                      <summary>More actions</summary>
                      {criterion && item && selectedPass && (
                        <div className={s.actionList}>
                          <SaveRegression
                            operationId={operationId}
                            subjectId={candidate.id}
                            criterionId={criterion.criterionId}
                            statement={criterion.statement}
                            deterministic={criterion.method === "deterministic"}
                          />
                        </div>
                      )}
                      {candidate.sealed ? (
                        <SavedSourceActions
                          operationId={operationId}
                          subjectId={candidate.id}
                          revisionId={candidate.evaluationId}
                          title={candidate.title}
                          peers={(evidence?.candidates ?? []).filter(
                            (peer) =>
                              peer.sealed &&
                              peer.id !== candidate.id &&
                              peer.evaluationId === candidate.evaluationId,
                          )}
                        />
                      ) : (
                        <p className={s.small}>More actions appear once the build is saved.</p>
                      )}
                    </details>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="No builds yet">Progress shows the plan.</EmptyState>
            )
          ) : (
            <>
              <section>
                <div className={s.sectionHeading}>
                  <div>
                    <h2>Spending by work</h2>
                    <p>
                      Pending charges hold the maximum cost of requests already sent until the
                      provider confirms the actual cost.
                    </p>
                  </div>
                </div>
                {detailsError && (
                  <Notice>
                    {detailsError}
                    <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
                      Reload details
                    </button>
                  </Notice>
                )}
                {detailsLoading && !spendingDetails.length && <Loading label="Loading spending" />}
                <ScrollRegion className={s.tableWrap} label="Spending details">
                  <table className={s.stackTable}>
                    <thead>
                      <tr>
                        <th scope="col">Work</th>
                        <th scope="col">Charged</th>
                        <th scope="col">Pending charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!detailsLoading && !spendingDetails.length && !detailsError && (
                        <tr>
                          <td colSpan={3}>
                            {modelFree
                              ? "This run sends no model requests, so it has no charges."
                              : "There are no charges yet."}
                          </td>
                        </tr>
                      )}
                      {spendingRows.map((row) => (
                        <tr key={row.id}>
                          <th scope="row">
                            {row.title}
                            {row.meta && <span className={s.tableMeta}>{row.meta}</span>}
                          </th>
                          <td data-label="Charged">{formatMoney(row.chargedUsd)}</td>
                          <td data-label="Pending">{formatMoney(row.pendingUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
                <details className={s.tableNote}>
                  <summary>
                    {view.lineage.operations.length > 1
                      ? "Spending limit and source runs"
                      : "Spending limit"}
                  </summary>{" "}
                  <section className={`${s.panel} ${s.panelBody}`}>
                    <h2>Spending</h2>
                    <p className={s.small}>
                      {modelFree
                        ? "This run sends no model requests, so its spending limit doesn’t apply."
                        : "Everything in this run shares one spending limit. If the next step could cost more than what’s left, work pauses until you increase the limit."}
                    </p>
                    <div className={`${s.budget} ${s.section}`}>
                      {!modelFree && (
                        <div className={s.budgetBar} aria-hidden>
                          <span
                            style={{
                              width: `${ceiling ? (100 * view.spending.billedUsd) / ceiling : 0}%`,
                            }}
                          />
                          <i
                            style={{
                              width: `${ceiling ? (100 * view.spending.reservedUsd) / ceiling : 0}%`,
                            }}
                          />
                        </div>
                      )}
                      {view.lineage.operations.length > 1 && (
                        <details>
                          <summary>Spending of this run and its source runs</summary>
                          <p>
                            A source run made the saved builds or the evidence that this run uses.
                            Each run keeps its own charges.
                          </p>
                          <p>
                            {formatMoney(view.lineage.billedUsd)} charged ·{" "}
                            {formatMoney(view.lineage.reservedUsd)} pending across{" "}
                            {view.lineage.operations.length} runs.
                          </p>
                          {view.lineage.unavailable > 0 && (
                            <p>
                              Spending isn’t available for {view.lineage.unavailable} of them, so
                              the real totals may be higher.
                            </p>
                          )}
                          {view.lineage.operations
                            .filter((item) => item.operationId !== operationId)
                            .map((item) => (
                              <p key={item.operationId}>
                                {item.deleted ? (
                                  "Deleted run"
                                ) : (
                                  <Link className={s.action} href={`/runs/${item.operationId}`}>
                                    Source run
                                  </Link>
                                )}{" "}
                                ·{" "}
                                {item.billedUsd === null
                                  ? "Spending unavailable"
                                  : formatMoney(item.billedUsd)}
                              </p>
                            ))}
                        </details>
                      )}
                      {caps?.budget.allowed && (
                        <button className={s.secondary} disabled={busy} onClick={openBudget}>
                          Increase spending limit
                        </button>
                      )}
                    </div>
                  </section>
                </details>
              </section>
              <ScreenRecordings
                operationId={operationId}
                refresh={execution?.completedStageCount}
              />
              <section className={s.section}>
                <div className={s.sectionHeading}>
                  <h2>Activity</h2>
                  <span className={s.small}>{activity?.total ?? 0} events</span>
                </div>
                {!!activity?.items.length && (
                  <ol className={s.activityLog}>
                    {activity.items.map((event, index) => (
                      <li key={event.id} data-kind={event.kind}>
                        <LogTime value={event.at} previous={activity.items[index - 1]?.at} />
                        <span className={s.logMark} aria-hidden />
                        <p>
                          <strong>{transitionLabel(event.stage, event.kind, event.reason)}</strong>
                          {/* Many units of one stage start together; each row names its own. */}
                          {event.unit && <span data-unit>{event.unit}</span>}
                          {event.reason && (
                            <span>
                              <ProblemText
                                text={event.reason}
                                summary={event.buildStop ?? undefined}
                              />
                            </span>
                          )}
                          {event.kind === "started" && (
                            <UnitLogLink
                              operationId={operationId}
                              stage={event.stage}
                              unitId={event.unitId}
                            />
                          )}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {activity && activity.pages > 1 && (
                  <nav className={`${s.actions} ${s.pager}`} aria-label="Activity pages">
                    <button
                      className={s.secondary}
                      disabled={activity.page <= 1}
                      onClick={() => navigate({ activityPage: String(activity.page - 1) })}
                    >
                      Previous events
                    </button>
                    <span>
                      Page {activity.page} of {activity.pages}
                    </span>
                    <button
                      className={s.secondary}
                      disabled={activity.page >= activity.pages}
                      onClick={() => navigate({ activityPage: String(activity.page + 1) })}
                    >
                      Next events
                    </button>
                  </nav>
                )}
              </section>
            </>
          )}
        </>
      )}
      <Dialog
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        title="Increase the spending limit"
      >
        {error && <Notice>{error}</Notice>}
        <div className={s.form}>
          <p className={s.small}>
            Enter a new total limit for this run. Charges so far count toward it, and paused work
            resumes once it fits.
          </p>
          <div className={s.field}>
            <label htmlFor="increase-budget">New spending limit (USD)</label>
            <input
              id="increase-budget"
              type="number"
              min={ceiling}
              step="any"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <button
            className={s.primary}
            disabled={busy || Number(budget) <= ceiling}
            onClick={() =>
              void perform(async () => {
                await action(`/api/operations/${operationId}/commands`, "command_operation", {
                  kind: "budget",
                  ceilingUsd: Number(budget),
                });
              })
            }
          >
            Set new limit
          </button>
        </div>
      </Dialog>
    </main>
  );
}
