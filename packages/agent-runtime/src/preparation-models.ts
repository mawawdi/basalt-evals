import {
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../../model-client/src/contracts.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import {
  BoundedModelClient,
  isUnchargedRateLimit,
  ModelRateLimitError,
} from "../../model-client/src/bounded-client.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import type { PreparationRoles, PrivateProposal, PublicPreparation } from "./eval-preparation.js";
import type { PrivatePlan, SubmissionRepair } from "../../eval-authoring/src/proposals.js";
import {
  assembledPrivateSubmission,
  criteriaSubmission,
  preparationRequests,
  type PreparationModel,
  privateCriteriaSchema,
  privatePlanSchema,
  publicSubmissionSchema,
} from "../../eval-authoring/src/preparation-request.js";
import { assertPreparationShape } from "../../eval-authoring/src/submission-validation.js";
import {
  authoredAuthorityCatalog,
  resolvePrivateSubmission,
} from "../../eval-authoring/src/private-submission.js";
import {
  applyCorrection,
  CorrectionNotApplied,
  type CorrectionPart,
} from "../../eval-authoring/src/proposal-correction.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { hashJson } from "../../contracts/src/index.js";

export class PreparationDispatcher {
  private readonly stages = new Map<string, BoundedModelClient>();

  constructor(
    private readonly client: ModelClient,
    private readonly ledger: DurableSpendLedger,
    private readonly snapshots: ModelSnapshot[],
    private readonly beforeRequest?: () => Promise<void>,
    private readonly signal?: AbortSignal,
    private readonly namespace?: string,
  ) {}

  async complete(stage: string, request: ModelTurnRequest): Promise<ModelTurnResult> {
    let client = this.stages.get(stage);
    if (!client) {
      client = new BoundedModelClient(
        this.client,
        this.ledger,
        this.snapshots,
        this.namespace ? `${stage}:${this.namespace}` : stage,
        false,
        this.beforeRequest,
      );
      this.stages.set(stage, client);
    }
    return client.complete(request, this.signal);
  }
}

function submission(
  result: ModelTurnResult,
  toolName: string,
  base: Record<string, unknown> | null,
): Record<string, unknown> {
  if (result.kind === "provider_error" && isUnchargedRateLimit(result))
    throw new ModelRateLimitError(result.errorClass);
  // A stopped runaway with a known charge is an unreadable answer. Basalt keeps the base, if
  // one exists. A runaway with an unknown charge stays a provider failure and stops preparation.
  if (
    result.kind === "provider_error" &&
    result.errorClass === "runaway_output" &&
    result.usage.costUsd !== null
  ) {
    const reason =
      "The answer became a long run of whitespace, so Basalt stopped it. Do not write long runs of whitespace.";
    throw base ? new CorrectionNotApplied(reason) : new Error(reason);
  }
  if (result.kind !== "assistant")
    throw new ExecutionFault({
      causeCode: result.errorClass,
      category: "provider",
      dependency: null,
      unit: { stage: "preparation", id: result.requestHash },
      evidenceRefs: [result.requestHash],
      recoveryActions: ["inspect"],
      explanation:
        "A preparation request to the model failed. Basalt did not send the request again. Examine the response before you start a new run.",
    });
  if (result.stopReason === "max_tokens")
    throw new ExecutionFault({
      causeCode: "preparation_output_limit",
      category: "provider",
      dependency: null,
      unit: { stage: "preparation", id: result.requestHash },
      evidenceRefs: [result.requestHash, result.responseHash],
      recoveryActions: ["inspect"],
      explanation: `The model reached its output limit before it completed a preparation response. Basalt did not send the request again. Examine the response before you start a new run.`,
    });
  const calls = result.message.toolCalls.filter((call) => call.name === toolName);
  if (
    calls.length !== 1 ||
    result.message.toolCalls.length !== 1 ||
    !calls[0]!.arguments ||
    typeof calls[0]!.arguments !== "object" ||
    Array.isArray(calls[0]!.arguments)
  )
    throw new Error("Preparation model must submit exactly one structured proposal");
  return calls[0]!.arguments as Record<string, unknown>;
}

/** The fields that the public model submits. Code supplies the fixed fields of each task. */
function publicSubmission(preparation: PublicPreparation): Record<string, unknown> {
  return structuredClone({
    publicScene: preparation.publicScene,
    stages: preparation.stages.map((stage) => ({
      publicTask: {
        roles: stage.publicTask.roles,
        acceptance: stage.publicTask.acceptance,
        evidenceInstructions: stage.publicTask.evidenceInstructions,
      },
      publicDevelopment: stage.publicDevelopment,
    })),
  });
}

/**
 * Repair before the shape check. A repair that cannot read the submission leaves it unchanged,
 * so the shape check reports the real errors. The caller repairs the result again and records
 * any deliberate repair error.
 */
function repaired(
  submission: Record<string, unknown>,
  repair: SubmissionRepair | undefined,
): Record<string, unknown> {
  if (!repair) return submission;
  try {
    return repair(submission);
  } catch {
    return submission;
  }
}

/** The edits of a correction, or the base unchanged with the reason that Basalt kept it. */
function corrected(part: CorrectionPart, base: Record<string, unknown> | null, output: unknown) {
  if (!base) return output as Record<string, unknown>;
  try {
    return applyCorrection(part, base, output) as Record<string, unknown>;
  } catch (error) {
    throw new CorrectionNotApplied(error instanceof Error ? error.message : String(error));
  }
}

export function modelPreparationRoles(input: {
  dispatcher: PreparationDispatcher;
  publicModel: PreparationModel;
  privateModel: PreparationModel;
  seed: number;
}): PreparationRoles {
  const requests = preparationRequests(input);
  let retainedPublic: { context: string; submission: Record<string, unknown> } | null = null;
  let retainedPlan: { context: string; submission: Record<string, unknown> } | null = null;
  let retainedCriteria: { context: string; submission: Record<string, unknown> } | null = null;
  return {
    async preparePublic(value, repair): Promise<PublicPreparation> {
      const context = hashJson({
        stagePrompts: value.stagePrompts,
        title: value.title,
        slug: value.slug,
      });
      // A correction edits the last readable submission, also when it has shape errors. The
      // previous proposal is the base only after a recovery, when no submission is retained.
      const base =
        value.attempt > 1 && retainedPublic?.context === context
          ? retainedPublic.submission
          : value.previousProposal
            ? publicSubmission(value.previousProposal)
            : null;
      const request = requests.preparePublic(value, base);
      const output = submission(
        await input.dispatcher.complete("prepare_public", request),
        request.tools[0]!.name,
        base,
      );
      const edited = repaired(corrected("Public", base, output), repair);
      retainedPublic = { context, submission: edited };
      assertPreparationShape(
        edited,
        publicSubmissionSchema(value.stagePrompts.length),
        "Public preparation",
      );
      const stages = edited.stages as Array<Record<string, unknown>>;
      return {
        ...edited,
        stages: stages.map((stage, index) => ({
          ...stage,
          publicTask: {
            ...(stage.publicTask as object),
            schema: "basalt-evals/task",
            slug: value.slug,
            title: value.title,
            prompt: value.stagePrompts[index]!,
            seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
          },
        })),
      } as unknown as PublicPreparation;
    },
    async preparePrivatePlan(value, repair): Promise<PrivatePlan> {
      const context = hashJson({
        builderPrompt: value.builderPrompt,
        rubric: value.rubric,
        criteria: value.criteria,
        evaluationStage: value.evaluationStage,
        publicProposal: value.publicProposal,
      });
      // Shape errors must correct the exact rejected response, too. No unvalidated
      // proposal reaches the compiler; the durable response reconstructs this on recovery.
      const base =
        value.attempt > 1 && retainedPlan?.context === context
          ? retainedPlan.submission
          : value.previousPlan
            ? (structuredClone(value.previousPlan) as unknown as Record<string, unknown>)
            : null;
      const request = requests.preparePrivatePlan(value, base);
      const output = submission(
        await input.dispatcher.complete("prepare_private_plan", request),
        request.tools[0]!.name,
        base,
      );
      const edited = repaired(corrected("PrivatePlan", base, output), repair);
      retainedPlan = { context, submission: edited };
      assertPreparationShape(edited, privatePlanSchema, "Private plan");
      return edited as unknown as PrivatePlan;
    },
    async preparePrivateCriteria(value, repair): Promise<PrivateProposal> {
      const context = hashJson({
        builderPrompt: value.builderPrompt,
        rubric: value.rubric,
        criteria: value.criteria,
        evaluationStage: value.evaluationStage,
        publicProposal: value.publicProposal,
        plan: value.plan,
      });
      const base =
        value.attempt > 1 && retainedCriteria?.context === context
          ? retainedCriteria.submission
          : value.previousPrivateProposal
            ? criteriaSubmission(value.previousPrivateProposal, value)
            : null;
      const request = requests.preparePrivateCriteria(value, base);
      const output = submission(
        await input.dispatcher.complete("prepare_private_criteria", request),
        request.tools[0]!.name,
        base,
      );
      const edited = repaired(corrected("PrivateCriteria", base, output), repair);
      retainedCriteria = { context, submission: edited };
      assertPreparationShape(
        edited,
        privateCriteriaSchema(authoredAuthorityCatalog(value).map((item) => item.id)),
        "Private criteria",
      );
      return resolvePrivateSubmission(
        assembledPrivateSubmission(value.publicProposal.publicTask.slug, value.plan, edited),
        value,
      );
    },
  };
}
