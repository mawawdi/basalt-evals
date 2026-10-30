import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_CHANNEL_LIMIT,
  EXPOSURE_MEASURES,
  GUI_LAYOUT_CHECKS,
  HUMANOID_STATES,
  PERFORMANCE_AGGREGATES,
  PERFORMANCE_METRICS,
  SOURCE_LINT_CODES,
  SPIKE_PENDING_RULES,
  STUDIO_CAPABILITY_CATALOG,
  type ExposureMeasure,
  type GuiLayoutCheck,
  type PerformanceAggregate,
  type PerformanceMetric,
  type SourceLintCode,
} from "./capabilities.js";
import { assertStudioSequenceView, type StudioSequenceView } from "./sequence-view.js";
export {
  assertStudioSequenceView,
  isSequenceTransitionBinding,
  sequenceViewReferenceErrors,
  studioSequenceView,
  MAXIMUM_PRESENTED_FRAMES,
  SEQUENCE_VIEW_FIELDS,
  type StudioSequenceView,
  type SequenceTransitionBinding,
} from "./sequence-view.js";
import { assertBarrierTrajectory, type BarrierTrajectory } from "./barrier.js";
import {
  assertHarnessDefinition,
  MAX_HARNESS_SUMMARIES,
  MAX_HARNESS_TURNS,
  type HarnessDefinition,
} from "./harness.js";
export {
  assertHarnessDefinition,
  BUILDER_TOOL_NAMES,
  isHarnessId,
  MAX_HARNESS_TURNS,
  type BuilderToolName,
  type HarnessDefinition,
} from "./harness.js";
import { assertExactRecordKeys, fail, isFiniteNumber, isRecord, isText } from "./validation.js";
export { assertBarrierTrajectory, type BarrierTrajectory } from "./barrier.js";
export { publicTaskInstructions } from "./public-task-instructions.js";
export { studioIdentityIssue, deterministicObservationBindings } from "./studio-observation.js";
import { assertSceneTextObservation, type SceneTextObservation } from "./scene-text.js";
import { isEvidenceClass, type EvidenceClass } from "./evidence-class.js";
export { EVIDENCE_CLASSES, isEvidenceClass, type EvidenceClass } from "./evidence-class.js";
export {
  assertSceneTextObservation,
  sceneTextNeedsReview,
  type SceneTextObservation,
} from "./scene-text.js";

type Hash = string;
type ISO8601 = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const TASK_SCHEMA = "basalt-evals/task" as const;
export const EVALUATOR_SCHEMA = "basalt-evals/evaluator" as const;
const STUDY_SCHEMA = "basalt-evals/study" as const;
export const TREATMENT_SCHEMA = "basalt-evals/treatment" as const;
export const AGENT_RUN_SCHEMA = "basalt-evals/agent-run" as const;
export const STUDIO_EVIDENCE_SCHEMA = "basalt-evals/studio-evidence" as const;

export const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
export const MAX_CANDIDATE_FILES = 10_000;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTURE_PIXELS = 4096 * 4096;
const MAX_STUDY_TREATMENTS = 10_000;
const MAX_AGENT_TRACE_EVENTS = 10_000;
/**
 * The provider pauses of one build or judgment. A paused request is a call, but it does not use
 * a turn. After this number of pauses, the next pausing failure ends the unit as incomplete.
 */
export const MAX_PROVIDER_PAUSES = 8;
export const MAX_STUDIO_SCENARIO_DURATION_MS = 30 * 60_000;
const MAX_STUDIO_MOTION_SPAN_MS = 10 * 60_000;
export const MAX_STUDIO_CLIENTS = 8;
export const SEQUENCE_SAMPLE_INTERVAL_MS = 500;
// Cover every supported actor for the longest declared scenario, including startup headroom.
export const MAX_SEQUENCE_FRAMES =
  Math.ceil((MAX_STUDIO_SCENARIO_DURATION_MS + 120_000) / SEQUENCE_SAMPLE_INTERVAL_MS) *
    MAX_STUDIO_CLIENTS +
  MAX_STUDIO_CLIENTS;
export const MAX_SEQUENCE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_NATIVE_ARTIFACTS = MAX_SEQUENCE_FRAMES + 8192;
export const MAX_NATIVE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_NATIVE_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;

type EvaluationLayer = "static" | "engine" | "code" | "visual" | "human";
export type CriterionOutcome = "verified" | "rejected" | "incomplete";

export type FailureClassification =
  | "task_spec_failure"
  | "model_reasoning_failure"
  | "model_refusal"
  | "model_tool_use_failure"
  | "harness_context_failure"
  | "harness_feedback_failure"
  | "budget_or_stop_failure"
  | "provider_or_transport_failure"
  | "workspace_or_security_failure"
  | "static_or_luau_failure"
  | "studio_mutation_failure"
  | "engine_runtime_failure"
  | "visual_or_interaction_failure"
  | "grader_failure"
  | "environment_failure"
  | "evidence_incomplete"
  | "human_product_rejection"
  | "unknown";

export interface PublicTask {
  schema: typeof TASK_SCHEMA;
  slug: string;
  title: string;
  prompt: string;
  seed: { projectFile: string; sourceRoots: string[] };
  roles: SemanticRole[];
  acceptance: string[];
  evidenceInstructions: string[];
}

interface SemanticRole {
  /** The id is also the CollectionService tag of the object, so a role has one name. */
  id: string;
  className: string;
  scope: "workspace" | "replicated_storage" | "local_player_gui";
  cardinality: "exactly_one" | "zero_or_one";
}

export type StudioFactRequest =
  | { id: string; kind: "instance"; path: string }
  | { id: string; kind: "instance_name"; path: string }
  | { id: string; kind: "instance_value"; path: string }
  | { id: string; kind: "part_motion"; path: string; sampleCount: number; intervalMs: number }
  | {
      id: string;
      kind: "actor_part_motion";
      actor: string;
      path: string;
      sampleCount: number;
      intervalMs: number;
    }
  | { id: string; kind: "actor_part_support"; actor: string; path: string }
  | { id: string; kind: "gui_text"; path: string }
  | { id: string; kind: "gui_geometry"; path: string }
  | { id: string; kind: "part_position"; path: string }
  | { id: string; kind: "part_physics"; path: string }
  | { id: string; kind: "part_physics_trace"; path: string; durationMs: number }
  | {
      id: string;
      kind: "part_route_trace";
      path: string;
      startPath: string;
      endPath: string;
      durationMs: number;
      proximityStuds: number;
    }
  | { id: string; kind: "particle_state"; path: string }
  | { id: string; kind: "replication_probe"; path: string; attribute: string }
  | { id: string; kind: "actor_health"; actor: string }
  | { id: string; kind: "player_count" }
  | { id: string; kind: "diagnostics" }
  /** Server only. Each sample covers one intervalMs, so the window is sampleCount * intervalMs. */
  | { id: string; kind: "performance_trace"; sampleCount: number; intervalMs: number }
  /** Client only. The path is a local player ScreenGui. */
  | { id: string; kind: "gui_layout"; path: string };

interface StudioPhase {
  id: string;
  label: string;
  instruction: string;
  driver:
    | { kind: "manual" }
    | { kind: "wait_for_session"; timeoutMs: number }
    | { kind: "wait_for_fact"; readyFactId: string; readyValue: string; timeoutMs: number }
    | { kind: "wait_for_exists"; readyFactId: string; timeoutMs: number }
    | { kind: "observe_from_actor"; targetPath: string; timeoutMs: number }
    | {
        kind: "gui_button";
        path: string;
        readyFactId: string;
        readyValue: string;
        timeoutMs: number;
      }
    | {
        kind: "character_move_to";
        targetPath: string;
        readyFactId: string;
        readyValue: string;
        timeoutMs: number;
      }
    | { kind: "character_reach_part"; targetPath: string; timeoutMs: number };
  facts: StudioFactRequest[];
  captures: Array<{
    id: string;
    instruction: string;
  }>;
}

type StudioScenarioArgument =
  { kind: "literal"; value: JsonPrimitive } | { kind: "actor_user_id"; actor: string };

type StudioScenarioAction =
  | { kind: "wait" }
  | { kind: "move_to"; actor: string; targetPath: string }
  | { kind: "place_on_part"; actor: string; targetPath: string }
  | {
      kind: "place_relative_to_part" | "move_relative_to_part";
      actor: string;
      targetPath: string;
      offsetStuds: [number, number, number];
    }
  | { kind: "probe_barrier"; actor: string; barrierPath: string }
  | { kind: "press_key"; actor: string; key: "E" }
  | { kind: "hold_key"; actor: string; key: "E" | "F" | "Space"; durationMs: number }
  | { kind: "gui_activate"; actor: string; path: string }
  | { kind: "gui_text_entry"; actor: string; path: string; text: string }
  | {
      kind: "fire_remote";
      actor: string;
      path: string;
      arguments: StudioScenarioArgument[];
    }
  | { kind: "disconnect"; actor: string };

/** A platform-observable fact that a step can wait for. No kind reads a candidate attribute. */
type StudioAnchorFact =
  | { kind: "humanoid_state"; actor: string; state: (typeof HUMANOID_STATES)[number] }
  | { kind: "character_on_part"; actor: string; path: string }
  | { kind: "character_near_part"; actor: string; path: string; radiusStuds: number }
  | { kind: "gui_visible"; path: string; visible: boolean }
  | { kind: "instance_present"; path: string; present: boolean }
  | { kind: "part_can_collide"; path: string; value: boolean }
  | { kind: "part_anchored"; path: string; value: boolean };

type StudioStepAnchor = { step: string } | { fact: StudioAnchorFact; scope: string };

/**
 * startMs is an offset from the shared scenario start. Use it only for a rubric claim about
 * time from that start. Otherwise anchor the step on an earlier step or on a fact.
 */
type StudioStepTiming = { startMs: number } | { after: StudioStepAnchor; offsetMs: number };

/** A pass/fail time bound. Only a human rubric sets it, and quote copies that rubric text. */
interface StudioStepRequirement {
  withinMs: number;
  quote: string;
}

/**
 * A pass/fail bound of a rule. Only human text sets it. quote copies that text and states value
 * in the unit of the rule. The compiler checks that the text of the mapped criterion contains it.
 */
export interface AuthoredBound {
  value: number;
  quote: string;
}

interface StudioScenarioStep {
  id: string;
  at: StudioStepTiming;
  /** How long the runner looks for the anchor, and how late the step can start. */
  horizonMs: number;
  /** How long a fact anchor must hold before the step counts it as observed. */
  holdMs: number;
  action: StudioScenarioAction;
  observations: Array<{ context: string; fact: StudioFactRequest }>;
  requirement: StudioStepRequirement | null;
}

export interface StudioScenario {
  id: string;
  label: string;
  /** The outer observation budget. No step starts after it ends. */
  durationMs: number;
  reportContexts: string[];
  steps: StudioScenarioStep[];
}

type StudioStepOutcome = "observed" | "not_observed_within_horizon" | "acquisition_failed";
const STUDIO_STEP_OUTCOMES: readonly StudioStepOutcome[] = [
  "observed",
  "not_observed_within_horizon",
  "acquisition_failed",
];

/**
 * One context's record of one step. All times are seconds on the Studio server clock
 * (workspace:GetServerTimeNow in that context). Luau omits nil fields, so a time that does
 * not apply is absent.
 */
export interface StudioScenarioStepReport {
  stepId: string;
  outcome: StudioStepOutcome;
  /** The time this context started the step and started to look for its anchor. */
  dueAt: number;
  /** The anchor time that this context used: the shared start, a completion or a sighting. */
  anchorObservedAt?: number;
  /** For a fact that this context watched: the largest gap between two polls. */
  pollIntervalMs?: number;
  /** True when the fact already held at the first poll, so the sighting is not a transition. */
  anchorPreexisting?: true;
  scheduledAt?: number;
  actedAt?: number;
  capturedAt?: number;
  action?: { kind: StudioScenarioAction["kind"]; succeeded: boolean; probe?: BarrierTrajectory };
  observations: StudioObservation[];
}

export interface StudioScenarioReport {
  context: string;
  /** The shared scenario start on the Studio server clock, in seconds. */
  startAt: number;
  actors: Array<{ actor: string; userId: number; name: string }>;
  steps: StudioScenarioStepReport[];
}

export interface StudioCollectionPlan {
  schema: "basalt-evals/studio-plan";
  clients: number;
  actors: string[];
  roles: SemanticRole[];
  scenarios: StudioScenario[];
  phases: StudioPhase[];
}

export type DeterministicRule =
  | { kind: "path_exists"; path: string }
  | { kind: "source_contains"; path: string; text: string; caseSensitive: boolean }
  | {
      kind: "fact_equals";
      phaseId: string;
      factId: string;
      field: (typeof FACT_FIELD_NAMES)[number];
      expected: JsonPrimitive;
    }
  | {
      kind: "fact_contains";
      phaseId: string;
      factId: string;
      field: "text";
      text: string;
      caseSensitive: boolean;
    }
  | {
      kind: "number_in_range";
      phaseId: string;
      factId: string;
      field: (typeof NUMBER_FIELD_NAMES)[number];
      minimum: number;
      maximum: number;
    }
  | { kind: "diagnostics_empty"; phaseId: string; factId: string }
  | { kind: "capture_present"; phaseId: string; captureId: string }
  | {
      kind: "scenario_action_succeeded";
      scenarioId: string;
      stepId: string;
      actor: string;
    }
  | {
      kind: "scenario_barrier_passage";
      scenarioId: string;
      stepId: string;
      actor: string;
      expected: "blocked" | "passed";
    }
  | {
      kind: "scenario_fact_equals";
      scenarioId: string;
      stepId: string;
      context: string;
      factId: string;
      field: (typeof FACT_FIELD_NAMES)[number];
      expected: JsonPrimitive;
    }
  | {
      kind: "scenario_fact_supports_value";
      scenarioId: string;
      stepId: string;
      context: string;
      factId: string;
      field: (typeof FACT_FIELD_NAMES)[number];
      expected: JsonPrimitive;
    }
  | {
      kind: "scenario_fact_equals_actor_user_id";
      scenarioId: string;
      stepId: string;
      context: string;
      factId: string;
      actor: string;
    }
  | {
      kind: "scenario_number_delta_in_range";
      scenarioId: string;
      context: string;
      fromStepId: string;
      fromFactId: string;
      toStepId: string;
      toFactId: string;
      field: (typeof NUMBER_FIELD_NAMES)[number];
      minimum: number;
      maximum: number;
    }
  | {
      kind: "scenario_cross_context_equals";
      scenarioId: string;
      stepId: string;
      factId: string;
      field: (typeof FACT_FIELD_NAMES)[number];
      contexts: string[];
    }
  | {
      /** Grades the human-authored requirement of one fact-anchored step. */
      kind: "scenario_step_within";
      scenarioId: string;
      stepId: string;
    }
  | {
      /** No finding of these codes in the static analysis of the sealed source. */
      kind: "source_lint_absent";
      codes: SourceLintCode[];
    }
  | {
      /** No script error of these diagnostics facts comes from a script of the build. */
      kind: "build_errors_absent";
      facts: StudioObservationBinding[];
    }
  | {
      /** One fixed check of one gui_layout fact. Only min_text_px has a minimum, in px. */
      kind: "gui_layout_holds";
      fact: StudioObservationBinding;
      check: GuiLayoutCheck;
      minimum: AuthoredBound | null;
    }
  | {
      /**
       * One aggregate of one metric of one performance_trace fact is at most the maximum. The
       * maximum is in ms for a frame metric, as a count for instance_count and in mb for
       * memory_mb. memory_mb permits only growth, because it is the whole Studio process.
       */
      kind: "performance_within";
      scenarioId: string;
      stepId: string;
      context: string;
      factId: string;
      metric: PerformanceMetric;
      aggregate: PerformanceAggregate;
      maximum: AuthoredBound;
    }
  | {
      /**
       * Each text element of the same-phase gui_layout fact has a WCAG contrast ratio of at
       * least the minimum in the pixels of the capture. The minimum is a ratio N:1.
       */
      kind: "capture_text_contrast";
      phaseId: string;
      captureId: string;
      layoutFactId: string;
      minimum: AuthoredBound;
    }
  | {
      /**
       * One exposure measure of all pixels of the capture is in the bounds. Each bound is a
       * percent: of white luminance for mean_luminance, and of the pixels for a share.
       */
      kind: "capture_exposure";
      phaseId: string;
      captureId: string;
      measure: ExposureMeasure;
      minimum: AuthoredBound | null;
      maximum: AuthoredBound | null;
    };

export interface DeterministicCriterion {
  id: string;
  layer: "static" | "engine";
  statement: string;
  required: boolean;
  rule: DeterministicRule;
}

export interface RubricAnchor {
  score: number;
  label: string;
  description: string;
}

export interface ScoreRange {
  minimum: number;
  maximum: number;
  step: number | null;
}

export function validRubricScore(
  criterion: { anchors: RubricAnchor[]; scoreRange: ScoreRange | null },
  score: unknown,
): score is number {
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  const range = criterion.scoreRange;
  if (range === null) return criterion.anchors.some((anchor) => anchor.score === score);
  if (score < range.minimum || score > range.maximum) return false;
  if (range.step === null) return true;
  const units = (score - range.minimum) / range.step;
  return Math.abs(units - Math.round(units)) < 1e-8;
}

/**
 * The human rubric author sets the polarity of a criterion. A presence criterion is met when the
 * build shows what the criterion text describes. An absence criterion is met when the build does
 * not show it.
 */
export const POLARITIES = ["presence", "absence"] as const;
export type Polarity = (typeof POLARITIES)[number];

export function isPolarity(value: unknown): value is Polarity {
  return (POLARITIES as readonly unknown[]).includes(value);
}

export interface VisualCriterion {
  id: string;
  statement: string;
  required: boolean;
  /** Null when the rubric author set no class. Then no model judges the criterion. */
  evidenceClass: EvidenceClass | null;
  /** Only the rubric author sets it. A criterion without a `Polarity:` line has presence. */
  polarity: Polarity;
  captureIds: string[];
  sequence: boolean;
  anchors: RubricAnchor[];
  scoreRange: ScoreRange | null;
  minimumPassingScore: number | null;
}

export interface CodeCriterion {
  id: string;
  statement: string;
  required: boolean;
  sourceSelection:
    { kind: "all_luau_in_roots"; roots: string[] } | { kind: "exact_files"; paths: string[] };
  anchors: RubricAnchor[];
  scoreRange: ScoreRange | null;
  minimumPassingScore: number | null;
}

/** Human wording without an authored numerical scale. Judgment stays categorical. */
export interface UnscaledCriterion {
  id: string;
  statement: string;
  required: boolean;
  /** Null when the rubric author set no class. Then no model judges Studio evidence for it. */
  evidenceClass: EvidenceClass | null;
  /** Only the rubric author sets it. A criterion without a `Polarity:` line has presence. */
  polarity: Polarity;
  evidence: {
    sourceSelection: CodeCriterion["sourceSelection"] | null;
    facts: StudioObservationBinding[];
    actions: StudioActionBinding[];
    captureIds: string[];
    sequence: boolean;
  };
}

/** Presentation classification, derived from independently selectable evidence channels. */
function unscaledEvidenceKind(
  evidence: UnscaledCriterion["evidence"],
): "code" | "visual" | "studio_evidence" {
  if (
    evidence.facts.length ||
    evidence.actions.length ||
    (evidence.sourceSelection && (evidence.captureIds.length || evidence.sequence))
  )
    return "studio_evidence";
  return evidence.sourceSelection ? "code" : "visual";
}

export function unscaledEvidenceLayer(evidence: UnscaledCriterion["evidence"]) {
  const kind = unscaledEvidenceKind(evidence);
  return kind === "studio_evidence" ? "engine" : kind;
}

export type StudioObservationBinding =
  | { phaseId: string; factId: string }
  | { scenarioId: string; stepId: string; context: string; factId: string };

export interface StudioActionBinding {
  scenarioId: string;
  stepId: string;
  context: string;
}

export interface EvaluatorSpec {
  schema: typeof EVALUATOR_SCHEMA;
  task: { slug: string };
  studio: StudioCollectionPlan;
  sequence: StudioSequenceView | null;
  deterministic: DeterministicCriterion[];
  codeQuality: CodeCriterion[];
  visual: VisualCriterion[];
  unscaled: UnscaledCriterion[];
  humanReview: string[];
}

export interface RegisteredTask {
  id: string;
  directory: string;
  publicTask: PublicTask;
  evaluator: EvaluatorSpec;
  publicTaskHash: Hash;
  evaluatorHash: Hash;
  seedHash: Hash;
  collectionPlanHash: Hash;
}

export interface StudyModel {
  /** Exact model slug placed on the provider request. */
  id: string;
  /** Exact model identity expected in the provider response envelope. */
  responseModelId: string;
  transport: string;
  /** Immutable catalog revision selected by `id`. */
  revision: string;
  pricing: {
    currency: "USD";
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    capturedAt: ISO8601;
  };
}

export interface StudyDefinition {
  schema: typeof STUDY_SCHEMA;
  id: string;
  title: string;
  hypothesis: string;
  taskDirectories: string[];
  models: StudyModel[];
  transportConfigurationHash: Hash;
  harnesses: HarnessDefinition[];
  repetitions: number;
  seed: number;
  environment: {
    platform: "Roblox Studio";
    studioVersion: string;
    captureProtocol: "studio-mcp-viewport";
    cameraProtocol: string;
  };
}

export interface Treatment {
  schema: typeof TREATMENT_SCHEMA;
  id: string;
  ordinal: number;
  studyHash: Hash;
  task: {
    id: string;
    publicTaskHash: Hash;
    evaluatorHash: Hash;
    seedHash: Hash;
    collectionPlanHash: Hash;
  };
  model: StudyModel;
  transportConfigurationHash: Hash;
  harness: HarnessDefinition;
  repetition: number;
  randomSeed: number;
  environment: StudyDefinition["environment"];
}

export interface FrozenStudy {
  schema: "basalt-evals/frozen-study";
  frozenAt: ISO8601;
  study: StudyDefinition;
  studyHash: Hash;
  implementationCommit: string;
  dirty: boolean;
  connectorSourceHash: Hash;
  connectorArtifactHash: Hash;
  tasks: Array<{
    id: string;
    directory: string;
    publicTaskHash: Hash;
    evaluatorHash: Hash;
    seedHash: Hash;
    collectionPlanHash: Hash;
  }>;
  treatments: Treatment[];
}

interface CandidateFile {
  path: string;
  hash: Hash;
  bytes: number;
}

export interface CandidateManifest {
  rootHash: Hash;
  projectFile: string;
  files: CandidateFile[];
}

export interface AgentTraceEvent {
  sequence: number;
  at: ISO8601;
  /** A `boundary` records a context compaction: the conversation restarts from a summary. */
  kind:
    | "model_request"
    | "model_response"
    | "tool_call"
    | "tool_result"
    | "tool_rejection"
    | "boundary"
    | "gate";
  data: Record<string, JsonValue>;
}

export interface AgentRun {
  schema: typeof AGENT_RUN_SCHEMA;
  id: string;
  treatmentId: string;
  startedAt: ISO8601;
  endedAt: ISO8601;
  status: "locally_eligible" | "rejected" | "incomplete";
  stopReason:
    | "finished"
    | "turn_limit"
    | "context_limit"
    | "spending_limit"
    | "output_limit"
    | "provider_error"
    | "refusal"
    | "invalid_tool_call"
    | "cancelled";
  candidate: CandidateManifest;
  usage: {
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    estimatedCostUsd: number | null;
    providerReportedCostUsd: number | null;
  };
  trace: AgentTraceEvent[];
  failure?: { classification: FailureClassification; detail: string };
}

export type StudioObservation =
  | {
      factId: string;
      kind: "binding_failure";
      requestedKind: StudioFactRequest["kind"];
      path: string;
      reason:
        | "missing"
        | "ambiguous"
        | "wrong_class"
        | "wrong_scope"
        | "unavailable_scope"
        | "undeclared_role";
    }
  | { factId: string; kind: "instance"; exists: boolean; className: string }
  | { factId: string; kind: "instance_name"; exists: boolean; name: string }
  | {
      factId: string;
      kind: "instance_value";
      exists: boolean;
      /** The concrete ValueBase class, or "" when exists is false. */
      className: (typeof INSTANCE_VALUE_CLASSES)[number] | "";
      /** The Value property, or the fallback false when exists is false. */
      value: number | boolean | string;
    }
  | {
      factId: string;
      kind: "part_motion";
      samples: Array<{ elapsedMs: number; x: number; y: number; z: number }>;
      delta: number;
    }
  | {
      factId: string;
      kind: "actor_part_motion";
      actor: string;
      exists: boolean;
      samples: Array<{
        elapsedMs: number;
        x: number;
        y: number;
        z: number;
        actorX: number;
        actorY: number;
        actorZ: number;
        localX: number;
        localY: number;
        localZ: number;
        sizeX: number;
        sizeY: number;
        sizeZ: number;
      }>;
      partDelta: number;
      actorDelta: number;
      maxRelativeDelta: number;
    }
  | {
      factId: string;
      kind: "actor_part_support";
      actor: string;
      exists: boolean;
      localX: number;
      localY: number;
      localZ: number;
      sizeX: number;
      sizeY: number;
      sizeZ: number;
      hitTarget: boolean;
      hitDistance: number;
    }
  | { factId: string; kind: "gui_text"; exists: boolean; text: string; visible: boolean }
  | {
      factId: string;
      kind: "gui_geometry";
      exists: boolean;
      visible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { factId: string; kind: "part_position"; exists: boolean; x: number; y: number; z: number }
  | {
      factId: string;
      kind: "part_physics";
      exists: boolean;
      anchored: boolean;
      canCollide: boolean;
    }
  | {
      factId: string;
      kind: "part_physics_trace";
      exists: boolean;
      initialAnchored: boolean;
      finalAnchored: boolean;
      initialCanCollide: boolean;
      finalCanCollide: boolean;
      everUnanchored: boolean;
      observedMs: number;
      changes: Array<{ elapsedMs: number; anchored: boolean; canCollide: boolean }>;
    }
  | {
      factId: string;
      kind: "part_route_trace";
      exists: boolean;
      observedMs: number;
      sampleCount: number;
      maxFrameGapMs: number;
      visits: Array<{
        marker: "start" | "end";
        enterMs: number;
        exitMs: number;
        travelStuds: number;
        minDistanceStuds: number;
        longestStillMs: number;
        maxFrameGapMs: number;
      }>;
    }
  | {
      factId: string;
      kind: "particle_state";
      exists: boolean;
      enabled: boolean;
      emissionRate: number;
    }
  | {
      factId: string;
      kind: "replication_probe";
      exists: boolean;
      value: JsonPrimitive;
      observedFrom: "studio";
    }
  | { factId: string; kind: "actor_health"; actor: string; exists: boolean; value: number }
  | { factId: string; kind: "player_count"; value: number }
  | { factId: string; kind: "diagnostics"; messages: string[]; scriptErrors: ScriptDiagnostic[] }
  | { factId: string; kind: "performance_trace"; samples: PerformanceSample[] }
  | {
      factId: string;
      kind: "gui_layout";
      exists: boolean;
      /** False when the element limit left out visible GuiObjects. */
      complete: boolean;
      screen: GuiRect;
      guiInset: { left: number; top: number; right: number; bottom: number };
      viewport: { w: number; h: number };
      ignoreGuiInset: boolean;
      elements: GuiLayoutElement[];
    };

/**
 * One interval of a server performance trace. Luau cannot send JSON null, so every sample
 * omits instanceCount or memoryMb when Studio did not let the runner read that value.
 */
export interface PerformanceSample {
  elapsedMs: number;
  frames: number;
  meanFrameMs: number;
  maxFrameMs: number;
  instanceCount?: number;
  memoryMb?: number;
}

/** A rectangle in GUI pixels: AbsolutePosition and AbsoluteSize. */
export interface GuiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One visible GuiObject of a gui_layout observation. Absent fields do not apply. */
export interface GuiLayoutElement {
  path: string;
  className: string;
  rect: GuiRect;
  /** The rect inside every ancestor with ClipsDescendants. Absent when nothing of it stays. */
  clippedRect?: GuiRect;
  zIndex: number;
  /** True for a TextLabel, TextButton or TextBox with non-empty Text. */
  hasText: boolean;
  textBounds?: { w: number; h: number };
  textSize?: number;
  textScaled?: boolean;
  textWrapped?: boolean;
  textFits?: boolean;
}

export interface ScriptDiagnostic {
  message: string;
  stackTrace: string;
  source:
    | { kind: "script"; path: string; className: string; inDataModel: boolean }
    | { kind: "unavailable" };
}

interface VisualCapture {
  captureId: string;
  file: string;
  hash: Hash;
  bytes: number;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Candidate GUI text at this capture. It routes review and never makes a verdict. */
  sceneText: SceneTextObservation;
}

export interface StudioEvidence {
  schema: typeof STUDIO_EVIDENCE_SCHEMA;
  id: string;
  treatmentId: string;
  candidateHash: Hash;
  collectionPlanHash: Hash;
  connectorSourceHash: Hash;
  connectorArtifactHash: Hash;
  place: { file: string; hash: Hash };
  studio: { version: string; sessionId: string };
  startedAt: ISO8601;
  endedAt: ISO8601;
  scenarios: Array<{
    scenarioId: string;
    startedAt: ISO8601;
    endedAt: ISO8601;
    reports: StudioScenarioReport[];
  }>;
  phases: Array<{
    phaseId: string;
    observations: StudioObservation[];
    captures: VisualCapture[];
  }>;
}

/** Resolve only the explicitly bound fact from a verified Studio evidence record. */
export function boundStudioObservation(
  evidence: StudioEvidence,
  binding: StudioObservationBinding,
): StudioObservation | null {
  if ("phaseId" in binding)
    return (
      evidence.phases
        .find((phase) => phase.phaseId === binding.phaseId)
        ?.observations.find((item) => item.factId === binding.factId) ?? null
    );
  return (
    evidence.scenarios
      .find((scenario) => scenario.scenarioId === binding.scenarioId)
      ?.reports.find((report) => report.context === binding.context)
      ?.steps.find((step) => step.stepId === binding.stepId)
      ?.observations.find((item) => item.factId === binding.factId) ?? null
  );
}

/** The role paths that the capture found at least one time, in any phase or scenario step. */
export function identifiedRolePaths(
  plan: StudioCollectionPlan,
  evidence: StudioEvidence,
): Set<string> {
  const found = new Set<string>();
  const note = (fact: object, observation: StudioObservation | null) => {
    if (
      "path" in fact &&
      typeof fact.path === "string" &&
      fact.path.startsWith("role.") &&
      observation &&
      "exists" in observation &&
      observation.exists
    )
      found.add(fact.path);
  };
  for (const phase of plan.phases)
    for (const fact of phase.facts)
      note(fact, boundStudioObservation(evidence, { phaseId: phase.id, factId: fact.id }));
  for (const scenario of plan.scenarios)
    for (const step of scenario.steps)
      for (const item of step.observations)
        note(
          item.fact,
          boundStudioObservation(evidence, {
            scenarioId: scenario.id,
            context: item.context,
            stepId: step.id,
            factId: item.fact.id,
          }),
        );
  return found;
}

/** A signed input receipt is distinct from the observations of its effects. */
export function boundStudioAction(
  evidence: StudioEvidence,
  binding: StudioActionBinding,
  plan: StudioCollectionPlan,
) {
  const requestedAction = plan.scenarios
    .find((scenario) => scenario.id === binding.scenarioId)
    ?.steps.find((step) => step.id === binding.stepId)?.action;
  if (
    !requestedAction ||
    requestedAction.kind === "wait" ||
    requestedAction.actor !== binding.context
  )
    throw new Error("Action binding does not identify a performed input in the frozen plan");
  const step = evidence.scenarios
    .find((scenario) => scenario.scenarioId === binding.scenarioId)
    ?.reports.find((report) => report.context === binding.context)
    ?.steps.find((item) => item.stepId === binding.stepId);
  if (!step?.action || step.scheduledAt === undefined || step.actedAt === undefined) return null;
  if (step.action.kind !== requestedAction.kind)
    throw new Error("Action receipt differs from the frozen plan");
  // Both times use the Studio server clock. They bound the input, not its effect.
  return {
    requestedAction,
    outcome: step.outcome,
    scheduledAt: step.scheduledAt,
    actedAt: step.actedAt,
    action: step.action,
  };
}

/** The context whose report is authoritative for the schedule of a step. */
export function stepScheduleContext(step: StudioScenarioStep): string {
  if (step.action.kind !== "wait") return step.action.actor;
  if ("after" in step.at && "fact" in step.at.after) return step.at.after.scope;
  return "server";
}

/**
 * Find the durations that a text states in digits and a unit, in milliseconds.
 * A requirement quote must state its withinMs this way, in whole milliseconds. An authored bound
 * keeps a fraction of a millisecond, for example 16.7 ms.
 */
function statedDurationsMs(text: string, fraction = false): number[] {
  const units =
    /\b(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?)(?![A-Za-z])/giu;
  return [...text.matchAll(units)].map((match) => {
    const unit = match[2]!.toLowerCase();
    const multiplier =
      unit === "ms" || unit.startsWith("millisecond") || unit.startsWith("msec")
        ? 1
        : unit.startsWith("min")
          ? 60_000
          : 1_000;
    const value = Number(match[1]) * multiplier;
    return fraction ? Number(value.toFixed(6)) : Math.round(value);
  });
}

/** The units of an authored bound. A ratio is N:1, a percent is N% and a count has no unit. */
export type QuantityUnit = "px" | "ratio" | "count" | "mb" | "ms" | "percent";

/**
 * One number in digits and its unit. A number without a unit is a count. A number that is part
 * of a name, a digit group or a time of day is not a quantity.
 */
const STATED_QUANTITY =
  /(?<![\w.,:])(\d+(?:\.\d+)?)(?![.,]?\d)(?:(?:\s*|-)(?<px>px|pixels?)(?![A-Za-z])|\s*:\s*(?<ratio>1)(?![.,]?\d)|\s*(?<percent>%|percent(?![A-Za-z]))|\s*(?<mb>mb|megabytes?)(?![A-Za-z])|(?:\s*|-)(?<duration>milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?)(?![A-Za-z])|(?![A-Za-z%:]))/giu;

/**
 * Find the quantities that a text states in digits and the unit. A duration is in milliseconds,
 * and a ratio N:1 gives N. An authored bound must state its value this way.
 */
export function statedQuantities(text: string, unit: QuantityUnit): number[] {
  if (unit === "ms") return statedDurationsMs(text, true);
  const found: number[] = [];
  for (const match of text.matchAll(STATED_QUANTITY)) {
    const groups = match.groups ?? {};
    const value = Number(match[1]);
    const stated = groups.px
      ? "px"
      : groups.ratio
        ? "ratio"
        : groups.percent
          ? "percent"
          : groups.mb
            ? "mb"
            : groups.duration
              ? "ms"
              : Number.isInteger(value)
                ? "count"
                : null;
    if (stated === unit) found.push(value);
  }
  return found;
}

/** The authored bounds of a rule. The compiler checks the quote of each bound. */
export function authoredBounds(rule: DeterministicRule): AuthoredBound[] {
  if (rule.kind === "gui_layout_holds") return rule.minimum ? [rule.minimum] : [];
  if (rule.kind === "performance_within") return [rule.maximum];
  if (rule.kind === "capture_text_contrast") return [rule.minimum];
  if (rule.kind === "capture_exposure")
    return [rule.minimum, rule.maximum].filter((bound) => bound !== null);
  return [];
}

/** The unit of the maximum of each performance metric. */
const PERFORMANCE_METRIC_UNITS: Record<PerformanceMetric, QuantityUnit> = {
  max_frame_ms: "ms",
  mean_frame_ms: "ms",
  instance_count: "count",
  memory_mb: "mb",
};

/** A deterministic decision, not a model confidence estimate. */
interface VisualAcceptance {
  source: "required_criterion_scores";
  outcome: "accept" | "reject" | "abstain";
}

/** Unknown required evidence takes precedence, including alongside a known failure. */
export function deriveVisualAcceptance(
  rubric: VisualCriterion[],
  decisions: Array<{ criterionId: string; score: number | null }>,
): VisualAcceptance {
  assertSameIds(
    rubric.map((c) => c.id),
    decisions.map((c) => c.criterionId),
    "visual decision coverage",
  );
  for (const criterion of rubric) {
    const score = decisions.find((c) => c.criterionId === criterion.id)!.score;
    if (score !== null && !validRubricScore(criterion, score))
      throw new Error(`Visual decision score is outside the anchors for ${criterion.id}`);
  }
  const required = rubric
    .filter((c) => c.required)
    .map((c) => ({
      minimum: c.minimumPassingScore,
      score: decisions.find((d) => d.criterionId === c.id)!.score,
    }));
  return {
    source: "required_criterion_scores",
    outcome: required.some((c) => c.score === null || c.minimum === null)
      ? "abstain"
      : required.some((c) => c.score! < c.minimum!)
        ? "reject"
        : "accept",
  };
}

export interface CriterionResult {
  criterionId: string;
  layer: EvaluationLayer;
  outcome: CriterionOutcome;
  score?: number;
  explanation: string;
  evidence: Hash[];
  /**
   * The Studio values that a code check read, in the sequence of its rule: one value for a fact,
   * the value before and after for a delta, and one value for each context of a cross-context
   * rule. Null for a source check, a judge check, a human score, or a check that read no value.
   */
  observed: JsonPrimitive[] | null;
}

/** A longer observed text is stored as its content hash, so a result stays small. */
const MAX_OBSERVED_TEXT = 256;

/** The stored form of one observed value. A text longer than the bound becomes its hash. */
export function observedValue(value: JsonPrimitive): JsonPrimitive {
  return typeof value === "string" && value.length > MAX_OBSERVED_TEXT
    ? `sha256:${contentHash(value)}`
    : value;
}

export function contentHash(value: string | Uint8Array): Hash {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  const serialized = JSON.stringify(normalizeJson(value, new Set<object>()));
  if (serialized === undefined) throw new Error("Value is not JSON-serializable");
  return serialized;
}

export function hashJson(value: unknown): Hash {
  return contentHash(stableJson(value));
}

/** Locale-independent ordering for anything that feeds a hash or identity, matching stableJson keys. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertPublicTask(value: unknown): asserts value is PublicTask {
  if (!isRecord(value) || value.schema !== TASK_SCHEMA) fail("task schema");
  assertExactRecordKeys(
    value,
    ["schema", "slug", "title", "prompt", "seed", "roles", "acceptance", "evidenceInstructions"],
    "task fields",
  );
  if (!isSlug(value.slug)) fail("task identity");
  if (!isText(value.title)) fail("task metadata");
  if (!isText(value.prompt) || !isRecord(value.seed)) fail("task prompt or seed");
  assertExactRecordKeys(value.seed, ["projectFile", "sourceRoots"], "task seed fields");
  if (!isSafeRelative(value.seed.projectFile) || !value.seed.projectFile.endsWith(".project.json"))
    fail("task project file");
  assertStringArray(value.seed.sourceRoots, "task source roots", isSafeRelative);
  const sourceRoots = value.seed.sourceRoots;
  if (
    sourceRoots.length === 0 ||
    new Set(sourceRoots).size !== sourceRoots.length ||
    sourceRoots.some((root, index) =>
      sourceRoots.some(
        (candidate, candidateIndex) => index !== candidateIndex && candidate.startsWith(`${root}/`),
      ),
    )
  )
    fail("task source roots must be non-overlapping, unique, and non-empty");
  assertStringArray(value.acceptance, "task acceptance", isText);
  assertStringArray(value.evidenceInstructions, "task evidence instructions", isText);
  assertSemanticRoles(value.roles);
  if (value.acceptance.length === 0) fail("task requires acceptance statements");
}

export function assertEvaluatorSpec(value: unknown): asserts value is EvaluatorSpec {
  if (!isRecord(value) || value.schema !== EVALUATOR_SCHEMA) fail("evaluator schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "task",
      "studio",
      "sequence",
      "deterministic",
      "codeQuality",
      "visual",
      "unscaled",
      "humanReview",
    ],
    "evaluator fields",
  );
  if (!isRecord(value.task) || !isSlug(value.task.slug)) fail("evaluator task identity");
  assertExactRecordKeys(value.task, ["slug"], "evaluator task fields");
  // Collect the errors of the plan and of each criterion, so one correction sees all of them.
  const errors: string[] = [];
  const collect = (label: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      errors.push(label + (error instanceof Error ? error.message : String(error)));
    }
  };
  const label = (section: string, criterion: unknown, index: number) =>
    `${section} criterion ${isRecord(criterion) && typeof criterion.id === "string" ? criterion.id : "without an ID"} (${section}/${index}): `;
  collect("", () => assertStudioCollectionPlan(value.studio));
  const studio = value.studio as StudioCollectionPlan;
  // The criteria refer to IDs in the plan. Without its phase and scenario lists, stop here.
  if (
    errors.length &&
    !(isRecord(studio) && Array.isArray(studio.phases) && Array.isArray(studio.scenarios))
  )
    throw new Error(errors[0]);
  collect("sequence: ", () => {
    if (value.sequence !== null) assertStudioSequenceView(value.sequence, studio);
  });
  if (
    !Array.isArray(value.deterministic) ||
    !Array.isArray(value.codeQuality) ||
    !Array.isArray(value.visual) ||
    !Array.isArray(value.unscaled)
  )
    fail("evaluator criteria");
  const criterionIds = new Set<string>();
  const factPhase = new Map(
    studio.phases.flatMap((phase) => phase.facts.map((fact) => [fact.id, phase.id] as const)),
  );
  const capturePhase = new Map(
    studio.phases.flatMap((phase) =>
      phase.captures.map((capture) => [capture.id, phase.id] as const),
    ),
  );
  const scenarios = new Map(studio.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const [index, criterion] of value.deterministic.entries())
    collect(label("deterministic", criterion, index), () => {
      if (
        !isRecord(criterion) ||
        !isId(criterion.id) ||
        criterion.id.startsWith("human:") ||
        criterionIds.has(criterion.id)
      )
        fail("deterministic criterion identity");
      assertExactRecordKeys(
        criterion,
        ["id", "layer", "statement", "required", "rule"],
        "deterministic criterion fields",
      );
      criterionIds.add(criterion.id);
      if (!STATIC_ENGINE_LAYERS.has(String(criterion.layer)) || !isText(criterion.statement))
        fail("deterministic criterion metadata");
      if (typeof criterion.required !== "boolean") fail("deterministic criterion required flag");
      assertDeterministicRule(criterion.rule);
      const staticRule =
        criterion.rule.kind === "path_exists" ||
        criterion.rule.kind === "source_contains" ||
        criterion.rule.kind === "source_lint_absent";
      if (
        (staticRule && criterion.layer !== "static") ||
        (!staticRule && criterion.layer !== "engine")
      )
        fail("criterion layer does not match its evidence authority");
      if (
        (criterion.rule.kind === "fact_equals" ||
          criterion.rule.kind === "fact_contains" ||
          criterion.rule.kind === "number_in_range" ||
          criterion.rule.kind === "diagnostics_empty") &&
        factPhase.get(criterion.rule.factId) !== criterion.rule.phaseId
      )
        fail("criterion references an unknown Studio fact");
      if (
        criterion.rule.kind === "capture_present" &&
        capturePhase.get(criterion.rule.captureId) !== criterion.rule.phaseId
      )
        fail("criterion references an unknown Studio capture");
      if (criterion.rule.kind === "build_errors_absent")
        for (const binding of criterion.rule.facts)
          if (boundFactKind(studio, binding) !== "diagnostics")
            fail(
              `build error rule ${criterion.id}: bind only diagnostics facts of the Studio plan`,
            );
      if (
        criterion.rule.kind === "gui_layout_holds" &&
        boundFactKind(studio, criterion.rule.fact) !== "gui_layout"
      )
        fail(`GUI layout rule ${criterion.id}: bind a gui_layout fact of the Studio plan`);
      if (
        criterion.rule.kind === "performance_within" &&
        boundFactKind(studio, {
          scenarioId: criterion.rule.scenarioId,
          stepId: criterion.rule.stepId,
          context: criterion.rule.context,
          factId: criterion.rule.factId,
        }) !== "performance_trace"
      )
        fail(`Performance rule ${criterion.id}: bind a performance_trace fact of the Studio plan`);
      if (
        (criterion.rule.kind === "capture_text_contrast" ||
          criterion.rule.kind === "capture_exposure") &&
        capturePhase.get(criterion.rule.captureId) !== criterion.rule.phaseId
      )
        fail(`Capture pixel rule ${criterion.id}: bind a capture of the Studio plan`);
      if (
        criterion.rule.kind === "capture_text_contrast" &&
        boundFactKind(studio, {
          phaseId: criterion.rule.phaseId,
          factId: criterion.rule.layoutFactId,
        }) !== "gui_layout"
      )
        fail(
          `Text contrast rule ${criterion.id}: bind a gui_layout fact of the phase of the capture`,
        );
      if (
        criterion.rule.kind === "scenario_action_succeeded" ||
        criterion.rule.kind === "scenario_barrier_passage" ||
        criterion.rule.kind === "scenario_fact_equals" ||
        criterion.rule.kind === "scenario_fact_equals_actor_user_id" ||
        criterion.rule.kind === "scenario_number_delta_in_range" ||
        criterion.rule.kind === "scenario_cross_context_equals" ||
        criterion.rule.kind === "scenario_step_within"
      ) {
        const scenario = scenarios.get(criterion.rule.scenarioId);
        if (!scenario) fail("criterion references an unknown Studio scenario");
        assertScenarioRuleReferences(criterion.rule, scenario);
      }
    });
  const captureIds = new Set(
    studio.phases.flatMap((phase) => phase.captures.map((capture) => capture.id)),
  );
  for (const [index, criterion] of value.codeQuality.entries())
    collect(label("codeQuality", criterion, index), () => {
      if (
        !isRecord(criterion) ||
        !isId(criterion.id) ||
        criterion.id.startsWith("human:") ||
        criterionIds.has(criterion.id)
      )
        fail("code-quality criterion identity");
      assertExactRecordKeys(
        criterion,
        [
          "id",
          "statement",
          "required",
          "sourceSelection",
          "anchors",
          "scoreRange",
          "minimumPassingScore",
        ],
        "code-quality criterion fields",
      );
      criterionIds.add(criterion.id);
      if (!isText(criterion.statement) || typeof criterion.required !== "boolean")
        fail("code-quality criterion metadata");
      if (!isRecord(criterion.sourceSelection)) fail("code-quality source selection");
      const selection = criterion.sourceSelection;
      if (selection.kind === "all_luau_in_roots") {
        assertExactRecordKeys(selection, ["kind", "roots"], "code-quality source roots");
        assertStringArray(selection.roots, "code-quality source roots", isSafeRelative);
        if (
          selection.roots.length === 0 ||
          new Set(selection.roots).size !== selection.roots.length
        )
          fail("code-quality source roots must be unique and non-empty");
      } else if (selection.kind === "exact_files") {
        assertExactRecordKeys(selection, ["kind", "paths"], "code-quality exact files");
        assertStringArray(selection.paths, "code-quality exact files", isSafeRelative);
        if (
          selection.paths.length === 0 ||
          new Set(selection.paths).size !== selection.paths.length ||
          selection.paths.some((path) => !/\.luau?$/u.test(path))
        )
          fail("code-quality exact files must be unique Luau source");
      } else fail("code-quality source selection kind");
      assertAnchoredCriterion(criterion, "code-quality");
    });
  for (const [index, criterion] of value.visual.entries())
    collect(label("visual", criterion, index), () => {
      if (
        !isRecord(criterion) ||
        !isId(criterion.id) ||
        criterion.id.startsWith("human:") ||
        criterionIds.has(criterion.id)
      )
        fail("visual criterion identity");
      assertExactRecordKeys(
        criterion,
        [
          "id",
          "statement",
          "required",
          "evidenceClass",
          "polarity",
          "captureIds",
          "sequence",
          "anchors",
          "scoreRange",
          "minimumPassingScore",
        ],
        "visual criterion fields",
      );
      criterionIds.add(criterion.id);
      if (
        !isText(criterion.statement) ||
        typeof criterion.required !== "boolean" ||
        (criterion.evidenceClass !== null && !isEvidenceClass(criterion.evidenceClass)) ||
        !isPolarity(criterion.polarity)
      )
        fail("visual criterion metadata");
      assertStringArray(criterion.captureIds, "visual capture IDs", isId);
      if (
        (!criterion.captureIds.length && !criterion.sequence) ||
        new Set(criterion.captureIds).size !== criterion.captureIds.length
      )
        fail("visual capture IDs must be unique and non-empty");
      if (
        typeof criterion.sequence !== "boolean" ||
        (criterion.sequence && value.sequence === null)
      )
        fail("visual sequence selection requires a declared sequence view");
      if (criterion.captureIds.some((id) => !captureIds.has(id)))
        fail("visual criterion references an unknown capture");
      assertAnchoredCriterion(criterion, "visual");
    });
  for (const [index, criterion] of value.unscaled.entries())
    collect(label("unscaled", criterion, index), () => {
      if (
        !isRecord(criterion) ||
        !isId(criterion.id) ||
        criterion.id.startsWith("human:") ||
        criterionIds.has(criterion.id)
      )
        fail("unscaled criterion identity");
      assertExactRecordKeys(
        criterion,
        ["id", "statement", "required", "evidenceClass", "polarity", "evidence"],
        "unscaled criterion fields",
      );
      criterionIds.add(criterion.id);
      if (
        !isText(criterion.statement) ||
        typeof criterion.required !== "boolean" ||
        (criterion.evidenceClass !== null && !isEvidenceClass(criterion.evidenceClass)) ||
        !isPolarity(criterion.polarity)
      )
        fail("unscaled criterion metadata");
      if (!isRecord(criterion.evidence)) fail("unscaled criterion evidence");
      assertExactRecordKeys(
        criterion.evidence,
        ["sourceSelection", "facts", "actions", "captureIds", "sequence"],
        "unscaled evidence channels",
      );
      if (
        typeof criterion.evidence.sequence !== "boolean" ||
        (criterion.evidence.sequence && value.sequence === null)
      )
        fail("unscaled sequence selection requires a declared sequence view");
      if (criterion.evidence.sourceSelection !== null) {
        const selection = criterion.evidence.sourceSelection;
        if (!isRecord(selection)) fail("unscaled source selection");
        if (selection.kind === "all_luau_in_roots") {
          assertExactRecordKeys(selection, ["kind", "roots"], "unscaled source roots");
          assertStringArray(selection.roots, "unscaled source roots", isSafeRelative);
          if (
            selection.roots.length === 0 ||
            new Set(selection.roots).size !== selection.roots.length
          )
            fail("unscaled source roots must be unique and non-empty");
        } else if (selection.kind === "exact_files") {
          assertExactRecordKeys(selection, ["kind", "paths"], "unscaled exact files");
          assertStringArray(selection.paths, "unscaled exact files", isSafeRelative);
          if (
            selection.paths.length === 0 ||
            new Set(selection.paths).size !== selection.paths.length ||
            selection.paths.some((path) => !/\.luau?$/u.test(path))
          )
            fail("unscaled exact files must be unique Luau source");
        } else fail("unscaled source selection kind");
      }
      {
        if (!Array.isArray(criterion.evidence.facts) || criterion.evidence.facts.length > 16)
          fail("unscaled Studio observation count");
        if (!Array.isArray(criterion.evidence.actions) || criterion.evidence.actions.length > 16)
          fail("unscaled Studio action count");
        assertStringArray(criterion.evidence.captureIds, "unscaled Studio capture IDs", isId);
        if (
          (!criterion.evidence.sourceSelection &&
            !criterion.evidence.sequence &&
            criterion.evidence.facts.length +
              criterion.evidence.actions.length +
              criterion.evidence.captureIds.length ===
              0) ||
          criterion.evidence.captureIds.length > 4 ||
          new Set(criterion.evidence.captureIds).size !== criterion.evidence.captureIds.length ||
          criterion.evidence.captureIds.some((id) => !captureIds.has(id))
        )
          fail(
            "unscaled evidence needs sealed source, distinct bound observations/actions, or captures",
          );
        const boundActions = new Set<string>();
        for (const binding of criterion.evidence.actions) {
          if (!isRecord(binding)) fail("unscaled Studio action binding");
          assertExactRecordKeys(
            binding,
            ["scenarioId", "stepId", "context"],
            "unscaled action binding",
          );
          if (!isId(binding.scenarioId) || !isId(binding.stepId) || !isId(binding.context))
            fail("unscaled Studio action binding");
          const key = `${binding.scenarioId}:${binding.stepId}:${binding.context}`;
          const scenario = studio.scenarios.find((item) => item.id === binding.scenarioId);
          const step = scenario?.steps.find((item) => item.id === binding.stepId);
          if (
            !scenario?.reportContexts.includes(binding.context) ||
            !step ||
            step.action.kind === "wait" ||
            step.action.actor !== binding.context
          )
            fail(`unscaled ${criterion.id} references missing performed action ${key}`);
          if (boundActions.has(key)) fail(`unscaled ${criterion.id} repeats action ${key}`);
          boundActions.add(key);
        }
        const boundFacts = new Set<string>();
        for (const binding of criterion.evidence.facts) {
          if (!isRecord(binding)) fail("unscaled Studio observation binding");
          let key: string;
          let exists: boolean;
          if (Object.hasOwn(binding, "phaseId")) {
            assertExactRecordKeys(
              binding,
              ["phaseId", "factId"],
              "unscaled phase observation binding",
            );
            if (!isId(binding.phaseId) || !isId(binding.factId))
              fail("unscaled phase observation binding");
            key = `phase:${binding.phaseId}:${binding.factId}`;
            exists = studio.phases.some(
              (phase) =>
                phase.id === binding.phaseId &&
                phase.facts.some((fact) => fact.id === binding.factId),
            );
          } else {
            assertExactRecordKeys(
              binding,
              ["scenarioId", "stepId", "context", "factId"],
              "unscaled scenario observation binding",
            );
            if (![binding.scenarioId, binding.stepId, binding.context, binding.factId].every(isId))
              fail("unscaled scenario observation binding");
            key = `scenario:${binding.scenarioId}:${binding.stepId}:${binding.context}:${binding.factId}`;
            exists = studio.scenarios.some(
              (scenario) =>
                scenario.id === binding.scenarioId &&
                scenario.steps.some(
                  (step) =>
                    step.id === binding.stepId &&
                    step.observations.some(
                      (observation) =>
                        observation.context === binding.context &&
                        observation.fact.id === binding.factId,
                    ),
                ),
            );
          }
          if (!exists)
            fail(
              `unscaled ${criterion.id} references missing Studio observation ${key}; action receipts are not observation facts`,
            );
          if (boundFacts.has(key))
            fail(`unscaled ${criterion.id} repeats Studio observation ${key}`);
          boundFacts.add(key);
        }
      }
    });
  collect("", () => assertStringArray(value.humanReview, "human review", isText));
  if (errors.length === 1) throw new Error(errors[0]);
  if (errors.length > 1)
    throw new Error(`${errors.length} evaluator errors:\n${errors.join("\n")}`);
  // A time bound must come from human text in this evaluator, never from a drafting model.
  const authoredText = [
    ...value.deterministic.map((criterion) => criterion.statement),
    ...value.codeQuality.map((criterion) => criterion.statement),
    ...value.visual.map((criterion) => criterion.statement),
    ...value.unscaled.map((criterion) => criterion.statement),
    ...(value.humanReview as string[]),
  ];
  for (const scenario of studio.scenarios)
    for (const step of scenario.steps)
      if (step.requirement && !authoredText.some((text) => text.includes(step.requirement!.quote)))
        fail(
          `Scenario ${scenario.id} step ${step.id} requirement quote: copy the exact rubric text of an authored criterion`,
        );
}

export function assertStudioCollectionPlan(value: unknown): asserts value is StudioCollectionPlan {
  if (!isRecord(value) || value.schema !== "basalt-evals/studio-plan") fail("Studio plan schema");
  assertExactRecordKeys(
    value,
    ["schema", "clients", "actors", "roles", "scenarios", "phases"],
    "Studio plan fields",
  );
  if (!isPositiveInteger(value.clients) || value.clients > MAX_STUDIO_CLIENTS)
    fail("Studio plan clients");
  assertStringArray(value.actors, "Studio plan actors", isId);
  if (
    value.actors.length !== value.clients ||
    new Set(value.actors).size !== value.actors.length ||
    value.actors.includes("server")
  )
    fail("Studio plan actors");
  if (!Array.isArray(value.scenarios) || value.scenarios.length > 32) fail("Studio plan scenarios");
  assertSemanticRoles(value.roles);
  const roleIds = new Set(value.roles.map((role) => role.id));
  const roleDefinitions = value.roles;
  const assertGuiRole = (path: string, textEntry: boolean) => {
    if (!path.startsWith("role.")) return;
    const role = roleDefinitions.find((item) => item.id === path.slice(5));
    if (
      !role ||
      role.scope !== "local_player_gui" ||
      (textEntry
        ? role.className !== "TextBox"
        : !(STUDIO_CAPABILITY_CATALOG.guiInputRoleClasses as readonly string[]).includes(
            role.className,
          ))
    )
      fail(
        `GUI input binding ${path}: declare a local_player_gui ${textEntry ? "TextBox" : "GuiObject"} role compatible with the selected input`,
      );
  };
  // A gui_layout observation reads one ScreenGui of the local player.
  const assertGuiLayoutPath = (fact: Record<string, unknown>) => {
    if (fact.kind !== "gui_layout") return;
    const path = String(fact.path);
    const role = path.startsWith("role.")
      ? roleDefinitions.find((item) => `role.${item.id}` === path)
      : null;
    if (
      role
        ? role.className !== "ScreenGui" || role.scope !== "local_player_gui"
        : !/^game\.Players\.LocalPlayer\.PlayerGui(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(path)
    )
      fail(
        `GUI layout path ${path}: use a local_player_gui ScreenGui role or a game.Players.LocalPlayer.PlayerGui.<name> path`,
      );
  };
  const actorIds = new Set(value.actors);
  const contexts = new Set(["server", ...value.actors]);
  const scenarioIds = new Set<string>();
  // Each scenario is checked on its own, so one correction can see the errors of all scenarios.
  const scenarioErrors: Error[] = [];
  for (const scenario of value.scenarios) {
    try {
      if (!isRecord(scenario) || !isId(scenario.id) || scenarioIds.has(scenario.id))
        fail("Studio scenario ID");
      scenarioIds.add(scenario.id);
      assertExactRecordKeys(
        scenario,
        ["id", "label", "durationMs", "reportContexts", "steps"],
        "Studio scenario fields",
      );
      if (
        !isText(scenario.label) ||
        !isPositiveInteger(scenario.durationMs) ||
        scenario.durationMs > MAX_STUDIO_SCENARIO_DURATION_MS
      )
        fail("Studio scenario metadata");
      assertStringArray(
        scenario.reportContexts,
        "Studio scenario report contexts",
        (entry): entry is string => typeof entry === "string" && contexts.has(entry),
      );
      if (
        scenario.reportContexts.length === 0 ||
        !scenario.reportContexts.includes("server") ||
        new Set(scenario.reportContexts).size !== scenario.reportContexts.length
      )
        fail("Studio scenario report contexts");
      if (
        !Array.isArray(scenario.steps) ||
        scenario.steps.length === 0 ||
        scenario.steps.length > 256
      )
        fail("Studio scenario steps");
      const stepIds = new Set<string>();
      let previousStartMs = -1;
      for (const step of scenario.steps) {
        if (!isRecord(step) || !isId(step.id) || stepIds.has(step.id))
          fail("Studio scenario step ID");
        assertExactRecordKeys(
          step,
          ["id", "at", "horizonMs", "holdMs", "action", "observations", "requirement"],
          "Studio scenario step fields",
        );
        const where = `Studio scenario ${scenario.id} step ${step.id}`;
        try {
          previousStartMs = assertStepTiming(
            step,
            scenario as unknown as { durationMs: number; reportContexts: string[] },
            stepIds,
            previousStartMs,
            actorIds,
            roleIds,
            roleDefinitions,
          );
        } catch (error) {
          throw new Error(
            `${where} timing: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          );
        }
        stepIds.add(step.id);
        try {
          assertStudioScenarioAction(step.action, actorIds, roleIds);
        } catch (error) {
          throw new Error(
            `Scenario ${scenario.id}, step ${step.id}, action: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        if (
          step.action.kind === "disconnect" &&
          scenario.reportContexts.includes(step.action.actor)
        )
          fail(
            `${where} disconnect: a client that leaves Play sends no report, also for steps before it leaves. Remove it from reportContexts, remove its observations and anchors in this scenario, and observe from the server or from a client that stays`,
          );
        if (step.action.kind === "probe_barrier" && 2_500 > scenario.durationMs)
          throw new Error(
            `${where}: barrier probe exceeds scenario duration. The probe needs 2500 ms, and the scenario has ${String(scenario.durationMs)} ms`,
          );
        if (step.action.kind === "gui_activate" || step.action.kind === "gui_text_entry")
          assertGuiRole(step.action.path, step.action.kind === "gui_text_entry");
        if (!Array.isArray(step.observations) || step.observations.length > 64)
          fail("Studio scenario observations");
        const observationKeys = new Set<string>();
        for (const observation of step.observations) {
          if (!isRecord(observation)) fail("Studio scenario observation");
          assertExactRecordKeys(
            observation,
            ["context", "fact"],
            "Studio scenario observation fields",
          );
          if (
            typeof observation.context !== "string" ||
            !scenario.reportContexts.includes(observation.context) ||
            !isRecord(observation.fact) ||
            !isId(observation.fact.id)
          )
            throw new Error(
              `${where}: each observation needs a fact with an ID and a context from reportContexts (${scenario.reportContexts.join(", ")})`,
            );
          const key = `${observation.context}:${observation.fact.id}`;
          if (observationKeys.has(key))
            throw new Error(
              `${where} observes fact ${observation.fact.id} in context ${observation.context} two times. Keep one observation, or give the other fact a new ID`,
            );
          observationKeys.add(key);
          try {
            assertStudioFact(observation.fact, actorIds, roleIds);
            if (observation.context === "server") assertNoServerLocalPlayerPath(observation.fact);
            if (observation.fact.kind === "performance_trace" && observation.context !== "server")
              throw new Error("performance_trace runs only in the server context");
            if (observation.fact.kind === "gui_layout" && observation.context === "server")
              throw new Error("gui_layout runs only in the client context of an actor");
            assertGuiLayoutPath(observation.fact);
          } catch (error) {
            throw new Error(
              `Scenario ${scenario.id}, step ${step.id}, context ${observation.context}, fact ${observation.fact.id}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          if (studioFactWindowMs(observation.fact as StudioFactRequest) > scenario.durationMs)
            throw new Error(
              `${where}, context ${observation.context}, fact ${observation.fact.id}: observation window exceeds the scenario budget of ${String(scenario.durationMs)} ms`,
            );
        }
        const at = step.at as StudioStepTiming;
        const guiScope =
          "after" in at && "fact" in at.after && at.after.fact.kind === "gui_visible"
            ? at.after.scope
            : null;
        if (
          guiScope !== null &&
          step.observations.some(
            (observation) => isRecord(observation) && observation.context !== guiScope,
          )
        )
          fail(`${where} observations: a gui_visible anchor can only anchor its own client`);
      }
    } catch (error) {
      scenarioErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (scenarioErrors.length === 1) throw scenarioErrors[0]!;
  if (scenarioErrors.length > 1)
    throw new Error(
      `${scenarioErrors.length} Studio scenarios have errors:\n${scenarioErrors.map((error) => error.message).join("\n")}`,
    );
  if (!Array.isArray(value.phases) || value.phases.length === 0) fail("Studio plan phases");
  const phaseIds = new Set<string>();
  const factIds = new Set<string>();
  const captureIds = new Set<string>();
  for (const phase of value.phases) {
    if (!isRecord(phase) || !isId(phase.id) || phaseIds.has(phase.id)) fail("Studio phase ID");
    assertExactRecordKeys(
      phase,
      ["id", "label", "instruction", "driver", "facts", "captures"],
      "Studio phase fields",
    );
    phaseIds.add(phase.id);
    if (!isText(phase.label) || !isText(phase.instruction)) fail("Studio phase instructions");
    if (!Array.isArray(phase.facts) || !Array.isArray(phase.captures)) fail("Studio phase data");
    for (const fact of phase.facts) {
      if (!isRecord(fact) || !isId(fact.id) || factIds.has(fact.id)) fail("Studio fact ID");
      factIds.add(fact.id);
      try {
        assertStudioFact(fact, undefined, roleIds);
        assertGuiLayoutPath(fact);
      } catch (error) {
        throw new Error(
          `Phase ${phase.id}, fact ${fact.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const driver = phase.driver;
    if (!isRecord(driver)) fail("Studio phase driver");
    if (driver.kind === "gui_button" && typeof driver.path === "string")
      assertGuiRole(driver.path, false);
    if (driver.kind === "manual") {
      assertExactRecordKeys(driver, ["kind"], "Studio manual driver");
    } else if (driver.kind === "wait_for_session") {
      assertExactRecordKeys(driver, ["kind", "timeoutMs"], "Studio session driver");
      if (!isPositiveInteger(driver.timeoutMs) || driver.timeoutMs > 60_000)
        fail("Studio session readiness timeout");
    } else if (driver.kind === "character_reach_part" || driver.kind === "observe_from_actor") {
      assertExactRecordKeys(
        driver,
        ["kind", "targetPath", "timeoutMs"],
        "Studio reach-part driver",
      );
      if (
        !isStudioInstanceRef(driver.targetPath, roleIds) ||
        !isPositiveInteger(driver.timeoutMs) ||
        driver.timeoutMs > 60_000
      )
        fail("Studio reach-part input");
      if (
        driver.kind === "observe_from_actor" &&
        !phase.facts.some(
          (fact) => isRecord(fact) && fact.kind === "instance" && fact.path === driver.targetPath,
        )
      )
        fail(
          `Actor view requires a same-phase instance observation of its target. Add {"kind":"instance","id":"<new id>","path":${JSON.stringify(driver.targetPath)}} to the facts of phase ${JSON.stringify(phase.id)}`,
        );
    } else if (
      driver.kind === "wait_for_fact" ||
      driver.kind === "wait_for_exists" ||
      driver.kind === "gui_button" ||
      driver.kind === "character_move_to"
    ) {
      const pathField = driver.kind === "gui_button" ? "path" : "targetPath";
      assertExactRecordKeys(
        driver,
        driver.kind === "wait_for_exists"
          ? ["kind", "readyFactId", "timeoutMs"]
          : driver.kind === "wait_for_fact"
            ? ["kind", "readyFactId", "readyValue", "timeoutMs"]
            : ["kind", pathField, "readyFactId", "readyValue", "timeoutMs"],
        "Studio driven input driver",
      );
      if (
        (driver.kind !== "wait_for_fact" &&
          driver.kind !== "wait_for_exists" &&
          !isStudioInstanceRef(driver[pathField], roleIds)) ||
        (driver.kind !== "wait_for_exists" && !isId(driver.readyValue)) ||
        !isPositiveInteger(driver.timeoutMs) ||
        driver.timeoutMs > 60_000 ||
        !phase.facts.some(
          (fact) =>
            isRecord(fact) &&
            fact.id === driver.readyFactId &&
            (fact.kind === "replication_probe" ||
              (driver.kind === "wait_for_exists" &&
                (fact.kind === "instance" || fact.kind === "instance_name"))),
        )
      )
        fail("Studio driven input readiness");
    } else fail("Studio phase driver kind");
    for (const capture of phase.captures) {
      if (!isRecord(capture) || !isId(capture.id) || captureIds.has(capture.id))
        fail("Studio capture ID");
      assertExactRecordKeys(capture, ["id", "instruction"], "Studio capture fields");
      captureIds.add(capture.id);
      if (!isText(capture.instruction)) fail("Studio capture instructions");
    }
  }
}

export function assertStudyDefinition(value: unknown): asserts value is StudyDefinition {
  if (!isRecord(value) || value.schema !== STUDY_SCHEMA) fail("study schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "id",
      "title",
      "hypothesis",
      "taskDirectories",
      "models",
      "transportConfigurationHash",
      "harnesses",
      "repetitions",
      "seed",
      "environment",
    ],
    "study fields",
  );
  if (!isId(value.id) || !isText(value.title) || !isText(value.hypothesis)) fail("study metadata");
  assertStringArray(value.taskDirectories, "study task directories", isSafeRelative);
  if (
    value.taskDirectories.length === 0 ||
    new Set(value.taskDirectories).size !== value.taskDirectories.length
  )
    fail("study task directories must be unique and non-empty");
  if (!Array.isArray(value.models) || value.models.length === 0) fail("study models");
  for (const model of value.models) assertStudyModel(model);
  if (new Set(value.models.map((model) => model.id)).size !== value.models.length)
    fail("study model IDs must be unique");
  if (!isHash(value.transportConfigurationHash)) fail("study transport configuration hash");
  if (!Array.isArray(value.harnesses) || value.harnesses.length === 0) fail("study harnesses");
  for (const harness of value.harnesses) assertHarnessDefinition(harness);
  if (new Set(value.harnesses.map((harness) => harness.id)).size !== value.harnesses.length)
    fail("study harness IDs must be unique");
  if (!isPositiveInteger(value.repetitions) || !isNonNegativeInteger(value.seed))
    fail("study repetitions or seed");
  if (
    value.taskDirectories.length *
      value.models.length *
      value.harnesses.length *
      value.repetitions >
    MAX_STUDY_TREATMENTS
  )
    fail(`study exceeds ${MAX_STUDY_TREATMENTS} treatments`);
  if (!isRecord(value.environment) || value.environment.platform !== "Roblox Studio")
    fail("study environment");
  assertExactRecordKeys(
    value.environment,
    ["platform", "studioVersion", "captureProtocol", "cameraProtocol"],
    "study environment fields",
  );
  if (!isText(value.environment.studioVersion) || !isText(value.environment.cameraProtocol))
    fail("study environment metadata");
  if (value.environment.captureProtocol !== "studio-mcp-viewport") fail("study capture protocol");
}

export function assertTreatment(value: unknown): asserts value is Treatment {
  if (!isRecord(value) || value.schema !== TREATMENT_SCHEMA) fail("treatment schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "id",
      "ordinal",
      "studyHash",
      "task",
      "model",
      "transportConfigurationHash",
      "harness",
      "repetition",
      "randomSeed",
      "environment",
    ],
    "treatment fields",
  );
  if (!isId(value.id) || !isPositiveInteger(value.ordinal) || !isHash(value.studyHash))
    fail("treatment identity");
  if (!isRecord(value.task)) fail("treatment task");
  assertExactRecordKeys(
    value.task,
    ["id", "publicTaskHash", "evaluatorHash", "seedHash", "collectionPlanHash"],
    "treatment task fields",
  );
  if (
    typeof value.task.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{12}$/.test(value.task.id)
  )
    fail("treatment task ID");
  for (const field of [
    "publicTaskHash",
    "evaluatorHash",
    "seedHash",
    "collectionPlanHash",
  ] as const)
    if (!isHash(value.task[field])) fail(`treatment task ${field}`);
  assertStudyModel(value.model);
  if (!isHash(value.transportConfigurationHash)) fail("treatment transport hash");
  assertHarnessDefinition(value.harness);
  if (
    !isPositiveInteger(value.repetition) ||
    !isNonNegativeInteger(value.randomSeed) ||
    !isStudyEnvironment(value.environment)
  )
    fail("treatment repetition, seed, or environment");
  const body = {
    ordinal: value.ordinal,
    studyHash: value.studyHash,
    task: value.task,
    model: value.model,
    transportConfigurationHash: value.transportConfigurationHash,
    harness: value.harness,
    repetition: value.repetition,
    randomSeed: value.randomSeed,
    environment: value.environment,
  };
  if (value.id !== `tr-${hashJson(body).slice(0, 20)}`) fail("treatment content identity");
}

export function assertFrozenStudy(value: unknown): asserts value is FrozenStudy {
  if (!isRecord(value) || value.schema !== "basalt-evals/frozen-study") fail("frozen study schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "frozenAt",
      "study",
      "studyHash",
      "implementationCommit",
      "dirty",
      "connectorSourceHash",
      "connectorArtifactHash",
      "tasks",
      "treatments",
    ],
    "frozen study fields",
  );
  assertIso(value.frozenAt, "frozen study timestamp");
  assertStudyDefinition(value.study);
  if (value.studyHash !== hashJson(value.study)) fail("frozen study hash");
  if (
    typeof value.implementationCommit !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.implementationCommit) ||
    typeof value.dirty !== "boolean" ||
    !isHash(value.connectorSourceHash) ||
    !isHash(value.connectorArtifactHash)
  )
    fail("frozen study implementation binding");
  if (!Array.isArray(value.tasks) || value.tasks.length !== value.study.taskDirectories.length)
    fail("frozen study tasks");
  const taskIds = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (!isRecord(task)) fail("frozen task");
    assertExactRecordKeys(
      task,
      ["id", "directory", "publicTaskHash", "evaluatorHash", "seedHash", "collectionPlanHash"],
      "frozen task fields",
    );
    if (
      typeof task.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{12}$/.test(task.id) ||
      taskIds.has(task.id) ||
      task.directory !== value.study.taskDirectories[index]
    )
      fail("frozen task identity");
    taskIds.add(task.id);
    for (const field of [
      "publicTaskHash",
      "evaluatorHash",
      "seedHash",
      "collectionPlanHash",
    ] as const)
      if (!isHash(task[field])) fail(`frozen task ${field}`);
  }
  const expectedTreatments =
    value.tasks.length *
    value.study.models.length *
    value.study.harnesses.length *
    value.study.repetitions;
  if (!Array.isArray(value.treatments) || value.treatments.length !== expectedTreatments)
    fail("frozen study treatments");
  const treatmentIds = new Set<string>();
  const treatmentCombinations = new Set<string>();
  const tasksById = new Map(value.tasks.map((task) => [task.id, task] as const));
  const study = value.study;
  const expectedMatrix = value.tasks.flatMap((task) =>
    study.models.flatMap((model) =>
      study.harnesses.flatMap((harness) =>
        Array.from({ length: study.repetitions }, (_, index) => ({
          task,
          model,
          harness,
          repetition: index + 1,
        })),
      ),
    ),
  );
  for (const [index, treatment] of value.treatments.entries()) {
    assertTreatment(treatment);
    const expected = expectedMatrix[index];
    if (expected === undefined) fail("frozen treatment matrix");
    const frozenTask = tasksById.get(treatment.task.id);
    const combination = stableJson({
      task: treatment.task.id,
      model: treatment.model.id,
      harness: treatment.harness.id,
      repetition: treatment.repetition,
    });
    const expectedSeed = Number.parseInt(
      contentHash(
        `${value.study.seed}:${treatment.task.id}:${treatment.model.id}:${treatment.repetition}`,
      ).slice(0, 8),
      16,
    );
    if (
      treatment.ordinal !== index + 1 ||
      treatment.task.id !== expected.task.id ||
      hashJson(treatment.model) !== hashJson(expected.model) ||
      hashJson(treatment.harness) !== hashJson(expected.harness) ||
      treatment.repetition !== expected.repetition ||
      treatment.studyHash !== value.studyHash ||
      treatment.transportConfigurationHash !== value.study.transportConfigurationHash ||
      frozenTask === undefined ||
      treatment.task.publicTaskHash !== frozenTask.publicTaskHash ||
      treatment.task.evaluatorHash !== frozenTask.evaluatorHash ||
      treatment.task.seedHash !== frozenTask.seedHash ||
      treatment.task.collectionPlanHash !== frozenTask.collectionPlanHash ||
      treatment.repetition > value.study.repetitions ||
      treatment.randomSeed !== expectedSeed ||
      treatmentIds.has(treatment.id) ||
      treatmentCombinations.has(combination) ||
      !value.study.models.some((model) => hashJson(model) === hashJson(treatment.model)) ||
      !value.study.harnesses.some((harness) => hashJson(harness) === hashJson(treatment.harness)) ||
      hashJson(treatment.environment) !== hashJson(value.study.environment)
    )
      fail("frozen treatment binding");
    const body = {
      ordinal: treatment.ordinal,
      studyHash: treatment.studyHash,
      task: treatment.task,
      model: treatment.model,
      transportConfigurationHash: treatment.transportConfigurationHash,
      harness: treatment.harness,
      repetition: treatment.repetition,
      randomSeed: treatment.randomSeed,
      environment: treatment.environment,
    };
    if (treatment.id !== `tr-${hashJson(body).slice(0, 20)}`) fail("frozen treatment identity");
    treatmentIds.add(treatment.id);
    treatmentCombinations.add(combination);
  }
}

export function assertAgentRun(value: unknown): asserts value is AgentRun {
  if (!isRecord(value) || value.schema !== AGENT_RUN_SCHEMA) fail("agent run schema");
  const expectedFields = [
    "schema",
    "id",
    "treatmentId",
    "startedAt",
    "endedAt",
    "status",
    "stopReason",
    "candidate",
    "usage",
    "trace",
    ...(value.failure === undefined ? [] : ["failure"]),
  ];
  assertExactRecordKeys(value, expectedFields, "agent run fields");
  if (!isId(value.id) || !isId(value.treatmentId)) fail("agent run identity");
  assertIso(value.startedAt, "agent run start");
  assertIso(value.endedAt, "agent run end");
  if (value.endedAt < value.startedAt) fail("agent run interval");
  if (!new Set(["locally_eligible", "rejected", "incomplete"]).has(String(value.status)))
    fail("agent run status");
  if (
    !new Set([
      "finished",
      "turn_limit",
      "context_limit",
      "spending_limit",
      "output_limit",
      "provider_error",
      "refusal",
      "invalid_tool_call",
      "cancelled",
    ]).has(String(value.stopReason))
  )
    fail("agent run stop reason");
  assertCandidateManifest(value.candidate);
  if (!isRecord(value.usage)) fail("agent run usage");
  assertExactRecordKeys(
    value.usage,
    [
      "calls",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "estimatedCostUsd",
      "providerReportedCostUsd",
    ],
    "agent run usage fields",
  );
  if (!isNonNegativeInteger(value.usage.calls)) fail("agent run call count");
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const)
    if (!isNullableNonNegativeInteger(value.usage[field])) fail(`agent run ${field}`);
  for (const field of ["estimatedCostUsd", "providerReportedCostUsd"] as const)
    if (!isNullableFiniteNonNegative(value.usage[field])) fail(`agent run ${field}`);
  if (!Array.isArray(value.trace) || value.trace.length > MAX_AGENT_TRACE_EVENTS)
    fail("agent run trace");
  let modelRequests = 0;
  let modelResponses = 0;
  let preDispatchStops = 0;
  // A provider pause after dispatch is a call without a turn. A hold before dispatch is no call.
  let pausedCalls = 0;
  let providerHolds = 0;
  // A compaction is a call without a turn. Each one ends at one boundary.
  let compactions = 0;
  let boundaries = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let gates = 0;
  for (const [index, event] of value.trace.entries()) {
    if (!isRecord(event)) fail("agent trace event");
    assertExactRecordKeys(event, ["sequence", "at", "kind", "data"], "agent trace fields");
    if (
      event.sequence !== index + 1 ||
      !new Set([
        "model_request",
        "model_response",
        "tool_call",
        "tool_result",
        "tool_rejection",
        "boundary",
        "gate",
      ]).has(String(event.kind)) ||
      !isRecord(event.data)
    )
      fail("agent trace event");
    assertIso(event.at, "agent trace timestamp");
    if (event.at < value.startedAt || event.at > value.endedAt) fail("agent trace interval");
    if (event.kind === "model_request") modelRequests += 1;
    if (event.kind === "model_response") {
      modelResponses += 1;
      if (
        event.data.kind === "spending_limit" ||
        event.data.kind === "admission_blocked" ||
        event.data.kind === "provider_hold" ||
        event.data.errorClass === "local_request_validation"
      )
        preDispatchStops += 1;
      if (event.data.kind === "provider_paused") pausedCalls += 1;
      if (event.data.kind === "provider_hold") providerHolds += 1;
      if (event.data.kind === "compaction") compactions += 1;
    }
    if (event.kind === "boundary") boundaries += 1;
    if (event.kind === "tool_call") toolCalls += 1;
    if (event.kind === "tool_result") toolResults += 1;
    if (event.kind === "tool_rejection") {
      assertExactRecordKeys(event.data, ["proposed", "reason", "responseHash"], "tool rejection");
      if (
        !isNonNegativeInteger(event.data.proposed) ||
        event.data.proposed < 1 ||
        event.data.proposed > 16 ||
        event.data.reason !== "invalid_tool_batch" ||
        !isHash(event.data.responseHash)
      )
        fail("tool rejection");
    }
    if (event.kind === "gate") gates += 1;
    stableJson(event.data);
  }
  if (
    value.usage.calls - pausedCalls - compactions > MAX_HARNESS_TURNS ||
    pausedCalls + providerHolds > MAX_PROVIDER_PAUSES ||
    compactions > MAX_HARNESS_SUMMARIES ||
    boundaries !== compactions
  )
    fail("agent run call count");
  if (
    modelRequests - preDispatchStops !== value.usage.calls ||
    modelResponses - preDispatchStops !== value.usage.calls ||
    toolCalls !== toolResults ||
    gates !== 1 ||
    value.trace.at(-1)?.kind !== "gate"
  )
    fail("agent trace accounting");
  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) fail("agent run failure");
    assertExactRecordKeys(value.failure, ["classification", "detail"], "agent failure fields");
    if (
      !FAILURE_CLASSIFICATIONS.has(String(value.failure.classification)) ||
      !isText(value.failure.detail)
    )
      fail("agent run failure");
  }
  if (
    (value.status === "locally_eligible" &&
      (value.stopReason !== "finished" || value.failure !== undefined)) ||
    (value.status !== "locally_eligible" && value.failure === undefined)
  )
    fail("agent run outcome binding");
  const body = {
    treatmentId: value.treatmentId,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    status: value.status,
    stopReason: value.stopReason,
    candidate: value.candidate,
    usage: value.usage,
    trace: value.trace,
    ...(value.failure === undefined ? {} : { failure: value.failure }),
  };
  if (value.id !== `run-${hashJson(body).slice(0, 20)}`) fail("agent run content identity");
}

export function assertCandidateManifest(value: unknown): asserts value is CandidateManifest {
  if (!isRecord(value) || !isHash(value.rootHash) || !isSafeRelative(value.projectFile))
    fail("candidate manifest");
  assertExactRecordKeys(value, ["rootHash", "projectFile", "files"], "candidate manifest fields");
  if (!Array.isArray(value.files) || value.files.length > MAX_CANDIDATE_FILES)
    fail("candidate files");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !isSafeRelative(file.path) ||
      paths.has(file.path) ||
      !isHash(file.hash) ||
      !isNonNegativeInteger(file.bytes)
    )
      fail("candidate file");
    assertExactRecordKeys(file, ["path", "hash", "bytes"], "candidate file fields");
    paths.add(file.path);
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CANDIDATE_BYTES)
      fail("candidate byte limit");
  }
  const files = value.files as CandidateFile[];
  if (
    files.length === 0 ||
    files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path) ||
    !paths.has(value.projectFile) ||
    value.rootHash !== hashJson(files)
  )
    fail("candidate manifest identity");
}

export function assertStudioEvidence(value: unknown): asserts value is StudioEvidence {
  if (!isRecord(value) || value.schema !== STUDIO_EVIDENCE_SCHEMA) fail("Studio evidence schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "id",
      "treatmentId",
      "candidateHash",
      "collectionPlanHash",
      "connectorSourceHash",
      "connectorArtifactHash",
      "place",
      "studio",
      "startedAt",
      "endedAt",
      "scenarios",
      "phases",
    ],
    "Studio evidence fields",
  );
  for (const field of ["id", "treatmentId"] as const)
    if (!isId(value[field])) fail(`Studio ${field}`);
  for (const field of [
    "candidateHash",
    "collectionPlanHash",
    "connectorSourceHash",
    "connectorArtifactHash",
  ] as const)
    if (!isHash(value[field])) fail(`Studio ${field}`);
  if (!isRecord(value.place) || !isSafeRelative(value.place.file) || !isHash(value.place.hash))
    fail("Studio place");
  assertExactRecordKeys(value.place, ["file", "hash"], "Studio place fields");
  if (!isRecord(value.studio) || !isText(value.studio.version) || !isId(value.studio.sessionId))
    fail("Studio session");
  assertExactRecordKeys(value.studio, ["version", "sessionId"], "Studio session fields");
  assertIso(value.startedAt, "Studio start");
  assertIso(value.endedAt, "Studio end");
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) fail("Studio evidence interval");
  if (!Array.isArray(value.scenarios) || value.scenarios.length > 32)
    fail("Studio evidence scenarios");
  const scenarioIds = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!isRecord(scenario) || !isId(scenario.scenarioId) || scenarioIds.has(scenario.scenarioId))
      fail("Studio evidence scenario");
    assertExactRecordKeys(
      scenario,
      ["scenarioId", "startedAt", "endedAt", "reports"],
      "Studio evidence scenario fields",
    );
    scenarioIds.add(scenario.scenarioId);
    assertIso(scenario.startedAt, "Studio scenario start");
    assertIso(scenario.endedAt, "Studio scenario end");
    if (scenario.endedAt < scenario.startedAt) fail("Studio scenario interval");
    if (
      !Array.isArray(scenario.reports) ||
      scenario.reports.length === 0 ||
      scenario.reports.length > 9
    )
      fail("Studio scenario reports");
    const contexts = new Set<string>();
    for (const report of scenario.reports) {
      if (!isRecord(report) || !isId(report.context) || contexts.has(report.context))
        fail("Studio scenario report context");
      assertExactRecordKeys(
        report,
        ["context", "startAt", "actors", "steps"],
        "Studio scenario report fields",
      );
      if (!isStudioClockTime(report.startAt)) fail("Studio scenario report start");
      contexts.add(report.context);
      if (!Array.isArray(report.actors) || report.actors.length === 0 || report.actors.length > 8)
        fail("Studio scenario report actors");
      const actorIds = new Set<string>();
      const userIds = new Set<number>();
      for (const actor of report.actors) {
        if (
          !isRecord(actor) ||
          !isId(actor.actor) ||
          actorIds.has(actor.actor) ||
          typeof actor.userId !== "number" ||
          !Number.isSafeInteger(actor.userId) ||
          userIds.has(actor.userId) ||
          !isBoundedTrimmedText(actor.name, 128)
        )
          fail("Studio scenario report actor");
        assertExactRecordKeys(
          actor,
          ["actor", "userId", "name"],
          "Studio scenario report actor fields",
        );
        actorIds.add(actor.actor);
        userIds.add(actor.userId);
      }
      if (!Array.isArray(report.steps) || report.steps.length === 0 || report.steps.length > 256)
        fail("Studio scenario report steps");
      const stepIds = new Set<string>();
      for (const step of report.steps) {
        assertStudioStepReport(step);
        if (stepIds.has(step.stepId)) fail("Studio scenario report step");
        stepIds.add(step.stepId);
      }
    }
  }
  if (!Array.isArray(value.phases) || value.phases.length === 0) fail("Studio evidence phases");
  const phaseIds = new Set<string>();
  const factIds = new Set<string>();
  const captureIds = new Set<string>();
  for (const phase of value.phases) {
    if (!isRecord(phase) || !isId(phase.phaseId) || phaseIds.has(phase.phaseId))
      fail("Studio evidence phase");
    assertExactRecordKeys(
      phase,
      ["phaseId", "observations", "captures"],
      "Studio evidence phase fields",
    );
    phaseIds.add(phase.phaseId);
    if (!Array.isArray(phase.observations) || !Array.isArray(phase.captures))
      fail("Studio evidence phase contents");
    for (const observation of phase.observations) {
      assertStudioObservation(observation);
      if (factIds.has(observation.factId)) fail("duplicate Studio evidence fact");
      factIds.add(observation.factId);
    }
    for (const capture of phase.captures) {
      if (
        !isRecord(capture) ||
        !isId(capture.captureId) ||
        captureIds.has(capture.captureId) ||
        !isSafeRelative(capture.file) ||
        !isHash(capture.hash) ||
        !isPositiveInteger(capture.bytes) ||
        capture.bytes > MAX_CAPTURE_BYTES ||
        !new Set(["image/png", "image/jpeg"]).has(String(capture.mediaType)) ||
        !isPositiveInteger(capture.width) ||
        capture.width > 8_192 ||
        !isPositiveInteger(capture.height) ||
        capture.height > 8_192 ||
        capture.width * capture.height > MAX_CAPTURE_PIXELS
      )
        fail("Studio evidence capture");
      assertExactRecordKeys(
        capture,
        ["captureId", "file", "hash", "bytes", "mediaType", "width", "height", "sceneText"],
        "Studio evidence capture fields",
      );
      assertSceneTextObservation(capture.sceneText);
      captureIds.add(capture.captureId);
    }
  }
  const body = {
    treatmentId: value.treatmentId,
    candidateHash: value.candidateHash,
    collectionPlanHash: value.collectionPlanHash,
    connectorSourceHash: value.connectorSourceHash,
    connectorArtifactHash: value.connectorArtifactHash,
    place: value.place,
    studio: value.studio,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    scenarios: value.scenarios,
    phases: value.phases,
  };
  if (value.id !== `evidence-${hashJson(body).slice(0, 20)}`)
    fail("Studio evidence content identity");
}

/** A Studio server clock time in seconds. */
export function isStudioClockTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const STEP_REPORT_OPTIONAL_FIELDS = [
  "anchorObservedAt",
  "pollIntervalMs",
  "anchorPreexisting",
  "scheduledAt",
  "actedAt",
  "capturedAt",
  "action",
] as const;

/** The shape and internal consistency of one context's record of one step. */
export function assertStudioStepReport(value: unknown): asserts value is StudioScenarioStepReport {
  if (!isRecord(value) || !isId(value.stepId)) fail("Studio scenario report step");
  assertExactRecordKeys(
    value,
    [
      "stepId",
      "outcome",
      "dueAt",
      "observations",
      ...STEP_REPORT_OPTIONAL_FIELDS.filter((field) => value[field] !== undefined),
    ],
    "Studio scenario report step fields",
  );
  const label = `Studio scenario report step ${value.stepId}`;
  if (!STUDIO_STEP_OUTCOMES.includes(value.outcome as StudioStepOutcome)) fail(`${label} outcome`);
  for (const field of ["dueAt", "anchorObservedAt", "scheduledAt", "actedAt", "capturedAt"])
    if ((field === "dueAt" || value[field] !== undefined) && !isStudioClockTime(value[field]))
      fail(`${label} ${field}`);
  if (value.pollIntervalMs !== undefined && !isFiniteNonNegative(value.pollIntervalMs))
    fail(`${label} poll interval`);
  if (value.anchorPreexisting !== undefined && value.anchorPreexisting !== true)
    fail(`${label} preexisting anchor`);
  const observed = value.outcome === "observed";
  if (observed && (value.anchorObservedAt === undefined || value.scheduledAt === undefined))
    fail(`${label}: an observed step records anchorObservedAt and scheduledAt`);
  if ((value.action === undefined) !== (value.actedAt === undefined) || (value.action && !observed))
    fail(`${label}: only an observed step records an action and actedAt together`);
  // The runner never schedules a step before its anchor and never starts it early.
  const scheduledAt = value.scheduledAt as number | undefined;
  if (
    scheduledAt !== undefined &&
    ((value.anchorObservedAt !== undefined && scheduledAt < (value.anchorObservedAt as number)) ||
      (value.actedAt !== undefined && (value.actedAt as number) < scheduledAt) ||
      (value.capturedAt !== undefined && (value.capturedAt as number) < scheduledAt))
  )
    fail(`${label}: a step time is before its anchor or its schedule`);
  if (!Array.isArray(value.observations) || value.observations.length > 64)
    fail(`${label} observations`);
  if (
    (value.capturedAt === undefined) !== (value.observations.length === 0) ||
    (value.capturedAt !== undefined && !observed)
  )
    fail(`${label}: only an observed step records capturedAt and its observations together`);
  if (value.action !== undefined) {
    if (!isRecord(value.action)) fail("Studio scenario action receipt");
    assertExactRecordKeys(
      value.action,
      ["kind", "succeeded", ...(value.action.probe === undefined ? [] : ["probe"])],
      "Studio scenario action receipt fields",
    );
    if (
      !SCENARIO_ACTION_KINDS.has(String(value.action.kind)) ||
      typeof value.action.succeeded !== "boolean"
    )
      fail("Studio scenario action receipt");
    if (value.action.kind === "probe_barrier") {
      if (value.action.succeeded) assertBarrierTrajectory(value.action.probe);
      else if (value.action.probe !== undefined) fail("failed barrier probe contains samples");
    } else if (value.action.probe !== undefined) fail("non-probe action contains trajectory");
  }
  const factIds = new Set<string>();
  for (const observation of value.observations) {
    assertStudioObservation(observation);
    if (factIds.has(observation.factId)) fail("duplicate Studio scenario fact");
    factIds.add(observation.factId);
  }
}

function assertSameIds(expected: string[], actual: string[], label: string): void {
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  if (
    sortedExpected.length !== sortedActual.length ||
    sortedExpected.some((id, index) => id !== sortedActual[index])
  )
    fail(label);
}

export function isSafeRelativePath(value: unknown): value is string {
  return isSafeRelative(value);
}

export function assertStudioObservation(value: unknown): asserts value is StudioObservation {
  if (isRecord(value) && value.kind === "binding_failure") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "requestedKind", "path", "reason"],
      "binding failure fields",
    );
    if (
      !isId(value.factId) ||
      !STUDIO_FACT_KINDS.has(String(value.requestedKind)) ||
      typeof value.path !== "string" ||
      !/^role\.[a-z][a-z0-9_-]{0,63}$/u.test(value.path) ||
      ![
        "missing",
        "ambiguous",
        "wrong_class",
        "wrong_scope",
        "unavailable_scope",
        "undeclared_role",
      ].includes(String(value.reason))
    )
      fail("binding failure");
    return;
  }
  if (!isRecord(value) || !isId(value.factId) || !STUDIO_FACT_KINDS.has(String(value.kind)))
    fail("Studio observation");
  if (value.kind === "diagnostics") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "messages", "scriptErrors"],
      "diagnostic observation fields",
    );
    assertStringArray(
      value.messages,
      "diagnostic messages",
      (entry): entry is string => typeof entry === "string" && entry.length <= 16_384,
    );
    if (
      value.messages.length > DIAGNOSTIC_CHANNEL_LIMIT ||
      !Array.isArray(value.scriptErrors) ||
      value.scriptErrors.length > DIAGNOSTIC_CHANNEL_LIMIT
    )
      fail("diagnostic channel bounds");
    for (const entry of value.scriptErrors) {
      if (!isRecord(entry)) fail("script diagnostic");
      assertExactRecordKeys(entry, ["message", "stackTrace", "source"], "script diagnostic fields");
      if (
        typeof entry.message !== "string" ||
        entry.message.length > 16_384 ||
        typeof entry.stackTrace !== "string" ||
        entry.stackTrace.length > 16_384 ||
        !isRecord(entry.source)
      )
        fail("script diagnostic content");
      if (entry.source.kind === "unavailable") {
        assertExactRecordKeys(entry.source, ["kind"], "unavailable script origin");
      } else if (entry.source.kind === "script") {
        assertExactRecordKeys(
          entry.source,
          ["kind", "path", "className", "inDataModel"],
          "script origin fields",
        );
        if (
          !isText(entry.source.path) ||
          entry.source.path.length > 2048 ||
          !isText(entry.source.className) ||
          entry.source.className.length > 80 ||
          typeof entry.source.inDataModel !== "boolean"
        )
          fail("script origin");
      } else fail("script origin kind");
    }
    return;
  }
  if (value.kind === "instance") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "className"],
      "instance observation fields",
    );
    if (typeof value.exists !== "boolean" || typeof value.className !== "string")
      fail("instance observation");
    return;
  }
  if (value.kind === "instance_name") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "name"],
      "instance-name observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.name !== "string" ||
      value.name.length > 16_384
    )
      fail("instance-name observation");
    return;
  }
  if (value.kind === "instance_value") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "className", "value"],
      "instance-value observation fields",
    );
    // The class fixes the type of the value. An absent value has the fallback false.
    const valid =
      value.exists === false
        ? value.className === "" && value.value === false
        : value.exists === true &&
          ((value.className === "IntValue" && Number.isInteger(value.value)) ||
            (value.className === "NumberValue" && isFiniteNumber(value.value)) ||
            (value.className === "BoolValue" && typeof value.value === "boolean") ||
            (value.className === "StringValue" &&
              typeof value.value === "string" &&
              value.value.length <= 65_536));
    if (!valid) fail("instance-value observation");
    return;
  }
  if (value.kind === "part_motion") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "samples", "delta"],
      "motion observation fields",
    );
    if (
      !Array.isArray(value.samples) ||
      value.samples.length > 480 ||
      !isFiniteNonNegative(value.delta)
    )
      fail("motion observation");
    let previousMs = -1;
    let maximumDelta = 0;
    let origin: { x: number; y: number; z: number } | undefined;
    for (const sample of value.samples) {
      if (
        !isRecord(sample) ||
        !isFiniteNonNegative(sample.elapsedMs) ||
        (origin === undefined ? sample.elapsedMs !== 0 : sample.elapsedMs <= previousMs) ||
        !isFiniteNumber(sample.x) ||
        !isFiniteNumber(sample.y) ||
        !isFiniteNumber(sample.z)
      )
        fail("motion sample");
      assertExactRecordKeys(sample, ["elapsedMs", "x", "y", "z"], "motion sample fields");
      previousMs = sample.elapsedMs;
      origin ??= { x: sample.x, y: sample.y, z: sample.z };
      maximumDelta = Math.max(
        maximumDelta,
        Math.hypot(sample.x - origin.x, sample.y - origin.y, sample.z - origin.z),
      );
    }
    // Roblox Vector3 arithmetic uses float32; permit only rounding error in the
    // reported magnitude, never an unsupported distance or empty moving trace.
    if (
      !Number.isFinite(maximumDelta) ||
      (value.samples.length === 0 && value.delta !== 0) ||
      Math.abs(value.delta - maximumDelta) > 1e-6 * Math.max(1, maximumDelta)
    )
      fail("motion delta does not match samples");
    return;
  }
  if (value.kind === "actor_part_motion") {
    assertExactRecordKeys(
      value,
      [
        "factId",
        "kind",
        "actor",
        "exists",
        "samples",
        "partDelta",
        "actorDelta",
        "maxRelativeDelta",
      ],
      "actor-part motion observation fields",
    );
    if (
      typeof value.actor !== "string" ||
      !isId(value.actor) ||
      typeof value.exists !== "boolean" ||
      !Array.isArray(value.samples) ||
      value.samples.length > 480 ||
      !isFiniteNonNegative(value.partDelta) ||
      !isFiniteNonNegative(value.actorDelta) ||
      !isFiniteNonNegative(value.maxRelativeDelta) ||
      value.exists !== value.samples.length > 0
    )
      fail("actor-part motion observation");
    let previousMs = -1;
    let first:
      | { x: number; y: number; z: number; actorX: number; actorY: number; actorZ: number }
      | undefined;
    let partDelta = 0;
    let actorDelta = 0;
    let maxRelativeDelta = 0;
    for (const sample of value.samples) {
      if (
        !isRecord(sample) ||
        !isFiniteNonNegative(sample.elapsedMs) ||
        (first === undefined ? sample.elapsedMs !== 0 : sample.elapsedMs <= previousMs) ||
        ![
          sample.x,
          sample.y,
          sample.z,
          sample.actorX,
          sample.actorY,
          sample.actorZ,
          sample.localX,
          sample.localY,
          sample.localZ,
          sample.sizeX,
          sample.sizeY,
          sample.sizeZ,
        ].every(isFiniteNumber) ||
        !isFiniteNumber(sample.sizeX) ||
        sample.sizeX <= 0 ||
        !isFiniteNumber(sample.sizeY) ||
        sample.sizeY <= 0 ||
        !isFiniteNumber(sample.sizeZ) ||
        sample.sizeZ <= 0
      )
        fail("actor-part motion sample");
      assertExactRecordKeys(
        sample,
        [
          "elapsedMs",
          "x",
          "y",
          "z",
          "actorX",
          "actorY",
          "actorZ",
          "localX",
          "localY",
          "localZ",
          "sizeX",
          "sizeY",
          "sizeZ",
        ],
        "actor-part motion sample fields",
      );
      const point = sample as {
        x: number;
        y: number;
        z: number;
        actorX: number;
        actorY: number;
        actorZ: number;
      };
      previousMs = sample.elapsedMs;
      first ??= point;
      partDelta = Math.max(
        partDelta,
        Math.hypot(point.x - first.x, point.y - first.y, point.z - first.z),
      );
      actorDelta = Math.max(
        actorDelta,
        Math.hypot(
          point.actorX - first.actorX,
          point.actorY - first.actorY,
          point.actorZ - first.actorZ,
        ),
      );
      maxRelativeDelta = Math.max(
        maxRelativeDelta,
        Math.hypot(
          point.actorX - point.x - (first.actorX - first.x),
          point.actorY - point.y - (first.actorY - first.y),
          point.actorZ - point.z - (first.actorZ - first.z),
        ),
      );
    }
    const summaries: Array<[number, number]> = [
      [value.partDelta, partDelta],
      [value.actorDelta, actorDelta],
      [value.maxRelativeDelta, maxRelativeDelta],
    ];
    for (const [actual, expected] of summaries)
      if (Math.abs(actual - expected) > 1e-6 * Math.max(1, expected))
        fail("actor-part motion summary does not match samples");
    return;
  }
  if (value.kind === "actor_part_support") {
    assertExactRecordKeys(
      value,
      [
        "factId",
        "kind",
        "actor",
        "exists",
        "localX",
        "localY",
        "localZ",
        "sizeX",
        "sizeY",
        "sizeZ",
        "hitTarget",
        "hitDistance",
      ],
      "actor-part support observation fields",
    );
    if (
      typeof value.actor !== "string" ||
      !isId(value.actor) ||
      typeof value.exists !== "boolean" ||
      ![value.localX, value.localY, value.localZ, value.sizeX, value.sizeY, value.sizeZ].every(
        isFiniteNumber,
      ) ||
      (value.exists &&
        (Number(value.sizeX) <= 0 || Number(value.sizeY) <= 0 || Number(value.sizeZ) <= 0)) ||
      typeof value.hitTarget !== "boolean" ||
      !isFiniteNonNegative(value.hitDistance) ||
      (value.hitTarget && !value.exists)
    )
      fail("actor-part support observation");
    return;
  }
  if (value.kind === "gui_text") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "text", "visible"],
      "GUI observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.text !== "string" ||
      value.text.length > 65_536 ||
      typeof value.visible !== "boolean"
    )
      fail("GUI observation");
    return;
  }
  if (value.kind === "gui_geometry") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "visible", "x", "y", "width", "height"],
      "GUI geometry observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.visible !== "boolean" ||
      !isFiniteNumber(value.x) ||
      !isFiniteNumber(value.y) ||
      !isFiniteNonNegative(value.width) ||
      !isFiniteNonNegative(value.height)
    )
      fail("GUI geometry observation");
    return;
  }
  if (value.kind === "part_position") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "x", "y", "z"],
      "part position observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      !isFiniteNumber(value.x) ||
      !isFiniteNumber(value.y) ||
      !isFiniteNumber(value.z)
    )
      fail("part position observation");
    return;
  }
  if (value.kind === "part_physics") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "anchored", "canCollide"],
      "part physics observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.anchored !== "boolean" ||
      typeof value.canCollide !== "boolean"
    )
      fail("part physics observation");
    if (!value.exists && (value.anchored || value.canCollide))
      fail("absent part physics observation");
    return;
  }
  if (value.kind === "part_physics_trace") {
    assertExactRecordKeys(
      value,
      [
        "factId",
        "kind",
        "exists",
        "initialAnchored",
        "finalAnchored",
        "initialCanCollide",
        "finalCanCollide",
        "everUnanchored",
        "observedMs",
        "changes",
      ],
      "part physics trace observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.initialAnchored !== "boolean" ||
      typeof value.finalAnchored !== "boolean" ||
      typeof value.initialCanCollide !== "boolean" ||
      typeof value.finalCanCollide !== "boolean" ||
      typeof value.everUnanchored !== "boolean" ||
      !isFiniteNonNegative(value.observedMs) ||
      !Array.isArray(value.changes) ||
      value.changes.length > 256
    )
      fail("part physics trace observation");
    let prior = -1;
    let final = value.initialAnchored;
    let finalCanCollide = value.initialCanCollide;
    let everUnanchored = !value.initialAnchored;
    for (const change of value.changes) {
      if (!isRecord(change)) fail("part physics trace change");
      assertExactRecordKeys(
        change,
        ["elapsedMs", "anchored", "canCollide"],
        "part physics trace change fields",
      );
      if (
        !isFiniteNonNegative(change.elapsedMs) ||
        change.elapsedMs < prior ||
        change.elapsedMs > value.observedMs ||
        typeof change.anchored !== "boolean" ||
        typeof change.canCollide !== "boolean"
      )
        fail("part physics trace change");
      prior = change.elapsedMs;
      final = change.anchored;
      finalCanCollide = change.canCollide;
      everUnanchored ||= !change.anchored;
    }
    if (
      (!value.exists &&
        (value.initialAnchored ||
          value.finalAnchored ||
          value.initialCanCollide ||
          value.finalCanCollide ||
          value.everUnanchored ||
          value.changes.length > 0)) ||
      (value.exists &&
        (value.finalAnchored !== final ||
          value.finalCanCollide !== finalCanCollide ||
          value.everUnanchored !== everUnanchored))
    )
      fail("part physics trace summary");
    return;
  }
  if (value.kind === "part_route_trace") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "observedMs", "sampleCount", "maxFrameGapMs", "visits"],
      "part route trace observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      !isFiniteNonNegative(value.observedMs) ||
      !isNonNegativeInteger(value.sampleCount) ||
      !isFiniteNonNegative(value.maxFrameGapMs) ||
      value.maxFrameGapMs > value.observedMs ||
      !Array.isArray(value.visits) ||
      value.visits.length > 256
    )
      fail("part route trace observation");
    if (
      !value.exists &&
      (value.observedMs !== 0 ||
        value.sampleCount !== 0 ||
        value.maxFrameGapMs !== 0 ||
        value.visits.length !== 0)
    )
      fail("absent part route trace observation");
    if (value.exists && value.sampleCount === 0)
      fail("part route trace has no acquisition samples");
    let priorEnterMs = -1;
    for (const visit of value.visits) {
      if (!isRecord(visit)) fail("part route visit");
      assertExactRecordKeys(
        visit,
        [
          "marker",
          "enterMs",
          "exitMs",
          "travelStuds",
          "minDistanceStuds",
          "longestStillMs",
          "maxFrameGapMs",
        ],
        "part route visit fields",
      );
      if (
        (visit.marker !== "start" && visit.marker !== "end") ||
        !isFiniteNonNegative(visit.enterMs) ||
        !isFiniteNonNegative(visit.exitMs) ||
        visit.enterMs < priorEnterMs ||
        visit.exitMs < visit.enterMs ||
        visit.exitMs > value.observedMs ||
        !isFiniteNonNegative(visit.travelStuds) ||
        !isFiniteNonNegative(visit.minDistanceStuds) ||
        !isFiniteNonNegative(visit.longestStillMs) ||
        visit.longestStillMs > visit.exitMs - visit.enterMs ||
        !isFiniteNonNegative(visit.maxFrameGapMs) ||
        visit.maxFrameGapMs > visit.exitMs - visit.enterMs
      )
        fail("part route visit");
      priorEnterMs = visit.enterMs;
    }
    return;
  }
  if (value.kind === "particle_state") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "exists", "enabled", "emissionRate"],
      "particle observation fields",
    );
    if (
      typeof value.exists !== "boolean" ||
      typeof value.enabled !== "boolean" ||
      !isFiniteNonNegative(value.emissionRate)
    )
      fail("particle observation");
    return;
  }
  if (value.kind === "actor_health") {
    assertExactRecordKeys(
      value,
      ["factId", "kind", "actor", "exists", "value"],
      "actor-health observation fields",
    );
    if (
      !isId(value.actor) ||
      typeof value.exists !== "boolean" ||
      !isFiniteNonNegative(value.value)
    )
      fail("actor-health observation");
    return;
  }
  if (value.kind === "player_count") {
    assertExactRecordKeys(value, ["factId", "kind", "value"], "player-count observation fields");
    if (!isNonNegativeInteger(value.value) || value.value > 8) fail("player-count observation");
    return;
  }
  if (value.kind === "performance_trace") {
    assertPerformanceTrace(value);
    return;
  }
  if (value.kind === "gui_layout") {
    assertGuiLayout(value);
    return;
  }
  assertExactRecordKeys(
    value,
    ["factId", "kind", "exists", "value", "observedFrom"],
    "replication observation fields",
  );
  if (
    typeof value.exists !== "boolean" ||
    !isJsonPrimitive(value.value) ||
    value.observedFrom !== "studio"
  )
    fail("replication observation");
}

const PERFORMANCE_SAMPLE_OPTIONAL_FIELDS = ["instanceCount", "memoryMb"] as const;

/** The samples of a server performance trace, in the order of their measured times. */
function assertPerformanceTrace(value: Record<string, unknown>): void {
  assertExactRecordKeys(value, ["factId", "kind", "samples"], "performance trace fields");
  if (!Array.isArray(value.samples) || value.samples.length === 0 || value.samples.length > 480)
    fail("performance trace samples (1–480)");
  // A Stats value is readable for the whole trace or for none of it, so all samples have the
  // shape of the first sample. The judge reads the samples as one table.
  const first: unknown = value.samples[0];
  const optional = isRecord(first)
    ? PERFORMANCE_SAMPLE_OPTIONAL_FIELDS.filter((field) => first[field] !== undefined)
    : [];
  let previousMs = 0;
  for (const sample of value.samples) {
    if (!isRecord(sample)) fail("performance sample");
    assertExactRecordKeys(
      sample,
      ["elapsedMs", "frames", "meanFrameMs", "maxFrameMs", ...optional],
      "performance sample fields",
    );
    if (
      !isFiniteNonNegative(sample.elapsedMs) ||
      sample.elapsedMs <= previousMs ||
      !isNonNegativeInteger(sample.frames) ||
      !isFiniteNonNegative(sample.meanFrameMs) ||
      !isFiniteNonNegative(sample.maxFrameMs) ||
      sample.meanFrameMs > sample.maxFrameMs * (1 + 1e-9) ||
      (sample.frames === 0 && (sample.meanFrameMs !== 0 || sample.maxFrameMs !== 0)) ||
      (sample.instanceCount !== undefined && !isNonNegativeInteger(sample.instanceCount)) ||
      (sample.memoryMb !== undefined && !isFiniteNonNegative(sample.memoryMb))
    )
      fail("performance sample");
    previousMs = sample.elapsedMs;
  }
}

const GUI_TEXT_CLASSES = new Set(["TextLabel", "TextButton", "TextBox"]);
const GUI_TEXT_FIELDS = ["textBounds", "textSize", "textScaled", "textWrapped", "textFits"];

function isGuiRect(value: unknown): value is GuiRect {
  if (!isRecord(value)) return false;
  assertExactRecordKeys(value, ["x", "y", "w", "h"], "GUI rectangle fields");
  return [value.x, value.y, value.w, value.h].every(isFiniteNumber);
}

/** Geometry and text fit of one ScreenGui. Absence keeps the zero fallback values. */
function assertGuiLayout(value: Record<string, unknown>): void {
  assertExactRecordKeys(
    value,
    [
      "factId",
      "kind",
      "exists",
      "complete",
      "screen",
      "guiInset",
      "viewport",
      "ignoreGuiInset",
      "elements",
    ],
    "GUI layout observation fields",
  );
  if (
    typeof value.exists !== "boolean" ||
    typeof value.complete !== "boolean" ||
    typeof value.ignoreGuiInset !== "boolean" ||
    !isGuiRect(value.screen) ||
    !isRecord(value.guiInset) ||
    !isRecord(value.viewport) ||
    !Array.isArray(value.elements) ||
    value.elements.length > 256
  )
    fail("GUI layout observation");
  assertExactRecordKeys(value.guiInset, ["left", "top", "right", "bottom"], "GUI inset fields");
  assertExactRecordKeys(value.viewport, ["w", "h"], "GUI viewport fields");
  const inset = value.guiInset;
  const viewport = value.viewport;
  if (
    ![inset.left, inset.top, inset.right, inset.bottom].every(isFiniteNonNegative) ||
    !isFiniteNonNegative(viewport.w) ||
    !isFiniteNonNegative(viewport.h)
  )
    fail("GUI layout frame");
  if (!value.exists) {
    const screen = value.screen;
    if (
      !value.complete ||
      value.ignoreGuiInset ||
      value.elements.length !== 0 ||
      [screen.x, screen.y, screen.w, screen.h].some((number) => number !== 0) ||
      [inset.left, inset.top, inset.right, inset.bottom, viewport.w, viewport.h].some(
        (number) => number !== 0,
      )
    )
      fail("absent GUI layout observation");
    return;
  }
  if (Number(viewport.w) <= 0 || Number(viewport.h) <= 0) fail("GUI layout viewport");
  for (const element of value.elements) {
    if (!isRecord(element)) fail("GUI layout element");
    const optional = [
      ...(element.clippedRect === undefined ? [] : ["clippedRect"]),
      ...(element.hasText === true ? GUI_TEXT_FIELDS : []),
    ];
    assertExactRecordKeys(
      element,
      ["path", "className", "rect", "zIndex", "hasText", ...optional],
      "GUI layout element fields",
    );
    if (
      !isText(element.path) ||
      element.path.length > 2048 ||
      !isText(element.className) ||
      element.className.length > 80 ||
      !isGuiRect(element.rect) ||
      !Number.isInteger(element.zIndex) ||
      typeof element.hasText !== "boolean"
    )
      fail("GUI layout element");
    if (element.clippedRect !== undefined) {
      const rect = element.rect;
      const clipped = element.clippedRect;
      // The clipped rectangle is an intersection with the element, so it stays inside it.
      if (
        !isGuiRect(clipped) ||
        clipped.x < rect.x - 0.01 ||
        clipped.y < rect.y - 0.01 ||
        clipped.x + clipped.w > rect.x + rect.w + 0.01 ||
        clipped.y + clipped.h > rect.y + rect.h + 0.01
      )
        fail("GUI layout clipped rectangle");
    }
    if (element.hasText) {
      const bounds = element.textBounds;
      if (
        !GUI_TEXT_CLASSES.has(element.className) ||
        !isRecord(bounds) ||
        !isFiniteNonNegative(element.textSize) ||
        typeof element.textScaled !== "boolean" ||
        typeof element.textWrapped !== "boolean" ||
        typeof element.textFits !== "boolean"
      )
        fail("GUI layout text");
      assertExactRecordKeys(bounds, ["w", "h"], "GUI text bounds fields");
      if (!isFiniteNonNegative(bounds.w) || !isFiniteNonNegative(bounds.h)) fail("GUI text bounds");
    }
  }
}

function assertAnchoredCriterion(value: Record<string, unknown>, label: string): void {
  const range = value.scoreRange;
  if (range !== null) {
    if (!isRecord(range)) fail(`${label} score range`);
    assertExactRecordKeys(range, ["minimum", "maximum", "step"], `${label} score range fields`);
    if (
      !isFiniteNumber(range.minimum) ||
      !isFiniteNumber(range.maximum) ||
      range.minimum >= range.maximum ||
      (range.step !== null &&
        (!isFiniteNumber(range.step) ||
          range.step <= 0 ||
          range.step > range.maximum - range.minimum))
    )
      fail(`${label} score range`);
  }
  if (!Array.isArray(value.anchors) || (range === null && value.anchors.length < 2))
    fail(
      `${label} criterion anchors: criterion ${JSON.stringify(value.id)} needs an authored score range or at least two authored score anchors. If the rubric gives no score scale for it, remove it from the ${label} criteria and put it in privateEvaluator.unscaled with a categorical judgment`,
    );
  const scores = new Set<number>();
  for (const anchor of value.anchors) {
    if (
      !isRecord(anchor) ||
      !isFiniteNumber(anchor.score) ||
      scores.has(anchor.score) ||
      !isText(anchor.label) ||
      !isText(anchor.description)
    )
      fail(`${label} criterion anchor`);
    assertExactRecordKeys(anchor, ["score", "label", "description"], `${label} anchor fields`);
    scores.add(anchor.score);
  }
  const anchors = value.anchors as RubricAnchor[];
  const domain = { anchors, scoreRange: range as ScoreRange | null };
  if (range !== null && anchors.some((anchor) => !validRubricScore(domain, anchor.score)))
    fail(`${label} anchor outside authored range`);
  if (anchors.some((anchor, index) => index > 0 && anchors[index - 1]!.score >= anchor.score))
    fail(`${label} criterion anchors must be ordered by increasing score`);
  if (value.minimumPassingScore !== null && !validRubricScore(domain, value.minimumPassingScore))
    fail(`${label} passing score must belong to the authored scale`);
}

const ROLE_CLASSES = new Set<string>(STUDIO_CAPABILITY_CATALOG.roleClasses);
const ROLE_SCOPES = ["workspace", "replicated_storage", "local_player_gui"];
const ROLE_CARDINALITIES = ["exactly_one", "zero_or_one"];

/** Name every invalid role and each of its problems at once. */
export function assertSemanticRoles(value: unknown): asserts value is SemanticRole[] {
  if (!Array.isArray(value) || value.length > 64) fail("semantic role inventory");
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const [index, role] of value.entries()) {
    if (!isRecord(role)) fail("semantic role");
    assertExactRecordKeys(
      role,
      ["id", "className", "scope", "cardinality"],
      "semantic role fields",
    );
    const problems = [
      ...(typeof role.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(role.id)
        ? ["id must have 1 to 64 lowercase letters, digits, _ or -, and start with a letter"]
        : []),
      ...(!ROLE_CLASSES.has(String(role.className))
        ? [`className must be one of ${[...ROLE_CLASSES].join(", ")}`]
        : []),
      ...(!ROLE_SCOPES.includes(String(role.scope))
        ? [`scope must be one of ${ROLE_SCOPES.join(", ")}`]
        : []),
      ...(!ROLE_CARDINALITIES.includes(String(role.cardinality))
        ? [`cardinality must be one of ${ROLE_CARDINALITIES.join(", ")}`]
        : []),
      ...(role.className === "ScreenGui" && role.scope !== "local_player_gui"
        ? ["a ScreenGui role needs the local_player_gui scope"]
        : []),
      ...(ids.has(String(role.id)) ? ["id is also the id of an earlier role"] : []),
    ];
    if (problems.length)
      errors.push(`role ${index} (${JSON.stringify(role.id)}): ${problems.join("; ")}`);
    ids.add(String(role.id));
  }
  if (errors.length) throw new Error(`Invalid semantic role binding: ${errors.join(". ")}`);
}

/** A path to the Player of the client that collects the fact, or to a descendant of it. */
export function isLocalPlayerPath(path: string): boolean {
  return path === "game.Players.LocalPlayer" || path.startsWith("game.Players.LocalPlayer.");
}

/** The server has no LocalPlayer, so a LocalPlayer path resolves only in a client context. */
function assertNoServerLocalPlayerPath(fact: Record<string, unknown>): void {
  const paths = ["path", "startPath", "endPath", "targetPath", "barrierPath"]
    .map((field) => fact[field])
    .filter((path): path is string => typeof path === "string" && isLocalPlayerPath(path));
  if (paths.length)
    throw new Error(
      `the server has no LocalPlayer, so ${paths.join(", ")} resolves only in a client context. Observe it in the context of the actor that owns the value`,
    );
}

function isStudioInstanceRef(value: unknown, roleIds: Set<string>): value is string {
  if (typeof value !== "string") return false;
  if (/^game(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(value)) return true;
  const match = /^role\.([a-z][a-z0-9_-]{0,63})$/u.exec(value);
  return match !== null && roleIds.has(match[1]!);
}

function assertStudioFact(
  fact: Record<string, unknown>,
  actors?: Set<string>,
  roleIds: Set<string> = new Set(),
): void {
  if (!STUDIO_FACT_KINDS.has(String(fact.kind))) fail("Studio fact kind");
  if (fact.kind === "diagnostics") {
    assertExactRecordKeys(fact, ["id", "kind"], "diagnostic fact fields");
    return;
  }
  if (fact.kind === "player_count") {
    assertExactRecordKeys(fact, ["id", "kind"], "player-count fact fields");
    return;
  }
  if (fact.kind === "actor_health") {
    assertExactRecordKeys(fact, ["id", "kind", "actor"], "actor-health fact fields");
    if (!actors || typeof fact.actor !== "string" || !actors.has(fact.actor))
      fail("actor-health fact actor");
    return;
  }
  if (fact.kind === "actor_part_motion") {
    if (!actors) fail("actor-part motion is scenario-only; place it in scenario step observations");
    assertExactRecordKeys(
      fact,
      ["id", "kind", "actor", "path", "sampleCount", "intervalMs"],
      "actor-part motion fact fields",
    );
    if (!actors || typeof fact.actor !== "string" || !actors.has(fact.actor))
      fail("actor-part motion actor");
    if (!isStudioInstanceRef(fact.path, roleIds)) fail("actor-part motion path");
    if (
      !isPositiveInteger(fact.sampleCount) ||
      fact.sampleCount > 480 ||
      !isPositiveInteger(fact.intervalMs) ||
      fact.intervalMs > 60_000 ||
      (fact.sampleCount - 1) * fact.intervalMs > MAX_STUDIO_MOTION_SPAN_MS
    )
      fail("actor-part motion sampling window");
    return;
  }
  if (fact.kind === "actor_part_support") {
    if (!actors)
      fail("actor-part support is scenario-only; place it in scenario step observations");
    assertExactRecordKeys(fact, ["id", "kind", "actor", "path"], "actor-part support fact fields");
    if (!actors || typeof fact.actor !== "string" || !actors.has(fact.actor))
      fail("actor-part support actor");
    if (!isStudioInstanceRef(fact.path, roleIds)) fail("actor-part support path");
    return;
  }
  if (fact.kind === "part_physics_trace") {
    if (!actors) fail("part physics trace is scenario-only");
    assertExactRecordKeys(fact, ["id", "kind", "path", "durationMs"], "part physics trace fields");
    if (!isStudioInstanceRef(fact.path, roleIds)) fail("part physics trace path");
    if (!isPositiveInteger(fact.durationMs) || fact.durationMs > MAX_STUDIO_MOTION_SPAN_MS)
      fail("part physics trace duration");
    return;
  }
  if (fact.kind === "part_route_trace") {
    if (!actors) fail("part route trace is scenario-only");
    assertExactRecordKeys(
      fact,
      ["id", "kind", "path", "startPath", "endPath", "durationMs", "proximityStuds"],
      "part route trace fields",
    );
    if (
      ![fact.path, fact.startPath, fact.endPath].every((path) => isStudioInstanceRef(path, roleIds))
    )
      fail("part route trace path");
    if (!isPositiveInteger(fact.durationMs) || fact.durationMs > MAX_STUDIO_MOTION_SPAN_MS)
      fail("part route trace duration");
    if (
      !isFiniteNumber(fact.proximityStuds) ||
      fact.proximityStuds < 0.1 ||
      fact.proximityStuds > 50
    )
      fail("part route trace proximity");
    return;
  }
  if (fact.kind === "performance_trace") {
    if (!actors) fail("performance trace is scenario-only; observe it in the server context");
    assertExactRecordKeys(
      fact,
      ["id", "kind", "sampleCount", "intervalMs"],
      "performance trace fact fields",
    );
    if (
      !isPositiveInteger(fact.sampleCount) ||
      fact.sampleCount > 480 ||
      !isPositiveInteger(fact.intervalMs) ||
      fact.intervalMs < 250 ||
      fact.intervalMs > 60_000 ||
      fact.sampleCount * fact.intervalMs > MAX_STUDIO_MOTION_SPAN_MS
    )
      fail("performance trace window (1–480 samples, intervalMs 250–60000, at most ten minutes)");
    return;
  }
  if (!isStudioInstanceRef(fact.path, roleIds)) fail("Studio fact path");
  if (fact.kind === "part_motion") {
    assertExactRecordKeys(
      fact,
      ["id", "kind", "path", "sampleCount", "intervalMs"],
      "motion fact fields",
    );
    if (!isPositiveInteger(fact.sampleCount) || fact.sampleCount > 480)
      fail("motion samples (1–480)");
    if (
      !isPositiveInteger(fact.intervalMs) ||
      fact.intervalMs > 60_000 ||
      (fact.sampleCount - 1) * fact.intervalMs > MAX_STUDIO_MOTION_SPAN_MS
    )
      fail("motion sampling window (at most ten minutes)");
  } else if (fact.kind === "replication_probe") {
    assertExactRecordKeys(fact, ["id", "kind", "path", "attribute"], "replication fact fields");
    if (!isId(fact.attribute)) fail("replication attribute");
  } else {
    assertExactRecordKeys(fact, ["id", "kind", "path"], "Studio fact fields");
  }
}

/** The declared acquisition window of one observation, in milliseconds. */
export function studioFactWindowMs(fact: StudioFactRequest): number {
  if (fact.kind === "part_motion" || fact.kind === "actor_part_motion")
    return (fact.sampleCount - 1) * fact.intervalMs;
  if (fact.kind === "part_physics_trace" || fact.kind === "part_route_trace")
    return fact.durationMs;
  if (fact.kind === "performance_trace") return fact.sampleCount * fact.intervalMs;
  return 0;
}

const ANCHOR_FACT_KINDS = new Set<string>(STUDIO_CAPABILITY_CATALOG.anchorFacts);
const HUMANOID_STATE_NAMES = new Set<string>(HUMANOID_STATES);

function assertAnchorFact(
  fact: unknown,
  scope: string,
  actors: Set<string>,
  roleIds: Set<string>,
  roles: SemanticRole[],
): asserts fact is StudioAnchorFact {
  if (!isRecord(fact) || !ANCHOR_FACT_KINDS.has(String(fact.kind)))
    throw new Error(
      `after.fact.kind must be one of ${[...ANCHOR_FACT_KINDS].join(", ")}; a candidate attribute cannot be an anchor`,
    );
  const actorFact = (fields: string[]) => {
    assertExactRecordKeys(fact, ["kind", "actor", ...fields], `${String(fact.kind)} anchor fields`);
    if (typeof fact.actor !== "string" || !actors.has(fact.actor))
      throw new Error(`${String(fact.kind)} anchor needs a declared actor`);
  };
  const pathFact = (field: string) => {
    if (!isStudioInstanceRef(fact.path, roleIds))
      throw new Error(`${String(fact.kind)} anchor needs a declared instance path`);
    if (field && typeof fact[field] !== "boolean")
      throw new Error(`${String(fact.kind)} anchor ${field} must be a boolean`);
  };
  if (fact.kind === "humanoid_state") {
    actorFact(["state"]);
    if (!HUMANOID_STATE_NAMES.has(String(fact.state)))
      throw new Error("humanoid_state anchor state must name a HumanoidStateType");
  } else if (fact.kind === "character_on_part") {
    actorFact(["path"]);
    pathFact("");
  } else if (fact.kind === "character_near_part") {
    actorFact(["path", "radiusStuds"]);
    pathFact("");
    if (!isFiniteNumber(fact.radiusStuds) || fact.radiusStuds < 0.1 || fact.radiusStuds > 50)
      throw new Error("character_near_part radiusStuds must be from 0.1 to 50");
  } else if (fact.kind === "gui_visible") {
    assertExactRecordKeys(fact, ["kind", "path", "visible"], "gui_visible anchor fields");
    pathFact("visible");
    const path = fact.path as string;
    const role = path.startsWith("role.") ? roles.find((item) => `role.${item.id}` === path) : null;
    if (
      scope === "server" ||
      (role ? role.scope !== "local_player_gui" : !path.startsWith("game.Players.LocalPlayer."))
    )
      throw new Error("gui_visible anchor needs a client scope and a local player GUI path");
    // The anchor reads the visibility of a GuiObject. A ScreenGui is not a GuiObject.
    if (role?.className === "ScreenGui")
      throw new Error("gui_visible anchor needs a GuiObject role, not a ScreenGui role");
  } else {
    const field = fact.kind === "instance_present" ? "present" : "value";
    assertExactRecordKeys(fact, ["kind", "path", field], `${fact.kind} anchor fields`);
    pathFact(field);
  }
  if (scope === "server") assertNoServerLocalPlayerPath(fact);
}

function assertStepTiming(
  step: Record<string, unknown>,
  scenario: { durationMs: number; reportContexts: string[] },
  earlier: Set<string>,
  previousStartMs: number,
  actors: Set<string>,
  roleIds: Set<string>,
  roles: SemanticRole[],
): number {
  if (!isPositiveInteger(step.horizonMs) || step.horizonMs > 60_000)
    throw new Error("horizonMs must be an integer from 1 to 60000");
  if (!isNonNegativeInteger(step.holdMs) || step.holdMs >= step.horizonMs)
    throw new Error("holdMs must be an integer from 0 to less than horizonMs");
  const at = step.at;
  if (!isRecord(at)) throw new Error("at must be an object");
  let factAnchor = false;
  if (Object.hasOwn(at, "startMs")) {
    assertExactRecordKeys(at, ["startMs"], "Studio step timing fields");
    if (
      !isNonNegativeInteger(at.startMs) ||
      at.startMs > scenario.durationMs ||
      at.startMs < previousStartMs
    )
      throw new Error(
        `startMs=${String(at.startMs)} must be an integer from ${Math.max(previousStartMs, 0)} to durationMs=${scenario.durationMs}`,
      );
    previousStartMs = at.startMs;
  } else {
    assertExactRecordKeys(at, ["after", "offsetMs"], "Studio step timing fields");
    if (!isNonNegativeInteger(at.offsetMs) || at.offsetMs > scenario.durationMs)
      throw new Error("offsetMs must be an integer from 0 to durationMs");
    const after = at.after;
    if (!isRecord(after)) throw new Error("after must be an object");
    if (Object.hasOwn(after, "step")) {
      assertExactRecordKeys(after, ["step"], "Studio step anchor fields");
      if (typeof after.step !== "string" || !earlier.has(after.step))
        throw new Error("after.step must name an earlier step");
    } else {
      assertExactRecordKeys(after, ["fact", "scope"], "Studio fact anchor fields");
      if (typeof after.scope !== "string" || !scenario.reportContexts.includes(after.scope))
        throw new Error("after.scope must be server or an actor in reportContexts");
      assertAnchorFact(after.fact, after.scope, actors, roleIds, roles);
      factAnchor = true;
    }
  }
  if (!factAnchor && step.holdMs !== 0)
    throw new Error("holdMs applies only to a fact anchor; use 0");
  const requirement = step.requirement;
  if (requirement !== null) {
    if (!isRecord(requirement)) throw new Error("requirement must be null or an object");
    assertExactRecordKeys(requirement, ["withinMs", "quote"], "Studio step requirement fields");
    if (!factAnchor || earlier.size === 0)
      throw new Error("requirement needs a fact anchor and a previous step");
    if (!isPositiveInteger(requirement.withinMs) || requirement.withinMs > step.horizonMs)
      throw new Error("requirement.withinMs must be an integer from 1 to horizonMs");
    if (
      !isText(requirement.quote) ||
      requirement.quote.length > 1024 ||
      !statedDurationsMs(requirement.quote).includes(requirement.withinMs)
    )
      throw new Error(
        "requirement.quote must copy rubric text that states withinMs in digits and a unit",
      );
  }
  return previousStartMs;
}

function assertStudioScenarioAction(
  action: unknown,
  actors: Set<string>,
  roleIds: Set<string>,
): asserts action is StudioScenarioAction {
  if (!isRecord(action)) fail("Studio scenario action");
  if (action.kind === "wait") {
    assertExactRecordKeys(action, ["kind"], "Studio scenario wait action fields");
    return;
  }
  if (typeof action.actor !== "string" || !actors.has(action.actor))
    fail("Studio scenario action actor");
  if (action.kind === "place_relative_to_part" || action.kind === "move_relative_to_part") {
    assertExactRecordKeys(
      action,
      ["kind", "actor", "targetPath", "offsetStuds"],
      "Studio relative placement fields",
    );
    if (!isStudioInstanceRef(action.targetPath, roleIds)) fail("Studio relative placement path");
    if (
      !Array.isArray(action.offsetStuds) ||
      action.offsetStuds.length !== 3 ||
      action.offsetStuds.some(
        (value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10000,
      )
    )
      fail("Studio relative placement offset (three finite coordinates within 10000 studs)");
    return;
  }
  if (action.kind === "move_to" || action.kind === "place_on_part") {
    assertExactRecordKeys(
      action,
      ["kind", "actor", "targetPath"],
      "Studio scenario movement fields",
    );
    if (!isStudioInstanceRef(action.targetPath, roleIds)) fail("Studio scenario movement path");
    return;
  }
  if (action.kind === "probe_barrier") {
    assertExactRecordKeys(action, ["kind", "actor", "barrierPath"], "barrier probe fields");
    if (!isStudioInstanceRef(action.barrierPath, roleIds)) fail("barrier probe path");
    return;
  }
  if (action.kind === "press_key") {
    assertExactRecordKeys(action, ["kind", "actor", "key"], "Studio scenario key fields");
    if (action.key !== "E") fail("Studio scenario key");
    return;
  }
  if (action.kind === "hold_key") {
    assertExactRecordKeys(action, ["kind", "actor", "key", "durationMs"], "Studio held-key fields");
    if (
      !["E", "F", "Space"].includes(String(action.key)) ||
      !isPositiveInteger(action.durationMs) ||
      action.durationMs < 50 ||
      action.durationMs > 5_000
    )
      fail("Studio held-key action");
    return;
  }
  if (action.kind === "gui_activate" || action.kind === "gui_text_entry") {
    assertExactRecordKeys(
      action,
      action.kind === "gui_activate"
        ? ["kind", "actor", "path"]
        : ["kind", "actor", "path", "text"],
      "Studio GUI action fields",
    );
    if (
      !isStudioInstanceRef(action.path, roleIds) ||
      (action.kind === "gui_text_entry" &&
        (typeof action.text !== "string" ||
          action.text.length < 1 ||
          action.text.length > 256 ||
          action.text.includes("\0")))
    )
      fail("Studio GUI action");
    return;
  }
  if (action.kind === "disconnect") {
    assertExactRecordKeys(action, ["kind", "actor"], "Studio scenario disconnect fields");
    return;
  }
  if (action.kind === "fire_remote") {
    assertExactRecordKeys(
      action,
      ["kind", "actor", "path", "arguments"],
      "Studio scenario remote fields",
    );
    if (
      !isStudioInstanceRef(action.path, roleIds) ||
      !Array.isArray(action.arguments) ||
      action.arguments.length > 8
    )
      fail("Studio scenario remote action");
    for (const argument of action.arguments) {
      if (!isRecord(argument)) fail("Studio scenario remote argument");
      if (argument.kind === "literal") {
        assertExactRecordKeys(argument, ["kind", "value"], "Studio scenario literal fields");
        if (argument.value === null || !isJsonPrimitive(argument.value))
          fail("Studio scenario literal");
      } else if (argument.kind === "actor_user_id") {
        assertExactRecordKeys(argument, ["kind", "actor"], "Studio scenario actor argument fields");
        if (typeof argument.actor !== "string" || !actors.has(argument.actor))
          fail("Studio scenario actor argument");
      } else fail("Studio scenario remote argument kind");
    }
    return;
  }
  fail("Studio scenario action kind");
}

function scenarioStep(scenario: StudioScenario, id: string): StudioScenarioStep | undefined {
  return scenario.steps.find((step) => step.id === id);
}

function scenarioObservation(
  scenario: StudioScenario,
  stepId: string,
  context: string,
  factId: string,
): boolean {
  return Boolean(
    scenarioStep(scenario, stepId)?.observations.some(
      (entry) => entry.context === context && entry.fact.id === factId,
    ),
  );
}

/** The kind of the plan fact that a binding names, or null when the plan has no such fact. */
function boundFactKind(
  plan: StudioCollectionPlan,
  binding: StudioObservationBinding,
): StudioFactRequest["kind"] | null {
  if ("phaseId" in binding)
    return (
      plan.phases
        .find((phase) => phase.id === binding.phaseId)
        ?.facts.find((fact) => fact.id === binding.factId)?.kind ?? null
    );
  const scenario = plan.scenarios.find((item) => item.id === binding.scenarioId);
  return scenario
    ? (scenarioStep(scenario, binding.stepId)?.observations.find(
        (entry) => entry.context === binding.context && entry.fact.id === binding.factId,
      )?.fact.kind ?? null)
    : null;
}

function assertScenarioRuleReferences(rule: DeterministicRule, scenario: StudioScenario): void {
  if (rule.kind === "scenario_barrier_passage") {
    const action = scenarioStep(scenario, rule.stepId)?.action;
    if (
      !action ||
      action.kind !== "probe_barrier" ||
      action.actor !== rule.actor ||
      !scenario.reportContexts.includes(rule.actor)
    )
      fail("barrier passage rule reference");
    return;
  }
  if (rule.kind === "scenario_action_succeeded") {
    const step = scenarioStep(scenario, rule.stepId);
    if (!step || step.action.kind === "wait" || step.action.actor !== rule.actor)
      fail("scenario action rule reference");
    return;
  }
  if (rule.kind === "scenario_fact_equals" || rule.kind === "scenario_fact_supports_value") {
    if (!scenarioObservation(scenario, rule.stepId, rule.context, rule.factId))
      fail("scenario fact rule reference");
    return;
  }
  if (rule.kind === "scenario_fact_equals_actor_user_id") {
    if (
      !scenarioObservation(scenario, rule.stepId, rule.context, rule.factId) ||
      !scenario.steps.some(
        (step) => step.action.kind !== "wait" && step.action.actor === rule.actor,
      )
    )
      fail("scenario actor-value rule reference");
    return;
  }
  if (rule.kind === "scenario_number_delta_in_range") {
    if (
      !scenarioObservation(scenario, rule.fromStepId, rule.context, rule.fromFactId) ||
      !scenarioObservation(scenario, rule.toStepId, rule.context, rule.toFactId)
    )
      fail("scenario delta rule reference");
    return;
  }
  if (rule.kind === "scenario_cross_context_equals") {
    if (
      rule.contexts.length < 2 ||
      rule.contexts.some(
        (context) => !scenarioObservation(scenario, rule.stepId, context, rule.factId),
      )
    )
      fail("scenario cross-context rule reference");
    return;
  }
  if (rule.kind === "scenario_step_within") {
    const step = scenarioStep(scenario, rule.stepId);
    if (!step?.requirement)
      fail("scenario timing rule requires a step with a human-authored requirement");
  }
}

function assertDeterministicRule(value: unknown): asserts value is DeterministicRule {
  if (!isRecord(value) || !RULE_KINDS.has(String(value.kind))) fail("deterministic rule");
  if (value.kind === "path_exists") {
    assertExactRecordKeys(value, ["kind", "path"], "path rule fields");
    if (!isSafeRelative(value.path) || !/\.luau?$/u.test(value.path))
      fail("path rule must select a Luau source file");
    return;
  }
  if (value.kind === "source_contains") {
    assertExactRecordKeys(value, ["kind", "path", "text", "caseSensitive"], "source rule fields");
    if (
      !isSafeRelative(value.path) ||
      !/\.luau?$/u.test(value.path) ||
      !isText(value.text) ||
      value.text.length > 2_048 ||
      typeof value.caseSensitive !== "boolean"
    )
      fail("source rule");
    return;
  }
  if (value.kind === "scenario_action_succeeded") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "actor"],
      "scenario action rule fields",
    );
    if (!isId(value.scenarioId) || !isId(value.stepId) || !isId(value.actor))
      fail("scenario action rule");
    return;
  }
  if (value.kind === "scenario_barrier_passage") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "actor", "expected"],
      "barrier passage rule fields",
    );
    if (
      !isId(value.scenarioId) ||
      !isId(value.stepId) ||
      !isId(value.actor) ||
      (value.expected !== "blocked" && value.expected !== "passed")
    )
      fail("barrier passage rule");
    return;
  }
  if (value.kind === "scenario_fact_equals" || value.kind === "scenario_fact_supports_value") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "context", "factId", "field", "expected"],
      "scenario fact rule fields",
    );
    if (
      !isId(value.scenarioId) ||
      !isId(value.stepId) ||
      !isId(value.context) ||
      !isId(value.factId) ||
      !FACT_FIELDS.has(String(value.field)) ||
      !isJsonPrimitive(value.expected)
    )
      fail("scenario fact rule");
    return;
  }
  if (value.kind === "scenario_fact_equals_actor_user_id") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "context", "factId", "actor"],
      "scenario actor-value rule fields",
    );
    if (
      !isId(value.scenarioId) ||
      !isId(value.stepId) ||
      !isId(value.context) ||
      !isId(value.factId) ||
      !isId(value.actor)
    )
      fail("scenario actor-value rule");
    return;
  }
  if (value.kind === "scenario_number_delta_in_range") {
    assertExactRecordKeys(
      value,
      [
        "kind",
        "scenarioId",
        "context",
        "fromStepId",
        "fromFactId",
        "toStepId",
        "toFactId",
        "field",
        "minimum",
        "maximum",
      ],
      "scenario delta rule fields",
    );
    if (
      !isId(value.scenarioId) ||
      !isId(value.context) ||
      !isId(value.fromStepId) ||
      !isId(value.fromFactId) ||
      !isId(value.toStepId) ||
      !isId(value.toFactId) ||
      !NUMBER_FIELDS.has(String(value.field)) ||
      !isFiniteNumber(value.minimum) ||
      !isFiniteNumber(value.maximum) ||
      value.minimum > value.maximum
    )
      fail("scenario delta rule");
    return;
  }
  if (value.kind === "scenario_cross_context_equals") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "factId", "field", "contexts"],
      "scenario cross-context rule fields",
    );
    assertStringArray(value.contexts, "scenario cross-context contexts", isId);
    if (
      !isId(value.scenarioId) ||
      !isId(value.stepId) ||
      !isId(value.factId) ||
      !FACT_FIELDS.has(String(value.field)) ||
      value.contexts.length < 2 ||
      new Set(value.contexts).size !== value.contexts.length
    )
      fail("scenario cross-context rule");
    return;
  }
  if (value.kind === "scenario_step_within") {
    assertExactRecordKeys(value, ["kind", "scenarioId", "stepId"], "scenario timing rule fields");
    if (!isId(value.scenarioId) || !isId(value.stepId)) fail("scenario timing rule");
    return;
  }
  if (value.kind === "source_lint_absent") {
    assertExactRecordKeys(value, ["kind", "codes"], "source lint rule fields");
    assertStringArray(
      value.codes,
      "source lint codes",
      (code): code is string => typeof code === "string" && SOURCE_LINT_CODE_SET.has(code),
    );
    if (
      value.codes.length === 0 ||
      value.codes.length > 16 ||
      new Set(value.codes).size !== value.codes.length
    )
      fail("source lint rule needs 1 to 16 distinct codes");
    return;
  }
  if (value.kind === "build_errors_absent") {
    assertExactRecordKeys(value, ["kind", "facts"], "build error rule fields");
    if (!Array.isArray(value.facts) || value.facts.length === 0 || value.facts.length > 16)
      fail("build error rule needs 1 to 16 diagnostics facts");
    const keys = new Set<string>();
    for (const binding of value.facts) {
      if (!isRecord(binding)) fail("build error fact binding");
      if (Object.hasOwn(binding, "phaseId")) {
        assertExactRecordKeys(binding, ["phaseId", "factId"], "build error phase fact binding");
        if (!isId(binding.phaseId) || !isId(binding.factId)) fail("build error fact binding");
      } else {
        assertExactRecordKeys(
          binding,
          ["scenarioId", "stepId", "context", "factId"],
          "build error scenario fact binding",
        );
        if (![binding.scenarioId, binding.stepId, binding.context, binding.factId].every(isId))
          fail("build error fact binding");
      }
      keys.add(stableJson(binding));
    }
    if (keys.size !== value.facts.length) fail("build error rule repeats a fact");
    return;
  }
  if (value.kind === "gui_layout_holds") {
    assertExactRecordKeys(value, ["kind", "fact", "check", "minimum"], "GUI layout rule fields");
    assertGuiLayoutBinding(value.fact);
    if (!GUI_LAYOUT_CHECK_SET.has(String(value.check))) fail("GUI layout check");
    if (value.check === "min_text_px") {
      assertAuthoredBound(value.minimum, "px", "GUI layout minimum");
      if (value.minimum.value <= 0) fail("GUI layout minimum: use a value above 0 px");
    } else if (value.minimum !== null)
      fail("GUI layout minimum: only min_text_px has a minimum, so use null");
    return;
  }
  if (value.kind === "performance_within") {
    assertExactRecordKeys(
      value,
      ["kind", "scenarioId", "stepId", "context", "factId", "metric", "aggregate", "maximum"],
      "performance rule fields",
    );
    if (![value.scenarioId, value.stepId, value.context, value.factId].every(isId))
      fail("performance rule reference");
    if (!PERFORMANCE_METRIC_SET.has(String(value.metric))) fail("performance metric");
    if (!PERFORMANCE_AGGREGATE_SET.has(String(value.aggregate))) fail("performance aggregate");
    if (value.metric === "memory_mb" && value.aggregate !== "growth")
      fail(
        "performance rule: memory_mb is the memory of the whole Studio process, so use only the aggregate growth",
      );
    assertAuthoredBound(
      value.maximum,
      PERFORMANCE_METRIC_UNITS[value.metric as PerformanceMetric],
      "performance maximum",
    );
    return;
  }
  if (value.kind === "capture_text_contrast") {
    assertExactRecordKeys(
      value,
      ["kind", "phaseId", "captureId", "layoutFactId", "minimum"],
      "text contrast rule fields",
    );
    if (![value.phaseId, value.captureId, value.layoutFactId].every(isId))
      fail("text contrast rule reference");
    assertAuthoredBound(value.minimum, "ratio", "text contrast minimum");
    if (value.minimum.value < 1 || value.minimum.value > 21)
      fail("text contrast minimum: use a ratio from 1:1 to 21:1");
    return;
  }
  if (value.kind === "capture_exposure") {
    assertExactRecordKeys(
      value,
      ["kind", "phaseId", "captureId", "measure", "minimum", "maximum"],
      "exposure rule fields",
    );
    if (![value.phaseId, value.captureId].every(isId)) fail("exposure rule reference");
    if (!EXPOSURE_MEASURE_SET.has(String(value.measure))) fail("exposure measure");
    if (value.minimum === null && value.maximum === null)
      fail("exposure rule: give a minimum, a maximum or both");
    for (const [bound, label] of [
      [value.minimum, "exposure minimum"],
      [value.maximum, "exposure maximum"],
    ] as const)
      if (bound !== null) {
        assertAuthoredBound(bound, "percent", label);
        if (bound.value > 100) fail(`${label}: use a percent from 0 to 100`);
      }
    if (
      isRecord(value.minimum) &&
      isRecord(value.maximum) &&
      Number(value.minimum.value) > Number(value.maximum.value)
    )
      fail("exposure rule: the minimum is above the maximum");
    return;
  }
  if (!isId(value.phaseId) || !isId(value.factId ?? value.captureId))
    fail("evidence rule reference");
  if (value.kind === "fact_equals") {
    assertExactRecordKeys(
      value,
      ["kind", "phaseId", "factId", "field", "expected"],
      "fact equality fields",
    );
    if (!FACT_FIELDS.has(String(value.field)) || !isJsonPrimitive(value.expected))
      fail("fact expectation");
  }
  if (value.kind === "fact_contains") {
    assertExactRecordKeys(
      value,
      ["kind", "phaseId", "factId", "field", "text", "caseSensitive"],
      "fact text fields",
    );
    if (
      value.field !== "text" ||
      !isText(value.text) ||
      value.text.length > 2_048 ||
      typeof value.caseSensitive !== "boolean"
    )
      fail("fact text rule");
  }
  if (value.kind === "number_in_range") {
    assertExactRecordKeys(
      value,
      ["kind", "phaseId", "factId", "field", "minimum", "maximum"],
      "number rule fields",
    );
    if (!NUMBER_FIELDS.has(String(value.field))) fail("number rule field");
    if (
      !isFiniteNumber(value.minimum) ||
      !isFiniteNumber(value.maximum) ||
      value.minimum > value.maximum
    )
      fail("number rule range");
  }
  if (value.kind === "diagnostics_empty")
    assertExactRecordKeys(value, ["kind", "phaseId", "factId"], "diagnostic rule fields");
  if (value.kind === "capture_present")
    assertExactRecordKeys(value, ["kind", "phaseId", "captureId"], "capture rule fields");
}

/** The binding of the one gui_layout fact of a GUI layout rule. */
function assertGuiLayoutBinding(value: unknown): asserts value is StudioObservationBinding {
  if (!isRecord(value)) fail("GUI layout fact binding");
  if (Object.hasOwn(value, "phaseId")) {
    assertExactRecordKeys(value, ["phaseId", "factId"], "GUI layout phase fact binding");
    if (!isId(value.phaseId) || !isId(value.factId)) fail("GUI layout fact binding");
    return;
  }
  assertExactRecordKeys(
    value,
    ["scenarioId", "stepId", "context", "factId"],
    "GUI layout scenario fact binding",
  );
  if (![value.scenarioId, value.stepId, value.context, value.factId].every(isId))
    fail("GUI layout fact binding");
}

/** A bound from human text: quote must state value in digits and the unit. */
function assertAuthoredBound(
  value: unknown,
  unit: QuantityUnit,
  label: string,
): asserts value is AuthoredBound {
  if (!isRecord(value)) fail(label);
  assertExactRecordKeys(value, ["value", "quote"], `${label} fields`);
  if (
    !isFiniteNumber(value.value) ||
    !isText(value.quote) ||
    value.quote.length > 1024 ||
    !statedQuantities(value.quote, unit).includes(value.value)
  )
    throw new Error(
      `${label}: quote must copy human text that states the value ${String(value.value)} in ${unit}`,
    );
}

function assertStudyModel(value: unknown): asserts value is StudyModel {
  if (
    !isRecord(value) ||
    !isBoundedTrimmedText(value.id, 256) ||
    !isId(value.transport) ||
    !isBoundedTrimmedText(value.revision, 256)
  )
    fail("study model");
  assertExactRecordKeys(
    value,
    ["id", "responseModelId", "transport", "revision", "pricing"],
    "study model fields",
  );
  if (!isBoundedTrimmedText(value.responseModelId, 256)) fail("study response model identity");
  if (!isRecord(value.pricing) || value.pricing.currency !== "USD") fail("model pricing");
  assertExactRecordKeys(
    value.pricing,
    ["currency", "inputPerMillionTokens", "outputPerMillionTokens", "capturedAt"],
    "model pricing fields",
  );
  if (
    !isFiniteNonNegative(value.pricing.inputPerMillionTokens) ||
    !isFiniteNonNegative(value.pricing.outputPerMillionTokens)
  )
    fail("model pricing rates");
  assertIso(value.pricing.capturedAt, "model pricing capture");
}

function isStudyEnvironment(value: unknown): value is StudyDefinition["environment"] {
  if (!isRecord(value) || value.platform !== "Roblox Studio") return false;
  try {
    assertExactRecordKeys(
      value,
      ["platform", "studioVersion", "captureProtocol", "cameraProtocol"],
      "study environment fields",
    );
  } catch {
    return false;
  }
  return (
    isText(value.studioVersion) &&
    isText(value.cameraProtocol) &&
    value.captureProtocol === "studio-mcp-viewport"
  );
}

function normalizeJson(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new Error("Value is not JSON-serializable");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Only plain objects are JSON-serializable");
  if (ancestors.has(value)) throw new Error("Cannot canonicalize cyclic JSON");
  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      ownKeys.length !== keys.length ||
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
      })
    )
      throw new Error("JSON arrays must be dense data arrays");
    normalized = value.map((item) => normalizeJson(item, ancestors));
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      Reflect.ownKeys(record).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
      })
    )
      throw new Error("JSON objects must contain only enumerable data properties");
    normalized = Object.fromEntries(
      keys.sort().map((key) => [key, normalizeJson(record[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return normalized;
}

function assertStringArray(
  value: unknown,
  label: string,
  predicate: (entry: unknown) => entry is string,
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every(predicate)) fail(label);
}

function assertIso(value: unknown, label: string): asserts value is ISO8601 {
  if (!isText(value)) fail(label);
  try {
    if (new Date(value).toISOString() !== value) fail(label);
  } catch {
    fail(label);
  }
}

function isBoundedTrimmedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
}
function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function isHash(value: unknown): value is Hash {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isSafeRelative(value: unknown): value is string {
  return (
    isText(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFiniteNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}
function isNullableFiniteNonNegative(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value);
}
function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  );
}
const STATIC_ENGINE_LAYERS = new Set(["static", "engine"]);
const STUDIO_FACT_KINDS = new Set<string>(STUDIO_CAPABILITY_CATALOG.observations);
const SCENARIO_ACTION_KINDS = new Set<string>(STUDIO_CAPABILITY_CATALOG.scenarioActions);
// A rule that waits for a spike is valid in a plan that a person writes.
const RULE_KINDS = new Set<string>([
  ...STUDIO_CAPABILITY_CATALOG.deterministicRules,
  ...SPIKE_PENDING_RULES,
]);
const SOURCE_LINT_CODE_SET = new Set<string>(SOURCE_LINT_CODES);
const GUI_LAYOUT_CHECK_SET = new Set<string>(GUI_LAYOUT_CHECKS);
const PERFORMANCE_METRIC_SET = new Set<string>(PERFORMANCE_METRICS);
const PERFORMANCE_AGGREGATE_SET = new Set<string>(PERFORMANCE_AGGREGATES);
const EXPOSURE_MEASURE_SET = new Set<string>(EXPOSURE_MEASURES);
/** The only ValueBase classes whose Value an instance_value observation reads. */
export const INSTANCE_VALUE_CLASSES = [
  "IntValue",
  "NumberValue",
  "BoolValue",
  "StringValue",
] as const;
export const NUMBER_FIELD_NAMES = [
  "delta",
  "value",
  "emissionRate",
  "x",
  "y",
  "z",
  "width",
  "height",
] as const;
const NUMBER_FIELDS = new Set<string>(NUMBER_FIELD_NAMES);
export const FACT_FIELD_NAMES = [
  "exists",
  "className",
  "name",
  "anchored",
  "canCollide",
  "everUnanchored",
  "text",
  "visible",
  "x",
  "y",
  "z",
  "width",
  "height",
  "enabled",
  "value",
  "observedFrom",
] as const;
const FACT_FIELDS = new Set<string>(FACT_FIELD_NAMES);
const FAILURE_CLASSIFICATIONS = new Set<string>([
  "task_spec_failure",
  "model_reasoning_failure",
  "model_refusal",
  "model_tool_use_failure",
  "harness_context_failure",
  "harness_feedback_failure",
  "budget_or_stop_failure",
  "provider_or_transport_failure",
  "workspace_or_security_failure",
  "static_or_luau_failure",
  "studio_mutation_failure",
  "engine_runtime_failure",
  "visual_or_interaction_failure",
  "grader_failure",
  "environment_failure",
  "evidence_incomplete",
  "human_product_rejection",
  "unknown",
]);
