import { STUDIO_CAPABILITY_CATALOG } from "../../contracts/src/capabilities.js";
import { stableJson } from "../../contracts/src/index.js";
import type { ModelTurnRequest } from "../../model-client/src/contracts.js";
import type { EvalRevision } from "./compiler.js";
import type { AuthoredCriterion } from "./input.js";
import { MAX_PREPARATION_PROPOSAL_BYTES } from "./preparation-request.js";

/** How the private plan tests one authored criterion. */
const COVERAGE_VALUES = ["matches", "partial", "stricter", "untested"] as const;
export type Coverage = (typeof COVERAGE_VALUES)[number];

/** How the builder prompt asks for one authored criterion. */
const PROMPT_SUPPORT_VALUES = ["stated", "implied", "unstated"] as const;
export type PromptSupport = (typeof PROMPT_SUPPORT_VALUES)[number];

/** How one private check relates to the authored criteria and to the public contract. */
const CHECK_SUPPORT_VALUES = ["supports", "orphan", "unstated_in_public_contract"] as const;
export type CheckSupport = (typeof CHECK_SUPPORT_VALUES)[number];

/** The answer of the coverage model for one authored criterion. */
export interface CriterionCoverage {
  criterionId: string;
  /** The plan elements and the words that support the values. The model writes it first. */
  evidenceFor: string;
  /** The plan elements and the words that contradict the values. Empty when none do. */
  evidenceAgainst: string;
  coverage: Coverage;
  promptSupport: PromptSupport;
  /** True when the criterion asks about more than one evidence class. */
  mixesClasses: boolean;
  note: string;
}

/** The answer of the coverage model for one private check, an executable criterion of the plan. */
export interface CheckCoverage {
  checkId: string;
  evidenceFor: string;
  evidenceAgainst: string;
  support: CheckSupport;
  /** The authored criteria that the check decides. Empty for an orphan check. */
  criterionIds: string[];
  note: string;
}

export const COVERAGE_TOOL = "submit_coverage_notes";
const MAX_COVERAGE_NOTE_LENGTH = 600;
/**
 * The quote reserves this bound, because the plan does not exist before preparation. A larger
 * plan gives incomplete notes.
 */
export const MAX_COVERAGE_PLAN_BYTES = MAX_PREPARATION_PROPOSAL_BYTES;
/** Up to this many criteria share one request. More criteria get one request each. */
const MAX_SHARED_COVERAGE_CRITERIA = 8;

/**
 * The part of the notes that one request asks for: all criteria and all checks, one criterion,
 * or all checks.
 */
export type CoverageScope =
  { kind: "all" } | { kind: "criterion"; criterionId: string } | { kind: "checks" };

/** One request for a small set. A large set gets one request for each criterion and the checks. */
export function coverageScopes(criteria: AuthoredCriterion[]): CoverageScope[] {
  if (criteria.length <= MAX_SHARED_COVERAGE_CRITERIA) return [{ kind: "all" }];
  return [
    ...criteria.map((criterion) => ({ kind: "criterion" as const, criterionId: criterion.id })),
    { kind: "checks" },
  ];
}

/** Each request has its own stage, so each one has its own ledger request and receipts. */
export function coverageStage(scope: CoverageScope): string {
  return scope.kind === "all"
    ? "coverage"
    : scope.kind === "checks"
      ? "coverage:checks"
      : `coverage:${scope.criterionId}`;
}

interface CoverageInput {
  builderPrompt: string;
  rubric: string;
  criteria: AuthoredCriterion[];
  /** Null only in the quote. */
  plan: CoveragePlan | null;
}

type CoveragePlan = Pick<
  EvalRevision,
  "privateEvaluator" | "criterionMappings" | "requiredCapabilities"
> & { roles: EvalRevision["publicTask"]["roles"] };

/** The parts of a revision that decide the answers. The builder never reads them. */
export function coveragePlan(revision: EvalRevision): CoveragePlan {
  return {
    roles: revision.publicTask.roles,
    privateEvaluator: revision.privateEvaluator,
    criterionMappings: revision.criterionMappings,
    requiredCapabilities: revision.requiredCapabilities,
  };
}

/** The private checks of a plan, in the sequence of the plan. The quote has none. */
export function coverageCheckIds(plan: CoveragePlan | null): string[] {
  if (!plan) return [];
  const evaluator = plan.privateEvaluator;
  return [
    ...evaluator.deterministic,
    ...evaluator.codeQuality,
    ...evaluator.visual,
    ...evaluator.unscaled,
  ].map((criterion) => criterion.id);
}

const SYSTEM = [
  "You examine a prepared evaluation of a Roblox mechanic.",
  "A person wrote the builder prompt and the success criteria. The builder model reads only the builder prompt and the public roles.",
  "A preparation model then wrote a private test plan: privateEvaluator, criterionMappings and the public roles.",
  "Basalt runs this plan in Roblox Studio. Code checks the deterministic rules, and a judge model reads the evidence that each other criterion binds.",
  "Each executable criterion in privateEvaluator (deterministic, codeQuality, visual and unscaled) is one private check.",
  "Report only the relation between the prompt, the criteria and the plan. Do not rate their quality, and do not write a new plan.",
  "In each entry, write evidenceFor and evidenceAgainst before the values. Name the plan elements and quote the words of the prompt or the criterion that support or contradict your values, for example a check ID, a phase ID, a scenario ID or a fact ID. Write an empty evidenceAgainst when nothing contradicts the values.",
  "For each criterion, give coverage: matches when the rules and the bound evidence let Basalt decide the criterion as the person wrote it; partial when the plan tests only a part of the criterion, or when its evidence cannot show a part of the criterion; stricter when the plan asks for more than the criterion, for example a threshold, a deadline, a name or a count that the person did not write; untested when no rule or judgment in the plan decides the criterion, or when the plan tests a different behavior.",
  "For each criterion, give promptSupport: stated when the builder prompt asks for it; implied when a builder can infer it from the prompt and the public roles; unstated when a builder cannot know it from them.",
  "For each criterion, set mixesClasses to true when its text asks about more than one evidence class: appearance, timing, motion or causality.",
  "A criterion with the polarity absence names a thing that the build must not show. It is met only when that thing is absent.",
  "For each private check, give support: supports when it decides one or more authored criteria, and list them in criterionIds; orphan when it decides no authored criterion, with an empty criterionIds; unstated_in_public_contract when it tests a name, a value or a behavior that neither the builder prompt nor the public roles state, and list the criteria that it relates to.",
  "Write a note of one to three sentences for each entry.",
  "Use capabilityCatalog to find what each observation records.",
  `Submit exactly one entry for each criterionId and each checkId that the tool ${COVERAGE_TOOL} lists.`,
].join(" ");

function entrySchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** The same request factory serves the quote and dispatch. */
export function coverageRequest(
  model: { id: string; maxOutputTokens: number },
  seed: number,
  input: CoverageInput,
  scope: CoverageScope,
): ModelTurnRequest {
  const checkIds = coverageCheckIds(input.plan);
  // The quote bounds the plan and the check IDs in the tool, because neither exists before it.
  if (
    input.plan &&
    Buffer.byteLength(stableJson({ plan: input.plan, checkIds }), "utf8") > MAX_COVERAGE_PLAN_BYTES
  )
    throw new Error("The test plan is larger than the quoted bound of the coverage notes");
  const reported =
    scope.kind === "criterion"
      ? input.criteria.filter((criterion) => criterion.id === scope.criterionId)
      : input.criteria;
  if (scope.kind === "criterion" && reported.length !== 1)
    throw new Error("The coverage request names an unknown authored criterion");
  const evidence = {
    evidenceFor: { type: "string" },
    evidenceAgainst: { type: "string" },
  };
  const criteria = {
    type: "array",
    items: entrySchema({
      criterionId: { type: "string", enum: reported.map((criterion) => criterion.id) },
      ...evidence,
      coverage: { type: "string", enum: [...COVERAGE_VALUES] },
      promptSupport: { type: "string", enum: [...PROMPT_SUPPORT_VALUES] },
      mixesClasses: { type: "boolean" },
      note: { type: "string" },
    }),
  };
  const checks = {
    type: "array",
    items: entrySchema({
      checkId: { type: "string", enum: checkIds },
      ...evidence,
      support: { type: "string", enum: [...CHECK_SUPPORT_VALUES] },
      criterionIds: {
        type: "array",
        items: { type: "string", enum: input.criteria.map((criterion) => criterion.id) },
      },
      note: { type: "string" },
    }),
  };
  return {
    model: model.id,
    seed,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: stableJson({
          builderPrompt: input.builderPrompt,
          rubric: input.rubric,
          // A request for one criterion shows only that criterion. The checks need all of them.
          authoredCriteria: reported.map((criterion) => ({
            id: criterion.id,
            text: criterion.text,
            required: criterion.required,
            evidenceClass: criterion.evidenceClass,
            polarity: criterion.polarity,
          })),
          plan: input.plan,
          capabilityCatalog: STUDIO_CAPABILITY_CATALOG,
        }),
      },
    ],
    tools: [
      {
        name: COVERAGE_TOOL,
        description:
          scope.kind === "all"
            ? "Submit one entry for each authored criterion and one entry for each private check."
            : scope.kind === "checks"
              ? "Submit one entry for each private check."
              : "Submit one entry for the authored criterion.",
        parameters: entrySchema(
          scope.kind === "all"
            ? { criteria, checks }
            : scope.kind === "checks"
              ? { checks }
              : { criteria },
        ),
        strict: true,
      },
    ],
    maxOutputTokens: model.maxOutputTokens,
  };
}

function text(value: unknown, required: boolean): value is string {
  return (
    typeof value === "string" &&
    (!required || value.trim().length > 0) &&
    value.length <= MAX_COVERAGE_NOTE_LENGTH
  );
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}

/**
 * Accept exactly one valid entry for each criterion and check of the scope, in the authored
 * sequence and the plan sequence.
 */
export function coverageNotes(
  value: Record<string, unknown>,
  input: { criteria: AuthoredCriterion[]; checkIds: string[] },
  scope: CoverageScope,
): { criteria: CriterionCoverage[]; checks: CheckCoverage[] } {
  const reported =
    scope.kind === "checks"
      ? []
      : scope.kind === "criterion"
        ? input.criteria.filter((criterion) => criterion.id === scope.criterionId)
        : input.criteria;
  const checkIds = scope.kind === "criterion" ? [] : input.checkIds;
  const lists =
    scope.kind === "all"
      ? ["criteria", "checks"]
      : scope.kind === "checks"
        ? ["checks"]
        : ["criteria"];
  if (!exactKeys(value, lists) || lists.some((key) => !Array.isArray(value[key])))
    throw new Error(`The coverage notes must contain only the lists ${lists.join(" and ")}`);
  const criteria = new Map<string, CriterionCoverage>();
  for (const entry of (value.criteria ?? []) as unknown[]) {
    if (
      !exactKeys(entry, [
        "criterionId",
        "evidenceFor",
        "evidenceAgainst",
        "coverage",
        "promptSupport",
        "mixesClasses",
        "note",
      ]) ||
      typeof entry.criterionId !== "string" ||
      !reported.some((criterion) => criterion.id === entry.criterionId) ||
      criteria.has(entry.criterionId) ||
      !text(entry.evidenceFor, false) ||
      !text(entry.evidenceAgainst, false) ||
      !COVERAGE_VALUES.includes(entry.coverage as Coverage) ||
      !PROMPT_SUPPORT_VALUES.includes(entry.promptSupport as PromptSupport) ||
      typeof entry.mixesClasses !== "boolean" ||
      !text(entry.note, true)
    )
      throw new Error(
        "Each criterion entry must name one authored criterion one time, with known values, evidence text and a short note",
      );
    criteria.set(entry.criterionId, {
      criterionId: entry.criterionId,
      evidenceFor: entry.evidenceFor.trim(),
      evidenceAgainst: entry.evidenceAgainst.trim(),
      coverage: entry.coverage as Coverage,
      promptSupport: entry.promptSupport as PromptSupport,
      mixesClasses: entry.mixesClasses,
      note: entry.note.trim(),
    });
  }
  if (criteria.size !== reported.length)
    throw new Error("The coverage notes must contain an entry for each authored criterion");
  const authored = new Set(input.criteria.map((criterion) => criterion.id));
  const checks = new Map<string, CheckCoverage>();
  for (const entry of (value.checks ?? []) as unknown[]) {
    if (
      !exactKeys(entry, [
        "checkId",
        "evidenceFor",
        "evidenceAgainst",
        "support",
        "criterionIds",
        "note",
      ]) ||
      typeof entry.checkId !== "string" ||
      !checkIds.includes(entry.checkId) ||
      checks.has(entry.checkId) ||
      !text(entry.evidenceFor, false) ||
      !text(entry.evidenceAgainst, false) ||
      !CHECK_SUPPORT_VALUES.includes(entry.support as CheckSupport) ||
      !Array.isArray(entry.criterionIds) ||
      entry.criterionIds.some((id) => typeof id !== "string" || !authored.has(id)) ||
      new Set(entry.criterionIds).size !== entry.criterionIds.length ||
      // A check that supports criteria names them. An orphan check names no criterion.
      (entry.support === "supports" && entry.criterionIds.length === 0) ||
      (entry.support === "orphan" && entry.criterionIds.length !== 0) ||
      !text(entry.note, true)
    )
      throw new Error(
        "Each check entry must name one private check one time, with a known support value, the authored criteria that it decides and a short note",
      );
    checks.set(entry.checkId, {
      checkId: entry.checkId,
      evidenceFor: entry.evidenceFor.trim(),
      evidenceAgainst: entry.evidenceAgainst.trim(),
      support: entry.support as CheckSupport,
      // The authored sequence keeps equal answers equal.
      criterionIds: input.criteria
        .map((criterion) => criterion.id)
        .filter((id) => (entry.criterionIds as string[]).includes(id)),
      note: entry.note.trim(),
    });
  }
  if (checks.size !== checkIds.length)
    throw new Error("The coverage notes must contain an entry for each private check");
  return {
    criteria: reported.map((criterion) => criteria.get(criterion.id)!),
    checks: checkIds.map((id) => checks.get(id)!),
  };
}
