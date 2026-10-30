import {
  boundStudioObservation,
  identifiedRolePaths,
  studioIdentityIssue,
  deterministicObservationBindings,
  boundStudioAction,
  contentHash,
  hashJson,
  stableJson,
  MAX_CANDIDATE_BYTES,
  MAX_CANDIDATE_FILES,
  type CodeCriterion,
  type DeterministicCriterion,
  type StudioEvidence,
  type StudioCollectionPlan,
  type StudioObservationBinding,
  type StudioActionBinding,
  type UnscaledCriterion,
  type VisualCriterion,
} from "../../contracts/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { renderedSelection } from "./rendered-selection.js";

export type ExecutableCriterion =
  CodeCriterion | DeterministicCriterion | UnscaledCriterion | VisualCriterion;

const SOURCE_FILE_BYTES = 512 * 1024;
const OBSERVATION_BYTES = 512 * 1024;
const RUNTIME_BYTES = 32 * 1024 * 1024;

function sourceSelection(criterion: ExecutableCriterion) {
  return "sourceSelection" in criterion
    ? criterion.sourceSelection
    : "evidence" in criterion
      ? criterion.evidence.sourceSelection
      : "rule" in criterion &&
          (criterion.rule.kind === "path_exists" || criterion.rule.kind === "source_contains")
        ? { kind: "exact_files" as const, paths: [criterion.rule.path] }
        : null;
}

/** Bounds the material that this exact projection is allowed to serialize, before acquisition. */
export function criterionMaterialTextBound(
  criterion: ExecutableCriterion,
  plan: StudioCollectionPlan,
): number {
  const selection = sourceSelection(criterion);
  const fileCount = !selection
    ? 0
    : selection.kind === "exact_files"
      ? selection.paths.length
      : MAX_CANDIDATE_FILES;
  const sourceBytes = Math.min(MAX_CANDIDATE_BYTES, fileCount * SOURCE_FILE_BYTES);
  const facts = criterionObservationBindings(criterion, plan).length;
  const actions = "evidence" in criterion ? criterion.evidence.actions.length : 0;
  // Six bytes cover the worst JSON escape expansion of each source byte.
  return (
    4096 +
    sourceBytes * 6 +
    fileCount * 4096 +
    (facts + actions) * (OBSERVATION_BYTES + 4096) +
    ("rule" in criterion && criterion.layer === "engine" ? RUNTIME_BYTES : 0)
  );
}

export function criterionObservationBindings(
  criterion: ExecutableCriterion,
  plan: StudioCollectionPlan,
): StudioObservationBinding[] {
  const captures = renderedSelection(criterion).captureIds;
  const bindings: StudioObservationBinding[] = [
    ...("rule" in criterion ? deterministicObservationBindings(criterion.rule) : []),
    ...("evidence" in criterion ? criterion.evidence.facts : []),
    ...plan.phases
      .filter((phase) => phase.captures.some((capture) => captures.includes(capture.id)))
      .flatMap((phase) => phase.facts.map((fact) => ({ phaseId: phase.id, factId: fact.id }))),
  ];
  return [...new Map(bindings.map((binding) => [hashJson(binding), binding])).values()];
}

/**
 * Reasons that the selected evidence channels cannot support the evidence class. A criterion
 * with a reason gets an insufficient outcome without a model call.
 */
export function evidenceClassGaps(criterion: ExecutableCriterion): string[] {
  if (!("evidenceClass" in criterion)) return [];
  const selection = renderedSelection(criterion);
  const rendered = selection.captureIds.length > 0 || selection.sequence;
  const facts = "evidence" in criterion ? criterion.evidence.facts.length : 0;
  const evidenceClass = criterion.evidenceClass;
  if (evidenceClass === null)
    return rendered
      ? ["The rubric author set no evidence class, so no model can judge its rendered frames"]
      : [];
  if (evidenceClass === "appearance")
    return rendered ? [] : ["An appearance criterion has no rendered frames to judge"];
  if (rendered)
    return [
      `A ${evidenceClass} criterion needs a runtime-fact requirement; frames at two per second cannot establish it`,
    ];
  return facts > 0 ? [] : [`A ${evidenceClass} criterion has no signed runtime fact to judge`];
}

export interface CriterionMaterial {
  criterionId: string;
  signedObservations: Array<{
    binding: StudioObservationBinding;
    observation: ReturnType<typeof boundStudioObservation>;
    hash: string | null;
  }>;
  signedActions: Array<{
    binding: StudioActionBinding;
    receipt: ReturnType<typeof boundStudioAction>;
    hash: string | null;
  }>;
  sealedSources: Array<{ path: string; hash: string; text: string }>;
  absentSourcePaths: string[];
  signedRuntime: StudioEvidence | null;
  unavailable: string[];
}

/** Quotation has no acquired evidence yet; dispatch always resolves the sealed projection. */
export function pendingCriterionMaterial(criterionId: string): CriterionMaterial {
  return {
    criterionId,
    signedObservations: [],
    signedActions: [],
    sealedSources: [],
    absentSourcePaths: [],
    signedRuntime: null,
    unavailable: [],
  };
}

/** Grading data only. Never expose criterion mappings or these projections to a builder. */
export async function criterionMaterial(input: {
  files: RepositoryFiles;
  sourceRoot: string;
  sourceFiles: Array<{ path: string; hash: string }>;
  evidence: StudioEvidence;
  plan: StudioCollectionPlan;
  criterion: ExecutableCriterion;
}): Promise<CriterionMaterial> {
  const { criterion, evidence } = input;
  const bindings = criterionObservationBindings(criterion, input.plan);
  const signedObservations = bindings.map((binding) => {
    const observation = boundStudioObservation(evidence, binding);
    if (Buffer.byteLength(stableJson(observation), "utf8") > OBSERVATION_BYTES)
      throw new Error(
        "The recorded facts for a criterion are larger than the limit in the preview. Basalt kept the evidence. Edit the evaluation so that the criterion uses less recorded data.",
      );
    return { binding, observation, hash: observation ? hashJson(observation) : null };
  });
  const actionBindings = "evidence" in criterion ? criterion.evidence.actions : [];
  const signedActions = actionBindings.map((binding) => {
    const receipt = boundStudioAction(evidence, binding, input.plan);
    if (Buffer.byteLength(stableJson(receipt), "utf8") > OBSERVATION_BYTES)
      throw new Error(
        "The recorded action result for a criterion is larger than the limit in the preview. Basalt kept the evidence.",
      );
    return { binding, receipt, hash: receipt ? hashJson(receipt) : null };
  });
  const identified = identifiedRolePaths(input.plan, evidence);
  // The evidence class gate comes first. Its reasons stop a model call for this criterion.
  const unavailable = evidenceClassGaps(criterion).concat(
    signedObservations
      .filter((item) => !item.observation)
      .map((item) => `Required observation was not acquired: ${JSON.stringify(item.binding)}`),
    signedObservations.flatMap((item) => {
      const issue = studioIdentityIssue(input.plan, item.binding, item.observation, identified);
      return issue ? [issue] : [];
    }),
    signedActions
      .filter((item) => !item.receipt)
      .map((item) => `Required action receipt was not acquired: ${JSON.stringify(item.binding)}`),
  );
  const selection = sourceSelection(criterion);
  const sealedSources: CriterionMaterial["sealedSources"] = [];
  const absentSourcePaths: string[] = [];
  if (selection) {
    const selected = input.sourceFiles.filter((file) =>
      selection.kind === "exact_files"
        ? selection.paths.includes(file.path)
        : /\.luau?$/u.test(file.path) &&
          selection.roots.some((root) => file.path.startsWith(`${root}/`)),
    );
    const missing =
      selection.kind === "exact_files"
        ? selection.paths.filter((path) => !selected.some((file) => file.path === path))
        : [];
    // A complete sealed inventory can establish file absence for a fixed path rule.
    // It cannot supply source text requested by a code-quality criterion.
    if ("rule" in criterion) absentSourcePaths.push(...missing);
    else if (!selected.length || missing.length)
      unavailable.push("Required sealed source was not acquired");
    for (const file of selected) {
      const bytes = await input.files.bytes(`${input.sourceRoot}/${file.path}`, SOURCE_FILE_BYTES);
      if (contentHash(bytes) !== file.hash)
        throw new Error("Criterion source differs from the sealed candidate");
      sealedSources.push({ path: file.path, hash: file.hash, text: bytes.toString("utf8") });
    }
  }
  const signedRuntime = "rule" in criterion && criterion.layer === "engine" ? evidence : null;
  if (Buffer.byteLength(stableJson(signedRuntime), "utf8") > RUNTIME_BYTES)
    throw new Error(
      "The recorded Studio data for a criterion is larger than the limit in the preview. Basalt kept the evidence. Edit the evaluation so that the criterion uses less recorded data.",
    );
  const result = {
    criterionId: criterion.id,
    signedObservations,
    signedActions,
    sealedSources,
    absentSourcePaths,
    // Calibration may ask a model to judge wording also checked by a fixed rule.
    // Supply the actual runtime observations, never the rule's expected values or verdict.
    signedRuntime,
    unavailable,
  };
  if (
    Buffer.byteLength(stableJson(result), "utf8") >
    criterionMaterialTextBound(criterion, input.plan)
  )
    throw new Error(
      "The evidence for a criterion is larger than the limit in the preview. Basalt kept the evidence.",
    );
  return result;
}
