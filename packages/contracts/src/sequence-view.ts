import type { StudioCollectionPlan } from "./index.js";
import { isRecord } from "./validation.js";

/**
 * The id names the capture anchor and the source identifies the measured event. A state
 * source is the observed effect. The effect plays for effectWindowMs after the anchor.
 * The result then holds for holdMs. Frame selection and sufficiency use these windows.
 */
export interface SequenceTransitionBinding {
  id: string;
  source:
    | { kind: "action"; stepId: string }
    | {
        kind: "state";
        context: string;
        path: string;
        attribute: string;
        from: string | number | boolean | null;
        to: string | number | boolean | null;
      };
  effectWindowMs: number;
  holdMs: number;
}

/**
 * One rendered scenario view, independent of source identity and execution.
 * maximumGapMs is the largest unrecorded interval between consecutive frames that a
 * transition window can contain. It is the only frame-gap limit. frameBudget is the largest
 * number of sequence frames in one judgment. Transition frames must fit in it.
 */
export interface StudioSequenceView {
  scenarioId: string;
  requiredTransitions: SequenceTransitionBinding[];
  camera: null | { position: [number, number, number]; lookAt: [number, number, number] };
  viewport: null | { width: number; height: number };
  maximumGapMs: number;
  frameBudget: number;
}

export const SEQUENCE_VIEW_FIELDS = [
  "camera",
  "frameBudget",
  "maximumGapMs",
  "requiredTransitions",
  "scenarioId",
  "viewport",
] as const;
/** One model request holds at most this number of images, phase captures included. */
export const MAXIMUM_PRESENTED_FRAMES = 64;
const MAX_TRANSITION_WINDOW_MS = 60_000;
const MIN_SEQUENCE_GAP_MS = 100;
const MAX_SEQUENCE_GAP_MS = 10_000;

/** Copy exactly the view fields from a larger record, for example a development view. */
export function studioSequenceView(value: StudioSequenceView): StudioSequenceView {
  return {
    scenarioId: value.scenarioId,
    requiredTransitions: value.requiredTransitions,
    camera: value.camera,
    viewport: value.viewport,
    maximumGapMs: value.maximumGapMs,
    frameBudget: value.frameBudget,
  };
}

const id = /^[a-z][a-z0-9-]{0,63}$/u;
function vector(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100_000)
  );
}
function duration(value: unknown) {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_TRANSITION_WINDOW_MS
  );
}
function scalar(value: unknown) {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 256)
  );
}

export function isSequenceTransitionBinding(value: unknown): value is SequenceTransitionBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "effectWindowMs,holdMs,id,source" ||
    typeof value.id !== "string" ||
    !id.test(value.id) ||
    !duration(value.effectWindowMs) ||
    !duration(value.holdMs) ||
    !isRecord(value.source)
  )
    return false;
  const source = value.source;
  if (source.kind === "action")
    return (
      Object.keys(source).sort().join(",") === "kind,stepId" &&
      typeof source.stepId === "string" &&
      id.test(source.stepId)
    );
  return (
    source.kind === "state" &&
    Object.keys(source).sort().join(",") === "attribute,context,from,kind,path,to" &&
    typeof source.context === "string" &&
    id.test(source.context) &&
    typeof source.path === "string" &&
    (/^game(?:\.[A-Za-z_][A-Za-z0-9_]*){1,16}$/u.test(source.path) ||
      /^role\.[a-z][a-z0-9_-]{0,63}$/u.test(source.path)) &&
    typeof source.attribute === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(source.attribute) &&
    scalar(source.from) &&
    scalar(source.to) &&
    !Object.is(source.from, source.to)
  );
}

/** The same view contract is used by public tools, private grading and study plans. */
export function assertStudioSequenceView(
  value: unknown,
  plan?: StudioCollectionPlan,
): asserts value is StudioSequenceView {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== SEQUENCE_VIEW_FIELDS.join(",") ||
    typeof value.scenarioId !== "string" ||
    !Number.isSafeInteger(value.maximumGapMs) ||
    (value.maximumGapMs as number) < MIN_SEQUENCE_GAP_MS ||
    (value.maximumGapMs as number) > MAX_SEQUENCE_GAP_MS ||
    !Number.isSafeInteger(value.frameBudget) ||
    (value.frameBudget as number) < 1 ||
    (value.frameBudget as number) > MAXIMUM_PRESENTED_FRAMES ||
    !id.test(value.scenarioId) ||
    !Array.isArray(value.requiredTransitions) ||
    value.requiredTransitions.length > 16 ||
    value.requiredTransitions.some((binding) => !isSequenceTransitionBinding(binding)) ||
    new Set(value.requiredTransitions.map((binding) => (binding as SequenceTransitionBinding).id))
      .size !== value.requiredTransitions.length ||
    (value.camera !== null &&
      (!isRecord(value.camera) ||
        Object.keys(value.camera).sort().join(",") !== "lookAt,position" ||
        !vector(value.camera.position) ||
        !vector(value.camera.lookAt))) ||
    (value.viewport !== null &&
      (!isRecord(value.viewport) ||
        Object.keys(value.viewport).sort().join(",") !== "height,width" ||
        !Number.isSafeInteger(value.viewport.width) ||
        !Number.isSafeInteger(value.viewport.height) ||
        (value.viewport.width as number) < 320 ||
        (value.viewport.width as number) > 4096 ||
        (value.viewport.height as number) < 240 ||
        (value.viewport.height as number) > 4096))
  ) {
    throw new Error("Invalid Studio sequence view");
  }
  if (!plan) return;
  const errors = sequenceViewReferenceErrors(value, plan);
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Report independent reference defects even when another proposal section is malformed. */
export function sequenceViewReferenceErrors(
  value: unknown,
  plan: unknown,
  path = "/sequence",
): string[] {
  if (!isRecord(value) || !isRecord(plan) || !Array.isArray(plan.scenarios)) return [];
  if (typeof value.scenarioId !== "string") return [];
  const scenarios = plan.scenarios.filter(isRecord);
  const scenario = scenarios.find((entry) => entry.id === value.scenarioId);
  if (!scenario)
    return [
      `${path}/scenarioId: unknown scenario ${JSON.stringify(value.scenarioId)}; declared scenarios: ${scenarios.map((entry) => entry.id).join(", ") || "none"}`,
    ];
  if (!Array.isArray(scenario.steps) || !Array.isArray(value.requiredTransitions)) return [];
  const steps = scenario.steps.filter(isRecord);
  const errors: string[] = [];
  for (const [index, transition] of value.requiredTransitions.entries()) {
    if (!isSequenceTransitionBinding(transition)) continue; // Shape validation owns this defect.
    if (
      typeof scenario.durationMs === "number" &&
      transition.effectWindowMs + transition.holdMs > scenario.durationMs
    )
      errors.push(
        `${path}/requiredTransitions/${index}: effectWindowMs plus holdMs must fit in the ${String(scenario.durationMs)} ms duration of scenario ${JSON.stringify(value.scenarioId)}`,
      );
    const reference = `${path}/requiredTransitions/${index}/source`;
    const source = transition.source;
    if (source.kind === "action") {
      const step = steps.find((entry) => entry.id === source.stepId);
      // The transition time is the actedAt of the actor's signed report.
      const actor = step && isRecord(step.action) ? step.action.actor : undefined;
      if (
        step &&
        typeof actor === "string" &&
        (!Array.isArray(scenario.reportContexts) || !scenario.reportContexts.includes(actor))
      )
        errors.push(
          `${reference}/stepId: action transition ${JSON.stringify(transition.id)} needs its actor ${JSON.stringify(actor)} in reportContexts, because the signed report records actedAt`,
        );
      if (!step || (isRecord(step.action) && step.action.kind === "wait"))
        errors.push(
          `${reference}/stepId: ${JSON.stringify(source.stepId)} must reference a non-wait action in scenario ${JSON.stringify(value.scenarioId)}; declared actions: ${
            steps
              .filter((entry) => isRecord(entry.action) && entry.action.kind !== "wait")
              .map((entry) => entry.id)
              .join(", ") || "none"
          }`,
        );
    } else if (
      !Array.isArray(scenario.reportContexts) ||
      !scenario.reportContexts.includes(source.context) ||
      !steps.some(
        (step) =>
          Array.isArray(step.observations) &&
          step.observations.some(
            (observation) =>
              isRecord(observation) &&
              isRecord(observation.fact) &&
              observation.context === source.context &&
              observation.fact.kind === "replication_probe" &&
              observation.fact.path === source.path &&
              observation.fact.attribute === source.attribute,
          ),
      )
    )
      errors.push(
        `${reference}: state transition ${JSON.stringify(transition.id)} requires a declared replication_probe for ${source.context}:${source.path}.${source.attribute} in scenario ${JSON.stringify(value.scenarioId)}`,
      );
  }
  return errors;
}
