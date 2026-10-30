"use client";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReviewerProfile } from "../../../../../dist/packages/contracts/src/review.js";
import { action, message } from "../../components/api";
import { ReviewerPicker } from "../../components/reviewer-picker";
import { statementText } from "../../components/result-display";
import { Dialog, Notice } from "../../components/ui";
import s from "../../components/workbench.module.css";

/** The most characters of the reason of a mark or a retirement. */
const REASON_CHARS = 300;

/**
 * A person marks a saved build as a known good or a known bad build for the criteria that they
 * choose. The mark names the reviewer profile of the person and one reason. It never changes an
 * answer.
 */
export function KnownBuildMark({
  evaluationId,
  operationId,
  subjectId,
  title,
  criteria,
}: {
  evaluationId: string;
  operationId: string;
  subjectId: string;
  title: string;
  /** The authored criteria of the build, as the run checked them. */
  criteria: Array<{ id: string; text: string }>;
}) {
  const router = useRouter();
  const fieldId = useId();
  const working = useRef(false);
  const [open, setOpen] = useState(false),
    [expectation, setExpectation] = useState<"met" | "not_met">("met"),
    [chosen, setChosen] = useState<string[]>([]),
    [reviewer, setReviewer] = useState<ReviewerProfile | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function save() {
    if (working.current || !reviewer || !chosen.length || !reason.trim()) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action("/api/known-builds", "mark_known_build", {
        evaluationId,
        operationId,
        subjectId,
        criterionIds: chosen,
        expectation,
        reviewerId: reviewer.id,
        reason: reason.trim(),
      });
      setSaved(true);
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={s.secondary}
        type="button"
        aria-label={`Mark ${title} as known good or known bad`}
        onClick={() => setOpen(true)}
      >
        {saved ? `${title} marked · mark again` : `${title}: mark as known good / known bad`}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Mark ${title}`}>
        {error && <Notice>{error}</Notice>}
        {/* The reviewer picker has fixed element IDs, so only an open dialog renders it. */}
        {open && (
          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p>
              Each new version of this evaluation must give the same answers for this build before a
              new benchmark can start. A known build never changes an answer.
            </p>
            <fieldset>
              <legend>This build is</legend>
              <div className={s.selectionGrid}>
                {(
                  [
                    ["met", "A known good build", "It meets the chosen criteria"],
                    ["not_met", "A known bad build", "It fails the chosen criteria"],
                  ] as const
                ).map(([value, name, detail]) => (
                  <label className={s.choice} key={value}>
                    <input
                      type="radio"
                      name={fieldId + "-expectation"}
                      disabled={busy}
                      checked={expectation === value}
                      onChange={() => setExpectation(value)}
                    />
                    <span>
                      {name}
                      <small>{detail}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Criteria</legend>
              <div className={s.selectionGrid}>
                {criteria.map((criterion) => (
                  <label className={s.choice} key={criterion.id}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={chosen.includes(criterion.id)}
                      onChange={(event) =>
                        setChosen(
                          event.target.checked
                            ? [...chosen, criterion.id]
                            : chosen.filter((id) => id !== criterion.id),
                        )
                      }
                    />
                    <span>{statementText(criterion.text)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <ReviewerPicker value={reviewer} disabled={busy} onChange={setReviewer} />
            <div className={s.field}>
              <label htmlFor={fieldId + "-reason"}>Reason</label>
              <textarea
                id={fieldId + "-reason"}
                disabled={busy}
                maxLength={REASON_CHARS}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <small>One sentence about what you saw in this build.</small>
            </div>
            <button
              className={s.primary}
              type="submit"
              disabled={busy || !reviewer || !chosen.length || !reason.trim()}
            >
              {busy ? "Saving…" : "Save known build"}
            </button>
            {!chosen.length && <p role="status">Choose at least one criterion to continue.</p>}
          </form>
        )}
      </Dialog>
    </>
  );
}

/** A person retires a known build. Basalt keeps the mark, and the build gates no new version. */
export function KnownBuildRetire({ knownBuildId, title }: { knownBuildId: string; title: string }) {
  const router = useRouter();
  const fieldId = useId();
  const working = useRef(false);
  const [open, setOpen] = useState(false),
    [reviewer, setReviewer] = useState<ReviewerProfile | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function retire() {
    if (working.current || !reviewer || !reason.trim()) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action("/api/known-build-retirements", "retire_known_build", {
        knownBuildId,
        reviewerId: reviewer.id,
        reason: reason.trim(),
      });
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button className={s.secondary} type="button" onClick={() => setOpen(true)}>
        Retire
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Retire ${title}`}>
        {error && <Notice>{error}</Notice>}
        {open && (
          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              void retire();
            }}
          >
            <p>
              Basalt keeps the mark and its reason, but this build no longer blocks any version of
              the evaluation.
            </p>
            <ReviewerPicker value={reviewer} disabled={busy} onChange={setReviewer} />
            <div className={s.field}>
              <label htmlFor={fieldId + "-reason"}>Reason</label>
              <textarea
                id={fieldId + "-reason"}
                disabled={busy}
                maxLength={REASON_CHARS}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <button
              className={s.primary}
              type="submit"
              disabled={busy || !reviewer || !reason.trim()}
            >
              {busy ? "Saving…" : "Retire known build"}
            </button>
          </form>
        )}
      </Dialog>
    </>
  );
}
