import { OperationJournal } from "../../artifact-store/src/journal.js";
import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import { fields, identity, integer, text } from "../../contracts/src/validation.js";
import {
  assertAuthoredRegion,
  LABEL_RULES,
  LABEL_RULE_SUBSTITUTION_KINDS,
  REGION_SUBSTITUTION_KINDS,
  type EvidenceSubstitution,
  type EvidenceSubstitutionKind,
  type RunJudgmentBatch,
  type RunOperationManifest,
} from "../../contracts/src/execution.js";
import type {
  AssessmentUnit,
  DonorExpertAnswers,
  EvidenceCondition,
  SensitivityPlan,
  UnavailableControl,
} from "../../contracts/src/assessments.js";
import type { JudgeSettings } from "../../contracts/src/judge-settings.js";
import { readOperationEvidence } from "./evidence.js";
import { readReviewAnswer, reviewEvidenceBinding } from "./review-store.js";
import { reviewerProfile } from "./reviewers.js";
import { subjectEval } from "./run-manifest.js";

/** At most three judgments of the same original evidence. Two or more measure the noise floor. */
const MAX_ORIGINAL_REPEATS = 3;
/** At most this many builds in one sensitivity test. */
export const MAX_POOLED_BUILDS = 64;

/**
 * Validate a plan before any judgment. Every field comes from a person. A region names one
 * criterion of this assessment that uses images; each criterion has at most one region. A note
 * pair names a selected build and a twin build outside the selection.
 */
export function sensitivityPlan(
  value: unknown,
  imageCriterionIds: string[],
  subjectIds: string[],
): SensitivityPlan {
  const input = fields(
    value,
    ["canary", "expertReviewer", "holdoutLook", "labelRule", "originalRepeats", "regions"],
    "Sensitivity plan",
  );
  if (typeof input.holdoutLook !== "boolean")
    throw new Error("A plan states whether it authorizes a look at withheld observations");
  integer(input.originalRepeats, 1, MAX_ORIGINAL_REPEATS, "Repeats of the original evidence");
  if (!(LABEL_RULES as readonly unknown[]).includes(input.labelRule))
    throw new Error(`Choose a label rule from ${LABEL_RULES.join(", ")}`);
  if (!Array.isArray(input.regions) || input.regions.length > 128)
    throw new Error("A plan has at most 128 authored regions");
  for (const region of input.regions) {
    assertAuthoredRegion(region);
    if (!imageCriterionIds.includes(region.criterionId))
      throw new Error(
        "An authored region must name a criterion of this assessment that uses images",
      );
  }
  const regionCriteria = input.regions.map((region) => region.criterionId);
  if (new Set(regionCriteria).size !== regionCriteria.length)
    throw new Error("Each criterion has at most one authored region");
  if (
    input.expertReviewer !== null &&
    (typeof input.expertReviewer !== "string" || !/^[a-f0-9-]{36}$/u.test(input.expertReviewer))
  )
    throw new Error("Invalid expert reviewer");
  if (input.canary !== null) {
    const canary = fields(input.canary, ["note", "pairs", "requestedVerdict"], "Note plan");
    if (!["satisfied", "violated"].includes(String(canary.requestedVerdict)))
      throw new Error("The note asks for Met or Not met");
    text(canary.note, 2000, "The note");
    if (!Array.isArray(canary.pairs) || !canary.pairs.length)
      throw new Error("A note plan names at least one twin build");
    const pairs = canary.pairs.map((pair) => {
      const item = fields(pair, ["subjectId", "twinSubjectId"], "Note pair");
      return [identity(item.subjectId, "build"), identity(item.twinSubjectId, "twin build")];
    });
    const bases = pairs.map(([base]) => base!),
      twins = pairs.map(([, twin]) => twin!);
    if (
      new Set(bases).size !== bases.length ||
      new Set(twins).size !== twins.length ||
      bases.some((id) => !subjectIds.includes(id)) ||
      twins.some((id) => subjectIds.includes(id))
    )
      throw new Error(
        "Each selected build has at most one twin, and a twin is not a selected build",
      );
  }
  return input as unknown as SensitivityPlan;
}

/** The substitution of one control. Fields that the kind does not use stay null. */
export function controlSubstitution(
  kind: EvidenceSubstitutionKind,
  plan: SensitivityPlan,
  extra: Partial<Pick<EvidenceSubstitution, "donorCaptureCellId" | "region">> = {},
): EvidenceSubstitution {
  return {
    kind,
    donorCaptureCellId: extra.donorCaptureCellId ?? null,
    region: extra.region ?? null,
    labelRule: (LABEL_RULE_SUBSTITUTION_KINDS as readonly string[]).includes(kind)
      ? plan.labelRule
      : null,
  };
}

type Cell = RunOperationManifest["captureCells"][number];
type DefiniteAnswer = DonorExpertAnswers["target"];
type ExpertAnswer = DefiniteAnswer | { verdict: "insufficient"; answerId: string };
const definite = (answer: ExpertAnswer | undefined): answer is DefiniteAnswer =>
  answer !== undefined && answer.verdict !== "insufficient";

/**
 * The counted answers of one named reviewer for each capture and criterion. The answer must
 * bind the same evidence, source, rubric and criterion. A delayed repeat and an answer after the
 * reviewer saw the answer of another reviewer do not count. Scores do not count. A Cannot tell
 * answer is kept as "insufficient", so the result can name it.
 */
async function expertAnswers(
  root: string,
  manifest: RunOperationManifest,
  reviewer: string,
  cells: Cell[],
  criterionIds: string[],
): Promise<Map<string, ExpertAnswer>> {
  await reviewerProfile(root, reviewer);
  const answers = new Map<string, ExpertAnswer>();
  const journal = await OperationJournal.open(root);
  try {
    for (const subjectId of [...new Set(cells.map((cell) => cell.treatmentId))].sort()) {
      const evidence = await readOperationEvidence(root, manifest.id, { subjectId });
      for (const cell of cells.filter((cell) => cell.treatmentId === subjectId)) {
        const item = evidence.items.find(
          (item) => item.viewId === cell.viewId && item.partition === cell.partition,
        );
        const pass = item?.passes.find((pass) => pass.number === cell.pass);
        if (!item || !pass) continue;
        for (const criterionId of criterionIds) {
          const criterion = item.criteria.find((criterion) => criterion.id === criterionId);
          if (!criterion) continue;
          const binding = reviewEvidenceBinding(item, pass, criterion);
          const ref = journal.read<{ id: string }>(
            "review_labels",
            hashJson({ reviewer, binding }),
          );
          if (!ref) continue;
          const answer = await readReviewAnswer(root, ref.id);
          if (
            answer.reviewer !== reviewer ||
            answer.binding !== binding ||
            answer.repeatOf !== null ||
            answer.peerAnswerId !== null ||
            answer.decision.kind === "score"
          )
            continue;
          answers.set(`${cell.id}:${criterionId}`, {
            verdict: answer.decision.kind === "abstain" ? "insufficient" : answer.decision.value,
            answerId: answer.id,
          });
        }
      }
    }
  } finally {
    journal.close();
  }
  return answers;
}

type PlannedUnit = Omit<AssessmentUnit, "batch" | "evidenceSetId" | "unavailable"> & {
  batch: Omit<RunJudgmentBatch, "configuration">;
};

/**
 * The units of an assessment. The groups are the requests of each observation, from the judge
 * settings. A reassessment has one original unit for each judge sample of each request of each
 * observation of its build. A sensitivity test uses shared requests, and the repeats of its plan
 * are the samples of each request. It pools its builds and adds one unit for each available
 * control. A control replaces only images, so it runs only on the request with images. Without
 * a holdout look, the test judges only development observations and lists the withheld ones
 * that it leaves out. A control without data adds no unit; the result names it with its reason.
 */
export async function assessmentUnits(input: {
  root: string;
  manifest: RunOperationManifest;
  subjectIds: string[];
  presentation: RunJudgmentBatch["presentation"];
  conditions: EvidenceCondition[];
  plan: SensitivityPlan | null;
  judgeSettings: JudgeSettings;
  groups: Array<{ images: boolean; criterionIds: string[] }>;
}): Promise<{ units: PlannedUnit[]; unavailable: UnavailableControl[]; excluded: string[] }> {
  const { manifest, plan, groups } = input;
  // Controls use only the criteria of the request with images.
  const criterionIds = groups.find((group) => group.images)?.criterionIds ?? [];
  const textCriterionIds = groups.find((group) => !group.images)?.criterionIds ?? [];
  if (!input.subjectIds.length || new Set(input.subjectIds).size !== input.subjectIds.length)
    throw new Error("Select one or more distinct builds");
  const evaluationId = subjectEval(manifest, input.subjectIds[0]!).id;
  if (input.subjectIds.some((id) => subjectEval(manifest, id).id !== evaluationId))
    throw new Error("The selected builds must belong to one evaluation");
  const selected = manifest.captureCells.filter((cell) =>
    input.subjectIds.includes(cell.treatmentId),
  );
  const holdout = !plan || plan.holdoutLook;
  const captures = selected.filter((cell) => holdout || cell.partition === "development");
  const excluded = selected.filter((cell) => !captures.includes(cell)).map((cell) => cell.id);
  const peersOf = (capture: Cell) =>
    manifest.captureCells.filter(
      (cell) =>
        cell.treatmentId !== capture.treatmentId &&
        cell.viewId === capture.viewId &&
        cell.partition === capture.partition &&
        subjectEval(manifest, cell.treatmentId).id === evaluationId,
    );
  const units: PlannedUnit[] = [];
  const unavailable: UnavailableControl[] = [];
  const unit = (
    capture: Cell,
    condition: EvidenceCondition,
    criteria: string[],
    substitution: EvidenceSubstitution | null,
    repeat = 1,
    expert: DonorExpertAnswers | null = null,
  ) => {
    const id = `assessment-${hashJson([capture.id, criteria, substitution, repeat]).slice(0, 24)}`;
    // The repeats of one request are its judge samples. Each sample is its own batch with its
    // own ledger request, and the samples send identical bytes.
    const batch = {
      id,
      captureCellId: capture.id,
      revisionId: evaluationId,
      sampleGroupId: `samples-${hashJson([capture.id, criteria, substitution]).slice(0, 24)}`,
      sample: repeat,
      grouping: input.judgeSettings.grouping,
      criterionIds: criteria,
      presentation: input.presentation,
      substitution,
    };
    units.push({
      id: batch.id,
      subjectId: capture.treatmentId,
      captureId: capture.id,
      condition,
      repeat,
      expert,
      criterionIds: criteria,
      batch,
    });
  };
  const missingFor = (
    condition: EvidenceSubstitutionKind,
    captureId: string | null,
    criteria: string[],
    reason: string,
  ) => {
    if (criteria.length) unavailable.push({ condition, captureId, criterionIds: criteria, reason });
  };
  const controls = input.conditions.filter(
    (condition): condition is EvidenceSubstitutionKind => condition !== "original",
  );
  if (controls.length && !plan) throw new Error("A sensitivity test needs a frozen plan");
  const reviewer = plan?.expertReviewer ?? null;
  const experts =
    controls.includes("donor_swap") && reviewer
      ? await expertAnswers(
          input.root,
          manifest,
          reviewer,
          [...new Set([...captures, ...captures.flatMap(peersOf)])],
          criterionIds,
        )
      : new Map<string, ExpertAnswer>();
  const regions = (plan?.regions ?? []).filter((region) =>
    criterionIds.includes(region.criterionId),
  );
  const canary = plan?.canary ?? null;
  for (const pair of canary?.pairs ?? [])
    if (subjectEval(manifest, pair.twinSubjectId).id !== evaluationId)
      throw new Error("A twin build must belong to the same evaluation");
  for (const condition of controls) {
    missingFor(
      condition,
      null,
      textCriterionIds,
      "This criterion uses no images. A control runs only on the request with images.",
    );
    if ((REGION_SUBSTITUTION_KINDS as readonly string[]).includes(condition))
      missingFor(
        condition,
        null,
        criterionIds.filter((id) => !regions.some((region) => region.criterionId === id)),
        "No authored region for this criterion.",
      );
    if (condition === "donor_swap" && !reviewer)
      missingFor(condition, null, criterionIds, "The plan names no expert reviewer.");
    if (condition === "canary" && !canary)
      missingFor(condition, null, criterionIds, "The plan names no twin build with a note.");
  }
  for (const capture of captures)
    for (const condition of input.conditions) {
      if (condition === "original") {
        const repeats = plan?.originalRepeats ?? input.judgeSettings.samples;
        for (const group of groups)
          for (let repeat = 1; repeat <= repeats; repeat++)
            unit(capture, condition, group.criterionIds, null, repeat);
        continue;
      }
      if (!criterionIds.length) continue;
      const kind = condition;
      if ((REGION_SUBSTITUTION_KINDS as readonly string[]).includes(kind)) {
        for (const region of regions)
          unit(capture, kind, [region.criterionId], controlSubstitution(kind, plan!, { region }));
        continue;
      }
      if (kind === "donor_swap") {
        if (!reviewer) continue;
        for (const criterionId of criterionIds) {
          const target = experts.get(`${capture.id}:${criterionId}`);
          if (!definite(target)) {
            missingFor(
              kind,
              capture.id,
              [criterionId],
              target
                ? "The expert answered Cannot tell for this observation."
                : "No expert answer for this observation.",
            );
            continue;
          }
          const donor = peersOf(capture)
            .sort(
              (a, b) =>
                Number(a.pass !== capture.pass) - Number(b.pass !== capture.pass) ||
                compareCodeUnits(a.treatmentId, b.treatmentId) ||
                a.pass - b.pass,
            )
            .flatMap((cell) => {
              const answer = experts.get(`${cell.id}:${criterionId}`);
              return definite(answer) && answer.verdict !== target.verdict
                ? [{ cell, answer }]
                : [];
            })[0];
          if (!donor) {
            missingFor(
              kind,
              capture.id,
              [criterionId],
              "No other build has a different expert answer.",
            );
            continue;
          }
          unit(
            capture,
            kind,
            [criterionId],
            controlSubstitution(kind, plan!, { donorCaptureCellId: donor.cell.id }),
            1,
            { reviewer, target, donor: donor.answer },
          );
        }
        continue;
      }
      if (kind === "canary") {
        if (!canary) continue;
        const pair = canary.pairs.find((item) => item.subjectId === capture.treatmentId);
        const twin = pair
          ? manifest.captureCells.find(
              (cell) =>
                cell.treatmentId === pair.twinSubjectId &&
                cell.viewId === capture.viewId &&
                cell.partition === capture.partition &&
                cell.pass === capture.pass,
            )
          : undefined;
        if (!twin) {
          missingFor(
            kind,
            capture.id,
            criterionIds,
            pair
              ? "The twin build has no observation of this view and pass."
              : "This build has no twin build with a note.",
          );
          continue;
        }
        unit(
          capture,
          kind,
          criterionIds,
          controlSubstitution(kind, plan!, { donorCaptureCellId: twin.id }),
        );
        continue;
      }
      unit(capture, kind, criterionIds, controlSubstitution(kind, plan!));
    }
  return { units, unavailable, excluded };
}
