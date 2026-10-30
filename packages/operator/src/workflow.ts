import { MAX_GENERATIONS } from "../../contracts/src/execution-limits.js";
import { assertRunIdentityFree } from "./run-visibility.js";
import type {
  EvaluationWorkflow,
  LaunchPreview,
  LaunchSelection,
} from "../../contracts/src/execution.js";
import { budgetSummary } from "./budget-summary.js";
import { projectRun } from "./catalog-projection.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, isHarnessId, MAXIMUM_PRESENTED_FRAMES } from "../../contracts/src/index.js";
import { launchIdentity } from "../../contracts/src/validation.js";
import { DEFAULT_JUDGE_SETTINGS, judgeSettings } from "../../contracts/src/judge-settings.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { modelIdentityWithoutPrices } from "../../model-client/src/catalog.js";
import { assertRegisteredModels, readModelRegistry, type ModelRegistry } from "./model-registry.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { preparationQuote, textDraft, reusableDefinition } from "./prepare-draft.js";
import { quoteSelectionRun } from "./selection-run.js";
import { authoringActionResult, queueAuthoringAction } from "./authoring-operation.js";
import { queueRunStart, runStartProgress } from "./run-request.js";
import { assertOperationOwnerStopped, processAlive } from "./process-owner.js";
import { bindOperationImplementation } from "./execution-guard.js";
import { authoringProgress } from "./authoring-operation.js";
import { readLifecycle } from "./lifecycle.js";
import { readHarnessRegistry, selectedHarnesses, type HarnessRegistry } from "./config.js";

/**
 * The models come from the defaults that a person saves on the Models page. The tool set is the
 * default harness of the operator configuration.
 */
export function launchDefaults(
  registry: ModelRegistry,
  harnesses: Pick<HarnessRegistry, "defaultHarnessId">,
): Omit<LaunchSelection, "sources"> {
  return {
    objective: "evaluate",
    builderModelIds: [...registry.defaults.builderModelIds],
    harnessIds: [harnesses.defaultHarnessId],
    repetitions: 1,
    capturePasses: 3,
    gradingModelId: registry.defaults.gradingModelId,
    judgeSettings: structuredClone(DEFAULT_JUDGE_SETTINGS),
    preparationModelId: registry.defaults.preparationModelId,
    coverageModelId: registry.defaults.coverageModelId,
    capacity: "interactive",
  };
}

const LAUNCH_FIELDS = [
  "sources",
  "objective",
  "builderModelIds",
  "harnessIds",
  "repetitions",
  "capturePasses",
  "gradingModelId",
  "judgeSettings",
  "preparationModelId",
  "coverageModelId",
  "capacity",
];

const hashPattern = /^[a-f0-9]{64}$/u;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("Unsupported launch fields");
}

/** Check the shape of a selection. `assertLaunchModels` checks its models against the registry. */
export function launchSelection(value: unknown): LaunchSelection {
  exact(value, LAUNCH_FIELDS);
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 1000)
    throw new Error("Choose 1 to 1,000 evaluations.");
  value.sources.forEach((source) => exact(source, ["kind", "id"]));
  const selection = value as unknown as LaunchSelection;
  if (
    selection.sources.some(
      (source) => !["draft", "evaluation"].includes(source.kind) || !hashPattern.test(source.id),
    ) ||
    new Set(selection.sources.map((source) => source.id)).size !== selection.sources.length ||
    !["evaluate", "prepare"].includes(selection.objective)
  )
    throw new Error("Choose saved evaluations or drafts, and choose each one only one time.");
  for (const ids of [selection.builderModelIds, selection.harnessIds])
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
      throw new Error(
        "Choose at least one model and at least one set of tools. Choose each one only one time.",
      );
  if (selection.harnessIds.some((id) => !isHarnessId(id)))
    throw new Error("Choose tools from the approved list.");
  for (const id of [
    selection.gradingModelId,
    selection.preparationModelId,
    selection.coverageModelId,
  ])
    if (id !== null && typeof id !== "string") throw new Error("Choose each model by its ID.");
  if (selection.objective === "evaluate" && !selection.gradingModelId)
    throw new Error("Select a judge model. Save a default judge on the Models page.");
  judgeSettings(selection.judgeSettings);
  if (selection.sources.some((source) => source.kind === "draft") && !selection.preparationModelId)
    throw new Error(
      "Select a preparation model for the drafts. Save a default on the Models page.",
    );
  if (!["interactive", "flex"].includes(selection.capacity))
    throw new Error("Choose Interactive or Flex for the request priority.");
  if (
    !Number.isSafeInteger(selection.repetitions) ||
    selection.repetitions < 1 ||
    selection.repetitions > MAX_GENERATIONS ||
    !Number.isSafeInteger(selection.capturePasses) ||
    selection.capturePasses < 1 ||
    selection.capturePasses > 3
  )
    throw new Error(
      `Choose 1 to ${MAX_GENERATIONS} builds per model and 1 to 3 observations per build.`,
    );
  return structuredClone(selection);
}

/** A new preview uses only models that a person added. A saved preview keeps its models. */
export function assertLaunchModels(selection: LaunchSelection, registry: ModelRegistry): void {
  assertRegisteredModels(registry, [
    ...selection.builderModelIds,
    ...(selection.gradingModelId ? [selection.gradingModelId] : []),
    ...(selection.preparationModelId ? [selection.preparationModelId] : []),
    ...(selection.coverageModelId ? [selection.coverageModelId] : []),
  ]);
}

export async function workflowRecord(root: string, id: string): Promise<EvaluationWorkflow | null> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<EvaluationWorkflow>("workflows", id);
  } finally {
    journal.close();
  }
}

export async function updateWorkflow(
  root: string,
  id: string,
  changes: Partial<Pick<EvaluationWorkflow, "phase" | "state" | "blocker" | "revisions">>,
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const current = journal.read<EvaluationWorkflow>("workflows", id);
      if (!current) return null;
      const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
      // A late worker failure must not overwrite an explicit Stop in another process.
      if (current.state === "stopped" && changes.state === "attention") next.state = "stopped";
      journal.put("workflows", id, next);
      projectRun(journal, id);
      return next;
    });
  } finally {
    journal.close();
  }
}

/** Every stage revalidates the initially authorized endpoint and tariff; no inference here. */
export function pinnedWorkflowAdapters(
  preview: Pick<LaunchPreview, "models" | "studio">,
  adapters: ExecutionAdapters,
): ExecutionAdapters {
  return {
    ...adapters,
    studio: {
      ...adapters.studio,
      async identity(root) {
        const current = await adapters.studio.identity(root);
        if (hashJson(current) !== hashJson(preview.studio))
          throw new Error(
            "Studio, the Basalt connector or the Studio lane count changed after the preview. Make a new preview.",
          );
        return current;
      },
      async run(input) {
        const current = await adapters.studio.identity(input.root);
        if (hashJson(current) !== hashJson(preview.studio))
          throw new Error(
            "Studio, the Basalt connector or the Studio lane count changed after the preview. Make a new preview.",
          );
        return adapters.studio.run(input);
      },
    },
    // The workflow uses the endpoint sets of its preview. A request carries its set and its
    // price ceiling, so a later catalog read cannot change a model of the workflow.
    async catalog(requests) {
      return requests.map((request) => {
        const authorized = preview.models.find((model) => model.id === request.id);
        if (!authorized) throw new Error("This model was not authorized for the workflow");
        return authorized;
      });
    },
  };
}

export async function readLaunchPreview(root: string, id: string): Promise<LaunchPreview> {
  if (!hashPattern.test(id)) throw new Error("Invalid launch preview identity");
  const saved = await new RepositoryFiles(root).json<LaunchPreview>(
    `.basalt-evals/launch-previews/${id}.json`,
  );
  const { id: actual, ...body } = saved;
  if (id !== actual || hashJson(body) !== actual)
    throw new Error("Launch preview integrity failed");
  launchSelection(saved.selection);
  return saved;
}

async function quoteWorkflowRun(
  root: string,
  selection: LaunchSelection,
  revisionIds: string[],
  adapters: ExecutionAdapters,
) {
  const { builderModelIds, harnessIds, repetitions, capturePasses, gradingModelId } = selection;
  if (!gradingModelId) throw new Error("Select a judge model.");
  return quoteSelectionRun(
    root,
    {
      builderModelIds,
      harnessIds,
      repetitions,
      capturePasses,
      gradingModelId,
      judgeSettings: selection.judgeSettings,
      revisionIds: [...new Set(revisionIds)],
    },
    adapters,
  );
}

export async function previewEvaluationLaunch(
  root: string,
  input: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<LaunchPreview> {
  const selection = launchSelection(input);
  assertLaunchModels(selection, await readModelRegistry(root));
  // A new preview uses only registered tool sets.
  const harnesses = selectedHarnesses(await readHarnessRegistry(root), selection.harnessIds);
  const drafts = selection.sources.some((source) => source.kind === "draft");
  const preparationModelId = drafts ? selection.preparationModelId : null;
  const coverageModelId = drafts ? selection.coverageModelId : null;
  const ids = [
    ...new Set([
      ...(preparationModelId ? [preparationModelId] : []),
      ...(coverageModelId ? [coverageModelId] : []),
      ...(selection.objective === "evaluate"
        ? [...selection.builderModelIds, selection.gradingModelId!]
        : []),
    ]),
  ];
  // The catalog and the Studio identity do not depend on each other, so they run together.
  // If both fail, the catalog error comes first.
  const [catalog, identity] = await Promise.allSettled([
    adapters.catalog(
      ids.map((id) => ({
        id,
        requirement: {
          tools: true,
          allowFlex: selection.capacity === "flex",
          images:
            id === selection.gradingModelId ||
            (harnesses.some((harness) => harness.developmentRuns > 0) &&
              selection.builderModelIds.includes(id)),
          // The endpoint is pinned before the evaluations are read. One judge request can carry
          // the maximum presented frames, so the judge endpoint must accept that many images.
          ...(id === selection.gradingModelId
            ? { imagesPerRequest: MAXIMUM_PRESENTED_FRAMES }
            : {}),
        },
      })),
    ),
    adapters.studio.identity(root),
  ]);
  if (catalog.status === "rejected") throw catalog.reason;
  if (identity.status === "rejected") throw identity.reason;
  const models = catalog.value;
  const studio = identity.value;
  const bound = pinnedWorkflowAdapters({ models, studio }, adapters);
  const evaluations: LaunchPreview["evaluations"] = [];
  for (const source of selection.sources) {
    let revision =
      source.kind === "evaluation"
        ? await new EvalDefinitionStore(root).readExecutableRevision(source.id)
        : null;
    const draft = await textDraft(root, revision?.draftId ?? source.id);
    if (!revision)
      revision = await reusableDefinition(
        root,
        draft.id,
        models.find((model) => model.id === preparationModelId)!,
      );
    if (evaluations.some((item) => item.draftId === draft.id))
      throw new Error(
        "This selection contains the same evaluation more than one time. Select each evaluation only one time.",
      );
    evaluations.push({
      draftId: draft.id,
      title: draft.title,
      revisionId: revision?.id ?? null,
      preparation: revision
        ? null
        : await preparationQuote(root, draft.id, preparationModelId!, coverageModelId, bound),
    });
  }
  const run =
    evaluations.every((item) => item.revisionId) && selection.objective === "evaluate"
      ? await quoteWorkflowRun(
          root,
          selection,
          evaluations.map((item) => item.revisionId!),
          bound,
        )
      : null;
  const body = {
    title: evaluations.length === 1 ? evaluations[0]!.title : `${evaluations.length} evaluations`,
    evaluations,
    selection,
    models,
    studio,
    run,
    budget: budgetSummary(),
  };
  const preview = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/launch-previews/${preview.id}.json`,
    preview,
  );
  return preview;
}

/** Safe both at initial admission and after an interrupted stage transition. */
export async function queueWorkflowStage(
  root: string,
  workflow: EvaluationWorkflow,
  ownerToken?: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const preview = await readLaunchPreview(root, workflow.previewId);
  const next = preview.evaluations.find((item) => !workflow.revisions[item.draftId]);
  if (next) {
    if (!next.preparation)
      throw new Error("Unprepared evaluation lacks an authorized preparation quote");
    await queueAuthoringAction(
      root,
      {
        operationId: workflow.id,
        stage: "preparation",
        draftId: next.draftId,
        revisionId: null,
        quoteId: next.preparation.id,
        ceilingUsd: workflow.ceilingUsd,
      },
      ownerToken,
    );
    return true;
  }
  if (workflow.selection.objective === "prepare") {
    await updateWorkflow(root, workflow.id, {
      phase: "complete",
      state: "complete",
      blocker: null,
    });
    return false;
  }
  if (await runStartProgress(root, workflow.id)) {
    await updateWorkflow(root, workflow.id, { phase: "execution", blocker: null });
    return true;
  }
  const quote =
    preview.run ??
    (await quoteWorkflowRun(
      root,
      workflow.selection,
      preview.evaluations.map((item) => workflow.revisions[item.draftId]!),
      pinnedWorkflowAdapters(preview, adapters),
    ));
  await queueRunStart(
    root,
    { quoteId: quote.id, ceilingUsd: workflow.ceilingUsd, idempotencyKey: workflow.id },
    workflow.id,
  );
  await updateWorkflow(root, workflow.id, { phase: "execution", blocker: null });
  return true;
}

export async function queueEvaluationWorkflow(root: string, input: unknown) {
  exact(input, ["previewId", "ceilingUsd", "idempotencyKey"]);
  if (
    typeof input.previewId !== "string" ||
    typeof input.ceilingUsd !== "number" ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < 0
  )
    throw new Error("Make a preview, and set a spending limit of 0 or more.");
  const intent = launchIdentity(input.idempotencyKey);
  const preview = await readLaunchPreview(root, input.previewId);
  const id = `flow-${hashJson(intent).slice(0, 32)}`;
  await assertRunIdentityFree(root, id);
  const authorizationHash = hashJson(input);
  const prior = await workflowRecord(root, id);
  if (prior && prior.requestHash !== authorizationHash)
    throw new Error(
      "Basalt already received this start request with a different selection or spending limit. Make a new preview.",
    );
  if (prior && (prior.state !== "active" || (await authoringProgress(root, id)))) return prior;
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/eval-operations/${id}/workflow-authorizations/${authorizationHash}.json`,
    input,
  );
  const now = new Date().toISOString();
  const workflow: EvaluationWorkflow = {
    id,
    previewId: preview.id,
    title: preview.title,
    inputHash: hashJson(preview.evaluations.map((item) => item.draftId)),
    draftIds: preview.evaluations.map((item) => item.draftId),
    selection: preview.selection,
    ceilingUsd: input.ceilingUsd,
    authorizationHash,
    requestHash: authorizationHash,
    phase: preview.evaluations.some((item) => item.preparation) ? "preparation" : "execution",
    state: "active",
    blocker: null,
    revisions: Object.fromEntries(
      preview.evaluations
        .filter((item) => item.revisionId)
        .map((item) => [item.draftId, item.revisionId!]),
    ),
    createdAt: now,
    updatedAt: now,
  };
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const existing = journal.read<EvaluationWorkflow>("workflows", id);
      if (existing && existing.requestHash !== authorizationHash)
        throw new Error(
          "Basalt already received this start request with a different selection or spending limit. Make a new preview.",
        );
      if (!existing) journal.put("workflows", id, workflow);
      projectRun(journal, id);
    });
  } finally {
    journal.close();
  }
  try {
    await queueWorkflowStage(root, prior ?? workflow);
  } catch (error) {
    await updateWorkflow(root, id, {
      state: "attention",
      blocker: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return workflow;
}

/** Called only by the current process owner after a saved authoring receipt. */
export async function advanceEvaluationWorkflow(
  root: string,
  id: string,
  ownerToken: string,
  adapters: ExecutionAdapters,
): Promise<boolean> {
  const journal = await OperationJournal.open(root);
  try {
    const owner = journal.read<{ token: string; active: boolean; pid: number }>("drivers", id);
    if (!owner?.active || owner.token !== ownerToken || owner.pid !== process.pid)
      throw new Error("Only the current driver may advance a workflow");
  } finally {
    journal.close();
  }
  const workflow = await workflowRecord(root, id);
  if (!workflow || workflow.state !== "active") return false;
  const saved = await authoringActionResult(root, id);
  if (saved.stopped) {
    await updateWorkflow(root, id, { state: "stopped" });
    return false;
  }
  // Only a preparation runs under a workflow.
  const result = saved.result as {
    revisionId?: string | null;
    validation?: { status: string };
  } | null;
  if (saved.state !== "completed" || !result) {
    await updateWorkflow(root, id, {
      state: "attention",
      blocker:
        saved.error ??
        "This step of the run did not complete. Examine the saved attempt before you resume the run.",
    });
    return false;
  }
  if (!result.revisionId || result.validation?.status !== "ready") {
    await updateWorkflow(root, id, {
      state: "attention",
      blocker:
        result.validation?.status === "needs_clarification"
          ? "Edit the highlighted success criteria to continue."
          : "Basalt could not prepare this evaluation. Open its details to see the problem.",
    });
    return false;
  }
  const current = await updateWorkflow(root, id, {
    revisions: { ...workflow.revisions, [saved.action.draftId]: result.revisionId },
    blocker: null,
  });
  return queueWorkflowStage(root, current!, ownerToken, adapters);
}

async function savedBudgetAmendment(
  root: string,
  workflow: EvaluationWorkflow,
  ledger: DurableSpendLedger,
  ceilingUsd: number,
): Promise<boolean> {
  if (
    workflow.state === "complete" ||
    workflow.ceilingUsd !== ceilingUsd ||
    workflow.authorizationHash === workflow.requestHash
  )
    return false;
  const amendment = await new RepositoryFiles(root).json(
    `.basalt-evals/eval-operations/${workflow.id}/workflow-authorizations/${workflow.authorizationHash}.json`,
  );
  exact(amendment, ["operationId", "previousAuthorizationHash", "ceilingUsd"]);
  if (
    hashJson(amendment) !== workflow.authorizationHash ||
    amendment.operationId !== workflow.id ||
    typeof amendment.previousAuthorizationHash !== "string" ||
    !hashPattern.test(amendment.previousAuthorizationHash) ||
    amendment.ceilingUsd !== ceilingUsd
  )
    throw new Error("Saved budget amendment does not match this workflow");
  const spending = await ledger.read();
  await assertOperationOwnerStopped(root, workflow.id);
  return (
    spending.authorizations.at(-1)!.ceilingUsd === ceilingUsd &&
    spending.authorizations.some(
      (item) => item.quoteHash === workflow.authorizationHash && item.ceilingUsd === ceilingUsd,
    ) &&
    (await workflowRecord(root, workflow.id))?.authorizationHash === workflow.authorizationHash
  );
}

export async function increaseWorkflowBudget(root: string, id: string, input: unknown) {
  exact(input, ["ceilingUsd"]);
  const workflow = await workflowRecord(root, id);
  if (workflow?.state === "complete")
    throw new Error("This run is complete. Basalt cannot change its spending limit.");
  if (
    !workflow ||
    typeof input.ceilingUsd !== "number" ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < workflow.ceilingUsd
  )
    throw new Error("Choose a spending limit that is higher than the current limit.");
  await assertOperationOwnerStopped(root, id);
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash: workflow.inputHash }));
  if (input.ceilingUsd === workflow.ceilingUsd) {
    if (await savedBudgetAmendment(root, workflow, ledger, input.ceilingUsd)) return workflow;
    throw new Error("Choose a spending limit that is higher than the current limit.");
  }
  const assertCurrent = (journal: OperationJournal) => {
    const current = journal.read<EvaluationWorkflow>("workflows", id);
    if (
      !current ||
      current.authorizationHash !== workflow.authorizationHash ||
      current.requestHash !== workflow.requestHash ||
      current.inputHash !== workflow.inputHash ||
      current.ceilingUsd !== workflow.ceilingUsd
    )
      throw new Error("The spending limit changed while Basalt saved the new limit. Try again.");
    if (!readLifecycle(journal, id).capabilities.budget.allowed)
      throw new Error("Stop the run before you change its spending limit.");
    return current;
  };
  const amendment = {
    operationId: id,
    previousAuthorizationHash: workflow.authorizationHash,
    ceilingUsd: input.ceilingUsd,
  };
  const amendmentHash = hashJson(amendment);
  try {
    await ledger.read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (workflow.authorizationHash !== workflow.requestHash)
      throw new Error("A previously amended workflow is missing its spending ledger");
    const original = await new RepositoryFiles(root).json(
      `.basalt-evals/eval-operations/${id}/workflow-authorizations/${workflow.requestHash}.json`,
    );
    exact(original, ["previewId", "ceilingUsd", "idempotencyKey"]);
    if (
      hashJson(original) !== workflow.requestHash ||
      typeof original.previewId !== "string" ||
      original.previewId !== workflow.previewId ||
      `flow-${hashJson(launchIdentity(original.idempotencyKey)).slice(0, 32)}` !== id ||
      typeof original.ceilingUsd !== "number" ||
      !Number.isFinite(original.ceilingUsd) ||
      original.ceilingUsd < 0 ||
      original.ceilingUsd !== workflow.ceilingUsd
    )
      throw new Error("Original spending authorization does not match this workflow");
    const preview = await readLaunchPreview(root, original.previewId);
    if (
      hashJson(preview.evaluations.map((item) => item.draftId)) !== workflow.inputHash ||
      hashJson(preview.selection) !== hashJson(workflow.selection)
    )
      throw new Error("Original spending authorization belongs to different inputs");
    try {
      await ledger.initialize(
        { quoteHash: workflow.requestHash, ceilingUsd: original.ceilingUsd },
        (journal) => {
          assertCurrent(journal);
          if (
            !journal.read("spending", id) &&
            (journal.read("spending_progress", id) || journal.read("operation_progress", id))
          )
            throw new Error("Retained spending state is missing its ledger");
        },
      );
    } catch (error) {
      const current = await workflowRecord(root, id);
      if (
        current?.authorizationHash === amendmentHash &&
        (await savedBudgetAmendment(root, current, ledger, input.ceilingUsd))
      )
        return current;
      throw error;
    }
  }
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/eval-operations/${id}/workflow-authorizations/${amendmentHash}.json`,
    amendment,
  );
  try {
    await ledger.authorize(
      { quoteHash: amendmentHash, ceilingUsd: input.ceilingUsd },
      (journal) => {
        const current = assertCurrent(journal);
        journal.put("workflows", id, {
          ...current,
          ceilingUsd: input.ceilingUsd,
          authorizationHash: amendmentHash,
          updatedAt: new Date().toISOString(),
        });
        projectRun(journal, id);
      },
    );
  } catch (error) {
    const current = await workflowRecord(root, id);
    if (
      current?.authorizationHash === amendmentHash &&
      (await savedBudgetAmendment(root, current, ledger, input.ceilingUsd))
    )
      return current;
    throw error;
  }
  return workflowRecord(root, id);
}

export async function amendWorkflowInputs(root: string, id: string, input: unknown) {
  exact(input, ["previewId"]);
  if (typeof input.previewId !== "string")
    throw new Error("An input amendment needs its exact preview");
  await assertOperationOwnerStopped(root, id);
  const current = await workflowRecord(root, id);
  if (!current || current.phase === "execution" || current.phase === "complete")
    throw new Error(
      "The builds of this run already started, so Basalt cannot change its evaluations. Start a new run.",
    );
  const preview = await readLaunchPreview(root, input.previewId);
  const original = await readLaunchPreview(root, current.previewId);
  if (!preview.evaluations.some((item) => item.preparation))
    throw new Error(
      "Basalt already prepared these evaluations. Change one that still needs preparation, or start a new run with them.",
    );
  if (
    preview.evaluations.length !== original.evaluations.length ||
    hashJson({ ...preview.selection, sources: null }) !==
      hashJson({ ...original.selection, sources: null }) ||
    hashJson(preview.models.map(modelIdentityWithoutPrices)) !==
      hashJson(original.models.map(modelIdentityWithoutPrices)) ||
    hashJson(preview.studio) !== hashJson(original.studio)
  )
    throw new Error(
      "Keep the models, amount of work, Studio and number of evaluations of the approved run. Then make a new preview.",
    );
  const ledger = new DurableSpendLedger(root, id, hashJson({ inputHash: current.inputHash }));
  if ((await ledger.read()).entries.some((entry) => entry.status === "pending"))
    throw new Error(
      "A saved request has a pending charge. Select Check payment status before you change the evaluations.",
    );
  const prior = await authoringProgress(root, id);
  if (!prior || (!prior.stopped && ["queued", "running"].includes(prior.state)))
    throw new Error("Stop the run before you change its evaluations.");
  // The run continues on the code that started it. Check that code before the change is saved.
  await bindOperationImplementation(root, id, hashJson({ inputHash: current.inputHash }));
  const amendment = {
    previousAuthorizationHash: current.authorizationHash,
    previewId: preview.id,
    ceilingUsd: current.ceilingUsd,
  };
  const hash = hashJson(amendment);
  await new RepositoryFiles(root).writeJsonOnce(
    `.basalt-evals/eval-operations/${id}/workflow-authorizations/${hash}.json`,
    amendment,
  );
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const latest = journal.read<EvaluationWorkflow>("workflows", id);
      const owner = journal.read<{ active: boolean; pid: number }>("drivers", id);
      if (owner?.active && processAlive(owner.pid))
        throw new Error("Stop the run before you change its evaluations.");
      if (latest?.authorizationHash !== current.authorizationHash)
        throw new Error("The run changed while Basalt saved your changes. Try again.");
      journal.put("workflows", id, {
        ...current,
        previewId: preview.id,
        title: preview.title,
        selection: preview.selection,
        draftIds: [
          ...new Set([...current.draftIds, ...preview.evaluations.map((item) => item.draftId)]),
        ],
        authorizationHash: hash,
        phase: "preparation",
        state: "active",
        blocker: null,
        revisions: Object.fromEntries(
          preview.evaluations
            .filter((item) => item.revisionId)
            .map((item) => [item.draftId, item.revisionId!]),
        ),
        updatedAt: new Date().toISOString(),
      });
      projectRun(journal, id);
    });
  } finally {
    journal.close();
  }
  await queueWorkflowStage(root, (await workflowRecord(root, id))!);
  return workflowRecord(root, id);
}
