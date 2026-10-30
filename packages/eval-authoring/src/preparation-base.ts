import { hashJson } from "../../contracts/src/index.js";
import type { CriterionMapping, EvalRevision } from "./compiler.js";
import { pairCriteria } from "./criterion-pairing.js";
import type { AuthoredCriterion, EvalDraft, EvalDraftStage } from "./input.js";
import type { PrivateProposal, PublicPreparation } from "./proposals.js";
import { neutralRojoSeed, type PublicScene, type PublicScenePart } from "./seed.js";

/**
 * A registered evaluation that a new preparation starts from: its draft and its stage revisions
 * in stage order. The base has the title and the stage prompts of the new draft, so only its
 * criteria can differ.
 */
export interface PreparationBase {
  draft: EvalDraft;
  revisions: EvalRevision[];
}

/** How the preparation of one stage used the tests of the base. */
interface PreparationReuseStage {
  /**
   * `reused`: the stage kept the plan of the base. `fallback`: the criteria did not compile on
   * the plan of the base, so the stage prepared a new plan. `prepared`: the plan of the base did
   * not pass the current checks, so the stage prepared a new plan.
   */
  plan: "reused" | "fallback" | "prepared";
  /** The authored criteria whose checks are the checks of the base, byte for byte. */
  carriedCriteria: number;
  /** The other authored criteria of the stage. */
  preparedCriteria: number;
}

export interface PreparationReuse {
  /** The revision of the first stage of the base. */
  baseRevisionId: string;
  stages: PreparationReuseStage[];
}

/** A registered draft can be the base of a draft with the same title and stage prompts. */
export function canBeBase(base: EvalDraft, draft: EvalDraft): boolean {
  return (
    base.title === draft.title &&
    hashJson(base.stages.map((stage) => stage.prompt)) ===
      hashJson(draft.stages.map((stage) => stage.prompt))
  );
}

// The seed has these fixed parts before the parts of the public scene.
const FIXED_PARTS = new Set(["Ground", "EvalSpawn"]);

function vector(value: unknown, start: number): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < start + 3) return null;
  const items = value.slice(start, start + 3);
  return items.every((item) => typeof item === "number")
    ? (items as [number, number, number])
    : null;
}

/**
 * The public preparation of the base, from its stage revisions. A revision keeps the public
 * scene only in its seed, so the scene comes from the seed. The result is null when that scene
 * does not give the exact seed of each stage again.
 */
export function basePublicPreparation(base: PreparationBase): PublicPreparation | null {
  const tree = (base.revisions[0]?.seed.project as { tree?: { Workspace?: unknown } } | undefined)
    ?.tree;
  const workspace = tree?.Workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
  const parts: PublicScenePart[] = [];
  for (const [name, node] of Object.entries(workspace)) {
    if (name.startsWith("$") || FIXED_PARTS.has(name)) continue;
    const properties = (node as { $properties?: Record<string, unknown> } | null)?.$properties;
    const position = vector(properties?.CFrame, 0);
    const size = vector(properties?.Size, 0);
    if (
      !properties ||
      !position ||
      !size ||
      typeof properties.Anchored !== "boolean" ||
      typeof properties.CanCollide !== "boolean" ||
      typeof properties.Transparency !== "number"
    )
      return null;
    parts.push({
      name,
      position,
      size,
      anchored: properties.Anchored,
      canCollide: properties.CanCollide,
      transparency: properties.Transparency,
    });
  }
  const publicScene: PublicScene = { parts };
  try {
    const seed = hashJson(neutralRojoSeed(base.draft.title, publicScene));
    if (base.revisions.some((revision) => hashJson(revision.seed) !== seed)) return null;
  } catch {
    return null;
  }
  return {
    publicScene,
    stages: base.revisions.map((revision) => ({
      publicTask: structuredClone(revision.publicTask),
      publicDevelopment: structuredClone(revision.publicDevelopment),
    })),
  };
}

/** The parts of an authored criterion that its checks read. The ID and the place can change. */
function sameAuthoredCriterion(from: AuthoredCriterion, to: AuthoredCriterion): boolean {
  const content = (criterion: AuthoredCriterion) =>
    hashJson({
      text: criterion.text,
      required: criterion.required,
      evidenceClass: criterion.evidenceClass,
      polarity: criterion.polarity,
      clauses: criterion.clauses.map((clause) => clause.text),
    });
  return content(from) === content(to);
}

/** The base criteria that stay in a stage, by base ID, with their criteria in the new stage. */
function unchangedCriteria(
  base: EvalRevision,
  stage: EvalDraftStage,
): Map<string, { from: AuthoredCriterion; to: AuthoredCriterion }> {
  const target = {
    authored: { criteria: stage.criteria },
    criterionMappings: [],
  } as unknown as Pick<EvalRevision, "authored" | "criterionMappings">;
  const unchanged = new Map<string, { from: AuthoredCriterion; to: AuthoredCriterion }>();
  for (const pair of pairCriteria(base, target).pairs) {
    const from = base.authored.criteria.find((item) => item.id === pair.from.criterionId)!;
    const to = stage.criteria.find((item) => item.id === pair.to.criterionId)!;
    if (sameAuthoredCriterion(from, to)) unchanged.set(from.id, { from, to });
  }
  return unchanged;
}

/**
 * The private proposal of one stage from the stage revision of the base. It keeps the checks of
 * each unchanged authored criterion byte for byte, and drops the checks of a changed or removed
 * one. A check that also checks a changed criterion is dropped too. The mappings take the IDs
 * and the places of the criteria in the new draft. The compiler then names the criteria that
 * have no check.
 */
export function carriedPrivateProposal(base: EvalRevision, stage: EvalDraftStage): PrivateProposal {
  const unchanged = unchangedCriteria(base, stage);
  const kept = new Set(
    base.criterionMappings
      .map((mapping) => mapping.executableCriterionId)
      .filter(
        (id): id is string =>
          id !== null &&
          base.criterionMappings.every(
            (mapping) =>
              mapping.executableCriterionId !== id ||
              mapping.authoredCriterionId === null ||
              unchanged.has(mapping.authoredCriterionId),
          ),
      ),
  );
  const criterionMappings: CriterionMapping[] = base.criterionMappings.flatMap((mapping) => {
    if (mapping.executableCriterionId !== null && !kept.has(mapping.executableCriterionId))
      return [];
    if (mapping.authoredCriterionId === null) return [structuredClone(mapping)];
    const pair = unchanged.get(mapping.authoredCriterionId);
    if (!pair) return [];
    return [
      {
        ...structuredClone(mapping),
        authoredCriterionId: pair.to.id,
        // Equal text gives equal clauses, so a clause keeps its place in the criterion.
        authoredClauseIds: mapping.authoredClauseIds.map(
          (id) => pair.to.clauses[pair.from.clauses.findIndex((clause) => clause.id === id)]!.id,
        ),
        authority:
          mapping.authority.source === "human_rubric"
            ? { source: "human_rubric", start: pair.to.start, end: pair.to.end }
            : structuredClone(mapping.authority),
      },
    ];
  });
  const evaluator = structuredClone(base.privateEvaluator);
  const keep = <T extends { id: string }>(items: T[]) => items.filter((item) => kept.has(item.id));
  return {
    privateEvaluator: {
      ...evaluator,
      deterministic: keep(evaluator.deterministic),
      codeQuality: keep(evaluator.codeQuality),
      visual: keep(evaluator.visual),
      unscaled: keep(evaluator.unscaled),
    },
    criterionMappings,
    requiredCapabilities: structuredClone(base.requiredCapabilities),
  };
}

/**
 * The authored criteria of a prepared stage whose checks are the checks of the base. Each one is
 * unchanged, has a check, and each of its checks is equal to the check of the base.
 */
export function carriedCriteria(
  base: EvalRevision,
  stage: EvalDraftStage,
  proposal: PrivateProposal,
): number {
  const checks = (evaluator: PrivateProposal["privateEvaluator"]) =>
    new Map(
      [
        ...evaluator.deterministic,
        ...evaluator.codeQuality,
        ...evaluator.visual,
        ...evaluator.unscaled,
      ].map((item) => [item.id, hashJson(item)]),
    );
  const before = checks(base.privateEvaluator),
    after = checks(proposal.privateEvaluator);
  return [...unchangedCriteria(base, stage).values()].filter(({ to }) => {
    const ids = proposal.criterionMappings
      .filter((mapping) => mapping.authoredCriterionId === to.id)
      .map((mapping) => mapping.executableCriterionId)
      .filter((id): id is string => id !== null);
    return ids.length > 0 && ids.every((id) => after.get(id) === before.get(id));
  }).length;
}
