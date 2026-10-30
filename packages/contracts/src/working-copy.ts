/** The most stages of one evaluation. Each stage builds on the build of the stage before it. */
export const MAX_EVAL_STAGES = 6;

/** One stage of a working copy, as the editor holds it. */
export interface WorkingCopyStage {
  prompt: string;
  criteria: string;
  /** The authored criterion IDs of the gate of the stage. */
  gateCriterionIds: string[];
}

export interface WorkingCopy {
  id: string;
  revision: number;
  evaluationId: string | null;
  baseDraftId: string | null;
  title: string;
  /** One to six stages in their order. An evaluation without stages has one stage. */
  stages: WorkingCopyStage[];
  updatedAt: string;
  /** The parsed criteria of each stage, or the parse error of its success criteria. */
  parsed: Array<{
    criteria: Array<{ id: string; text: string; start: number; end: number; required: boolean }>;
    error: string | null;
  }>;
}
export interface WorkingCopyInput {
  revision: number;
  evaluationId: string | null;
  baseDraftId: string | null;
  title: string;
  stages: WorkingCopyStage[];
}
