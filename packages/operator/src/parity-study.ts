import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import type { LaunchIntent } from "../../contracts/src/launch.js";
import { fields, hash, identifiers } from "../../contracts/src/validation.js";
import {
  compileCuratedRevision,
  readCuratedTaskFiles,
} from "../../eval-authoring/src/curated-revision.js";
import type { PublicPreparation } from "../../eval-authoring/src/proposals.js";
import { registerReadyEvaluation } from "../../eval-authoring/src/registration.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import {
  preparationParity,
  type ParityRow,
  type PreparationParityReport,
} from "../../experiments/src/preparation-parity.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { evaluationSummary } from "./discovery.js";
import { publicPreparationContext } from "./prepare-draft.js";
import { savePublicPreparation } from "./public-preparation.js";
import { savedAnswers } from "./recheck-results.js";
import { frozenRunStatus } from "./run-builder.js";
import { quoteRegisteredEvalRun } from "./run-plan.js";
import { readRunQuote } from "./run-quotes.js";
import { readRegisteredSource } from "./sources.js";

/*
 * The preparation parity study. A person curates one task: the rubric, the map and the task files.
 * Each preparation model prepares the same draft with the curated public part, so it writes only
 * the private stages. The saved study builds run under each plan with code checks only and two
 * observations each. The report pairs the answers by authored criterion and source hash.
 */

interface ParityStudy {
  schema: "basalt-evals/parity-study";
  id: string;
  taskDirectory: string;
  draftId: string;
  curatedRevisionId: string;
  /** The saved study builds as registered sources. */
  sourceIds: string[];
  /** The curated public part, or null when the seed cannot hold it as a public scene. */
  publicProposal: PublicPreparation | null;
}

/** Each saved build runs two times under each plan, so a report can show the noise floor. */
const PARITY_OBSERVATIONS = 2;

const studyFile = (id: string) => `.basalt-evals/parity-studies/${hash(id, "study identity")}.json`;

async function readParityStudy(root: string, id: string): Promise<ParityStudy> {
  const study = await new RepositoryFiles(root).json<ParityStudy>(studyFile(id));
  const { id: savedId, ...body } = study;
  if (study.schema !== "basalt-evals/parity-study" || savedId !== id || hashJson(body) !== id)
    throw new Error("The parity study changed");
  return study;
}

/**
 * Compile the curated revision of one task, register it as ready and save the study. The person
 * wrote the rubric and the map. The study builds are sources that a person registered.
 */
export async function curateParityStudy(
  root: string,
  taskDirectory: string,
  sourceIds: string[],
): Promise<ParityStudy> {
  identifiers(sourceIds, 64, "Study builds", true);
  for (const id of sourceIds) await readRegisteredSource(root, id);
  const curated = compileCuratedRevision(await readCuratedTaskFiles(resolve(root, taskDirectory)));
  if (!curated.revision)
    throw new Error(
      "The curated plan does not compile: " +
        curated.validation.diagnostics.map((item) => item.message).join("; "),
    );
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(curated.draft);
  await store.writeRevision(curated.revision);
  await registerReadyEvaluation(root, curated.revision.id);
  const body: Omit<ParityStudy, "id"> = {
    schema: "basalt-evals/parity-study",
    taskDirectory,
    draftId: curated.draft.id,
    curatedRevisionId: curated.revision.id,
    sourceIds: [...sourceIds].sort(),
    publicProposal: curated.publicProposal,
  };
  const study = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJsonOnce(studyFile(study.id), study);
  return study;
}

/**
 * Save the curated public part for each preparation model, then give the preparation launch of
 * each model. A launch needs a preview and a spending limit like every paid run.
 */
export async function prepareParityStudy(
  root: string,
  studyId: string,
  modelIds: string[],
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<LaunchIntent[]> {
  const study = await readParityStudy(root, studyId);
  if (!study.publicProposal)
    throw new Error(
      "The seed of this task has an instance that a public scene cannot hold. A curated public part is not available.",
    );
  const draft = await new EvalDefinitionStore(root).readDraft(study.draftId);
  const intents: LaunchIntent[] = [];
  for (const modelId of modelIds) {
    const [snapshot] = await adapters.catalog([{ id: modelId, requirement: { tools: true } }]);
    if (!snapshot) throw new Error(`The model ${modelId} is not available`);
    await savePublicPreparation(
      root,
      await publicPreparationContext(root, draft, snapshot),
      study.publicProposal,
      "curated",
    );
    intents.push({
      kind: "evaluation",
      selection: {
        sources: [{ kind: "draft", id: study.draftId }],
        objective: "prepare",
        builderModelIds: [modelId],
        harnessIds: ["thin"],
        repetitions: 1,
        capturePasses: 1,
        gradingModelId: null,
        judgeSettings: DEFAULT_JUDGE_SETTINGS,
        preparationModelId: modelId,
        coverageModelId: null,
        capacity: "interactive",
      },
    });
  }
  return intents;
}

/** The code-only run of the study builds under one plan of the study. */
export async function quoteParityRun(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const input = fields(value, ["studyId", "revisionId"], "Parity run");
  const study = await readParityStudy(root, hash(input.studyId, "study identity"));
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    hash(input.revisionId, "evaluation identity"),
  );
  if (revision.draftId !== study.draftId)
    throw new Error("The plan does not belong to the draft of this parity study");
  const ready = await evaluationSummary(root, revision.id);
  if (!ready?.validationRecordHash)
    throw new Error("This plan is not ready to run. Complete its preparation first.");
  return quoteRegisteredEvalRun({
    root,
    adapters,
    selection: {
      captureScope: "final",
      publicFeedbackId: null,
      sourceIds: study.sourceIds,
      parentSourceId: null,
      gradingMode: "code",
      continuingOperationId: null,
      revisionId: revision.id,
      validationRecordHash: ready.validationRecordHash,
      builderModelIds: [],
      gradingModelId: null,
      judgeSettings: DEFAULT_JUDGE_SETTINGS,
      harnessIds: [],
      repetitions: 0,
      nativeCaptureRepetitions: PARITY_OBSERVATIONS,
    },
  });
}

/**
 * The rows of one finished parity run. Each observation of each study build gives one answer for
 * each authored criterion that a code check of the plan checks. One not met code check makes the
 * authored criterion not met.
 */
async function parityRows(
  root: string,
  study: ParityStudy,
  operationId: string,
  preparationModelId: string | null,
): Promise<ParityRow[]> {
  const status = await frozenRunStatus(root, operationId);
  const manifest = status.manifest;
  if (!manifest.quoteSelectionId) throw new Error("The run is not a parity run of this study");
  const saved = await readRunQuote(root, manifest.quoteSelectionId);
  if (
    saved.kind !== "eval" ||
    saved.selection.gradingMode !== "code" ||
    hashJson([...saved.selection.sourceIds].sort()) !== hashJson(study.sourceIds)
  )
    throw new Error("The run is not a parity run of this study");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    saved.selection.revisionId,
  );
  if (revision.draftId !== study.draftId) throw new Error("The run checks a plan of another draft");
  if ((preparationModelId === null) !== (revision.id === study.curatedRevisionId))
    throw new Error("Name the curated run without a model, and each prepared run with its model");
  const answers = savedAnswers(manifest, status.criterionOutcomes);
  const rows: ParityRow[] = [];
  for (const capture of manifest.captureCells) {
    const subject = manifest.subjects.find((item) => item.id === capture.treatmentId)!;
    const { source } = await readRegisteredSource(root, subject.sourceId!);
    for (const criterion of revision.authored.criteria) {
      const checks = revision.criterionMappings
        .filter(
          (mapping) =>
            mapping.authoredCriterionId === criterion.id &&
            revision.privateEvaluator.deterministic.some(
              (item) => item.id === mapping.executableCriterionId,
            ),
        )
        .map((mapping) => answers.get(`${capture.id}:${mapping.executableCriterionId}`) ?? null);
      if (!checks.length) continue;
      rows.push({
        preparationModelId,
        revisionId: revision.id,
        authoredCriterionId: criterion.id,
        sourceHash: source.candidate.rootHash,
        answer: checks.includes("not_met")
          ? "not_met"
          : checks.every((answer) => answer === "met")
            ? "met"
            : "insufficient",
      });
    }
  }
  return rows;
}

/** Pair the finished parity runs. Each prepared run names its preparation model. */
export async function parityReport(
  root: string,
  studyId: string,
  curatedOperationId: string,
  prepared: Array<{ modelId: string; operationId: string }>,
): Promise<PreparationParityReport> {
  const study = await readParityStudy(root, studyId);
  const rows = await parityRows(root, study, curatedOperationId, null);
  for (const item of prepared)
    rows.push(...(await parityRows(root, study, item.operationId, item.modelId)));
  return preparationParity(rows);
}
