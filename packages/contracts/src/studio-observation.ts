import type {
  DeterministicCriterion,
  StudioCollectionPlan,
  StudioObservation,
  StudioObservationBinding,
} from "./index.js";

/**
 * A tag query establishes role identity, not absence of every visible object. If the query
 * found the tagged target at another time of the same capture, a later absence is evidence,
 * for example a coin that a pickup removes. Only a role that the capture never found is
 * unknown.
 */
export function studioIdentityIssue(
  plan: StudioCollectionPlan,
  binding: StudioObservationBinding,
  observation: StudioObservation | null,
  identifiedRoles: ReadonlySet<string>,
): string | null {
  if (!observation) return null;
  if (observation.kind === "binding_failure")
    return (
      "Public observation binding " +
      observation.path +
      " could not be resolved (" +
      observation.reason +
      "). The requested object's presence or appearance is unknown."
    );
  const fact =
    "phaseId" in binding
      ? plan.phases
          .find((phase) => phase.id === binding.phaseId)
          ?.facts.find((fact) => fact.id === binding.factId)
      : plan.scenarios
          .find((scenario) => scenario.id === binding.scenarioId)
          ?.steps.find((step) => step.id === binding.stepId)
          ?.observations.find(
            (item) => item.context === binding.context && item.fact.id === binding.factId,
          )?.fact;
  if (
    fact &&
    "path" in fact &&
    fact.path.startsWith("role.") &&
    "exists" in observation &&
    !observation.exists &&
    !identifiedRoles.has(fact.path)
  )
    return (
      "Public role " +
      fact.path.slice(5) +
      " has no identified tagged target. The requested object's presence or appearance is unknown."
    );
  return null;
}

export function deterministicObservationBindings(
  rule: DeterministicCriterion["rule"],
): StudioObservationBinding[] {
  if (rule.kind === "build_errors_absent") return rule.facts;
  if (rule.kind === "gui_layout_holds") return [rule.fact];
  if (rule.kind === "capture_text_contrast")
    return [{ phaseId: rule.phaseId, factId: rule.layoutFactId }];
  if (rule.kind === "capture_exposure") return [];
  if ("phaseId" in rule && "factId" in rule)
    return [{ phaseId: rule.phaseId, factId: rule.factId }];
  if (!("scenarioId" in rule)) return [];
  if (rule.kind === "scenario_number_delta_in_range")
    return [
      {
        scenarioId: rule.scenarioId,
        context: rule.context,
        stepId: rule.fromStepId,
        factId: rule.fromFactId,
      },
      {
        scenarioId: rule.scenarioId,
        context: rule.context,
        stepId: rule.toStepId,
        factId: rule.toFactId,
      },
    ];
  if (rule.kind === "scenario_cross_context_equals")
    return rule.contexts.map((context) => ({
      scenarioId: rule.scenarioId,
      context,
      stepId: rule.stepId,
      factId: rule.factId,
    }));
  if ("context" in rule && "stepId" in rule && "factId" in rule)
    return [
      {
        scenarioId: rule.scenarioId,
        context: rule.context,
        stepId: rule.stepId,
        factId: rule.factId,
      },
    ];
  return [];
}
