import { frozenRunStatus } from "./run-builder.js";
import { operationSource, registerSource, readRegisteredSource } from "./sources.js";
import { subjectEval, manifestHash } from "./run-manifest.js";
import type { ExecutionAdapters } from "./adapters.js";
import { registerPublicFeedback } from "./public-feedback.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import type { EvalRunSelection, RunOperationManifest } from "../../contracts/src/execution.js";
import { quoteSavedBuildRun } from "./stage-run.js";

export async function registerSavedSubject(input: {
  root: string;
  operationId: string;
  subjectId: string;
}) {
  const status = await frozenRunStatus(input.root, input.operationId);
  const evaluation = subjectEval(status.manifest, input.subjectId);
  const event = status.events.find(
    (event) =>
      event.unitId === input.subjectId &&
      event.kind === "completed" &&
      ["builder", "seal"].includes(event.stage ?? ""),
  );
  if (!event) throw new Error("This action needs a saved build. Choose a build that finished.");
  const subject = status.manifest.subjects.find((subject) => subject.id === input.subjectId)!;
  if (subject.sourceId)
    return { saved: (await readRegisteredSource(input.root, subject.sourceId)).source, evaluation };
  const source = await operationSource(input.root, status.manifest, input.subjectId);
  const saved = await registerSource({
    root: input.root,
    workspace: source.workspaceRoot,
    candidate: source.candidate,
    provenance: {
      kind: source.agentRun ? "generated" : "retained",
      originOperationId: input.operationId,
      evidenceHashes: [manifestHash(status.manifest), event.id],
      parentSourceId: status.manifest.subjects.find((subject) => subject.id === input.subjectId)!
        .parentSourceId,
    },
  });
  return { saved, evaluation };
}

/** New capture work from verified saved source. It uses the same quote, start and driver. */
export async function quoteSavedReplay(input: {
  root: string;
  operationId: string;
  subjectId: string;
  passes: number;
  adapters?: ExecutionAdapters;
}) {
  return quoteSavedAcquisition(input, "final");
}

export async function quoteSavedPublicDevelopment(input: Parameters<typeof quoteSavedReplay>[0]) {
  return quoteSavedAcquisition(input, "public_development");
}

async function quoteSavedAcquisition(
  input: Parameters<typeof quoteSavedReplay>[0],
  scope: "final" | "public_development",
) {
  const { saved, evaluation } = await registerSavedSubject(input);
  const selection: EvalRunSelection = {
    continuingOperationId: null,
    revisionId: evaluation.id,
    validationRecordHash: evaluation.validationRecordHash,
    captureScope: scope,
    publicFeedbackId: null,
    sourceIds: [saved.id],
    parentSourceId: null,
    gradingMode: "none",
    builderModelIds: [],
    gradingModelId: null,
    judgeSettings: DEFAULT_JUDGE_SETTINGS,
    harnessIds: [],
    repetitions: 0,
    nativeCaptureRepetitions: input.passes,
  };
  // A build of a staged evaluation holds the earlier stages, so it needs no earlier build.
  return quoteSavedBuildRun({
    root: input.root,
    stage: evaluation.stage,
    selections: [selection],
    ...(input.adapters ? { adapters: input.adapters } : {}),
  });
}

/**
 * The completed build that a registered source saved, in its own run. Null when the source
 * names no completed build of a run, for example a control or an imported source.
 */
export async function originBuild(
  root: string,
  sourceId: string,
): Promise<{ manifest: RunOperationManifest; subjectId: string } | null> {
  const { source } = await readRegisteredSource(root, sourceId);
  if (!source.provenance.originOperationId) return null;
  const origin = await frozenRunStatus(root, source.provenance.originOperationId, false);
  const event = origin.events.find(
    (item) =>
      source.provenance.evidenceHashes.includes(item.id) &&
      item.kind === "completed" &&
      ["builder", "seal"].includes(item.stage ?? ""),
  );
  return event?.unitId ? { manifest: origin.manifest, subjectId: event.unitId } : null;
}

/** The selection is fixed before looking at pixels: first public view and first pass. */
export async function registerSavedPublicFeedback(input: {
  root: string;
  operationId: string;
  subjectId: string;
}) {
  const { saved, evaluation } = await registerSavedSubject(input);
  const view = evaluation.views.find((view) => view.partition === "development");
  if (!view) throw new Error("Record an extra observation of the original build first.");
  return registerPublicFeedback(input.root, {
    operationId: input.operationId,
    subjectId: input.subjectId,
    sourceId: saved.id,
    viewId: view.id,
    pass: 1,
  });
}
