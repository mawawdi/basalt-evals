import { budgetSummary } from "./budget-summary.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { EXECUTION_LIMITS } from "../../contracts/src/execution-limits.js";
import { nativeStepWatchdogMs } from "../../studio-runner/src/native-worker.js";
import { studioMaxClients } from "../../studio-runner/src/workers.js";
import { quoteEvalControls } from "./prepare-controls.js";
import { queueAuthoringAction } from "./authoring-operation.js";
import { projectRun } from "./catalog-projection.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../contracts/src/judge-settings.js";
import { fields, hash, money, text, launchIdentity } from "../../contracts/src/validation.js";
import type {
  LaunchIntent,
  OperationLaunchPreview,
  OperationAuthorization,
  OperationCommandInput,
} from "../../contracts/src/launch.js";
import {
  previewEvaluationLaunch,
  amendWorkflowInputs,
  queueEvaluationWorkflow,
} from "./workflow.js";
import { increaseOperationBudget } from "./operation-budget.js";
import { judgeCriteria, quoteRegisteredEvalRun } from "./run-plan.js";
import { quoteRegisteredExperiment } from "./experiment-run.js";
import { quoteSavedReplay, quoteSavedPublicDevelopment, registerSavedSubject } from "./replay.js";
import { quoteSavedRepair } from "./repair.js";
import {
  previewAssessment,
  sensitivityConditions,
  queueAssessment,
  sourceRevisionId,
} from "./assessment.js";
import { previewRecheck } from "./recheck.js";
import { quoteParityRun } from "./parity-study.js";
import { recordRecheckLaunch } from "./recheck-results.js";
import { stageComponents } from "./stage-run.js";
import { recheckPartSelection } from "../../contracts/src/recheck.js";
import { previewExemplarComparison, queueExemplarComparison } from "./exemplar-comparison.js";
import { explanationRevision, quoteFailureExplanation } from "./failure-explanation.js";
import { queueRunStart } from "./run-request.js";
import { readRunQuote } from "./run-quotes.js";
import { startOperationDriver } from "./driver.js";
import { resumeSavedOperation, stopSavedOperation, continueSavedOperation } from "./service.js";
import { reconcileOperationBilling } from "./reconcile.js";
import { savedLifecycle } from "./lifecycle.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { readRegressionReference } from "./regressions.js";
import { frozenRunStatus } from "./run-builder.js";
import { launchSelection } from "./workflow.js";
import { readRegisteredSource } from "./sources.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import type { RegisteredPublicFeedback } from "./public-feedback.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { DELETED_RUNS } from "./run-visibility.js";
import { frozenModelConcurrency } from "./model-registry.js";

/** All execution intents share one preview and authorization boundary. Preview never dispatches. */
export async function previewOperationLaunch(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<OperationLaunchPreview> {
  const input = fields(value, ["kind", "selection"], "Launch intent") as unknown as LaunchIntent;
  let evaluation: OperationLaunchPreview["evaluation"] = null,
    assessment: OperationLaunchPreview["assessment"] = null,
    comparison: OperationLaunchPreview["comparison"] = null;
  let quote: OperationLaunchPreview["quote"] = null,
    binding: OperationLaunchPreview["binding"],
    humanQuestions = 0;
  let reference: OperationLaunchPreview["reference"] = null;
  let recheck: OperationLaunchPreview["recheck"] = null;
  let title: string;
  let regression: OperationLaunchPreview["regression"] = null;
  switch (input.kind) {
    case "reference": {
      fields(input.selection, ["revisionId", "gradingModelId"], "Reference test");
      const revision = await new EvalDefinitionStore(root).readExecutableRevision(
        input.selection.revisionId,
      );
      quote = await quoteEvalControls(root, revision.id, input.selection.gradingModelId, adapters);
      reference = { revisionId: revision.id };
      binding = { kind: "reference", id: quote.id };
      title = `${revision.publicTask.title} · reference test`;
      break;
    }
    case "regression": {
      fields(
        input.selection,
        ["referenceId", "configuration", "presentation"],
        "Regression launch",
      );
      regression = await readRegressionReference(root, input.selection.referenceId);
      if (
        hashJson((await frozenRunStatus(root, regression.operationId, false)).manifest) !==
        regression.manifestHash
      )
        throw new Error("Regression source binding changed");
      const options = launchSelection({
        ...input.selection.configuration,
        sources: [{ kind: "evaluation", id: regression.evaluationId }],
      });
      if (regression.purpose === "grader") {
        assessment = await previewAssessment(
          root,
          {
            operationId: regression.operationId,
            revisionId: regression.evaluationId,
            subjectIds: [regression.subjectId],
            modelId: options.gradingModelId,
            presentation: input.selection.presentation,
            conditions: ["original"],
            sensitivity: null,
          },
          adapters,
          { criterionIds: regression.criterionIds, judgeSettings: DEFAULT_JUDGE_SETTINGS },
        );
        quote = assessment.quote;
        binding = { kind: "assessment", id: assessment.id };
      } else {
        const revision = await new EvalDefinitionStore(root).readExecutableRevision(
          regression.evaluationId,
        );
        const needsGrader = judgeCriteria(revision).length > 0;
        const saved = await quoteRegisteredEvalRun({
          root,
          adapters,
          selection: {
            revisionId: regression.evaluationId,
            validationRecordHash: regression.validationRecordHash,
            builderModelIds: options.builderModelIds,
            harnessIds: options.harnessIds,
            repetitions: options.repetitions,
            nativeCaptureRepetitions: options.capturePasses,
            gradingModelId: needsGrader ? options.gradingModelId : null,
            judgeSettings: options.judgeSettings,
            captureScope: "final",
            publicFeedbackId: null,
            parentSourceId: null,
            sourceIds: [],
            gradingMode: "all",
            continuingOperationId: null,
          },
        });
        quote = saved.quote;
        binding = { kind: "run", id: saved.id };
      }
      title = regression.title;
      break;
    }
    case "evaluation":
      evaluation = await previewEvaluationLaunch(root, input.selection, adapters);
      title = evaluation.title;
      quote =
        evaluation.run?.quote ??
        evaluation.evaluations.find((item) => item.preparation)?.preparation ??
        null;
      binding = { kind: "workflow", id: evaluation.id };
      break;
    case "recheck": {
      const { part, ...selection } = recheckPartSelection(input.selection);
      const preview = await previewRecheck(root, selection, adapters);
      if (part === "judge") {
        if (!preview.judge)
          throw new Error(
            preview.unavailable.find((item) => item.part === "judge")?.reason ??
              "The judge answers of these builds stay valid, so the judge has nothing to check again.",
          );
        assessment = preview.judge;
        quote = assessment.quote;
        binding = { kind: "assessment", id: assessment.id };
        title = `${preview.title} · reassessment`;
      } else {
        if (!preview.observation)
          throw new Error(
            preview.unavailable.find((item) => item.part === "observation")?.reason ??
              "Studio observed these builds with the current plan, so they need no new observation.",
          );
        quote = preview.observation.quote;
        binding = { kind: "run", id: preview.observation.id };
        title = `${preview.title} · new observation`;
      }
      recheck = { ...selection, part };
      break;
    }
    case "sensitivity":
      sensitivityConditions(input.selection.conditions);
      assessment = await previewAssessment(
        root,
        {
          ...input.selection,
          revisionId: await sourceRevisionId(
            root,
            input.selection.operationId,
            input.selection.subjectIds,
          ),
        },
        adapters,
      );
      title = `${assessment.title} · sensitivity test`;
      quote = assessment.quote;
      binding = { kind: "assessment", id: assessment.id };
      break;
    case "exemplar_comparison":
      comparison = await previewExemplarComparison(root, input.selection, adapters);
      title = comparison.title;
      quote = comparison.quote;
      binding = { kind: "exemplar_comparison", id: comparison.id };
      break;
    case "explain_failures": {
      quote = await quoteFailureExplanation(root, input.selection, adapters);
      const revision = await new EvalDefinitionStore(root).readExecutableRevision(
        input.selection.revisionId,
      );
      binding = { kind: "explanation", id: quote.id };
      title = `${revision.publicTask.title} · explain failures`;
      break;
    }
    default: {
      let saved;
      if (input.kind === "replay" || input.kind === "public_development") {
        fields(input.selection, ["operationId", "subjectId", "passes"], "Retained-source launch");
        saved = await (input.kind === "replay" ? quoteSavedReplay : quoteSavedPublicDevelopment)({
          root,
          ...input.selection,
          adapters,
        });
      } else if (input.kind === "repair") {
        fields(
          input.selection,
          [
            "operationId",
            "subjectId",
            "modelId",
            "gradingModelId",
            "attempts",
            "passes",
            "publicFeedbackId",
          ],
          "Repair launch",
        );
        saved = await quoteSavedRepair({ root, ...input.selection, adapters });
      } else if (input.kind === "parity") {
        saved = await quoteParityRun(root, input.selection, adapters);
      } else if (input.kind === "research") {
        fields(input.selection, ["experimentId", "gradingModelId"], "Research launch");
        saved = await quoteRegisteredExperiment({ root, ...input.selection, adapters });
        humanQuestions = saved.humanWorkload.questions;
      } else throw new Error("Unknown launch intent");
      quote = saved.quote;
      binding = { kind: "run", id: saved.id };
      title =
        input.kind === "repair"
          ? "Repair attempt"
          : input.kind === "replay"
            ? "Saved build replay"
            : input.kind === "public_development"
              ? "Extra observation"
              : input.kind === "research"
                ? "Registered research"
                : input.kind === "parity"
                  ? "Preparation parity run"
                  : "Checked evaluation";
    }
  }
  let budget = budgetSummary();
  const parents = new Set(
    regression
      ? [regression.operationId]
      : "operationId" in input.selection
        ? [input.selection.operationId]
        : [],
  );
  const sources = new Set<string>(),
    feedbacks = new Set<string>();
  if (input.kind === "repair" && input.selection.publicFeedbackId)
    feedbacks.add(input.selection.publicFeedbackId);
  if (input.kind === "research") {
    const research = await readRegisteredExperiment(root, input.selection.experimentId);
    Object.values(research.sourceBindings).forEach((id) => sources.add(id));
    Object.values(research.publicFeedbackBindings).forEach((id) => feedbacks.add(id));
    if (research.selectionAuthority) parents.add(research.selectionAuthority.operationId);
    for (const item of research.repairPopulation ?? [])
      if (item.discovery) parents.add(item.discovery.operationId);
  }
  for (const id of sources) {
    const { source } = await readRegisteredSource(root, id);
    if (source.provenance.originOperationId) parents.add(source.provenance.originOperationId);
  }
  for (const id of feedbacks) {
    const feedback = await new RepositoryFiles(root).json<RegisteredPublicFeedback>(
      `.basalt-evals/public-feedback/${id}.json`,
    );
    const { id: savedId, ...body } = feedback;
    if (savedId !== id || hashJson(body) !== id) throw new Error("Public feedback lineage changed");
    parents.add(feedback.operationId);
  }
  const parentOperationIds = [...parents].sort();
  const studio =
    evaluation?.studio ??
    (quote && quote.workload.nativeRootLaunches > 0 ? await adapters.studio.identity(root) : null);
  const revisionIds = new Set<string>();
  evaluation?.evaluations.forEach((item) => {
    if (item.revisionId) revisionIds.add(item.revisionId);
  });
  if (reference) revisionIds.add(reference.revisionId);
  if (binding.kind === "run") {
    const saved = await readRunQuote(root, binding.id);
    if (saved.kind === "eval") revisionIds.add(saved.selection.revisionId);
    else if (saved.kind === "selection")
      saved.selection.revisionIds.forEach((id) => revisionIds.add(id));
    else if (saved.kind === "stages")
      for (const component of await stageComponents(root, saved))
        revisionIds.add(component.selection.revisionId);
    else
      (await readRegisteredExperiment(root, saved.selection.experimentId)).evaluations.forEach(
        (item) => revisionIds.add(item.id),
      );
  }
  let longestStudioTrialMs: number | null = null;
  // A job can take any Studio slot, so each plan must fit the smallest maxClients.
  const maxClients = studio ? studioMaxClients(await adapters.studio.capabilities(root)) : null;
  const store = new EvalDefinitionStore(root);
  const revisions = [];
  for (const id of revisionIds) {
    const revision = await store.readExecutableRevision(id);
    // Each stage of a staged evaluation has its own Studio plans.
    revisions.push(
      ...(revision.stage.index === 1 ? await store.readStageRevisions(id, true) : [revision]),
    );
  }
  for (const revision of revisions) {
    for (const plan of [revision.privateEvaluator.studio, revision.publicDevelopment.plan]) {
      if (maxClients !== null && plan.clients > maxClients)
        throw new Error(
          `This evaluation needs ${plan.clients} Studio clients, but a Studio slot runs at most ${maxClients}. Raise maxClients in the Studio workers file, or use fewer clients in the evaluation.`,
        );
      for (const step of [
        ...(plan.phases.length ? ["presentation"] : []),
        ...plan.scenarios.map((item) => item.id),
      ])
        longestStudioTrialMs = Math.max(
          longestStudioTrialMs ?? 0,
          nativeStepWatchdogMs(plan, step),
        );
    }
  }
  const timeLimits = {
    readinessMs: studio ? EXECUTION_LIMITS.readinessRequestMs : 0,
    longestStudioTrialMs,
  };
  const previewModels = evaluation?.models ?? quote?.models ?? [];
  // The request concurrency of each model changes the duration of a run, so the scope has it.
  const costScope = hashJson({
    input,
    models: previewModels.map(modelTreatmentIdentity),
    studio,
    preparation: evaluation?.evaluations.map((item) => !!item.preparation) ?? [],
    limits: {
      ...EXECUTION_LIMITS,
      modelConcurrency: await frozenModelConcurrency(root, previewModels),
    },
  });
  const costs = await OperationJournal.open(root);
  try {
    budget = budgetSummary(costs, costScope);
  } finally {
    costs.close();
  }
  const body = {
    costScope,
    studio,
    timeLimits,
    kind: input.kind,
    title,
    budget,
    quote,
    humanQuestions,
    evaluation,
    assessment,
    comparison,
    reference,
    recheck,
    binding,
    regression,
    parentOperationIds,
  };
  const preview = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/launch-previews/${preview.id}.json`;
  await files.writeJsonOnce(path, preview);
  return preview;
}

export async function readOperationLaunch(root: string, id: string) {
  hash(id);
  const preview = await new RepositoryFiles(root)
    .json<OperationLaunchPreview>(`.basalt-evals/launch-previews/${id}.json`)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error("Basalt cannot find this preview. Make a new preview.");
      throw error;
    });
  const { id: savedId, ...body } = preview;
  if (id !== savedId || hashJson(body) !== id) throw new Error("Launch preview changed");
  return preview;
}

export async function launchAuthorization(root: string, identity: string) {
  launchIdentity(identity);
  const journal = await OperationJournal.open(root);
  try {
    const record = journal.read<import("../../contracts/src/launch.js").LaunchAuthorizationStatus>(
      "launch_authorizations",
      hashJson(identity),
    );
    return record
      ? {
          previewId: record.previewId,
          ceilingUsd: record.ceilingUsd,
          operationId: record.operationId,
        }
      : null;
  } finally {
    journal.close();
  }
}

export async function authorizeOperation(
  root: string,
  value: unknown,
  workerModule?: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const row = fields(
    value,
    ["previewId", "ceilingUsd", "idempotencyKey"],
    "Operation authorization",
  );
  hash(row.previewId);
  money(row.ceilingUsd);
  launchIdentity(row.idempotencyKey);
  const input = row as unknown as OperationAuthorization;
  const key = hashJson(input.idempotencyKey);
  const deletedStart = (journal: OperationJournal) => {
    const prior = journal.read<{ operationId: string | null }>("launch_authorizations", key);
    // Delete can also remove the preview. A replay of the request never starts the run again.
    if (prior?.operationId && journal.read(DELETED_RUNS, prior.operationId))
      throw new Error("A person deleted the run of this start request. Make a new preview.");
  };
  const saved = await OperationJournal.open(root);
  try {
    deletedStart(saved);
  } finally {
    saved.close();
  }
  const preview = await readOperationLaunch(root, input.previewId);
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const requestHash = hashJson(input);
      const prior = journal.read<{ requestHash: string; operationId: string | null }>(
        "launch_authorizations",
        key,
      );
      if (prior && prior.requestHash !== requestHash)
        throw new Error(
          "Basalt already received this start request with a different selection or spending limit. Make a new preview.",
        );
      deletedStart(journal);
      journal.put("launch_authorizations", key, {
        requestHash,
        previewId: preview.id,
        ceilingUsd: input.ceilingUsd,
        operationId: prior?.operationId ?? null,
      });
    });
  } finally {
    journal.close();
  }
  const operationId =
    preview.binding.kind === "reference"
      ? (
          await queueAuthoringAction(root, {
            operationId: `reference-${hashJson(input.idempotencyKey).slice(0, 32)}`,
            stage: "controls",
            revisionId: preview.reference!.revisionId,
            quoteId: preview.binding.id,
            ceilingUsd: input.ceilingUsd,
          })
        ).action.operationId
      : preview.binding.kind === "workflow"
        ? (await queueEvaluationWorkflow(root, { ...input, previewId: preview.binding.id })).id
        : preview.binding.kind === "assessment"
          ? (await queueAssessment(root, { ...input, previewId: preview.binding.id })).operationId
          : preview.binding.kind === "exemplar_comparison"
            ? (await queueExemplarComparison(root, { ...input, previewId: preview.binding.id }))
                .operationId
            : preview.binding.kind === "explanation"
              ? (
                  await queueAuthoringAction(root, {
                    operationId: `explanation-${hashJson(input.idempotencyKey).slice(0, 32)}`,
                    stage: "explanation",
                    revisionId: await explanationRevision(root, preview.binding.id),
                    quoteId: preview.binding.id,
                    ceilingUsd: input.ceilingUsd,
                  })
                ).action.operationId
              : (
                  await queueRunStart(root, {
                    quoteId: preview.binding.id,
                    ceilingUsd: input.ceilingUsd,
                    idempotencyKey: input.idempotencyKey,
                  })
                ).operationId;
  // A new observation observes the registered source of each saved build.
  const recheckSources: Record<string, string> = {};
  if (preview.recheck?.part === "observation") {
    const quoted = await readRunQuote(root, preview.binding.id);
    // A stage run observes the saved builds in its first component.
    const saved = quoted.kind === "stages" ? (await stageComponents(root, quoted))[0]! : quoted;
    for (const subjectId of preview.recheck.subjectIds) {
      const { id } = (
        await registerSavedSubject({ root, operationId: preview.recheck.operationId, subjectId })
      ).saved;
      if (saved.kind === "eval" && saved.selection.sourceIds.includes(id))
        recheckSources[subjectId] = id;
    }
  }
  const records = await OperationJournal.open(root);
  try {
    records.transaction(() => {
      const key = hashJson(input.idempotencyKey);
      const authorization = records.read<Record<string, unknown>>("launch_authorizations", key)!;
      records.put("launch_authorizations", key, { ...authorization, operationId });
      const context = {
        costScope: preview.costScope,
        previewId: preview.id,
        kind: preview.kind,
        title: preview.title,
        regressionId: preview.regression?.id ?? null,
        parentOperationIds: preview.parentOperationIds,
      };
      const prior = records.read("operation_context", operationId);
      if (prior && hashJson(prior) !== hashJson(context))
        throw new Error("Operation already has a different launch context");
      records.put("operation_context", operationId, context);
      // A later recheck of the same builds reads the answers of this launch.
      if (preview.recheck)
        recordRecheckLaunch(records, preview.recheck.revisionId, preview.recheck.operationId, {
          operationId,
          part: preview.recheck.part,
          subjects: preview.recheck.subjectIds.map((subjectId) => ({
            subjectId,
            sourceId: recheckSources[subjectId] ?? null,
          })),
          previewId: preview.id,
        });
      projectRun(records, operationId);
    });
  } finally {
    records.close();
  }
  const lifecycle = await savedLifecycle(root, operationId);
  if (["queued", "running"].includes(lifecycle.state))
    await startOperationDriver(root, operationId, workerModule, adapters);
  return { operationId };
}

/** Each run command in the words of its console action. */
const commandActions: Record<OperationCommandInput["kind"], string> = {
  stop: "stop the run",
  resume: "resume the run",
  reconcile: "check the payment status of the run",
  budget: "change the spending limit of the run",
  amend: "change the evaluations of the run",
};

export async function commandOperation(
  root: string,
  id: string,
  value: unknown,
  workerModule?: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const input = value as OperationCommandInput;
  const keys =
    input?.kind === "stop"
      ? ["kind", "reason"]
      : input?.kind === "budget"
        ? ["kind", "ceilingUsd"]
        : input?.kind === "amend"
          ? ["kind", "previewId"]
          : ["kind"];
  fields(value, keys, "Operation command");
  if (!["stop", "resume", "reconcile", "budget", "amend"].includes(input.kind))
    throw new Error("Unknown operation command");
  const lifecycle = await savedLifecycle(root, id);
  if (!lifecycle.capabilities[input.kind].allowed)
    throw new Error(
      `Basalt cannot ${commandActions[input.kind]} now. Reload the page to see the current state of the run.`,
    );
  switch (input.kind) {
    case "stop":
      return stopSavedOperation(root, id, text(input.reason, 500, "Stop reason"));
    case "resume":
      return resumeSavedOperation(root, id, workerModule, adapters);
    case "reconcile":
      return reconcileOperationBilling(root, id, adapters);
    case "budget":
      return increaseOperationBudget(root, id, money(input.ceilingUsd));
    case "amend": {
      const preview = await readOperationLaunch(root, input.previewId);
      if (preview.binding.kind !== "workflow")
        throw new Error("Input amendment requires an evaluation preview");
      await amendWorkflowInputs(root, id, { previewId: preview.binding.id });
      return continueSavedOperation(root, id, workerModule, adapters);
    }
  }
}
