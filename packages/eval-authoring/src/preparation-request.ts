import { hashJson, stableJson, TASK_SCHEMA } from "../../contracts/src/index.js";
import type { ModelTurnRequest } from "../../model-client/src/contracts.js";
import type {
  PreparationRoles,
  PrivatePlan,
  PrivateProposal,
  PublicProposal,
} from "./proposals.js";
import { STUDIO_CAPABILITY_CATALOG } from "../../contracts/src/capabilities.js";
import { neutralRojoSeed, neutralWorkspacePaths } from "./seed.js";
import { authoredAuthorityCatalog, privateSubmission } from "./private-submission.js";
import { correctionSchema, MAX_CORRECTION_ENVELOPE_BYTES } from "./proposal-correction.js";
import {
  capabilitiesSchema,
  criterionMappingsSchema,
  developmentViewSchema,
  privateEvaluatorSchema,
  roleSchema,
  sequenceViewSchema,
  studioPlanSchema,
} from "./tool-schemas.js";
const publicTaskSchema = {
  type: "object",
  properties: {
    schema: { type: "string", enum: [TASK_SCHEMA] },
    slug: { type: "string" },
    title: { type: "string" },
    prompt: { type: "string" },
    seed: {
      type: "object",
      properties: {
        projectFile: { type: "string" },
        sourceRoots: { type: "array", items: { type: "string" } },
      },
      required: ["projectFile", "sourceRoots"],
      additionalProperties: false,
    },
    roles: { type: "array", items: roleSchema },
    acceptance: { type: "array", items: { type: "string" } },
    evidenceInstructions: { type: "array", items: { type: "string" } },
  },
  required: [
    "schema",
    "slug",
    "title",
    "prompt",
    "seed",
    "roles",
    "acceptance",
    "evidenceInstructions",
  ],
  additionalProperties: false,
};

const publicDevelopmentSchema = {
  type: "object",
  properties: {
    schema: { type: "string", enum: ["basalt-evals/public-development"] },
    task: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
    plan: studioPlanSchema,
    views: { type: "array", items: developmentViewSchema },
  },
  required: ["schema", "task", "plan", "views"],
  additionalProperties: false,
};

const sceneVector = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const publicSceneSchema = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          position: sceneVector,
          size: sceneVector,
          anchored: { type: "boolean" },
          canCollide: { type: "boolean" },
          transparency: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["name", "position", "size", "anchored", "canCollide", "transparency"],
        additionalProperties: false,
      },
    },
  },
  required: ["parts"],
  additionalProperties: false,
};

const submissionFields = {
  "public-task": publicTaskSchema,
  "public-task-proposal": {
    type: "object",
    properties: {
      roles: publicTaskSchema.properties.roles,
      acceptance: publicTaskSchema.properties.acceptance,
      evidenceInstructions: publicTaskSchema.properties.evidenceInstructions,
    },
    required: ["roles", "acceptance", "evidenceInstructions"],
    additionalProperties: false,
  },
  "public-development": publicDevelopmentSchema,
  "public-scene": publicSceneSchema,
  "studio-plan": studioPlanSchema,
  "sequence-view": { anyOf: [sequenceViewSchema, { type: "null" }] },
  deterministic: privateEvaluatorSchema.properties.deterministic,
  "code-quality": privateEvaluatorSchema.properties.codeQuality,
  visual: privateEvaluatorSchema.properties.visual,
  unscaled: privateEvaluatorSchema.properties.unscaled,
  "human-review": privateEvaluatorSchema.properties.humanReview,
  "criterion-mappings": criterionMappingsSchema,
  capabilities: capabilitiesSchema,
};
type SubmissionField = keyof typeof submissionFields;

const submitSchema = (fields: Record<string, SubmissionField>, authorityIds: string[]) => ({
  type: "object",
  properties: Object.fromEntries(
    Object.entries(fields).map(([field, type]) => [
      field,
      type === "criterion-mappings"
        ? criterionMappingsSchema(authorityIds)
        : submissionFields[type],
    ]),
  ),
  required: Object.keys(fields),
  additionalProperties: false,
});

export const MAX_PREPARATION_PROPOSAL_BYTES = 256 * 1024;
/**
 * The attempts of each proposal part: the first answer and three corrections. Each correction
 * is a new request with the exact diagnostics, never a repeat of an earlier request.
 */
export const PREPARATION_ATTEMPTS = 4;
/**
 * The complete public preparation of an evaluation with `stages` stages: one shared scene and
 * the public task and development recipe of each stage, in stage order.
 */
export const publicProposalSchema = (stages: number) =>
  publicPreparationSchema("public-task", stages);
/** The public submission of the model. Code supplies the fixed fields of each public task. */
export const publicSubmissionSchema = (stages: number) =>
  publicPreparationSchema("public-task-proposal", stages);
function publicPreparationSchema(task: "public-task" | "public-task-proposal", stages: number) {
  return {
    type: "object",
    properties: {
      publicScene: submissionFields["public-scene"],
      stages: {
        type: "array",
        minItems: stages,
        maxItems: stages,
        items: {
          type: "object",
          properties: {
            publicTask: submissionFields[task],
            publicDevelopment: submissionFields["public-development"],
          },
          required: ["publicTask", "publicDevelopment"],
          additionalProperties: false,
        },
      },
    },
    required: ["publicScene", "stages"],
    additionalProperties: false,
  };
}
/** The plan stage of the private part: the private Studio plan and its sequence view. */
const PRIVATE_PLAN_FIELDS = {
  studio: "studio-plan",
  sequence: "sequence-view",
} as const satisfies Record<string, SubmissionField>;
/** The criteria stage of the private part, against the frozen private plan. */
const PRIVATE_CRITERIA_FIELDS = {
  deterministic: "deterministic",
  codeQuality: "code-quality",
  visual: "visual",
  unscaled: "unscaled",
  humanReview: "human-review",
  criterionMappings: "criterion-mappings",
  requiredCapabilities: "capabilities",
} as const satisfies Record<string, SubmissionField>;
export const privatePlanSchema = submitSchema(PRIVATE_PLAN_FIELDS, []);
export const privateCriteriaSchema = (authorityIds: string[]) =>
  submitSchema(PRIVATE_CRITERIA_FIELDS, authorityIds);

/** The criteria submission that a resolved private proposal came from. */
export function criteriaSubmission(
  proposal: PrivateProposal,
  input: Parameters<typeof privateSubmission>[1],
): Record<string, unknown> {
  const submitted = privateSubmission(proposal, input);
  return Object.fromEntries(
    Object.keys(PRIVATE_CRITERIA_FIELDS).map((field) => [
      field,
      field === "criterionMappings" || field === "requiredCapabilities"
        ? submitted[field]
        : (submitted.privateEvaluator as Record<string, unknown>)[field],
    ]),
  );
}

/** The private submission form of a frozen plan and a criteria submission. */
export function assembledPrivateSubmission(
  slug: string,
  plan: PrivatePlan,
  criteria: Record<string, unknown>,
): Record<string, unknown> {
  return {
    privateEvaluator: {
      schema: "basalt-evals/evaluator",
      task: { slug },
      studio: plan.studio,
      sequence: plan.sequence,
      deterministic: criteria.deterministic,
      codeQuality: criteria.codeQuality,
      visual: criteria.visual,
      unscaled: criteria.unscaled,
      humanReview: criteria.humanReview,
    },
    criterionMappings: criteria.criterionMappings,
    requiredCapabilities: criteria.requiredCapabilities,
  };
}
export const MAX_PREPARATION_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_PUBLIC_ENVIRONMENT_BYTES = 40 * 1024;
// A quote builds the requests before the public proposal and the private plan exist.
type RequestInputs = {
  preparePublic: Parameters<PreparationRoles["preparePublic"]>[0];
  preparePrivatePlan: Omit<
    Parameters<PreparationRoles["preparePrivatePlan"]>[0],
    "publicProposal"
  > & {
    publicProposal: PublicProposal | null;
  };
  preparePrivateCriteria: Omit<
    Parameters<PreparationRoles["preparePrivateCriteria"]>[0],
    "publicProposal" | "plan"
  > & {
    publicProposal: PublicProposal | null;
    plan: PrivatePlan | null;
  };
};
type PreparationStage = "prepare_public" | "prepare_private_plan" | "prepare_private_criteria";

const publicEnvironmentGuidance =
  "The neutralSeed is the actual Basalt-supplied Rojo environment and source scaffold, derived independently of the rubric. Basalt already supplies Ground and EvalSpawn; publicScene.parts adds only the declared prompt-presupposed geometry, so an empty parts array does not mean the seed or spawn is missing. Inspect neutralSeed.project for the supplied spawn's actual position and size when checking a camera viewpoint. Do not require another candidate role for an existing neutral seed object. Rendered captures can support color and visibility when the acquisition viewpoint and timing are appropriate; do not require an unavailable color or line-of-sight property probe instead. Public development collects observations for the builder and does not assign private rubric judgments. Audit candidate role lifecycle from the builder prompt alone: when an object may legitimately be created after an interaction or after a baseline sample, use zero_or_one so initial absence is observed rather than made a binding defect. Its authored presence requirement remains required. exactly_one must not impose an unauthored startup deadline. A view from spawn may aim within that viewpoint unless the prompt fixes camera orientation. A static wait_for_exists chooses when to capture a public role; the runner also captures and records absence if the acquisition wait expires, which is not an authored creation deadline.";

// The drafting model writes anchored steps. A person adds each pass/fail time bound.
const STEP_TIMING_GUIDANCE = [
  "Use the fewest scenarios. Each scenario starts a new Studio Play with every client, and each start takes about 30 to 60 seconds in every development run and every final observation. Put all steps in one scenario, unless a check needs a fresh place state that an earlier step changed. Order the steps so that each check sees the state that it needs.",
  "Put each disconnect in its own scenario. A client that leaves Play sends no report for any step of its scenario, so observe the departure from the server or from a client that stays.",
  "In one scenario, the startMs values never become smaller from one step to the next.",
  "Anchor each step on an observed fact or on an earlier step.",
  "If a step must wait for a state, use at {after:{fact,scope},offsetMs}.",
  "Take each anchor fact only from capabilityCatalog.anchorFacts. Never anchor a step on a candidate attribute.",
  "Anchor facts and observations are two separate lists. Use an anchor fact only in at.after.fact. In observations and phase facts, use only capabilityCatalog.observations.",
  "To observe GUI visibility, use gui_text or gui_geometry; both record visible. To observe presence, use instance. To observe CanCollide or Anchored, use part_physics or part_physics_trace.",
  "If a step follows an earlier step, use at {after:{step},offsetMs}.",
  "Use at {startMs} only for a rubric claim that counts time from the scenario start.",
  "Set horizonMs to the time that the runner looks for the anchor. The limit is 60000.",
  "If the runner does not see the anchor within horizonMs, the step outcome is not_observed_within_horizon. This outcome is not a failure.",
  "Set holdMs to 0. If a fact anchor must stay true before the step starts, set holdMs to that time.",
  "Set requirement to null. A person adds a time bound from the rubric.",
  "durationMs is the outer budget of the scenario. No step starts after it.",
].join(" ");

/** A preparation role's model with its frozen endpoint's own per-response output limit. */
export interface PreparationModel {
  id: string;
  maxOutputTokens: number;
}

export function preparationRequests(input: {
  publicModel: PreparationModel;
  privateModel: PreparationModel;
  seed: number;
}): {
  preparePublic: (
    value: RequestInputs["preparePublic"],
    correction?: Record<string, unknown> | null,
  ) => ModelTurnRequest;
  preparePrivatePlan: (
    value: RequestInputs["preparePrivatePlan"],
    correction?: Record<string, unknown> | null,
  ) => ModelTurnRequest;
  preparePrivateCriteria: (
    value: RequestInputs["preparePrivateCriteria"],
    correction?: Record<string, unknown> | null,
  ) => ModelTurnRequest;
} {
  let turn = 0;
  const call = (
    stage: PreparationStage,
    { id: model, maxOutputTokens }: PreparationModel,
    system: string,
    user: unknown,
    toolName: string,
    fields: Record<string, SubmissionField>,
    guidance = "",
    retainedSubmission: Record<string, unknown> | null = null,
  ) => {
    const isPublic = stage === "prepare_public";
    const part = isPublic
      ? "public"
      : stage === "prepare_private_plan"
        ? "private_plan"
        : "private_criteria";
    const schemaKey = {
      public: "publicSubmissionSchema",
      private_plan: "privatePlanSubmissionSchema",
      private_criteria: "privateCriteriaSubmissionSchema",
    }[part];
    const planInput =
      stage === "prepare_private_plan" ? (user as RequestInputs["preparePrivatePlan"]) : null;
    const criteriaInput =
      stage === "prepare_private_criteria"
        ? (user as RequestInputs["preparePrivateCriteria"])
        : null;
    const privateInput = planInput ?? criteriaInput;
    const authorities = privateInput ? authoredAuthorityCatalog(privateInput) : [];
    // A correction edits the retained submission. It never generates the whole proposal again.
    const correctionBase =
      retainedSubmission ??
      (planInput?.previousPlan
        ? (structuredClone(planInput.previousPlan) as unknown as Record<string, unknown>)
        : criteriaInput?.previousPrivateProposal
          ? criteriaSubmission(criteriaInput.previousPrivateProposal, criteriaInput)
          : null);
    const publicStages = isPublic
      ? (user as RequestInputs["preparePublic"]).stagePrompts.length
      : 0;
    const proposalSchema = isPublic
      ? publicSubmissionSchema(publicStages)
      : submitSchema(
          fields,
          authorities.map((item) => item.id),
        );
    const submissionSchema = correctionBase ? proposalSchema : null;
    const correction = correctionBase
      ? {
          correctionBaseHash: hashJson(correctionBase),
          [schemaKey]: submissionSchema,
        }
      : {};
    const publicSeed = isPublic ? neutralRojoSeed("Basalt public environment") : null;
    const context = publicSeed
      ? {
          ...(user as Record<string, unknown>),
          ...(correctionBase ? { previousProposal: correctionBase, ...correction } : {}),
          neutralSeed: publicSeed,
          suppliedWorkspacePaths: [...neutralWorkspacePaths(publicSeed.project)],
          environmentBasis:
            "The base scaffold. Additional geometry must be presupposed by the public prompt.",
        }
      : privateInput
        ? {
            ...Object.fromEntries(
              Object.entries(user as Record<string, unknown>).filter(
                ([key]) => key !== "previousPlan" && key !== "previousPrivateProposal",
              ),
            ),
            authoredAuthorityCatalog: authorities,
            previousSubmission: correctionBase,
            correctionBaseHash: correctionBase ? hashJson(correctionBase) : null,
            ...(correctionBase ? { [schemaKey]: submissionSchema } : {}),
          }
        : user;
    if (
      publicSeed &&
      Buffer.byteLength(
        stableJson({
          neutralSeed: publicSeed,
          suppliedWorkspacePaths: [...neutralWorkspacePaths(publicSeed.project)],
        }),
        "utf8",
      ) > MAX_PUBLIC_ENVIRONMENT_BYTES
    )
      throw new Error("Public environment exceeds its quoted material bound");
    for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
      // A public preparation holds the public part of each stage.
      const maximum =
        key === "diagnostics"
          ? MAX_PREPARATION_DIAGNOSTIC_BYTES
          : key === "previousProposal" && isPublic
            ? MAX_PREPARATION_PROPOSAL_BYTES * publicStages
            : [
                  "publicProposal",
                  "previousProposal",
                  "previousSubmission",
                  "plan",
                  "builderTaskInstructions",
                ].includes(key)
              ? MAX_PREPARATION_PROPOSAL_BYTES
              : key === "proposal"
                ? MAX_PREPARATION_PROPOSAL_BYTES * 2
                : null;
      if (maximum !== null && Buffer.byteLength(stableJson(value), "utf8") > maximum)
        throw new Error(`Preparation ${key} exceeds its quoted material bound`);
    }
    const editRules =
      "Every path addresses the retained proposal as given, so never adjust an index for another edit: Basalt applies the edits so that no edit moves the target of another. Use one replace or remove for one location; several adds at one index insert in the given order. Array indexes are zero-based; add at /- appends. For an object field, add and replace both set the field, and remove deletes it. For an array, add inserts an item and replace changes an existing item. Rename a malformed key by removing it and adding the correct key. A path can also name a whole top-level part.";
    const correctionInstructions = isPublic
      ? `This is a correction of the retained public proposal in previousProposal. Submit submit_public_correction with baseHash equal to correctionBaseHash and one to 32 edits. Each edit has op (add, replace or remove), a JSON Pointer path within publicScene or stages, for example /stages/0/publicTask/acceptance/1, and value (null for remove). ${editRules} New or replaced objects must follow publicSubmissionSchema. Preserve all unrelated roles, scenarios, steps, phases and views. Do not resubmit a complete proposal. Basalt applies the edits to a clone and fully validates the result; edits cannot bypass those checks.`
      : `This is a correction of the retained private ${part === "private_plan" ? "plan" : "criteria"} submission in previousSubmission. Submit submit_${part}_correction with baseHash equal to correctionBaseHash and one to 32 edits. Each edit has op (add, replace or remove), a JSON Pointer path within ${part === "private_plan" ? "studio or sequence" : "deterministic, codeQuality, visual, unscaled, humanReview, criterionMappings or requiredCapabilities"}, and value (null for remove). ${editRules} New or replaced objects must follow ${schemaKey}. Preserve all unrelated ${part === "private_plan" ? "scenarios, steps, observations, phases and captures" : "criteria, mappings and evidence bindings"}. Do not resubmit a complete submission or public material. The compiler applies edits to a clone, resolves human authority and fully validates the result; edits cannot bypass those checks.`;
    if (
      Buffer.byteLength(
        stableJson(correctionSchema) +
          stableJson(submissionSchema) +
          correctionInstructions +
          "correctionBaseHash" +
          "0".repeat(64),
        "utf8",
      ) > MAX_CORRECTION_ENVELOPE_BYTES
    )
      throw new Error("Correction instructions exceed their quoted bound");
    const request: ModelTurnRequest = {
      model,
      seed: isPublic
        ? Number.parseInt(hashJson({ stage, model, user: context }).slice(0, 8), 16)
        : input.seed + turn++,
      system: [
        system,
        guidance,
        "Public and private Studio plans both require at least one driven presentation phase, even when criteria use scenario evidence only. Scenarios run in separate Play sessions; a presentation phase cannot stand in for a scenario's dynamic facts. A sequence requiredTransitions[].id is a unique capture-anchor label, not a step reference. Prefer a state anchor for an effect: bind the observed from-to change of a replication_probe that marks the effect. If the recording never observes that change, Basalt labels the last frame as horizon-end, so failure evidence is still collected. Use an action anchor only when no observed state marks the effect. For action anchors, source.stepId must name a non-wait action in that view's scenario. For state anchors, source must match a replication_probe declared in that scenario's reportContexts and observations; the collector watches the probe throughout the scenario. Each transition declares effectWindowMs, the time over which its effect plays after the anchor, and holdMs, the time that the result must then hold. Basalt keeps the last frame before the anchor, the first frame after an observed state change, one frame after the hold and the fewest effect-window frames that keep maximumGapMs, then the other effect-window frames, then an even fill up to frameBudget. effectWindowMs plus holdMs must fit in the scenario duration. End the hold at least 1500 ms before the scenario ends, because the frame after the hold must start after the hold plus the clock uncertainty. The view's maximumGapMs is the largest unrecorded interval permitted between consecutive frames of a transition; the recorder takes two frames per second, so use 1000 unless an effect needs denser frames. frameBudget is the largest number of sequence frames in one judgment, from 1 to 64. Each frame adds cost to every judgment, and if the required frames do not fit, the evidence is insufficient. Set it to the number of actors times the sum, for each transition, of 2, plus 1 for a state anchor, plus effectWindowMs + 1000 divided by maximumGapMs and rounded up.",
        "Apply capabilityCatalog.executionSemantics when scheduling observations and captures. Observations in the same step as a movement request are not post-arrival evidence, and another context can observe before the actor performs that step. Add later observations or a measured trace when an effect needs time to occur. Presentation phases share their own session state in order, but cannot inherit interactions from scenario sessions.",
        "The capability catalog's observationResults describes the signed output fields and their exact meaning. Treat those collector guarantees as implemented behavior, while still checking whether selected observations support the authored claim. Do not demand redundant point observations for values already recorded by a trace or infer that a successful attribute probe can exist without its resolved instance. Evidence still needs the correct object, context, timing and provenance; these output guarantees do not establish candidate success.",
        ...(correctionBase ? [correctionInstructions] : []),
        "Measurement choices belong to Basalt, not the author. For spatial visibility from a specified player location, observe_from_actor can aim at a target while preserving the avatar location and occluders. It takes targetPath and timeoutMs plus a same-phase instance fact. This driver is not mandatory for all captures: character_reach_part acquires rendered interaction feedback after contact, and GUI captures may use the current player view. Apply the selected driver's phaseDriverSemantics from the fixed capability catalog. Do not replace a contact-driven capture with a separate static view that misses transient feedback. A missing target still yields facts and a frame; missing actor or camera is incomplete acquisition. Do not ask the author to choose camera height/direction, invent a viewing restriction, or interpret a frame that missed the target as proof of invisibility. Camera orientation becomes an authored requirement only when the original author explicitly fixes it.",
        "The publicTask prompt, acceptance statements, evidence instructions and roles are all delivered to the builder. The roles are rendered as explicit tagging instructions in the public builder contract; they need not be duplicated inside the byte-preserved authored prompt. Audit the complete delivered contract without inventing additional authored requirements.",
        "For every observe_from_actor capture consumed by a grader, Basalt automatically supplies verified acquisition provenance: actual avatar viewpoint, target position, targetPresent and aimed, together with public seed geometry. The same-phase instance fact remains mandatory in the capture plan. A criterion need not duplicate that fact merely to establish acquisition targeting; object name, class, state and causal behavior still need their own mapped observations or source evidence. Aiming alone never establishes rendered visibility or success.",
        "Source inspection is supplied outside the Studio plan. The builder can read its declared source roots through public local tools; final evaluation and control grading can bind hash-verified sealed Luau using evidence.sourceSelection. A public Studio recipe contains only runtime acquisition, not private criterion mappings or source-acquisition steps. Do not reject public preparation for lacking a source observation in Studio JSON. In private evaluation, bind sourceSelection explicitly when the claim needs implementation or causal evidence; never infer code from pixels or state alone.",
        "Controlled setup may establish the initial conditions needed to measure an authored behavior. Setup success alone does not establish that behavior, but later independent measurements can. Do not add a separate discovery, navigation, onboarding or reachability requirement unless the authored wording requires it. Judge usability within the scope actually authored. When collecting runtime diagnostics for a Play session, include server and every participating client after the relevant behavior window; a server observation does not cover client errors. Attribution to the mechanic may still require sealed source and retain uncertainty.",
        "For qualitative motion quality, acquire a dense short trajectory in addition to any long route window. Increasing intervalMs merely to span a long cycle can lose teleporting or jitter between samples. Multiple observations may use different windows and sample rates. Actual sample timestamps and gaps constrain the judgment; acquisition resolution is not an authored smoothness threshold. For an authored timed state transition, observe its changes with a suitable trace across the interval, rather than two widely separated snapshots that cannot distinguish early or late transitions.",
        ...(isPublic ? [publicEnvironmentGuidance] : []),
        ...(privateInput
          ? [
              "Select criterionMappings.authorityId only from authoredAuthorityCatalog. The compiler resolves the exact source spans and authoredCriterionId; do not submit those derived fields. Generated publicTask.acceptance summaries are interpretations, not additional human authority. For categorical criteria submit only id and evidence; the compiler supplies statement and requiredness from the selected authored passage. Do not duplicate generated acceptance summaries as new authored criteria. Prompt-only requirements are unscored context. Never create a scored criterion from the full prompt or duplicate a rubric item. All categorical evidence objects include sourceSelection, facts, actions, captureIds and sequence; use empty arrays or null for unused channels. actions selects signed input receipts as {scenarioId,stepId,context}, where context is the actor that performed the action and is in reportContexts. A successful move_to receipt proves an issued movement request, not contact or causation; combine it with before/after facts and source where needed. Action receipts are never fact IDs.",
              "studio.schema must be basalt-evals/studio-plan. Each stage submits every field of its tool; corrections use the declared edit tool of the stage. Every required check must have an exact authored mapping. Instance observations record concrete ClassName values such as Part; BasePart, GuiObject and ValueBase are abstract and cannot equal that field. For an abstract public role class, test exists=true on its role path because role resolution already enforces IsA(className). A required concrete-class check must agree with its public role; if the authored prompt explicitly requires a narrower class, the public role must declare that class too. A trace used to judge an invariant throughout the declared Play window must cover the full claimed observation window; otherwise retain insufficient evidence.",
              "Private acquisition is independent of public development. You may add private scenarios, observations, diagnostics, captures and fixed actions using the frozen scene and public roles; private plans need not copy public development coverage. Repair missing private evidence here without requiring a public-plan change. Public instructions, roles, scene and development tools stay unchanged.",
            ]
          : []),
      ]
        .filter(Boolean)
        .join(" "),
      messages: [{ role: "user", content: stableJson(context) }],
      tools: [
        {
          name: correctionBase ? `submit_${part}_correction` : toolName,
          description: correctionBase
            ? `Correct only defective ${part} proposal fields; all resulting data is validated.`
            : "Submit one canonical data proposal for Basalt validation.",
          parameters: correctionBase ? correctionSchema : proposalSchema,
          // The provider constrains a proposal to its schema. A correction value can hold any
          // JSON, so the correction tool is not strict.
          ...(correctionBase ? {} : { strict: true as const }),
        },
      ],
      maxOutputTokens,
    };
    return request;
  };
  // Both private stages share one system text. The stage text says which fields to submit.
  const privateCall = (
    stage: "prepare_private_plan" | "prepare_private_criteria",
    stageText: string,
    value: RequestInputs["preparePrivatePlan"] | RequestInputs["preparePrivateCriteria"],
    toolName: string,
    fields: Record<string, SubmissionField>,
    correction: Record<string, unknown> | null,
  ) =>
    call(
      stage,
      input.privateModel,
      `${stageText} ${"Interpret the human rubric into a private canonical evaluator and exact criterion coverage map. Preserve human wording, scales, thresholds and anchors. evaluationStage gives the place of this stage in its evaluation. A build of stage 2 or later starts from the build of the stage before it, and earlierPrompts tell what that build was asked to do. Plan and check only the authored criteria of this stage. The author made each criterion in evaluationStage.gateCriterionIds a gate for the next stage; check each one with a required deterministic criterion. Basalt prepares the private evaluator in two stages. The plan stage submits studio, the private Studio plan, and sequence. The criteria stage then submits deterministic, codeQuality, visual, unscaled, humanReview, criterionMappings and requiredCapabilities against the frozen plan, which it cannot change. When the supplied tool is a correction tool, submit only its baseHash and edits; Basalt applies those edits to the retained submission. Preserve unrelated fields and correct the reported structural and semantic defects. Basalt supplies the evaluator schema and task. Place phases inside studio. Use codeQuality or visual numeric anchors only when the authored passage explicitly supplies every score label; copy each score and label exactly. Set minimumPassingScore to null when no passing threshold was authored; a numerical score then leaves overall acceptance unresolved. Weights are separate metadata and cannot supply score anchors. Route unscaled wording to unscaled with categorical satisfied/violated/insufficient judgment. Submit only id and evidence for each categorical criterion; the compiler supplies its exact wording and requiredness from criterionMappings.authorityId. Each authority in authoredAuthorityCatalog has the evidenceClass that the human rubric author set. You cannot set or change it; the compiler copies it into each visual and categorical criterion. Route each criterion by that class. Each authority also has the polarity that the human rubric author set, presence or absence, and the compiler copies it the same way. The text of an absence authority names a thing that the build must not show; the criterion is met only when that thing is absent. Write each deterministic rule of an absence authority so that it passes only when the named thing is absent. For an appearance criterion, bind signed captureIds and/or sequence:true; a model judges rendered frames only for appearance. An appearance criterion without an authored score scale goes in unscaled with captureIds or sequence:true, never in visual. For a timing, motion or causality criterion, use a deterministic engine rule or a categorical criterion whose evidence.facts bind signed phase facts as {phaseId,factId} or signed scenario facts as {scenarioId,stepId,context,factId}, with empty captureIds and sequence false; frames at two per second cannot establish these classes. An authority with a null evidenceClass cannot use rendered frames. Set sequence to a view of the relevant scenario (scenarioId, requiredTransitions, camera, viewport, maximumGapMs, frameBudget), or null when unused. A scenario sequence captures the actual inputs and their aftermath in the same session, including multiple actors. Prefer it for post-input visual evidence instead of repeating the input in a separate presentation Play; when a passage also needs runtime facts, use one evidence object with sourceSelection, facts, actions, captureIds and sequence. All five fields are required: sourceSelection is a bounded sealed Luau selection or null; facts, actions and captureIds are arrays; sequence is a boolean selecting the private rendered scenario. At least one channel must be selected. A single categorical judgment may combine code, runtime facts, and images. Prefer one judgment per complete authored passage with all necessary evidence; do not create a source-only judgment for a passage that also asserts visibility or behavior. To assess carrying a player, use a public place_on_part action before motion, then bind its action receipt, an actor_part_support contact probe after placement, and actor_part_motion samples that include platform size and actor coordinates in the platform's local frame. A move_to receipt proves only that a command was issued, not that the avatar reached the part; placement does not prove player-discoverable boarding. These facts are scenario-only and cannot appear in studio.phases[].facts. For endpoint pauses and repeated travel, use part_route_trace with public marker paths and a declared observation radius, alongside part_motion if continuous geometry is needed; neither the radius nor the finite observation duration is an authored pass/fail speed limit. A missing cycle in a finite trace is insufficient unless the author specified a time bound. Leave acquisition headroom inside scenario.durationMs for actual Studio sampling and later steps. If anchored state matters throughout movement, bind part_physics_trace over the movement window; point snapshots alone miss transitions. Observe public route markers in publicProposal.publicScene.parts by their game.Workspace.<name> paths when relevant; never invent private-only scene objects. Never invent numeric anchors or a passing threshold. Use human review when evidence cannot support even a categorical verdict. A diagnostics fact accumulates since before Play; observe it after the mechanic window. Do not make an all-session diagnostics_empty rule stand in for mechanic-scoped errors unless the neutral seed makes attribution safe; retain ambiguous errors for review. Every authored criterion and every required executable criterion must have a mapping. Exactly one reported executable criterion must map to each authored rubric item. Combine observations for multiple clauses in that criterion. Existence, names, numerical comparisons, and error counts use supported deterministic rules; qualitative interpretation uses the judge. Use only fixed Studio plan JSON capabilities. Repeat exactly the publicProposal.publicTask.roles in the private Studio plan and use role.<id> for candidate objects. Observe a Player-owned object or attribute through a game.Players.LocalPlayer.<path> literal path in the client context of the actor that owns it; never name a Player such as Player1. replication_probe reads a Player attribute, and instance or instance_name reads the presence or name of a Player-owned object such as leaderstats.Wins. instance_value reads the Value of an IntValue, NumberValue, BoolValue or StringValue, for example a leaderstats value through game.Players.LocalPlayer.leaderstats.Wins in the client context of the actor that owns it. Expected values remain private. Submit the requested objects only."}`,
      {
        ...value,
        capabilityCatalog: STUDIO_CAPABILITY_CATALOG,
        privateProposalShape: {
          clauseCoverage:
            "Every rubric mapping must list authoredClauseIds from its exact authored criterion. Cover every clause, including conditions, exceptions and conjunctions. Keep the complete criterion and governing context authoritative; clause boundaries do not change AND/OR meaning. Builder-prompt mappings use an empty authoredClauseIds array. Unsupported or ambiguous modifiers require an author clarification, never omission.",
          planStage: Object.keys(PRIVATE_PLAN_FIELDS),
          criteriaStage: Object.keys(PRIVATE_CRITERIA_FIELDS),
          note: "Submit every field of the stage, also an empty array. humanReview entries must copy the exact original criterion passage, including any bullet prefix; never replace one with reviewer instructions. A diagnostics fact accumulates errors from before Play until collection; observe it after the mechanic's behavior window and mark attribution uncertainty insufficient. An explicit authored stud distance requires bound sampled part_motion or actor_part_motion evidence; part_route_trace endpoint visits alone do not prove the exact displacement. Bind part_physics_trace for an authored throughout-movement anchored requirement. If one authored rubric passage has both anchored-state and travel clauses, include the appropriate physics and motion facts in the same unscaled evidence list within one reported criterion. Never leave an extra required rule unmapped. A move_to action alone does not prove the actor reached a moving part: use place_on_part plus actor_part_support and motion evidence for isolated carry testing. For repeated route and pause claims use part_route_trace and preserve its measured timing uncertainty; a missing cycle in a finite window is insufficient without an authored time bound.",
          unscaledStudioBindings: [
            { phaseId: "phase-id", factId: "fact-id" },
            {
              scenarioId: "scenario-id",
              stepId: "step-id",
              context: "server",
              factId: "fact-id",
            },
          ],
          stepTiming: STEP_TIMING_GUIDANCE,
          motionFactLimits:
            "part_motion and actor_part_motion sampleCount is 1–480 and (sampleCount - 1) × intervalMs must be at most 600000 milliseconds. Use enough samples to observe the claimed behavior without treating nominal intervals as exact elapsed time.",
          interactionTiming:
            "Do not use scenario_fact_equals on a candidate-created role or replication state at a fixed sample when the human wording supplies no deadline: even a non-required rejection can misstate a slower valid outcome, including when no action preceded the sample. Do not use fact_equals on a candidate role observed in a wait_for_exists capture phase: its timeout is an acquisition window, not a pass/fail deadline, even for an optional check. Use a required categorical criterion over signed Studio observations and source review for the authored claim. If an exact value is useful as an extra positive check, use non-required scenario_fact_supports_value: a match verifies only that sampled fact, while a miss is incomplete, never a failure. Do not make a later persistence observation necessary unless the human wording specifies the duration. Baseline role absence is valid evidence.",
          nativeExecution:
            "Every phase must use a fixed non-manual driver. For a static candidate-created visual object, wait_for_exists on a same-phase public role instance fact may choose the capture moment. This fixed runner still records facts and a frame if the wait expires; the timeout bounds acquisition, not the authored behavior. Do not rely only on an immediate wait_for_session frame to judge eventual visibility. A visual capture must occur in a driven phase tied to the relevant interaction, not a manual phase after a separate scenario that may have already ended. For feedback caused by touching a supplied Part, character_reach_part takes only targetPath and timeoutMs and captures after local avatar contact; it does not require a candidate attribute or readyFactId. Do not silently assume transient feedback persists.",
          identityAndAuthority:
            "If the human text names a candidate object, observe its actual name with instance_name on role.<id>; tag and class alone do not prove it. If the criterion asserts that a touch causes a server-owned write, include a required categorical source-review criterion over sealed Luau source as well as signed before/contact/after Studio observations. The source review must check the server handler's causal path and create-if-needed behavior; a move receipt and contact sample alone cannot prove it.",
          categoricalBindings:
            "For unscaled evidence, include sourceSelection, facts, actions, captureIds and sequence; use null or empty arrays for unneeded channels and false for unused sequence. Source selection is {kind:all_luau_in_roots,roots:[src]} or {kind:exact_files,paths:[declared-file.luau]}. Select sealed source together with observations when causal attribution is part of the authored claim. List only exact observation fact IDs declared at that exact scenario step/context or phase, and only capture IDs declared in the fixed Studio plan. Bind rendered captures for color, visibility, appearance, readability, and UI claims, while keeping motion and timing claims grounded in signed facts. Action step IDs and move_to receipts are not observation facts. Select signed action receipts in evidence.actions using {scenarioId,stepId,context}; context is the performing actor and must be in reportContexts. These receipts include the frozen requestedAction, the step outcome, the signed success outcome, scheduledAt and actedAt. actedAt is the start of the input on the Studio server clock, not the time of its effect. Movement request success does not prove contact or causation.",
        },
      },
      toolName,
      fields,
      "For interaction-driven state changes, bind the pre-input state, the action receipt, physical interaction evidence before and after where the fixed catalog supports it, and the post-input state; a final value alone cannot establish activation. A semantic role may resolve to nil before its candidate object is created; exactly_one constrains any object found at observation time, not startup lifetime. An actor_part_support ray after move_to is contact evidence only when it hits the declared target, and lack of such support may be insufficient for legitimate non-floor interactions. Keep source review and targeted controls for causal claims that sampled geometry cannot prove. Set every step requirement to null, also when the rubric states a time bound. A person adds that bound with the exact rubric quote. A non-required scenario_fact_supports_value rule can establish the exact expected value if observed, but returns incomplete on a finite miss; map the original wording to a required categorical criterion over signed observations and source review. path_exists and source_contains inspect sealed Luau files, never game.Workspace instance paths or neutral seed objects. Do not demand a specific source filename unless the builder prompt names it; use Studio instance facts for supplied scene parts. Studio scenarios already wait for every planned avatar to become alive with a HumanoidRootPart before their shared clock starts; do not make session or actor readiness depend on candidate success. A static capture may instead wait for a public candidate role, with absence after the wait retained as candidate evidence rather than an infrastructure failure. If diagnostics are required, collect them after the last relevant scenario observation rather than midway through a longer window.",
      correction,
    );
  return {
    preparePublic(value, correction = null) {
      return call(
        "prepare_public",
        input.publicModel,
        "From the public builder prompts in stagePrompts alone, propose one neutral Roblox public scene and, for each stage, a public task and a public Studio development recipe. stagePrompts holds the prompt of each stage in order, and each stage builds on the build of the stage before it. Submit one entry in stages for each prompt, in the same order. Basalt adds the fixed public task fields and the prompt of the stage to each public task. The builder of a stage sees only its own public task, its own development recipe and the earlier prompts, so the acceptance statements, evidence instructions, roles and development recipe of a stage must not describe a later stage. List in the roles of a stage each role that its builder must tag, also a role of an earlier stage. publicScene is shared by every stage, so declare the geometry that any stage presupposes. publicScene.parts declares only static neutral Part geometry explicitly presupposed by the builder prompt, such as an existing platform or marked endpoints. If the prompt asks to complete a seed around a named existing Part, include that Part in publicScene as well as any named markers; do not make the builder create a prerequisite the prompt says already exists. Use [] when no environment parts are presupposed. When public setup dimensions are unspecified, record any chosen neutral geometry as a setup assumption, never an authored success threshold. Keep publicly named objects and interaction locations inspectable through the public plan. Scene part names must be unique and may be referenced as game.Workspace.<name> in both public and private plans; candidate-created objects must use semantic roles. Choose the least restrictive role class justified by the public prompt. A semantic tag is a public observation binding, not permission to require a particular GUI widget, source layout, or effect lifecycle. If the prompt merely asks for visible feedback, use a rendered capture without requiring a TextLabel or other specific GUI role. Do not make wait_for_session readiness depend on a candidate-created success object; collect its absence as evidence after the actor and session are ready. Never infer scene geometry from a hidden rubric. Cover each requested player-visible behavior with a development observation when fixed capabilities permit it; use catalogued acquisition and action primitives to establish reproducible initial conditions, then measure the requested behavior directly. Setup actions cannot themselves prove usability or candidate success. Select observation kinds only in their supported phase or scenario contexts. Repeated behavior needs an observation window that can exhibit multiple cycles when feasible; an insufficient finite window does not invent a speed requirement. Preserve actual sampling gaps and uncertainty. Acquisition proximity and readiness bounds are measurement settings, never human grading thresholds. Leave acquisition headroom within scenario.durationMs. Keep every hidden criterion, expected value and rubric passage out of this context. Use only fixed Studio plan JSON capabilities; no executable evaluator code. Basalt supplies publicTask.schema, slug, title, prompt and seed from frozen inputs; never submit those fields. publicTask.acceptance and publicTask.evidenceInstructions must each be arrays of plain strings. Submit exactly three top-level keys: publicTask, publicDevelopment and publicScene. publicDevelopment uses schema basalt-evals/public-development; its task is {slug} with no other fields, plan contains schema basalt-evals/studio-plan plus clients, actors, roles, scenarios and phases, and views is a sibling of plan. Each scenario.reportContexts must contain server and may contain only actor IDs; each observation.context must name one of those contexts. A wait_for_session timeout must be at most 60000 ms. Declare candidate objects as public roles: {id,className,scope,cardinality:'exactly_one'|'zero_or_one'} with scope workspace, replicated_storage or local_player_gui. The role id is also the CollectionService tag that the builder puts on the object, so it has only lowercase letters, digits, _ and -, and it starts with a letter. The Studio plan must repeat exactly those roles and refer to each candidate object as role.<id>. Observe a Player-owned object or attribute through a game.Players.LocalPlayer.<path> literal path in the client context of the actor that owns it; never name a Player such as Player1. replication_probe reads a Player attribute, and instance or instance_name reads the presence or name of a Player-owned object such as leaderstats.Wins. instance_value reads the Value of an IntValue, NumberValue, BoolValue or StringValue, for example a leaderstats value through game.Players.LocalPlayer.leaderstats.Wins in the client context of the actor that owns it. The neutral server/client/shared source directories are supplied separately by Basalt. When previousProposal is supplied, correct that exact public proposal according to diagnostics. Submit the requested objects only.",
        {
          ...value,
          capabilityCatalog: STUDIO_CAPABILITY_CATALOG,
          fixedPublicTaskFields: {
            schema: "basalt-evals/task",
            slug: value.slug,
            title: value.title,
            seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
          },
          publicTaskRemainingFields: ["roles", "acceptance", "evidenceInstructions"],
          publicDevelopmentFields: ["schema", "task", "plan", "views"],
          studioShapeGuidance: {
            neutralSpawn:
              "EvalSpawn is centered at (0, 1, 18) with size (6, 1, 6). A supplied Part targeted by move_to or character_reach_part must be outside the spawn avatar's contact area; otherwise it may activate before the baseline observation. Leave a clear avatar-sized horizontal gap when choosing neutral scene geometry.",
            scenarioFields: ["id", "label", "durationMs", "reportContexts", "steps"],
            stepFields: [
              "id",
              "at",
              "horizonMs",
              "holdMs",
              "action",
              "observations",
              "requirement",
            ],
            stepTiming: STEP_TIMING_GUIDANCE,
            observationFields: ["context", "fact"],
            phaseFields: ["id", "label", "instruction", "driver", "facts", "captures"],
            note: "Observations belong to a step, never directly to a scenario. Every step must have an observations array, even when empty. Every scenario must include server in reportContexts. The phase array is required at plan level. A scenario durationMs is its outer budget, up to 1800000 milliseconds; no step starts after it ends; each motion or event trace may span up to 600000 milliseconds and must finish before the scenario ends, leaving headroom for real sampling. Observe the positions of named public route markers or endpoints and use part_route_trace for public endpoint visits. When the builder prompt asks for an anchored part, use part_physics or part_physics_trace to observe its state during the relevant window.",
            interactionTiming:
              "An absent candidate role at baseline is a valid observation, not acquisition failure. An outcome absent at a single post-action sample may need more acquisition; do not turn the chosen sample time or an unrequested later persistence check into a pass threshold.",
            nativeExecution:
              "Every phase must have a fixed non-manual driver. The isolated native worker rejects manual phases before Studio. A wait_for_exists driver may name a same-phase instance fact for a supplied scene object. For touch-triggered feedback, use character_reach_part with the supplied BasePart targetPath and timeoutMs: it moves the local avatar and captures after its downward contact ray hits the part. It has no readyFactId or readyValue and does not wait on candidate success. A later session-ready capture alone may miss transient feedback.",
            namedObjects:
              "When the builder prompt explicitly names a candidate-created object, public role ids are shown to the builder as the observation tags. Use a public instance_name fact on role.<id> if development should inspect the object's actual name. A tag alone does not establish the authored name.",
          },
        },
        "submit_public_proposal",
        {
          publicTask: "public-task-proposal",
          publicDevelopment: "public-development",
          publicScene: "public-scene",
        },
        "Basalt already supplies Ground and EvalSpawn with fixed neutral geometry. Never list either name in publicScene.parts; declare only additional prompt-presupposed Parts. A scenario's shared clock now starts only after every planned avatar is alive with a HumanoidRootPart; wait_for_session phase facts do not establish avatar readiness. For a static candidate-created visual object, a wait_for_exists phase may use its public role instance fact to choose when to capture; the fixed runner still collects facts and a frame when the wait expires, so this is an evidence-acquisition window, not an authored creation deadline or an infrastructure-readiness gate. Do not use an immediate wait_for_session capture as the only rendered view of a candidate-created object. An absent role in a finite window must remain distinguishable from broken capture. When a request says visible from spawn, keep the character at spawn but allow the camera to aim within that viewpoint unless the author explicitly fixes camera orientation; public and private views must agree. An absent exactly_one role is a public binding failure. A public object that is legitimately absent before interaction needs a zero_or_one binding. For a prompt that says an interaction changes state, observe the relevant state before the input and again after it. A move_to receipt proves only a movement request: when touching a supplied floor Part is the trigger, observe actor_part_support before and after movement, and retain its action outcome and target-local geometry. An observed later state plus support is evidence of activation, but cannot alone prove causal touch; keep source review and negative controls for that claim. Place diagnostics after the final behavioral observation, within the scenario window.",
        correction,
      );
    },
    preparePrivatePlan(value, correction = null) {
      return privateCall(
        "prepare_private_plan",
        "This is the plan stage. Submit only studio and sequence. Plan every scenario, step, observation, phase, capture and sequence view that the authored criteria need, because the criteria stage cannot change the plan. Declare a sequence view when an appearance criterion needs frames after an input.",
        value,
        "submit_private_plan",
        PRIVATE_PLAN_FIELDS,
        correction,
      );
    },
    preparePrivateCriteria(value, correction = null) {
      return privateCall(
        "prepare_private_criteria",
        "This is the criteria stage. The private plan in plan is frozen. Submit only deterministic, codeQuality, visual, unscaled, humanReview, criterionMappings and requiredCapabilities. Bind evidence only to IDs that exist in plan. If plan has no evidence for a clause, bind that clause to human review.",
        value,
        "submit_private_criteria",
        PRIVATE_CRITERIA_FIELDS,
        correction,
      );
    },
  };
}
