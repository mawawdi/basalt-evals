"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LaunchIntent } from "../../../../../dist/packages/contracts/src/launch.js";
import type {
  RecheckPart,
  RecheckSelection,
} from "../../../../../dist/packages/contracts/src/recheck.js";
import { formatMoney, message } from "../../components/api";
import { useLaunchPreview } from "../../components/launch-preview";
import { startLaunchAttempt, type LaunchAttempt } from "../../components/launch-attempt";
import { LaunchBudget, LaunchSummary } from "../../components/run-configuration";
import { Dialog, Notice, ProblemText } from "../../components/ui";
import s from "../../components/workbench.module.css";

type Presentation = "still" | "sequence" | "grounded-sequence";

/**
 * The launch of one paid part of a recheck: the judge part or the new observations. It uses the
 * normal free preview and an explicit spending limit. When `chooseJudge` is set, the person
 * chooses the judge here.
 */
export function RecheckLaunch({
  selection,
  part,
  label,
  models,
  chooseJudge = false,
}: {
  selection: RecheckSelection;
  part: RecheckPart;
  label: string;
  models: Array<{ id: string; name: string }>;
  chooseJudge?: boolean;
}) {
  const router = useRouter();
  const fieldId = useId();
  const mounted = useRef(true);
  const starting = useRef(false);
  const [open, setOpen] = useState(false),
    [judgeModel, setJudgeModel] = useState(selection.judge?.modelId ?? ""),
    [presentation, setPresentation] = useState<Presentation>(
      selection.judge?.presentation ?? "still",
    ),
    [budget, setBudget] = useState(""),
    [intent] = useState(() => crypto.randomUUID()),
    [attempt, setAttempt] = useState<LaunchAttempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const judge = chooseJudge
    ? judgeModel
      ? { modelId: judgeModel, presentation }
      : null
    : selection.judge;
  const launch: LaunchIntent | null =
    !open || attempt || (chooseJudge && !judge)
      ? null
      : { kind: "recheck", selection: { ...selection, judge, part } };
  const { preview, loading, error: previewError, retry } = useLaunchPreview(launch);
  const limit = Number(budget);
  const validBudget = budget.trim() !== "" && Number.isFinite(limit) && limit >= 0;
  async function start() {
    if ((!preview && !attempt) || !validBudget || starting.current) return;
    starting.current = true;
    const request = attempt ?? { previewId: preview!.id, ceilingUsd: limit };
    setAttempt(request);
    setBusy(true);
    setError("");
    try {
      const result = await startLaunchAttempt(intent, request);
      if (result.kind === "rejected") {
        if (mounted.current) {
          setAttempt(null);
          setError(result.error);
        }
        return;
      }
      router.push(`/runs/${result.operationId}`);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <button className={s.secondary} type="button" disabled={busy} onClick={() => setOpen(true)}>
        {busy ? "Starting run…" : label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label}>
        {(error || previewError) && (
          <Notice>
            {error || <ProblemText text={previewError} />}
            {previewError && (
              <button className={s.secondary} type="button" onClick={retry}>
                Check again
              </button>
            )}
          </Notice>
        )}
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <p>
            {part === "judge"
              ? "The judge checks the saved evidence again with the criteria of this version. This run makes no new builds or Studio observations."
              : "Studio plays the saved builds again with the private checks of this version, and Basalt checks the new observations. This run makes no new builds."}
          </p>
          <p className={s.small}>
            The preview is free. Once you start, only this new work can add cost, up to the limit
            you enter.
          </p>
          {chooseJudge && (
            <>
              <div className={s.field}>
                <label htmlFor={fieldId + "-judge"}>Judge model</label>
                <select
                  id={fieldId + "-judge"}
                  disabled={busy || !!attempt}
                  value={judgeModel}
                  onChange={(event) => setJudgeModel(event.target.value)}
                >
                  <option value="" disabled>
                    Select a judge
                  </option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={s.field}>
                <label htmlFor={fieldId + "-presentation"}>Evidence presentation</label>
                <select
                  id={fieldId + "-presentation"}
                  disabled={busy || !!attempt}
                  value={presentation}
                  onChange={(event) => setPresentation(event.target.value as Presentation)}
                >
                  <option value="still">Still images</option>
                  <option value="sequence">Recorded sequence</option>
                  <option value="grounded-sequence">Notes from recorded sequence</option>
                </select>
              </div>
            </>
          )}
          <LaunchBudget
            id={fieldId + "-budget"}
            scope="recheck"
            value={attempt ? String(attempt.ceilingUsd) : budget}
            onChange={setBudget}
            disabled={busy || !!attempt}
          />
          {preview?.quote && (
            <LaunchSummary
              description={`No new builds · ${preview.quote.workload.criterionOutcomes} ${preview.quote.workload.criterionOutcomes === 1 ? "answer" : "answers"} to check`}
              budget={preview.budget}
              timeLimits={preview.timeLimits}
            />
          )}
          <button
            className={s.primary}
            type="submit"
            disabled={busy || (!preview && !attempt) || !validBudget}
          >
            {busy
              ? "Starting…"
              : attempt
                ? "Recover launch request"
                : `Start · limit ${validBudget ? formatMoney(limit) : "—"}`}
          </button>
          {loading && <p role="status">Checking selection…</p>}
          {chooseJudge && !judge && <p role="status">Choose a judge to continue.</p>}
        </form>
      </Dialog>
    </>
  );
}
