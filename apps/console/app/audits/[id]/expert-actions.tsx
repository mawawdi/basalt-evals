"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ReviewerPicker } from "../../components/reviewer-picker";
import type {
  ReviewerProfile,
  ReviewProgress,
} from "../../../../../dist/packages/contracts/src/review.js";
import { action, message } from "../../components/api";
import { Notice } from "../../components/ui";
import s from "../../components/workbench.module.css";

/**
 * A second reviewer answers the same questions in a separate blind review. Round 2 starts
 * after both reviewers finish. Each reviewer then sees only the other answer and reason.
 */
export function ExpertActions({
  batchId,
  reviewer,
  canAddSecond,
  canStartRoundTwo,
}: {
  batchId: string;
  reviewer: ReviewerProfile;
  canAddSecond: boolean;
  canStartRoundTwo: boolean;
}) {
  const router = useRouter();
  const [second, setSecond] = useState<ReviewerProfile | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const working = useRef(false);
  // One identity for each intent, so a lost response cannot create a second review twice.
  const secondKey = useRef(crypto.randomUUID()),
    roundKey = useRef(crypto.randomUUID());
  async function run(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      working.current = false;
    }
  }
  if (!canAddSecond && !canStartRoundTwo) return null;
  return (
    <section className={s.section} aria-labelledby="expert-actions">
      <h2 id="expert-actions">{canAddSecond ? "Second reviewer" : "Round 2"}</h2>
      {error && <Notice>{error}</Notice>}
      {canAddSecond && (
        <>
          <p>
            A second person answers the same questions in a separate review, in a different order.
            Neither reviewer sees the judge’s answers or the other reviewer’s answers.
          </p>
          <p className={s.small}>
            Choose a profile other than {reviewer.displayName}. Ask the second reviewer not to open
            run results or this report before the review ends.
          </p>
          <ReviewerPicker value={second} disabled={busy} onChange={setSecond} />
          {second?.id === reviewer.id && (
            <p className={s.small} role="status">
              {reviewer.displayName} gave the first answers. Choose or create a different profile.
            </p>
          )}
          <button
            className={s.primary}
            disabled={busy || !second || second.id === reviewer.id}
            onClick={() =>
              void run(async () => {
                const created = await action<ReviewProgress>(
                  `/api/review-batches/${batchId}/second`,
                  "create_second_review",
                  { reviewer: second!.id, idempotencyKey: secondKey.current },
                );
                router.push(`/reviews/${created.id}`);
              })
            }
          >
            {busy ? "Creating review…" : "Create second review"}
          </button>
        </>
      )}
      {canStartRoundTwo && (
        <>
          <p>
            The two reviewers gave different answers to some questions. In round 2, each reviewer
            sees only the other reviewer’s answer and reason, and gives a final answer. Questions
            where they still disagree become contested.
          </p>
          <button
            className={s.primary}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await action<ReviewProgress[]>(
                  `/api/review-batches/${batchId}/round-two`,
                  "create_round_two",
                  { idempotencyKey: roundKey.current },
                );
                router.refresh();
              })
            }
          >
            {busy ? "Starting round 2…" : "Start round 2"}
          </button>
        </>
      )}
    </section>
  );
}
