import { MAX_GENERATIONS } from "../../contracts/src/execution-limits.js";
import {
  qualitativeCriteria,
  scoringCriteria,
  scoringConfiguration,
  assertGradingQuote,
  scoringPresentation,
} from "../../eval-authoring/src/scoring.js";
import { readReadinessRecord } from "../../eval-authoring/src/registration.js";
import type {
  EvalRunSelection,
  RunOperationManifest,
  SavedEvalRunQuote,
} from "../../contracts/src/execution.js";
import { judgeSettings } from "../../contracts/src/judge-settings.js";
import { operationInputHash } from "./operation-binding.js";
import {
  criterionImageDimensions,
  judgmentGroups,
  requiresImages,
} from "../../eval-authoring/src/rendered-selection.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { readRegisteredSource } from "./sources.js";
import { quoteBuilderTurns } from "../../agent-runtime/src/workload.js";
import {
  pendingCriterionMaterial,
  criterionMaterialTextBound,
} from "../../eval-authoring/src/criterion-material.js";
import { batchJudgmentRequest } from "../../eval-authoring/src/batch-judgment.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import {
  gateCheckIds,
  publicEvalRevisionView,
  type EvalRevision,
} from "../../eval-authoring/src/compiler.js";
import { readPublicFeedback } from "./public-feedback.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  hashJson,
  isHarnessId,
  studioSequenceView,
  type StudyModel,
} from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { modelRoute, type ModelSnapshot } from "../../model-client/src/catalog.js";
import {
  assertRegisteredModels,
  frozenModelConcurrency,
  readModelRegistry,
} from "./model-registry.js";
import { openRouterModelClientDescriptor } from "../../model-client/src/openrouter-ai-sdk.js";
import {
  createRunQuote,
  includePriorCommittedSpend,
  type QuotedModelWork,
} from "../../model-client/src/quote.js";
import { freezeStudy } from "../../task-registry/src/index.js";
import { operatorStudyTemplate, readHarnessRegistry, selectedHarnesses } from "./config.js";
import { checkNotesPacks } from "./harness-notes.js";
import { freezeRunOperation, RunOperationStore } from "./operation.js";
import { assertCurrentBuild } from "./execution-guard.js";
import {
  cleanImplementationCommit,
  sameExecutionSource,
} from "../../artifact-store/src/implementation.js";
import { combineNativeWork, nativeLaunchWork } from "../../studio-runner/src/workload.js";
import { preparedOperationSpending } from "./prepare-controls.js";
import { manifestHash } from "./run-manifest.js";
import { assertKnownBuildGate } from "./known-build-gate.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const opaque = /^[a-z0-9][a-z0-9-]{0,80}$/u;

function assertSelection(selection: EvalRunSelection): void {
  judgeSettings(selection.judgeSettings);
  if (
    (selection.continuingOperationId !== null &&
      (typeof selection.continuingOperationId !== "string" ||
        !opaque.test(selection.continuingOperationId))) ||
    !["final", "public_development"].includes(selection.captureScope) ||
    (selection.captureScope === "public_development" &&
      (selection.gradingMode !== "none" || selection.builderModelIds.length > 0)) ||
    (selection.publicFeedbackId !== null &&
      (!hashPattern.test(selection.publicFeedbackId) || selection.parentSourceId === null)) ||
    !hashPattern.test(selection.revisionId) ||
    !hashPattern.test(selection.validationRecordHash) ||
    !Array.isArray(selection.builderModelIds) ||
    !Array.isArray(selection.sourceIds) ||
    new Set(selection.sourceIds).size !== selection.sourceIds.length ||
    selection.sourceIds.some((id) => !hashPattern.test(id)) ||
    (selection.parentSourceId !== null &&
      (!hashPattern.test(selection.parentSourceId) || selection.builderModelIds.length === 0)) ||
    selection.sourceIds.length + selection.builderModelIds.length < 1 ||
    !["all", "code", "none"].includes(selection.gradingMode) ||
    (selection.gradingMode === "none" && selection.builderModelIds.length > 0) ||
    (selection.gradingMode !== "all" && selection.gradingModelId !== null) ||
    new Set(selection.builderModelIds).size !== selection.builderModelIds.length ||
    selection.builderModelIds.some((id) => typeof id !== "string") ||
    (selection.gradingModelId !== null && typeof selection.gradingModelId !== "string") ||
    !Array.isArray(selection.harnessIds) ||
    (selection.builderModelIds.length > 0
      ? selection.harnessIds.length < 1
      : selection.harnessIds.length !== 0) ||
    new Set(selection.harnessIds).size !== selection.harnessIds.length ||
    selection.harnessIds.some((id) => !isHarnessId(id)) ||
    !Number.isSafeInteger(selection.repetitions) ||
    (selection.builderModelIds.length > 0
      ? selection.repetitions < 1
      : selection.repetitions !== 0) ||
    selection.repetitions > MAX_GENERATIONS ||
    !Number.isSafeInteger(selection.nativeCaptureRepetitions) ||
    selection.nativeCaptureRepetitions < 1 ||
    selection.nativeCaptureRepetitions > 3
  )
    throw new Error("Invalid bounded eval run selection");
}

export function evalRunSelection(value: unknown): EvalRunSelection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "builderModelIds,captureScope,continuingOperationId,gradingMode,gradingModelId,harnessIds,judgeSettings,nativeCaptureRepetitions,parentSourceId,publicFeedbackId,repetitions,revisionId,sourceIds,validationRecordHash"
  )
    throw new Error("Select a registered eval, operation, models and bounded workload");
  const selection = value as EvalRunSelection;
  assertSelection(selection);
  return selection;
}

function quoteFile(id: string): string {
  if (!hashPattern.test(id)) throw new Error("Invalid frozen run quote ID");
  return `.basalt-evals/eval-run-quotes/${id}.json`;
}

/** The criteria that a judge model checks. An evaluation without them needs no judge model. */
export function judgeCriteria(revision: Pick<EvalRevision, "privateEvaluator">) {
  return [
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
}

/** Read-only catalog lookup and immutable quote; no inference or Studio work. */
export async function quoteRegisteredEvalRun(input: {
  root: string;
  selection: EvalRunSelection;
  snapshots?: ModelSnapshot[];
  adapters?: ExecutionAdapters;
}): Promise<SavedEvalRunQuote> {
  const { selection } = input;
  assertSelection(selection);
  const root = resolve(input.root);
  // A new quote uses only models that a person added. A frozen run keeps its snapshots.
  assertRegisteredModels(await readModelRegistry(root), [
    ...selection.builderModelIds,
    ...(selection.gradingModelId ? [selection.gradingModelId] : []),
  ]);
  const files = new RepositoryFiles(root);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(selection.revisionId);
  const validationRecord = await readReadinessRecord(
    root,
    revision.id,
    selection.validationRecordHash,
  );
  if (!["ready", "controls_checked"].includes(validationRecord.validation.status))
    throw new Error(
      "The selected evaluation is not ready to run. Complete its preparation, or choose another evaluation.",
    );
  // Known builds gate new builds only. Saved builds can still be observed and checked again.
  if (selection.builderModelIds.length > 0) await assertKnownBuildGate(root, revision.id);
  for (const id of selection.sourceIds) await readRegisteredSource(root, id);
  if (selection.parentSourceId) await readRegisteredSource(root, selection.parentSourceId);
  const repairContext = selection.publicFeedbackId
    ? (
        await readPublicFeedback(
          root,
          selection.publicFeedbackId,
          selection.parentSourceId!,
          publicEvalRevisionView(revision).publicContentHash,
        )
      ).context
    : undefined;
  // Only `all` sends judge requests. A run with only code checks needs no judge model.
  const qualitative = selection.gradingMode === "all" ? judgeCriteria(revision) : [];
  if (
    revision.privateEvaluator.visual.some((criterion) => criterion.captureIds.length > 4) ||
    revision.privateEvaluator.unscaled.some((criterion) => criterion.evidence.captureIds.length > 4)
  )
    throw new Error(
      "A criterion of this evaluation uses more than four images. Edit the evaluation so that each criterion uses four images or fewer.",
    );
  const needsImages = qualitative.some(requiresImages);
  if (qualitative.length > 0 !== (selection.gradingModelId !== null))
    throw new Error(
      "The judge model choice does not match this evaluation. An evaluation with criteria for the judge needs one judge model, and an evaluation with only code checks needs none.",
    );
  const harnesses = selectedHarnesses(await readHarnessRegistry(root), selection.harnessIds);
  await checkNotesPacks({ root, harnesses, revision, freeze: false });
  const ids = [
    ...new Set([
      ...selection.builderModelIds,
      ...(selection.gradingModelId ? [selection.gradingModelId] : []),
    ]),
  ];
  const trials = selection.builderModelIds.length * harnesses.length * selection.repetitions;
  const captureViews =
    selection.captureScope === "public_development" ? revision.publicDevelopment.views.length : 1;
  const captures =
    (trials + selection.sourceIds.length) * selection.nativeCaptureRepetitions * captureViews;
  // Each judge sample is its own request and answers each of its criteria again.
  const { samples } = selection.judgeSettings;
  const gradingJudgments =
    selection.gradingMode === "none"
      ? 0
      : captures * (revision.privateEvaluator.deterministic.length + qualitative.length * samples);
  // Shared requests give each capture one request with images and one with no images. One
  // criterion per request gives each capture one request for each criterion.
  const groups = judgmentGroups(qualitative, selection.judgeSettings.grouping);
  const workFor = (snapshot: ModelSnapshot): QuotedModelWork[] => {
    const work: QuotedModelWork[] = [];
    if (selection.builderModelIds.includes(snapshot.id))
      for (const harness of harnesses) {
        const views = revision.publicDevelopment.views;
        work.push(
          ...quoteBuilderTurns({
            task: revision.publicTask,
            harness,
            snapshot,
            trials: selection.repetitions,
            ...(repairContext ? { repairContext } : {}),
            ...(revision.stage.earlierPrompts.length
              ? { earlierPrompts: revision.stage.earlierPrompts }
              : {}),
            development:
              harness.developmentRuns > 0
                ? {
                    publicScenarios: views.map((view) => view.id),
                    width: views.some((view) => !view.viewport)
                      ? null
                      : Math.max(...views.map((view) => view.viewport!.width)),
                    height: views.some((view) => !view.viewport)
                      ? null
                      : Math.max(...views.map((view) => view.viewport!.height)),
                  }
                : null,
          }),
        );
      }
    if (selection.gradingModelId === snapshot.id)
      for (const group of groups) {
        const criteria = scoringCriteria(
          revision,
          group.criteria.map((item) => item.id),
        );
        const request = batchJudgmentRequest({
          configuration: scoringConfiguration(revision, snapshot),
          criteria,
          criterionEvidence: criteria.map((criterion) => pendingCriterionMaterial(criterion.id)),
          publicTask: revision.publicTask.prompt,
          context: { actors: [], intervals: [] },
          images: [],
          observation: null,
        });
        work.push(
          quoteRequest({
            stage: "grading",
            snapshot,
            request,
            calls: captures * samples,
            futureTextBytes:
              65536 +
              Buffer.byteLength(JSON.stringify(revision.seed.project), "utf8") +
              group.criteria.reduce(
                (sum, criterion) =>
                  sum + criterionMaterialTextBound(criterion, revision.privateEvaluator.studio),
                0,
              ),
            expectedFutureTextBytes: 4096,
            imageDimensions: group.images
              ? criterionImageDimensions(group.criteria, revision.privateEvaluator)
              : [],
          }),
        );
      }
    return work;
  };
  const snapshots =
    input.snapshots ??
    (await (input.adapters ?? liveExecutionAdapters).catalog(
      ids.map((id) => ({
        id,
        requirement: {
          tools: true,
          images:
            (selection.gradingModelId === id && needsImages) ||
            (selection.builderModelIds.includes(id) &&
              (harnesses.some((harness) => harness.developmentRuns > 0) ||
                !!repairContext?.images.length)),
          quoteWorkload: (snapshot) =>
            workFor(snapshot).map((work) => ({ calls: work.calls, usage: work.upper })),
        },
      })),
    ));
  if (
    snapshots.length !== ids.length ||
    ids.some((id) => !snapshots.some((item) => item.id === id))
  )
    throw new Error("Selected model pool has incomplete endpoint metadata");
  for (const snapshot of snapshots) {
    if (!modelLimits(snapshot).supportedParameters.includes("tools"))
      throw new Error("Selected endpoints lack required tools: " + snapshot.id);
    if (
      ((selection.gradingModelId === snapshot.id && needsImages) ||
        (selection.builderModelIds.includes(snapshot.id) &&
          (harnesses.some((harness) => harness.developmentRuns > 0) ||
            !!repairContext?.images.length))) &&
      !snapshot.inputModalities.includes("image")
    )
      throw new Error("Selected endpoint lacks required image input: " + snapshot.id);
  }
  const work = snapshots.flatMap(workFor);
  let quote = createRunQuote(
    {
      independentBuilderTrials: trials,
      nativeCaptureRepetitions: selection.nativeCaptureRepetitions,
      ...combineNativeWork(
        nativeLaunchWork(
          selection.captureScope === "public_development"
            ? revision.publicDevelopment.plan
            : revision.privateEvaluator.studio,
          captures,
        ),
        nativeLaunchWork(
          revision.publicDevelopment.plan,
          selection.builderModelIds.length *
            selection.repetitions *
            harnesses.reduce((sum, harness) => sum + harness.developmentRuns, 0),
        ),
      ),
      criterionOutcomes: gradingJudgments,
      judgmentBatches: captures * groups.length * samples,
      modelWork: work,
    },
    snapshots,
    revision.id,
  );
  if (selection.continuingOperationId) {
    const prior = await preparedOperationSpending({
      root,
      operationId: selection.continuingOperationId,
      revisionId: revision.id,
      draftId: revision.draftId,
    });
    quote = includePriorCommittedSpend(
      quote,
      prior.entries.reduce(
        (sum, item) => sum + (item.status === "billed" ? item.billedUsd! : item.reservedUsd),
        0,
      ),
      prior.authorizations.at(-1)!.ceilingUsd,
    );
  }
  const body = {
    schema: "basalt-evals/saved-run-quote" as const,
    kind: "eval" as const,
    selection,
    quote,
  };
  const saved = { ...body, id: hashJson(body) };
  try {
    await files.writeJson(quoteFile(saved.id), saved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(quoteFile(saved.id))) !== hashJson(saved))
      throw new Error("Saved run quote identity changed");
  }
  return saved;
}

/** Freeze exact trials from a saved eval and selected ceiling; no paid call is made. */
export async function prepareFrozenEvalRun(input: {
  root: string;
  quoteId: string;
  operationId: string;
  ceilingUsd: number;
  /**
   * The revision of stage 1 of a staged evaluation. Only a composed run freezes a later stage: a
   * selection run with the stages before it, or a stage run that starts from saved builds.
   */
  firstRevisionId?: string;
  /** A composed operation shares one transport descriptor across all member quotes. */
  transportModels?: ModelSnapshot[];
  adapters?: ExecutionAdapters;
}): Promise<RunOperationManifest> {
  if (!opaque.test(input.operationId) || !Number.isFinite(input.ceilingUsd) || input.ceilingUsd < 0)
    throw new Error("Run operation needs an opaque ID and nonnegative USD ceiling");
  const root = resolve(input.root);
  const files = new RepositoryFiles(root);
  const saved = await files.json<SavedEvalRunQuote>(quoteFile(input.quoteId));
  const { id, ...body } = saved;
  if (
    saved.schema !== "basalt-evals/saved-run-quote" ||
    saved.kind !== "eval" ||
    id !== input.quoteId ||
    hashJson(body) !== id
  )
    throw new Error("Saved eval run quote changed");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(
    saved.selection.revisionId,
  );
  if (
    saved.selection.continuingOperationId &&
    saved.selection.continuingOperationId !== input.operationId
  )
    throw new Error(
      "This quote continues the existing operation and its aggregate spending ledger",
    );
  const validationRecord = await readReadinessRecord(
    root,
    revision.id,
    saved.selection.validationRecordHash,
  );
  const [head, identity] = await Promise.all([
    cleanImplementationCommit(root),
    (input.adapters ?? liveExecutionAdapters).studio.identity(root),
  ]);
  // A reference check stays bound to its commit; later commits that leave execution source
  // unchanged (console, tests, documentation) run as that same implementation.
  const implementationCommit =
    validationRecord.check &&
    (await sameExecutionSource(root, validationRecord.check.implementationCommit, head))
      ? validationRecord.check.implementationCommit
      : head;
  const { connectorArtifactHash, studioVersion } = identity;
  if (
    validationRecord.check !== null &&
    (validationRecord.check.implementationCommit !== implementationCommit ||
      validationRecord.check.connectorArtifactHash !== connectorArtifactHash)
  )
    throw new Error(
      "The reference test of this evaluation used a different Basalt code version or Basalt connector. Run the reference test again.",
    );
  const registry = await readHarnessRegistry(root);
  const config = operatorStudyTemplate(
    await files.json("studies/operator-config.json"),
    registry.harnesses,
    [`.basalt-evals/eval-revisions/${revision.id}`],
  );
  // The frozen treatments use the registry order. Each selected ID must still be registered.
  selectedHarnesses(registry, saved.selection.harnessIds);
  const harnesses = registry.harnesses.filter((item) =>
    saved.selection.harnessIds.includes(item.id),
  );
  await checkNotesPacks({ root, harnesses, revision, freeze: true });
  const transportModels = input.transportModels ?? saved.quote.models;
  if (
    new Set(transportModels.map((model) => model.id)).size !== transportModels.length ||
    saved.quote.models.some(
      (model) =>
        !transportModels.some(
          (item) => modelTreatmentIdentity(item) === modelTreatmentIdentity(model),
        ),
    )
  )
    throw new Error("Composed transport differs from its quoted member models");
  const routes = Object.fromEntries(transportModels.map((model) => [model.id, modelRoute(model)]));
  const ids = transportModels.map((model) => model.id);
  const models: StudyModel[] = saved.selection.builderModelIds.map((modelId) => {
    const snapshot = saved.quote.models.find((item) => item.id === modelId)!;
    // The highest price of the set bounds an estimate, because any endpoint can serve a request.
    const price = modelRoute(snapshot).maxPrice;
    return {
      id: modelId,
      responseModelId: modelId,
      transport: "openrouter-ai-sdk-core",
      revision: snapshot.revision,
      pricing: {
        currency: "USD",
        inputPerMillionTokens: price.prompt,
        outputPerMillionTokens: price.completion,
        capturedAt: snapshot.capturedAt,
      },
    };
  });
  const study = {
    ...config,
    environment: { ...config.environment, studioVersion },
    id: `eval-run-${revision.id.slice(0, 16)}`,
    models,
    harnesses,
    repetitions: saved.selection.repetitions,
    seed: Number.parseInt(revision.id.slice(0, 8), 16),
    transportConfigurationHash: hashJson(
      ids.length ? openRouterModelClientDescriptor(ids, routes) : { modelTransport: null },
    ),
  };
  const frozen = models.length
    ? await freezeStudy({
        repositoryRoot: root,
        study,
        implementationCommit,
        dirty: false,
        connectorSourceHash: identity.connectorSourceHash,
        connectorArtifactHash,
      })
    : { treatments: [] };
  const sources = await Promise.all(
    saved.selection.sourceIds.map(async (id) => {
      await readRegisteredSource(root, id);
      return {
        id: `source-${id.slice(0, 32)}`,
        evalId: revision.id,
        kind: "retained" as const,
        builder: null,
        sourceId: id,
        parentSourceId: null,
        publicFeedbackId: null,
        stageIndex: revision.stage.index,
        parentSubjectId: null,
      };
    }),
  );
  const views =
    saved.selection.captureScope === "public_development"
      ? revision.publicDevelopment.views.map((view) => ({
          id: view.id,
          partition: "development" as const,
          plan: revision.publicDevelopment.plan,
          sequence: studioSequenceView(view),
        }))
      : [
          {
            id: "default",
            partition: "withheld" as const,
            plan: revision.privateEvaluator.studio,
            sequence: revision.privateEvaluator.sequence,
          },
        ];
  const captureCells = [...frozen.treatments, ...sources].flatMap((treatment) =>
    views.flatMap((view) =>
      Array.from({ length: saved.selection.nativeCaptureRepetitions }, (_, index) => ({
        id: `capture-${hashJson([treatment.id, view.id, index + 1]).slice(0, 32)}`,
        treatmentId: treatment.id,
        viewId: view.id,
        pass: index + 1,
        partition: view.partition,
      })),
    ),
  );
  const criteria = [
    ...revision.privateEvaluator.deterministic.map((item) => ({
      id: item.id,
      method: "deterministic" as const,
    })),
    ...revision.privateEvaluator.codeQuality.map((item) => ({
      id: item.id,
      method: "code" as const,
    })),
    ...revision.privateEvaluator.visual.map((item) => ({ id: item.id, method: "visual" as const })),
    ...revision.privateEvaluator.unscaled.map((item) => ({
      id: item.id,
      method: "unscaled" as const,
    })),
  ];
  const scoredCriterionIds = qualitativeCriteria(revision).map((item) => item.id);
  const { grouping, samples } = saved.selection.judgeSettings;
  const groups = judgmentGroups(qualitativeCriteria(revision), grouping);
  const gradingCells =
    saved.selection.gradingMode === "none"
      ? []
      : captureCells.flatMap((capture) =>
          criteria
            .filter((criterion) => !scoredCriterionIds.includes(criterion.id))
            .map((criterion) => ({
              id: `grade-${capture.id}-${criterion.id}`,
              captureCellId: capture.id,
              criterionId: criterion.id,
              method: "deterministic" as const,
            })),
        );
  const gradingConfiguration =
    saved.selection.gradingMode !== "all" || !scoredCriterionIds.length
      ? null
      : scoringConfiguration(
          revision,
          saved.quote.models.find((model) => model.id === saved.selection.gradingModelId)!,
        );
  if (gradingConfiguration)
    assertGradingQuote(gradingConfiguration, saved.quote.workload.modelWork);
  const firstRevisionId = input.firstRevisionId ?? revision.id;
  if ((revision.stage.index === 1) !== (firstRevisionId === revision.id))
    throw new Error("A later stage of an evaluation runs only in a run that names its stage 1");
  return freezeRunOperation({
    buildIdentityHash: await assertCurrentBuild(root),
    operationId: input.operationId,
    inputHash: await operationInputHash(root, input.operationId, revision.draftId),
    revision,
    validationRecord,
    quote: saved.quote,
    quoteSelectionId: saved.id,
    implementationCommit,
    connectorArtifactHash,
    selectedModelIds: saved.quote.models.map((model) => model.id),
    selectedHarnessIds: saved.selection.harnessIds,
    modelConcurrency: await frozenModelConcurrency(root, saved.quote.models),
    treatments: frozen.treatments,
    retainedSources: sources,
    views,
    stage: {
      firstRevisionId,
      index: revision.stage.index,
      count: revision.stage.count,
      earlierPrompts: [...revision.stage.earlierPrompts],
      gateCriterionIds: gateCheckIds(revision),
    },
    publicFeedbackId: saved.selection.publicFeedbackId,
    parentSourceId: saved.selection.parentSourceId,
    gradingMode: saved.selection.gradingMode,
    captureCells,
    gradingCells,
    judgmentBatches: !gradingConfiguration
      ? []
      : captureCells.flatMap((capture) =>
          groups.flatMap((group) => {
            // Each sample is its own batch. Its stage judgment:<id> gives it its own ledger
            // request, and the samples of a group send identical bytes.
            const criterionIds = group.criteria.map((item) => item.id);
            const sampleGroupId = `samples-${hashJson([criterionIds, capture.id]).slice(0, 24)}`;
            return Array.from({ length: samples }, (_, index) => ({
              id: `judgment-${hashJson([criterionIds, capture.id, index + 1]).slice(0, 24)}`,
              captureCellId: capture.id,
              revisionId: revision.id,
              sampleGroupId,
              sample: index + 1,
              grouping,
              criterionIds,
              presentation: scoringPresentation(revision),
              substitution: null,
              configuration: gradingConfiguration,
            }));
          }),
        ),
    ceilingUsd: input.ceilingUsd,
  });
}

export async function freezeRegisteredEvalRun(input: Parameters<typeof prepareFrozenEvalRun>[0]) {
  const manifest = await prepareFrozenEvalRun(input);
  await new RunOperationStore(
    input.root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  ).create(manifest);
  return manifest;
}
