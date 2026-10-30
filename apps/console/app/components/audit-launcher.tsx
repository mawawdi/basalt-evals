"use client";
import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  REVIEW_SESSION_LIMITS,
  REVIEW_TRAINING_QUESTION_LIMIT,
  type ReviewPreview,
  type ReviewerProfile,
  type ReviewProgress,
  type ReviewSelection,
} from "../../../../dist/packages/contracts/src/review.js";
import type { ReviewTreatmentCatalog } from "../../../../dist/packages/contracts/src/console.js";
import { ReviewerPicker } from "./reviewer-picker";
import { action, message } from "./api";
import { Dialog, Notice } from "./ui";
import { checkerLabel } from "./result-display";
import s from "./workbench.module.css";
type TreatmentCatalog = ReviewTreatmentCatalog;

export function AuditLauncher({ operationIds }: { operationIds: string[] }) {
  const router = useRouter();
  const [reviewer, setReviewer] = useState<ReviewerProfile | null>(null);
  const [catalog, setCatalog] = useState<TreatmentCatalog["items"] | null>(null);
  const [treatments, setTreatments] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [catalogAttempt, setCatalogAttempt] = useState(0);
  const [questions, setQuestions] = useState("40");
  const [sent, setSent] = useState(false);
  const [purpose, setPurpose] = useState<"audit" | "diagnostic" | "training">("audit");
  const questionLimit = purpose === "training" ? REVIEW_TRAINING_QUESTION_LIMIT : 100000;
  const invalidQuestions =
    !questions.trim() ||
    !Number.isSafeInteger(Number(questions)) ||
    Number(questions) < 1 ||
    Number(questions) > questionLimit;
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const identity = useRef("");
  const working = useRef(false);
  const storage = `basalt-review-intent:${[...operationIds].sort().join(":")}`;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setCatalog(null);
    setError("");
    void action<TreatmentCatalog>("/api/review-batches/treatments", "review_treatments", {
      operationIds,
    })
      .then((value) => {
        if (!active) return;
        setCatalog(value.items);
        const choices: Record<string, string> = {};
        for (const item of value.items) {
          const available = item.treatments.filter(
            (t) => purpose !== "audit" || t.evidenceCondition === "original",
          );
          const saved = preview?.selection.treatments.find(
            (t) => t.operationId === item.operationId,
          )?.treatmentId;
          choices[item.operationId] =
            saved && available.some((t) => t.id === saved)
              ? saved
              : available.length === 1
                ? available[0]!.id
                : "";
        }
        setTreatments(choices);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [open, purpose, operationIds.join(":"), catalogAttempt]);
  function begin() {
    if (working.current) return;
    setError("");
    setReviewer(null);
    setOpen(true);
    setPreview(null);
    setSent(false);
    identity.current = crypto.randomUUID();
    try {
      const saved = JSON.parse(sessionStorage.getItem(storage) ?? "null");
      if (saved?.preview && saved?.key) {
        identity.current = saved.key;
        setPreview(saved.preview);
        setQuestions(String(saved.preview.selection.questionLimit));
        setSent(saved.sent === true);
        setPurpose(saved.preview.selection.purpose);
      }
    } catch {
      /* A fresh intent remains available. */
    }
  }
  function invalidate() {
    if (sent) return;
    setPreview(null);
    identity.current = crypto.randomUUID();
    try {
      sessionStorage.removeItem(storage);
    } catch {}
  }
  async function prepare() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (!reviewer || !catalog) throw new Error("Choose your reviewer profile");
      const selection: ReviewSelection = {
        purpose,
        operationIds,
        reviewer: reviewer.id,
        // Training needs no judge: its answers never meet an automatic result.
        treatments:
          purpose === "training"
            ? []
            : catalog.map((item) => ({
                operationId: item.operationId,
                treatmentId: treatments[item.operationId] || null,
              })),
        questionLimit: Number(questions),
        unitIds: [],
      };
      const value = await action<ReviewPreview>(
        "/api/review-batches/preview",
        "preview_review_batch",
        selection,
      );
      setPreview(value);
      try {
        sessionStorage.setItem(storage, JSON.stringify({ key: identity.current, preview: value }));
      } catch {}
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  async function start() {
    if (working.current || !preview || (!sent && preview.selection.reviewer !== reviewer?.id))
      return;
    working.current = true;
    setBusy(true);
    setError("");
    setSent(true);
    try {
      sessionStorage.setItem(
        storage,
        JSON.stringify({ key: identity.current, preview, sent: true }),
      );
    } catch {}
    try {
      const batch = await action<ReviewProgress>(
        "/api/review-batches/create",
        "create_review_batch",
        { previewId: preview.id, idempotencyKey: identity.current },
      );
      try {
        sessionStorage.removeItem(storage);
      } catch {}
      router.push(`/reviews/${batch.id}`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  const reason =
    sent && preview
      ? ""
      : !reviewer
        ? "Choose or create your reviewer profile."
        : !catalog
          ? "Loading judges…"
          : purpose !== "training" &&
              catalog.some(
                (item) =>
                  item.treatments.filter(
                    (t) => purpose !== "audit" || t.evidenceCondition === "original",
                  ).length > 1 && !treatments[item.operationId],
              )
            ? "Choose one judge for each run."
            : invalidQuestions
              ? `Enter a whole-number question limit from 1 to ${questionLimit.toLocaleString("en-US")}.`
              : preview && !preview.selectedUnitIds.length
                ? purpose === "training"
                  ? "No training questions are available. Training uses only development observations that no other review used."
                  : "No questions match this selection. Choose another judge or run."
                : "";
  return (
    <>
      <button className={s.secondary} onClick={begin} disabled={busy}>
        Review a sample
      </button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Review a sample of results"
      >
        <p className={s.small}>
          Optional. Answer a sample of questions yourself to see how often the automatic results
          agree with you.
        </p>
        {error && (
          <Notice>
            {error}
            {!catalog && (
              <button
                className={s.secondary}
                disabled={busy}
                onClick={() => setCatalogAttempt((value) => value + 1)}
              >
                Reload judges
              </button>
            )}
          </Notice>
        )}
        {sent && (
          <Notice kind="info">
            Reopen the review you already started before you change the settings.
          </Notice>
        )}
        <fieldset className={s.stack} disabled={busy || sent}>
          {open && (
            <ReviewerPicker
              value={reviewer}
              disabled={busy}
              onChange={(profile) => {
                setReviewer(profile);
                if (preview?.selection.reviewer !== profile.id) invalidate();
              }}
            />
          )}
          {(purpose === "training" ? [] : (catalog ?? [])).map((item, index) => {
            const available = item.treatments.filter(
              (t) => purpose !== "audit" || t.evidenceCondition === "original",
            );
            return (
              <div className={s.field} key={item.operationId}>
                {available.length > 1 ? (
                  <label htmlFor={`grader-${index}`}>
                    Judge for {item.title}
                    {(catalog?.length ?? 0) > 1 && ` (run ${index + 1})`}
                  </label>
                ) : (
                  <p className={s.small}>
                    Judge for {item.title}
                    {(catalog?.length ?? 0) > 1 && ` (run ${index + 1})`}
                  </p>
                )}
                {available.length > 1 ? (
                  <select
                    id={`grader-${index}`}
                    value={treatments[item.operationId] ?? ""}
                    onChange={(e) => {
                      setTreatments({ ...treatments, [item.operationId]: e.target.value });
                      invalidate();
                    }}
                  >
                    <option value="">Choose a judge</option>
                    {available.map((t) => (
                      <option key={t.id} value={t.id}>
                        {checkerLabel(t)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p>{available[0] ? checkerLabel(available[0]) : "Code checks"}</p>
                )}
                {purpose === "audit" &&
                  item.treatments.some((t) => t.evidenceCondition !== "original") && (
                    <p className={s.small}>
                      This preview leaves out test images (blank or unrelated).
                    </p>
                  )}
              </div>
            );
          })}
          <div className={s.field}>
            <label htmlFor="audit-purpose">Purpose</label>
            <select
              id="audit-purpose"
              value={purpose}
              onChange={(event) => {
                const next = event.target.value as "audit" | "diagnostic" | "training";
                setPurpose(next);
                if (next === "training") setQuestions("5");
                else if (purpose === "training") setQuestions("40");
                invalidate();
              }}
            >
              <option value="audit">Random review</option>
              <option value="diagnostic">Targeted review</option>
              <option value="training">Training review</option>
            </select>
            <p className={s.small}>
              {purpose === "audit"
                ? "Basalt picks questions at random from the automatic results."
                : purpose === "diagnostic"
                  ? "Look at failed or unclear results. This review describes what you find, not the overall accuracy."
                  : "Practice on development observations that no other review uses. Training answers do not count in any agreement."}
            </p>
          </div>
          <div className={s.field}>
            <label htmlFor="audit-questions">Question limit</label>
            <input
              id="audit-questions"
              type="number"
              min={1}
              max={questionLimit}
              step={1}
              value={questions}
              aria-describedby="audit-questions-error"
              aria-invalid={invalidQuestions}
              onChange={(event) => {
                setQuestions(event.target.value);
                invalidate();
              }}
            />
            <small id="audit-questions-error">
              {invalidQuestions
                ? `Enter a whole number from 1 to ${questionLimit.toLocaleString("en-US")}.`
                : ""}
            </small>
          </div>
          <p className={s.small}>
            A session ends after {REVIEW_SESSION_LIMITS.activeMs / 60000} active minutes or{" "}
            {REVIEW_SESSION_LIMITS.questions} answers, and you can continue in a new session. These
            limits control your workload, not the accuracy.
          </p>
          {preview && (
            <section className={`${s.panel} ${s.panelBody}`}>
              <h3>
                {preview.selectedUnitIds.length} selected{" "}
                {preview.selectedUnitIds.length === 1 ? "question" : "questions"}
              </h3>
              <p>
                Basalt picked the questions from {preview.eligible} of {preview.plannedOutcomes}{" "}
                results you can review.
                {preview.excluded > 0 &&
                  ` It left out ${preview.excluded} ${preview.excluded === 1 ? "result" : "results"} because of unavailable evidence, an unavailable answer or a test image.`}
              </p>
              <p className={s.small}>
                {Math.max(0, preview.selectedUnitIds.length - preview.reusable)}{" "}
                {preview.selectedUnitIds.length - preview.reusable === 1
                  ? "question needs"
                  : "questions need"}{" "}
                your answer.
                {preview.reusable > 0 &&
                  ` ${preview.reusable} ${preview.reusable === 1 ? "reuses an answer" : "reuse answers"} you already gave.`}{" "}
                A review never starts models or Studio.
              </p>
              <p className={s.small}>
                Assigned to {reviewer?.displayName}. This does not change after the review starts.
              </p>
            </section>
          )}
          <button
            className={s.primary}
            disabled={busy || !!reason}
            aria-describedby="review-launch-reason"
            onClick={() => void (preview ? start() : prepare())}
          >
            {busy
              ? preview
                ? "Creating review session…"
                : "Preparing sample…"
              : preview
                ? "Start review"
                : "Preview sample"}
          </button>
          <p id="review-launch-reason" className={s.small} role="status">
            {reason ||
              (preview
                ? "Start only when you’re ready to review. Active time counts only while the session is visible and focused."
                : "A preview does not assign questions or start the review timer.")}
          </p>
        </fieldset>
        {sent && (
          <button className={s.primary} disabled={busy} onClick={() => void start()}>
            {busy ? "Reopening review…" : "Reopen your review session"}
          </button>
        )}
      </Dialog>
    </>
  );
}
