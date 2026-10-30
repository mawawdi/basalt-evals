import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import type { RunQuote } from "../../model-client/src/quote.js";
import type {
  BatchRequestConfiguration,
  JudgmentPresentation,
  BatchDecision,
} from "../../eval-authoring/src/batch-judgment.js";
import type { AddressedToEvaluator } from "../../eval-authoring/src/criterion-response.js";
import type {
  AuthoredRegion,
  EvidenceSubstitutionKind,
  LabelRule,
  RunJudgmentBatch,
} from "./execution.js";
import type { EvidenceUseReport } from "../../experiments/src/evidence-use.js";

/** Retained evidence as captured, or one diagnostic replacement of its rendered part. */
export type EvidenceCondition = "original" | EvidenceSubstitutionKind;
/**
 * Conditions a retained-evidence assessment can apply. Unrelated-image controls need the shared
 * study views of registered research, so they are not offered here.
 */
export const ASSESSMENT_CONDITIONS = [
  "original",
  "blank",
  "facts_and_source",
  "text_only",
  "region_removed",
  "region_sham",
  "region_black",
  "donor_swap",
  "reversed",
  "shuffled",
  "phase_shuffled",
  "repeated_frame",
  "canary",
] as const satisfies readonly EvidenceCondition[];
export const EVIDENCE_CONDITION_LABELS: Record<EvidenceCondition, string> = {
  original: "original evidence",
  blank: "blank images",
  facts_and_source: "behavior and code only",
  text_only: "prompt and criteria only",
  region_removed: "region removed",
  region_sham: "sham region removed",
  region_black: "region in black",
  donor_swap: "swapped images",
  unrelated: "unrelated images",
  reversed: "reversed frames",
  shuffled: "shuffled frames",
  phase_shuffled: "shuffled within phases",
  repeated_frame: "one frame repeated",
  canary: "note to the judge",
};
/** The question that each control asks. A control is a diagnostic, never an accuracy measure. */
export type ControlLevel = "dependence" | "localization" | "direction" | "order" | "text";
export const CONTROL_LEVELS: Record<EvidenceSubstitutionKind, ControlLevel> = {
  blank: "dependence",
  facts_and_source: "dependence",
  text_only: "dependence",
  region_removed: "localization",
  region_sham: "localization",
  region_black: "localization",
  donor_swap: "direction",
  unrelated: "direction",
  reversed: "order",
  shuffled: "order",
  phase_shuffled: "order",
  repeated_frame: "order",
  canary: "text",
};

/**
 * The frozen plan of a sensitivity test. A person writes every field before any judgment.
 * Basalt takes no part of it from a model.
 */
export interface SensitivityPlan {
  /** Judgments of the original evidence for each observation. Two or more measure the noise floor. */
  originalRepeats: number;
  /** Preregistered: whether labels move with the images under order and content controls. */
  labelRule: LabelRule;
  /** Authored decisive and sham regions. A criterion without one has no region controls. */
  regions: AuthoredRegion[];
  /** The reviewer whose answers select label-discordant donors, or null. */
  expertReviewer: string | null;
  /**
   * Twin builds that differ from a selected build only by the same in-scene note to the judge,
   * or null. Each selected build has at most one twin, and a twin is never a selected build.
   */
  canary: {
    pairs: Array<{ subjectId: string; twinSubjectId: string }>;
    /** The answer that the note asks the judge to give. */
    requestedVerdict: "satisfied" | "violated";
    /** The exact text of the note, for the record. */
    note: string;
  } | null;
  /**
   * False: the test judges only development observations. True: the person authorizes a look
   * at withheld observations too, and Basalt records it as a look at the holdout.
   */
  holdoutLook: boolean;
}

/** Immutable provenance; an assessment references evidence rather than manufacturing new captures. */
export interface EvidenceSet {
  id: string;
  operationId: string;
  manifestHash: string;
  /** The revision whose criteria the judge reads. */
  revisionId: string;
  subjectId: string;
  captureId: string;
  captureReceiptHash: string;
  /** The receipt of the donor or twin capture, or null. */
  donorReceiptHash: string | null;
  evidenceHash: string;
  sourceHash: string;
  rubricHash: string;
  criterionIds: string[];
  materialHash: string;
  presentation: JudgmentPresentation;
  condition: EvidenceCondition;
}
export interface AssessmentSelection {
  operationId: string;
  /** The revision whose criteria the judge checks. It is the revision of the source run. */
  revisionId: string;
  /**
   * Builds of one evaluation. A reassessment has exactly one. A sensitivity test pools one or
   * more, and its exact tests count builds, so one build cannot show an effect.
   */
  subjectIds: string[];
  modelId: string;
  presentation: JudgmentPresentation;
  /** Ordinary reassessment uses only `original`; a sensitivity test adds diagnostic conditions. */
  conditions: EvidenceCondition[];
  /** Null for a reassessment. */
  sensitivity: SensitivityPlan | null;
}
/** Expert answers that made a donor label-discordant for one criterion. */
export interface DonorExpertAnswers {
  reviewer: string;
  target: { verdict: "satisfied" | "violated"; answerId: string };
  donor: { verdict: "satisfied" | "violated"; answerId: string };
}
export interface AssessmentUnit {
  id: string;
  /** The build of the capture: the cluster of the exact tests. */
  subjectId: string;
  captureId: string;
  condition: EvidenceCondition;
  /** The repeat of the original evidence, from 1. Every control has 1. */
  repeat: number;
  /** Donor-swap units only. */
  expert: DonorExpertAnswers | null;
  criterionIds: string[];
  evidenceSetId: string | null;
  unavailable: string | null;
  batch: RunJudgmentBatch;
}
export interface AssessmentPreview {
  sourceJudgingSetups: Array<{ modelId: string; presentation: string }>;
  /** Candidate policy is inspectable only; dispatched requests keep the frozen original selection. */
  packetPolicyHash: string;
  evidencePackets: Array<{
    captureId: string;
    evidenceSetId: string | null;
    dispatchedImages: number;
    proposedImages: number | null;
    manifest: import("../../studio-runner/src/evidence-packet.js").EvidencePacketManifest | null;
    error: string | null;
  }>;
  proposedPacketWork: import("../../model-client/src/quote.js").QuotedModelWork[];
  id: string;
  selection: AssessmentSelection;
  /** Controls that the plan asked for but that have no data, with the reason. */
  unavailableControls: UnavailableControl[];
  /** Withheld observations of the selected builds that the test leaves out without a holdout look. */
  excludedCaptureIds: string[];
  sourceManifestHash: string;
  title: string;
  configuration: BatchRequestConfiguration;
  units: AssessmentUnit[];
  quote: RunQuote;
  budget: import("./execution.js").BudgetSummary;
}
export interface UnavailableControl {
  condition: EvidenceSubstitutionKind;
  /** Null when the reason applies to every observation. */
  captureId: string | null;
  criterionIds: string[];
  reason: string;
}
export interface AssessmentPlan {
  createdAt: string;
  gradingSemanticsHash: string;
  id: string;
  previewId: string;
  inputHash: string;
  implementationCommit: string;
  buildIdentityHash: string;
  model: ModelSnapshot;
  ceilingUsd: number;
}
export interface AssessmentProgress {
  operationId: string;
  previewId: string;
  title: string;
  /** The time of the launch. Lists show work newest first by this time. */
  startedAt: string;
  sourceOperationId: string;
  subjectIds: string[];
  planned: number;
  completed: number;
  incomplete: number;
  inFlight: string | null;
  finished: boolean;
  stopped: boolean;
  error: string | null;
}
/** Keep every planned answer visible, even when cancellation ends work before a unit is recorded. */
export function assessmentOutcomeCounts(progress: AssessmentProgress) {
  const remaining = progress.planned - progress.completed - progress.incomplete;
  if (remaining < 0) throw new Error("Assessment outcome accounting exceeds its plan");
  return {
    available: progress.completed,
    incomplete: progress.incomplete,
    remaining,
    unavailable: progress.incomplete + remaining,
    stoppedRemaining: progress.stopped ? remaining : 0,
  };
}

export interface AssessmentResult {
  operationId: string;
  unitId: string;
  evidenceSetId: string;
  treatmentIdentity: string;
  decisions: BatchDecision[];
  /** The report of the guard. Null when no model read the build output. */
  addressedToEvaluator: AddressedToEvaluator | null;
  responseHashes: string[];
  costUsd: number | null;
}

export interface AssessmentReport {
  criteria: Array<{ id: string; statement: string }>;
  plan: AssessmentPlan;
  selection: AssessmentSelection;
  /** The selected builds with the titles that the evidence view of the source run uses. */
  builds: Array<{ id: string; title: string }>;
  planned: number;
  results: Array<{
    unitId: string;
    subjectId: string;
    captureId: string;
    condition: EvidenceCondition;
    repeat: number;
    substitution: RunJudgmentBatch["substitution"];
    pass: number;
    criterionIds: string[];
    result: AssessmentResult | null;
    error: string | null;
  }>;
  spending: {
    billedUsd: number;
    reservedUsd: number;
    availableUsd: number;
    pendingBilling: boolean;
    uncertainBilling: boolean;
    uncertainRequests: number;
  };
  lineage: import("./launch.js").LineageSpending;
  limitation: string;
  /** Null for a reassessment. */
  evidenceUse: EvidenceUseReport | null;
}

export function decodeAssessmentProgress(value: unknown): AssessmentProgress {
  const row = value as AssessmentProgress;
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join(",") !==
      "completed,error,finished,inFlight,incomplete,operationId,planned,previewId,sourceOperationId,startedAt,stopped,subjectIds,title" ||
    !Array.isArray(row.subjectIds) ||
    !row.subjectIds.length ||
    new Set(row.subjectIds).size !== row.subjectIds.length ||
    ![row.operationId, row.sourceOperationId, ...row.subjectIds].every(
      (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,100}$/u.test(id),
    ) ||
    !/^[a-f0-9]{64}$/u.test(row.previewId) ||
    typeof row.title !== "string" ||
    typeof row.startedAt !== "string" ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    typeof row.finished !== "boolean" ||
    typeof row.stopped !== "boolean" ||
    (row.error !== null && typeof row.error !== "string") ||
    (row.inFlight !== null && typeof row.inFlight !== "string") ||
    ![row.planned, row.completed, row.incomplete].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    row.completed + row.incomplete > row.planned ||
    (row.finished && (row.inFlight !== null || row.completed + row.incomplete !== row.planned))
  )
    throw new Error("Invalid assessment progress record");
  return row;
}
