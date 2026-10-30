import { ensureStudioReadiness } from "./studio-readiness.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { createLibraryEvaluation } from "../../eval-authoring/src/library.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { ownedComputation } from "./owned-computation.js";
import { registerReadyEvaluation } from "../../eval-authoring/src/registration.js";
import { operationInputHash, preparationPath, authorizePreparation } from "./operation-binding.js";
import { coverageModelWork, preparationModelWork } from "../../eval-authoring/src/quote.js";
import { prepareCoverageNotes } from "./coverage-notes.js";
import { prepareEmptyBuildCheck } from "./empty-build-check.js";
import { prepareKnownBuildGate } from "./known-builds.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import {
  readPublicPreparation,
  savePublicPreparation,
  type PublicPreparationContext,
} from "./public-preparation.js";
import {
  prepareEvalDraft,
  publicPreparationErrors,
} from "../../agent-runtime/src/eval-preparation.js";
import {
  basePublicPreparation,
  canBeBase,
  type PreparationBase,
} from "../../eval-authoring/src/preparation-base.js";
import type { EvalDraft } from "../../eval-authoring/src/input.js";
import type { PublicPreparation } from "../../eval-authoring/src/proposals.js";
import type { EvaluationSummary } from "../../contracts/src/catalog.js";
import {
  modelPreparationRoles,
  PreparationDispatcher,
} from "../../agent-runtime/src/preparation-models.js";
import { readFile } from "node:fs/promises";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { assertCurrentBuild, bindOperationImplementation } from "./execution-guard.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { recordExecutionFailure } from "../../artifact-store/src/failures.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { hashJson, stableJson } from "../../contracts/src/index.js";
import {
  createEvalDraft,
  EvalDefinitionStore,
  quotePreparation,
  stageEvalRevision,
} from "../../eval-authoring/src/index.js";
import { type ModelSnapshot } from "../../model-client/src/catalog.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { assertRegisteredModels, readModelRegistry } from "./model-registry.js";
import type { RunQuote } from "../../model-client/src/quote.js";

const idPattern = /^[a-f0-9]{64}$/u;
const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;

const store = (root: string) => new EvalDefinitionStore(root);
const files = (root: string) => new RepositoryFiles(root);

export async function createTextDraft(root: string, input: unknown) {
  const draft = createEvalDraft(input);
  await store(root).writeDraft(draft);
  await createLibraryEvaluation(root, draft.id);
  return draft;
}

export async function textDraft(root: string, id: string) {
  if (!idPattern.test(id)) throw new Error("Invalid eval draft ID");
  return store(root).readDraft(id);
}

/**
 * The most recently registered evaluation with the title and the stage prompts of the draft. A
 * new preparation keeps its tests where they still fit. Basalt skips a registered evaluation that
 * it cannot read.
 */
export async function preparationBase(
  root: string,
  draft: EvalDraft,
): Promise<PreparationBase | null> {
  const journal = await OperationJournal.open(root);
  let rows: EvaluationSummary[];
  try {
    rows = journal.list<EvaluationSummary>("catalog_evaluations");
  } finally {
    journal.close();
  }
  const registered = rows
    .filter(
      (row) =>
        row.kind === "evaluation" &&
        (row.readiness === "ready" || row.readiness === "checked") &&
        row.stages === draft.stages.length,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const row of registered)
    try {
      const baseDraft = await store(root).readDraft(row.draftId);
      if (!canBeBase(baseDraft, draft)) continue;
      return { draft: baseDraft, revisions: await store(root).readStageRevisions(row.id, true) };
    } catch {
      continue;
    }
  return null;
}

/** The public preparation of the base when it passes the current public checks. */
function basePublicPart(base: PreparationBase | null, draft: EvalDraft): PublicPreparation | null {
  const preparation = base ? basePublicPreparation(base) : null;
  return preparation && !publicPreparationErrors(preparation, draft).length ? preparation : null;
}

/**
 * The key of a saved public preparation and of a saved compilation: the stage prompts, the
 * build and the preparation model.
 */
export async function publicPreparationContext(
  root: string,
  draft: EvalDraft,
  model: ModelSnapshot,
): Promise<PublicPreparationContext> {
  return {
    stagePrompts: draft.stages.map((stage) => stage.prompt),
    title: draft.title,
    slug: draft.slug,
    buildIdentityHash: await assertCurrentBuild(root),
    preparationIdentityHash: hashJson([modelTreatmentIdentity(model)]),
  };
}

/** Exact authored inputs and compiler/model identity, independent of evaluated builders. */
export async function reusableDefinition(
  root: string,
  draftId: string,
  model: ModelSnapshot,
): Promise<EvalRevision | null> {
  const draft = await textDraft(root, draftId);
  const publicContext = await publicPreparationContext(root, draft, model);
  const journal = await OperationJournal.open(root);
  try {
    const cached = journal.read<{ state: string; value: { revision: EvalRevision | null } }>(
      "evaluation_compilations",
      hashJson({ draftId, publicContext }),
    );
    if (cached?.state !== "complete" || !cached.value.revision) return null;
    const registered = journal.read("catalog_evaluations", cached.value.revision.id);
    return registered ? cached.value.revision : null;
  } finally {
    journal.close();
  }
}

export async function preparationQuote(
  root: string,
  draftId: string,
  preparationModelId: string,
  coverageModelId: string | null,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<RunQuote> {
  const draft = await textDraft(root, draftId);
  assertRegisteredModels(await readModelRegistry(root), [
    preparationModelId,
    ...(coverageModelId ? [coverageModelId] : []),
  ]);
  const work = (id: string, snapshot: ModelSnapshot) => [
    ...(id === preparationModelId ? preparationModelWork(draft, snapshot) : []),
    ...(id === coverageModelId ? coverageModelWork(draft, snapshot) : []),
  ];
  const snapshots = await adapters.catalog(
    [...new Set([preparationModelId, ...(coverageModelId ? [coverageModelId] : [])])].map((id) => ({
      id,
      requirement: {
        tools: true,
        quoteWorkload: (snapshot: ModelSnapshot) =>
          work(id, snapshot).map((item) => ({ calls: item.calls, usage: item.upper })),
      },
    })),
  );
  const planner = snapshots.find((model) => model.id === preparationModelId)!;
  const publicContext = await publicPreparationContext(root, draft, planner);
  const base = await preparationBase(root, draft);
  const quote = quotePreparation(
    draft,
    planner,
    coverageModelId ? snapshots.find((model) => model.id === coverageModelId)! : null,
    basePublicPart(base, draft) !== null ||
      (await readPublicPreparation(root, publicContext)) !== null,
    base !== null,
  );
  const file = ".basalt-evals/eval-quotes/" + quote.id + ".json";
  try {
    await files(root).writeJson(file, quote);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await files(root).json<RunQuote>(file);
    if (hashJson(existing) !== hashJson(quote)) throw new Error("Quote identity collision");
  }
  return quote;
}

async function readQuote(root: string, id: string): Promise<RunQuote> {
  if (!idPattern.test(id)) throw new Error("Invalid quote ID");
  const quote = await files(root).json<RunQuote>(".basalt-evals/eval-quotes/" + id + ".json");
  const { id: storedId, ...body } = quote;
  if (storedId !== id || hashJson(body) !== id) throw new Error("Quote content changed");
  return quote;
}

export async function prepareTextDraft(input: {
  root: string;
  draftId: string;
  quoteId: string;
  operationId: string;
  ceilingUsd: number;
  signal?: AbortSignal;
  adapters?: ExecutionAdapters;
}) {
  if (
    !idPattern.test(input.draftId) ||
    !idPattern.test(input.quoteId) ||
    !operationPattern.test(input.operationId) ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < 0
  )
    throw new Error("Invalid preparation operation");
  const [draft, quote] = await Promise.all([
    textDraft(input.root, input.draftId),
    readQuote(input.root, input.quoteId),
  ]);
  if (quote.subjectId !== draft.id) throw new Error("The quote belongs to a different eval draft");
  // The quote froze its models. A later change to the registry does not change them.
  const frozen = (stage: string) =>
    quote.models.find(
      (model) =>
        model.id === quote.workload.modelWork.find((work) => work.stage === stage)?.modelId,
    ) ?? null;
  const planner = frozen("preparation");
  const coverageModel = frozen("coverage");
  // The quote of a base also covers the correction of the carried criteria of each stage.
  const base = await preparationBase(input.root, draft);
  // A quote without the public part used a saved public preparation.
  const reused = [true, false].find(
    (publicReused) =>
      planner &&
      hashJson(
        quotePreparation(draft, planner, coverageModel, publicReused, base !== null).workload,
      ) === hashJson(quote.workload),
  );
  const expected =
    planner && reused !== undefined
      ? quotePreparation(draft, planner, coverageModel, reused, base !== null)
      : null;
  if (!planner || !expected || hashJson(quote.models) !== hashJson(expected.models))
    throw new Error(
      "The preview no longer matches the saved evaluations or the models. Make a new preview.",
    );
  const fresh = quote.models;
  const inputHash = hashJson({
    inputHash: await operationInputHash(input.root, input.operationId, draft.id),
  });
  const ledger = new DurableSpendLedger(input.root, input.operationId, inputHash);
  await authorizePreparation(input.root, ledger, {
    quoteHash: hashJson(quote),
    ceilingUsd: input.ceilingUsd,
  });
  await files(input.root).directory(
    `.basalt-evals/eval-operations/${input.operationId}/preparations/${draft.id}`,
  );
  const resultFile = resolve(input.root, preparationPath(input.operationId, draft.id));
  try {
    return JSON.parse(await readFile(resultFile, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensureStudioReadiness({
    root: input.root,
    operationId: input.operationId,
    studio: (input.adapters ?? liveExecutionAdapters).studio,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const client = (input.adapters ?? liveExecutionAdapters).model(fresh);
  const guard = await bindOperationImplementation(input.root, input.operationId, inputHash);
  const publicContext = await publicPreparationContext(input.root, draft, planner);
  // The public part of the base keeps the public content of the base, so a recheck can keep
  // its builds. Otherwise a saved public preparation of these prompts is used.
  const publicPreparation = {
    proposal:
      basePublicPart(base, draft) ?? (await readPublicPreparation(input.root, publicContext)),
    accepted: (proposal: Parameters<typeof savePublicPreparation>[2]) =>
      savePublicPreparation(input.root, publicContext, proposal, "model"),
  };
  if (reused && !publicPreparation.proposal)
    throw new Error(
      "The saved preparation that the preview used is not available. Make a new preview.",
    );
  let compiledRevisionId: string | null = null;
  try {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const dispatcher = new PreparationDispatcher(client, ledger, fresh, guard, signal, draft.id);
    const roles = modelPreparationRoles({
      dispatcher,
      publicModel: { id: planner.id, maxOutputTokens: modelLimits(planner).maxOutputTokens },
      privateModel: { id: planner.id, maxOutputTokens: modelLimits(planner).maxOutputTokens },
      seed: Number.parseInt(draft.id.slice(0, 8), 16),
    });
    const prepared = await ownedComputation({
      root: input.root,
      operationId: input.operationId,
      namespace: "evaluation_compilations",
      key: hashJson({ draftId: draft.id, publicContext }),
      signal,
      run: () =>
        prepareEvalDraft(
          draft,
          roles,
          async (compiled) => {
            signal.throwIfAborted();
            await guard();
            const body = {
              schema: "basalt-evals/compiled-proposal",
              operationId: input.operationId,
              quoteId: quote.id,
              revision: compiled.revision,
              validation: compiled.validation,
            };
            const path = `.basalt-evals/eval-operations/${input.operationId}/compiled/${compiled.revision.id}.json`;
            try {
              await files(input.root).writeJson(path, body);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              if (hashJson(await files(input.root).json(path)) !== hashJson(body))
                throw new Error("Retained compiled proposal changed");
            }
            const attemptReceipt = {
              schema: "basalt-evals/compiled-attempt",
              operationId: input.operationId,
              quoteId: quote.id,
              revisionId: compiled.revision.id,
              attempt: compiled.attempt,
              normalizations: compiled.normalizations,
            };
            const attemptPath = `.basalt-evals/eval-operations/${input.operationId}/compiled-attempts/${hashJson(attemptReceipt)}.json`;
            try {
              await files(input.root).writeJson(attemptPath, attemptReceipt);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              if (hashJson(await files(input.root).json(attemptPath)) !== hashJson(attemptReceipt))
                throw new Error("Retained compiled attempt changed");
            }
            compiledRevisionId = compiled.revision.id;
          },
          publicPreparation,
          base,
        ),
    });
    signal.throwIfAborted();
    await guard();
    // Each stage revision names the next one, so the last stage is written first.
    for (const revision of [...prepared.revisions].reverse())
      await store(input.root).writeRevision(revision);
    const first = prepared.revisions[0] ?? null;
    // The notes and the empty build never block the evaluation, so registration does not wait
    // for them. The empty build observes the staged evaluation, so it starts after the stage step.
    const registering = (async () => ({
      registered: first ? await registerReadyEvaluation(input.root, first.id, signal) : null,
      staged: first ? await stageEvalRevision(input.root, first.id, signal) : null,
    }))();
    const coverageDispatcher = (revisionId: string) =>
      new PreparationDispatcher(client, ledger, fresh, guard, signal, revisionId);
    // A check of the evaluation starts after its registration, from the revision of stage 1.
    const afterRegistration = <T>(check: (stage: EvalRevision) => Promise<T>) =>
      first ? registering.then(() => check(first)) : Promise.resolve(null);
    const [registration, coverage, emptyBuild, knownBuilds] = await Promise.allSettled([
      registering,
      // Each stage gets its own coverage notes.
      Promise.all(
        prepared.revisions.map((revision) =>
          coverageModel
            ? prepareCoverageNotes({
                root: input.root,
                operationId: input.operationId,
                revision,
                model: coverageModel,
                dispatcher: coverageDispatcher(revision.id),
                signal,
              })
            : Promise.resolve(null),
        ),
      ),
      // Only stage 1 starts from the seed. A later stage starts from the build of the stage
      // before it, so the empty build does not apply to it.
      afterRegistration((stage) =>
        prepareEmptyBuildCheck({
          root: input.root,
          operationId: input.operationId,
          revisionId: stage.id,
          studio: (input.adapters ?? liveExecutionAdapters).studio,
          signal,
          beforeObservation: guard,
        }),
      ),
      // The known builds of each stage gate a new benchmark of the evaluation. A saved build
      // pairs with the revision of its own stage.
      afterRegistration((stage) =>
        prepareKnownBuildGate({
          root: input.root,
          operationId: input.operationId,
          revisionId: stage.id,
          draftId: draft.id,
          studio: (input.adapters ?? liveExecutionAdapters).studio,
          signal,
          beforeObservation: guard,
        }),
      ),
    ]);
    if (registration.status === "rejected") throw registration.reason;
    if (coverage.status === "rejected") throw coverage.reason;
    if (emptyBuild.status === "rejected") throw emptyBuild.reason;
    if (knownBuilds.status === "rejected") throw knownBuilds.reason;
    const { registered, staged } = registration.value;
    const receipt = {
      schema: "basalt-evals/preparation-receipt",
      operationId: input.operationId,
      draftId: draft.id,
      quoteId: quote.id,
      ceilingUsd: input.ceilingUsd,
      compiledRevisionId,
      revisionId: first?.id ?? null,
      validationRecordHash: registered?.validationRecordHash ?? null,
      stagedTaskId: staged?.taskId ?? null,
      stages: prepared.revisions.map((revision, index) => {
        const notes = coverage.value[index];
        return {
          revisionId: revision.id,
          coverage: notes ? { modelId: notes.model.id, state: notes.state } : null,
          emptyBuild:
            index === 0
              ? emptyBuild.value
                ? { state: emptyBuild.value.state, hollow: emptyBuild.value.hollow }
                : null
              : {
                  state: "not_applicable" as const,
                  reason: "The stage starts from the build of the earlier stage.",
                },
        };
      }),
      knownBuilds: knownBuilds.value
        ? knownBuilds.value.results.map(({ knownBuildId, authoredCriterionId, status }) => ({
            knownBuildId,
            authoredCriterionId,
            status,
          }))
        : null,
      validation: prepared.validation,
      attempts: prepared.attempts,
      normalizations: prepared.normalizations,
      reuse: prepared.reuse,
      spending: await ledger.read(),
    };
    signal.throwIfAborted();
    await publishImmutable(resultFile, stableJson(receipt) + "\n");
    return receipt;
  } catch (error) {
    if (error instanceof ExecutionFault)
      await recordExecutionFailure(input.root, input.operationId, error.failure);
    const interrupted = {
      schema: "basalt-evals/preparation-interruption",
      operationId: input.operationId,
      draftId: draft.id,
      quoteId: quote.id,
      ceilingUsd: input.ceilingUsd,
      compiledRevisionId,
      error: error instanceof Error ? error.message : String(error),
      spending: await ledger.read(),
    };
    // Interrupted attempts are retained separately. Recovery may consume completed receipts
    // and continue distinct, unattempted actions; it must not replay uncertain paid requests.
    const interruptedFile = resolve(
      ledger.directory,
      `preparation-interrupted-${hashJson(interrupted)}.json`,
    );
    try {
      await publishImmutable(interruptedFile, stableJson(interrupted) + "\n");
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
    return interrupted;
  }
}
