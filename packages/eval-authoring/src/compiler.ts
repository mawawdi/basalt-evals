import {
  authoredScoreAnchors,
  authoredNumericScale,
  authoredScoreRange,
} from "./rubric-grading.js";
import {
  assertEvaluatorSpec,
  assertPublicTask,
  authoredBounds,
  hashJson,
  isSafeRelativePath,
  type EvaluatorSpec,
  type EvidenceClass,
  type Polarity,
  type PublicTask,
  type StudioFactRequest,
  type StudioObservationBinding,
} from "../../contracts/src/index.js";
import {
  assertPublicDevelopmentRecipe,
  type PublicDevelopmentRecipe,
} from "../../development/src/index.js";
import type { AuthoredCriterion, EvalDraft } from "./input.js";
import { authoredRequired, type RubricNode } from "./rubric-document.js";
import { STUDIO_CAPABILITY_CATALOG } from "../../contracts/src/capabilities.js";
import { criterionObservationBindings } from "./criterion-material.js";
import { renderedSelection } from "./rendered-selection.js";
import {
  assertNeutralInteractionClearance,
  assertNeutralPathReferences,
  neutralWorkspacePaths,
} from "./seed.js";

export type EvidenceMethod = "deterministic" | "code" | "visual" | "unscaled" | "human";
export type CapabilityName =
  | (typeof STUDIO_CAPABILITY_CATALOG.supported)[number]
  | (typeof STUDIO_CAPABILITY_CATALOG.unavailable)[number];

export interface CriterionMapping {
  authoredCriterionId: string | null;
  authoredClauseIds: string[];
  authority: { source: "builder_prompt" | "human_rubric"; start: number; end: number };
  method: EvidenceMethod;
  executableCriterionId: string | null;
  rationale: string;
}

export interface EvalProposal {
  publicTask: PublicTask;
  publicDevelopment: PublicDevelopmentRecipe;
  privateEvaluator: EvaluatorSpec;
  seed: { project: unknown; sources: Array<{ path: string; text: string }> };
  criterionMappings: CriterionMapping[];
  requiredCapabilities: CapabilityName[];
}

/**
 * The place of one revision in its evaluation. An evaluation without stages has one stage. The
 * revision of stage 1 binds the later stages through `nextRevisionId`, so its identity is the
 * identity of the whole evaluation.
 */
interface EvalRevisionStage {
  /** The stage number, from 1. */
  index: number;
  /** The number of stages of the evaluation. */
  count: number;
  /** The authored prompts of the earlier stages, in order. The builder of this stage sees them. */
  earlierPrompts: string[];
  /**
   * Authored criterion IDs of this stage. The next stage starts only when the required code
   * checks of these criteria pass on each observation of the build.
   */
  gateCriterionIds: string[];
  /** The revision of the next stage, or null for the last stage. */
  nextRevisionId: string | null;
}

/** One prepared stage of an evaluation. Execution reads each stage as its own revision. */
export interface EvalRevision extends EvalProposal {
  schema: "basalt-evals/eval-revision";
  id: string;
  draftId: string;
  builderPromptHash: string;
  rubricHash: string;
  authored: {
    builderPrompt: string;
    rubric: string;
    criteria: AuthoredCriterion[];
    document: RubricNode[];
  };
  stage: EvalRevisionStage;
}

/** The executable code checks of the gate of a stage, in the sequence of the evaluator. */
export function gateCheckIds(
  revision: Pick<EvalRevision, "stage" | "criterionMappings" | "privateEvaluator">,
): string[] {
  const executable = new Set(
    revision.criterionMappings
      .filter(
        (mapping) =>
          mapping.authoredCriterionId !== null &&
          revision.stage.gateCriterionIds.includes(mapping.authoredCriterionId),
      )
      .map((mapping) => mapping.executableCriterionId),
  );
  return revision.privateEvaluator.deterministic
    .filter((criterion) => executable.has(criterion.id))
    .map((criterion) => criterion.id);
}

/** Exact governing passages, shared by proposed controls and final judgments. */
export function criterionAuthoredPassages(revision: EvalRevision, criterionId: string): string[] {
  const passages: string[] = [];
  for (const mapping of revision.criterionMappings.filter(
    (item) => item.executableCriterionId === criterionId,
  )) {
    const criterion = revision.authored.criteria.find(
      (item) => item.id === mapping.authoredCriterionId,
    );
    for (const id of criterion?.contextNodeIds ?? []) {
      const node = revision.authored.document.find((item) => item.id === id);
      if (!node) throw new Error("Authored rubric context is missing");
      passages.push(node.text);
    }
    const source =
      mapping.authority.source === "builder_prompt"
        ? revision.authored.builderPrompt
        : revision.authored.rubric;
    passages.push(source.slice(mapping.authority.start, mapping.authority.end));
  }
  return [...new Set(passages)];
}

function manualPhaseErrors(proposal: EvalProposal): string[] {
  const errors: string[] = [];
  for (const [label, plan] of [
    ["public development", proposal.publicDevelopment.plan],
    ["private evaluation", proposal.privateEvaluator.studio],
  ] as const)
    for (const phase of plan.phases)
      if (phase.driver.kind === "manual")
        errors.push(
          `${label} phase ${phase.id} cannot run unattended; use a fixed driven phase that acquires evidence at the relevant interaction`,
        );
  return errors;
}

export function assertUnattendedEvalRevision(revision: EvalRevision): void {
  const errors = manualPhaseErrors(revision);
  if (errors.length > 0) throw new Error(errors.join("; "));
  assertNeutralInteractionClearance(revision.seed.project, [
    revision.publicDevelopment.plan,
    revision.privateEvaluator.studio,
  ]);
}

/** The sole projection permitted to enter an evaluated builder workspace. */
export function publicEvalRevisionView(revision: EvalRevision) {
  const content = {
    publicTask: revision.publicTask,
    publicDevelopment: revision.publicDevelopment,
    seed: revision.seed,
  };
  return { publicContentHash: hashJson(content), ...content };
}

export interface EvalDiagnostic {
  code:
    | "missing_coverage"
    | "invalid_proposal"
    | "unsupported_capability"
    | "authority_conflict"
    /** A check samples a value that the build creates at a fixed time. */
    | "fixed_state_sample"
    /** The same, for a gate criterion. Only a change or an action result can decide a gate. */
    | "gate_fixed_state_sample";
  message: string;
  /** The stage of the diagnostic, from 1. An authored criterion ID is unique only in its stage. */
  stage: number;
  authoredCriterionId: string | null;
}

/** A diagnostic before the compiler adds its stage. */
type StageDiagnostic = Omit<EvalDiagnostic, "stage">;

export interface EvalValidation {
  schema: "basalt-evals/eval-validation";
  draftId: string;
  revisionId: string | null;
  status:
    "preparation_failed" | "needs_clarification" | "unsupported" | "ready" | "controls_checked";
  diagnostics: EvalDiagnostic[];
  preparation: "compiled" | "incomplete";
  acquisition: "not_run" | "validated" | "incomplete";
  discrimination: "not_run" | "validated" | "failed" | "incomplete";
  humanCalibration: "unavailable" | "available";
  controlSetHash: string | null;
  unreviewedClaims: string[];
}

/** Capabilities are fixed runner primitives, never generated evaluator code. */
const IMPLEMENTED_CAPABILITIES: ReadonlySet<CapabilityName> = new Set(
  STUDIO_CAPABILITY_CATALOG.supported,
);

function diagnostic(
  code: EvalDiagnostic["code"],
  message: string,
  authoredCriterionId: string | null = null,
): StageDiagnostic {
  return { code, message, authoredCriterionId };
}

function explicitPassingScore(text: string): number | null {
  const match =
    /\b(?:minimum passing score(?:\s+is)?(?:\s+exactly)?|passing score(?:\s+is)?|score\s+(?:of\s+)?at\s+least)\s*[:=]?\s*(\d+(?:\.\d+)?)\b/iu.exec(
      text,
    );
  return match ? Number(match[1]) : null;
}

function requiresStudDistance(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*studs?\b/iu.test(text);
}

function boundStudioFact(
  evaluator: EvaluatorSpec,
  binding: StudioObservationBinding,
): StudioFactRequest | null {
  if ("phaseId" in binding)
    return (
      evaluator.studio.phases
        .find((phase) => phase.id === binding.phaseId)
        ?.facts.find((fact) => fact.id === binding.factId) ?? null
    );
  return (
    evaluator.studio.scenarios
      .find((scenario) => scenario.id === binding.scenarioId)
      ?.steps.find((step) => step.id === binding.stepId)
      ?.observations.find(
        (observation) =>
          observation.context === binding.context && observation.fact.id === binding.factId,
      )?.fact ?? null
  );
}

function boundStudioFactKind(
  evaluator: EvaluatorSpec,
  binding: StudioObservationBinding,
): string | null {
  return boundStudioFact(evaluator, binding)?.kind ?? null;
}

/**
 * Route one mapped check by the evidence class of its human rubric item. A model judges
 * rendered frames only for appearance. Timing, motion and causality need runtime facts.
 */
function evidenceClassDiagnostics(
  proposal: EvalProposal,
  mapping: CriterionMapping,
  evidenceClass: EvidenceClass | null,
): StageDiagnostic[] {
  const id = mapping.executableCriterionId;
  const fail = (message: string, code: EvalDiagnostic["code"] = "invalid_proposal") => [
    diagnostic(code, message, mapping.authoredCriterionId),
  ];
  const judged =
    mapping.method === "visual"
      ? proposal.privateEvaluator.visual.find((item) => item.id === id)
      : mapping.method === "unscaled"
        ? proposal.privateEvaluator.unscaled.find((item) => item.id === id)
        : undefined;
  if (judged && judged.evidenceClass !== evidenceClass)
    return fail(
      `Criterion ${judged.id} must use the evidence class that the rubric author set: ${String(evidenceClass)}. A model cannot set or change it.`,
    );
  const selection = judged ? renderedSelection(judged) : { captureIds: [], sequence: false };
  const rendered = selection.captureIds.length > 0 || selection.sequence;
  if (rendered && evidenceClass === null)
    return fail(
      "Set an evidence class for this criterion with an `Evidence class:` line. The judge can use images only for an appearance criterion.",
      "authority_conflict",
    );
  if (evidenceClass === "appearance") {
    if (mapping.method === "code")
      return fail(
        "An appearance criterion needs rendered frames or a runtime fact. Source review cannot show what a player sees.",
      );
    if (mapping.method === "unscaled" && !rendered)
      return fail(
        `Criterion ${String(id)}: an appearance criterion needs bound signed rendered frames in captureIds or sequence. Combine sourceSelection, facts and captureIds in this criterion when its authored passage requires multiple kinds of evidence.`,
      );
    return [];
  }
  if (evidenceClass === null) return [];
  if (rendered)
    return fail(
      `A ${evidenceClass} criterion needs a runtime-fact requirement. Frames at two per second cannot establish ${evidenceClass}; remove captureIds and sequence and bind signed runtime facts.`,
    );
  const deterministic = proposal.privateEvaluator.deterministic.find((item) => item.id === id);
  if (
    mapping.method === "code" ||
    (mapping.method === "deterministic" && deterministic?.layer !== "engine") ||
    (mapping.method === "unscaled" &&
      proposal.privateEvaluator.unscaled.find((item) => item.id === id)?.evidence.facts.length ===
        0)
  )
    return fail(
      `A ${evidenceClass} criterion needs a signed runtime fact: an engine rule or evidence.facts. Source text cannot establish ${evidenceClass}.`,
    );
  return [];
}

/** Only the human rubric author sets the polarity of a judged criterion. */
function polarityDiagnostics(
  proposal: EvalProposal,
  mapping: CriterionMapping,
  polarity: Polarity,
): StageDiagnostic[] {
  const id = mapping.executableCriterionId;
  const judged =
    mapping.method === "visual"
      ? proposal.privateEvaluator.visual.find((item) => item.id === id)
      : mapping.method === "unscaled"
        ? proposal.privateEvaluator.unscaled.find((item) => item.id === id)
        : undefined;
  return judged && judged.polarity !== polarity
    ? [
        diagnostic(
          "invalid_proposal",
          `Criterion ${judged.id} must use the polarity that the rubric author set: ${polarity}. A model cannot set or change it.`,
          mapping.authoredCriterionId,
        ),
      ]
    : [];
}

/**
 * Validate one generated interpretation of one stage against the untouched human rubric of that
 * stage. `stageNumber` counts from 1. A stored revision of an earlier stage names the revision of
 * the next stage. Preparation also compiles an earlier stage without it, only to read the
 * diagnostics.
 */
export function compileEvalProposal(
  draft: EvalDraft,
  stageNumber: number,
  proposal: EvalProposal,
  nextRevisionId: string | null = null,
): { revision: EvalRevision | null; validation: EvalValidation } {
  const authored = draft.stages[stageNumber - 1];
  if (!authored || !Number.isSafeInteger(stageNumber))
    throw new Error("The draft has no such stage");
  if (nextRevisionId !== null && stageNumber === draft.stages.length)
    throw new Error("The last stage has no next stage revision");
  // Earlier prompts are public context of this stage, so a source path can come from them.
  const publicPrompts = [
    ...draft.stages.slice(0, stageNumber - 1).map((stage) => stage.prompt),
    authored.prompt,
  ];
  const diagnostics: StageDiagnostic[] = [];
  if (
    !proposal ||
    typeof proposal !== "object" ||
    Object.keys(proposal).sort().join(",") !==
      "criterionMappings,privateEvaluator,publicDevelopment,publicTask,requiredCapabilities,seed"
  )
    return {
      revision: null,
      validation: {
        schema: "basalt-evals/eval-validation",
        draftId: draft.id,
        revisionId: null,
        status: "preparation_failed",
        diagnostics: [
          {
            ...diagnostic(
              "invalid_proposal",
              "Generated eval proposal contains unsupported fields",
            ),
            stage: stageNumber,
          },
        ],
        preparation: "incomplete",
        acquisition: "not_run",
        discrimination: "not_run",
        humanCalibration: "unavailable",
        controlSetHash: null,
        unreviewedClaims: [],
      },
    };
  // Each check runs on its own, so one correction can see all errors of the proposal.
  const check = (run: () => void) => {
    try {
      run();
    } catch (error) {
      diagnostics.push(
        diagnostic("invalid_proposal", error instanceof Error ? error.message : String(error)),
      );
    }
  };
  check(() => assertPublicTask(proposal.publicTask));
  check(() => assertEvaluatorSpec(proposal.privateEvaluator));
  check(() => assertPublicDevelopmentRecipe(proposal.publicDevelopment, proposal.publicTask));
  // The checks below read the shapes that the checks above accept.
  if (diagnostics.length === 0) {
    check(() => {
      if (proposal.publicTask.prompt !== authored.prompt)
        throw new Error("The public task must retain the exact authored builder prompt");
    });
    check(() => {
      if (proposal.privateEvaluator.task.slug !== proposal.publicTask.slug)
        throw new Error("Private evaluation is bound to a different public task");
    });
    check(() => {
      if (
        hashJson(proposal.publicTask.roles) !== hashJson(proposal.publicDevelopment.plan.roles) ||
        hashJson(proposal.publicTask.roles) !== hashJson(proposal.privateEvaluator.studio.roles)
      )
        throw new Error("Public development and private evaluation must use the same public roles");
    });
    const neutralPaths = neutralWorkspacePaths(proposal.seed?.project);
    check(() =>
      assertNeutralInteractionClearance(proposal.seed?.project, [
        proposal.publicDevelopment.plan,
        proposal.privateEvaluator.studio,
      ]),
    );
    check(() =>
      assertNeutralPathReferences(
        [
          proposal.publicDevelopment.plan,
          proposal.publicDevelopment.views,
          proposal.privateEvaluator.studio,
        ],
        neutralPaths,
        proposal.publicTask.roles.map((role) => role.id),
      ),
    );
    check(() => {
      if (
        !proposal.seed ||
        typeof proposal.seed !== "object" ||
        !Array.isArray(proposal.seed.sources) ||
        proposal.seed.sources.length === 0
      )
        throw new Error("A neutral seed with source files is required");
      const paths = new Set<string>();
      for (const source of proposal.seed.sources) {
        if (
          !source ||
          !isSafeRelativePath(source.path) ||
          !/\.luau?$/u.test(source.path) ||
          typeof source.text !== "string" ||
          !proposal.publicTask.seed.sourceRoots.some((root) =>
            source.path.startsWith(root + "/"),
          ) ||
          paths.has(source.path)
        )
          throw new Error("The neutral seed contains an unsafe or duplicate Luau source");
        paths.add(source.path);
      }
    });
  }
  if (diagnostics.length > 0)
    return {
      revision: null,
      validation: {
        schema: "basalt-evals/eval-validation",
        draftId: draft.id,
        revisionId: null,
        status: "preparation_failed",
        diagnostics: diagnostics.map((item) => ({ ...item, stage: stageNumber })),
        preparation: "incomplete",
        acquisition: "not_run",
        discrimination: "not_run",
        humanCalibration: "unavailable",
        controlSetHash: null,
        unreviewedClaims: [],
      },
    };
  if (!Array.isArray(proposal.requiredCapabilities))
    diagnostics.push(diagnostic("invalid_proposal", "Capability requirements are missing"));
  else
    for (const capability of proposal.requiredCapabilities) {
      if (!IMPLEMENTED_CAPABILITIES.has(capability))
        diagnostics.push(
          new Set<string>(STUDIO_CAPABILITY_CATALOG.unavailable).has(capability)
            ? diagnostic(
                "unsupported_capability",
                "Basalt cannot collect evidence for the Studio capability " + capability + ".",
              )
            : diagnostic(
                "invalid_proposal",
                "Unknown required capability " +
                  capability +
                  ". Use the declared capability catalog; an invented name does not establish unsupported authored behavior.",
              ),
        );
    }
  for (const message of manualPhaseErrors(proposal))
    diagnostics.push(diagnostic("invalid_proposal", message));
  // Only human rubric text sets a time bound. A drafted plan never carries one.
  for (const [label, plan] of [
    ["publicDevelopment.plan", proposal.publicDevelopment.plan],
    ["privateEvaluator.studio", proposal.privateEvaluator.studio],
  ] as const)
    for (const scenario of plan.scenarios)
      for (const step of scenario.steps)
        if (step.requirement !== null)
          diagnostics.push(
            diagnostic(
              "invalid_proposal",
              `${label} scenario ${scenario.id} step ${step.id}: set requirement to null. A drafted plan cannot set a time bound; a person adds it from the rubric`,
            ),
          );
  const codeSelections = [
    ...proposal.privateEvaluator.codeQuality.map((criterion) => criterion.sourceSelection),
    ...proposal.privateEvaluator.unscaled.flatMap((criterion) =>
      criterion.evidence.sourceSelection ? [criterion.evidence.sourceSelection] : [],
    ),
  ];
  for (const selection of codeSelections) {
    if (selection.kind !== "exact_files") continue;
    for (const path of selection.paths)
      if (!publicPrompts.some((prompt) => prompt.includes(path)))
        diagnostics.push(
          diagnostic(
            "invalid_proposal",
            `Exact source file ${path} was not required by the authored public builder prompt`,
            null,
          ),
        );
  }
  for (const criterion of proposal.privateEvaluator.deterministic) {
    const rule = criterion.rule;
    if (rule.kind === "fact_equals") {
      const phase = proposal.privateEvaluator.studio.phases.find(
        (item) => item.id === rule.phaseId,
      );
      const fact = phase?.facts.find((item) => item.id === rule.factId);
      if (
        (phase?.driver.kind === "wait_for_exists" || phase?.driver.kind === "observe_from_actor") &&
        fact &&
        "path" in fact &&
        fact.path.startsWith("role.")
      )
        diagnostics.push(
          diagnostic(
            "invalid_proposal",
            `Check ${criterion.id} turns a candidate-dependent capture window into a pass/fail deadline; use categorical evidence instead`,
          ),
        );
    }
    if (rule.kind === "scenario_fact_equals") {
      const scenario = proposal.privateEvaluator.studio.scenarios.find(
        (item) => item.id === rule.scenarioId,
      );
      const observedStep = scenario?.steps.find((step) => step.id === rule.stepId);
      const observedFact = observedStep?.observations.find(
        (item) => item.context === rule.context && item.fact.id === rule.factId,
      )?.fact;
      const candidateRole =
        observedFact && "path" in observedFact && observedFact.path.startsWith("role.");
      const afterAction =
        observedStep &&
        scenario?.steps
          .slice(0, scenario.steps.indexOf(observedStep) + 1)
          .some((step) => step.action.kind !== "wait");
      if (
        (observedFact?.kind === "instance" ||
          observedFact?.kind === "instance_name" ||
          observedFact?.kind === "instance_value" ||
          observedFact?.kind === "replication_probe") &&
        ((candidateRole && rule.expected !== false) || afterAction)
      ) {
        const authoredIds = proposal.criterionMappings
          .filter((mapping) => mapping.executableCriterionId === criterion.id)
          .flatMap((mapping) =>
            mapping.authoredCriterionId === null ? [] : [mapping.authoredCriterionId],
          );
        const gate = authoredIds.find((id) => authored.gateCriterionIds.includes(id));
        diagnostics.push(
          gate
            ? diagnostic(
                "gate_fixed_state_sample",
                `Check ${criterion.id} uses a fixed state sample that can reject a slower valid outcome. The author made this criterion a gate, so it needs a required code check that samples no fixed state: a change across an action (scenario_number_delta_in_range) or an action result (scenario_action_succeeded), when the authored wording states one. If the wording states only a value at one moment, no code check is valid, and a person must change the gate`,
                gate,
              )
            : diagnostic(
                "fixed_state_sample",
                `Check ${criterion.id} uses a fixed state sample that can reject a slower valid outcome; use scenario_fact_supports_value or an authored timed rule`,
                authoredIds[0] ?? null,
              ),
        );
      }
    }
    if (
      (rule.kind === "fact_equals" ||
        rule.kind === "scenario_fact_equals" ||
        rule.kind === "scenario_fact_supports_value") &&
      rule.field === "className" &&
      (rule.expected === "BasePart" ||
        rule.expected === "GuiObject" ||
        rule.expected === "ValueBase")
    )
      diagnostics.push(
        diagnostic(
          "invalid_proposal",
          `Check ${criterion.id} compares concrete ClassName to abstract ${rule.expected}; use a semantic role existence check or an exact concrete class`,
        ),
      );
    if (criterion.rule.kind !== "path_exists" && criterion.rule.kind !== "source_contains")
      continue;
    const path = criterion.rule.path;
    if (
      !publicPrompts.some((prompt) => prompt.includes(path)) &&
      !proposal.seed.sources.some((source) => source.path === path)
    )
      diagnostics.push(
        diagnostic(
          "invalid_proposal",
          `Exact source file ${path} was not required by the authored public builder prompt`,
          null,
        ),
      );
  }
  const criteria = new Map(authored.criteria.map((criterion) => [criterion.id, criterion]));
  const executableIds = {
    deterministic: new Set(
      (Array.isArray(proposal.privateEvaluator?.deterministic)
        ? proposal.privateEvaluator.deterministic
        : []
      ).map((item) => item.id),
    ),
    code: new Set(
      (Array.isArray(proposal.privateEvaluator?.codeQuality)
        ? proposal.privateEvaluator.codeQuality
        : []
      ).map((item) => item.id),
    ),
    visual: new Set(
      (Array.isArray(proposal.privateEvaluator?.visual)
        ? proposal.privateEvaluator.visual
        : []
      ).map((item) => item.id),
    ),
    unscaled: new Set(
      (Array.isArray(proposal.privateEvaluator?.unscaled)
        ? proposal.privateEvaluator.unscaled
        : []
      ).map((item) => item.id),
    ),
  };
  const executableById = new Map<
    string,
    {
      method: "deterministic" | "code" | "visual" | "unscaled";
      required: boolean;
      minimumPassingScore: number | null;
    }
  >([
    ...proposal.privateEvaluator.deterministic.map(
      (item) =>
        [
          item.id,
          { method: "deterministic" as const, required: item.required, minimumPassingScore: null },
        ] as const,
    ),
    ...proposal.privateEvaluator.codeQuality.map(
      (item) =>
        [
          item.id,
          {
            method: "code" as const,
            required: item.required,
            minimumPassingScore: item.minimumPassingScore,
          },
        ] as const,
    ),
    ...proposal.privateEvaluator.visual.map(
      (item) =>
        [
          item.id,
          {
            method: "visual" as const,
            required: item.required,
            minimumPassingScore: item.minimumPassingScore,
          },
        ] as const,
    ),
    ...proposal.privateEvaluator.unscaled.map(
      (item) =>
        [
          item.id,
          { method: "unscaled" as const, required: item.required, minimumPassingScore: null },
        ] as const,
    ),
  ]);
  const requiredExecutable = new Map<string, EvidenceMethod>([
    ...proposal.privateEvaluator.deterministic
      .filter((item) => item.required)
      .map((item) => [item.id, "deterministic" as const] as const),
    ...proposal.privateEvaluator.codeQuality
      .filter((item) => item.required)
      .map((item) => [item.id, "code" as const] as const),
    ...proposal.privateEvaluator.visual
      .filter((item) => item.required)
      .map((item) => [item.id, "visual" as const] as const),
    ...proposal.privateEvaluator.unscaled
      .filter((item) => item.required)
      .map((item) => [item.id, "unscaled" as const] as const),
  ]);
  const requiredCount =
    proposal.privateEvaluator.deterministic.filter((item) => item.required).length +
    proposal.privateEvaluator.codeQuality.filter((item) => item.required).length +
    proposal.privateEvaluator.visual.filter((item) => item.required).length +
    proposal.privateEvaluator.unscaled.filter((item) => item.required).length;
  if (requiredExecutable.size !== requiredCount)
    diagnostics.push(
      diagnostic("invalid_proposal", "Required executable criterion IDs must be distinct"),
    );
  const mapped = new Set<string>();
  const mappedClauses = new Set<string>();
  const mappedExecutable = new Set<string>();
  if (!Array.isArray(proposal.criterionMappings))
    diagnostics.push(diagnostic("invalid_proposal", "Criterion mappings are missing"));
  else
    for (const mapping of proposal.criterionMappings) {
      if (
        !mapping ||
        typeof mapping !== "object" ||
        Object.keys(mapping).sort().join(",") !==
          "authoredClauseIds,authoredCriterionId,authority,executableCriterionId,method,rationale"
      ) {
        diagnostics.push(
          diagnostic("invalid_proposal", "Criterion mapping has unsupported fields"),
        );
        continue;
      }
      const reference = mapping.authority;
      if (reference?.source !== "human_rubric" || mapping.authoredCriterionId === null) {
        diagnostics.push(
          diagnostic(
            "invalid_proposal",
            "Only authored rubric items may create scored criteria; prompt coverage is unscored",
          ),
        );
        continue;
      }
      const authorityText = reference?.source === "human_rubric" ? authored.rubric : null;
      if (
        authorityText === null ||
        !reference ||
        Object.keys(reference).sort().join(",") !== "end,source,start" ||
        !Number.isSafeInteger(reference.start) ||
        !Number.isSafeInteger(reference.end) ||
        reference.start < 0 ||
        reference.end <= reference.start ||
        reference.end > authorityText.length ||
        !authorityText.slice(reference.start, reference.end).trim()
      ) {
        diagnostics.push(
          diagnostic("invalid_proposal", "Criterion authority has no exact authored source span"),
        );
        continue;
      }
      const rubricCriterion =
        mapping.authoredCriterionId === null ? null : criteria.get(mapping.authoredCriterionId);
      if (
        !Array.isArray(mapping.authoredClauseIds) ||
        new Set(mapping.authoredClauseIds).size !== mapping.authoredClauseIds.length ||
        (rubricCriterion
          ? !mapping.authoredClauseIds.length ||
            mapping.authoredClauseIds.some(
              (id) => !rubricCriterion.clauses.some((clause) => clause.id === id),
            )
          : mapping.authoredClauseIds.length !== 0)
      ) {
        diagnostics.push(
          diagnostic(
            "missing_coverage",
            "Name exact authored clauses covered by this evidence and grading method",
            mapping.authoredCriterionId,
          ),
        );
        continue;
      }
      if (
        reference.source === "human_rubric" &&
        (!rubricCriterion ||
          rubricCriterion.start !== reference.start ||
          rubricCriterion.end !== reference.end)
      ) {
        diagnostics.push(
          diagnostic("invalid_proposal", "Criterion mapping changed its authored passage"),
        );
        continue;
      }
      if (typeof mapping.rationale !== "string" || !mapping.rationale.trim())
        diagnostics.push(
          diagnostic(
            "invalid_proposal",
            "Criterion mapping needs a rationale",
            mapping.authoredCriterionId,
          ),
        );
      if (mapping.method === "human") {
        diagnostics.push(
          diagnostic(
            "authority_conflict",
            "Basalt has no automatic check for this criterion. Edit the criterion to state a result that Basalt can observe or measure. A review by a person cannot replace an automatic check.",
            mapping.authoredCriterionId,
          ),
        );
        if (mapping.executableCriterionId !== null)
          diagnostics.push(
            diagnostic(
              "invalid_proposal",
              "Human-only criteria cannot name an executable check",
              mapping.authoredCriterionId,
            ),
          );
        if (
          !rubricCriterion ||
          !proposal.privateEvaluator?.humanReview?.includes(rubricCriterion.text)
        )
          diagnostics.push(
            diagnostic(
              "missing_coverage",
              "Human review must retain the exact original criterion wording",
              mapping.authoredCriterionId,
            ),
          );
      } else if (
        !["deterministic", "code", "visual", "unscaled"].includes(mapping.method) ||
        !mapping.executableCriterionId ||
        !executableIds[mapping.method as "deterministic" | "code" | "visual" | "unscaled"]?.has(
          mapping.executableCriterionId,
        )
      )
        diagnostics.push(
          diagnostic(
            "invalid_proposal",
            `Criterion mapping names no executable check: ${mapping.method} ${mapping.executableCriterionId}; retain or restore that mapped check in privateEvaluator`,
            mapping.authoredCriterionId,
          ),
        );
      else {
        const executable = executableById.get(mapping.executableCriterionId);
        if (!executable || executable.method !== mapping.method)
          diagnostics.push(
            diagnostic(
              "invalid_proposal",
              "Criterion mapping method differs from its executable check",
              mapping.authoredCriterionId,
            ),
          );
        else {
          const source = authorityText.slice(reference.start, reference.end);
          const governingSource = [
            ...(rubricCriterion?.contextNodeIds ?? []).map(
              (id) => authored.document.find((node) => node.id === id)!.text,
            ),
            source,
          ].join("\n");
          if (mapping.method === "deterministic") {
            const criterion = proposal.privateEvaluator.deterministic.find(
              (item) => item.id === mapping.executableCriterionId,
            );
            if (criterion?.rule.kind === "scenario_fact_supports_value" && criterion.required)
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "A finite positive-value observation may support judgment but cannot be a required failure gate without an authored deadline",
                  mapping.authoredCriterionId,
                ),
              );
            // Only the author's words set a bound. Its quote must come from this criterion.
            for (const bound of criterion ? authoredBounds(criterion.rule) : [])
              if (!governingSource.includes(bound.quote))
                diagnostics.push(
                  diagnostic(
                    "authority_conflict",
                    `Check ${mapping.executableCriterionId} uses the bound ${bound.value} from "${bound.quote}", but the criterion text does not contain that quote. Write the bound in the criterion, or remove it from the check.`,
                    mapping.authoredCriterionId,
                  ),
                );
          }
          diagnostics.push(
            ...evidenceClassDiagnostics(proposal, mapping, rubricCriterion?.evidenceClass ?? null),
            ...polarityDiagnostics(proposal, mapping, rubricCriterion?.polarity ?? "presence"),
          );
          if (
            reference.source === "human_rubric" &&
            (mapping.method === "code" || mapping.method === "visual") &&
            !authoredNumericScale(governingSource)
          )
            diagnostics.push(
              diagnostic(
                "invalid_proposal",
                "Unscaled human wording needs a categorical unscaled criterion, not generated numerical anchors",
                mapping.authoredCriterionId,
              ),
            );
          if (mapping.method === "unscaled" && authoredNumericScale(governingSource))
            diagnostics.push(
              diagnostic(
                "invalid_proposal",
                "An authored numerical scale needs its original anchors and threshold preserved",
                mapping.authoredCriterionId,
              ),
            );
          if (mapping.method === "unscaled") {
            const categorical = proposal.privateEvaluator.unscaled.find(
              (item) => item.id === mapping.executableCriterionId,
            );
            const statement = categorical?.statement;
            if (statement?.trim() !== source.trim())
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "Categorical criterion must use the exact authored passage as its statement",
                  mapping.authoredCriterionId,
                ),
              );
            if (
              categorical &&
              /\b(?:runtime|run-time|script)\s+(?:errors?|exceptions?)\b/iu.test(source) &&
              !criterionObservationBindings(categorical, proposal.privateEvaluator.studio).some(
                (binding) =>
                  boundStudioFactKind(proposal.privateEvaluator, binding) === "diagnostics",
              )
            )
              diagnostics.push(
                diagnostic(
                  "missing_coverage",
                  `Criterion ${categorical.id}: runtime-error wording needs a diagnostics observation selected in this criterion's evidence.facts. A diagnostic collected elsewhere in the plan or selected by another criterion is not supplied to this judgment. Preserve the authored passage and bind the relevant observation after the behavior window.`,
                  mapping.authoredCriterionId,
                ),
              );
            if (
              categorical &&
              rubricCriterion?.evidenceClass === "motion" &&
              categorical.evidence.facts.length > 0 &&
              requiresStudDistance(source) &&
              !categorical.evidence.facts.some((binding) =>
                ["part_motion", "actor_part_motion"].includes(
                  boundStudioFactKind(proposal.privateEvaluator, binding) ?? "",
                ),
              )
            )
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "Authored stud distance needs a bound sampled part-motion observation",
                  mapping.authoredCriterionId,
                ),
              );
            if (
              categorical &&
              /\banchored\b/iu.test(source) &&
              (() => {
                if (categorical.evidence.facts.length === 0) return true;
                const facts = categorical.evidence.facts.map((binding) =>
                  boundStudioFact(proposal.privateEvaluator, binding),
                );
                const motionPaths = new Set(
                  facts.flatMap((fact) =>
                    fact &&
                    (fact.kind === "part_motion" ||
                      fact.kind === "actor_part_motion" ||
                      fact.kind === "part_route_trace")
                      ? [fact.path]
                      : [],
                  ),
                );
                if (
                  facts.some(
                    (fact) =>
                      fact &&
                      (fact.kind === "part_physics" || fact.kind === "part_physics_trace") &&
                      (motionPaths.size === 0 || motionPaths.has(fact.path)),
                  )
                )
                  return false;
                return !proposal.criterionMappings.some((other) => {
                  if (
                    other.authoredCriterionId !== mapping.authoredCriterionId ||
                    other.method !== "deterministic"
                  )
                    return false;
                  const criterion = proposal.privateEvaluator.deterministic.find(
                    (item) => item.id === other.executableCriterionId,
                  );
                  const rule = criterion?.rule;
                  if (
                    !rule ||
                    (rule.kind !== "fact_equals" && rule.kind !== "scenario_fact_equals") ||
                    !(
                      (rule.field === "anchored" && rule.expected === true) ||
                      (rule.field === "everUnanchored" && rule.expected === false)
                    )
                  )
                    return false;
                  const binding: StudioObservationBinding =
                    rule.kind === "fact_equals"
                      ? { phaseId: rule.phaseId, factId: rule.factId }
                      : {
                          scenarioId: rule.scenarioId,
                          stepId: rule.stepId,
                          context: rule.context,
                          factId: rule.factId,
                        };
                  const physics = boundStudioFact(proposal.privateEvaluator, binding);
                  return (
                    physics != null &&
                    (physics.kind === "part_physics" || physics.kind === "part_physics_trace") &&
                    (motionPaths.size === 0 || motionPaths.has(physics.path))
                  );
                });
              })()
            )
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "Authored anchored-part requirement needs a bound part_physics or part_physics_trace observation on the moving part, either in the categorical facts or as a second executable check mapped to this same authored criterion",
                  mapping.authoredCriterionId,
                ),
              );
          }
          if (
            reference.source === "human_rubric" &&
            (mapping.method === "code" || mapping.method === "visual")
          ) {
            const scaled =
              mapping.method === "code"
                ? proposal.privateEvaluator.codeQuality.find(
                    (item) => item.id === mapping.executableCriterionId,
                  )
                : proposal.privateEvaluator.visual.find(
                    (item) => item.id === mapping.executableCriterionId,
                  );
            const anchors = authoredScoreAnchors(governingSource);
            try {
              if (
                scaled &&
                hashJson(scaled.scoreRange) !== hashJson(authoredScoreRange(governingSource))
              )
                diagnostics.push(
                  diagnostic(
                    "invalid_proposal",
                    "Generated scoring range differs from the authored bounds and increments",
                    mapping.authoredCriterionId,
                  ),
                );
            } catch (error) {
              diagnostics.push(
                diagnostic("authority_conflict", String(error), mapping.authoredCriterionId),
              );
            }
            if (
              scaled &&
              authoredNumericScale(governingSource) &&
              (anchors.length !== scaled.anchors.length ||
                anchors.some(
                  (anchor) =>
                    !scaled.anchors.some(
                      (candidate) =>
                        candidate.score === anchor.score && candidate.label === anchor.label,
                    ),
                ))
            )
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "Generated score anchors differ from the exact authored scores and labels",
                  mapping.authoredCriterionId,
                ),
              );
            if (
              scaled &&
              explicitPassingScore(governingSource) === null &&
              scaled.minimumPassingScore !== null
            )
              diagnostics.push(
                diagnostic(
                  "invalid_proposal",
                  "No passing score was authored; preserve null and report the score without inventing acceptance",
                  mapping.authoredCriterionId,
                ),
              );
          }
          const threshold = explicitPassingScore(governingSource);
          if (threshold !== null && executable.minimumPassingScore !== threshold)
            diagnostics.push(
              diagnostic(
                "invalid_proposal",
                `Authored minimum passing score ${threshold} differs from generated ${String(executable.minimumPassingScore)}`,
                mapping.authoredCriterionId,
              ),
            );
          const required =
            reference.source === "human_rubric"
              ? authored.criteria.find((item) => item.id === mapping.authoredCriterionId)!.required
              : authoredRequired(authorityText.slice(reference.start, reference.end));
          if (executable.required !== required)
            diagnostics.push(
              diagnostic(
                "invalid_proposal",
                required
                  ? "Required authored criterion became optional"
                  : "Optional authored criterion became required",
                mapping.authoredCriterionId,
              ),
            );
          mappedExecutable.add(mapping.executableCriterionId);
        }
      }
      if (mapping.authoredCriterionId !== null) mapped.add(mapping.authoredCriterionId);
      for (const clauseId of mapping.authoredClauseIds) mappedClauses.add(clauseId);
    }
  for (const criterion of authored.criteria)
    for (const clause of criterion.clauses)
      if (!mappedClauses.has(clause.id))
        diagnostics.push(
          diagnostic(
            "missing_coverage",
            `No evidence and grading method covers authored clause at ${clause.start}–${clause.end}: ${clause.text}`,
            criterion.id,
          ),
        );
  for (const criterion of authored.criteria) {
    const bindings = proposal.criterionMappings.filter(
      (item) => item.authoredCriterionId === criterion.id,
    );
    const outcomes = new Set(bindings.map((item) => item.executableCriterionId ?? "human"));
    if (outcomes.size > 1)
      diagnostics.push(
        diagnostic(
          "invalid_proposal",
          "One authored rubric item must produce one reported criterion; combine its supporting observations",
          criterion.id,
        ),
      );
  }
  for (const criterion of authored.criteria)
    if (!mapped.has(criterion.id))
      diagnostics.push(
        diagnostic(
          "missing_coverage",
          "No evidence and grading method covers this rubric passage",
          criterion.id,
        ),
      );
  for (const id of [
    ...proposal.privateEvaluator.deterministic,
    ...proposal.privateEvaluator.codeQuality,
    ...proposal.privateEvaluator.visual,
    ...proposal.privateEvaluator.unscaled,
  ].map((item) => item.id))
    if (!mappedExecutable.has(id))
      diagnostics.push(
        diagnostic(
          "missing_coverage",
          "Executable criterion has no authored rubric authority: " +
            id +
            ". Add a criterion mapping with its exact source span; one authored rubric item produces one reported criterion with all supporting observations.",
        ),
      );
  // A score says how much of a thing the build shows. It cannot measure an absent thing.
  for (const criterion of authored.criteria)
    if (
      criterion.polarity === "absence" &&
      authoredNumericScale(
        [
          ...criterion.contextNodeIds.map(
            (id) => authored.document.find((node) => node.id === id)!.text,
          ),
          criterion.text,
        ].join("\n"),
      )
    )
      diagnostics.push(
        diagnostic(
          "authority_conflict",
          `The criterion at characters ${criterion.start}–${criterion.end} has the polarity absence and a score scale. A score cannot measure a thing that must be absent. Remove the score scale or the Polarity line.`,
          criterion.id,
        ),
      );
  for (const node of authored.document.filter((node) => node.role === "unresolved"))
    diagnostics.push(
      diagnostic(
        "authority_conflict",
        `The success criteria text at characters ${node.start}–${node.end} is not clear. Write it as a criterion, as context, or as grading information on its own line, for example an evidence class.`,
      ),
    );
  if (authored.criteria.length === 0)
    diagnostics.push(
      diagnostic(
        "authority_conflict",
        "The success criteria contain context or grading information but no criterion. Add one or more criteria.",
      ),
    );
  // The author picks the gate. Each gate criterion needs a required code check, because only a
  // code check decides a gate without a model.
  for (const id of authored.gateCriterionIds) {
    const checks = new Set(
      proposal.criterionMappings
        .filter((mapping) => mapping.authoredCriterionId === id)
        .map((mapping) => mapping.executableCriterionId),
    );
    if (
      !proposal.privateEvaluator.deterministic.some(
        (criterion) => checks.has(criterion.id) && criterion.required,
      )
    )
      diagnostics.push(
        diagnostic(
          "invalid_proposal",
          "The author made this criterion a gate for the next stage. A gate needs a required deterministic code check. Check this criterion with a required deterministic criterion.",
          id,
        ),
      );
  }
  const status = diagnostics.some((item) => item.code === "unsupported_capability")
    ? ("unsupported" as const)
    : diagnostics.some((item) => item.code === "authority_conflict")
      ? ("needs_clarification" as const)
      : diagnostics.length > 0
        ? ("preparation_failed" as const)
        : ("ready" as const);
  if (diagnostics.length > 0)
    return {
      revision: null,
      validation: {
        schema: "basalt-evals/eval-validation",
        draftId: draft.id,
        revisionId: null,
        status,
        diagnostics: diagnostics.map((item) => ({ ...item, stage: stageNumber })),
        preparation: "incomplete",
        acquisition: "not_run",
        discrimination: "not_run",
        humanCalibration: "unavailable",
        controlSetHash: null,
        unreviewedClaims: [],
      },
    };
  const body = {
    schema: "basalt-evals/eval-revision" as const,
    draftId: draft.id,
    builderPromptHash: authored.promptHash,
    rubricHash: authored.rubricHash,
    authored: {
      builderPrompt: authored.prompt,
      rubric: authored.rubric,
      criteria: authored.criteria,
      document: authored.document,
    },
    stage: {
      index: stageNumber,
      count: draft.stages.length,
      earlierPrompts: publicPrompts.slice(0, -1),
      gateCriterionIds: [...authored.gateCriterionIds],
      nextRevisionId,
    },
    ...proposal,
  };
  const revision: EvalRevision = { ...body, id: hashJson(body) };
  return {
    revision,
    validation: {
      schema: "basalt-evals/eval-validation",
      draftId: draft.id,
      revisionId: revision.id,
      status: "ready",
      diagnostics: [],
      preparation: "compiled",
      acquisition: "not_run",
      discrimination: "not_run",
      humanCalibration: "unavailable",
      controlSetHash: null,
      unreviewedClaims: [],
    },
  };
}
