import { workloadCeiling, checkingCeiling } from "../../model-client/src/quote.js";
import type {
  EvalRunSelection,
  RunOperationManifest,
  RunSubject,
  SavedExperimentRunQuote,
} from "../../contracts/src/execution.js";
import { sequenceImageDimensions } from "../../eval-authoring/src/rendered-selection.js";
import {
  gradingConfiguration,
  assertGradingQuote,
  scoringCriteria,
} from "../../eval-authoring/src/scoring.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson, type Treatment } from "../../contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { publicEvalRevisionView } from "../../eval-authoring/src/compiler.js";
import { quoteBuilderTurns } from "../../agent-runtime/src/workload.js";
import {
  pendingCriterionMaterial,
  criterionMaterialTextBound,
} from "../../eval-authoring/src/criterion-material.js";
import { readPublicFeedback } from "./public-feedback.js";
import { readHarnessRegistry, selectedHarnesses } from "./config.js";
import { verifyExperimentAuthority } from "./experiment-authority.js";
import {
  batchJudgmentRequest,
  MAX_OBSERVATION_JSON_BYTES,
  observationRequest,
  type BatchFrameContext,
} from "../../eval-authoring/src/batch-judgment.js";
import { createRunQuote, type QuotedModelWork } from "../../model-client/src/quote.js";
import { quoteRequest } from "../../model-client/src/quoted-request.js";
import { type ModelSnapshot } from "../../model-client/src/catalog.js";
import { combineNativeWork, nativeLaunchWork } from "../../studio-runner/src/workload.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import { judgeCriteria, prepareFrozenEvalRun, quoteRegisteredEvalRun } from "./run-plan.js";
import { RunOperationStore } from "./operation.js";
import { assertManifest, manifestHash } from "./run-manifest.js";
import { frozenModelConcurrency } from "./model-registry.js";

export async function quoteRegisteredExperiment(input: {
  root: string;
  experimentId: string;
  gradingModelId: string;
  adapters?: ExecutionAdapters;
}) {
  const registered = await readRegisteredExperiment(input.root, input.experimentId),
    plan = registered.plan;
  await verifyExperimentAuthority(input.root, registered);
  const adapters = input.adapters ?? liveExecutionAdapters;
  const ids = [
    ...new Set([...plan.builders.map((builder) => builder.modelId), input.gradingModelId]),
  ];
  const factories: Array<{
    modelId: string;
    create: (snapshot: ModelSnapshot) => QuotedModelWork[];
  }> = [];
  const componentSelections: EvalRunSelection[] = [];
  const native = [];
  const criterionCounts = new Map<string, number>();
  const requiredCounts = new Map<string, number>();
  const registry = await readHarnessRegistry(input.root);
  const harnessOf = (id: string) => selectedHarnesses(registry, [id])[0]!;
  for (const evaluation of registered.evaluations) {
    const revision = await new EvalDefinitionStore(input.root).readExecutableRevision(
      evaluation.id,
    );
    const builders = plan.builders.filter((builder) => builder.evalId === evaluation.id);
    requiredCounts.set(
      evaluation.id,
      [
        ...revision.privateEvaluator.deterministic,
        ...revision.privateEvaluator.visual,
        ...revision.privateEvaluator.codeQuality,
        ...revision.privateEvaluator.unscaled,
      ].filter((criterion) => criterion.required).length,
    );
    criterionCounts.set(
      evaluation.id,
      revision.privateEvaluator.deterministic.length +
        revision.privateEvaluator.visual.length +
        revision.privateEvaluator.codeQuality.length +
        revision.privateEvaluator.unscaled.length,
    );
    const sources = [
      ...new Set(
        plan.sources
          .filter((source) => source.evalId === evaluation.id)
          .map((source) => registered.sourceBindings[source.id]!),
      ),
    ];
    const models = [...new Set(builders.map((builder) => builder.modelId))];
    const harnesses = [...new Set(builders.map((builder) => builder.harness))];
    const graderNeeded = judgeCriteria(revision).length > 0;
    componentSelections.push({
      captureScope: "final",
      publicFeedbackId: null,
      sourceIds: sources,
      parentSourceId: null,
      continuingOperationId: null,
      gradingMode: "all",
      revisionId: evaluation.id,
      validationRecordHash: evaluation.validationRecordHash,
      builderModelIds: models,
      gradingModelId: graderNeeded ? input.gradingModelId : null,
      judgeSettings: DEFAULT_JUDGE_SETTINGS,
      harnessIds: harnesses,
      repetitions: builders.length ? Math.max(...builders.map((builder) => builder.repetition)) : 0,
      nativeCaptureRepetitions: 3,
    });
    for (const builder of builders) {
      const harness = harnessOf(builder.harness);
      if (
        harness.maxTurns !== builder.bounds.turns ||
        harness.developmentRuns !== builder.bounds.developmentRuns
      )
        throw new Error("Protocol builder bounds differ from the executable harness");
      const feedbackId =
        builder.assistance === "public_observations"
          ? registered.publicFeedbackBindings[builder.parentSourceId!]!
          : null;
      const repairContext = feedbackId
        ? (
            await readPublicFeedback(
              input.root,
              feedbackId,
              registered.sourceBindings[builder.parentSourceId!]!,
              publicEvalRevisionView(revision).publicContentHash,
            )
          ).context
        : undefined;
      const views = revision.publicDevelopment.views;
      factories.push({
        modelId: builder.modelId,
        create: (snapshot) =>
          quoteBuilderTurns({
            task: revision.publicTask,
            harness,
            snapshot,
            trials: 1,
            ...(repairContext ? { repairContext } : {}),
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
      });
    }
    native.push(
      nativeLaunchWork(
        revision.publicDevelopment.plan,
        builders.reduce((sum, builder) => sum + builder.bounds.developmentRuns, 0),
      ),
    );
    for (const view of evaluation.views) {
      const captures = plan.captures.filter(
        (capture) => capture.evalId === evaluation.id && capture.viewId === view.id,
      );
      native.push(nativeLaunchWork(view.plan, captures.length));
      const executableCriteria = [
        ...revision.privateEvaluator.deterministic,
        ...revision.privateEvaluator.visual,
        ...revision.privateEvaluator.codeQuality,
        ...revision.privateEvaluator.unscaled,
      ];
      const criteria = scoringCriteria(
        revision,
        executableCriteria.map((criterion) => criterion.id),
      );
      for (const presentation of ["still", "sequence", "grounded-sequence"] as const) {
        const units = plan.judgments.filter(
          (unit) =>
            unit.presentation === presentation &&
            captures.some((capture) => capture.id === unit.captureId),
        );
        if (!units.length) continue;
        if (presentation !== "still" && !view.sequence)
          throw new Error("Sequence treatment requires a registered sequence view");
        const context: BatchFrameContext = { actors: [], intervals: [] };
        const dimensions = view.sequence
          ? sequenceImageDimensions(view.sequence, view.plan, presentation)
          : view.plan.phases.flatMap((phase) =>
              phase.captures.map(() => ({ width: null, height: null })),
            );
        if (presentation === "grounded-sequence")
          factories.push({
            modelId: input.gradingModelId,
            create: (snapshot) => [
              quoteRequest({
                stage: "grading",
                snapshot,
                // The frame IDs bound the longest observation answer before acquisition.
                request: observationRequest(
                  gradingConfiguration(snapshot, 0),
                  {
                    ...context,
                    intervals: dimensions.map((_, index) => ({
                      frameId: `frame-${index + 1}`,
                      actor: "",
                      startMs: 0,
                      endMs: 0,
                    })),
                  },
                  [],
                ),
                calls: units.length,
                futureTextBytes: 65536,
                expectedFutureTextBytes: 4096,
                imageDimensions: dimensions,
              }),
            ],
          });
        factories.push({
          modelId: input.gradingModelId,
          create: (snapshot) => [
            quoteRequest({
              stage: "grading",
              snapshot,
              request: batchJudgmentRequest({
                configuration: gradingConfiguration(snapshot, 0),
                criteria,
                criterionEvidence: criteria.map((criterion) =>
                  pendingCriterionMaterial(criterion.id),
                ),
                publicTask: revision.publicTask.prompt,
                context,
                images: [],
                observation:
                  presentation === "grounded-sequence"
                    ? { observations: [], limitations: [] }
                    : null,
              }),
              calls: units.length,
              futureTextBytes:
                65536 +
                Buffer.byteLength(JSON.stringify(revision.seed.project), "utf8") +
                executableCriteria.reduce(
                  (sum, criterion) =>
                    sum + criterionMaterialTextBound(criterion, revision.privateEvaluator.studio),
                  0,
                ) +
                (presentation === "grounded-sequence" ? MAX_OBSERVATION_JSON_BYTES : 0),
              expectedFutureTextBytes: 4096,
              imageDimensions: presentation === "grounded-sequence" ? [] : dimensions,
            }),
          ],
        });
      }
    }
  }
  const workFor = (snapshot: ModelSnapshot) =>
    factories
      .filter((factory) => factory.modelId === snapshot.id)
      .flatMap((factory) => factory.create(snapshot));
  const snapshots = await adapters.catalog(
    ids.map((id) => ({
      id,
      requirement: {
        tools: true,
        images:
          id === input.gradingModelId ||
          plan.builders.some(
            (builder) => builder.modelId === id && harnessOf(builder.harness).developmentRuns > 0,
          ),
        quoteWorkload: (snapshot) =>
          workFor(snapshot).map((work) => ({ calls: work.calls, usage: work.upper })),
      },
    })),
  );
  const work = snapshots.flatMap(workFor),
    components: string[] = [];
  for (const selection of componentSelections) {
    const ids = [
      ...selection.builderModelIds,
      ...(selection.gradingModelId ? [selection.gradingModelId] : []),
    ];
    components.push(
      (
        await quoteRegisteredEvalRun({
          root: input.root,
          selection,
          snapshots: snapshots.filter((model) => ids.includes(model.id)),
        })
      ).id,
    );
  }
  const criterionCount = plan.judgments.map((unit) =>
    criterionCounts.get(plan.captures.find((capture) => capture.id === unit.captureId)!.evalId)!,
  );
  const quote = createRunQuote(
    {
      independentBuilderTrials: plan.builders.length,
      nativeCaptureRepetitions: 3,
      ...combineNativeWork(...native),
      criterionOutcomes: criterionCount.reduce((sum, count) => sum + count, 0),
      judgmentBatches: plan.judgments.length,
      modelWork: work,
    },
    snapshots,
    registered.id,
  );
  const body = {
    schema: "basalt-evals/saved-run-quote" as const,
    kind: "experiment" as const,
    selection: {
      experimentId: registered.id,
      gradingModelId: input.gradingModelId,
      componentQuoteIds: components,
    },
    quote,
    humanWorkload: {
      questions: plan.reviewGroups.reduce(
        (total, group) =>
          total +
          group.captureIds.reduce(
            (count, id) =>
              count +
              (requiredCounts.get(plan.captures.find((capture) => capture.id === id)!.evalId) ?? 0),
            0,
          ),
        0,
      ),
      unit: "criterion_per_capture" as const,
      automaticAssignment: "registered_protocol" as const,
    },
  };
  const saved: SavedExperimentRunQuote = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(input.root),
    path = `.basalt-evals/eval-run-quotes/${saved.id}.json`;
  try {
    await files.writeJson(path, saved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return saved;
}

export async function freezeRegisteredExperiment(input: {
  root: string;
  operationId: string;
  quoteId: string;
  ceilingUsd: number;
  adapters?: ExecutionAdapters;
}) {
  const files = new RepositoryFiles(input.root);
  const saved = await files.json<SavedExperimentRunQuote>(
    `.basalt-evals/eval-run-quotes/${input.quoteId}.json`,
  );
  const { id, ...body } = saved;
  if (id !== input.quoteId || hashJson(body) !== id || saved.kind !== "experiment")
    throw new Error("Experiment quote changed");
  const registered = await readRegisteredExperiment(input.root, saved.selection.experimentId),
    plan = registered.plan;
  if (plan.judgments.length)
    assertGradingQuote(
      gradingConfiguration(
        saved.quote.models.find((model) => model.id === saved.selection.gradingModelId)!,
        0,
      ),
      saved.quote.workload.modelWork,
    );
  await verifyExperimentAuthority(input.root, registered);
  const adapters = input.adapters ?? liveExecutionAdapters;
  const components: RunOperationManifest[] = [];
  for (const quoteId of saved.selection.componentQuoteIds)
    components.push(await prepareFrozenEvalRun({ ...input, quoteId, adapters }));
  const base = components[0]!;
  const evals = registered.evaluations.map((evaluation) => ({
    ...components.find((component) => component.evals[0]!.id === evaluation.id)!.evals[0]!,
    views: evaluation.views,
  }));
  const subjects: RunSubject[] = [],
    bindings: Record<string, string> = {};
  for (const source of plan.sources) {
    bindings[source.id] = source.id;
    subjects.push({
      id: source.id,
      evalId: source.evalId,
      kind: source.kind === "generated" ? "retained" : "control",
      sourceId: registered.sourceBindings[source.id]!,
      builder: null,
      parentSourceId: null,
      publicFeedbackId: null,
      stageIndex: 1,
      parentSubjectId: null,
    });
  }
  for (const [index, unit] of plan.builders.entries()) {
    const original = components
      .flatMap((component) => component.subjects)
      .find(
        (subject) =>
          subject.evalId === unit.evalId &&
          subject.builder?.model.id === unit.modelId &&
          subject.builder.harness.id === unit.harness &&
          subject.builder.repetition === unit.repetition,
      )?.builder;
    if (!original) throw new Error("Protocol builder has no quoted harness treatment");
    const treatmentBody = {
      ordinal: index + 1,
      studyHash: plan.id,
      task: original.task,
      model: original.model,
      transportConfigurationHash: original.transportConfigurationHash,
      harness: original.harness,
      repetition: unit.repetition,
      randomSeed: unit.seed,
      environment: original.environment,
    };
    const treatment: Treatment = {
      schema: original.schema,
      id: `tr-${hashJson(treatmentBody).slice(0, 20)}`,
      ...treatmentBody,
    };
    bindings[unit.id] = treatment.id;
    subjects.push({
      id: treatment.id,
      evalId: unit.evalId,
      kind: unit.parentSourceId ? "repair" : "generated",
      builder: treatment,
      sourceId: null,
      parentSourceId: unit.parentSourceId ? registered.sourceBindings[unit.parentSourceId]! : null,
      publicFeedbackId:
        unit.assistance === "public_observations"
          ? registered.publicFeedbackBindings[unit.parentSourceId!]!
          : null,
      stageIndex: 1,
      parentSubjectId: null,
    });
  }
  const { modelWork: _work, ...planned } = saved.quote.workload;
  // Each capture of a protocol judges the criteria of the evaluation of its own build.
  const captureEvals = new Map(
    plan.captures.map((capture) => [
      capture.id,
      subjects.find((subject) => subject.id === bindings[capture.subjectId])!.evalId,
    ]),
  );
  const manifest: RunOperationManifest = {
    ...base,
    id: input.operationId,
    inputHash: registered.id,
    evals,
    subjects,
    gradingMode: "all",
    gates: plan.gates,
    protocol: {
      kind: plan.kind,
      hash: plan.id,
      registrationId: registered.id,
      subjectBindings: bindings,
    },
    quoteId: saved.quote.id,
    quoteSelectionId: saved.id,
    quoteHash: hashJson(saved.quote),
    workloadCeilingUsd: workloadCeiling(saved.quote),
    checkingCeilingUsd: checkingCeiling(saved.quote),
    modelSnapshots: saved.quote.models,
    modelConcurrency: await frozenModelConcurrency(input.root, saved.quote.models),
    selectedModelIds: saved.quote.models.map((model) => model.id),
    selectedHarnessIds: [...new Set(plan.builders.map((unit) => unit.harness))],
    captureCells: plan.captures.map((unit) => ({
      id: unit.id,
      treatmentId: bindings[unit.subjectId]!,
      viewId: unit.viewId,
      partition: unit.partition,
      pass: unit.pass,
      requires: unit.requires,
    })),
    gradingCells: [],
    judgmentBatches: plan.judgments.map((unit) => ({
      id: unit.id,
      captureCellId: unit.captureId,
      revisionId: captureEvals.get(unit.captureId)!,
      sampleGroupId: unit.sampleGroupId,
      sample: unit.sample,
      grouping: "shared",
      criterionIds: [],
      presentation: unit.presentation,
      // The samples of a group share the seed, so they send identical bytes.
      configuration: gradingConfiguration(
        saved.quote.models.find((model) => model.id === saved.selection.gradingModelId)!,
        Number.parseInt(hashJson([plan.id, unit.sampleGroupId]).slice(0, 8), 16),
      ),
      substitution: unit.substitution
        ? {
            kind: unit.substitution.kind,
            donorCaptureCellId: unit.substitution.donorCaptureId,
            region: null,
            labelRule: null,
          }
        : null,
    })),
    planned,
    ceilingUsd: input.ceilingUsd,
    unreviewedClaims: [
      ...new Set(components.flatMap((component) => component.unreviewedClaims)),
    ].sort(),
  };
  for (const batch of manifest.judgmentBatches) {
    const revision = await new EvalDefinitionStore(input.root).readExecutableRevision(
      batch.revisionId,
    );
    batch.criterionIds = [
      ...revision.privateEvaluator.deterministic,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.unscaled,
    ].map((criterion) => criterion.id);
  }
  assertManifest(manifest);
  if (plan.kind === "repair_discovery") {
    const journal = await OperationJournal.open(input.root);
    try {
      journal.transaction(() => {
        for (const evaluation of registered.evaluations) {
          const key = hashJson([registered.selectionAuthority, evaluation.id]);
          const prior = journal.read<{ operationId: string; planHash: string }>(
            "repair_discovery_blocks",
            key,
          );
          if (prior && (prior.operationId !== input.operationId || prior.planHash !== plan.id))
            throw new Error(
              "Basalt already started a repair discovery run for this evaluation. Open that run and select Resume.",
            );
          journal.put("repair_discovery_blocks", key, {
            operationId: input.operationId,
            planHash: plan.id,
          });
        }
      });
    } finally {
      journal.close();
    }
  }
  await new RunOperationStore(
    input.root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  ).create(manifest);
  return manifest;
}
