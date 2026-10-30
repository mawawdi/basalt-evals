import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import {
  assertExemplarChoice,
  EXEMPLAR_REASON_CHARS,
  MAX_EXEMPLARS,
  type ExemplarBuild,
  type ExemplarChoice,
} from "../../contracts/src/exemplars.js";
import { fields, hash, identity, object, text } from "../../contracts/src/validation.js";
import { exemplarComparisonGaps } from "../../eval-authoring/src/exemplar-comparison.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { ExemplarComparisonPlan } from "../../experiments/src/protocols.js";
import { readRegressionReference } from "./regressions.js";
import { judgeCriteria } from "./run-plan.js";
import { reviewerProfile } from "./reviewers.js";
import { frozenRunStatus } from "./run-builder.js";
import { manifestHash, operationSubject, subjectEval } from "./run-manifest.js";
import { originBuild } from "./replay.js";
import { operationSource } from "./sources.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";

/*
 * Exemplar choices and the holdout rule of the exemplar comparison stream. Only a person chooses
 * an exemplar: the choice names the reviewer profile of that person, and no model output can
 * write it. An exemplar is a saved example or a build of a run, and only one of its development
 * observations. Basalt refuses a withheld observation, because it is part of the holdout.
 */

export function criterionIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value))
    throw new Error("Invalid criterion identity");
  return value;
}

/**
 * An exemplar observation is a recorded development observation of the build. Basalt refuses
 * a withheld observation, because it is part of the holdout.
 */
export function assertExemplarObservation(
  manifest: Pick<RunOperationManifest, "captureCells">,
  completedUnits: string[],
  subjectId: string,
  captureId: string,
): void {
  const capture = manifest.captureCells.find(
    (cell) => cell.id === captureId && cell.treatmentId === subjectId,
  );
  if (!capture)
    throw new Error(
      "The chosen observation is not an observation of the build. Choose an observation of the anchor build.",
    );
  if (capture.partition !== "development")
    throw new Error(
      "Choose a development observation. A withheld observation is part of the holdout.",
    );
  if (!completedUnits.includes(`final_capture:${capture.id}`))
    throw new Error(
      "The chosen observation has no recorded evidence. Choose an observation that finished.",
    );
}

/**
 * The model that made a build. A saved build names the run that made it, so the rule follows
 * that record. Null when no model made the build, for example a person or a control.
 */
async function subjectBuilderModelId(
  root: string,
  manifest: RunOperationManifest,
  subjectId: string,
  depth = 0,
): Promise<string | null> {
  const subject = operationSubject(manifest, subjectId);
  if (subject.builder) return subject.builder.model.id;
  if (!subject.sourceId || depth >= 8) return null;
  const origin = await originBuild(root, subject.sourceId);
  return origin ? subjectBuilderModelId(root, origin.manifest, origin.subjectId, depth + 1) : null;
}

/** Resolve one exemplar to a development observation of a recorded build of the evaluation. */
async function resolveExemplar(
  root: string,
  evaluationId: string,
  criterionId: string,
  value: unknown,
): Promise<ExemplarBuild> {
  const row = object(value, "Exemplar");
  let savedExampleId: string | null = null,
    savedManifestHash: string | null = null,
    operationId: string,
    subjectId: string;
  if ("savedExampleId" in row) {
    fields(row, ["savedExampleId", "captureId"], "Exemplar from a saved example");
    const reference = await readRegressionReference(root, hash(row.savedExampleId));
    if (reference.withheldCaptureIds.length)
      throw new Error(
        "Choose a saved example with only development observations. A withheld observation is part of the holdout.",
      );
    if (reference.evaluationId !== evaluationId || !reference.criterionIds.includes(criterionId))
      throw new Error(
        "The saved example does not include this evaluation and criterion. Choose a different saved example.",
      );
    savedExampleId = reference.id;
    savedManifestHash = reference.manifestHash;
    operationId = reference.operationId;
    subjectId = reference.subjectId;
  } else {
    fields(row, ["operationId", "subjectId", "captureId"], "Exemplar from a run");
    operationId = identity(row.operationId);
    subjectId = identity(row.subjectId);
  }
  const captureId = identity(row.captureId, "observation identity");
  const status = await frozenRunStatus(root, operationId, false);
  const manifest = status.manifest;
  if (savedManifestHash !== null && savedManifestHash !== manifestHash(manifest))
    throw new Error("The run of the saved example changed");
  if (subjectEval(manifest, subjectId).id !== evaluationId)
    throw new Error(
      "The anchor build belongs to a different evaluation. Choose a build of this evaluation.",
    );
  assertExemplarObservation(manifest, status.completedUnits, subjectId, captureId);
  const source = await operationSource(root, manifest, subjectId);
  return {
    savedExampleId,
    operationId,
    manifestHash: manifestHash(manifest),
    subjectId,
    captureId,
    sourceHash: source.candidate.rootHash,
    builderModelId: await subjectBuilderModelId(root, manifest, subjectId),
  };
}

/**
 * Save the exemplar choice of one criterion. The latest choice of a criterion is current;
 * earlier choices stay readable by their identity. A preview freezes the identity it uses.
 */
export async function chooseExemplars(root: string, value: unknown): Promise<ExemplarChoice> {
  const input = fields(
    value,
    ["evaluationId", "criterionId", "exemplars", "reviewerId", "reason"],
    "Exemplar choice",
  );
  const evaluationId = hash(input.evaluationId, "evaluation identity");
  const criterionId = criterionIdentity(input.criterionId);
  const reviewerId = identity(input.reviewerId, "reviewer identity");
  await reviewerProfile(root, reviewerId);
  const reason = text(input.reason, EXEMPLAR_REASON_CHARS, "The reason");
  if (
    !Array.isArray(input.exemplars) ||
    !input.exemplars.length ||
    input.exemplars.length > MAX_EXEMPLARS
  )
    throw new Error("Choose one or two anchor builds.");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluationId);
  // Only a judge criterion can use anchor builds. A code check never compares two builds.
  const criterion = judgeCriteria(revision).find((item) => item.id === criterionId);
  if (!criterion)
    throw new Error(
      "The criterion is not a judge criterion of this evaluation. Choose a criterion that the judge checks.",
    );
  const gaps = exemplarComparisonGaps(criterion);
  if (gaps.length) throw new Error(gaps.join("; "));
  const exemplars: ExemplarBuild[] = [];
  for (const item of input.exemplars)
    exemplars.push(await resolveExemplar(root, evaluationId, criterionId, item));
  const body: Omit<ExemplarChoice, "id"> = {
    evaluationId,
    criterionId,
    exemplars,
    reviewerId,
    reason,
    chosenAt: new Date().toISOString(),
  };
  const choice = assertExemplarChoice({ ...body, id: hashJson(body) });
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      journal.put("exemplar_choices", choice.id, choice);
      journal.put("current_exemplars", `${evaluationId}:${criterionId}`, { choiceId: choice.id });
    });
  } finally {
    journal.close();
  }
  return choice;
}

export async function readExemplarChoice(root: string, id: string): Promise<ExemplarChoice> {
  hash(id, "exemplar choice identity");
  const journal = await OperationJournal.open(root);
  try {
    const choice = journal.read<ExemplarChoice>("exemplar_choices", id);
    if (!choice) throw new Error("The exemplar choice is unavailable");
    if (choice.id !== id) throw new Error("Exemplar choice changed");
    return assertExemplarChoice(choice);
  } finally {
    journal.close();
  }
}

/** The current choice of one criterion, or null when no person chose exemplars for it. */
export async function currentExemplarChoice(
  root: string,
  evaluationId: string,
  criterionId: string,
): Promise<ExemplarChoice | null> {
  const journal = await OperationJournal.open(root);
  let pointer: { choiceId: string } | null;
  try {
    pointer = journal.read<{ choiceId: string }>(
      "current_exemplars",
      `${hash(evaluationId, "evaluation identity")}:${criterionIdentity(criterionId)}`,
    );
  } finally {
    journal.close();
  }
  if (!pointer) return null;
  const choice = await readExemplarChoice(root, pointer.choiceId);
  if (choice.evaluationId !== evaluationId || choice.criterionId !== criterionId)
    throw new Error("The current exemplar choice belongs to another criterion");
  return choice;
}

/** The current choice of each criterion of one evaluation. */
export async function listExemplarChoices(root: string, evaluationId: string) {
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    hash(evaluationId, "evaluation identity"),
  );
  const criteria = [];
  for (const criterion of judgeCriteria(revision))
    criteria.push({
      criterionId: criterion.id,
      gaps: exemplarComparisonGaps(criterion),
      choice: await currentExemplarChoice(root, evaluationId, criterion.id),
    });
  return { evaluationId, criteria };
}

/**
 * The holdout rule. The stream never judges a withheld observation before the analysis plan
 * pins it: the run must belong to the registered plan, and the plan must name the same
 * authored exemplar choice for each criterion.
 */
export function assertPinnedComparison(input: {
  manifest: RunOperationManifest;
  withheldCaptureIds: string[];
  analysisPlanId: string | null;
  plan: { id: string; exemplarComparison: ExemplarComparisonPlan | null } | null;
  evaluationId: string;
  choices: ExemplarChoice[];
}): void {
  if (!input.withheldCaptureIds.length && input.analysisPlanId === null) return;
  if (input.analysisPlanId === null || !input.plan)
    throw new Error(
      "The run of this build has withheld observations. Select the registered analysis plan that pins this comparison.",
    );
  const stream = input.plan.exemplarComparison;
  if (
    input.manifest.protocol?.registrationId !== input.analysisPlanId ||
    input.manifest.protocol.hash !== input.plan.id ||
    !stream ||
    input.choices.some((choice) => {
      const pinned = stream.criteria.find(
        (item) => item.evalId === input.evaluationId && item.criterionId === choice.criterionId,
      );
      return (
        !pinned ||
        pinned.choiceId !== choice.id ||
        hashJson(pinned.exemplarSourceHashes) !==
          hashJson(choice.exemplars.map((exemplar) => exemplar.sourceHash))
      );
    })
  )
    throw new Error(
      "The registered analysis plan of this run does not pin these anchor builds. This comparison cannot use the withheld observations.",
    );
}
