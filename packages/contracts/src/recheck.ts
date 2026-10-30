import type { CellAction, CellReason } from "../../eval-authoring/src/revision-delta.js";
import type { JudgmentPresentation } from "../../eval-authoring/src/batch-judgment.js";
import type { AssessmentPreview } from "./assessments.js";
import type { SavedEvalRunQuote, SavedStageRunQuote } from "./execution.js";
import type { CriterionResult } from "./index.js";
import type { JudgeSettings } from "./judge-settings.js";
import { fields, hash, identifiers, identity } from "./validation.js";

/*
 * A recheck brings the answers of saved builds to another revision of their evaluation. Each
 * build and criterion gets one action from the content hash that changed. Unchanged answers stay.
 * Code checks run again on the saved evidence with no cost. Only the judge part and the
 * observation part need a paid launch.
 */

/** The most builds that one recheck selects. */
export const MAX_RECHECK_BUILDS = 64;

export const JUDGMENT_PRESENTATIONS = ["still", "sequence", "grounded-sequence"] as const;

/**
 * The judge of the judge part. A recheck judges with the samples and the grouping of the run
 * that saved the builds, so the judge is only a model and an evidence presentation.
 */
export interface RecheckJudge {
  modelId: string;
  presentation: JudgmentPresentation;
}

export interface RecheckSelection {
  /** The run that saved the builds. */
  operationId: string;
  /** Builds of one evaluation of that run. */
  subjectIds: string[];
  /**
   * The target version of the evaluation, by the revision of its stage 1. It can be the version
   * of the run. A build of a later stage pairs with the same stage of that version.
   */
  revisionId: string;
  /** Null: the recheck makes no judge checks. */
  judge: RecheckJudge | null;
}

/** The two paid parts of a recheck. Each part is its own launch. */
export const RECHECK_PARTS = ["judge", "observation"] as const;
export type RecheckPart = (typeof RECHECK_PARTS)[number];

/**
 * The action of one cell. `not_reached`: a build of an earlier stage fails a gate of the target
 * version, so that version never starts the stage of this build.
 */
export type RecheckAction = CellAction | "not_reached";

/**
 * The reason of an action. `shared_request_changed`: another criterion of the same shared judge
 * request changes, so the judge answers this criterion again. `not_checked`: the run did not
 * check the criterion on this observation, so no saved answer exists to reuse.
 * `parent_gate_failed`: a gate check of the target version does not pass on a build of an
 * earlier stage. `parent_gate_changed`: the target version changes a gate, and the saved
 * observations of the build of that stage cannot decide it.
 */
export type RecheckReason =
  | CellReason
  | "shared_request_changed"
  | "not_checked"
  | "parent_gate_failed"
  | "parent_gate_changed";

/** A combined answer of one build, one observation and one criterion. */
export type RecheckAnswer = "met" | "not_met" | "split" | "scored" | "insufficient";

export interface RecheckCell {
  subjectId: string;
  captureId: string;
  /** The authored criterion of the target revision, or of the run for a removed criterion. */
  authoredCriterionId: string;
  /** The paired authored criterion of the run, or null for an added criterion. */
  fromAuthoredCriterionId: string | null;
  /** The text of that authored criterion. */
  authoredText: string;
  /** The executable criterion of the run, or null for an added criterion. */
  fromCriterionId: string | null;
  /** The executable criterion of the target revision, or null for a removed criterion. */
  toCriterionId: string | null;
  action: RecheckAction;
  reason: RecheckReason;
  /** The saved answer of the run. Null when the run has no answer. */
  before: RecheckAnswer | null;
  /** The answer for the target revision. Null until the work of the action has an answer. */
  after: RecheckAnswer | null;
  /** Why the code check could not run on this observation, or null. */
  issue: string | null;
}

/** The immutable result of the code checks of a target revision on one saved observation. */
export interface RecheckCodeRecord {
  schema: "basalt-evals/recheck-code-checks";
  id: string;
  operationId: string;
  manifestHash: string;
  subjectId: string;
  captureId: string;
  /** The target revision whose code checks ran. */
  revisionId: string;
  partition: "development" | "withheld";
  candidateHash: string;
  evidenceHash: string;
  results: CriterionResult[];
}

/**
 * A gate of an earlier stage that the target version changes, for one build of a later stage.
 * The code checks of the gate in the target version run again on the saved observations of the
 * build of that stage.
 */
export interface RecheckGate {
  /** The selected build. */
  subjectId: string;
  /** The stage of the gate. */
  stage: number;
  /** The build of that stage, in its own run. Null when Basalt cannot find it. */
  parent: { operationId: string; subjectId: string } | null;
  /** The answer of each gate check of the target version on each observation of that build. */
  checks: Array<{ captureId: string; criterionId: string; answer: RecheckAnswer }>;
  state: "passed" | "failed" | "undecided";
  /** Why the saved observations cannot decide the gate, or null. */
  issue: string | null;
  /** What a failed or undecided gate means for the selected build, or null for a passed gate. */
  reason: string | null;
}

export interface RecheckPreview {
  schema: "basalt-evals/recheck-preview";
  id: string;
  selection: RecheckSelection;
  /** The revision of the run that saved the builds. */
  sourceRevisionId: string;
  /**
   * The judge settings of that run. The judge part and the new observation use them, so a new
   * answer combines its samples like the answer of the run.
   */
  judgeSettings: JudgeSettings;
  title: string;
  cells: RecheckCell[];
  /** The changed gates of the earlier stages of the selected builds. */
  gates: RecheckGate[];
  /** The saved code check records that this preview used. */
  codeRecordIds: string[];
  /** The judge part: a reassessment preview of the target revision, or null. */
  judge: AssessmentPreview | null;
  /** The observation part: a quote of new observations of the saved builds, or null. */
  observation: SavedEvalRunQuote | SavedStageRunQuote | null;
  /** The reason of each paid part that the recheck needs and cannot quote. */
  unavailable: Array<{ part: RecheckPart | "build"; reason: string }>;
  /** The withheld observations that the code checks read. Each read is a look at the holdout. */
  holdoutCaptureIds: string[];
}

/** One paid launch of a recheck. Basalt records it so that later reads can find its answers. */
export interface RecheckLaunch {
  operationId: string;
  part: RecheckPart;
  /** The saved builds. A new observation observes the registered source of each build. */
  subjects: Array<{ subjectId: string; sourceId: string | null }>;
  previewId: string;
}

export function recheckSelection(value: unknown): RecheckSelection {
  const row = fields(value, ["operationId", "subjectIds", "revisionId", "judge"], "Recheck");
  const judge =
    row.judge === null
      ? null
      : (fields(row.judge, ["modelId", "presentation"], "Recheck judge") as Record<
          string,
          unknown
        >);
  if (
    judge &&
    (typeof judge.modelId !== "string" ||
      !/^[a-z0-9][a-z0-9./:-]{0,127}$/u.test(judge.modelId) ||
      !(JUDGMENT_PRESENTATIONS as readonly unknown[]).includes(judge.presentation))
  )
    throw new Error("Choose a judge model and a supported evidence presentation.");
  return {
    operationId: identity(row.operationId, "run identity"),
    subjectIds: identifiers(row.subjectIds, MAX_RECHECK_BUILDS, "Recheck builds"),
    revisionId: hash(row.revisionId, "evaluation identity"),
    judge: judge
      ? {
          modelId: judge.modelId as string,
          presentation: judge.presentation as JudgmentPresentation,
        }
      : null,
  };
}

/** The selection of one paid part of a recheck. */
export function recheckPartSelection(value: unknown): RecheckSelection & { part: RecheckPart } {
  const row = fields(
    value,
    ["operationId", "subjectIds", "revisionId", "judge", "part"],
    "Recheck launch",
  );
  if (!(RECHECK_PARTS as readonly unknown[]).includes(row.part))
    throw new Error("Choose the judge part or the observation part of the recheck.");
  const { part, ...selection } = row;
  return { ...recheckSelection(selection), part: part as RecheckPart };
}
