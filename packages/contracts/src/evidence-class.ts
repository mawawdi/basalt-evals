/**
 * The human rubric author sets the evidence class of a criterion. A model can judge rendered
 * frames only for appearance. Timing, motion and causality need signed runtime facts. This
 * module imports nothing, so the console can use it in the browser.
 */
export const EVIDENCE_CLASSES = ["appearance", "timing", "motion", "causality"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return (EVIDENCE_CLASSES as readonly unknown[]).includes(value);
}
