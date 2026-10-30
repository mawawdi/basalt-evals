import type { RubricAnchor, ScoreRange } from "./index.js";
import type { BatchRequestConfiguration } from "../../eval-authoring/src/batch-judgment.js";
import type { EvidenceCondition } from "./assessments.js";

/** A training review uses separate items. Its answers never count in an agreement. */
export type ReviewPurpose = "audit" | "diagnostic" | "protocol" | "training";

/** A review session ends at the first of these limits. The reviewer can start a new session. */
export const REVIEW_SESSION_LIMITS = { activeMs: 20 * 60_000, questions: 40 } as const;
/**
 * About one question in ten comes back later in the same sequence. At least `between`
 * other questions come between the two, or all later questions if there are fewer.
 */
export const REVIEW_REPEATS = { share: 0.1, between: 3 } as const;
/** A training review is short. */
export const REVIEW_TRAINING_QUESTION_LIMIT = 10;

/** The fixed reason codes. Each saved human answer, including Cannot tell, has one. */
export const REVIEW_REASON_CODES = [
  "images_show",
  "behavior_shows",
  "code_shows",
  "partly_met",
  "evidence_missing",
  "evidence_unclear",
  "needs_motion_or_timing",
  "criterion_unclear",
  "other",
] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];
/** The answers that can use a code. A definite answer is a choice or a score. */
export const REVIEW_REASON_USE: Record<ReviewReasonCode, "definite" | "cannot_tell" | "any"> = {
  images_show: "definite",
  behavior_shows: "definite",
  code_shows: "definite",
  partly_met: "definite",
  evidence_missing: "cannot_tell",
  evidence_unclear: "any",
  needs_motion_or_timing: "cannot_tell",
  criterion_unclear: "any",
  other: "any",
};
export const REVIEW_REASON_SENTENCE_LIMIT = 300;
/** A reason code and one sentence in the words of the reviewer. */
export interface ReviewReason {
  code: ReviewReasonCode;
  sentence: string;
}
/** A draft can hold an incomplete reason. A saved answer cannot. */
export interface ReviewReasonDraft {
  code: ReviewReasonCode | null;
  sentence: string;
}
/** Null when the reason is valid for the decision. Otherwise the problem in one sentence. */
export function reviewReasonProblem(decision: ReviewDecision, reason: unknown): string | null {
  if (!reason || typeof reason !== "object" || Array.isArray(reason))
    return "Choose a reason and explain it in one sentence.";
  const value = reason as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "code,sentence") return "Invalid reason fields";
  if (!REVIEW_REASON_CODES.includes(value.code as ReviewReasonCode)) return "Choose a reason.";
  const use = REVIEW_REASON_USE[value.code as ReviewReasonCode];
  if (use === "definite" && decision.kind === "abstain")
    return "This reason needs a definite answer. For Cannot tell, choose a different reason.";
  if (use === "cannot_tell" && decision.kind !== "abstain")
    return "This reason only works with Cannot tell.";
  if (typeof value.sentence !== "string") return "Explain your answer in one sentence.";
  const sentence = value.sentence.trim();
  if (!sentence) return "Explain your answer in one sentence.";
  if (value.sentence !== sentence) return "Remove the extra spaces at the start or end.";
  if (sentence.length > REVIEW_REASON_SENTENCE_LIMIT)
    return `Keep it to ${REVIEW_REASON_SENTENCE_LIMIT} characters or fewer.`;
  if (/[\r\n]/u.test(sentence) || /[.!?]\s+\p{Lu}/u.test(sentence))
    return "Write only one sentence.";
  return null;
}

export interface ReviewerProfile {
  id: string;
  displayName: string;
  createdAt: string;
}
export interface ReviewRunSelection {
  id: string;
  operationIds: string[];
  createdAt: string;
}
export interface ReviewTreatment {
  id: string;
  componentIds: string[];
  label: string;
  modelIdentity: string;
  methods: string[];
  presentation: string;
  evidenceCondition: EvidenceCondition;
  configuration: Omit<BatchRequestConfiguration, "seed">;
  /** The judge samples of each request and the grouping of criteria in requests. */
  judgeSettings: import("./judge-settings.js").JudgeSettings;
}
interface ReviewTreatmentChoice {
  operationId: string;
  treatmentId: string | null;
}
export interface ReviewAutomaticDecision {
  operationId: string;
  recordId: string;
  criterionId: string;
  artifactHash: string | null;
  configurationHash: string;
}
export interface ReviewCriterion {
  id: string;
  statement: string;
  required: boolean;
  anchors: RubricAnchor[] | null;
  scoreRange: ScoreRange | null;
  minimumPassingScore: number | null;
}
interface EvidenceImage {
  id: string;
  file: string;
  hash: string;
  mediaType: string;
  /**
   * The plan id of the phase of a snapshot, or of the scenario of a recorded sequence. A review
   * binding hashes it, so it stays an id.
   */
  context: string;
  /** The plan label of the same phase or scenario, for people. */
  label: string;
  /**
   * The plan actor whose client recorded a sequence frame. Null for a phase snapshot, and for a
   * frame whose player the runtime report does not identify.
   */
  actor: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface EvidencePass {
  id: string;
  number: number;
  evidenceHash: string;
  observations: unknown;
  images: EvidenceImage[];
  /** A routing flag for optional human review, never a verdict. */
  reviewRoute: "scene_text" | null;
}
/** Server-only bindings. Browser projections never contain storage paths or operational identity. */
export interface EvidenceItem {
  id: string;
  subjectId: string;
  viewId: string;
  partition: "development" | "withheld";
  releaseGateIds: string[];
  plannedPasses: number;
  rubricHash: string;
  rubric: string;
  sources: Array<{ id: string; path: string; file: string; hash: string }>;
  criteria: ReviewCriterion[];
  passes: EvidencePass[];
}
export interface OperationEvidence {
  operationId: string;
  manifestHash: string;
  items: EvidenceItem[];
  unavailable: Array<{ captureId: string; reason: "integrity_unavailable" }>;
}
export interface EvidenceView {
  id: string;
  plannedPasses: number;
  sources: Array<{ id: string; path: string }>;
  passes: Array<{
    id: string;
    number: number;
    observations: unknown;
    /** The measured transitions and state changes of the recorded sequence, on the clock of its frames. */
    events?: Array<{ id: string; at: string }>;
    /** The measured transitions of the recorded sequence, on the clock of its frames. */
    transitions?: Array<{ id: string; at: string }>;
    /**
     * How the Studio clock of the events maps to the host clock of the frames: host time is
     * Studio time plus offsetMs, within plus or minus uncertaintyMs. Null when the recording has
     * no clock probe. Absent without a recorded sequence.
     */
    clock?: { offsetMs: number; uncertaintyMs: number } | null;
    /** The largest number of frames of the recorded sequence in one judge check, from the plan. */
    frameBudget?: number;
    /**
     * The scenarios of the frozen plan of the observation: the label, and the horizon and the
     * time requirement of each step. A requirement quotes the rubric of a person.
     */
    scenarioPlan?: Array<{
      id: string;
      label: string;
      steps: Array<{
        id: string;
        horizonMs: number;
        requirement: { withinMs: number; quote: string } | null;
      }>;
    }>;
    images: Array<Omit<EvidenceImage, "file" | "hash">>;
  }>;
}
/** Cannot tell is an abstention. Its reason is in the answer, as for every other answer. */
export type ReviewDecision =
  | { kind: "categorical"; value: "satisfied" | "violated" }
  | { kind: "score"; value: number }
  | { kind: "abstain" };
export type ReviewVerdict = "satisfied" | "violated" | "scored" | "insufficient";
export interface ReviewUnit {
  id: string;
  treatmentId: string | null;
  automaticDecision: ReviewAutomaticDecision | null;
  operationId: string;
  manifestHash: string;
  itemId: string;
  passId: string;
  criterionId: string;
  /** Includes source, rubric, criterion and evidence, but not the reviewer. */
  binding: string;
  automatic: ReviewVerdict | null;
  automaticScore: number | null;
  method: string;
}
export interface ReviewPopulation {
  id: string;
  treatments: Array<{
    operationId: string;
    treatment: ReviewTreatment | null;
    plannedOutcomes: number;
  }>;
  operations: Array<{ id: string; manifestHash: string }>;
  evidence: OperationEvidence[];
  units: ReviewUnit[];
  plannedOutcomes: number;
  sourcePlannedOutcomes: number;
  exclusions: Array<{
    operationId: string;
    unitId: string;
    treatmentId: string | null;
    /**
     * "training": a training review used the item, so a review that counts cannot use it.
     * "labelling": a review that counts used the item, so training cannot use it.
     */
    reason:
      | "missing_outcome"
      | "unavailable_evidence"
      | "withheld"
      | "diagnostic_control"
      | "training"
      | "labelling";
  }>;
}
export interface ReviewSelection {
  purpose: ReviewPurpose;
  operationIds: string[];
  treatments: ReviewTreatmentChoice[];
  reviewer: string;
  /** The count of distinct sampled questions. Delayed repeats come in addition. */
  questionLimit: number;
  unitIds: string[];
}
export interface ReviewPreview {
  id: string;
  populationId: string;
  selection: ReviewSelection;
  seed: string;
  selectedUnitIds: string[];
  eligible: number;
  plannedOutcomes: number;
  excluded: number;
  reusable: number;
  createdAt: string;
}
export interface ReviewDraft {
  revision: number;
  decision: ReviewDecision | null;
  reason: ReviewReasonDraft | null;
  blindingIssue: string | null;
}
export interface ReviewAssignment {
  id: string;
  batchId: string;
  unitId: string;
  reviewer: string;
  /** The position in the seeded order of this reviewer. */
  ordinal: number;
  releaseHash: string;
  acknowledged: boolean;
  claim: { sessionId: string; expiresAt: number } | null;
  draft: ReviewDraft;
  answerId: string | null;
  submittedVerdict: ReviewVerdict | null;
  reusedFrom: string | null;
  /** A delayed repeat names the assignment of its first occurrence. It never reuses an answer. */
  repeatOf: string | null;
  /** Round 2 only: the round 1 answer of the other reviewer that the question shows. */
  peerAnswerId: string | null;
  /** The review session in which the reviewer saved the first answer. */
  sessionNumber: number | null;
}
/** One sitting. It ends at a session limit, at the last answer or when the reviewer ends it. */
export interface ReviewSessionState {
  number: number;
  state: "open" | "time_limit" | "question_limit" | "ended" | "completed";
  startedAt: string;
  activeMs: number;
  /** Questions that got their first answer in this session. */
  answered: number;
}
/**
 * The link of a batch to an independent review by two reviewers. The pair identity is the
 * round 1 batch of the first reviewer. Round 2 shows each reviewer only the other answer.
 */
export interface ReviewExpertLink {
  pairId: string;
  role: "first" | "second";
  round: 1 | 2;
}
export interface ReviewPair {
  id: string;
  first: string;
  second: string | null;
  roundTwo: { first: string; second: string; unitIds: string[] } | null;
}
export interface ReviewBatch {
  id: string;
  previewId: string;
  populationId: string;
  purpose: ReviewPurpose;
  reviewer: string;
  /** The seed of the order and the repeats of this reviewer. */
  orderSeed: string;
  /** In the order of the reviewer. A delayed repeat is a separate assignment. */
  assignmentIds: string[];
  state: "active" | "completed";
  sessions: ReviewSessionState[];
  expert: ReviewExpertLink | null;
  createdAt: string;
  operationIds: string[];
}
export interface ReviewAnswer {
  id: string;
  batchId: string;
  assignmentId: string;
  reviewer: string;
  purpose: ReviewPurpose;
  binding: string;
  decision: ReviewDecision;
  verdict: ReviewVerdict;
  reason: ReviewReason;
  blindingIssue: string | null;
  submittedAt: string;
  previousAnswerId: string | null;
  copiedFrom: string | null;
  /** The assignment of the first occurrence when this answer is a delayed repeat. */
  repeatOf: string | null;
  /** Round 2: the answer of the other reviewer that the reviewer saw. */
  peerAnswerId: string | null;
}
export interface ReviewProgress {
  id: string;
  reviewer: string;
  purpose: ReviewPurpose;
  state: ReviewBatch["state"];
  assigned: number;
  answered: number;
  abstained: number;
  reused: number;
  remaining: number;
  /** Delayed repeats among the assigned questions. */
  repeats: number;
  /** All sessions together. */
  activeMs: number;
  /** The current or the last session. */
  session: ReviewSessionState | null;
  sessionLimits: { activeMs: number; questions: number };
  expert: ReviewExpertLink | null;
  createdAt: string;
  nextAssignmentId: string | null;
}
/** The reviewer does not learn which questions repeat or which review this one pairs with. */
export interface BlindReviewProgress extends Omit<
  ReviewProgress,
  "purpose" | "createdAt" | "repeats" | "expert"
> {
  kind: "training" | "review" | "round_two";
  questions: Array<{ id: string; answered: boolean; acknowledged: boolean; reopenable: boolean }>;
}
export interface BlindReviewQuestion {
  id: string;
  ordinal: number;
  criterion: ReviewCriterion;
  governingPassages: string[];
  evidence: EvidenceView;
  draft: ReviewDraft;
  answer: { decision: ReviewDecision; reason: ReviewReason; blindingIssue: string | null } | null;
  /** Round 2 only: the answer and the reason of the other reviewer. Never a judge answer. */
  peer: { decision: ReviewDecision; reason: ReviewReason } | null;
  /** False for a delayed repeat, its first occurrence and round 2. Each keeps its own answer. */
  crossPass: boolean;
  acknowledged: boolean;
  unavailable: string | null;
  preferredEvidence: "images" | "observations" | "source";
}
/** A share among sampled units of one population class, with an exact finite-population interval. */
export interface AuditQuantity {
  /** Population units in the class that the share describes. */
  population: number;
  /** Sampled units in that class. */
  selected: number;
  /** Sampled units with a resolved human label and the counted event. */
  numerator: number;
  /** Sampled units with a resolved human label. */
  denominator: number;
  /** Sampled units without a resolved human label. The interval takes both completions. */
  unresolved: number;
  estimate: number | null;
  interval: { lower: number; upper: number; confidence: 0.95 } | null;
}
/** A count with an explicit denominator and no population interval. */
export interface AuditRatio {
  numerator: number;
  denominator: number;
  unresolved: number;
  estimate: number | null;
}
/** A share over independent cells with a two-sided exact Clopper–Pearson interval. */
export interface AuditShare {
  numerator: number;
  denominator: number;
  /** Cells without a resolved value. The interval takes both completions. */
  unresolved: number;
  estimate: number | null;
  interval: { lower: number; upper: number; confidence: number; method: "clopper_pearson" } | null;
}
/**
 * Acceptance measures of one grading stream. A "share" conditions on the automatic
 * decision. A "rate" conditions on the human label.
 */
export interface AuditAcceptance {
  /** Binary decisions where the human label equals the automatic decision. */
  agreement: AuditQuantity;
  /** Among automatic accepts: the human rejects. Needs a random sample. */
  falseAcceptanceShare: AuditQuantity;
  /** Among automatic rejects: the human accepts. Needs a random sample. */
  falseRejectionShare: AuditQuantity;
  /** Among sampled human rejects: the stream accepts. Certify it with authored negatives. */
  missRate: AuditRatio;
  /** Among sampled human accepts: the stream rejects. */
  falseRejectionRate: AuditRatio;
  /** Planned outcomes with an automatic accept or reject. */
  removalShare: AuditRatio;
  /** Planned outcomes with no automatic accept, reject or score. A person must decide them. */
  escalationShare: AuditRatio;
  /** One sampled false pass sends the stream back to escalate-all. */
  monitor: { state: "active" | "escalate_all"; falsePassUnitIds: string[] };
}
export type AuditRater = { kind: "human"; id: string } | { kind: "automatic"; id: string | null };
/** The answer of one rater for one sampled unit. An unresolved answer stays in the records. */
export interface AuditRating {
  unitId: string;
  /** The evidence operation and the candidate. The bootstrap resamples these clusters. */
  candidate: string;
  scale: string;
  rater: AuditRater;
  /** Null when the reviewer did not answer. "insufficient" is an abstention. */
  decision: ReviewVerdict | null;
  score: number | null;
  /** The reviewer reported a blinding issue. Statistics treat the label as unresolved. */
  flagged: boolean;
}
interface AuditEstimate {
  value: number | null;
  interval: { lower: number; upper: number } | null;
}
/** Paired human and automatic agreement on one authored scale. */
export interface AuditReliability {
  scale: string;
  statement: string;
  kind: "categorical" | "ordinal" | "continuous";
  selected: number;
  unanswered: number;
  abstained: number;
  flagged: number;
  automaticMissing: number;
  exactAgreement: AuditQuantity;
  /** Agreement within one step. Only for an ordinal scale. */
  withinOne: AuditQuantity | null;
  /** In authored score units. Not for a categorical scale. */
  meanAbsoluteError: AuditEstimate | null;
  /** Automatic minus human, in authored score units. A categorical scale uses 0 and 1. */
  signedBias: AuditEstimate;
  quadraticKappa: AuditEstimate;
  ordinalAlpha: AuditEstimate;
  bootstrap: {
    method: "candidate_cluster_bootstrap";
    seed: number;
    resamples: number;
    confidence: 0.95;
    clusters: number;
  };
}
/** Agreement of two raters on one authored scale, over identical items. */
export interface RaterScaleAgreement {
  scale: string;
  statement: string;
  kind: AuditReliability["kind"];
  /** Identical items with a rating from both raters. */
  compared: number;
  /** Identical items without a resolved rating from one rater or both. */
  missing: number;
  exactAgreement: AuditQuantity;
  withinOne: AuditQuantity | null;
  meanAbsoluteError: AuditEstimate | null;
  /** The second rater minus the first rater, in authored score units. */
  signedBias: AuditEstimate;
  quadraticKappa: AuditEstimate;
  ordinalAlpha: AuditEstimate;
  bootstrap: AuditReliability["bootstrap"];
}
/** The agreement of two raters on the same items. */
export interface RaterAgreement {
  pair: "judge_first" | "judge_second" | "first_second";
  raters: [AuditRater, AuditRater];
  /** Criterion acceptance (met or not met) on identical items. */
  acceptance: AuditQuantity;
  /** Nominal Krippendorff alpha on the same acceptance decisions. */
  acceptanceAlpha: number | null;
  /**
   * Candidate acceptance under the build rule: every required criterion is met, or one is
   * not met. A candidate without a decision from both raters is unresolved.
   */
  candidateAcceptance: AuditShare;
  scales: RaterScaleAgreement[];
}
/** The answers of one reviewer to one question. */
export interface ExpertAnswerView {
  answerId: string | null;
  decision: ReviewDecision | null;
  verdict: ReviewVerdict | null;
  reason: ReviewReason | null;
  flagged: boolean;
}
export interface ExpertDisagreement {
  unitId: string;
  operationId: string;
  candidateId: string;
  criterionId: string;
  statement: string;
  pass: number;
  automatic: { verdict: ReviewVerdict | null; score: number | null };
  first: ExpertAnswerView;
  second: ExpertAnswerView;
  firstRoundTwo: ExpertAnswerView | null;
  secondRoundTwo: ExpertAnswerView | null;
  /** "contested": the reviewers disagree after round 2. */
  status: "awaiting_round_two" | "round_two_open" | "resolved" | "contested";
}
/** Judge agreement with each reviewer inside one stratum of round 1 expert agreement. */
export interface ExpertStratum {
  stratum: "agreed" | "disagreed";
  units: number;
  judgeFirst: AuditShare;
  judgeSecond: AuditShare;
}
/** Two independent reviewers on identical items. Two reviewers permit no alternative-annotator test. */
export interface ExpertComparison {
  pairId: string;
  first: { batchId: string; reviewer: string; answered: number; assigned: number };
  second: { batchId: string; reviewer: string; answered: number; assigned: number };
  roundTwo: { firstBatchId: string; secondBatchId: string; questions: number } | null;
  /** Identical items: the sampled units that both reviewers have. */
  items: number;
  /** Items without a first answer from one reviewer or both. */
  unanswered: number;
  agreements: RaterAgreement[];
  strata: ExpertStratum[];
  disagreements: ExpertDisagreement[];
  /** Units where the reviewers still disagree after round 2. */
  contested: string[];
  claim: string;
}
/** Within-reviewer agreement of each delayed repeat with its first occurrence. */
export interface RepeatAgreement {
  pairs: Array<{
    unitId: string;
    first: ReviewDecision | null;
    repeat: ReviewDecision | null;
    agreed: boolean | null;
  }>;
  /** Exact decision agreement. Cannot tell, flagged and missing answers are unresolved. */
  agreement: AuditShare;
}
/** The acceptance gate is relative to the expert ceiling. Reports always give the lower bounds. */
export const AGREEMENT_GATE = {
  metric: "candidate_acceptance_agreement",
  minimum: 0.8,
  maximumShortfall: 0.1,
} as const;
export interface AgreementGateResult {
  metric: (typeof AGREEMENT_GATE)["metric"];
  minimum: number;
  maximumShortfall: number;
  judgeFirst: AuditShare | null;
  judgeSecond: AuditShare | null;
  experts: AuditShare | null;
  /** The expert–expert estimate minus the lower judge–expert estimate. */
  shortfall: number | null;
  state: "met" | "not_met" | "unresolved" | "needs_second_reviewer" | "not_applicable";
}
export interface AuditReport {
  id: string;
  batchId: string;
  populationId: string;
  purpose: ReviewPurpose;
  sampling: "uniform_without_replacement" | "targeted" | "registered_protocol" | "training";
  progress: ReviewProgress;
  plannedOutcomes: number;
  sourcePlannedOutcomes: number;
  eligible: number;
  treatments: Array<{
    operationId: string;
    treatment: ReviewTreatment | null;
    plannedOutcomes: number;
    eligible: number;
    excluded: number;
    reused: number;
    acceptance: AuditAcceptance;
    reliability: AuditReliability[];
  }>;
  decisions: Array<{
    unitId: string;
    treatmentId: string | null;
    automaticDecision: ReviewAutomaticDecision | null;
  }>;
  exclusions: ReviewPopulation["exclusions"];
  /** Only first answers of round 1 count. Training, repeats and round 2 do not. */
  acceptance: AuditAcceptance;
  reliability: AuditReliability[];
  ratings: AuditRating[];
  answerIds: string[];
  evidence: Array<{
    operationId: string;
    candidateId: string;
    criterionId: string;
    pass: number;
    answered: boolean;
    repeat: boolean;
  }>;
  repeats: RepeatAgreement;
  experts: ExpertComparison | null;
  gate: AgreementGateResult;
  claim: string;
}
