import type { RunView } from "../../contracts/src/execution.js";
import { stat } from "node:fs/promises";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { reviewerProfile } from "./reviewers.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, assertStudioCollectionPlan } from "../../contracts/src/index.js";
import { readReadinessRecord } from "../../eval-authoring/src/registration.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { criterionAuthoredPassages, type EvalRevision } from "../../eval-authoring/src/compiler.js";
import {
  plannedCounts,
  type BaselinePlan,
  type ExperimentPlan,
} from "../../experiments/src/protocols.js";
import { assertExemplarChoice, type ExemplarChoice } from "../../contracts/src/exemplars.js";
import { exemplarComparisonGaps } from "../../eval-authoring/src/exemplar-comparison.js";

import { readRegisteredSource } from "./sources.js";

export interface RegisteredExperiment {
  id: string;
  plan: ExperimentPlan;
  reviewer: string;
  evaluations: Array<{ id: string; validationRecordHash: string; views: RunView[] }>;
  sourceBindings: Record<string, string>;
  publicFeedbackBindings: Record<string, string>;
  selectionAuthority: { operationId: string; receiptHash: string } | null;
  repairPopulation: Array<{
    evalId: string;
    outcome: "retained_parent" | "discovered_parent" | "inconclusive";
    parentId: string | null;
    discovery: { operationId: string; receiptHash: string } | null;
  }> | null;
}

/** Trusted protocol compilation. HTTP accepts the resulting identity, never these executable plans. */
export async function registerExperiment(root: string, input: Omit<RegisteredExperiment, "id">) {
  const registered = { ...input, id: hashJson(input) };
  await validateExperiment(root, registered);
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/experiment-plans/${registered.id}.json`;
  try {
    await files.writeJson(path, registered);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(registered))
      throw new Error("Registered experiment changed");
  }
  const journal = await OperationJournal.open(root);
  try {
    journal.project("research", registered.id, {
      search: registered.plan.kind.replaceAll("_", " "),
      status: "registered",
      sort: registered.id,
      body: {
        id: registered.id,
        kind: registered.plan.kind,
        questions: registered.plan.reviewGroups.length,
      },
    });
  } finally {
    journal.close();
  }
  return registered;
}

export async function researchCatalog(root: string, query = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    const page = journal.page<{ id: string; kind: string; questions: number }>("research", {
      q: query.get("q") ?? "",
      page: Number(query.get("page") ?? 1),
      limit: 20,
    });
    const files = new RepositoryFiles(root);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (item) => ({
          ...item,
          registeredAt: (
            await stat(files.path(`.basalt-evals/experiment-plans/${item.id}.json`))
          ).mtime.toISOString(),
        })),
      ),
    };
  } finally {
    journal.close();
  }
}
export async function readRegisteredExperiment(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid experiment identity");
  const registered = await new RepositoryFiles(root).json<RegisteredExperiment>(
    `.basalt-evals/experiment-plans/${id}.json`,
  );
  if (registered.id !== id) throw new Error("Experiment identity changed");
  await validateExperiment(root, registered);
  return registered;
}
async function validateExperiment(root: string, value: RegisteredExperiment) {
  await reviewerProfile(root, value.reviewer);
  const { id, ...body } = value,
    { id: planId, ...planBody } = value.plan;
  if (id !== hashJson(body) || planId !== hashJson(planBody))
    throw new Error("Experiment definition changed");
  const counts = plannedCounts(value.plan);
  if (!counts.captureCells || !counts.judgmentBatches)
    throw new Error("Experiment needs frozen acquisition and judgments");
  if (
    value.plan.kind === "detector_calibration" &&
    (counts.builderTrials !== 0 ||
      counts.captureCells !== 144 ||
      counts.judgmentBatches !== 504 ||
      counts.graderCalls !== 672 ||
      counts.expertItems !== 48)
  )
    throw new Error("Detector calibration differs from its declared full denominator");
  const arms = value.plan.configuration.harnessArms;
  if (
    value.plan.kind === "harness_effectiveness" &&
    (counts.builderTrials !== 48 ||
      counts.captureCells !== 144 ||
      counts.judgmentBatches !== 144 ||
      counts.expertItems !== 48 ||
      !arms ||
      [arms.baseline, arms.treatment].some(
        (id) => value.plan.builders.filter((builder) => builder.harness === id).length !== 24,
      ))
  )
    throw new Error("Harness comparison differs from its declared full denominator");
  if (
    value.plan.analysis.confidence !== 0.95 ||
    value.plan.analysis.method !==
      {
        detector_calibration: "exact_build_cells",
        harness_effectiveness: "task_model_blocks",
        repair_discovery: "individual_attempts",
        matched_repair: "individual_attempts",
      }[value.plan.kind]
  )
    throw new Error("Experiment analysis changed its frozen uncertainty policy");
  if ((value.plan.kind === "matched_repair") !== Array.isArray(value.repairPopulation))
    throw new Error("Repair must retain every intended task and its parent-search outcome");
  if (value.plan.kind === "repair_discovery") {
    const tasks = [...new Set(value.plan.builders.map((builder) => builder.evalId))];
    if (
      !tasks.length ||
      tasks.length > 2 ||
      counts.builderTrials !== tasks.length * 2 ||
      counts.captureCells !== tasks.length * 12 ||
      counts.expertItems !== tasks.length * 4 ||
      value.plan.captures.some((capture) => capture.partition !== "development") ||
      tasks.some((id) => {
        const models = value.plan.builders
          .filter((builder) => builder.evalId === id)
          .map((builder) => builder.modelId);
        return models.length !== 2 || new Set(models).size !== 2;
      })
    )
      throw new Error("Discovery differs from the single two-builder block per task");
  }
  const requiredEvals = [
    ...new Set([...value.plan.sources, ...value.plan.builders].map((item) => item.evalId)),
  ].sort();
  if (hashJson(value.evaluations.map((item) => item.id).sort()) !== hashJson(requiredEvals))
    throw new Error("Experiment eval references are missing or duplicated");
  for (const evaluation of value.evaluations) {
    const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
    const validation = await readReadinessRecord(
      root,
      revision.id,
      evaluation.validationRecordHash,
    );
    if (
      validation.validation.status !== "controls_checked" ||
      validation.check?.status !== "checked"
    )
      throw new Error("Registered research requires the frozen reference-test validation gate");
    const criteria = [
      ...revision.privateEvaluator.deterministic,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.unscaled,
    ];
    if (new Set(evaluation.views.map((view) => view.id)).size !== evaluation.views.length)
      throw new Error("Experiment views must be unique");
    for (const view of evaluation.views) assertStudioCollectionPlan(view.plan);
    if (
      value.plan.captures
        .filter((capture) => capture.evalId === evaluation.id)
        .some(
          (capture) =>
            !evaluation.views.some(
              (view) => view.id === capture.viewId && view.partition === capture.partition,
            ),
        )
    )
      throw new Error("Protocol capture has no registered acquisition view");
    for (const source of value.plan.sources.filter((source) => source.evalId === evaluation.id))
      if (
        source.targetCriterionIds.some(
          (id) => !criteria.some((criterion) => criterion.id === id && criterion.required),
        )
      )
        throw new Error("Control target is not a required authored criterion");
    if (value.plan.baselines) assertBaselineAuthority(value.plan.baselines, evaluation, revision);
  }
  await validateExemplarComparison(root, value);
  if (
    hashJson(Object.keys(value.sourceBindings).sort()) !==
    hashJson(value.plan.sources.map((source) => source.id).sort())
  )
    throw new Error("Protocol source bindings differ from the frozen population");
  for (const source of value.plan.sources) {
    const saved = await readRegisteredSource(root, value.sourceBindings[source.id]!);
    if (
      saved.source.candidate.rootHash !== source.sourceHash ||
      (source.kind === "generated" && saved.source.provenance.kind !== "generated")
    )
      throw new Error(
        "Experiment source bytes or generated origin differ from the declared population",
      );
  }
  const assistedParents = [
    ...new Set(
      value.plan.builders
        .filter((builder) => builder.assistance === "public_observations")
        .map((builder) => builder.parentSourceId!),
    ),
  ].sort();
  if (hashJson(Object.keys(value.publicFeedbackBindings).sort()) !== hashJson(assistedParents))
    throw new Error("Assisted arms need exact public parent feedback bindings");
  for (const parentId of assistedParents) {
    const parent = value.plan.sources.find((source) => source.id === parentId);
    if (!parent) throw new Error("Assisted repair has no frozen parent");
    if (!/^[a-f0-9]{64}$/u.test(value.publicFeedbackBindings[parentId]!))
      throw new Error("Public feedback needs a registered content identity");
  }
}

/**
 * Check the baseline ladder of one evaluation against its frozen definition. An authored
 * threshold must quote the frozen rubric text that governs its criterion. A timing entry must
 * name a transition and an actor of the view sequence, or a capture and a time fact of one
 * phase.
 */
export function assertBaselineAuthority(
  ladder: BaselinePlan,
  evaluation: { id: string; views: RunView[] },
  revision: EvalRevision,
): void {
  const criteria = [
    ...revision.privateEvaluator.deterministic,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.unscaled,
  ];
  const errors: string[] = [];
  for (const rule of ladder.rules.filter((rule) => rule.evalId === evaluation.id)) {
    if (!criteria.some((criterion) => criterion.id === rule.criterionId && criterion.required)) {
      errors.push(
        `Pixel rule ${rule.id} names ${rule.criterionId}, which is not a required criterion of the frozen evaluation`,
      );
      continue;
    }
    const passage = rule.authoredThreshold?.passage;
    if (
      passage !== undefined &&
      (!revision.authored.rubric.includes(passage) ||
        !criterionAuthoredPassages(revision, rule.criterionId).some((text) =>
          text.includes(passage),
        ))
    )
      errors.push(
        `The authored threshold of pixel rule ${rule.id} does not quote the frozen rubric text of criterion ${rule.criterionId}`,
      );
  }
  for (const region of ladder.measurement.regions.filter(
    (region) => region.evalId === evaluation.id,
  ))
    if (
      region.criterionId !== null &&
      !criteria.some((criterion) => criterion.id === region.criterionId)
    )
      errors.push(
        `An authored region names ${region.criterionId}, which is not a criterion of the frozen evaluation`,
      );
  for (const timing of ladder.measurement.timing.filter(
    (timing) => timing.evalId === evaluation.id,
  )) {
    const view = evaluation.views.find((item) => item.id === timing.viewId);
    if (!view) {
      errors.push(`A timing entry names view ${timing.viewId}, which is not a registered view`);
      continue;
    }
    if (timing.kind === "sequence") {
      if (!view.sequence?.requiredTransitions.some((item) => item.id === timing.transitionId))
        errors.push(
          `The timing of view ${view.id} names transition ${timing.transitionId}, which the view sequence does not require`,
        );
      if (!view.plan.actors.includes(timing.actor))
        errors.push(
          `The timing of view ${view.id} names actor ${timing.actor}, which the view plan does not declare`,
        );
      continue;
    }
    for (const binding of timing.captures) {
      const phase = view.plan.phases.find((item) =>
        item.captures.some((capture) => capture.id === binding.captureId),
      );
      if (
        !phase?.facts.some(
          (fact) => fact.id === binding.factId && fact.kind === "replication_probe",
        )
      )
        errors.push(
          `The timing of view ${view.id} needs capture ${binding.captureId} and the replication probe ${binding.factId} in one phase`,
        );
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

/**
 * A pinned exemplar comparison names authored choices that exist. Each choice is for a
 * required appearance criterion of its task, and the plan repeats its exemplar builds.
 */
async function validateExemplarComparison(root: string, value: RegisteredExperiment) {
  const stream = value.plan.exemplarComparison;
  if (!stream) return;
  if (value.plan.kind !== "detector_calibration")
    throw new Error("Only a judge calibration can pin an exemplar comparison");
  const journal = await OperationJournal.open(root);
  let choices: ExemplarChoice[];
  try {
    choices = stream.criteria.map((item) => {
      const stored = journal.read<ExemplarChoice>("exemplar_choices", item.choiceId);
      if (!stored) throw new Error("A pinned exemplar choice is unavailable");
      return assertExemplarChoice(stored);
    });
  } finally {
    journal.close();
  }
  for (const [index, item] of stream.criteria.entries()) {
    const choice = choices[index]!;
    const revision = await new EvalDefinitionStore(root).readExecutableRevision(item.evalId);
    const criterion = [
      ...revision.privateEvaluator.deterministic,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.unscaled,
    ].find((candidate) => candidate.id === item.criterionId);
    if (
      choice.evaluationId !== item.evalId ||
      choice.criterionId !== item.criterionId ||
      hashJson(choice.exemplars.map((exemplar) => exemplar.sourceHash)) !==
        hashJson(item.exemplarSourceHashes) ||
      !criterion?.required ||
      exemplarComparisonGaps(criterion).length
    )
      throw new Error(
        "A pinned exemplar choice must match its required appearance criterion and its exemplar builds",
      );
  }
}
