import { MAX_GENERATIONS } from "../../contracts/src/execution-limits.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { fields, hash, integer } from "../../contracts/src/validation.js";
import type { SavedSelectionRunQuote, EvaluationRunSelection } from "../../contracts/src/suites.js";
import type {
  RunOperationManifest,
  RunSubject,
  SavedEvalRunQuote,
} from "../../contracts/src/execution.js";
import { assertRegisteredModels, readModelRegistry } from "./model-registry.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { catalogStageRecords } from "./evaluation-detail.js";
import {
  evalRunSelection,
  judgeCriteria,
  prepareFrozenEvalRun,
  quoteRegisteredEvalRun,
} from "./run-plan.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { composedQuote, continueStage, createComposedRun, sharedCatalog } from "./stage-run.js";

export async function quoteSelectionRun(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<SavedSelectionRunQuote> {
  const row = fields(
    value,
    [
      "revisionIds",
      "builderModelIds",
      "harnessIds",
      "repetitions",
      "capturePasses",
      "gradingModelId",
      "judgeSettings",
    ],
    "Selection workload",
  );
  if (
    !Array.isArray(row.revisionIds) ||
    !row.revisionIds.length ||
    row.revisionIds.length > 1000 ||
    new Set(row.revisionIds).size !== row.revisionIds.length
  )
    throw new Error("Choose 1 to 1,000 different evaluations.");
  row.revisionIds.forEach((id) => hash(id));
  integer(row.repetitions, 1, MAX_GENERATIONS, "Builds per model");
  integer(row.capturePasses, 1, 3, "Observations per build");
  const selection = row as unknown as EvaluationRunSelection;
  if (typeof selection.gradingModelId !== "string") throw new Error("Choose a judge model.");
  assertRegisteredModels(await readModelRegistry(root), [
    ...selection.builderModelIds,
    selection.gradingModelId,
  ]);
  const components: SavedEvalRunQuote[] = [];
  const catalog = sharedCatalog(adapters);
  for (const revisionId of selection.revisionIds) {
    const chain = await catalogStageRecords(root, revisionId, true);
    if (!chain)
      throw new Error(
        "A selected evaluation is not ready to run. Remove it from the selection, or complete its preparation.",
      );
    // Each stage of a staged evaluation is its own component, quoted in stage order.
    for (const [index, revision] of chain.stages.entries()) {
      const selected = evalRunSelection({
        revisionId: revision.id,
        validationRecordHash: chain.records[index]!,
        builderModelIds: selection.builderModelIds,
        harnessIds: selection.harnessIds,
        repetitions: selection.repetitions,
        nativeCaptureRepetitions: selection.capturePasses,
        gradingModelId: judgeCriteria(revision).length ? selection.gradingModelId : null,
        judgeSettings: selection.judgeSettings,
        captureScope: "final",
        publicFeedbackId: null,
        sourceIds: [],
        parentSourceId: null,
        gradingMode: "all",
        continuingOperationId: null,
      });
      components.push(
        await quoteRegisteredEvalRun({
          root,
          selection: selected,
          adapters: catalog.adapters,
        }),
      );
    }
  }
  const quote = composedQuote(
    components,
    [...catalog.models.values()],
    selection.capturePasses,
    hashJson(selection),
  );
  const body = {
    schema: "basalt-evals/saved-run-quote" as const,
    kind: "selection" as const,
    selection,
    componentQuoteIds: components.map((component) => component.id),
    quote,
  };
  const saved = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/eval-run-quotes/${saved.id}.json`;
  await files.writeJsonOnce(path, saved);
  return saved;
}

export async function freezeSelectionRun(input: {
  root: string;
  operationId: string;
  quoteId: string;
  ceilingUsd: number;
  adapters?: ExecutionAdapters;
}) {
  const files = new RepositoryFiles(input.root);
  const saved = await files.json<SavedSelectionRunQuote>(
    `.basalt-evals/eval-run-quotes/${input.quoteId}.json`,
  );
  const { id, ...body } = saved;
  if (id !== input.quoteId || hashJson(body) !== id || saved.kind !== "selection")
    throw new Error("Selection quote changed");
  const adapters = input.adapters ?? liveExecutionAdapters;
  const components: RunOperationManifest[] = [];
  const quoteIds = [...saved.componentQuoteIds];
  for (const revisionId of saved.selection.revisionIds) {
    // The components of a staged evaluation follow in stage order. A later stage continues the
    // build of its own model, tool set and repetition in the stage before it.
    const stages = await new EvalDefinitionStore(input.root).readStageRevisions(revisionId, true);
    let parents: RunSubject[] | null = null;
    for (const revision of stages) {
      const quoteId = quoteIds.shift();
      if (!quoteId) throw new Error("Selection workload differs from its snapshot");
      const component = await prepareFrozenEvalRun({
        ...input,
        quoteId,
        adapters,
        transportModels: saved.quote.models,
        firstRevisionId: revisionId,
      });
      if (component.evals[0]?.id !== revision.id)
        throw new Error("Quoted suite member differs from the frozen snapshot");
      const subjects = continueStage(component.subjects, parents);
      parents = subjects.filter((subject) => subject.builder);
      components.push({ ...component, subjects });
    }
  }
  if (quoteIds.length) throw new Error("Selection workload differs from its snapshot");
  return createComposedRun(input, components, saved, saved.selection.builderModelIds);
}
