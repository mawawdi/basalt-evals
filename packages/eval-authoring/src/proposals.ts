import type { EvalProposal } from "./compiler.js";
import type { EvalDraft } from "./input.js";
import type { PublicScene } from "./seed.js";

/** The public part of one stage, as the private preparation and the compiler read it. */
export type PublicProposal = Pick<EvalProposal, "publicTask" | "publicDevelopment"> & {
  publicScene: PublicScene;
};
/**
 * The public preparation of a whole evaluation: one scene that every stage shares, and the public
 * task and development recipe of each stage, in stage order.
 */
export interface PublicPreparation {
  publicScene: PublicScene;
  stages: Array<Pick<EvalProposal, "publicTask" | "publicDevelopment">>;
}
export type PrivateProposal = Pick<
  EvalProposal,
  "privateEvaluator" | "criterionMappings" | "requiredCapabilities"
>;
/** The private plan that the criteria stage reads but cannot change. */
export type PrivatePlan = Pick<EvalProposal["privateEvaluator"], "studio" | "sequence">;

/** The place of a stage in its evaluation, as the private preparation of the stage reads it. */
export interface EvaluationStageContext {
  /** The stage number, from 1. */
  index: number;
  count: number;
  /** The prompts of the earlier stages. The build of this stage starts from their build. */
  earlierPrompts: string[];
  /** The authored criteria of this stage that the next stage needs to pass. */
  gateCriterionIds: string[];
}

/** The public part of one stage of a public preparation. */
export function stagePublicProposal(
  preparation: PublicPreparation,
  stageNumber: number,
): PublicProposal {
  const stage = preparation.stages[stageNumber - 1];
  if (!stage) throw new Error("The public preparation has no such stage");
  return {
    publicTask: stage.publicTask,
    publicDevelopment: stage.publicDevelopment,
    publicScene: preparation.publicScene,
  };
}

/**
 * Repairs unambiguous structure in an unvalidated submission. A role applies it before its
 * shape check, so the repair also reaches output that the shape check would reject.
 */
export type SubmissionRepair = (submission: Record<string, unknown>) => Record<string, unknown>;

export interface PreparationRoles {
  /**
   * This context is deliberately unable to receive the human rubric. It gets the prompts of all
   * stages one time, so that the shared scene supports every stage.
   */
  preparePublic(
    input: {
      stagePrompts: string[];
      title: string;
      slug: string;
      attempt: number;
      diagnostics: string[];
      previousProposal: PublicPreparation | null;
    },
    repair?: SubmissionRepair,
  ): Promise<PublicPreparation>;
  /** The plan stage of the private part of one evaluation stage. */
  preparePrivatePlan(
    input: {
      builderPrompt: string;
      rubric: string;
      criteria: EvalDraft["stages"][number]["criteria"];
      evaluationStage: EvaluationStageContext;
      publicProposal: PublicProposal;
      previousPlan: PrivatePlan | null;
      attempt: number;
      diagnostics: string[];
    },
    repair?: SubmissionRepair,
  ): Promise<PrivatePlan>;
  /** The criteria stage of the private part of one evaluation stage, against the frozen plan. */
  preparePrivateCriteria(
    input: {
      builderPrompt: string;
      rubric: string;
      criteria: EvalDraft["stages"][number]["criteria"];
      evaluationStage: EvaluationStageContext;
      publicProposal: PublicProposal;
      plan: PrivatePlan;
      previousPrivateProposal: PrivateProposal | null;
      attempt: number;
      diagnostics: string[];
    },
    repair?: SubmissionRepair,
  ): Promise<PrivateProposal>;
}
