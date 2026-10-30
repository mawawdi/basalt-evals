import type { EvalRevision } from "./compiler.js";

export interface ControlSpec {
  id: string;
  kind: "working" | "negative" | "alternative";
  targetCriterionId: string | null;
}

function environmentOnlyCriterion(revision: EvalRevision, id: string): boolean {
  const criterion = revision.privateEvaluator.deterministic.find((item) => item.id === id);
  if (!criterion) return false;
  const rule = criterion.rule;
  if (!("factId" in rule)) return false;
  const fact =
    "phaseId" in rule
      ? revision.privateEvaluator.studio.phases
          .find((phase) => phase.id === rule.phaseId)
          ?.facts.find((item) => item.id === rule.factId)
      : "scenarioId" in rule && "stepId" in rule
        ? revision.privateEvaluator.studio.scenarios
            .find((scenario) => scenario.id === rule.scenarioId)
            ?.steps.find((step) => step.id === rule.stepId)
            ?.observations.find((item) => item.fact.id === rule.factId)?.fact
        : null;
  return fact?.kind === "player_count";
}

/** Environment assertions are checked by positives, never by changing candidate source. */
export function requiredNegativeControlIds(revision: EvalRevision): string[] {
  return [
    ...revision.privateEvaluator.deterministic.filter(
      (item) => item.required && !environmentOnlyCriterion(revision, item.id),
    ),
    ...revision.privateEvaluator.codeQuality.filter((item) => item.required),
    ...revision.privateEvaluator.visual.filter((item) => item.required),
    ...revision.privateEvaluator.unscaled.filter((item) => item.required),
  ].map((item) => item.id);
}

/** The tool contract names the exact checks; free-form keys invite false contrasts. */
export function controlOutcomeSchema(revision: EvalRevision) {
  const ids = revision.privateEvaluator.deterministic
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id)
    .sort();
  return {
    type: "object" as const,
    properties: Object.fromEntries(
      ids.map((id) => [id, { type: "string", enum: ["verified", "rejected", "incomplete"] }]),
    ),
    required: ids,
    additionalProperties: false,
  };
}

export function controlSpecs(revision: EvalRevision): ControlSpec[] {
  const required = requiredNegativeControlIds(revision);
  if (required.length > 128 || new Set(required).size !== required.length)
    throw new Error("Control generation needs distinct bounded required criteria");
  return [
    { id: "working", kind: "working", targetCriterionId: null },
    { id: "alternative", kind: "alternative", targetCriterionId: null },
    ...required.map((criterionId, index) => ({
      id: `negative-${String(index + 1).padStart(3, "0")}`,
      kind: "negative" as const,
      targetCriterionId: criterionId,
    })),
  ];
}
