import {
  assertPublicTask,
  assertStudioCollectionPlan,
  assertStudioSequenceView,
  hashJson,
} from "../../contracts/src/index.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { ModelRateLimitError } from "../../model-client/src/bounded-client.js";
import {
  ModelRequestAdmissionError,
  ModelRequestPendingError,
  ModelRequestValidationError,
} from "../../model-client/src/contracts.js";
import { SpendingCeilingError } from "../../model-client/src/ledger.js";
import { assertPublicDevelopmentRecipe } from "../../development/src/index.js";
import {
  compileEvalProposal,
  type EvalProposal,
  type EvalRevision,
  type EvalValidation,
} from "../../eval-authoring/src/compiler.js";
import type { EvalDiagnostic, EvalDraft } from "../../eval-authoring/src/index.js";
import { STUDIO_CAPABILITY_CATALOG } from "../../contracts/src/capabilities.js";
import {
  PREPARATION_ATTEMPTS,
  publicProposalSchema,
} from "../../eval-authoring/src/preparation-request.js";
import { assertPreparationShape } from "../../eval-authoring/src/submission-validation.js";
import { CorrectionNotApplied } from "../../eval-authoring/src/proposal-correction.js";
import {
  assertNeutralInteractionClearance,
  assertNeutralPathReferences,
  assertPublicScene,
  neutralRojoSeed,
  neutralWorkspacePaths,
} from "../../eval-authoring/src/seed.js";

import {
  carriedCriteria,
  carriedPrivateProposal,
  type PreparationBase,
  type PreparationReuse,
} from "../../eval-authoring/src/preparation-base.js";
import {
  stagePublicProposal,
  type PreparationRoles,
  type PrivatePlan,
  type PrivateProposal,
  type PublicPreparation,
  type PublicProposal,
} from "../../eval-authoring/src/proposals.js";
export type {
  PreparationRoles,
  PrivateProposal,
  PublicPreparation,
  PublicProposal,
} from "../../eval-authoring/src/proposals.js";

interface PreparationResult {
  /** The stage revisions in stage order. Empty when the preparation did not compile. */
  revisions: EvalRevision[];
  /** The validation of stage 1 when all stages compile, or of the stage that stopped. */
  validation: EvalValidation;
  attempts: {
    public: number;
    stages: Array<{ privatePlan: number; privateCriteria: number }>;
  };
  normalizations: string[];
  /** How each stage used the tests of the base, or null without a base. */
  reuse: PreparationReuse | null;
}

/**
 * A client that leaves Play cannot report. Remove it from reportContexts only when no
 * observation, anchor or binding reads its reports. Otherwise the validator names the conflict.
 */
function withoutDepartedReporters(scenarios: unknown, owner: unknown, notes: string[]): void {
  if (!Array.isArray(scenarios)) return;
  const bindsContext = (value: unknown, scenarioId: string, actor: string): boolean => {
    if (Array.isArray(value)) return value.some((item) => bindsContext(item, scenarioId, actor));
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (
      record.scenarioId === scenarioId &&
      (record.context === actor || record.actor === actor || record.scope === actor)
    )
      return true;
    return Object.values(record).some((item) => bindsContext(item, scenarioId, actor));
  };
  for (const scenario of scenarios as Array<Record<string, unknown>>) {
    if (
      !scenario ||
      typeof scenario.id !== "string" ||
      !Array.isArray(scenario.reportContexts) ||
      !Array.isArray(scenario.steps)
    )
      continue;
    const steps = scenario.steps as Array<Record<string, unknown> | null>;
    const departed = steps.flatMap((step) => {
      const action = step?.action as { kind?: unknown; actor?: unknown } | undefined;
      return action?.kind === "disconnect" && typeof action.actor === "string"
        ? [action.actor]
        : [];
    });
    for (const actor of new Set(departed)) {
      if (!(scenario.reportContexts as unknown[]).includes(actor)) continue;
      const read = steps.some((step) => {
        const observations = step?.observations;
        const after = (step?.at as { after?: { scope?: unknown } } | undefined)?.after;
        return (
          after?.scope === actor ||
          (Array.isArray(observations) &&
            observations.some(
              (observation) => (observation as { context?: unknown } | null)?.context === actor,
            ))
        );
      });
      if (read || bindsContext(owner, scenario.id, actor)) continue;
      scenario.reportContexts = (scenario.reportContexts as unknown[]).filter(
        (context) => context !== actor,
      );
      notes.push(`Removed departed client ${actor} from the reportContexts of ${scenario.id}`);
    }
  }
}

/**
 * A drafted step always has requirement null, and a scenario has no requirement field. Fill an
 * absent step requirement, and remove an empty scenario requirement. Both carry no data.
 */
function withCanonicalRequirements(scenarios: unknown, notes: string[]): void {
  if (!Array.isArray(scenarios)) return;
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) continue;
    const record = scenario as Record<string, unknown>;
    if (Object.hasOwn(record, "requirement") && record.requirement === null) {
      delete record.requirement;
      notes.push(`Removed the empty requirement field of scenario ${String(record.id)}`);
    }
    if (!Array.isArray(record.steps)) continue;
    const absent = record.steps.filter(
      (step) =>
        step &&
        typeof step === "object" &&
        !Array.isArray(step) &&
        !Object.hasOwn(step, "requirement"),
    ) as Array<Record<string, unknown>>;
    for (const step of absent) step.requirement = null;
    if (absent.length)
      notes.push(
        `Filled the absent requirement of ${absent.length} steps in scenario ${String(record.id)} with null`,
      );
  }
}

/** Repair only unambiguous model-output shape errors before fixed-plan validation. */
export function normalizePublicProposal(raw: PublicProposal): {
  proposal: PublicProposal;
  notes: string[];
} {
  const proposal = structuredClone(raw) as PublicProposal & Record<string, unknown>;
  const notes: string[] = [];
  if (
    proposal.publicDevelopment &&
    typeof proposal.publicDevelopment === "object" &&
    Object.hasOwn(proposal, "views") &&
    !Object.hasOwn(proposal.publicDevelopment ?? {}, "views") &&
    Array.isArray(proposal.views)
  ) {
    (proposal.publicDevelopment as unknown as Record<string, unknown>).views = proposal.views;
    delete proposal.views;
    notes.push("Moved public views into publicDevelopment");
  }
  const plan = proposal?.publicDevelopment?.plan;
  if (
    plan &&
    Object.hasOwn(plan, "views") &&
    !Object.hasOwn(proposal.publicDevelopment, "views") &&
    Array.isArray((plan as unknown as Record<string, unknown>).views)
  ) {
    (proposal.publicDevelopment as unknown as Record<string, unknown>).views = (
      plan as unknown as Record<string, unknown>
    ).views;
    delete (plan as unknown as Record<string, unknown>).views;
    notes.push("Moved public views from the plan into publicDevelopment");
  }
  if (
    plan &&
    Object.hasOwn(proposal.publicDevelopment, "phases") &&
    !Object.hasOwn(plan, "phases") &&
    Array.isArray((proposal.publicDevelopment as unknown as Record<string, unknown>).phases)
  ) {
    (plan as unknown as Record<string, unknown>).phases = (
      proposal.publicDevelopment as unknown as Record<string, unknown>
    ).phases;
    delete (proposal.publicDevelopment as unknown as Record<string, unknown>).phases;
    notes.push("Moved public phases into publicDevelopment.plan");
  }
  withCanonicalRequirements(plan?.scenarios, notes);
  if (!plan || !Array.isArray(plan.scenarios) || !Array.isArray(proposal.publicDevelopment.views))
    return { proposal, notes };
  if (Array.isArray(proposal.publicTask?.roles) && Array.isArray(plan.roles)) {
    const roleIds = new Map<string, string>();
    const canonicalIds = new Set<string>();
    for (const role of proposal.publicTask.roles) {
      if (typeof role.id !== "string") continue;
      const canonical = role.id
        .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
        .replaceAll("_", "-")
        .toLowerCase();
      if (canonicalIds.has(canonical))
        throw new Error("Public role IDs collide after canonicalization");
      canonicalIds.add(canonical);
      if (canonical !== role.id) {
        roleIds.set(role.id, canonical);
        notes.push(`Canonicalized public role ID ${role.id} to ${canonical}`);
        role.id = canonical;
      }
    }
    for (const role of plan.roles) {
      if (typeof role.id === "string") role.id = roleIds.get(role.id) ?? role.id;
    }
    const rewriteRoleReferences = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("role."))
        return "role." + (roleIds.get(value.slice(5)) ?? value.slice(5));
      if (Array.isArray(value)) return value.map(rewriteRoleReferences);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value))
          (value as Record<string, unknown>)[key] = rewriteRoleReferences(child);
      }
      return value;
    };
    rewriteRoleReferences(proposal.publicDevelopment);
  }
  for (const scenario of plan.scenarios as unknown as Array<Record<string, unknown>>) {
    if (!Object.hasOwn(scenario, "observations")) continue;
    const steps = scenario.steps;
    if (
      !Array.isArray(steps) ||
      steps.length !== 1 ||
      typeof steps[0] !== "object" ||
      steps[0] === null ||
      Object.hasOwn(steps[0], "observations") ||
      !Array.isArray(scenario.observations)
    )
      continue;
    (steps[0] as Record<string, unknown>).observations = scenario.observations;
    delete scenario.observations;
    notes.push(`Moved scenario ${String(scenario.id)} observations into its sole step`);
  }
  const scenarioIds = new Map<string, string>();
  for (const scenario of plan.scenarios) {
    if (typeof scenario.id !== "string") continue;
    const canonical = scenario.id.replaceAll("_", "-");
    if (canonical !== scenario.id) {
      scenarioIds.set(scenario.id, canonical);
      notes.push(`Canonicalized scenario ID ${scenario.id} to ${canonical}`);
      scenario.id = canonical;
    }
    if (!Array.isArray(scenario.steps)) continue;
    for (const step of scenario.steps) {
      if (!step || typeof step !== "object" || typeof step.id !== "string") continue;
      const canonicalStep = step.id.replaceAll("_", "-");
      if (canonicalStep !== step.id) {
        notes.push(`Canonicalized step ID ${step.id} to ${canonicalStep}`);
        step.id = canonicalStep;
      }
      // A step anchor refers to an earlier step by its ID.
      const anchor = (step as { at?: { after?: { step?: unknown } } }).at?.after;
      if (anchor && typeof anchor.step === "string") anchor.step = anchor.step.replaceAll("_", "-");
    }
  }
  withoutDepartedReporters(plan.scenarios, proposal.publicDevelopment, notes);
  for (const view of proposal.publicDevelopment.views) {
    if (typeof view.scenarioId === "string")
      view.scenarioId = scenarioIds.get(view.scenarioId) ?? view.scenarioId;
    if (typeof view.id !== "string") continue;
    const canonical = view.id.replaceAll("_", "-");
    if (canonical !== view.id) {
      notes.push(`Canonicalized view ID ${view.id} to ${canonical}`);
      view.id = canonical;
    }
    if (!Array.isArray(view.requiredTransitions)) continue;
    for (const transition of view.requiredTransitions) {
      if (typeof transition.id === "string") {
        const canonicalTransition = transition.id.replaceAll("_", "-");
        if (canonicalTransition !== transition.id) {
          notes.push(`Canonicalized transition ID ${transition.id} to ${canonicalTransition}`);
          transition.id = canonicalTransition;
        }
      }
      if (transition.source.kind === "action" && typeof transition.source.stepId === "string")
        transition.source.stepId = transition.source.stepId.replaceAll("_", "-");
    }
  }
  return { proposal, notes };
}

/**
 * Repair only unambiguous shape errors of a public preparation: the shared scene, then the public
 * part of each stage with the rules of one public proposal.
 */
export function normalizePublicPreparation(
  raw: PublicPreparation,
  previous: PublicPreparation | null = null,
): { preparation: PublicPreparation; notes: string[] } {
  const preparation = structuredClone(raw) as PublicPreparation & Record<string, unknown>;
  const notes: string[] = [];
  if (!Object.hasOwn(preparation, "publicScene") && previous?.publicScene !== undefined) {
    assertPublicScene(previous.publicScene);
    preparation.publicScene = structuredClone(previous.publicScene);
    notes.push("Reused unchanged public scene from the previous proposal");
  }
  if (!Array.isArray(preparation.stages)) return { preparation, notes };
  preparation.stages = preparation.stages.map((stage, index) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
    const normalized = normalizePublicProposal({
      ...stage,
      publicScene: preparation.publicScene,
    } as PublicProposal);
    notes.push(
      ...normalized.notes.map((note) =>
        preparation.stages.length > 1 ? `Stage ${index + 1}: ${note}` : note,
      ),
    );
    const { publicScene: _scene, ...part } = normalized.proposal;
    return part;
  });
  return { preparation, notes };
}

/** Repair unambiguous structure of a private plan before its validation. */
export function normalizePrivatePlan(raw: PrivatePlan): { plan: PrivatePlan; notes: string[] } {
  const plan = structuredClone(raw) as unknown as Record<string, unknown>;
  const notes: string[] = [];
  const studio = plan.studio;
  if (studio && typeof studio === "object" && !Array.isArray(studio)) {
    const fields = studio as Record<string, unknown>;
    if (!Object.hasOwn(fields, "schema")) {
      fields.schema = STUDIO_CAPABILITY_CATALOG.planSchema;
      notes.push("Filled the fixed Studio plan schema omitted from private evaluation");
    }
    withCanonicalRequirements(fields.scenarios, notes);
    withoutDepartedReporters(fields.scenarios, plan, notes);
  }
  return { plan: plan as unknown as PrivatePlan, notes };
}

/**
 * Canonicalize unambiguous structure of the criteria sections without changing authored
 * meaning. The value holds the sections, as a criteria submission or a private evaluator does.
 */
export function normalizePrivateCriteria<T>(raw: T): { criteria: T; notes: string[] } {
  const target = structuredClone(raw) as unknown as Record<string, unknown>;
  const notes: string[] = [];
  if (!target || typeof target !== "object" || Array.isArray(target))
    return { criteria: raw, notes };
  // Criterion selections are sets of references, not additional acquisitions.
  // Preserve the first reference and its order. Never deduplicate plan steps,
  // observations, criteria, authority mappings, or merely similar bindings.
  const uniqueSelection = (container: Record<string, unknown>, key: string, label: string) => {
    const values = container[key];
    if (!Array.isArray(values)) return;
    const seen = new Set<string>();
    const unique = values.filter((value) => {
      if (value === undefined) return true; // Invalid data remains for the validator.
      const identity = hashJson(value);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (unique.length !== values.length) {
      container[key] = unique;
      notes.push(
        `Removed ${values.length - unique.length} identical ${key} references from ${label}`,
      );
    }
  };
  for (const section of ["unscaled", "visual", "codeQuality"]) {
    if (!Array.isArray(target[section])) continue;
    for (const value of target[section]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const criterion = value as Record<string, unknown>;
      const label = `${section} criterion ${String(criterion.id)}`;
      const selection = section === "unscaled" ? criterion.evidence : criterion;
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) continue;
      const selected = selection as Record<string, unknown>;
      for (const key of section === "unscaled"
        ? ["facts", "actions", "captureIds"]
        : ["captureIds"])
        uniqueSelection(selected, key, label);
      const source = selected.sourceSelection;
      if (source && typeof source === "object" && !Array.isArray(source)) {
        const fields = source as Record<string, unknown>;
        if (fields.kind === "exact_files") uniqueSelection(fields, "paths", label);
        else if (fields.kind === "all_luau_in_roots") uniqueSelection(fields, "roots", label);
      }
    }
  }
  if (Array.isArray(target.deterministic)) {
    const engineRules = new Set([
      "fact_equals",
      "fact_contains",
      "number_in_range",
      "diagnostics_empty",
      "capture_present",
      "scenario_action_succeeded",
      "scenario_barrier_passage",
      "scenario_fact_equals",
      "scenario_fact_supports_value",
      "scenario_fact_equals_actor_user_id",
      "scenario_number_delta_in_range",
      "scenario_cross_context_equals",
      "scenario_step_within",
      "build_errors_absent",
      "gui_layout_holds",
      "performance_within",
      "capture_text_contrast",
      "capture_exposure",
    ]);
    for (const criterion of target.deterministic as Array<Record<string, unknown>>) {
      const rule = criterion.rule;
      if (!rule || typeof rule !== "object") continue;
      const kind = (rule as Record<string, unknown>).kind;
      const layer =
        kind === "path_exists" || kind === "source_contains" || kind === "source_lint_absent"
          ? "static"
          : engineRules.has(String(kind))
            ? "engine"
            : null;
      if (layer && criterion.layer !== layer) {
        criterion.layer = layer;
        notes.push(
          `Derived ${layer} layer from fixed rule ${String(kind)} for ${String(criterion.id)}`,
        );
      }
    }
  }
  return { criteria: target as unknown as T, notes };
}

/**
 * The checks of a private plan that need no criteria. The criteria stage cannot change the
 * plan, so these checks run before it. Each check runs on its own.
 */
function privatePlanErrors(
  plan: PrivatePlan,
  publicProposal: PublicProposal,
  title: string,
): string[] {
  const errors: string[] = [];
  const check = (run: () => void) => {
    try {
      run();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };
  check(() => assertStudioCollectionPlan(plan.studio));
  // The other checks read the phase and scenario lists of the plan.
  const studio = plan.studio as unknown as Record<string, unknown> | null;
  if (errors.length && !(studio && Array.isArray(studio.phases) && Array.isArray(studio.scenarios)))
    return errors;
  check(() => {
    if (plan.sequence !== null) assertStudioSequenceView(plan.sequence, plan.studio);
  });
  check(() => {
    if (hashJson(plan.studio.roles) !== hashJson(publicProposal.publicTask.roles))
      throw new Error("The private plan must repeat exactly the public roles");
  });
  for (const phase of plan.studio.phases)
    if (phase.driver.kind === "manual")
      errors.push(
        `private evaluation phase ${phase.id} cannot run unattended; use a fixed driven phase that acquires evidence at the relevant interaction`,
      );
  const seed = neutralRojoSeed(title, publicProposal.publicScene);
  check(() => assertNeutralInteractionClearance(seed.project, [plan.studio]));
  check(() =>
    assertNeutralPathReferences(
      plan.studio,
      neutralWorkspacePaths(seed.project),
      publicProposal.publicTask.roles.map((role) => role.id),
    ),
  );
  return errors;
}

function exactFields(value: unknown, fields: string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} contains missing or unsupported fields`);
  const actual = Object.keys(value);
  const missing = fields.filter((field) => !actual.includes(field));
  const unexpected = actual.filter((field) => !fields.includes(field));
  if (missing.length || unexpected.length)
    throw new Error(
      `${label} contains missing [${missing.join(", ")}] or unsupported [${unexpected.slice(0, 8).join(", ")}] fields`,
    );
}

/**
 * The diagnostics describe the base of the next correction, and only that base. If Basalt kept
 * the base, its errors still apply. Otherwise the new submission is the base.
 */
function nextDiagnostics(
  base: string[],
  part: "public" | "private plan" | "private criteria",
  error: unknown,
): string[] {
  const message = `${part}: ${error instanceof Error ? error.message : String(error)}`;
  return error instanceof CorrectionNotApplied ? [...new Set([...base, message])] : [message];
}

/**
 * A correction can repair only the output of the model. A local stop before dispatch, a stop
 * of the run, the spending limit, a rate limit and an uncertain paid request end the
 * preparation as an interruption. A correction would hide their cause and use the next
 * attempt.
 */
function mustStop(error: unknown): boolean {
  return (
    error instanceof ExecutionFault ||
    error instanceof SpendingCeilingError ||
    error instanceof ModelRateLimitError ||
    error instanceof ModelRequestAdmissionError ||
    error instanceof ModelRequestValidationError ||
    error instanceof ModelRequestPendingError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        // The bounded client throws this as a plain error when a saved request is not pending.
        error.message.startsWith("Paid call uncertain")))
  );
}

/** The checks of one public stage part with the shared scene. Each one throws its error. */
function assertPublicStage(
  proposal: PublicProposal,
  prompt: string,
  title: string,
  label: string,
): void {
  try {
    assertPublicTask(proposal.publicTask);
    assertPublicDevelopmentRecipe(proposal.publicDevelopment, proposal.publicTask);
    if (proposal.publicDevelopment.plan.phases.some((phase) => phase.driver.kind === "manual"))
      throw new Error("Unattended public development cannot use manual Studio phases");
    const publicSeed = neutralRojoSeed(title, proposal.publicScene);
    assertNeutralInteractionClearance(publicSeed.project, [proposal.publicDevelopment.plan]);
    const allowedPaths = neutralWorkspacePaths(publicSeed.project);
    assertNeutralPathReferences(
      proposal.publicDevelopment,
      allowedPaths,
      proposal.publicTask.roles.map((role) => role.id),
    );
    if (proposal.publicTask.prompt !== prompt)
      throw new Error("Public task must retain the exact builder prompt");
  } catch (error) {
    throw new Error(label + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * The errors of a complete public preparation under the current checks. A frozen preparation
 * from an earlier build passes these checks again before Basalt uses it.
 */
export function publicPreparationErrors(
  preparation: PublicPreparation,
  draft: EvalDraft,
): string[] {
  try {
    assertPreparationShape(
      preparation,
      publicProposalSchema(draft.stages.length),
      "Public preparation",
    );
    exactFields(preparation, ["publicScene", "stages"], "Public preparation");
    assertPublicScene(preparation.publicScene);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  // Each stage runs on its own, so one correction sees the errors of every stage.
  const errors: string[] = [];
  for (const [index, stage] of draft.stages.entries())
    try {
      assertPublicStage(
        stagePublicProposal(preparation, index + 1),
        stage.prompt,
        draft.title,
        draft.stages.length > 1 ? `Stage ${index + 1}: ` : "",
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  return errors;
}

/**
 * Up to three corrections for each part. A semantic conflict stops for a human author edit. The
 * public part runs one time for the whole evaluation. The private part runs one time for each
 * stage against the frozen public setup. When every stage compiles, the stage revisions are made
 * from the last stage to the first, so each one names the next one.
 *
 * With a base, a stage keeps the plan of the base stage if the plan passes the current checks.
 * Then the stage keeps the checks of the unchanged criteria, and the criteria stage prepares only
 * the others, as a correction of the carried proposal. If the criteria do not compile on the plan
 * of the base, the stage prepares a new plan and new criteria.
 */
export async function prepareEvalDraft(
  draft: EvalDraft,
  roles: PreparationRoles,
  onCompiled?: (result: {
    revision: EvalRevision;
    validation: EvalValidation;
    attempt: number;
    normalizations: string[];
  }) => Promise<void>,
  publicPreparation: {
    proposal: PublicPreparation | null;
    accepted: (proposal: PublicPreparation) => Promise<void>;
  } | null = null,
  base: PreparationBase | null = null,
): Promise<PreparationResult> {
  const stagePrompts = draft.stages.map((stage) => stage.prompt);
  const staged = draft.stages.length > 1;
  const stageLabel = (index: number) => (staged ? `Stage ${index}: ` : "");
  let corrections: string[] = [];
  // The code and the authored criterion of each compiler correction. A final failure keeps
  // them, so a person can see which criterion failed and why.
  const traces = new Map<string, Pick<EvalDiagnostic, "code" | "authoredCriterionId">>();
  let failedStage = 1;
  let previousPublicProposal: PublicPreparation | null = null;
  let acceptedPublicProposal = publicPreparation?.proposal
    ? structuredClone(publicPreparation.proposal)
    : null;
  if (
    acceptedPublicProposal &&
    hashJson(acceptedPublicProposal.stages.map((stage) => stage.publicTask.prompt)) !==
      hashJson(stagePrompts)
  )
    throw new Error("Frozen public preparation belongs to different prompts");
  if (base && base.revisions.length !== draft.stages.length)
    throw new Error("The base of the preparation has a different number of stages");
  let normalizations: string[] = [];
  const reuse: PreparationReuse | null = base
    ? { baseRevisionId: base.revisions[0]!.id, stages: [] }
    : null;
  const attempts: PreparationResult["attempts"] = {
    public: 0,
    stages: draft.stages.map(() => ({ privatePlan: 0, privateCriteria: 0 })),
  };
  const failed = (): PreparationResult => ({
    revisions: [],
    validation: {
      schema: "basalt-evals/eval-validation",
      draftId: draft.id,
      revisionId: null,
      status: "preparation_failed",
      diagnostics: corrections.map((message) => ({
        code: traces.get(message)?.code ?? "invalid_proposal",
        message:
          `After ${PREPARATION_ATTEMPTS - 1} corrections, the generated instructions still had this problem: ` +
          message,
        stage: failedStage,
        authoredCriterionId: traces.get(message)?.authoredCriterionId ?? null,
      })),
      preparation: "incomplete",
      acquisition: "not_run",
      discrimination: "not_run",
      humanCalibration: "unavailable",
      controlSetHash: null,
      unreviewedClaims: [],
    },
    attempts: structuredClone(attempts),
    normalizations,
    reuse: structuredClone(reuse),
  });
  for (let attempt = 1; !acceptedPublicProposal && attempt <= PREPARATION_ATTEMPTS; attempt += 1) {
    attempts.public = attempt;
    let preparation: PublicPreparation;
    try {
      // The role repairs before its shape check. The repair below is then idempotent.
      const repairs: string[] = [];
      const raw = await roles.preparePublic(
        {
          stagePrompts,
          title: draft.title,
          slug: draft.slug,
          attempt,
          diagnostics: corrections.filter((item) => item.startsWith("public: ")),
          previousProposal: previousPublicProposal,
        },
        (submission) => {
          const normalized = normalizePublicPreparation(
            submission as unknown as PublicPreparation,
            previousPublicProposal,
          );
          repairs.push(...normalized.notes);
          return normalized.preparation as unknown as Record<string, unknown>;
        },
      );
      const normalized = normalizePublicPreparation(raw, previousPublicProposal);
      preparation = normalized.preparation;
      normalizations = [...repairs, ...normalized.notes];
    } catch (error) {
      if (mustStop(error)) throw error;
      corrections = nextDiagnostics(
        corrections.filter((item) => item.startsWith("public: ")),
        "public",
        error,
      );
      continue;
    }
    const errors = publicPreparationErrors(preparation, draft);
    if (errors.length) {
      previousPublicProposal = preparation;
      corrections = ["public: " + errors.join("; ")];
      continue;
    }
    acceptedPublicProposal = structuredClone(preparation);
    await publicPreparation?.accepted(structuredClone(preparation));
  }
  if (!acceptedPublicProposal) return failed();
  const frozenPreparation = structuredClone(acceptedPublicProposal);
  const preparationHash = hashJson(frozenPreparation);
  const proposals: EvalProposal[] = [];
  for (const [stageOffset, stage] of draft.stages.entries()) {
    const stageNumber = stageOffset + 1;
    failedStage = stageNumber;
    const stageAttempts = attempts.stages[stageOffset]!;
    const frozenPublic = stagePublicProposal(frozenPreparation, stageNumber);
    const privateSources = {
      builderPrompt: stage.prompt,
      rubric: stage.rubric,
      criteria: stage.criteria,
      evaluationStage: {
        index: stageNumber,
        count: draft.stages.length,
        earlierPrompts: stagePrompts.slice(0, stageOffset),
        gateCriterionIds: stage.gateCriterionIds,
      },
    };
    const prefix = (message: string) => stageLabel(stageNumber) + message;
    // The plan stage. The criteria stage cannot change the plan, so the plan passes its checks
    // first.
    const planStage = async (): Promise<PrivatePlan | null> => {
      corrections = [];
      let previousPlan: PrivatePlan | null = null;
      for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS; attempt += 1) {
        stageAttempts.privatePlan = attempt;
        let plan: PrivatePlan;
        const repairs: string[] = [];
        try {
          const rawPlan = await roles.preparePrivatePlan(
            {
              ...privateSources,
              publicProposal: structuredClone(frozenPublic),
              previousPlan: previousPlan ? structuredClone(previousPlan) : null,
              attempt,
              diagnostics: corrections,
            },
            (submission) => {
              const normalized = normalizePrivatePlan(submission as unknown as PrivatePlan);
              repairs.push(...normalized.notes);
              return normalized.plan as unknown as Record<string, unknown>;
            },
          );
          const normalized = normalizePrivatePlan(rawPlan);
          plan = normalized.plan;
          repairs.push(...normalized.notes);
          exactFields(plan, ["studio", "sequence"], "Private plan");
        } catch (error) {
          if (mustStop(error)) throw error;
          corrections = nextDiagnostics(corrections, "private plan", error);
          continue;
        }
        const errors = privatePlanErrors(plan, frozenPublic, draft.title);
        if (errors.length) {
          previousPlan = plan;
          corrections = errors.map((message) => "private plan: " + message);
          continue;
        }
        normalizations.push(...repairs.map(prefix));
        return plan;
      }
      return null;
    };
    const proposalOf = (privateProposal: PrivateProposal): EvalProposal => ({
      publicTask: frozenPublic.publicTask,
      publicDevelopment: frozenPublic.publicDevelopment,
      privateEvaluator: privateProposal.privateEvaluator,
      criterionMappings: privateProposal.criterionMappings,
      requiredCapabilities: privateProposal.requiredCapabilities,
      seed: neutralRojoSeed(draft.title, frozenPreparation.publicScene),
    });
    // The criterion ID tells the correction where the error is.
    const compilerCorrections = (validation: EvalValidation) =>
      validation.diagnostics.map((item) => {
        const message =
          "private criteria: " +
          (item.authoredCriterionId
            ? `authored criterion ${item.authoredCriterionId}: ${item.message}`
            : item.message);
        traces.set(message, { code: item.code, authoredCriterionId: item.authoredCriterionId });
        return message;
      });
    // The criteria stage, against the frozen plan. A carried proposal makes the first request a
    // correction of that proposal.
    const criteriaStage = async (
      plan: PrivatePlan,
      carried: PrivateProposal | null,
      carriedCorrections: string[],
    ): Promise<{ proposal: EvalProposal } | { stop: PreparationResult } | null> => {
      const planHash = hashJson(plan);
      corrections = carriedCorrections;
      let previousPrivateProposal = carried ? structuredClone(carried) : null;
      for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS; attempt += 1) {
        stageAttempts.privateCriteria = attempt;
        let privateProposal: PrivateProposal;
        const repairs: string[] = [];
        try {
          const rawPrivateProposal = await roles.preparePrivateCriteria(
            {
              ...privateSources,
              publicProposal: structuredClone(frozenPublic),
              plan: structuredClone(plan),
              previousPrivateProposal: previousPrivateProposal
                ? structuredClone(previousPrivateProposal)
                : null,
              attempt,
              diagnostics: corrections,
            },
            (submission) => {
              const normalized = normalizePrivateCriteria(submission);
              repairs.push(...normalized.notes);
              return normalized.criteria;
            },
          );
          const normalized = normalizePrivateCriteria(rawPrivateProposal.privateEvaluator);
          privateProposal = { ...rawPrivateProposal, privateEvaluator: normalized.criteria };
          repairs.push(...normalized.notes);
          exactFields(
            privateProposal,
            ["privateEvaluator", "criterionMappings", "requiredCapabilities"],
            "Private criteria",
          );
        } catch (error) {
          if (mustStop(error)) throw error;
          corrections = nextDiagnostics(corrections, "private criteria", error);
          continue;
        }
        if (
          hashJson({
            studio: privateProposal.privateEvaluator.studio,
            sequence: privateProposal.privateEvaluator.sequence,
          }) !== planHash
        )
          throw new Error("The private plan changed during the criteria stage");
        const proposal = proposalOf(privateProposal);
        previousPrivateProposal = structuredClone(privateProposal);
        if (hashJson(frozenPreparation) !== preparationHash)
          throw new Error("Public preparation changed during private compilation");
        // A check compile. The revision of an earlier stage names the next stage only at the end.
        const checked = compileEvalProposal(draft, stageNumber, proposal);
        if (!checked.revision) {
          if (
            checked.validation.status === "unsupported" ||
            checked.validation.status === "needs_clarification"
          )
            return {
              stop: {
                revisions: [],
                ...checked,
                attempts: structuredClone(attempts),
                normalizations,
                reuse: structuredClone(reuse),
              },
            };
          corrections = compilerCorrections(checked.validation);
          continue;
        }
        normalizations.push(...repairs.map(prefix));
        return { proposal };
      }
      return null;
    };
    // The plan of the base stage, if it passes the current checks.
    const baseStage = base?.revisions[stageOffset] ?? null;
    const basePlan: PrivatePlan | null = baseStage
      ? {
          studio: structuredClone(baseStage.privateEvaluator.studio),
          sequence: structuredClone(baseStage.privateEvaluator.sequence),
        }
      : null;
    let planUse: "reused" | "fallback" | "prepared" =
      basePlan && !privatePlanErrors(basePlan, frozenPublic, draft.title).length
        ? "reused"
        : "prepared";
    let outcome: Awaited<ReturnType<typeof criteriaStage>> = null;
    if (baseStage && basePlan && planUse === "reused") {
      const carried = carriedPrivateProposal(baseStage, stage);
      const carriedProposal = proposalOf(carried);
      const checked = compileEvalProposal(draft, stageNumber, carriedProposal);
      // Without diagnostics the stage needs no model request.
      outcome = checked.revision
        ? { proposal: carriedProposal }
        : await criteriaStage(basePlan, carried, compilerCorrections(checked.validation));
      if (outcome === null) planUse = "fallback";
    }
    if (outcome === null) {
      const plan = await planStage();
      if (!plan) return failed();
      outcome = await criteriaStage(plan, null, []);
    }
    if (outcome === null) return failed();
    if ("stop" in outcome) return outcome.stop;
    if (reuse && baseStage) {
      const carried =
        planUse === "reused" ? carriedCriteria(baseStage, stage, outcome.proposal) : 0;
      reuse.stages.push({
        plan: planUse,
        carriedCriteria: carried,
        preparedCriteria: stage.criteria.length - carried,
      });
    }
    proposals.push(outcome.proposal);
  }
  // Each stage revision names the next one, so the revisions are made from the last stage.
  const revisions: EvalRevision[] = [];
  let validation: EvalValidation | null = null;
  for (let stageNumber = draft.stages.length; stageNumber >= 1; stageNumber -= 1) {
    const result = compileEvalProposal(
      draft,
      stageNumber,
      proposals[stageNumber - 1]!,
      revisions[0]?.id ?? null,
    );
    if (!result.revision) throw new Error("A checked stage proposal no longer compiles");
    revisions.unshift(result.revision);
    validation = result.validation;
    await onCompiled?.({
      revision: result.revision,
      validation: result.validation,
      attempt: attempts.stages[stageNumber - 1]!.privateCriteria,
      normalizations,
    });
  }
  return {
    revisions,
    validation: validation!,
    attempts: structuredClone(attempts),
    normalizations,
    reuse,
  };
}
