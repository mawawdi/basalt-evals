"use client";

import type {
  LaunchIntent,
  OperationLaunchPreview,
} from "../../../../../dist/packages/contracts/src/launch.js";
import { useLaunchPreview } from "../../components/launch-preview";
import { startLaunchAttempt } from "../../components/launch-attempt";
import { WorkloadLaunch } from "../../components/workload-launch";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { LaunchCatalog } from "../../../../../dist/packages/contracts/src/console.js";
import { action, read, message, formatMoney } from "../../components/api";
import {
  RunOptions,
  LaunchBudget,
  LaunchSummary,
  launchPreferences,
  type Options,
} from "../../components/run-configuration";
import { Dialog, Notice, ProblemText } from "../../components/ui";
import { counted, problemSummary } from "../../components/result-display";
import s from "../../components/workbench.module.css";
type Kind = "replay" | "repair" | "public-development";
type Configuration = {
  models: LaunchCatalog["models"];
  harnesses: LaunchCatalog["harnesses"];
  defaults: Options;
};
type Props = {
  operationId: string;
  subjectId: string;
  /** The evaluation of the build in this run. */
  revisionId: string;
  title: string;
  /** The other saved builds of the same evaluation. A sensitivity test can pool them. */
  peers: Array<{ id: string; title: string }>;
};
type PendingAuthorization = { preview: OperationLaunchPreview; ceilingUsd: number; kind: Kind };
export function SavedSourceActions(props: Props) {
  return <SavedSourceForm key={`${props.operationId}:${props.subjectId}`} {...props} />;
}
function SavedSourceForm({ operationId, subjectId, revisionId, title, peers }: Props) {
  const router = useRouter(),
    recoveryKey = `basalt-retained-launch:${operationId}:${subjectId}`;
  const [kind, setKind] = useState<Kind | null>(null),
    [feedbackId, setFeedbackId] = useState<string | null>(null),
    [budget, setBudget] = useState(""),
    [feedback, setFeedback] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [intent, setIntent] = useState(""),
    [pendingAuthorization, setPendingAuthorization] = useState<PendingAuthorization | null>(null),
    [config, setConfig] = useState<Configuration | null>(null),
    [selection, setSelection] = useState<Options | null>(null);
  const launching = useRef(false);
  const [optionsError, setOptionsError] = useState(""),
    [optionsAttempt, setOptionsAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    // An already-sent authorization belongs to its frozen preview, even when a
    // model is no longer selectable in the current catalog.
    let retainedPending = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
      if (
        saved?.pendingAuthorization &&
        /^[a-f0-9-]{36}$/u.test(saved.intent) &&
        /^[a-f0-9]{64}$/u.test(saved.pendingAuthorization.preview?.id) &&
        saved.pendingAuthorization.preview?.parentOperationIds?.includes(operationId) &&
        ["replay", "repair", "public-development"].includes(saved.kind) &&
        saved.pendingAuthorization.kind === saved.kind &&
        Number.isFinite(saved.pendingAuthorization.ceilingUsd)
      ) {
        retainedPending = true;
        setPendingAuthorization(saved.pendingAuthorization);
        setKind(saved.kind);
        setIntent(saved.intent);
        setSelection(saved.selection);
        setBudget(saved.budget);
        setFeedback(saved.feedback);
      }
    } catch {}
    void read<Configuration>("/api/launch-options")
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setOptionsError("");
        if (retainedPending) return;
        const prefs = launchPreferences(value.defaults, value.models, value.harnesses);
        setSelection({
          ...prefs.selection,
          builderModelIds: prefs.selection.builderModelIds.slice(0, 1),
        });
        setBudget(prefs.ceiling);
        try {
          const saved = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
          if (
            saved &&
            ["replay", "repair", "public-development"].includes(saved.kind) &&
            typeof saved.intent === "string" &&
            /^[a-f0-9-]{36}$/u.test(saved.intent) &&
            typeof saved.budget === "string" &&
            typeof saved.feedback === "boolean" &&
            saved.selection &&
            Array.isArray(saved.selection.builderModelIds) &&
            saved.selection.builderModelIds.every((id: string) =>
              value.models.some((model) => model.id === id),
            ) &&
            value.models.some((model) => model.id === saved.selection.gradingModelId) &&
            (saved.selection.preparationModelId === null ||
              value.models.some((model) => model.id === saved.selection.preparationModelId)) &&
            (saved.selection.coverageModelId === null ||
              value.models.some((model) => model.id === saved.selection.coverageModelId)) &&
            [1, 2, 3].includes(saved.selection.repetitions) &&
            [1, 2, 3].includes(saved.selection.capturePasses) &&
            (saved.pendingAuthorization === null ||
              (saved.pendingAuthorization?.kind === saved.kind &&
                /^[a-f0-9]{64}$/u.test(saved.pendingAuthorization.preview?.id) &&
                saved.pendingAuthorization.preview?.parentOperationIds?.includes(operationId) &&
                Number.isFinite(saved.pendingAuthorization.ceilingUsd) &&
                saved.pendingAuthorization.ceilingUsd >= 0))
          ) {
            setKind(saved.kind);
            setIntent(saved.intent);
            setSelection(saved.selection);
            setBudget(saved.budget);
            setFeedback(saved.feedback);
            setPendingAuthorization(saved.pendingAuthorization);
          }
        } catch {
          /* The server retains every authorized execution. */
        }
      })
      .catch((cause) => {
        if (!cancelled) setOptionsError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [recoveryKey, operationId, optionsAttempt]);
  useEffect(() => {
    if (!kind || !selection || !intent) return;
    try {
      sessionStorage.setItem(
        recoveryKey,
        JSON.stringify({ kind, intent, selection, budget, feedback, pendingAuthorization }),
      );
    } catch {
      /* Optional recovery. */
    }
  }, [kind, intent, selection, budget, feedback, recoveryKey, pendingAuthorization]);
  function close(completed = false) {
    setKind(null);
    if (pendingAuthorization && !completed) return;
    setPendingAuthorization(null);
    try {
      sessionStorage.removeItem(recoveryKey);
    } catch {
      /* Optional recovery. */
    }
  }
  async function perform(work: () => Promise<void>) {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setBusy(false);
      launching.current = false;
    }
  }
  useEffect(() => {
    let active = true;
    setFeedbackId(null);
    if (kind === "repair" && feedback && !pendingAuthorization) {
      void action<{ id: string }>(
        `/api/operations/${operationId}/public-feedback`,
        "register_public_feedback",
        { subjectId },
      )
        .then((value) => {
          if (active) setFeedbackId(value.id);
        })
        .catch((cause) => {
          if (active) setError(message(cause));
        });
    }
    return () => {
      active = false;
    };
  }, [kind, feedback, operationId, subjectId, pendingAuthorization]);
  const launch: LaunchIntent | null =
    !kind ||
    !selection ||
    (kind === "repair" && (!selection.builderModelIds.length || (feedback && !feedbackId)))
      ? null
      : kind === "repair"
        ? {
            kind,
            selection: {
              operationId,
              subjectId,
              modelId: selection.builderModelIds[0]!,
              gradingModelId: selection.gradingModelId,
              attempts: selection.repetitions,
              passes: selection.capturePasses,
              publicFeedbackId: feedback ? feedbackId : null,
            },
          }
        : {
            kind: kind === "public-development" ? "public_development" : kind,
            selection: { operationId, subjectId, passes: selection.capturePasses },
          };
  const {
    preview: quote,
    loading,
    error: previewError,
    retry,
  } = useLaunchPreview(pendingAuthorization ? null : launch);
  const shownQuote = pendingAuthorization?.preview ?? quote;
  const frozen = busy || !!pendingAuthorization;
  const reason = pendingAuthorization
    ? ""
    : !config || !selection
      ? optionsError
        ? "The run options didn’t load. Try again."
        : "Loading run options…"
      : kind === "repair" && !selection.builderModelIds.length
        ? "Choose a model for the repair."
        : !budget.trim() || !Number.isFinite(Number(budget)) || Number(budget) < 0
          ? "Enter a spending limit."
          : loading
            ? "Checking selection…"
            : !quote
              ? previewError
                ? problemSummary(previewError)
                : "Basalt must check the selection before the run can start."
              : "";
  return (
    <>
      {optionsError && (
        <Notice>
          {optionsError}
          <button className={s.secondary} onClick={() => setOptionsAttempt((value) => value + 1)}>
            Retry run options
          </button>
        </Notice>
      )}
      <div className={s.actionList}>
        <WorkloadLaunch
          kind="recheck"
          operationId={operationId}
          subjectId={subjectId}
          revisionId={revisionId}
        />
        <WorkloadLaunch
          kind="sensitivity"
          operationId={operationId}
          subjectId={subjectId}
          peers={peers}
        />
        {(["replay", "public-development", "repair"] as const).map((value) => (
          <button
            className={s.secondary}
            key={value}
            disabled={frozen}
            onClick={() => {
              setKind(value);
              if (!optionsError) setError("");
              setFeedback(false);
              setIntent(crypto.randomUUID());
            }}
          >
            {value === "replay"
              ? "Check the same build again"
              : value === "repair"
                ? "Try a repair"
                : "Record extra observation"}
          </button>
        ))}
      </div>
      {pendingAuthorization && !kind && (
        <Notice kind="info">
          Basalt saved a start request with a {formatMoney(pendingAuthorization.ceilingUsd)} limit.
          <button className={s.secondary} onClick={() => setKind(pendingAuthorization.kind)}>
            Recover run
          </button>
        </Notice>
      )}
      {error && !kind && <Notice>{error}</Notice>}
      <Dialog
        open={!!kind}
        onClose={() => {
          if (!busy) close();
        }}
        title={
          kind === "repair"
            ? "Try a repair"
            : kind === "replay"
              ? "Check the same build again"
              : "Record extra observation"
        }
      >
        {(error || previewError) && (
          <Notice>
            {error || <ProblemText text={previewError} />}
            {previewError && (
              <button className={s.secondary} onClick={retry}>
                Check again
              </button>
            )}
          </Notice>
        )}
        {optionsError && (
          <Notice>
            {optionsError}
            <button className={s.secondary} onClick={() => setOptionsAttempt((value) => value + 1)}>
              Retry run options
            </button>
          </Notice>
        )}
        {pendingAuthorization && (
          <Notice kind="info">
            Your original start request with a {formatMoney(pendingAuthorization.ceilingUsd)}{" "}
            spending limit is saved. Recover it before you start another run. Recovery reuses the
            same request, so it can’t create a duplicate.
          </Notice>
        )}
        <div className={s.form}>
          <h3>{title}</h3>
          <p className={s.small}>
            {kind === "repair"
              ? "Create a new build from this saved code. The model sees only permitted public feedback."
              : kind === "replay"
                ? "Collect new observations of this exact build without making a new build."
                : "Collect development observations of this build without making a new build."}
          </p>
          {selection && config && kind && (
            <RunOptions
              mode={kind}
              value={selection}
              models={config.models}
              disabled={frozen}
              onChange={setSelection}
            />
          )}
          {kind === "repair" && (
            <label className={s.acknowledge}>
              <input
                type="checkbox"
                disabled={frozen}
                checked={feedback}
                onChange={(event) => {
                  setFeedback(event.target.checked);
                }}
              />
              Include saved public development observations
            </label>
          )}
          <LaunchBudget id="source-budget" value={budget} onChange={setBudget} disabled={frozen} />
          {shownQuote && (
            <LaunchSummary
              description={`${counted(shownQuote.quote!.workload.independentBuilderTrials, "new build")} · ${counted(shownQuote.quote!.workload.capturePasses, "observation")}`}
              timeLimits={shownQuote.timeLimits}
              budget={shownQuote.budget}
            />
          )}
          <button
            className={s.primary}
            disabled={busy || !!reason}
            aria-describedby="source-launch-readiness"
            onClick={() =>
              void perform(async () => {
                if (!shownQuote || !kind) return;
                const attempted = pendingAuthorization ?? {
                  preview: shownQuote,
                  ceilingUsd: Number(budget),
                  kind,
                };
                setPendingAuthorization(attempted);
                try {
                  sessionStorage.setItem(
                    recoveryKey,
                    JSON.stringify({
                      kind,
                      intent,
                      selection,
                      budget,
                      feedback,
                      pendingAuthorization: attempted,
                    }),
                  );
                } catch {
                  /* The exact request remains in memory and on the server. */
                }
                const result = await startLaunchAttempt(intent, {
                  previewId: attempted.preview.id,
                  ceilingUsd: attempted.ceilingUsd,
                });
                if (!mounted.current) return;
                if (result.kind === "rejected") {
                  setPendingAuthorization(null);
                  setIntent(crypto.randomUUID());
                  try {
                    sessionStorage.removeItem(recoveryKey);
                  } catch {
                    /* Optional recovery. */
                  }
                  throw new Error(result.error);
                }
                close(true);
                router.push(`/runs/${result.operationId}`);
              })
            }
          >
            {busy
              ? "Starting…"
              : pendingAuthorization
                ? "Recover run"
                : `Start run · limit ${budget.trim() ? formatMoney(Number(budget)) : "—"}`}
          </button>
          <p id="source-launch-readiness" className={s.small} role="status">
            {busy
              ? "Saving your approval and opening the run…"
              : reason ||
                "This action starts a separate run with its own spending limit. Basalt keeps the original evidence."}
          </p>
        </div>
      </Dialog>
    </>
  );
}
