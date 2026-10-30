"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OperationLaunchPreview } from "../../../../../dist/packages/contracts/src/launch.js";
import type { LaunchCatalog } from "../../../../../dist/packages/contracts/src/console.js";
import { action, formatMoney, message } from "../../components/api";
import { startLaunchAttempt, type LaunchAttempt } from "../../components/launch-attempt";
import { LaunchBudget, LaunchSummary } from "../../components/run-configuration";
import { Notice } from "../../components/ui";
import s from "../../components/workbench.module.css";

/**
 * Explain failures: one model request about the flagged criteria of an evaluation. The preview
 * is free. The answers are hypotheses for a person and never change an answer.
 */
export function ExplainFailures({
  revisionId,
  criteria,
  models,
  defaultModelId,
}: {
  revisionId: string;
  /** The flagged criteria that the request asks about. */
  criteria: number;
  models: LaunchCatalog["models"];
  defaultModelId: string | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const mounted = useRef(true);
  const [modelId, setModelId] = useState(defaultModelId ?? models[0]?.id ?? "");
  const [preview, setPreview] = useState<OperationLaunchPreview | null>(null);
  const [ceiling, setCeiling] = useState("");
  const [identity, setIdentity] = useState("");
  const [attempt, setAttempt] = useState<LaunchAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    setIdentity(crypto.randomUUID());
    return () => {
      mounted.current = false;
    };
  }, []);
  // The spending limit appears above the button after the free preview, so focus moves to it.
  useEffect(() => {
    if (preview) document.getElementById(fieldId + "-budget")?.focus();
  }, [preview, fieldId]);
  const limit = ceiling.trim() && Number.isFinite(Number(ceiling)) ? Number(ceiling) : null;
  async function submit() {
    if (busy || !identity) return;
    setBusy(true);
    setError("");
    try {
      if (!preview) {
        const value = await action<OperationLaunchPreview>(
          "/api/launch-previews",
          "preview_launch",
          { kind: "explain_failures", selection: { revisionId, modelId } },
        );
        if (mounted.current) setPreview(value);
        return;
      }
      if (limit === null || limit < 0) throw new Error("Enter a spending limit of zero or more.");
      const request = attempt ?? { previewId: preview.id, ceilingUsd: limit };
      setAttempt(request);
      const started = await startLaunchAttempt(identity, request);
      if (started.kind === "rejected") {
        if (mounted.current) {
          setAttempt(null);
          setIdentity(crypto.randomUUID());
          setError(started.error);
        }
        return;
      }
      router.push(`/runs/${started.operationId}`);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <p className={s.small}>
        A model answers four questions about{" "}
        {criteria === 1 ? "the flagged criterion" : `each of the ${criteria} flagged criteria`}: is
        something missing from the prompt, does the plan observe the behavior, can a build pass
        without it, and did Studio cause the result? It reads the plan, the criterion and the
        observations of up to three builds. The answers are hypotheses, and they don’t change any
        answer.
      </p>
      <form
        className={`${s.form} ${s.narrowForm}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className={s.field}>
          Model
          <select
            value={modelId}
            disabled={busy || !!preview}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        {error && <Notice>{error}</Notice>}
        {preview && (
          <>
            <LaunchSummary
              description="One request to the model. The preview is free, and the request can cost up to your limit."
              budget={preview.budget}
            />
            <LaunchBudget
              id={fieldId + "-budget"}
              value={ceiling}
              onChange={setCeiling}
              disabled={busy || !!attempt}
            />
          </>
        )}
        <button
          className={s.secondary}
          type="submit"
          disabled={busy || !modelId || (!!preview && (limit === null || limit < 0))}
        >
          {busy
            ? preview
              ? "Starting…"
              : "Preparing preview…"
            : preview
              ? `Start explanation · limit ${limit === null ? "—" : formatMoney(limit)}`
              : "Explain failures"}
        </button>
        {preview && !attempt && (
          <button
            className={s.textButton}
            type="button"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setIdentity(crypto.randomUUID());
              setError("");
            }}
          >
            Change settings
          </button>
        )}
      </form>
    </>
  );
}
