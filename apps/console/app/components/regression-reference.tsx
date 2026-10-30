"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RegressionReference } from "../../../../dist/packages/contracts/src/comparisons.js";
import { action, message } from "./api";
import { Dialog, Notice } from "./ui";
import s from "./workbench.module.css";
import { statementText } from "./result-display";

type ExampleProps = {
  operationId: string;
  subjectId: string;
  criterionId: string;
  statement: string;
  deterministic: boolean;
};
export function SaveRegression(props: ExampleProps) {
  return (
    <SaveExample key={`${props.operationId}:${props.subjectId}:${props.criterionId}`} {...props} />
  );
}
function SaveExample({
  operationId,
  subjectId,
  criterionId,
  statement,
  deterministic,
}: ExampleProps) {
  const fieldId = useId();
  const mounted = useRef(true);
  const visible = useRef(false);
  const saving = useRef(false);
  const router = useRouter(),
    [open, setOpen] = useState(false),
    [title, setTitle] = useState(statementText(statement).slice(0, 160)),
    [purpose, setPurpose] = useState<"generation" | "grader">("generation"),
    [savedId, setSavedId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <button
        className={s.secondary}
        disabled={busy}
        onClick={() => {
          if (savedId) {
            router.push(`/regressions/${savedId}`);
            return;
          }
          visible.current = true;
          setOpen(true);
        }}
      >
        {busy
          ? "Saving example…"
          : savedId
            ? "Open saved example"
            : "Save an example for future checks"}
      </button>
      {!open && error && <Notice>{error}</Notice>}
      <Dialog
        open={open}
        onClose={() => {
          visible.current = false;
          setOpen(false);
        }}
        title="Save an example"
      >
        {error && <Notice>{error}</Notice>}
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (saving.current || !title.trim()) return;
            saving.current = true;
            setBusy(true);
            setError("");
            void action<RegressionReference>("/api/regressions", "save_regression", {
              title: title.trim(),
              purpose,
              operationId,
              subjectId,
              criterionIds: [criterionId],
            })
              .then((reference) => {
                if (!mounted.current) return;
                setSavedId(reference.id);
                if (visible.current) router.push(`/regressions/${reference.id}`);
              })
              .catch((cause) => {
                if (mounted.current) setError(message(cause));
              })
              .finally(() => {
                saving.current = false;
                if (mounted.current) setBusy(false);
              });
          }}
        >
          <p>
            The example keeps this success criterion and its evidence, without an expected answer.
            Future builders never see it.
          </p>
          <p className={s.small}>
            Saving an example is free. A future check needs its own spending limit.
          </p>
          <p className={s.small}>
            The example keeps every observation of this build, not only the one you see now, so you
            can save it only once Studio has recorded all of them.
          </p>
          <div className={s.field}>
            <label htmlFor={fieldId + "-title"}>Example title</label>
            <input
              id={fieldId + "-title"}
              value={title}
              maxLength={160}
              required
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <fieldset className={s.selectionGrid} disabled={busy}>
            <legend>Use this example to check</legend>
            <label className={s.choice}>
              <input
                type="radio"
                name={fieldId + "-purpose"}
                value="generation"
                checked={purpose === "generation"}
                onChange={() => setPurpose("generation")}
              />
              New builds from this evaluation
            </label>
            {!deterministic && (
              <label className={s.choice}>
                <input
                  type="radio"
                  name={fieldId + "-purpose"}
                  value="grader"
                  checked={purpose === "grader"}
                  onChange={() => setPurpose("grader")}
                />
                A judge that reads this saved evidence
              </label>
            )}
          </fieldset>
          <button className={s.primary} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save example"}
          </button>
        </form>
      </Dialog>
    </>
  );
}
