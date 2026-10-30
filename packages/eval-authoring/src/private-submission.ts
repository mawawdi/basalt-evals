import { hashJson } from "../../contracts/src/index.js";
import { assertExactRecordKeys } from "../../contracts/src/validation.js";
import type { AuthoredCriterion } from "./input.js";
import type { PrivateProposal } from "./proposals.js";

interface AuthoredPreparationSources {
  builderPrompt: string;
  rubric: string;
  criteria: AuthoredCriterion[];
}

/** Models select human authority by identity. They do not calculate offsets or author wording. */
export function authoredAuthorityCatalog(input: AuthoredPreparationSources) {
  return [
    ...input.criteria.map((criterion) => {
      if (input.rubric.slice(criterion.start, criterion.end) !== criterion.text)
        throw new Error("Authored criterion differs from its original rubric passage");
      return {
        id: `rubric-${criterion.id}`,
        source: "human_rubric" as const,
        start: criterion.start,
        end: criterion.end,
        text: criterion.text,
        required: criterion.required,
        // Read-only routing authority. Only the human rubric author sets these two values.
        evidenceClass: criterion.evidenceClass,
        polarity: criterion.polarity,
        authoredCriterionId: criterion.id,
        clauseIds: criterion.clauses.map((clause) => clause.id),
      };
    }),
  ];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Compile the sole current model submission shape into canonical executable metadata. */
export function resolvePrivateSubmission(
  raw: unknown,
  input: AuthoredPreparationSources,
): PrivateProposal {
  const proposal = object(structuredClone(raw), "Private submission");
  assertExactRecordKeys(
    proposal,
    ["privateEvaluator", "criterionMappings", "requiredCapabilities"],
    "private submission fields",
  );
  const authorities = authoredAuthorityCatalog(input);
  if (!Array.isArray(proposal.criterionMappings))
    throw new Error("Private submission needs criterion mappings");
  // Collect the error of each mapping and criterion, so one correction sees all of them.
  const errors: string[] = [];
  const unmapped = new Set<unknown>();
  const selected = proposal.criterionMappings.flatMap((value, index) => {
    try {
      const mapping = object(value, "Criterion mapping submission");
      assertExactRecordKeys(
        mapping,
        ["authorityId", "authoredClauseIds", "method", "executableCriterionId", "rationale"],
        "criterion mapping submission fields",
      );
      const authority = authorities.find((item) => item.id === mapping.authorityId);
      if (!authority) {
        unmapped.add(mapping.executableCriterionId);
        throw new Error(
          `Criterion ${String(mapping.executableCriterionId)} selects unknown authored authority ${String(mapping.authorityId)}; generated public summaries are not authored requirements`,
        );
      }
      return [{ mapping, authority }];
    } catch (error) {
      errors.push(`criterionMappings/${index}: ${(error as Error).message}`);
      return [];
    }
  });
  proposal.criterionMappings = selected.map(({ mapping, authority }) => ({
    authoredCriterionId: authority.authoredCriterionId,
    authoredClauseIds: mapping.authoredClauseIds,
    authority: { source: authority.source, start: authority.start, end: authority.end },
    method: mapping.method,
    executableCriterionId: mapping.executableCriterionId,
    rationale: mapping.rationale,
  }));
  const evaluator = object(proposal.privateEvaluator, "Private evaluator submission");
  if (!Array.isArray(evaluator.unscaled))
    throw new Error("Private evaluator needs categorical criteria");
  evaluator.unscaled = evaluator.unscaled.map((value, index) => {
    try {
      const criterion = object(value, "Categorical submission");
      assertExactRecordKeys(criterion, ["id", "evidence"], "categorical submission fields");
      const bindings = selected.filter(
        ({ mapping }) =>
          mapping.method === "unscaled" && mapping.executableCriterionId === criterion.id,
      );
      const ids = new Set(bindings.map(({ authority }) => authority.id));
      // A mapping error above already names a criterion without a valid mapping.
      if (ids.size !== 1 && unmapped.has(criterion.id)) return value;
      if (ids.size !== 1)
        throw new Error(
          `Categorical criterion ${String(criterion.id)} must select exactly one authored passage`,
        );
      const authority = bindings[0]!.authority;
      return {
        id: criterion.id,
        statement: authority.text,
        required: authority.required,
        evidenceClass: authority.evidenceClass,
        polarity: authority.polarity,
        evidence: criterion.evidence,
      };
    } catch (error) {
      errors.push(`privateEvaluator/unscaled/${index}: ${(error as Error).message}`);
      return value;
    }
  });
  if (!Array.isArray(evaluator.visual)) throw new Error("Private evaluator needs visual criteria");
  evaluator.visual = evaluator.visual.map((value, index) => {
    const criterion = object(value, "Visual submission");
    for (const [field, name] of [
      ["evidenceClass", "an evidence class"],
      ["polarity", "a polarity"],
    ] as const)
      if (Object.hasOwn(criterion, field)) {
        errors.push(`privateEvaluator/visual/${index}: Only the human rubric author sets ${name}`);
        return value;
      }
    const authorities = new Set(
      selected
        .filter(
          ({ mapping }) =>
            mapping.method === "visual" && mapping.executableCriterionId === criterion.id,
        )
        .map(({ authority }) => authority),
    );
    // The compiler reports a visual check without exactly one authored passage.
    const authority = authorities.size === 1 ? [...authorities][0]! : null;
    return {
      ...criterion,
      evidenceClass: authority?.evidenceClass ?? null,
      polarity: authority?.polarity ?? "presence",
    };
  });
  if (errors.length === 1) throw new Error(errors[0]);
  if (errors.length > 1)
    throw new Error(`${errors.length} private submission errors:\n${errors.join("\n")}`);
  return proposal as unknown as PrivateProposal;
}

/** Corrections see the same submission shape that the tool accepts, never compiler-owned fields. */
export function privateSubmission(proposal: PrivateProposal, input: AuthoredPreparationSources) {
  const authorities = authoredAuthorityCatalog(input);
  return {
    ...proposal,
    privateEvaluator: {
      ...proposal.privateEvaluator,
      visual: proposal.privateEvaluator.visual.map(
        ({ evidenceClass: _class, polarity: _polarity, ...criterion }) => criterion,
      ),
      unscaled: proposal.privateEvaluator.unscaled.map(({ id, evidence }) => ({ id, evidence })),
    },
    criterionMappings: proposal.criterionMappings.map((mapping) => {
      const authority = authorities.find(
        (item) =>
          item.authoredCriterionId === mapping.authoredCriterionId &&
          hashJson(mapping.authority) ===
            hashJson({ source: item.source, start: item.start, end: item.end }),
      );
      if (!authority) throw new Error("Canonical proposal has no selectable authored authority");
      return {
        authorityId: authority.id,
        authoredClauseIds: mapping.authoredClauseIds,
        method: mapping.method,
        executableCriterionId: mapping.executableCriterionId,
        rationale: mapping.rationale,
      };
    }),
  };
}
