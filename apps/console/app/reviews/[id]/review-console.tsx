"use client";
import { startTransition, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  REVIEW_REASON_CODES,
  REVIEW_REASON_SENTENCE_LIMIT,
  reviewReasonProblem,
  type BlindReviewProgress,
  type ReviewerProfile,
  type BlindReviewQuestion,
  type ReviewDecision,
  type ReviewReasonCode,
} from "../../../../../dist/packages/contracts/src/review.js";
import { ReviewIdentity } from "../../components/reviewer-picker";
import { criterionChoices } from "../../../../../dist/packages/contracts/src/review-choices.js";
import { fitReason, reasonChoices, reasonLabels } from "../../components/review-reasons";
import { EvidenceViewer } from "../../components/evidence-viewer";
import { action, read, message, ApiError } from "../../components/api";
import { Notice, Loading } from "../../components/ui";
import { draftMemory, useUnsavedGuard } from "../../components/draft-memory";
import s from "../../components/workbench.module.css";
import r from "../../components/review-experience.module.css";
import { statementText } from "../../components/result-display";

type Draft = BlindReviewQuestion["draft"];
function sameAnswer(left: Draft, right: Draft) {
  return (
    JSON.stringify(left.decision) === JSON.stringify(right.decision) &&
    JSON.stringify(left.reason) === JSON.stringify(right.reason) &&
    left.blindingIssue === right.blindingIssue
  );
}
/** The reason problem of a draft, or an empty string when the answer can be saved. */
function reasonIssue(draft: Draft | null) {
  if (!draft?.decision) return "";
  return (
    reviewReasonProblem(
      draft.decision,
      draft.reason && { ...draft.reason, sentence: draft.reason.sentence.trim() },
    ) ?? ""
  );
}
function scoreProblem(question: BlindReviewQuestion | null, draft: Draft | null) {
  if (!question || draft?.decision?.kind !== "score") return "";
  const value = draft.decision.value,
    range = question.criterion.scoreRange;
  if (!Number.isFinite(value)) return "Enter a number on the scale.";
  if (range) {
    if (value < range.minimum || value > range.maximum)
      return `Choose a score from ${range.minimum} to ${range.maximum}.`;
    if (range.step !== null) {
      const units = (value - range.minimum) / range.step;
      if (Math.abs(units - Math.round(units)) >= 1e-8)
        return `Use increments of ${range.step} from ${range.minimum}.`;
    }
  } else if (!question.criterion.anchors?.some((anchor) => anchor.score === value))
    return "Choose one of the listed scores.";
  return "";
}
function validLocalDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Draft;
  if (
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 0 ||
    (draft.blindingIssue !== null && typeof draft.blindingIssue !== "string")
  )
    return false;
  const reason = draft.reason;
  if (
    reason !== null &&
    (!reason ||
      typeof reason !== "object" ||
      typeof reason.sentence !== "string" ||
      (reason.code !== null && !REVIEW_REASON_CODES.includes(reason.code)))
  )
    return false;
  const decision = draft.decision;
  return (
    decision === null ||
    (!!decision &&
      ((decision.kind === "categorical" && ["satisfied", "violated"].includes(decision.value)) ||
        (decision.kind === "score" && Number.isFinite(decision.value)) ||
        decision.kind === "abstain"))
  );
}
function answerText(answer: { decision: ReviewDecision } | null, question: BlindReviewQuestion) {
  const decision = answer?.decision;
  if (!decision) return "No saved answer";
  if (decision.kind === "abstain") return "Cannot tell";
  if (decision.kind === "score") return `Score ${decision.value}`;
  return criterionChoices(question.criterion.statement)[decision.value];
}
export function ReviewConsole({ batchId }: { batchId: string }) {
  return (
    <ReviewIdentity key={batchId} batchId={batchId}>
      {(profile) => (
        <ReviewSession key={`${batchId}:${profile.id}`} batchId={batchId} reviewer={profile} />
      )}
    </ReviewIdentity>
  );
}
function ReviewSession({
  batchId,
  reviewer: profile,
}: {
  batchId: string;
  reviewer: ReviewerProfile;
}) {
  const reviewer = profile.id;
  const [progress, setProgress] = useState<BlindReviewProgress | null>(null);
  const [question, setQuestion] = useState<BlindReviewQuestion | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [busy, setBusy] = useState(false),
    [scoreTouched, setScoreTouched] = useState(false),
    [reasonTouched, setReasonTouched] = useState(false),
    [targetsLoading, setTargetsLoading] = useState(false),
    [targetPage, setTargetPage] = useState(0),
    [endDraftRetained, setEndDraftRetained] = useState(false),
    [draftFailed, setDraftFailed] = useState(false);
  const [conflict, setConflict] = useState(false),
    [recovery, setRecovery] = useState<Draft | null>(null);
  const [targets, setTargets] = useState<BlindReviewQuestion[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const deviceSaved = useRef(false);
  const [delivered, setDelivered] = useState<string[]>([]);
  const session = useRef(""),
    current = useRef<BlindReviewQuestion | null>(null),
    latest = useRef<Draft | null>(null),
    persisted = useRef<Draft | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serial = useRef(0),
    heading = useRef<HTMLHeadingElement>(null);
  const working = useRef(false),
    mounted = useRef(true),
    progressRequest = useRef(0),
    targetRequest = useRef(0);
  const progressValue = useRef(progress);
  progressValue.current = progress;
  function sequence() {
    serial.current = Math.max(Date.now(), serial.current + 1);
    return serial.current;
  }
  const base = `/api/reviews/${batchId}`;
  const key = (id: string) =>
    `basalt-review-recovery:${reviewer}:${batchId}:${id}:${session.current}`;
  function retain(id: string, value: Draft) {
    draftMemory.set(key(id), value);
    try {
      localStorage.setItem(key(id), JSON.stringify(value));
      deviceSaved.current = true;
    } catch {
      deviceSaved.current = false;
    }
    return deviceSaved.current;
  }
  function update(value: Partial<Omit<Draft, "revision">>, force = false) {
    if ((!force && working.current) || !current.current || !latest.current) return;
    const next = { ...latest.current, ...value };
    latest.current = next;
    setDraft(next);
    retain(current.current.id, next);
    if (timer.current) clearTimeout(timer.current);
    if (scoreProblem(current.current, next)) {
      setSaved(
        deviceSaved.current
          ? "Draft kept on this device until the score is valid"
          : "Unsaved · fix the score · only held on this page",
      );
      return;
    }
    setSaved("Saving draft…");
    timer.current = setTimeout(() => void flush().catch(() => {}), 600);
  }
  function flush() {
    if (timer.current) clearTimeout(timer.current);
    const id = current.current?.id;
    const work = chain.current
      .catch(() => {})
      .then(async () => {
        if (!id || current.current?.id !== id || !latest.current) return;
        const value = { ...latest.current };
        const invalid = scoreProblem(current.current, value);
        if (invalid) throw new Error(invalid);
        if (
          persisted.current?.revision === value.revision &&
          sameAnswer(persisted.current, value)
        ) {
          setSaved("Draft saved");
          return;
        }
        try {
          const result = await action<Draft>(`${base}/questions/${id}/draft`, "save_review_draft", {
            reviewer,
            sessionId: session.current,
            ...value,
          });
          if (current.current?.id === id && latest.current) {
            persisted.current = result;
            latest.current = { ...latest.current, revision: result.revision };
            setDraft(latest.current);
            retain(id, latest.current);
            setSaved(
              scoreProblem(current.current, latest.current)
                ? deviceSaved.current
                  ? "Draft kept on this device until the score is valid"
                  : "Unsaved · fix the score · only held on this page"
                : sameAnswer(latest.current, result)
                  ? "Draft saved"
                  : "Saving draft…",
            );
            setError("");
            setDraftFailed(false);
          }
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 409) setConflict(true);
          setSaved(
            deviceSaved.current
              ? "Draft kept on this device · not saved to the server yet"
              : "Unsaved · only held on this page",
          );
          setError(
            message(cause) +
              (deviceSaved.current
                ? " Your draft is kept on this device."
                : " This browser couldn’t keep a backup either, so keep this page open and copy your answer or try again."),
          );
          setDraftFailed(true);
          throw cause;
        }
      });
    chain.current = work;
    return work;
  }
  async function open(id: string, push = true, inAction = false) {
    if (working.current && !inAction) return;
    if (!inAction) working.current = true;
    progressRequest.current++;
    targetRequest.current++;
    setBusy(true);
    setError("");
    setSaved("");
    setConflict(false);
    setRecovery(null);
    setTargets([]);
    setTargetsLoading(false);
    setSelected([]);
    setTargetPage(0);
    setScoreTouched(false);
    setReasonTouched(false);
    setDraftFailed(false);
    setDelivered([]);
    try {
      const value = await action<BlindReviewQuestion>(
        `${base}/questions/${id}/claim`,
        "claim_review_question",
        { reviewer, sessionId: session.current },
      );
      if (!mounted.current) return;
      let recovered: Draft | null = null;
      try {
        const local: unknown =
          draftMemory.get(key(id)) ?? JSON.parse(localStorage.getItem(key(id)) ?? "null");
        recovered = validLocalDraft(local) ? local : null;
      } catch {
        /* Invalid local draft is discarded. */
      }
      const next =
        recovered && recovered.revision === value.draft.revision ? recovered : value.draft;
      const needsRecovery = !!(
        recovered &&
        recovered.revision !== value.draft.revision &&
        !sameAnswer(recovered, value.draft)
      );
      if (needsRecovery) setRecovery(recovered);
      const params = new URLSearchParams(location.search);
      if (push && current.current?.id !== id)
        for (const key of ["view", "source", "frame", "compare", "compareFrame"])
          params.delete(key);
      params.set("question", id);
      params.set("pass", value.evidence.passes[0]?.id ?? "");
      history[push ? "pushState" : "replaceState"](null, "", `${location.pathname}?${params}`);
      current.current = value;
      latest.current = next;
      persisted.current = value.draft;
      setQuestion(value);
      setDraft(next);
      if (!needsRecovery) retain(id, next);
      setSaved(
        value.answer && sameAnswer(value.draft, next)
          ? "Answer saved"
          : sameAnswer(value.draft, next)
            ? "Draft saved"
            : "Recovered local draft",
      );
      const ticket = ++progressRequest.current;
      const progress = await action<BlindReviewProgress>(`${base}/activity`, "review_activity", {
        reviewer,
        sessionId: session.current,
        sequence: sequence(),
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      });
      if (mounted.current && ticket === progressRequest.current) setProgress(progress);
      // Restore focus before enabling answers, so the next key cannot be stolen by a late frame.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      heading.current?.focus();
    } catch (cause) {
      if (mounted.current) {
        setError(message(cause));
        if (cause instanceof ApiError && cause.status === 409 && current.current) setConflict(true);
      }
    } finally {
      if (!inAction) working.current = false;
      if (mounted.current && !inAction) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const sessionKey = `basalt-review-actor-session:${reviewer}:${batchId}`;
    try {
      session.current = sessionStorage.getItem(sessionKey) ?? crypto.randomUUID();
      sessionStorage.setItem(sessionKey, session.current);
    } catch {
      session.current = crypto.randomUUID();
    }
    let active = true;
    void read<BlindReviewProgress>(`${base}?reviewer=${reviewer}`)
      .then(async (value) => {
        if (!active) return;
        setProgress(value);
        // The first session starts with the first question. A finished session waits for an
        // explicit start of the next session. At the time limit, the open question can still save.
        const session = value.session?.state ?? null;
        if (
          value.state === "active" &&
          (session === null || session === "open" || session === "time_limit")
        ) {
          const selected = new URLSearchParams(location.search).get("question");
          const id = value.questions.some((question) => question.id === selected)
            ? selected
            : session === "time_limit"
              ? null
              : value.nextAssignmentId;
          if (id) await open(id, false);
        }
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    const back = () => {
      const id = new URLSearchParams(location.search).get("question");
      if (!id || id === current.current?.id) return;
      if (working.current || progressValue.current?.state !== "active") {
        if (current.current) {
          const params = new URLSearchParams(location.search);
          params.set("question", current.current.id);
          history.replaceState(null, "", `${location.pathname}?${params}`);
        }
        return;
      }
      working.current = true;
      setBusy(true);
      void flush()
        .catch((cause) => {
          if (!deviceSaved.current) throw cause;
        })
        .then(() => open(id, false, true))
        .catch(() => {
          if (current.current) {
            const params = new URLSearchParams(location.search);
            params.set("question", current.current.id);
            history.replaceState(null, "", `${location.pathname}?${params}`);
          }
        })
        .finally(() => {
          working.current = false;
          if (active) setBusy(false);
        });
    };
    const heartbeat = () => {
      if (!current.current || working.current) return;
      const ticket = ++progressRequest.current;
      void action<BlindReviewProgress>(
        `${base}/activity`,
        "review_activity",
        {
          reviewer,
          sessionId: session.current,
          sequence: sequence(),
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
        },
        true,
      )
        .then((value) => {
          // A background refresh never competes with typing: keystrokes render first.
          if (active && ticket === progressRequest.current)
            startTransition(() => setProgress(value));
        })
        .catch((cause) => {
          if (active && ticket === progressRequest.current) setError(message(cause));
        });
    };
    const interval = setInterval(heartbeat, 15000);
    addEventListener("popstate", back);
    addEventListener("focus", heartbeat);
    addEventListener("blur", heartbeat);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      active = false;
      mounted.current = false;
      progressRequest.current++;
      targetRequest.current++;
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
      removeEventListener("popstate", back);
      removeEventListener("focus", heartbeat);
      removeEventListener("blur", heartbeat);
      document.removeEventListener("visibilitychange", heartbeat);
      if (current.current)
        void action(
          `${base}/activity`,
          "review_activity",
          {
            reviewer,
            sessionId: session.current,
            sequence: sequence(),
            visible: false,
            focused: false,
          },
          true,
        ).catch(() => {});
    };
  }, [base, reviewer]);
  function choose(decision: ReviewDecision | null) {
    update({ decision, reason: fitReason(decision, latest.current?.reason ?? null) });
  }
  function reason(value: { code?: ReviewReasonCode | null; sentence?: string }) {
    const previous = latest.current?.reason ?? { code: null, sentence: "" };
    update({ reason: { ...previous, ...value } });
  }
  async function save() {
    if (working.current || conflict || !current.current || !latest.current) return;
    const abstain = latest.current.decision?.kind === "abstain";
    if (!abstain && scoreProblem(current.current, latest.current)) {
      setScoreTouched(true);
      return;
    }
    if (reasonIssue(latest.current)) {
      setReasonTouched(true);
      return;
    }
    if (!abstain && !delivered.length) {
      setError(
        "The evidence hasn’t loaded yet. Open an image, the code or the recorded behavior, or choose Cannot tell.",
      );
      return;
    }
    working.current = true;
    progressRequest.current++;
    setBusy(true);
    setError("");
    try {
      // The saved sentence has no spaces before or after it.
      const typed = latest.current.reason;
      if (typed && typed.sentence !== typed.sentence.trim())
        update({ reason: { ...typed, sentence: typed.sentence.trim() } }, true);
      await flush();
      const value = latest.current!;
      const result = await action<{ answerId: string; progress: BlindReviewProgress }>(
        `${base}/questions/${current.current!.id}/answer`,
        "answer_review_question",
        {
          reviewer,
          sessionId: session.current,
          ...value,
        },
      );
      try {
        localStorage.removeItem(key(current.current!.id));
      } catch {}
      draftMemory.delete(key(current.current!.id));
      setProgress(result.progress);
      setSaved("Answer saved");
      current.current = null;
      latest.current = null;
      persisted.current = null;
      setQuestion(null);
      setDraft(null);
      if (
        result.progress.state === "active" &&
        result.progress.session?.state === "open" &&
        result.progress.nextAssignmentId
      )
        await open(result.progress.nextAssignmentId, true, true);
      else {
        current.current = null;
        latest.current = null;
        setQuestion(null);
        setDraft(null);
      }
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  async function end() {
    if (working.current) return;
    working.current = true;
    progressRequest.current++;
    setBusy(true);
    setError("");
    try {
      const hasDraft =
        !!recovery ||
        (!!latest.current &&
          !!current.current &&
          !!(latest.current.decision || latest.current.reason || latest.current.blindingIssue) &&
          (!current.current.answer ||
            !sameAnswer(
              { ...current.current.answer, revision: latest.current.revision },
              latest.current,
            )));
      if (current.current)
        await flush().catch((cause) => {
          if (!deviceSaved.current) throw cause;
        });
      const value = await action<BlindReviewProgress>(`${base}/end`, "end_review_session", {
        reviewer,
      });
      setProgress(value);
      setEndDraftRetained(hasDraft);
      setError("");
      setSaved("");
      setQuestion(null);
      setDraft(null);
      current.current = null;
      latest.current = null;
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  async function startSession() {
    if (working.current) return;
    working.current = true;
    progressRequest.current++;
    setBusy(true);
    setError("");
    setEndDraftRetained(false);
    try {
      const value = await action<BlindReviewProgress>(`${base}/sessions`, "start_review_session", {
        reviewer,
      });
      setProgress(value);
      if (value.nextAssignmentId) await open(value.nextAssignmentId, true, true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  async function previous() {
    if (working.current || !question || !progress || progress.state !== "active") return;
    const index = progress.questions.findIndex((item) => item.id === question.id);
    if (index < 1 || !progress.questions[index - 1]?.reopenable) return;
    working.current = true;
    progressRequest.current++;
    setBusy(true);
    try {
      await flush().catch((cause) => {
        if (!deviceSaved.current) throw cause;
      });
      await open(progress.questions[index - 1]!.id, true, true);
    } catch {
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  async function loadTargets(page = 0) {
    if (!question || !progress || targetsLoading) return;
    const source = question;
    const ticket = ++targetRequest.current;
    setTargetsLoading(true);
    if (page === 0) setTargets([]);
    try {
      const acknowledged = progress.questions.filter(
        (item) => item.acknowledged && item.id !== source.id,
      );
      const values = await Promise.all(
        acknowledged
          .slice(page * 25, (page + 1) * 25)
          .map((item) =>
            read<BlindReviewQuestion>(`${base}/questions/${item.id}?reviewer=${reviewer}`),
          ),
      );
      if (!mounted.current || ticket !== targetRequest.current || current.current?.id !== source.id)
        return;
      const matches = values.filter(
        (item) =>
          item.crossPass &&
          item.criterion.id === source.criterion.id &&
          item.evidence.id === source.evidence.id &&
          item.evidence.passes[0]?.id !== source.evidence.passes[0]?.id,
      );
      setTargets((current) =>
        page === 0
          ? matches
          : [
              ...current.filter((item) => !matches.some((match) => match.id === item.id)),
              ...matches,
            ],
      );
      setTargetPage(page + 1);
    } catch (cause) {
      if (mounted.current && ticket === targetRequest.current) setError(message(cause));
    } finally {
      if (mounted.current && ticket === targetRequest.current) setTargetsLoading(false);
    }
  }
  async function apply() {
    if (
      working.current ||
      targetsLoading ||
      progress?.state !== "active" ||
      conflict ||
      !question ||
      !draft ||
      !question.answer ||
      !sameAnswer({ ...question.answer, revision: draft.revision }, draft) ||
      !selected.length
    )
      return;
    working.current = true;
    progressRequest.current++;
    setBusy(true);
    setError("");
    try {
      const value = await action<BlindReviewProgress>(
        `${base}/questions/${question.id}/apply`,
        "apply_review_across_passes",
        {
          reviewer,
          sessionId: session.current,
          acknowledged: true,
          targets: targets
            .filter((item) => selected.includes(item.id))
            .map((item) => ({ id: item.id, revision: item.draft.revision })),
        },
      );
      setProgress(value);
      setSelected([]);
      setSaved("Saved answer applied to the selected observations");
      await loadTargets();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  const sessionState = progress?.session?.state ?? null;
  const done =
    progress &&
    !question &&
    (progress.state === "completed" || (sessionState !== null && sessionState !== "open"));
  // A finished session names only the kinds of answer it actually has.
  const answerKinds = progress
    ? [
        progress.abstained > 0 && `${progress.abstained} Cannot tell`,
        progress.reused > 0 &&
          `${progress.reused} reused from earlier ${progress.reused === 1 ? "answer" : "answers"}`,
      ].filter(Boolean)
    : [];
  useUnsavedGuard(
    () =>
      !!latest.current &&
      !deviceSaved.current &&
      (!persisted.current || !sameAnswer(latest.current, persisted.current)),
    () =>
      setError(
        "Your answer isn’t saved, and this browser can’t keep a backup. Copy the answer or save it again before you leave.",
      ),
  );
  useEffect(() => {
    document.title = "Independent review · Basalt";
  }, []);
  useEffect(() => {
    if (done) heading.current?.focus();
  }, [done]);
  const decision = draft?.decision;
  const choices = question ? criterionChoices(question.criterion.statement) : null;
  const invalidScore = scoreProblem(question, draft);
  const unchangedAnswer =
    !!question?.answer &&
    !!draft &&
    sameAnswer({ ...question.answer, revision: draft.revision }, draft);
  const acknowledgedTargetCount =
    progress?.questions.filter((item) => item.acknowledged && item.id !== question?.id).length ?? 0;
  const invalidReason = reasonIssue(draft);
  const finalQuestion =
    sessionState === "time_limit" ||
    (!question?.answer &&
      (progress?.remaining === 1 ||
        (progress?.session?.answered ?? 0) + 1 >= (progress?.sessionLimits.questions ?? 0)));
  const previousReopenable =
    !!question &&
    !!progress?.questions[progress.questions.findIndex((item) => item.id === question.id) - 1]
      ?.reopenable;
  return (
    <main>
      <div className={`${s.sectionHeading} ${r.sessionHeading}`}>
        <h1 ref={heading} tabIndex={-1}>
          {done
            ? "Session finished"
            : question
              ? `Question ${question.ordinal + 1} of ${progress?.assigned ?? "…"}`
              : "Your review session"}
        </h1>
        {progress && (
          <div className={r.sessionMeters} role="status">
            <div>
              <span>
                <strong>{progress.answered}</strong> saved, {progress.remaining} unanswered
              </span>
              <span className={s.meter} aria-hidden>
                <span
                  style={{
                    width: `${progress.assigned ? (100 * progress.answered) / progress.assigned : 0}%`,
                  }}
                />
              </span>
            </div>
            <div>
              <span>
                Session {progress.session?.number ?? 1}:{" "}
                <strong>{Math.floor((progress.session?.activeMs ?? 0) / 60000)}</strong> of{" "}
                {Math.round(progress.sessionLimits.activeMs / 60000)} active minutes,{" "}
                {progress.session?.answered ?? 0} of {progress.sessionLimits.questions} answers
              </span>
              <span className={s.meter} aria-hidden>
                <span
                  style={{
                    width: `${Math.min(100, (100 * (progress.session?.activeMs ?? 0)) / progress.sessionLimits.activeMs)}%`,
                  }}
                />
              </span>
            </div>
          </div>
        )}
      </div>
      {error && (
        <Notice>
          {error}
          {draft && (
            <button
              className={s.secondary}
              onClick={() =>
                void navigator.clipboard
                  .writeText(JSON.stringify(draft, null, 2))
                  .catch(() =>
                    setError(
                      "The browser couldn’t copy the draft. Keep this page open and try to save again.",
                    ),
                  )
              }
            >
              Copy answer draft
            </button>
          )}
          {conflict && question && (
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => void open(question.id, false)}
            >
              Reload saved answer
            </button>
          )}
          {draftFailed && !conflict && question && (
            <button
              className={s.secondary}
              disabled={busy || !!invalidScore}
              onClick={() => void flush().catch(() => {})}
            >
              Save draft again
            </button>
          )}
        </Notice>
      )}
      {saved && !done && (
        <p className={r.questionState} role="status" aria-live="polite">
          {saved}
        </p>
      )}
      {recovery && (
        <Notice kind="info">
          A saved answer changed while you were offline. You can restore the draft on this device.
          <div className={s.row}>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => {
                update({
                  decision: recovery.decision,
                  reason: recovery.reason,
                  blindingIssue: recovery.blindingIssue,
                });
                setRecovery(null);
              }}
            >
              Restore local draft
            </button>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => {
                if (question && draft) retain(question.id, draft);
                setRecovery(null);
              }}
            >
              Keep saved answer
            </button>
          </div>
        </Notice>
      )}
      {done ? (
        <section className={`${s.panel} ${s.panelBody}`}>
          <h2>
            {progress.state === "completed"
              ? "You answered all assigned questions"
              : sessionState === "time_limit"
                ? `This session reached ${Math.round(progress.sessionLimits.activeMs / 60000)} active minutes`
                : sessionState === "question_limit"
                  ? `This session reached ${progress.sessionLimits.questions} answers`
                  : "You ended this session"}
          </h2>
          <p>
            {progress.answered} answered.
            {answerKinds.length > 0 && ` The total includes ${answerKinds.join(" and ")}.`}
            {progress.remaining > 0 &&
              ` ${progress.remaining} ${progress.remaining === 1 ? "question is" : "questions are"} still unanswered.`}
          </p>
          {progress.state === "completed" ? (
            <p className={s.small}>Your answers are saved. This review has no more questions.</p>
          ) : (
            <>
              <p className={s.small}>
                Your answers are saved. Take a break, then start a new session to continue this
                review.
              </p>
              <button className={s.primary} disabled={busy} onClick={() => void startSession()}>
                {busy ? "Starting…" : `Start session ${(progress.session?.number ?? 0) + 1}`}
              </button>
            </>
          )}
          {endDraftRetained && (
            <p className={s.small}>
              Your unsubmitted draft stays{" "}
              {deviceSaved.current ? "on this device" : "on the server"}, but it doesn’t count as an
              answer.
            </p>
          )}
          <Link className={s.secondary} href="/reviews" prefetch={false}>
            Return to optional reviews
          </Link>
        </section>
      ) : !question || !draft ? (
        error ? (
          <button
            className={s.secondary}
            disabled={busy}
            onClick={() => {
              if (progress?.nextAssignmentId) void open(progress.nextAssignmentId, false);
              else location.reload();
            }}
          >
            Load review again
          </button>
        ) : (
          <Loading label="Loading assigned question" />
        )
      ) : (
        <>
          {sessionState === "time_limit" && (
            <Notice kind="info">
              This session reached its time limit. You can still save this answer, but no new
              question will open in this session.
            </Notice>
          )}
          {progress?.kind === "training" && (
            <Notice kind="info">
              This is a training review. Its questions are separate, and its answers do not count in
              any agreement.
            </Notice>
          )}
          {question.peer && (
            <Notice kind="info">
              This is round 2. The other reviewer gave a different answer to this question. Read
              their answer and reason, then give your final answer.
            </Notice>
          )}
          {question.unavailable && <Notice>{question.unavailable}</Notice>}
          {question.unavailable && (
            <p className={s.small}>
              The evidence for this question isn’t available. Choose Cannot tell to record that you
              can’t answer it.
            </p>
          )}
          <div className={s.reviewGrid}>
            <section
              className={`${s.panel} ${s.panelBody} ${s.questionContext}`}
              aria-label="Question and context"
            >
              <p className={s.small}>
                Observation {question.evidence.passes[0]?.number ?? "unavailable"}
                {question.answer ? " · Previously answered" : ""}
              </p>
              <h2>{statementText(question.criterion.statement)}</h2>
              {question.governingPassages
                .filter((text) => text !== question.criterion.statement)
                .map((text, index) => (
                  <blockquote key={index} className={s.small}>
                    {statementText(text)}
                  </blockquote>
                ))}
              {question.peer && (
                <section aria-labelledby="peer-answer">
                  <h3 id="peer-answer">Other reviewer’s answer</h3>
                  <p>
                    <strong>{answerText(question.peer, question)}</strong>
                  </p>
                  <p className={s.small}>
                    {reasonLabels[question.peer.reason.code]}: {question.peer.reason.sentence}
                  </p>
                </section>
              )}
            </section>
            <EvidenceViewer
              key={question.id}
              assetBase={`${base}/questions/${question.id}/asset?reviewer=${reviewer}`}
              item={question.evidence}
              passId={question.evidence.passes[0]?.id ?? ""}
              onPass={() => {}}
              preferred={question.preferredEvidence}
              showObservationNavigation={false}
              onDelivery={(kind, id, ready) =>
                setDelivered((current) => {
                  const key = kind + ":" + id;
                  return ready
                    ? current.includes(key)
                      ? current
                      : [...current, key]
                    : current.filter((value) => value !== key);
                })
              }
            />
            <section className={`${s.panel} ${s.panelBody} ${s.answerPanel}`}>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
                className={s.stack}
              >
                {question.criterion.scoreRange ? (
                  <div className={s.field}>
                    <label htmlFor="review-score">
                      Your score ({question.criterion.scoreRange.minimum}–
                      {question.criterion.scoreRange.maximum})
                    </label>
                    <input
                      id="review-score"
                      disabled={busy || conflict || !!question.unavailable}
                      type="number"
                      min={question.criterion.scoreRange.minimum}
                      max={question.criterion.scoreRange.maximum}
                      step={question.criterion.scoreRange.step ?? "any"}
                      aria-invalid={scoreTouched && !!invalidScore}
                      aria-describedby="review-score-help"
                      onBlur={() => setScoreTouched(true)}
                      value={decision?.kind === "score" ? decision.value : ""}
                      onChange={(event) =>
                        choose(
                          event.target.value === ""
                            ? null
                            : { kind: "score", value: Number(event.target.value) },
                        )
                      }
                    />
                    <p
                      id="review-score-help"
                      className={scoreTouched && invalidScore ? r.fieldError : s.small}
                    >
                      {scoreTouched && invalidScore
                        ? invalidScore
                        : question.criterion.scoreRange.step !== null
                          ? `Use increments of ${question.criterion.scoreRange.step} from ${question.criterion.scoreRange.minimum}.`
                          : "Use the scale and the evidence shown."}
                    </p>
                    {question.criterion.anchors?.map((anchor) => (
                      <p className={s.small} key={anchor.score}>
                        <strong>
                          {anchor.score} · {anchor.label}
                        </strong>{" "}
                        — {anchor.description}
                      </p>
                    ))}
                  </div>
                ) : question.criterion.anchors ? (
                  <fieldset
                    className={s.answerChoices}
                    disabled={busy || conflict || !!question.unavailable}
                  >
                    <legend>Your answer</legend>
                    {question.criterion.anchors.map((anchor) => (
                      <button
                        className={s.answerChoice}
                        type="button"
                        key={anchor.score}
                        aria-pressed={decision?.kind === "score" && decision.value === anchor.score}
                        onClick={() => choose({ kind: "score", value: anchor.score })}
                      >
                        <strong>
                          {anchor.score} · {anchor.label}
                        </strong>
                        <span>{anchor.description}</span>
                      </button>
                    ))}
                  </fieldset>
                ) : (
                  <fieldset
                    className={s.answerChoices}
                    disabled={busy || conflict || !!question.unavailable}
                    aria-label="Choose what the evidence shows"
                  >
                    {(["satisfied", "violated"] as const).map((value) => (
                      <button
                        key={value}
                        className={s.answerChoice}
                        type="button"
                        aria-pressed={decision?.kind === "categorical" && decision.value === value}
                        onClick={() => choose({ kind: "categorical", value })}
                      >
                        {choices![value]}
                      </button>
                    ))}
                  </fieldset>
                )}
                {question.criterion.minimumPassingScore === null &&
                  (question.criterion.anchors || question.criterion.scoreRange) && (
                    <p className={s.small}>
                      This criterion takes a score and has no minimum score for Met.
                    </p>
                  )}
                <button
                  className={s.secondary}
                  disabled={busy || conflict}
                  type="button"
                  aria-pressed={decision?.kind === "abstain"}
                  onClick={() => choose({ kind: "abstain" })}
                >
                  Cannot tell
                </button>
                <fieldset className={s.stack} disabled={busy || conflict}>
                  <legend>Why this answer?</legend>
                  <div className={s.field}>
                    <label htmlFor="review-reason">Reason</label>
                    <select
                      id="review-reason"
                      value={draft.reason?.code ?? ""}
                      aria-describedby="review-reason-help"
                      onBlur={() => setReasonTouched(true)}
                      onChange={(event) =>
                        reason({ code: (event.target.value || null) as ReviewReasonCode | null })
                      }
                    >
                      <option value="">Choose a reason</option>
                      {reasonChoices(decision ?? null).map((code) => (
                        <option key={code} value={code}>
                          {reasonLabels[code]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={s.field}>
                    <label htmlFor="review-reason-sentence">Explain in one sentence</label>
                    <input
                      id="review-reason-sentence"
                      maxLength={REVIEW_REASON_SENTENCE_LIMIT}
                      value={draft.reason?.sentence ?? ""}
                      aria-invalid={reasonTouched && !!invalidReason}
                      aria-describedby="review-reason-help"
                      onBlur={() => setReasonTouched(true)}
                      onChange={(event) => reason({ sentence: event.target.value })}
                    />
                  </div>
                  <p
                    id="review-reason-help"
                    className={reasonTouched && invalidReason ? r.fieldError : s.small}
                  >
                    {reasonTouched && invalidReason
                      ? invalidReason.replace(/(?<![.])$/u, ".")
                      : "Every answer needs a reason and one sentence, including Cannot tell."}
                  </p>
                </fieldset>
                <details>
                  <summary>Something suggests who made this</summary>
                  <div className={s.field}>
                    <label htmlFor="blinding-concern">
                      What could reveal the source or influence your answer?
                    </label>
                    <textarea
                      id="blinding-concern"
                      disabled={busy || conflict}
                      value={draft.blindingIssue ?? ""}
                      onChange={(event) => update({ blindingIssue: event.target.value || null })}
                      maxLength={2000}
                    />
                  </div>
                </details>
                <p className={r.answerHint}>
                  Your draft saves automatically. {finalQuestion ? "Save & finish" : "Save & next"}{" "}
                  saves your answer and reason for the evidence shown. Cannot tell records that you
                  couldn’t answer from the evidence.
                </p>
                <div>
                  <div className={s.reviewActions}>
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={busy || !previousReopenable || progress?.state !== "active"}
                      onClick={() => void previous()}
                    >
                      Previous
                    </button>
                    <button
                      className={s.primary}
                      disabled={
                        busy ||
                        conflict ||
                        !decision ||
                        !!invalidScore ||
                        !!invalidReason ||
                        (!delivered.length && decision?.kind !== "abstain") ||
                        (!!question.unavailable && decision.kind !== "abstain")
                      }
                      type="submit"
                    >
                      {busy ? "Saving…" : finalQuestion ? "Save & finish" : "Save & next"}
                    </button>
                    <button
                      className={s.textButton}
                      disabled={busy}
                      type="button"
                      onClick={() => void end()}
                    >
                      End session
                    </button>
                  </div>
                  <p className={s.small}>
                    End session keeps your draft but does not save it as an answer. You can continue
                    later in a new session.
                  </p>
                </div>
              </form>
              {question.answer && question.crossPass && (
                <details
                  onToggle={(event) => {
                    if (event.currentTarget.open) void loadTargets();
                  }}
                >
                  <summary>Apply saved answer to other observations</summary>
                  <p className={s.small}>
                    This works only for observations of the same criterion and build that you
                    already answered in this review. It replaces their saved answers.
                  </p>
                  <p className={r.savedAnswer}>
                    Saved answer to apply: <strong>{answerText(question.answer, question)}</strong>
                  </p>
                  {!unchangedAnswer && (
                    <p className={s.small}>
                      Your draft differs from the saved answer. Save your changes before you apply
                      them to other observations.
                    </p>
                  )}
                  <div className={r.targetList}>
                    {targets.map((target) => (
                      <label key={target.id}>
                        <input
                          type="checkbox"
                          disabled={
                            busy ||
                            conflict ||
                            !unchangedAnswer ||
                            (!selected.includes(target.id) && selected.length >= 50)
                          }
                          checked={selected.includes(target.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, target.id]
                                : selected.filter((id) => id !== target.id),
                            )
                          }
                        />
                        <span>
                          Observation {target.evidence.passes[0]?.number ?? "unavailable"}
                          <small>Current answer: {answerText(target.answer, target)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {targetsLoading && (
                    <p className={s.small} role="status">
                      Checking previously answered observations…
                    </p>
                  )}
                  {!targetsLoading && !targets.length && (
                    <p className={s.small}>
                      {targetPage * 25 < acknowledgedTargetCount
                        ? "None of the answered questions checked so far match."
                        : "You haven’t answered other observations of this criterion yet."}
                    </p>
                  )}
                  {targetPage * 25 < acknowledgedTargetCount && (
                    <button
                      className={s.secondary}
                      disabled={targetsLoading || busy}
                      onClick={() => void loadTargets(targetPage)}
                    >
                      Check more answered questions
                    </button>
                  )}
                  {targets.length > 0 && (
                    <p className={s.small}>
                      {selected.length} {selected.length === 1 ? "observation" : "observations"}{" "}
                      selected for replacement.
                    </p>
                  )}
                  <button
                    className={s.secondary}
                    disabled={
                      busy ||
                      targetsLoading ||
                      progress?.state !== "active" ||
                      conflict ||
                      !unchangedAnswer ||
                      !selected.length
                    }
                    onClick={() => void apply()}
                  >
                    Apply to selected observations
                  </button>
                </details>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
