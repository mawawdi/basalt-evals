import { registerSavedSubject } from "./replay.js";
import { judgeCriteria } from "./run-plan.js";
import type { ExecutionAdapters } from "./adapters.js";
import type { EvalRunSelection, RunEvalReference } from "../../contracts/src/execution.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { defaultHarness } from "./config.js";
import { stageRecordHashes } from "../../eval-authoring/src/registration.js";
import { quoteSavedBuildRun } from "./stage-run.js";

interface RepairInput {
  modelId: string;
  gradingModelId: string | null;
  attempts: number;
  passes: number;
  publicFeedbackId: string | null;
}

/** The console offers one judge for every repair. Only an evaluation with judge criteria uses it. */
export function repairSelection(
  input: RepairInput,
  harnessId: string,
  parentSourceId: string,
  evaluation: Pick<RunEvalReference, "id" | "validationRecordHash">,
  revision: Pick<EvalRevision, "privateEvaluator">,
): EvalRunSelection {
  return {
    continuingOperationId: null,
    revisionId: evaluation.id,
    validationRecordHash: evaluation.validationRecordHash,
    captureScope: "final",
    publicFeedbackId: input.publicFeedbackId,
    sourceIds: [],
    parentSourceId,
    gradingMode: "all",
    builderModelIds: [input.modelId],
    gradingModelId: judgeCriteria(revision).length ? input.gradingModelId : null,
    judgeSettings: DEFAULT_JUDGE_SETTINGS,
    harnessIds: [harnessId],
    repetitions: input.attempts,
    nativeCaptureRepetitions: input.passes,
  };
}

/**
 * Public-task-only repair: the sealed parent initializes a build with the default tool set. A
 * repair of a build of a staged evaluation continues through the last stage. A later stage
 * starts from the repair build only when that build passes the gate of its stage.
 */
export async function quoteSavedRepair(
  input: RepairInput & {
    root: string;
    operationId: string;
    subjectId: string;
    adapters?: ExecutionAdapters;
  },
) {
  const { saved, evaluation } = await registerSavedSubject(input);
  const store = new EvalDefinitionStore(input.root);
  const revision = await store.readExecutableRevision(evaluation.id);
  const harnessId = (await defaultHarness(input.root)).id;
  const selection = repairSelection(input, harnessId, saved.id, evaluation, revision);
  // The later stages keep the readiness records that the record of the repaired stage names.
  const stages = (await store.readStageRevisions(evaluation.stage.firstRevisionId, true)).slice(
    evaluation.stage.index - 1,
  );
  const records = await stageRecordHashes(input.root, stages, evaluation.validationRecordHash);
  return quoteSavedBuildRun({
    root: input.root,
    stage: evaluation.stage,
    // Each later build continues the build of the stage before it, so it has no saved source
    // and no public feedback.
    selections: [
      selection,
      ...stages.slice(1).map((stage, index) => ({
        ...selection,
        revisionId: stage.id,
        validationRecordHash: records[index + 1]!,
        gradingModelId: judgeCriteria(stage).length ? input.gradingModelId : null,
        publicFeedbackId: null,
        parentSourceId: null,
      })),
    ],
    ...(input.adapters ? { adapters: input.adapters } : {}),
  });
}
