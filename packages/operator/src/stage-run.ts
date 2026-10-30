import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import type {
  EvalRunSelection,
  RunOperationManifest,
  RunSubject,
  SavedEvalRunQuote,
  SavedStageRunQuote,
} from "../../contracts/src/execution.js";
import { stageRecordHashes } from "../../eval-authoring/src/registration.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import {
  checkingCeiling,
  createRunQuote,
  workloadCeiling,
  type RunQuote,
} from "../../model-client/src/quote.js";
import { combineNativeWork } from "../../studio-runner/src/workload.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { assertKnownBuildGate } from "./known-build-gate.js";
import { frozenModelConcurrency } from "./model-registry.js";
import { operationInputHash } from "./operation-binding.js";
import { RunOperationStore } from "./operation.js";
import { assertManifest, manifestHash } from "./run-manifest.js";
import { prepareFrozenEvalRun, quoteRegisteredEvalRun } from "./run-plan.js";
import { readRunQuote } from "./run-quotes.js";

/*
 * A composed run holds several eval quotes under one quote and one spending limit. A selection
 * run composes the stages of its evaluations from stage 1. A stage run composes the stages of one
 * staged evaluation from saved builds, so it can start at a later stage.
 */

/**
 * A catalog that asks the provider one time for each model. Each component quote of a composed
 * run then uses the same model snapshot.
 */
export function sharedCatalog(adapters: ExecutionAdapters) {
  const models = new Map<ModelSnapshot["id"], ModelSnapshot>();
  const shared: ExecutionAdapters = {
    ...adapters,
    async catalog(requests) {
      const missing = requests.filter((request) => !models.has(request.id));
      if (missing.length) {
        for (const model of await adapters.catalog(missing)) models.set(model.id, model);
      }
      return requests.map((request) => {
        const model = models.get(request.id);
        if (!model) throw new Error("Selection model is unavailable");
        return model;
      });
    },
  };
  return { adapters: shared, models };
}

/** One quote for the work of all components of a composed run. */
export function composedQuote(
  components: SavedEvalRunQuote[],
  models: ModelSnapshot[],
  nativeCaptureRepetitions: number,
  subjectId: string,
): RunQuote {
  const workloads = components.map((component) => component.quote.workload);
  const sum = (field: "independentBuilderTrials" | "criterionOutcomes" | "judgmentBatches") =>
    workloads.reduce((total, work) => total + work[field], 0);
  return createRunQuote(
    {
      ...combineNativeWork(...workloads),
      nativeCaptureRepetitions,
      independentBuilderTrials: sum("independentBuilderTrials"),
      criterionOutcomes: sum("criterionOutcomes"),
      judgmentBatches: sum("judgmentBatches"),
      modelWork: workloads.flatMap((work) => work.modelWork),
    },
    models,
    subjectId,
  );
}

/**
 * Link each build of a component to the build of the stage before it with the same model, tool
 * set and repetition. A component without `parents` starts its evaluation in the run, so its
 * builds keep no parent build.
 */
export function continueStage(subjects: RunSubject[], parents: RunSubject[] | null): RunSubject[] {
  if (!parents) return subjects;
  return subjects.map((subject) => {
    if (!subject.builder) return subject;
    const parent = parents.find(
      (item) =>
        item.builder!.model.id === subject.builder!.model.id &&
        item.builder!.harness.id === subject.builder!.harness.id &&
        item.builder!.repetition === subject.builder!.repetition,
    );
    if (!parent) throw new Error("A later stage has no build of the stage before it");
    return { ...subject, parentSubjectId: parent.id };
  });
}

/** Save one manifest of the frozen components of a composed run, after its check. */
export async function createComposedRun(
  input: { root: string; operationId: string; ceilingUsd: number },
  components: RunOperationManifest[],
  saved: { id: string; quote: RunQuote },
  selectedModelIds: string[],
): Promise<RunOperationManifest> {
  const { modelWork: _work, ...planned } = saved.quote.workload;
  const manifest: RunOperationManifest = {
    ...components[0]!,
    id: input.operationId,
    inputHash: await operationInputHash(
      input.root,
      input.operationId,
      components[0]!.evals[0]!.draftId,
    ),
    evals: components.flatMap((item) => item.evals),
    subjects: components.flatMap((item) => item.subjects),
    captureCells: components.flatMap((item) => item.captureCells),
    gradingCells: components.flatMap((item) => item.gradingCells),
    judgmentBatches: components.flatMap((item) => item.judgmentBatches),
    quoteId: saved.quote.id,
    quoteSelectionId: saved.id,
    quoteHash: hashJson(saved.quote),
    workloadCeilingUsd: workloadCeiling(saved.quote),
    checkingCeilingUsd: checkingCeiling(saved.quote),
    modelSnapshots: saved.quote.models,
    modelConcurrency: await frozenModelConcurrency(input.root, saved.quote.models),
    selectedModelIds,
    planned,
    ceilingUsd: input.ceilingUsd,
    unreviewedClaims: [...new Set(components.flatMap((item) => item.unreviewedClaims))].sort(),
  };
  assertManifest(manifest);
  await new RunOperationStore(
    input.root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  ).create(manifest);
  return manifest;
}

/**
 * Refuse revisions that are not consecutive stages of the evaluation of `firstRevisionId`, in
 * stage order.
 */
async function assertHeldStages(root: string, firstRevisionId: string, revisionIds: string[]) {
  const stages = await new EvalDefinitionStore(root).readStageRevisions(firstRevisionId, true);
  const start = stages.findIndex((stage) => stage.id === revisionIds[0]);
  if (
    !revisionIds.length ||
    start < 0 ||
    revisionIds.some((id, index) => stages[start + index]?.id !== id)
  )
    throw new Error("A stage run holds consecutive stages of one evaluation, in stage order");
}

/** The eval quotes of a stage run, in stage order. */
export async function stageComponents(
  root: string,
  saved: SavedStageRunQuote,
): Promise<SavedEvalRunQuote[]> {
  return Promise.all(
    saved.componentQuoteIds.map(async (id) => {
      const component = await readRunQuote(root, id);
      if (component.kind !== "eval") throw new Error("A stage run holds only eval quotes");
      return component;
    }),
  );
}

/**
 * The quote of a run from saved builds. A build of a staged evaluation needs a stage run, which
 * names stage 1 of the evaluation. Another build has one eval quote.
 */
export function quoteSavedBuildRun(input: {
  root: string;
  stage: { firstRevisionId: string; count: number };
  selections: EvalRunSelection[];
  adapters?: ExecutionAdapters;
}): Promise<SavedEvalRunQuote | SavedStageRunQuote> {
  const adapters = input.adapters ? { adapters: input.adapters } : {};
  if (input.stage.count > 1)
    return quoteStageRun({
      root: input.root,
      firstRevisionId: input.stage.firstRevisionId,
      selections: input.selections,
      ...adapters,
    });
  if (input.selections.length !== 1)
    throw new Error("An evaluation without stages has one selection");
  return quoteRegisteredEvalRun({ root: input.root, selection: input.selections[0]!, ...adapters });
}

/**
 * Quote a stage run. The first selection starts from saved sources: retained sources or the
 * parent of a repair. Each later selection builds the next stage from the builds before it, with
 * the readiness record that the record of the stage before names.
 */
export async function quoteStageRun(input: {
  root: string;
  firstRevisionId: string;
  selections: EvalRunSelection[];
  adapters?: ExecutionAdapters;
}): Promise<SavedStageRunQuote> {
  await assertHeldStages(
    input.root,
    input.firstRevisionId,
    input.selections.map((selection) => selection.revisionId),
  );
  const [first, ...later] = input.selections;
  if (
    first!.sourceIds.length > 0 === (first!.parentSourceId !== null) ||
    later.some((selection) => selection.sourceIds.length || selection.parentSourceId !== null)
  )
    throw new Error("Only the first stage of a stage run starts from saved sources");
  const records = await stageRecordHashes(
    input.root,
    input.selections.map((selection) => ({ id: selection.revisionId })),
    first!.validationRecordHash,
  );
  if (
    input.selections.some((selection, index) => selection.validationRecordHash !== records[index])
  )
    throw new Error("The stages of this run do not belong to one version of the evaluation.");
  // The known builds of an evaluation gate new builds of each stage by its revision of stage 1.
  if (input.selections.some((selection) => selection.builderModelIds.length))
    await assertKnownBuildGate(input.root, input.firstRevisionId);
  const catalog = sharedCatalog(input.adapters ?? liveExecutionAdapters);
  const components: SavedEvalRunQuote[] = [];
  for (const selection of input.selections)
    components.push(
      await quoteRegisteredEvalRun({ root: input.root, selection, adapters: catalog.adapters }),
    );
  const quote = composedQuote(
    components,
    [...catalog.models.values()],
    first!.nativeCaptureRepetitions,
    hashJson([input.firstRevisionId, components.map((component) => component.id)]),
  );
  const body = {
    schema: "basalt-evals/saved-run-quote" as const,
    kind: "stages" as const,
    firstRevisionId: input.firstRevisionId,
    componentQuoteIds: components.map((component) => component.id),
    quote,
  };
  const saved = { ...body, id: hashJson(body) };
  await new RepositoryFiles(input.root).writeJsonOnce(
    `.basalt-evals/eval-run-quotes/${saved.id}.json`,
    saved,
  );
  return saved;
}

/** Freeze a stage run. Each later stage continues the builds of the stage before it. */
export async function freezeStageRun(input: {
  root: string;
  operationId: string;
  quoteId: string;
  ceilingUsd: number;
  adapters?: ExecutionAdapters;
}): Promise<RunOperationManifest> {
  const files = new RepositoryFiles(input.root);
  const saved = await files.json<SavedStageRunQuote>(
    `.basalt-evals/eval-run-quotes/${input.quoteId}.json`,
  );
  const { id, ...body } = saved;
  if (id !== input.quoteId || hashJson(body) !== id || saved.kind !== "stages")
    throw new Error("Stage run quote changed");
  await assertHeldStages(
    input.root,
    saved.firstRevisionId,
    (await stageComponents(input.root, saved)).map((quote) => quote.selection.revisionId),
  );
  const adapters = input.adapters ?? liveExecutionAdapters;
  const components: RunOperationManifest[] = [];
  let parents: RunSubject[] | null = null;
  for (const quoteId of saved.componentQuoteIds) {
    const component = await prepareFrozenEvalRun({
      ...input,
      quoteId,
      adapters,
      transportModels: saved.quote.models,
      firstRevisionId: saved.firstRevisionId,
    });
    const subjects = continueStage(component.subjects, parents);
    parents = subjects.filter((subject) => subject.builder);
    components.push({ ...component, subjects });
  }
  return createComposedRun(input, components, saved, [
    ...new Set(components.flatMap((component) => component.selectedModelIds)),
  ]);
}
