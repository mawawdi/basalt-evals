export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
  limit: number;
}

/** Human-facing labels; authority and lifecycle values remain explicit in their contracts. */
export function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    verified: "Met",
    rejected: "Not met",
    split: "Split",
    insufficient: "Not enough evidence",
    missing: "Unavailable",
    incomplete: "Incomplete",
    scored: "Scored",
    active: "In progress",
    attention: "Needs attention",
    stopped: "Stopped",
    partial: "Results incomplete",
    complete: "Complete",
    not_reached: "Not reached",
    archived: "Archived",
    draft: "Draft",
    ready: "Ready",
    checked: "Ready",
    needs_validation: "Needs input",
    direct: "Same test conditions",
    descriptive: "Conditions differ",
    unsupported: "Cannot compare",
    historical: "Historical record",
    submitted: "Submitted",
    completed: "Complete",
    ended: "Ended early",
    time_exhausted: "Time limit reached",
  };
  return labels[value] ?? value;
}
export interface EvaluationSummary {
  id: string;
  evaluationId: string | null;
  archived: boolean;
  kind: "draft" | "evaluation";
  draftId: string;
  title: string;
  description: string;
  /** The number of stages. An evaluation without stages has one stage. */
  stages: number;
  readiness: "draft" | "needs_validation" | "ready" | "checked";
  validationRecordHash: string | null;
  qualitative: boolean;
  reason: string | null;
  updatedAt: string;
}
/** An unfinished preparation is launched from its authored inputs, never an unchecked runner. */
export function evaluationLaunchSource(source: EvaluationSummary): EvaluationSummary {
  return source.kind === "evaluation" &&
    source.readiness !== "ready" &&
    source.readiness !== "checked"
    ? {
        ...source,
        id: source.draftId,
        kind: "draft",
        readiness: "draft",
        validationRecordHash: null,
      }
    : source;
}
/** A reusable evaluation follows its latest authored snapshot; runs retain exact hashes. */
export interface EvaluationLibraryEntry {
  id: string;
  draftId: string;
  revisionId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface RunSummary {
  id: string;
  title: string;
  models: string[];
  startedAt: string | null;
  state: "active" | "attention" | "stopped" | "partial" | "complete";
  phase: string;
  blocker: string | null;
  billedUsd: number | null;
  reservedUsd: number | null;
  updatedAt: string;
  evaluationId: string | null;
  draftId: string | null;
  finished: boolean;
  stopped: boolean;
  /** A person moved the run out of the default lists. Its evidence stays readable. */
  archived: boolean;
}
/** The permanent spending record of a deleted run. Its files list is empty after removal. */
export interface DeletedRun {
  operationId: string;
  title: string;
  billedUsd: number;
  deletedAt: string;
  files: string[];
}
/**
 * The answers of a set of checks. A check is one criterion of one observation: a code check,
 * or the combined answer of one judge sample group. Each check counts one time.
 */
export interface AnswerCounts {
  planned: number;
  met: number;
  rejected: number;
  /** The judge samples disagree. A split is neither met nor not met. */
  split: number;
  /** A score without an authored minimum for met. */
  scored: number;
  /** The judge answered "not enough evidence". It is an answer, not an absent result. */
  insufficient: number;
  /** Checks without an answer: not yet checked, absent or failed. */
  unavailable: number;
}
export interface ResultSummary {
  id: string;
  operationId: string;
  evaluationId: string;
  evaluationTitle: string;
  candidateId: string;
  candidateTitle: string;
  kind: "generated" | "retained" | "control" | "repair";
  /** A build of a stage that the run did not reach is `not_reached`. It never started. */
  buildState: "planned" | "running" | "ready" | "incomplete" | "not_reached";
  /**
   * Why a build of a later stage never started: its build of the stage before it, and each gate
   * check of that build that failed. No failed check means that the build before it did not
   * finish. Null for a build that the run reached.
   */
  notReached: {
    parentCandidateId: string;
    /** For example "Z.ai: GLM 5.3 Flash · Build 2". */
    parentTitle: string;
    parentStage: number;
    failedGateChecks: Array<{ cellId: string; pass: number }>;
  } | null;
  model: string;
  /** The title of the frozen tool set. Null for a build without a builder model. */
  harness: string | null;
  captures: Array<
    AnswerCounts & {
      number: number;
      state: "planned" | "collecting" | "collected" | "incomplete";
    }
  >;
  functional: AnswerCounts;
  qualitative: AnswerCounts;
  costUsd: number | null;
  toolCalls: number | null;
  elapsedMs: number | null;
  state: "active" | "complete" | "incomplete" | "not_reached";
  updatedAt: string;
}
