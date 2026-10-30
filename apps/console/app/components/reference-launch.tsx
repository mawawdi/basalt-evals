"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OperationLaunchPreview } from "../../../../dist/packages/contracts/src/launch.js";
import { action, message, formatMoney } from "./api";
import { isLaunchAttempt, startLaunchAttempt, type LaunchAttempt } from "./launch-attempt";
import {
  LaunchBudget,
  LaunchSummary,
  launchPreferences,
  rememberLaunch,
  type Options,
} from "./run-configuration";
import { Notice } from "./ui";
import s from "./workbench.module.css";

type ReferenceProps = {
  /** The revision of stage 1. */
  revisionId: string;
  /** The number of stages of the evaluation. */
  stages: number;
  defaults: Options;
  models: import("../../../../dist/packages/contracts/src/console.js").LaunchCatalog["models"];
  harnesses: import("../../../../dist/packages/contracts/src/console.js").LaunchCatalog["harnesses"];
};
export function ReferenceLaunch(props: ReferenceProps) {
  return <ReferenceForm key={props.revisionId} {...props} />;
}
function ReferenceForm({ revisionId, stages, defaults, models, harnesses }: ReferenceProps) {
  const router = useRouter();
  const fieldId = useId();
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [preview, setPreview] = useState<OperationLaunchPreview | null>(null);
  const [ceiling, setCeiling] = useState("");
  const [identity, setIdentity] = useState("");
  const [gradingModelId, setGradingModelId] = useState(defaults.gradingModelId);
  const [hydrated, setHydrated] = useState(false);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<LaunchAttempt | null>(null);
  const key = `basalt-reference-launch:${revisionId}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (hydrated) return;
    const preferences = launchPreferences(defaults, models, harnesses);
    setCeiling(preferences.ceiling);
    setGradingModelId(preferences.selection.gradingModelId);
    let id = crypto.randomUUID();
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (
        typeof saved?.identity === "string" &&
        /^[a-f0-9-]{36}$/u.test(saved.identity) &&
        isLaunchAttempt(saved.attempt)
      ) {
        id = saved.identity;
        setAttempt(saved.attempt);
        setCeiling(String(saved.attempt.ceilingUsd));
      }
      if (
        saved &&
        models.some((m) => m.id === saved.gradingModelId) &&
        typeof saved.identity === "string" &&
        /^[a-f0-9-]{36}$/u.test(saved.identity) &&
        typeof saved.ceiling === "string" &&
        (saved.attempt === null || isLaunchAttempt(saved.attempt)) &&
        (saved.startedId === null ||
          (typeof saved.startedId === "string" &&
            /^[a-z0-9][a-z0-9-]{0,80}$/u.test(saved.startedId))) &&
        (saved.preview === null ||
          (saved.preview?.kind === "reference" &&
            saved.preview.reference?.revisionId === revisionId &&
            typeof saved.preview.id === "string" &&
            /^[a-f0-9]{64}$/u.test(saved.preview.id) &&
            saved.preview.budget &&
            saved.preview.timeLimits))
      ) {
        id = saved.identity;
        setCeiling(saved.attempt ? String(saved.attempt.ceilingUsd) : saved.ceiling);
        setGradingModelId(saved.gradingModelId);
        setPreview(saved.preview);
        setStartedId(saved.startedId);
        setAttempt(saved.attempt);
      }
    } catch {
      /* A new explicit preview remains available. */
    }
    setIdentity(id);
    setHydrated(true);
  }, [key, defaults, models, harnesses, revisionId, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ identity, ceiling, gradingModelId, preview, startedId, attempt }),
      );
    } catch {
      /* The current authorization identity remains in memory. */
    }
  }, [key, hydrated, identity, ceiling, gradingModelId, preview, startedId, attempt]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (submitting.current || !hydrated) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!preview && !attempt) {
        const value = await action<OperationLaunchPreview>(
          "/api/launch-previews",
          "preview_launch",
          {
            kind: "reference",
            selection: { revisionId, gradingModelId },
          },
        );
        if (mounted.current) setPreview(value);
      } else {
        if (!ceiling.trim() || !Number.isFinite(Number(ceiling)) || Number(ceiling) < 0)
          throw new Error("Enter a spending limit of zero or more.");
        const request = attempt ?? { previewId: preview!.id, ceilingUsd: Number(ceiling) };
        setAttempt(request);
        try {
          sessionStorage.setItem(
            key,
            JSON.stringify({
              identity,
              ceiling,
              gradingModelId,
              preview,
              startedId,
              attempt: request,
            }),
          );
        } catch {
          /* Optional recovery. */
        }
        const started = await startLaunchAttempt(identity, request);
        if (started.kind === "rejected") {
          if (mounted.current) {
            setAttempt(null);
            setIdentity(crypto.randomUUID());
            setError(started.error);
          }
          return;
        }
        rememberLaunch(
          { ...launchPreferences(defaults, models, harnesses).selection, gradingModelId },
          ceiling,
        );
        if (!mounted.current) return;
        setStartedId(started.operationId);
        setAttempt(null);
        router.push(`/runs/${started.operationId}`);
      }
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <details className={s.section}>
      <summary>Test this evaluation with references</summary>
      <p>
        The reference test makes a working example, an alternative and a deliberately broken
        example, records them in Studio and runs your checks on them. The expected score of each
        example is only a guess, so these results don’t prove that the checks agree with people.
      </p>
      {stages > 1 && (
        <p>
          This evaluation has {stages} stages. Each later stage starts from the working example of
          the stage before, and only if that example passes the stage’s gate.
        </p>
      )}
      <p className={s.small}>
        The preview is free. When you start a reference test, it can cost up to your limit.
      </p>
      <form
        className={`${s.form} ${s.narrowForm}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (startedId) router.push(`/runs/${startedId}`);
          else void submit();
        }}
      >
        {!attempt && (
          <label className={s.field}>
            Judge model
            <select
              value={gradingModelId ?? ""}
              disabled={busy || !!preview || !!attempt}
              onChange={(event) =>
                setGradingModelId(event.target.value as Options["gradingModelId"])
              }
            >
              {models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <Notice>{error}</Notice>}
        {attempt && (
          <p className={s.small}>
            A launch request with a {formatMoney(attempt.ceilingUsd)} limit was already sent.
            Recover it before you start different work.
          </p>
        )}
        {preview && (
          <>
            <LaunchSummary
              description="With this judge, reference tests check builds the same way as benchmark runs."
              budget={preview.budget}
              timeLimits={preview.timeLimits}
            />
            <LaunchBudget
              id={fieldId + "-budget"}
              value={attempt ? String(attempt.ceilingUsd) : ceiling}
              onChange={setCeiling}
              disabled={busy || !!attempt}
            />
          </>
        )}
        <button
          className={s.secondary}
          disabled={
            busy ||
            !hydrated ||
            (!!preview &&
              !startedId &&
              (!ceiling.trim() || !Number.isFinite(Number(ceiling)) || Number(ceiling) < 0))
          }
          type="submit"
        >
          {busy
            ? attempt
              ? "Recovering launch…"
              : preview
                ? "Starting reference test…"
                : "Preparing preview…"
            : startedId
              ? "Open reference test"
              : attempt
                ? "Check whether it started"
                : preview
                  ? `Start reference test · limit ${ceiling.trim() && Number.isFinite(Number(ceiling)) ? formatMoney(Number(ceiling)) : "—"}`
                  : "Preview reference test"}
        </button>
        {preview && !startedId && (
          <button
            className={s.textButton}
            type="button"
            disabled={busy || !!attempt}
            onClick={() => {
              setPreview(null);
              setIdentity(crypto.randomUUID());
              setError("");
            }}
          >
            Change settings
          </button>
        )}
        {startedId && (
          <button
            className={s.textButton}
            type="button"
            onClick={() => {
              setStartedId(null);
              setPreview(null);
              setIdentity(crypto.randomUUID());
              setError("");
            }}
          >
            Start another reference test
          </button>
        )}
      </form>
    </details>
  );
}
