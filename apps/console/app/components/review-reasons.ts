import {
  REVIEW_REASON_CODES,
  REVIEW_REASON_USE,
  type ReviewDecision,
  type ReviewReasonCode,
  type ReviewReasonDraft,
} from "../../../../dist/packages/contracts/src/review.js";

/** Labels for the fixed reason codes. The codes stay the stored values. */
export const reasonLabels: Record<ReviewReasonCode, string> = {
  images_show: "The images show it",
  behavior_shows: "The recorded behavior shows it",
  code_shows: "The code shows it",
  partly_met: "Only part is met",
  evidence_missing: "Evidence is missing",
  evidence_unclear: "Evidence is unclear",
  needs_motion_or_timing: "Needs motion or timing",
  criterion_unclear: "Criterion is unclear",
  other: "Other reason",
};

/** The codes that fit a decision. Without a decision, every code shows. */
export function reasonChoices(decision: ReviewDecision | null): ReviewReasonCode[] {
  return REVIEW_REASON_CODES.filter((code) => {
    const use = REVIEW_REASON_USE[code];
    return !decision || use === "any" || (use === "cannot_tell") === (decision.kind === "abstain");
  });
}

/** Keep the sentence and drop a code that does not fit the new decision. */
export function fitReason(
  decision: ReviewDecision | null,
  reason: ReviewReasonDraft | null,
): ReviewReasonDraft | null {
  if (!reason) return null;
  return reason.code && !reasonChoices(decision).includes(reason.code)
    ? { ...reason, code: null }
    : reason;
}
