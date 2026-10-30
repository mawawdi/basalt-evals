"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  MAX_EVAL_STAGES,
  type WorkingCopy,
  type WorkingCopyStage,
} from "../../../../dist/packages/contracts/src/working-copy.js";
import type { EvalDraft } from "../../../../dist/packages/eval-authoring/src/input.js";
import type { EvaluationLibraryEntry } from "../../../../dist/packages/contracts/src/catalog.js";
import { action, read, message, ApiError } from "./api";
import { Notice, PageHeading } from "./ui";
import { MarkdownPreview } from "./markdown-preview";
import { draftMemory, useUnsavedGuard } from "./draft-memory";
import s from "./workbench.module.css";
import { statementText } from "./result-display";

const LIMIT = 32768;
const blankStage = (): WorkingCopyStage => ({ prompt: "", criteria: "", gateCriterionIds: [] });
const unparsed = (): WorkingCopy["parsed"][number] => ({ criteria: [], error: null });
const bytes = (text: string) => new TextEncoder().encode(text).length;
const firstLine = (text: string) =>
  text
    .split("\n")[0]!
    .replace(/^#+\s*/, "")
    .slice(0, 120);
/**
 * Only the saved fields: the title and the stages. Each stage gets one key order, because the
 * editor compares the JSON text and a stage read back from the server has its keys sorted.
 */
const fields = (c: WorkingCopy) => ({
  title: c.title,
  stages: c.stages.map(({ prompt, criteria, gateCriterionIds }) => ({
    prompt,
    criteria,
    gateCriterionIds,
  })),
});
/** A stage keeps its text in a recovered copy only when the copy has the current shape. */
const validStages = (value: unknown): value is WorkingCopyStage[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_EVAL_STAGES &&
  value.every(
    (stage) =>
      typeof stage?.prompt === "string" &&
      typeof stage?.criteria === "string" &&
      Array.isArray(stage?.gateCriterionIds),
  );
/**
 * Remove each gate criterion that the saved parse of its stage no longer lists as required.
 * A stage with other text than the saved text keeps its gate until the next save.
 */
function prunedGates(stages: WorkingCopyStage[], saved: WorkingCopy): WorkingCopyStage[] {
  return stages.map((stage, index) => {
    const parse = saved.parsed[index];
    if (!parse || parse.error || saved.stages[index]?.criteria !== stage.criteria) return stage;
    const required = new Set(parse.criteria.filter((item) => item.required).map((item) => item.id));
    const kept = stage.gateCriterionIds.filter((id) => required.has(id));
    return kept.length === stage.gateCriterionIds.length
      ? stage
      : { ...stage, gateCriterionIds: kept };
  });
}

export function EvaluationEditor({
  initialDraft,
  initialEvaluation,
  duplicating = false,
  questions = [],
}: {
  initialDraft?: EvalDraft;
  initialEvaluation?: EvaluationLibraryEntry;
  duplicating?: boolean;
  questions?: Array<{
    id: string;
    message: string;
    stage: number;
    passage: { text: string } | null;
  }>;
}) {
  const router = useRouter(),
    params = useSearchParams();
  const [copy, setCopy] = useState<WorkingCopy | null>(null);
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const [status, setStatus] = useState("Loading draft…"),
    [error, setError] = useState("");
  const [conflict, setConflict] = useState(false),
    [busy, setBusy] = useState(false);
  const revision = useRef(0),
    session = useRef(""),
    deviceSaved = useRef(false),
    editSequence = useRef(0),
    persisted = useRef(""),
    currentCopyId = useRef(""),
    saving = useRef<{ id: string; request: Promise<WorkingCopy> } | null>(null);
  const returning = params.get("run"),
    amendment = params.get("workflow");
  const returnState = params.get("state");
  const bufferKey =
    "basalt-editor-buffer:" +
    (initialEvaluation?.id ?? (duplicating ? "duplicate-" + initialDraft?.id : "new"));
  const editingId = copy?.evaluationId ?? initialEvaluation?.id;
  const isDuplicating = duplicating && !editingId;
  const returnToRun =
    "/runs/new?" +
    new URLSearchParams({
      ...(returning ? { intent: returning } : {}),
      ...(returnState ? { state: returnState } : {}),
      ...(amendment ? { amend: amendment } : {}),
    });
  const backHref =
    returning || amendment ? returnToRun : editingId ? "/evaluations/" + editingId : "/evaluations";
  const oversized =
    !!copy &&
    copy.stages.some((stage) => bytes(stage.prompt) > LIMIT || bytes(stage.criteria) > LIMIT);
  const recoveryKey = (id: string) => `basalt-editor-recovery:${id}:${session.current}`;
  const [savedCopy, setSavedCopy] = useState<WorkingCopy | null>(null);
  // The stages before the last removal, so that Undo can put the removed stage back.
  const [removed, setRemoved] = useState<{
    number: number;
    stages: WorkingCopy["stages"];
    parsed: WorkingCopy["parsed"];
  } | null>(null);
  // A move or a removal takes away the focused control or moves its stage. Focus then goes to
  // the first enabled control of this list, so it follows the stage.
  const focusNext = useRef<string[]>([]);
  useEffect(() => {
    if (!focusNext.current.length) return;
    const target = focusNext.current
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find((node) => node && !node.matches(":disabled"));
    focusNext.current = [];
    target?.focus();
  });
  const [retainedCopy, setRetainedCopy] = useState<WorkingCopy | null>(null);
  function retain(value: WorkingCopy) {
    draftMemory.set(recoveryKey(value.id), value);
    try {
      localStorage.setItem(
        recoveryKey(value.id),
        JSON.stringify({ ...value, revision: revision.current }),
      );
      deviceSaved.current = true;
    } catch {
      deviceSaved.current = false;
    }
    return deviceSaved.current;
  }
  useEffect(() => {
    let alive = true;
    try {
      session.current = sessionStorage.getItem("basalt-editor-session") ?? crypto.randomUUID();
      sessionStorage.setItem("basalt-editor-session", session.current);
    } catch {
      session.current ||= crypto.randomUUID();
    }
    let retainedId: string | null = null;
    try {
      retainedId = localStorage.getItem(bufferKey);
    } catch {}
    const id =
      params.get("copy") ??
      (initialEvaluation
        ? "edit-" + initialEvaluation.id
        : retainedId && /^[a-zA-Z0-9_-]{16,100}$/u.test(retainedId)
          ? retainedId
          : crypto.randomUUID());
    try {
      localStorage.setItem(bufferKey, id);
    } catch {}
    setConflict(false);
    setError("");
    setCopy(null);
    currentCopyId.current = id;
    try {
      setRetainedCopy(
        (draftMemory.get(recoveryKey(id) + ":retained") as WorkingCopy | undefined) ??
          JSON.parse(localStorage.getItem(recoveryKey(id) + ":retained") ?? "null"),
      );
    } catch {
      setRetainedCopy(null);
    }
    const url = new URL(window.location.href);
    url.searchParams.set("copy", id);
    window.history.replaceState(null, "", url);
    const empty: WorkingCopy = {
      id,
      revision: 0,
      evaluationId: initialEvaluation?.id ?? null,
      baseDraftId: initialEvaluation?.draftId ?? null,
      title: initialDraft
        ? duplicating
          ? (initialDraft.title + " (copy)").slice(0, 120)
          : initialDraft.title
        : "",
      stages: initialDraft
        ? initialDraft.stages.map((stage) => ({
            prompt: stage.prompt,
            criteria: stage.rubric,
            gateCriterionIds: stage.gateCriterionIds,
          }))
        : [blankStage()],
      updatedAt: "",
      parsed: initialDraft
        ? initialDraft.stages.map((stage) => ({
            criteria: stage.criteria.map(({ id, text, start, end, required }) => ({
              id,
              text,
              start,
              end,
              required,
            })),
            error: null,
          }))
        : [unparsed()],
    };
    let recovered: WorkingCopy | null = null;
    try {
      recovered =
        (draftMemory.get(recoveryKey(id)) as WorkingCopy | undefined) ??
        JSON.parse(localStorage.getItem(recoveryKey(id)) ?? "null");
    } catch {}
    void read<WorkingCopy | null>("/api/working-copies/" + id)
      .then((server) => {
        if (!alive) return;
        const current = server ?? empty;
        setSavedCopy(current);
        revision.current = current.revision;
        persisted.current = server ? JSON.stringify(fields(server)) : "";
        const recoveredValid =
          recovered &&
          recovered.id === id &&
          recovered.evaluationId === current.evaluationId &&
          validStages(recovered.stages) &&
          Array.isArray(recovered.parsed) &&
          recovered.parsed.length === recovered.stages.length &&
          typeof recovered.title === "string";
        const changed = recoveredValid && JSON.stringify(fields(recovered!)) !== persisted.current;
        const obsolete = !!initialEvaluation && current.baseDraftId !== initialEvaluation.draftId;
        if (
          obsolete ||
          (changed && server && recovered && recovered.revision !== server.revision)
        ) {
          setConflict(true);
          setError(
            obsolete
              ? "This draft started from an older version of the evaluation. Your text is still here. Open the current version or apply your text to it."
              : "Another tab saved a different version. Compare it with your recovered text below and choose which one to keep.",
          );
        }
        setCopy(changed ? recovered : current);
        setStatus(
          changed
            ? "Recovered local edits"
            : server
              ? "Autosaved"
              : "Your text autosaves as you type",
        );
      })
      .catch((cause) => {
        if (alive) {
          revision.current = recovered?.revision ?? 0;
          persisted.current = "";
          setCopy(recovered ?? empty);
          setStatus(recovered ? "Recovered local edits · server unavailable" : "Working offline");
          setError(message(cause));
        }
      });
    return () => {
      alive = false;
      currentCopyId.current = "";
    };
  }, [params.get("copy")]);
  useEffect(() => {
    const retry = () => setCopy((current) => (current ? { ...current } : null));
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  useEffect(() => {
    if (!copy) return;
    retain(copy);
    if (conflict || busy || oversized) return;
    if (persisted.current === JSON.stringify(fields(copy))) return;
    const timer = setTimeout(async () => {
      if (saving.current?.id === copy.id) return;
      const pending = {
        id: copy.id,
        request: action<WorkingCopy>("/api/working-copies/" + copy.id, "save_working_copy", {
          ...fields(copy),
          revision: revision.current,
          evaluationId: copy.evaluationId,
          baseDraftId: copy.baseDraftId,
        }),
      };
      saving.current = pending;
      setStatus("Autosaving…");
      try {
        const saved = await pending.request;
        if (currentCopyId.current !== copy.id) return;
        revision.current = saved.revision;
        persisted.current = JSON.stringify(fields(saved));
        // The saved parse applies only while the editor has the same stages as the save.
        setCopy(
          (latest) =>
            latest && {
              ...latest,
              revision: saved.revision,
              parsed: saved.parsed.length === latest.stages.length ? saved.parsed : latest.parsed,
              stages: prunedGates(latest.stages, saved),
            },
        );
        setStatus(
          copyRef.current && JSON.stringify(fields(copyRef.current)) === persisted.current
            ? "Autosaved"
            : "Autosaving…",
        );
        setError("");
      } catch (cause) {
        if (currentCopyId.current !== copy.id) return;
        setStatus(
          deviceSaved.current
            ? "Edits kept on this device · not saved to the server yet"
            : "Unsaved · only held in this open editor",
        );
        setError(message(cause));
        if (cause instanceof ApiError && cause.status === 409) setConflict(true);
        if (cause instanceof ApiError && cause.status === 409)
          void read<WorkingCopy>("/api/working-copies/" + copy.id)
            .then((saved) => {
              if (currentCopyId.current === copy.id) setSavedCopy(saved);
            })
            .catch(() => {});
      } finally {
        if (saving.current === pending) saving.current = null;
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [copy, conflict, busy]);
  function change(next: WorkingCopy) {
    // Keep the latest keystroke recoverable even when Back is clicked before autosave fires.
    editSequence.current++;
    // Any other change ends the chance to undo a removal.
    setRemoved(null);
    if (!retain(next)) {
      setError(
        "This browser cannot keep a backup, so keep this editor open until your draft is saved.",
      );
    }
    setStatus(
      conflict
        ? deviceSaved.current
          ? "Kept on this device · choose which version to keep"
          : "Unsaved · choose which version to keep"
        : "Autosaving…",
    );
    setCopy(next);
  }
  function editStage(index: number, patch: Partial<WorkingCopyStage>) {
    if (!copy) return;
    const first = copy.stages[0]!;
    change({
      ...copy,
      stages: copy.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
      // The title follows the first line of the first prompt until the author changes it.
      title:
        index === 0 &&
        patch.prompt !== undefined &&
        (!copy.title || copy.title === firstLine(first.prompt))
          ? firstLine(patch.prompt)
          : copy.title,
    });
  }
  /** Put the stages in a new order. A stage that `order` leaves out is removed. */
  function arrange(order: number[]) {
    if (!copy) return;
    const stages = order.map((index) => copy.stages[index]!);
    // The last stage has no gate, because no stage comes after it.
    stages[stages.length - 1] = { ...stages.at(-1)!, gateCriterionIds: [] };
    change({ ...copy, stages, parsed: order.map((index) => copy.parsed[index] ?? unparsed()) });
  }
  function moveStage(index: number, offset: -1 | 1) {
    if (!copy) return;
    const order = copy.stages.map((_, i) => i);
    [order[index], order[index + offset]] = [order[index + offset]!, order[index]!];
    arrange(order);
    const stage = `[data-stage="${index + offset + 1}"]`;
    const [same, other] = offset < 0 ? ["up", "down"] : ["down", "up"];
    focusNext.current = [`${stage} [data-move="${same}"]`, `${stage} [data-move="${other}"]`];
  }
  function removeStage(index: number) {
    if (!copy) return;
    arrange(copy.stages.map((_, i) => i).filter((i) => i !== index));
    setRemoved({ number: index + 1, stages: copy.stages, parsed: copy.parsed });
    focusNext.current = ["#undo-remove-stage"];
  }
  function undoRemove() {
    if (!copy || !removed) return;
    change({ ...copy, stages: removed.stages, parsed: removed.parsed });
    focusNext.current = [`[aria-label="Remove stage ${removed.number}"]`];
  }
  function addStage() {
    if (!copy || copy.stages.length >= MAX_EVAL_STAGES) return;
    change({
      ...copy,
      stages: [...copy.stages, blankStage()],
      parsed: [...copy.parsed, unparsed()],
    });
  }
  useUnsavedGuard(
    () =>
      !!copyRef.current &&
      !deviceSaved.current &&
      JSON.stringify(fields(copyRef.current)) !== persisted.current,
    () =>
      setError(
        "The server does not have your latest text, and this browser cannot keep a backup. Copy the text or try saving again before you leave.",
      ),
  );
  async function loadSaved() {
    if (!copy) return;
    const intent = editSequence.current,
      id = copy.id;
    try {
      const server = await read<WorkingCopy>("/api/working-copies/" + copy.id);
      if (currentCopyId.current !== id) return;
      if (editSequence.current !== intent)
        throw new Error(
          "You typed while the saved copy loaded. Your newer text is still here, and you can load the saved copy again when you are ready.",
        );
      if (!server) throw new Error("The server has no saved copy yet. Your text is unchanged.");
      revision.current = server.revision;
      persisted.current = JSON.stringify(fields(server));
      setSavedCopy(server);
      // Keep a separate recoverable copy when explicitly choosing another text.
      if (copyRef.current) {
        setRetainedCopy(copyRef.current);
        draftMemory.set(recoveryKey(id) + ":retained", copyRef.current);
        try {
          localStorage.setItem(recoveryKey(id) + ":retained", JSON.stringify(copyRef.current));
        } catch {}
      }
      change(server);
      setConflict(false);
      setError("");
      setStatus("Saved copy loaded");
    } catch (cause) {
      setError(message(cause));
    }
  }
  async function reapply() {
    if (!copy || !initialEvaluation) return;
    const id = copy.id,
      intent = editSequence.current;
    setBusy(true);
    try {
      const [server, library] = await Promise.all([
        read<WorkingCopy>("/api/working-copies/" + id),
        read<
          Record<
            string,
            import("../../../../dist/packages/contracts/src/catalog.js").EvaluationSummary | null
          >
        >("/api/evaluations/current?" + new URLSearchParams({ ids: initialEvaluation.id })),
      ]);
      if (currentCopyId.current !== id || editSequence.current !== intent) return;
      const currentBase = library[initialEvaluation.id]?.draftId;
      if (!currentBase)
        throw new Error("The current evaluation is unavailable. Your text is unchanged.");
      revision.current = server.revision;
      setSavedCopy(server);
      change({ ...copy, revision: server.revision, baseDraftId: currentBase });
      setConflict(false);
      setError("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!copy) return;
    setBusy(true);
    setError("");
    try {
      if (saving.current?.id === copy.id) await saving.current.request;
      if (currentCopyId.current !== copy.id) return;
      if (persisted.current !== JSON.stringify(fields(copy))) {
        const saved = await action<WorkingCopy>(
          "/api/working-copies/" + copy.id,
          "save_working_copy",
          {
            ...fields(copy),
            revision: revision.current,
            evaluationId: copy.evaluationId,
            baseDraftId: copy.baseDraftId,
          },
        );
        if (currentCopyId.current !== copy.id) return;
        revision.current = saved.revision;
        persisted.current = JSON.stringify(fields(saved));
      }
      const saved = await action<{
        draft: EvalDraft;
        evaluation: EvaluationLibraryEntry;
        workingCopy: WorkingCopy;
      }>("/api/working-copies/" + copy.id + "/publish", "save_evaluation", {
        revision: revision.current,
      });
      if (currentCopyId.current !== copy.id) return;
      setCopy(saved.workingCopy);
      draftMemory.delete(recoveryKey(copy.id));
      try {
        localStorage.removeItem(recoveryKey(copy.id));
        localStorage.removeItem(bufferKey);
      } catch {}
      setStatus("Evaluation saved");
      const sourceId = saved.evaluation.revisionId ?? saved.draft.id;
      const savedSource = new URLSearchParams({ add: sourceId, library: saved.evaluation.id });
      const replaced = params.get("replace") ?? (amendment ? initialDraft?.id : null);
      if (replaced) savedSource.set("replace", replaced);
      router.push(
        returning || amendment
          ? returnToRun + "&" + savedSource
          : "/evaluations/" + saved.evaluation.id,
      );
      router.refresh();
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <PageHeading
        title={
          isDuplicating
            ? "Duplicate evaluation"
            : editingId
              ? "Edit evaluation"
              : "Create evaluation"
        }
        description="The model receives your prompt. Success criteria stay private."
      />
      {!copy && <p role="status">Loading draft…</p>}
      {error && (
        <Notice>
          {error}
          {copy && (
            <button
              className={s.secondary}
              onClick={() =>
                void navigator.clipboard
                  .writeText(
                    copy.stages
                      .map(
                        (stage, index) =>
                          (copy.stages.length > 1 ? `Stage ${index + 1}\n\n` : "") +
                          stage.prompt +
                          "\n\n" +
                          stage.criteria,
                      )
                      .join("\n\n"),
                  )
                  .catch(() => setError("Select the prompt and criteria below to copy your text."))
              }
            >
              Copy authored text
            </button>
          )}
          {copy && !conflict && (
            <button
              className={s.secondary}
              disabled={busy || oversized}
              onClick={() => {
                setError("");
                setCopy({ ...copy });
              }}
            >
              Try to save again
            </button>
          )}
          {conflict && (
            <div className={s.row}>
              {savedCopy && (
                <details>
                  <summary>Compare saved text</summary>
                  {savedCopy.stages.map((stage, index) => (
                    <div key={index}>
                      {savedCopy.stages.length > 1 && <h3>Stage {index + 1}</h3>}
                      <h3>Saved prompt</h3>
                      <pre className={s.code}>{stage.prompt}</pre>
                      <h3>Saved criteria</h3>
                      <pre className={s.code}>{stage.criteria}</pre>
                    </div>
                  ))}
                </details>
              )}
              <button className={s.secondary} onClick={loadSaved}>
                Load saved draft
              </button>
              {copy?.evaluationId && (
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => void reapply()}
                >
                  Apply my text to the current version
                </button>
              )}
              {copy?.evaluationId && (
                <button
                  className={s.secondary}
                  onClick={() => {
                    const next = new URLSearchParams(params.toString());
                    next.set("evaluation", copy.evaluationId!);
                    next.set("copy", crypto.randomUUID());
                    next.delete("draft");
                    next.delete("duplicate");
                    router.push(`/evaluations/new?${next}`);
                  }}
                >
                  Open current evaluation
                </button>
              )}
            </div>
          )}
        </Notice>
      )}
      {copy && (
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {retainedCopy && (
            <details>
              <summary>Previous unfinished text</summary>
              <h3>{retainedCopy.title}</h3>
              {validStages(retainedCopy.stages) &&
                retainedCopy.stages.map((stage, index) => (
                  <div key={index}>
                    <pre className={s.code}>{stage.prompt}</pre>
                    <pre className={s.code}>{stage.criteria}</pre>
                  </div>
                ))}
              <button
                type="button"
                className={s.secondary}
                disabled={busy || !validStages(retainedCopy.stages)}
                onClick={() =>
                  change({
                    ...copy,
                    ...fields(retainedCopy),
                    parsed: retainedCopy.stages.map((_, index) => copy.parsed[index] ?? unparsed()),
                  })
                }
              >
                Restore my earlier text here
              </button>
            </details>
          )}
          {editingId && (
            <p className={s.small}>
              Saving updates this evaluation. Earlier runs keep the exact inputs they started with.
            </p>
          )}
          <div className={s.field}>
            <label htmlFor="evaluation-title">Title</label>
            <input
              id="evaluation-title"
              maxLength={120}
              value={copy.title}
              disabled={busy}
              onChange={(e) => change({ ...copy, title: e.target.value })}
            />
          </div>
          {copy.stages.map((stage, index) => (
            <StageFields
              key={index}
              index={index}
              stages={copy.stages}
              parse={copy.parsed[index] ?? unparsed()}
              busy={busy}
              questions={questions.filter((question) => question.stage === index + 1)}
              onEdit={(patch) => editStage(index, patch)}
              onMove={(offset) => moveStage(index, offset)}
              onRemove={() => removeStage(index)}
            />
          ))}
          <div className={s.stageAdd}>
            <button
              type="button"
              className={s.secondary}
              disabled={busy || copy.stages.length >= MAX_EVAL_STAGES}
              onClick={addStage}
            >
              Add stage
            </button>
            <small className={s.small}>
              {copy.stages.length >= MAX_EVAL_STAGES
                ? `An evaluation can have up to ${MAX_EVAL_STAGES} stages.`
                : "In a new stage, the model continues its own build with a new prompt."}
            </small>
          </div>
          {removed && (
            <p className={s.stageUndo} role="status">
              Stage {removed.number} removed.
              <button
                id="undo-remove-stage"
                type="button"
                className={s.textButton}
                disabled={busy}
                onClick={undoRemove}
              >
                Undo
              </button>
            </p>
          )}
          <details>
            <summary>Formatted view and help</summary>
            <p>
              In the prompt, describe what the model must build. In the success criteria, list
              things you can see or measure, without adding new demands.
            </p>
            {copy.stages.map((stage, index) => {
              const label = copy.stages.length > 1 ? ` · Stage ${index + 1}` : "";
              return (
                <div key={index}>
                  <section aria-label={`Formatted prompt${label}`}>
                    <h2>Formatted prompt{label}</h2>
                    <MarkdownPreview value={stage.prompt} />
                  </section>
                  <section aria-label={`Formatted criteria${label}`}>
                    <h2>Formatted criteria{label}</h2>
                    <MarkdownPreview value={stage.criteria} />
                  </section>
                </div>
              );
            })}
          </details>
          <div className={s.toolbar}>
            <button
              className={s.primary}
              disabled={
                busy ||
                conflict ||
                oversized ||
                copy.stages.some((stage) => !stage.prompt.trim() || !stage.criteria.trim()) ||
                copy.parsed.some((parse) => Boolean(parse.error))
              }
            >
              {busy
                ? "Saving…"
                : returning || amendment
                  ? "Save & return to run"
                  : isDuplicating
                    ? "Create copy"
                    : editingId
                      ? "Save changes"
                      : "Save evaluation"}
            </button>
            <Link
              className={s.secondary}
              href={backHref}
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              {returning || amendment
                ? "Back to run"
                : editingId
                  ? "Back to evaluation"
                  : "Back to evaluations"}
            </Link>
            <span className={s.small} role="status">
              {status} · {missingText(copy.stages)}
            </span>
          </div>
        </form>
      )}
    </main>
  );
}

/** What the author must add before the evaluation can be saved. */
function missingText(stages: WorkingCopyStage[]): string {
  const index = stages.findIndex((stage) => !stage.prompt.trim() || !stage.criteria.trim());
  if (index < 0) return "Saving is free";
  const stage = stages[index]!;
  const where = stages.length > 1 ? ` to stage ${index + 1}` : "";
  return !stage.prompt.trim() && !stage.criteria.trim()
    ? `Add a prompt and success criteria${where} before you save`
    : !stage.prompt.trim()
      ? `Add a prompt${where} before you save`
      : `Add success criteria${where} before you save`;
}

/**
 * The prompt, the private criteria and the gate of one stage. With one stage, the fields look
 * the same as an evaluation without stages: no stage heading and no stage actions.
 */
function StageFields({
  index,
  stages,
  parse,
  busy,
  questions,
  onEdit,
  onMove,
  onRemove,
}: {
  index: number;
  stages: WorkingCopyStage[];
  parse: WorkingCopy["parsed"][number];
  busy: boolean;
  questions: Array<{ id: string; message: string; passage: { text: string } | null }>;
  onEdit: (patch: Partial<WorkingCopyStage>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const stage = stages[index]!;
  const staged = stages.length > 1;
  const number = index + 1;
  // The first stage keeps the field IDs of an evaluation without stages.
  const id = (name: string) => (index === 0 ? name : `${name}-${number}`);
  const context = staged ? <span className={s.visuallyHidden}> for stage {number}</span> : null;
  const required = parse.criteria.filter((item) => item.required);
  const columns = (
    <div className={s.columns}>
      <section className={`${s.field} ${s.authorPane}`}>
        <label htmlFor={id("evaluation-prompt")}>
          Prompt
          {context}
        </label>
        <textarea
          id={id("evaluation-prompt")}
          rows={8}
          aria-describedby={`${id("prompt-help")} ${id("prompt-limit")}`}
          aria-invalid={bytes(stage.prompt) > LIMIT}
          value={stage.prompt}
          disabled={busy}
          required
          onChange={(e) => onEdit({ prompt: e.target.value })}
        />
        <small id={id("prompt-help")}>
          {index === 0
            ? "Describe what the model must build. The model sees this text but never your success criteria."
            : "Describe what the model must add to its build. The model also sees the prompts of the earlier stages."}
        </small>
        <small id={id("prompt-limit")}>
          {bytes(stage.prompt).toLocaleString()} / 32,768 bytes
          {bytes(stage.prompt) > LIMIT
            ? " · The prompt is over the limit. Shorten it before you save."
            : ""}
        </small>
        {questions
          .filter((q) => q.passage && stage.prompt.includes(q.passage.text))
          .map((q) => (
            <Notice key={q.id} kind="info">
              <blockquote>{q.passage?.text.replace(/^\s*[-*+]\s+/u, "")}</blockquote>
              {q.message}
            </Notice>
          ))}
      </section>
      <section className={`${s.field} ${s.authorPane} ${s.sealed}`}>
        <label htmlFor={id("evaluation-criteria")}>
          Success criteria
          {context} <span className={s.privateTag}>Private</span>
        </label>
        <textarea
          id={id("evaluation-criteria")}
          rows={8}
          aria-describedby={`${id("criteria-help")} ${id("criteria-limit")} ${id("criteria-error")}`}
          aria-invalid={!!parse.error || bytes(stage.criteria) > LIMIT}
          value={stage.criteria}
          disabled={busy}
          required
          onChange={(e) => onEdit({ criteria: e.target.value })}
        />
        <small id={id("criteria-help")}>
          Write each criterion as a list item. Keep any numerical scales and success thresholds in
          your own words.
        </small>
        <small id={id("criteria-limit")}>
          {bytes(stage.criteria).toLocaleString()} / 32,768 bytes
          {bytes(stage.criteria) > LIMIT
            ? " · The success criteria are over the limit. Shorten them before you save."
            : ""}
        </small>
        <div id={id("criteria-error")}>
          {parse.error && (
            <Notice>{parse.error} Correct the criteria before you save the evaluation.</Notice>
          )}
        </div>
        {questions
          .filter((q) => !q.passage || !stage.prompt.includes(q.passage.text))
          .map((q) => (
            <Notice key={q.id} kind="info">
              <blockquote>{q.passage?.text.replace(/^\s*[-*+]\s+/u, "")}</blockquote>
              {q.message}
            </Notice>
          ))}
        {!parse.error && parse.criteria.length > 0 && (
          <details open>
            <summary>
              {parse.criteria.length} {parse.criteria.length === 1 ? "criterion" : "criteria"}
            </summary>
            <ol>
              {parse.criteria.map((item, i) => (
                <li key={i}>{statementText(item.text)}</li>
              ))}
            </ol>
          </details>
        )}
      </section>
    </div>
  );
  if (!staged) return columns;
  return (
    <section className={s.stageBlock} aria-labelledby={id("stage-heading")} data-stage={number}>
      <div className={s.stageHeading}>
        <h2 id={id("stage-heading")}>
          Stage {number} of {stages.length}
        </h2>
        <div className={s.row}>
          <button
            type="button"
            className={s.textButton}
            disabled={busy || index === 0}
            aria-label={`Move stage ${number} up`}
            data-move="up"
            onClick={() => onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className={s.textButton}
            disabled={busy || index === stages.length - 1}
            aria-label={`Move stage ${number} down`}
            data-move="down"
            onClick={() => onMove(1)}
          >
            Move down
          </button>
          <button
            type="button"
            className={s.textButton}
            disabled={busy}
            aria-label={`Remove stage ${number}`}
            onClick={onRemove}
          >
            Remove stage
          </button>
        </div>
      </div>
      {index > 0 && (
        <p className={s.small}>
          The model starts this stage from its own build of stage&nbsp;
          {index}.
        </p>
      )}
      {columns}
      {index < stages.length - 1 && (
        <fieldset className={s.field} aria-describedby={id("gate-help")}>
          <legend>Gate before stage {number + 1}</legend>
          <small id={id("gate-help")}>
            Optional. Stage {number + 1} starts only if the build passes every criterion you check
            here. Use criteria that code can check, like whether a part exists. If a checked
            criterion needs the judge, the run stops at Preparing tests and says why.
          </small>
          {required.length === 0 ? (
            <small>Add a required success criterion to this stage to use it as a gate.</small>
          ) : (
            required.map((item) => (
              <label key={item.id} className={s.choice}>
                <input
                  type="checkbox"
                  checked={stage.gateCriterionIds.includes(item.id)}
                  disabled={busy}
                  onChange={(e) =>
                    onEdit({
                      gateCriterionIds: e.target.checked
                        ? [...stage.gateCriterionIds, item.id]
                        : stage.gateCriterionIds.filter((gate) => gate !== item.id),
                    })
                  }
                />
                <span>{statementText(item.text)}</span>
              </label>
            ))
          )}
        </fieldset>
      )}
    </section>
  );
}
