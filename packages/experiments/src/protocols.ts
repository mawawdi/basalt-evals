import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import {
  PIXEL_MEASURES,
  assertPixelRegion,
  type PixelMeasure,
  type PixelRegion,
} from "./pixel-metrics.js";

/** A comparison of builders needs two different builder models. A person selects them. */
function builderPair(ids: readonly string[]): string[] {
  if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some((id) => typeof id !== "string"))
    throw new Error("Select two different builder models for this study");
  return [...ids];
}
/** The bounds of a registered harness that a plan binds. The run checks them again. */
interface PlannedHarness {
  id: string;
  maxTurns: number;
  developmentRuns: number;
}
function plannedBuilder(harness: PlannedHarness) {
  if (
    typeof harness.id !== "string" ||
    !harness.id ||
    !Number.isSafeInteger(harness.maxTurns) ||
    harness.maxTurns < 1 ||
    !Number.isSafeInteger(harness.developmentRuns) ||
    harness.developmentRuns < 0
  )
    throw new Error("A plan needs a registered harness with bounded turns and development runs");
  return {
    harness: harness.id,
    bounds: { turns: harness.maxTurns, developmentRuns: harness.developmentRuns },
  };
}
export const PRESENTATIONS = ["still", "sequence", "grounded-sequence"] as const;
export type Presentation = (typeof PRESENTATIONS)[number];
export type Partition = "development" | "withheld";
export interface StudySource {
  id: string;
  evalId: string;
  kind: "generated" | "working" | "negative";
  sourceHash: string;
  targetCriterionIds: string[];
}
interface CaptureUnit {
  id: string;
  subjectId: string;
  evalId: string;
  viewId: string;
  partition: Partition;
  pass: number;
  requires: string[];
}
export interface JudgmentUnit {
  id: string;
  captureId: string;
  /**
   * Identical requests share one sample group. Each sample, from 1, is its own unit with its own
   * ledger entry. The registered plans have one sample of each request.
   */
  sampleGroupId: string;
  sample: number;
  presentation: Presentation;
  calls: 1 | 2;
  substitution: null | {
    kind: "blank" | "unrelated";
    originalCaptureId: string;
    donorCaptureId: string | null;
  };
}
interface ReviewGroup {
  id: string;
  subjectId: string;
  viewId: string;
  partition: Partition;
  captureIds: string[];
  requires: string[];
}
interface BuilderUnit {
  id: string;
  evalId: string;
  modelId: string;
  /** The ID of a registered harness. */
  harness: string;
  repetition: number;
  seed: number;
  parentSourceId: string | null;
  assistance: "public_observations" | "public_task_only" | null;
  bounds: { turns: number; developmentRuns: number };
}
/** An authored effect region of one view. A criterion region replaces the view region. */
interface AuthoredRegion {
  evalId: string;
  viewId: string;
  criterionId: string | null;
  rectangle: PixelRegion;
  surroundMargin: number;
}
/**
 * How the frames of one task view get their recorded time from the action. A sequence uses
 * the measured anchor of one transition and the frames of one actor. Phase stills use one
 * fact for each capture that records its time from the action, in milliseconds.
 */
export type MeasurementTiming =
  | { evalId: string; viewId: string; kind: "sequence"; transitionId: string; actor: string }
  | {
      evalId: string;
      viewId: string;
      kind: "stills";
      captures: Array<{ captureId: string; factId: string }>;
    };
/** One pixel rule baseline for one required criterion. */
export interface PixelRule {
  id: string;
  evalId: string;
  criterionId: string;
  measure: PixelMeasure;
  /** at_least: a value at or above the threshold satisfies. at_most: at or below. */
  direction: "at_least" | "at_most";
  /**
   * Only a person writes this value. It quotes the passage of the human-authored criterion
   * that states the threshold. Null when the criterion states no threshold. No model output
   * and no calibration result can fill it.
   */
  authoredThreshold: { value: number; passage: string } | null;
}
/** The preregistered baseline ladder of a judge calibration. */
export interface BaselinePlan {
  trivial: ["always_pass", "always_fail"];
  measurement: {
    /** The smallest luma difference, in 8-bit code values, that changes a pixel. */
    changeThreshold: number;
    /** The smallest count of changed pixels that starts the change. */
    onsetPixels: number;
    regions: AuthoredRegion[];
    /** Authored rectangles that no measure reads, for example harness controls. */
    excluded: Array<{ evalId: string; viewId: string; rectangle: PixelRegion }>;
    timing: MeasurementTiming[];
  };
  /** Human-chosen exemplar builds for the reference distance, or null. */
  reference: null | {
    exemplars: Array<{ evalId: string; sourceId: string }>;
    grid: { width: number; height: number };
    toleranceMs: number;
  };
  rules: PixelRule[];
  /** Judge controls on the same units. Other plan parts make their judgments. */
  judgeControls: Array<"text_only" | "facts_and_source">;
  /** The model family of a second judge on the same units, or null. */
  secondJudgeFamily: string | null;
  comparison: {
    calibration: "development";
    holdout: "withheld";
    test: "exact_mcnemar";
    adjustment: "holm";
    cluster: "build";
  };
}
/**
 * The preregistered exemplar comparison stream of a judge calibration. A person chose the
 * exemplars of each criterion before the plan. The stream is separate from the absolute
 * judge. It answers each comparison in both orders.
 */
export interface ExemplarComparisonPlan {
  criteria: Array<{
    evalId: string;
    /** A required appearance criterion of the task. */
    criterionId: string;
    /** The content identity of the authored exemplar choice. */
    choiceId: string;
    /** The source identities of the one or two exemplar builds, in the order of the choice. */
    exemplarSourceHashes: string[];
  }>;
  /** The largest miss rate of the one reported metric: the automatic share at this bound. */
  maxMissRate: number;
  orders: ["candidate_first", "exemplar_first"];
}
export interface ExperimentPlan {
  id: string;
  kind: "detector_calibration" | "repair_discovery" | "matched_repair" | "harness_effectiveness";
  sources: StudySource[];
  builders: BuilderUnit[];
  captures: CaptureUnit[];
  judgments: JudgmentUnit[];
  reviewGroups: ReviewGroup[];
  gates: Array<{ id: string; kind: "review" | "selection"; requires: string[] }>;
  /** Only a judge calibration has a baseline ladder. */
  baselines: BaselinePlan | null;
  /** Only a judge calibration can preregister the exemplar comparison stream. */
  exemplarComparison: ExemplarComparisonPlan | null;
  configuration: {
    orderSeed: number | null;
    presentationSelectionHash: string | null;
    repairSelectionAuthority: "model" | "expert" | null;
    /** Only a harness comparison names its two harnesses. */
    harnessArms: { baseline: string; treatment: string } | null;
  };
  analysis: {
    confidence: 0.95;
    /** Exact build cells, task × model blocks, or descriptive individual attempts. */
    method: "exact_build_cells" | "task_model_blocks" | "individual_attempts";
  };
}

function identity(prefix: string, value: unknown) {
  return prefix + "-" + hashJson(value).slice(0, 24);
}
function distinct(values: string[], label: string) {
  if (!values.length || new Set(values).size !== values.length)
    throw new Error(label + " must be nonempty and unique");
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(label + " must be unique");
}
function seal(body: Omit<ExperimentPlan, "id">): ExperimentPlan {
  distinct(
    [...body.sources.map((source) => source.id), ...body.builders.map((unit) => unit.id)],
    "Study subjects",
  );
  distinct(
    body.captures.map((unit) => unit.id),
    "Capture identities",
  );
  distinct(
    body.judgments.map((unit) => unit.id),
    "Judgment identities",
  );
  return { ...body, id: hashJson(body) };
}
function captures(
  subjectId: string,
  evalId: string,
  views: Array<{ id: string; partition: Partition }>,
  withheldGate: string | null,
): CaptureUnit[] {
  return views.flatMap((view) =>
    [1, 2, 3].map((pass) => {
      const body = {
        subjectId,
        evalId,
        viewId: view.id,
        partition: view.partition,
        pass,
        requires: view.partition === "withheld" && withheldGate ? [withheldGate] : [],
      };
      return { ...body, id: identity("capture", body) };
    }),
  );
}
function reviews(units: CaptureUnit[]): ReviewGroup[] {
  const groups = new Map<string, CaptureUnit[]>();
  for (const unit of units) {
    const key = hashJson([unit.subjectId, unit.viewId, unit.partition]);
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const body = {
      subjectId: first.subjectId,
      viewId: first.viewId,
      partition: first.partition,
      captureIds: group.map((unit) => unit.id),
      requires: first.requires,
    };
    return { ...body, id: identity("review", body) };
  });
}
function judgment(
  captureId: string,
  presentation: Presentation,
  substitution: JudgmentUnit["substitution"] = null,
): JudgmentUnit {
  const body = {
    captureId,
    presentation,
    calls: presentation === "grounded-sequence" ? (2 as const) : (1 as const),
    substitution,
  };
  const sample = 1;
  return {
    ...body,
    sampleGroupId: identity("samples", body),
    sample,
    id: identity("judgment", { ...body, sample }),
  };
}
const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
/**
 * Validate the preregistered baseline ladder. The trivial baselines and the comparison
 * method are fixed. A rule that cannot have a value is refused before any work starts.
 */
function baselineLadder(
  input: Omit<BaselinePlan, "trivial" | "comparison">,
  sources: StudySource[],
  views: Array<{ id: string; partition: Partition }>,
): BaselinePlan {
  const evalIds = new Set(sources.map((source) => source.evalId));
  const viewIds = new Set(views.map((view) => view.id));
  const known = (evalId: string, viewId: string) => evalIds.has(evalId) && viewIds.has(viewId);
  const { measurement, reference, rules } = input;
  if (
    !Number.isSafeInteger(measurement.changeThreshold) ||
    measurement.changeThreshold < 1 ||
    measurement.changeThreshold > 255 ||
    !Number.isSafeInteger(measurement.onsetPixels) ||
    measurement.onsetPixels < 1
  )
    throw new Error("A change threshold is 1 to 255 and an onset count is a positive whole number");
  for (const region of measurement.regions) {
    if (
      !known(region.evalId, region.viewId) ||
      (region.criterionId !== null &&
        (typeof region.criterionId !== "string" || !region.criterionId))
    )
      throw new Error("An authored region names a planned task, view and criterion");
    assertPixelRegion(region.rectangle);
    if (
      !Number.isSafeInteger(region.surroundMargin) ||
      region.surroundMargin < 1 ||
      region.surroundMargin > 4096
    )
      throw new Error("A surround margin must be a whole number of pixels from 1 to 4096");
  }
  unique(
    measurement.regions.map((region) =>
      JSON.stringify([region.evalId, region.viewId, region.criterionId]),
    ),
    "Authored regions",
  );
  for (const item of measurement.excluded) {
    if (!known(item.evalId, item.viewId))
      throw new Error("An excluded rectangle names a planned task and view");
    assertPixelRegion(item.rectangle);
  }
  const name = (value: unknown) => typeof value === "string" && RULE_ID.test(value);
  for (const timing of measurement.timing)
    if (
      !known(timing.evalId, timing.viewId) ||
      (timing.kind === "sequence"
        ? !name(timing.transitionId) || typeof timing.actor !== "string" || !timing.actor
        : timing.kind !== "stills" ||
          !timing.captures.length ||
          new Set(timing.captures.map((item) => item.captureId)).size !== timing.captures.length ||
          timing.captures.some((item) => !name(item.captureId) || !name(item.factId)))
    )
      throw new Error("A timing entry names a planned view and its anchor or time facts");
  unique(
    measurement.timing.map((timing) => JSON.stringify([timing.evalId, timing.viewId])),
    "Timing entries",
  );
  if (reference) {
    if (
      !Number.isSafeInteger(reference.grid.width) ||
      !Number.isSafeInteger(reference.grid.height) ||
      reference.grid.width < 1 ||
      reference.grid.height < 1 ||
      reference.grid.width > 256 ||
      reference.grid.height > 256 ||
      !Number.isSafeInteger(reference.toleranceMs) ||
      reference.toleranceMs < 0 ||
      reference.toleranceMs > 60_000
    )
      throw new Error("A reference grid is 1 to 256 cells and a tolerance is 0 to 60000 ms");
    distinct(
      reference.exemplars.map((item) => item.evalId),
      "Exemplar tasks",
    );
    if (
      reference.exemplars.some(
        (item) =>
          !sources.some((source) => source.id === item.sourceId && source.evalId === item.evalId),
      )
    )
      throw new Error("An exemplar must be a planned source of its task");
  }
  unique(
    rules.map((rule) => rule.id),
    "Pixel rule identities",
  );
  for (const rule of rules) {
    if (
      !RULE_ID.test(rule.id) ||
      !evalIds.has(rule.evalId) ||
      typeof rule.criterionId !== "string" ||
      !rule.criterionId ||
      !PIXEL_MEASURES.includes(rule.measure) ||
      !["at_least", "at_most"].includes(rule.direction)
    )
      throw new Error("A pixel rule needs an identity, a planned task, a criterion and a measure");
    if (
      rule.authoredThreshold !== null &&
      (!Number.isFinite(rule.authoredThreshold.value) ||
        typeof rule.authoredThreshold.passage !== "string" ||
        !rule.authoredThreshold.passage.trim() ||
        rule.authoredThreshold.passage.length > 2000)
    )
      throw new Error("An authored threshold needs a finite value and its criterion passage");
    if (
      views.some(
        (view) =>
          !measurement.timing.some(
            (timing) => timing.evalId === rule.evalId && timing.viewId === view.id,
          ),
      )
    )
      throw new Error("A pixel rule needs a timing entry in each view of its task");
    if (
      rule.measure === "weber_contrast" &&
      views.some(
        (view) =>
          !measurement.regions.some(
            (region) =>
              region.evalId === rule.evalId &&
              region.viewId === view.id &&
              (region.criterionId === null || region.criterionId === rule.criterionId),
          ),
      )
    )
      throw new Error("A Weber contrast rule needs an authored region in each view");
    if (
      rule.measure === "reference_distance" &&
      !reference?.exemplars.some((item) => item.evalId === rule.evalId)
    )
      throw new Error("A reference distance rule needs an exemplar of its task");
  }
  if (
    new Set(input.judgeControls).size !== input.judgeControls.length ||
    input.judgeControls.some((kind) => !["text_only", "facts_and_source"].includes(kind)) ||
    (input.secondJudgeFamily !== null &&
      (typeof input.secondJudgeFamily !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.secondJudgeFamily)))
  )
    throw new Error("Judge controls are unique known kinds and a judge family is a vendor prefix");
  return {
    trivial: ["always_pass", "always_fail"],
    measurement,
    reference,
    rules,
    judgeControls: input.judgeControls,
    secondJudgeFamily: input.secondJudgeFamily,
    comparison: {
      calibration: "development",
      holdout: "withheld",
      test: "exact_mcnemar",
      adjustment: "holm",
      cluster: "build",
    },
  };
}

/**
 * Validate the preregistered exemplar comparison stream. An exemplar is never a planned
 * build, because a build must not be compared with itself.
 */
function exemplarComparisonPlan(
  input: Omit<ExemplarComparisonPlan, "orders">,
  sources: StudySource[],
): ExemplarComparisonPlan {
  const hash = /^[a-f0-9]{64}$/u;
  const planned = new Set(sources.map((source) => source.sourceHash));
  if (
    !Array.isArray(input.criteria) ||
    !input.criteria.length ||
    !Number.isFinite(input.maxMissRate) ||
    input.maxMissRate <= 0 ||
    input.maxMissRate >= 1
  )
    throw new Error("An exemplar comparison needs criteria and a miss rate between 0 and 1");
  for (const item of input.criteria)
    if (
      !sources.some((source) => source.evalId === item.evalId) ||
      typeof item.criterionId !== "string" ||
      !item.criterionId ||
      !hash.test(item.choiceId) ||
      !Array.isArray(item.exemplarSourceHashes) ||
      item.exemplarSourceHashes.length < 1 ||
      item.exemplarSourceHashes.length > 2 ||
      new Set(item.exemplarSourceHashes).size !== item.exemplarSourceHashes.length ||
      item.exemplarSourceHashes.some((value) => !hash.test(value) || planned.has(value))
    )
      throw new Error(
        "An exemplar comparison names a planned task, a criterion, an authored choice and one or two exemplars that are not planned builds",
      );
  unique(
    input.criteria.map((item) => JSON.stringify([item.evalId, item.criterionId])),
    "Exemplar comparison criteria",
  );
  return {
    criteria: input.criteria,
    maxMissRate: input.maxMissRate,
    orders: ["candidate_first", "exemplar_first"],
  };
}

export function planDetectorCalibration(input: {
  sources: StudySource[];
  views: Array<{ id: string; partition: Partition }>;
  baselines: Omit<BaselinePlan, "trivial" | "comparison">;
  exemplarComparison: Omit<ExemplarComparisonPlan, "orders"> | null;
}): ExperimentPlan {
  const evalIds = [...new Set(input.sources.map((source) => source.evalId))];
  if (
    evalIds.length !== 2 ||
    input.sources.length !== 12 ||
    input.views.filter((view) => view.partition === "development").length !== 2 ||
    input.views.filter((view) => view.partition === "withheld").length !== 2
  )
    throw new Error(
      "Detector calibration requires two tasks, twelve sources, and two views per partition",
    );
  distinct(
    input.views.map((view) => view.id),
    "Study views",
  );
  for (const evalId of evalIds) {
    const population = input.sources.filter((source) => source.evalId === evalId);
    if (
      population.filter((source) => source.kind === "generated").length !== 3 ||
      population.filter((source) => source.kind === "working").length !== 1 ||
      population.filter((source) => source.kind === "negative").length !== 2
    )
      throw new Error(
        "Each task needs three generated sources, one working reference, and two negatives",
      );
  }
  if (
    input.sources.some((source) =>
      source.kind === "negative"
        ? !source.targetCriterionIds.length ||
          new Set(source.targetCriterionIds).size !== source.targetCriterionIds.length
        : source.targetCriterionIds.length !== 0,
    )
  )
    throw new Error("Controls require frozen targeted criterion identities");
  const baselines = baselineLadder(input.baselines, input.sources, input.views);
  const exemplarComparison = input.exemplarComparison
    ? exemplarComparisonPlan(input.exemplarComparison, input.sources)
    : null;
  const units = input.sources.flatMap((source) =>
    captures(source.id, source.evalId, input.views, "presentation-selection"),
  );
  const judgments = units.flatMap((unit) =>
    PRESENTATIONS.map((presentation) => judgment(unit.id, presentation)),
  );
  for (const source of input.sources.filter((source) => source.kind === "working")) {
    for (const unit of units.filter(
      (unit) => unit.subjectId === source.id && unit.partition === "development",
    )) {
      const donor = units.find(
        (other) =>
          other.evalId !== unit.evalId &&
          other.viewId === unit.viewId &&
          other.pass === unit.pass &&
          input.sources.some(
            (source) => source.id === other.subjectId && source.kind === "working",
          ),
      )!;
      for (const presentation of PRESENTATIONS) {
        judgments.push(
          judgment(unit.id, presentation, {
            kind: "blank",
            originalCaptureId: unit.id,
            donorCaptureId: null,
          }),
        );
        judgments.push(
          judgment(unit.id, presentation, {
            kind: "unrelated",
            originalCaptureId: unit.id,
            donorCaptureId: donor.id,
          }),
        );
      }
    }
  }
  return seal({
    kind: "detector_calibration",
    sources: input.sources,
    builders: [],
    captures: units,
    judgments,
    reviewGroups: reviews(units),
    gates: [
      { id: "development-review", kind: "review", requires: [] },
      { id: "presentation-selection", kind: "selection", requires: ["development-review"] },
    ],
    baselines,
    exemplarComparison,
    configuration: {
      orderSeed: null,
      presentationSelectionHash: null,
      repairSelectionAuthority: null,
      harnessArms: null,
    },
    analysis: { confidence: 0.95, method: "exact_build_cells" },
  });
}

/** Stable PRNG used only for declared order and statistical resampling, never model determinism. */
export function seededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("The seed is not valid. Use a whole number from 0 to 4,294,967,295.");
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
export function planHarnessComparison(input: {
  evalIds: string[];
  builderModelIds: string[];
  /** The baseline harness and the treatment harness. */
  harnesses: { baseline: PlannedHarness; treatment: PlannedHarness };
  orderSeed: number;
  presentation: Presentation;
  presentationSelectionHash: string;
}): ExperimentPlan {
  distinct(input.evalIds, "Harness task identities");
  if (input.evalIds.length !== 4 || !/^[a-f0-9]{64}$/u.test(input.presentationSelectionHash))
    throw new Error("Harness comparison needs four tasks and a sealed presentation decision");
  const arms = [input.harnesses.baseline, input.harnesses.treatment];
  distinct(
    arms.map((harness) => harness.id),
    "Compared harness identities",
  );
  const models = builderPair(input.builderModelIds);
  const random = seededRandom(input.orderSeed);
  const builders = [1, 2, 3].flatMap((repetition) =>
    shuffle(
      input.evalIds.flatMap((evalId) =>
        models.flatMap((modelId) =>
          arms.map((harness) => {
            const body = {
              evalId,
              modelId,
              ...plannedBuilder(harness),
              repetition,
              seed: Number.parseInt(
                hashJson([input.orderSeed, evalId, modelId, repetition]).slice(0, 8),
                16,
              ),
              parentSourceId: null,
              assistance: null,
            };
            return { ...body, id: identity("builder", body) };
          }),
        ),
      ),
      random,
    ),
  );
  const units = builders.flatMap((builder) =>
    captures(builder.id, builder.evalId, [{ id: "final", partition: "withheld" }], null),
  );
  return seal({
    kind: "harness_effectiveness",
    sources: [],
    builders,
    captures: units,
    judgments: units.map((unit) => judgment(unit.id, input.presentation)),
    reviewGroups: reviews(units),
    gates: [],
    baselines: null,
    exemplarComparison: null,
    configuration: {
      orderSeed: input.orderSeed,
      presentationSelectionHash: input.presentationSelectionHash,
      repairSelectionAuthority: null,
      harnessArms: {
        baseline: input.harnesses.baseline.id,
        treatment: input.harnesses.treatment.id,
      },
    },
    analysis: { confidence: 0.95, method: "task_model_blocks" },
  });
}

export function planMatchedRepair(input: {
  parents: StudySource[];
  builderModelId: string;
  harness: PlannedHarness;
  views: Array<{ id: string; partition: Partition }>;
  presentation: Presentation;
  seed: number;
  presentationSelectionHash: string;
  selectionAuthority: "model" | "expert";
}): ExperimentPlan {
  if (
    !/^[a-f0-9]{64}$/u.test(input.presentationSelectionHash) ||
    !["model", "expert"].includes(input.selectionAuthority) ||
    input.parents.length < 1 ||
    input.parents.length > 2 ||
    input.parents.some((parent) => parent.kind !== "generated") ||
    new Set(input.parents.map((parent) => parent.evalId)).size !== input.parents.length ||
    input.views.filter((view) => view.partition === "development").length !== 2 ||
    input.views.filter((view) => view.partition === "withheld").length !== 2
  )
    throw new Error("Repair needs one generated parent per task and two views per partition");
  const builders = input.parents.flatMap((parent) =>
    [1, 2, 3].flatMap((repetition) => {
      const arms =
        repetition % 2
          ? (["public_observations", "public_task_only"] as const)
          : (["public_task_only", "public_observations"] as const);
      return arms.map((assistance) => {
        const body = {
          evalId: parent.evalId,
          modelId: input.builderModelId,
          ...plannedBuilder(input.harness),
          repetition,
          seed: Number.parseInt(hashJson([input.seed, parent.id, repetition]).slice(0, 8), 16),
          parentSourceId: parent.id,
          assistance,
        };
        return { ...body, id: identity("repair", body) };
      });
    }),
  );
  const units = [
    ...builders.flatMap((builder) =>
      captures(builder.id, builder.evalId, input.views, "repair-selection"),
    ),
    ...input.parents.flatMap((parent) =>
      captures(
        parent.id,
        parent.evalId,
        input.views.filter((view) => view.partition === "withheld"),
        "repair-selection",
      ),
    ),
  ];
  return seal({
    kind: "matched_repair",
    sources: input.parents,
    builders,
    captures: units,
    judgments: units.map((unit) => judgment(unit.id, input.presentation)),
    reviewGroups: reviews(units),
    gates:
      input.selectionAuthority === "model"
        ? [{ id: "repair-selection", kind: "selection", requires: [] }]
        : [
            { id: "repair-development-review", kind: "review", requires: [] },
            { id: "repair-selection", kind: "selection", requires: ["repair-development-review"] },
          ],
    baselines: null,
    exemplarComparison: null,
    configuration: {
      orderSeed: input.seed,
      presentationSelectionHash: input.presentationSelectionHash,
      repairSelectionAuthority: input.selectionAuthority,
      harnessArms: null,
    },
    analysis: { confidence: 0.95, method: "individual_attempts" },
  });
}

/** One predeclared two-builder block per affected task. No withheld work or repeated search. */
export function planRepairDiscovery(input: {
  evalIds: string[];
  builderModelIds: string[];
  harness: PlannedHarness;
  views: Array<{ id: string; partition: Partition }>;
  presentation: Presentation;
  presentationSelectionHash: string;
  seed: number;
}): ExperimentPlan {
  distinct(input.evalIds, "Discovery task identities");
  if (
    input.evalIds.length > 2 ||
    !/^[a-f0-9]{64}$/u.test(input.presentationSelectionHash) ||
    input.views.length !== 2 ||
    input.views.some((view) => view.partition !== "development")
  )
    throw new Error(
      "Discovery needs affected tasks, two development views, and a sealed presentation choice",
    );
  distinct(
    input.views.map((view) => view.id),
    "Discovery views",
  );
  seededRandom(input.seed);
  const models = builderPair(input.builderModelIds);
  const builders = input.evalIds.flatMap((evalId) =>
    models.map((modelId) => {
      const body = {
        evalId,
        modelId,
        ...plannedBuilder(input.harness),
        repetition: 1,
        seed: Number.parseInt(hashJson([input.seed, evalId, modelId]).slice(0, 8), 16),
        parentSourceId: null,
        assistance: null,
      };
      return { ...body, id: identity("discovery", body) };
    }),
  );
  const units = builders.flatMap((builder) =>
    captures(builder.id, builder.evalId, input.views, null),
  );
  return seal({
    kind: "repair_discovery",
    sources: [],
    builders,
    captures: units,
    judgments: units.map((unit) => judgment(unit.id, input.presentation)),
    reviewGroups: reviews(units),
    gates: [
      { id: "discovery-review", kind: "review", requires: [] },
      { id: "parent-selection", kind: "selection", requires: ["discovery-review"] },
    ],
    baselines: null,
    exemplarComparison: null,
    configuration: {
      orderSeed: input.seed,
      presentationSelectionHash: input.presentationSelectionHash,
      repairSelectionAuthority: "expert",
      harnessArms: null,
    },
    analysis: { confidence: 0.95, method: "individual_attempts" },
  });
}

interface TreatmentCalibration {
  id: Presentation;
  controlDecisions: Array<{ correct: boolean; complete: boolean }>;
  missingEvidenceDecisions: Array<{ abstained: boolean; complete: boolean }>;
  developmentCorrect: number;
  knownCostUsd: number | null;
}
export function selectPresentation(treatments: TreatmentCalibration[]) {
  distinct(
    treatments.map((item) => item.id),
    "Presentation candidates",
  );
  const eligible = treatments.filter(
    (item) =>
      item.controlDecisions.length &&
      item.missingEvidenceDecisions.length &&
      item.controlDecisions.every((decision) => decision.complete && decision.correct) &&
      item.missingEvidenceDecisions.every((decision) => decision.complete && decision.abstained),
  );
  eligible.sort(
    (a, b) =>
      b.developmentCorrect - a.developmentCorrect ||
      (a.knownCostUsd ?? Infinity) - (b.knownCostUsd ?? Infinity) ||
      compareCodeUnits(a.id, b.id),
  );
  return eligible.length
    ? { id: eligible[0]!.id, calibration: "eligible" as const }
    : { id: "sequence" as const, calibration: "provisional" as const };
}
export function selectRepairAttempt(
  attempts: Array<{
    id: string;
    runnable: boolean;
    requiredViolations: number;
    insufficientJudgments: number;
    knownCostUsd: number | null;
  }>,
) {
  return (
    attempts
      .filter((attempt) => attempt.runnable)
      .sort(
        (a, b) =>
          a.requiredViolations - b.requiredViolations ||
          a.insufficientJudgments - b.insufficientJudgments ||
          (a.knownCostUsd ?? Infinity) - (b.knownCostUsd ?? Infinity) ||
          compareCodeUnits(a.id, b.id),
      )[0]?.id ?? null
  );
}

/** Calls of the exemplar comparison stream: each capture, criterion, exemplar and order. */
function exemplarComparisonCalls(plan: ExperimentPlan) {
  const stream = plan.exemplarComparison;
  if (!stream) return 0;
  return stream.criteria.reduce(
    (sum, item) =>
      sum +
      plan.captures.filter((capture) => capture.evalId === item.evalId).length *
        item.exemplarSourceHashes.length *
        stream.orders.length,
    0,
  );
}

export function plannedCounts(plan: ExperimentPlan) {
  return {
    builderTrials: plan.builders.length,
    captureCells: plan.captures.length,
    judgmentBatches: plan.judgments.length,
    graderCalls: plan.judgments.reduce((sum, unit) => sum + unit.calls, 0),
    exemplarComparisonCalls: exemplarComparisonCalls(plan),
    expertItems: plan.reviewGroups.length,
    publicDevelopmentRuns: plan.builders.reduce(
      (sum, unit) => sum + unit.bounds.developmentRuns,
      0,
    ),
  };
}
