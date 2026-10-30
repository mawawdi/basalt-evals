import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import type { RunQuote, RunWorkload } from "../../model-client/src/quote.js";
import type { StudioCollectionPlan, Treatment, CriterionResult } from "./index.js";
import type { SequencePlan } from "../../studio-runner/src/sequence.js";
import type {
  BatchRequestConfiguration,
  JudgmentPresentation,
} from "../../eval-authoring/src/batch-judgment.js";
import type { JudgeGrouping, JudgeSettings } from "./judge-settings.js";

/** Canonical execution data, independent of service return types. */
export interface SpendLedgerEntry {
  requestId: string;
  stage: string;
  reservedUsd: number;
  billedUsd: number | null;
  status: "pending" | "billed";
  requestHash: string;
}

export interface SpendLedgerState {
  schema: "basalt-evals/spend-ledger";
  operationId: string;
  contextHash: string;
  authorizations: SpendAuthorization[];
  entries: SpendLedgerEntry[];
}

export interface SpendAuthorization {
  quoteHash: string;
  ceilingUsd: number;
}

export interface AuthoringAction {
  id: string;
  operationId: string;
  /** `explanation` sends the one request of Explain failures for an evaluation version. */
  stage: "preparation" | "controls" | "explanation";
  draftId: string;
  revisionId: string | null;
  quoteId: string;
  ceilingUsd: number;
}

export interface AuthoringProgress {
  action: AuthoringAction;
  state: "queued" | "running" | "completed" | "incomplete";
  stopped: boolean;
  resultHash: string | null;
  error: string | null;
}

export interface BudgetSummary {
  history: { count: number; minimumUsd: number; medianUsd: number; maximumUsd: number } | null;
  note: string;
}

export interface SavedExperimentRunQuote {
  schema: "basalt-evals/saved-run-quote";
  kind: "experiment";
  id: string;
  selection: { experimentId: string; gradingModelId: string; componentQuoteIds: string[] };
  quote: RunQuote;
  humanWorkload: {
    questions: number;
    unit: "criterion_per_capture";
    automaticAssignment: "registered_protocol";
  };
}

export interface StartRunRequest {
  quoteId: string;
  ceilingUsd: number;
  idempotencyKey: string;
}

export type RunStage =
  | "preparation"
  | "controls"
  | "builder"
  | "local_verification"
  | "public_development"
  | "seal"
  | "review"
  | "selection"
  | "final_capture"
  | "grading"
  | "judgment"
  | "repair"
  | "report";

export interface RunOperationEvent {
  schema: "basalt-evals/run-operation-event";
  id: string;
  sequence: number;
  previousHash: string | null;
  kind:
    | "started"
    | "completed"
    | "failed"
    | "incomplete"
    | "paused"
    | "provider_paused"
    | "not_dispatched"
    | "stop_requested"
    | "resumed";
  stage: RunStage | null;
  unitId: string | null;
  artifactHashes: string[];
  reason: string | null;
  at: string;
}

/** The part of the execution that a provider pause blocks. A request failure never pauses. */
export type ProviderPauseScope = "account" | "model" | "persistent";

/**
 * The saved cause of a `provider_paused` event. The event binds `hashJson(record)`.
 * - `dependency`: the model and endpoint identity of a model or persistent pause, or null for
 *   an account pause.
 * - `failureId`: the failure record of the pause.
 * - `ordinal`: the request ordinal of the rejected request in its stage, or null when the
 *   pause of another unit held this unit before its next request.
 */
export interface PauseRecord {
  scope: ProviderPauseScope;
  dependency: string | null;
  errorClass: string;
  failureId: string;
  ordinal: number | null;
}

/** One planned unit of a run, for example `builder` with its treatment ID. */
export interface RunUnit {
  stage: RunStage;
  unitId: string;
}

export interface RunOperationStatus {
  /** The hash of the spending authorizations. A new authorization raises the limit. */
  authorizationHash: string;
  manifest: RunOperationManifest;
  events: RunOperationEvent[];
  /** Units that started and have no terminal event, in start order. Several can run at once. */
  inFlightUnits: RunUnit[];
  /** The saved record of each `provider_paused` event, by the hash that the event binds. */
  pauseRecords: Record<string, PauseRecord>;
  completedUnits: string[];
  finished: boolean;
  measurementComplete: boolean;
  stopped: boolean;
  uncertainBilling: boolean;
  pendingBilling: boolean;
  billedUsd: number;
  reservedUsd: number;
  uncertainRequests: number;
  availableUsd: number;
  /**
   * One outcome for each code check and for each judge sample. `insufficient` is the answer
   * "not enough evidence" of the judge. It is an answer, not an absent result. `incomplete` is
   * a code check that could not decide.
   */
  criterionOutcomes: Array<{
    cellId: string;
    criterionId: string;
    outcome: CriterionResult["outcome"] | "scored" | "insufficient";
    decisionAuthority: "deterministic" | "model";
    evidence: string[];
  }>;
}

export interface RunOperationReport {
  schema: "basalt-evals/run-operation-report";
  operationId: string;
  manifestHash: string;
  outcome: "complete" | "partial";
  units: Record<
    "builder" | "final_capture" | "grading" | "judgment",
    {
      intended: number;
      attempted: number;
      completed: number;
      failed: number;
      incomplete: number;
      /** The units of builds whose stage the run did not reach. They count apart. */
      notReached: number;
      unattempted: number;
    }
  >;
  spending: { billedUsd: number; reservedUsd: number; uncertainRequests: number };
  criterionOutcomes: RunOperationStatus["criterionOutcomes"];
  unreviewedClaims: string[];
}

export interface RunCriterionArtifact {
  schema: "basalt-evals/run-criterion-artifact";
  operationId: string;
  cellId: string;
  treatmentId: string;
  candidateHash: string;
  captureEvidenceHash: string;
  criterion: CriterionResult;
  decisionAuthority: "deterministic" | "model";
  /** A grading cell is always a code check. Judge checks are judgment batches. */
  judgment: null;
  modelResponseHash: null;
}

export interface RunJudgmentBatch {
  id: string;
  captureCellId: string;
  /** The revision whose criteria the judge reads. */
  revisionId: string;
  /**
   * Identical requests for the same criteria and observation share one sample group. Each
   * sample, from 1, is its own batch with its own ledger entry.
   */
  sampleGroupId: string;
  sample: number;
  /** How the run put criteria in requests. A `per_criterion` batch has one criterion. */
  grouping: JudgeGrouping;
  criterionIds: string[];
  presentation: JudgmentPresentation;
  configuration: BatchRequestConfiguration;
  substitution: EvidenceSubstitution | null;
}

/**
 * Diagnostic replacements of the evidence that a judge reads. Each one is a control, never an
 * observation, and its answers never count as accuracy.
 *
 * - Dependence: `blank` keeps each frame slot with a blank image. `facts_and_source` removes the
 *   frames and keeps the runtime facts and the source. `text_only` keeps only the task text and
 *   the criteria.
 * - Localization: `region_removed` fills the authored decisive region with pixels from a frame of
 *   the same view before the action. `region_sham` fills an equal authored region in the same way.
 *   `region_black` fills the decisive region with black, as a check of the fill artifact.
 * - Direction: `donor_swap` shows the frames of a build whose expert answer differs.
 *   `unrelated` shows the frames of another evaluation and belongs to registered research.
 * - Order and content: `reversed`, `shuffled`, `phase_shuffled` and `repeated_frame`.
 * - Text: `canary` judges a twin build that differs only by an in-scene note to the judge.
 */
const EVIDENCE_SUBSTITUTION_KINDS = [
  "blank",
  "facts_and_source",
  "text_only",
  "region_removed",
  "region_sham",
  "region_black",
  "donor_swap",
  "unrelated",
  "reversed",
  "shuffled",
  "phase_shuffled",
  "repeated_frame",
  "canary",
] as const;
export type EvidenceSubstitutionKind = (typeof EVIDENCE_SUBSTITUTION_KINDS)[number];
/** Controls that show the evidence of another capture. */
export const DONOR_SUBSTITUTION_KINDS = [
  "donor_swap",
  "unrelated",
  "canary",
] as const satisfies readonly EvidenceSubstitutionKind[];
export const REGION_SUBSTITUTION_KINDS = [
  "region_removed",
  "region_sham",
  "region_black",
] as const satisfies readonly EvidenceSubstitutionKind[];
/** Order and content controls: each one states the preregistered label rule. */
export const LABEL_RULE_SUBSTITUTION_KINDS = [
  "reversed",
  "shuffled",
  "phase_shuffled",
  "repeated_frame",
  "donor_swap",
] as const satisfies readonly EvidenceSubstitutionKind[];

/**
 * A preregistered choice for the order and content controls. With `labels_keep_slots`, each
 * image label and frame interval stay in their slot, so they disagree with the pixels. With
 * `labels_follow_images`, the whole label and the whole interval move with their image. Only
 * the image number changes, because it states the position in the request.
 */
export const LABEL_RULES = ["labels_keep_slots", "labels_follow_images"] as const;
export type LabelRule = (typeof LABEL_RULES)[number];

/** Native pixels of one rendered frame. */
export interface PixelRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** The frames that a region applies to: one phase capture, or the sequence frames of one actor. */
export type RegionView = { kind: "capture"; captureId: string } | { kind: "actor"; actor: string };
/**
 * A decisive region that a person authored for one criterion and one view. Basalt never takes a
 * region from a judge's citation. The sham region has the same width and height and does not
 * overlap. For a capture view, `fillCaptureId` names a phase capture of the same view before the
 * action. For an actor view it is null: the fill is the last frame of that actor before the first
 * measured action.
 */
export interface AuthoredRegion {
  criterionId: string;
  view: RegionView;
  decisive: PixelRectangle;
  sham: PixelRectangle;
  fillCaptureId: string | null;
}

/** One control. Fields that a control kind does not use are null. */
export interface EvidenceSubstitution {
  kind: EvidenceSubstitutionKind;
  /** The capture whose evidence replaces the target: donor controls only. */
  donorCaptureCellId: string | null;
  /** The authored region: region controls only. */
  region: AuthoredRegion | null;
  /** The preregistered label rule: order and content controls only. */
  labelRule: LabelRule | null;
}

/** A rectangle of whole native pixels, inside the bounds when the caller knows them. */
export function validRectangle(
  region: PixelRectangle,
  bounds?: { width: number; height: number },
): boolean {
  return (
    typeof region === "object" &&
    region !== null &&
    !Array.isArray(region) &&
    Object.keys(region).sort().join() === "height,width,x,y" &&
    [region.x, region.y, region.width, region.height].every(Number.isSafeInteger) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width >= 1 &&
    region.height >= 1 &&
    region.x + region.width <= 8192 &&
    region.y + region.height <= 8192 &&
    (!bounds ||
      (region.x + region.width <= bounds.width && region.y + region.height <= bounds.height))
  );
}

export function rectanglesOverlap(a: PixelRectangle, b: PixelRectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const label = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/u.test(value);

/** Refuse a malformed authored region: an equal sham, no overlap, and a fill for its view. */
export function assertAuthoredRegion(region: AuthoredRegion): void {
  const view = region?.view;
  if (
    !region ||
    typeof region !== "object" ||
    Object.keys(region).sort().join() !== "criterionId,decisive,fillCaptureId,sham,view" ||
    !label(region.criterionId) ||
    !view ||
    typeof view !== "object" ||
    !(
      (view.kind === "capture" &&
        Object.keys(view).sort().join() === "captureId,kind" &&
        label(view.captureId) &&
        label(region.fillCaptureId) &&
        region.fillCaptureId !== view.captureId) ||
      (view.kind === "actor" &&
        Object.keys(view).sort().join() === "actor,kind" &&
        label(view.actor) &&
        region.fillCaptureId === null)
    ) ||
    !validRectangle(region.decisive) ||
    !validRectangle(region.sham) ||
    region.sham.width !== region.decisive.width ||
    region.sham.height !== region.decisive.height ||
    rectanglesOverlap(region.decisive, region.sham)
  )
    throw new Error(
      "An authored region needs a view, a fill frame for that view, and an equal sham region that does not overlap the decisive region",
    );
}

/** Each control kind uses exactly its own fields. */
export function assertEvidenceSubstitution(value: EvidenceSubstitution): void {
  const kind = value?.kind;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "donorCaptureCellId,kind,labelRule,region" ||
    !(EVIDENCE_SUBSTITUTION_KINDS as readonly unknown[]).includes(kind) ||
    (DONOR_SUBSTITUTION_KINDS as readonly string[]).includes(kind) !==
      (typeof value.donorCaptureCellId === "string") ||
    (value.donorCaptureCellId !== null && typeof value.donorCaptureCellId !== "string") ||
    (REGION_SUBSTITUTION_KINDS as readonly string[]).includes(kind) !== (value.region !== null) ||
    (LABEL_RULE_SUBSTITUTION_KINDS as readonly string[]).includes(kind) !==
      (LABEL_RULES as readonly unknown[]).includes(value.labelRule) ||
    (value.labelRule !== null && !(LABEL_RULES as readonly unknown[]).includes(value.labelRule))
  )
    throw new Error("Invalid evidence control");
  if (value.region) assertAuthoredRegion(value.region);
}

export type RunView = {
  id: string;
  partition: "development" | "withheld";
  plan: StudioCollectionPlan;
  sequence: Pick<
    SequencePlan,
    "scenarioId" | "requiredTransitions" | "camera" | "viewport" | "maximumGapMs" | "frameBudget"
  > | null;
};

/**
 * The place of a frozen evaluation in its staged evaluation. An evaluation without stages has
 * one stage. Each stage is its own evaluation of the run.
 */
interface RunEvalStage {
  /** The revision of stage 1. The library and the catalog know the evaluation by it. */
  firstRevisionId: string;
  /** The stage number, from 1. */
  index: number;
  count: number;
  /** The authored prompts of the earlier stages. The builder of this stage sees them. */
  earlierPrompts: string[];
  /** The code checks of this stage that each observation must pass before the next stage. */
  gateCriterionIds: string[];
}

export interface RunEvalReference {
  id: string;
  draftId: string;
  taskId: string;
  publicContentHash: string;
  rubricHash: string;
  controlSetHash: string | null;
  validationRecordHash: string;
  requiredCriterionIds: string[];
  views: RunView[];
  stage: RunEvalStage;
}

export interface RunSubject {
  id: string;
  evalId: string;
  kind: "generated" | "retained" | "control" | "repair";
  builder: Treatment | null;
  sourceId: string | null;
  parentSourceId: string | null;
  publicFeedbackId: string | null;
  /** The stage of the evaluation of the subject, from 1. */
  stageIndex: number;
  /**
   * The build of the stage before, with the same model, tool set and repetition. The build of
   * this subject starts from its sealed source. Null for stage 1.
   */
  parentSubjectId: string | null;
}

interface RunGate {
  id: string;
  kind: "review" | "selection";
  requires: string[];
}

export interface RunOperationManifest {
  schema: "basalt-evals/run-operation-manifest";
  id: string;
  inputHash: string;
  evals: RunEvalReference[];
  subjects: RunSubject[];
  gradingMode: GradingMode;
  gates: RunGate[];
  protocol: {
    kind: "detector_calibration" | "repair_discovery" | "matched_repair" | "harness_effectiveness";
    hash: string;
    registrationId: string;
    subjectBindings: Record<string, string>;
  } | null;
  quoteId: string;
  quoteSelectionId: string | null;
  quoteHash: string;
  workloadCeilingUsd: number;
  checkingCeilingUsd: number;
  implementationCommit: string;
  buildIdentityHash: string;
  connectorArtifactHash: string;
  modelSnapshots: ModelSnapshot[];
  /**
   * The most requests that the run sends to each model at the same time, with one value for
   * each model snapshot. The freeze copies the values from the Models page.
   */
  modelConcurrency: Record<string, number>;
  selectedModelIds: string[];
  selectedHarnessIds: string[];
  captureCells: Array<{
    id: string;
    treatmentId: string;
    viewId: string;
    pass: number;
    partition: "development" | "withheld";
    requires: string[];
  }>;
  gradingCells: Array<{
    id: string;
    captureCellId: string;
    criterionId: string;
    method: "deterministic";
  }>;
  judgmentBatches: RunJudgmentBatch[];
  unreviewedClaims: string[];
  ceilingUsd: number;
  planned: Omit<RunWorkload, "modelWork">;
}

/**
 * Which checks a run makes on each observation. `all` makes code checks and judge checks.
 * `code` makes only code checks, so it needs no judge model. `none` only observes.
 */
type GradingMode = "all" | "code" | "none";

export interface EvalRunSelection {
  captureScope: "final" | "public_development";
  publicFeedbackId: string | null;
  sourceIds: string[];
  parentSourceId: string | null;
  gradingMode: GradingMode;
  continuingOperationId: string | null;
  revisionId: string;
  validationRecordHash: string;
  builderModelIds: string[];
  gradingModelId: string | null;
  judgeSettings: JudgeSettings;
  harnessIds: string[];
  repetitions: number;
  nativeCaptureRepetitions: number;
}

export interface SavedEvalRunQuote {
  schema: "basalt-evals/saved-run-quote";
  kind: "eval";
  id: string;
  selection: EvalRunSelection;
  quote: RunQuote;
}

/**
 * A run of one or more stages of a staged evaluation from saved builds. It has one eval quote
 * for each stage that it holds, in stage order and without a gap. The builds of its first stage
 * start from saved sources. Each later build continues the build of the stage before it.
 */
export interface SavedStageRunQuote {
  schema: "basalt-evals/saved-run-quote";
  kind: "stages";
  id: string;
  /** The revision of stage 1. The library and the catalog know the evaluation by it. */
  firstRevisionId: string;
  componentQuoteIds: string[];
  quote: RunQuote;
}

export interface RunStart {
  operationId: string;
  requestHash: string;
  inputHash: string;
  request: StartRunRequest;
  state: "queued" | "freezing" | "running" | "incomplete";
  stopped: boolean;
  error: string | null;
}

export interface LaunchSelection {
  sources: Array<{ kind: "draft" | "evaluation"; id: string }>;
  objective: "evaluate" | "prepare";
  builderModelIds: string[];
  harnessIds: string[];
  repetitions: number;
  capturePasses: number;
  /** Required to evaluate. A person saves a default on the Models page. */
  gradingModelId: string | null;
  judgeSettings: JudgeSettings;
  /** Required when the sources include a draft. It prepares the draft. */
  preparationModelId: string | null;
  /** Optional. It writes coverage notes about each prepared draft for a person. */
  coverageModelId: string | null;
  capacity: "interactive" | "flex";
}

export interface LaunchPreview {
  id: string;
  title: string;
  evaluations: Array<{
    draftId: string;
    title: string;
    revisionId: string | null;
    preparation: RunQuote | null;
  }>;
  selection: LaunchSelection;
  models: ModelSnapshot[];
  studio: {
    studioVersion: string;
    connectorSourceHash: string;
    connectorArtifactHash: string;
    environmentHash: string;
  };
  run: import("./suites.js").SavedSelectionRunQuote | null;
  budget: BudgetSummary;
}

export interface EvaluationWorkflow {
  id: string;
  previewId: string;
  title: string;
  inputHash: string;
  draftIds: string[];
  selection: LaunchSelection;
  ceilingUsd: number;
  authorizationHash: string;
  requestHash: string;
  phase: "readiness" | "preparation" | "execution" | "complete";
  state: "active" | "attention" | "stopped" | "complete";
  blocker: string | null;
  revisions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
