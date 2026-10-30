/** The reasoning efforts that a request can select, from the most reasoning to none. */
export const REASONING_EFFORTS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** An explicit request policy; omission uses the frozen transport's reasoning selection. */
export type ModelRequestReasoning =
  { kind: "provider_default" } | { kind: "effort"; effort: ReasoningEffort };
