import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { executionTree } from "../../artifact-store/src/implementation.js";
import { hashJson } from "../../contracts/src/index.js";
import { fields, identity, hash } from "../../contracts/src/validation.js";
import type {
  ComparisonCell,
  ComparisonPopulation,
  RunComparison,
} from "../../contracts/src/comparisons.js";
import {
  comparisonGrid,
  comparisonSet,
  pairedAnswerTransitions,
  sharedEvidenceScope,
  summarizeComparisonPopulation,
} from "../../experiments/src/comparisons.js";
import { criterionNumbers } from "./benchmarks.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { frozenRunStatus } from "./run-builder.js";
import { operatorEvidence } from "./evidence-view.js";
import { operationReviewTreatments } from "./review-treatments.js";
import { assessmentProgress, assessmentReport } from "./assessment.js";
import { subjectEval, manifestHash } from "./run-manifest.js";
import { assessmentTreatment } from "./assessment-review.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";

async function recordedConditions(root: string, manifest: RunOperationManifest) {
  return {
    // Commits that change only the console, tests or documentation share one execution source.
    implementation: await executionTree(root, manifest.implementationCommit),
    build: manifest.buildIdentityHash,
    connector: manifest.connectorArtifactHash,
    builders: manifest.subjects
      .filter((subject) => subject.builder)
      .map((subject) => ({
        model: subject.builder!.model.id,
        modelRevision: subject.builder!.model.revision,
        transport: subject.builder!.transportConfigurationHash,
        harness: subject.builder!.harness,
        environment: subject.builder!.environment,
      })),
  };
}

function scaleContext(
  criterion:
    | { statement: string }
    | { statement: string; scoreRange: unknown; anchors: unknown; minimumPassingScore: unknown },
) {
  return "scoreRange" in criterion
    ? JSON.stringify({
        statement: criterion.statement,
        range: criterion.scoreRange,
        anchors: criterion.anchors,
        threshold: criterion.minimumPassingScore,
      })
    : null;
}

/**
 * The position of each executable criterion in the authored order of its evaluation, from 0. An
 * unknown criterion comes after all of them.
 */
function criterionOrder(revision: EvalRevision) {
  const numbers = criterionNumbers(revision);
  return (criterionId: string) => (numbers.get(criterionId) ?? numbers.size + 1) - 1;
}

async function comparisonPopulation(
  root: string,
  operationId: string,
  treatmentId: string | null,
): Promise<ComparisonPopulation> {
  identity(operationId);
  const assessment = await assessmentProgress(root, operationId);
  if (assessment) {
    const treatment = await assessmentTreatment(root, operationId);
    if (treatmentId !== null && treatmentId !== treatment.id)
      throw new Error("Selected assessment treatment is unavailable");
    const report = await assessmentReport(root, operationId);
    const source = await frozenRunStatus(root, assessment.sourceOperationId, false);
    // A reassessment has exactly one build; assessmentTreatment refuses a sensitivity test.
    const [subjectId] = assessment.subjectIds;
    const evaluation = subjectEval(source.manifest, subjectId!);
    const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
    const criteria = [
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.unscaled,
    ];
    const order = criterionOrder(revision);
    const cells: ComparisonCell[] = report.results.flatMap((unit) =>
      unit.criterionIds.map((criterionId) => {
        const criterion = criteria.find((item) => item.id === criterionId)!;
        const decision = unit.result?.decisions.find((item) => item.criterionId === criterionId);
        const capture = source.manifest.captureCells.find((cell) => cell.id === unit.captureId)!;
        const view = evaluation.views.find(
          (view) => view.id === capture.viewId && view.partition === capture.partition,
        )!;
        return {
          evaluationId: evaluation.id,
          rubricHash: revision.rubricHash,
          candidateId: subjectId!,
          captureId: unit.captureId,
          pass: capture.pass,
          evidenceCellId: null,
          criterionId,
          criterionOrder: order(criterionId),
          statement: criterion.statement,
          scale: scaleContext(criterion),
          acquisitionHash: hashJson(view),
          graderIdentity: treatment.id,
          generatorIdentity: null,
          method: "qualitative" as const,
          score: decision?.score ?? null,
          scaleHash:
            "scoreRange" in criterion
              ? hashJson({
                  scoreRange: criterion.scoreRange,
                  anchors: criterion.anchors,
                  minimumPassingScore: criterion.minimumPassingScore,
                })
              : null,
          // The rule of the run outcomes: a score without a minimum has the verdict insufficient.
          outcome: !decision
            ? ("incomplete" as const)
            : decision.verdict === "satisfied"
              ? ("met" as const)
              : decision.verdict === "violated"
                ? ("rejected" as const)
                : decision.score !== null
                  ? ("scored" as const)
                  : ("insufficient" as const),
        };
      }),
    );
    return {
      operationId,
      manifestHash: hashJson(report.plan),
      kind: "assessment",
      sourceOperationId: assessment.sourceOperationId,
      title: assessment.title,
      evaluations: [{ evaluationId: evaluation.id, title: revision.publicTask.title }],
      recordedAt: report.plan.createdAt,
      conditions: {
        ...(await recordedConditions(root, source.manifest)),
        gradingStream: treatment.label,
        sourceOperationStartedAt: source.events[0]?.at ?? null,
        graderImplementation: report.plan.implementationCommit,
        graderBuild: report.plan.buildIdentityHash,
        graderPlanHash: hashJson(report.plan),
        gradingSemanticsHash: report.plan.gradingSemanticsHash,
        graderModel: report.plan.model,
        provenanceLimit:
          "Source builder implementation and evidence time are separate from the assessment implementation.",
      },
      cells,
      independentBuilds: 0,
      captures: 0,
      billedUsd: report.spending.billedUsd,
      reservedUsd: report.spending.reservedUsd,
      toolCalls: null,
      elapsedMs: null,
    };
  }
  const status = await frozenRunStatus(root, operationId, false);
  const treatments = operationReviewTreatments(status.manifest);
  const selected =
    treatmentId ?? (treatments.treatments.length === 1 ? treatments.treatments[0]!.id : null);
  if (
    treatments.treatments.length &&
    !treatments.treatments.some(
      (item) => item.id === selected && item.evidenceCondition === "original",
    )
  )
    throw new Error("Select one original-evidence grading stream before comparison");
  const cells: ComparisonCell[] = [];
  let toolCalls = 0,
    elapsedMs = 0,
    toolsKnown = true,
    timingKnown = true;
  for (const subject of status.manifest.subjects) {
    const evidence = await operatorEvidence(root, operationId, undefined, {
      subjectId: subject.id,
    });
    const candidate = evidence.candidates[0]!;
    const evaluation = subjectEval(status.manifest, subject.id),
      revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
    const order = criterionOrder(revision);
    const criteria = [
      ...revision.privateEvaluator.deterministic,
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.unscaled,
    ];
    toolCalls += candidate.builderToolCalls ?? 0;
    elapsedMs += candidate.builderElapsedMs ?? 0;
    if (subject.builder && candidate.builderToolCalls === null) toolsKnown = false;
    if (subject.builder && candidate.builderElapsedMs === null) timingKnown = false;
    for (const cell of candidate.cells.filter(
      (cell) => cell.treatment === null || cell.treatment.id === selected,
    )) {
      const record =
        status.manifest.gradingCells.find(
          (record) => record.id === cell.automaticDecision.recordId,
        ) ??
        // A judge cell names its sample group. Its samples share one capture.
        status.manifest.judgmentBatches.find(
          (record) => record.sampleGroupId === cell.automaticDecision.recordId,
        )!;
      const capture = status.manifest.captureCells.find(
        (capture) => capture.id === record.captureCellId,
      )!;
      const view = evaluation.views.find(
        (view) => view.id === capture.viewId && view.partition === capture.partition,
      )!;
      const criterion = criteria.find((item) => item.id === cell.criterionId)!;
      cells.push({
        evaluationId: evaluation.id,
        rubricHash: revision.rubricHash,
        candidateId: subject.id,
        criterionId: cell.criterionId,
        criterionOrder: order(cell.criterionId),
        statement: criterion.statement,
        scale: scaleContext(criterion),
        captureId: capture.id,
        pass: capture.pass,
        evidenceCellId: cell.id,
        acquisitionHash: hashJson(view),
        graderIdentity: cell.treatment?.id ?? "deterministic",
        generatorIdentity: subject.builder
          ? hashJson({ model: subject.builder.model, harness: subject.builder.harness })
          : null,
        method: cell.method === "deterministic" ? "functional" : "qualitative",
        outcome:
          cell.outcome === "verified"
            ? "met"
            : cell.outcome === "rejected" ||
                cell.outcome === "split" ||
                cell.outcome === "scored" ||
                cell.outcome === "insufficient"
              ? cell.outcome
              : "incomplete",
        score: cell.score,
        scaleHash:
          "scoreRange" in criterion
            ? hashJson({
                scoreRange: criterion.scoreRange,
                anchors: criterion.anchors,
                minimumPassingScore: criterion.minimumPassingScore,
              })
            : null,
      });
    }
  }
  const evaluations = await Promise.all(
    status.manifest.evals.map(async (item) => ({
      evaluationId: item.id,
      title: (await new EvalDefinitionStore(root).readRevision(item.id)).publicTask.title,
    })),
  );
  return {
    operationId,
    manifestHash: manifestHash(status.manifest),
    kind: "execution",
    sourceOperationId: null,
    title: evaluations.map((item) => item.title).join(", "),
    evaluations,
    recordedAt: status.events[0]?.at ?? null,
    conditions: {
      ...(await recordedConditions(root, status.manifest)),
      gradingStream:
        treatments.treatments.find((item) => item.id === selected)?.label ?? "Code checks",
    },
    cells,
    independentBuilds: status.manifest.planned.independentBuilderTrials,
    captures: status.manifest.captureCells.length,
    billedUsd: status.billedUsd,
    reservedUsd: status.reservedUsd,
    toolCalls: toolsKnown ? toolCalls : null,
    elapsedMs: timingKnown ? elapsedMs : null,
  };
}

/**
 * Freeze a comparison of two to six runs in the order that a person chose them. A source run
 * and its reassessments keep only the answers of the evidence that all of them checked.
 */
export async function previewComparison(root: string, value: unknown) {
  const input = fields(value, ["populations"], "Comparison");
  if (
    !Array.isArray(input.populations) ||
    input.populations.length < 2 ||
    input.populations.length > 6
  )
    throw new Error("Choose two to six runs to compare.");
  const selections = input.populations.map((item: unknown) => {
    const selection = fields(item, ["operationId", "treatmentId"], "Comparison run");
    return {
      operationId: identity(selection.operationId),
      treatmentId: selection.treatmentId === null ? null : hash(selection.treatmentId),
    };
  });
  if (new Set(selections.map((item) => item.operationId)).size !== selections.length)
    throw new Error("Choose each run only one time.");
  const populations: ComparisonPopulation[] = [];
  for (const selection of selections)
    populations.push(
      await comparisonPopulation(root, selection.operationId, selection.treatmentId),
    );
  const scoped = sharedEvidenceScope(populations);
  const body = {
    ...scoped,
    ...comparisonSet(scoped.populations),
    createdAt: new Date().toISOString(),
  };
  const comparison: RunComparison = { ...body, id: hashJson(body) };
  await new RepositoryFiles(root).writeJson(
    `.basalt-evals/comparison-previews/${comparison.id}.json`,
    comparison,
  );
  return comparison;
}

/** The list row of a saved comparison. Basalt makes it again from the saved comparison. */
export function comparisonProjection(comparison: RunComparison) {
  const operationIds = comparison.populations.map((population) => population.operationId);
  return {
    body: {
      id: comparison.id,
      operationIds,
      title: comparison.populations
        .map((population) => {
          const models = (population.conditions.builders as Array<{ model: string }>)
            .map((item) => item.model)
            .join(", ");
          return `${population.title} (${models || "saved build"})`;
        })
        .join(" ↔ "),
      compatibility: comparison.compatibility,
      createdAt: comparison.createdAt,
    },
    search: operationIds.join(" "),
    status: comparison.compatibility,
    sort: comparison.createdAt,
  };
}

export async function createComparison(root: string, previewId: string) {
  hash(previewId);
  const saved = await new RepositoryFiles(root).json<RunComparison>(
    `.basalt-evals/comparison-previews/${previewId}.json`,
  );
  const { id, ...body } = saved;
  if (id !== previewId || hashJson(body) !== id) throw new Error("Comparison preview changed");
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      journal.put("comparisons", id, saved);
      journal.project("comparisons", id, comparisonProjection(saved));
    });
  } finally {
    journal.close();
  }
  return comparisonReport(root, id);
}

/** The saved comparison, checked against its identity. */
export async function savedComparison(root: string, id: string) {
  hash(id);
  const journal = await OperationJournal.open(root);
  try {
    const comparison = journal.read<RunComparison>("comparisons", id);
    if (!comparison) throw new Error("Comparison is unavailable");
    const { id: savedId, ...body } = comparison;
    if (savedId !== id || hashJson(body) !== id) throw new Error("Frozen comparison changed");
    return comparison;
  } finally {
    journal.close();
  }
}

export async function comparisonReport(root: string, id: string) {
  const comparison = await savedComparison(root, id);
  return {
    ...comparison,
    provenance: await Promise.all(
      comparison.populations.map((population) => comparisonProvenance(root, population)),
    ),
    summaries: comparison.populations.map(summarizeComparisonPopulation),
    grid: comparisonGrid(comparison),
    transitions: comparison.pairs.flatMap((pair) => {
      const transitions = pairedAnswerTransitions(comparison, pair.left, pair.right);
      return transitions ? [transitions] : [];
    }),
    limitation:
      "These results describe only these runs. They do not predict future runs or measure the calibration of the judge. Missing checks still count in the planned totals.",
  };
}

/** Derived from immutable authorities; never rewrite a saved comparison or historical treatment ID. */
async function comparisonProvenance(root: string, population: ComparisonPopulation) {
  if (population.kind !== "assessment")
    return { sourceOperationStartedAt: population.recordedAt, grader: null };
  try {
    const report = await assessmentReport(root, population.operationId);
    return {
      sourceOperationStartedAt:
        population.conditions.sourceOperationStartedAt ?? population.recordedAt,
      grader: {
        implementationCommit: report.plan.implementationCommit,
        buildIdentityHash: report.plan.buildIdentityHash,
        immutablePlanHash: hashJson(report.plan),
        gradingSemanticsHash: report.plan.gradingSemanticsHash,
        model: report.plan.model,
        assessmentCreatedAt: report.plan.createdAt,
      },
    };
  } catch (error) {
    return {
      sourceOperationStartedAt:
        population.conditions.sourceOperationStartedAt ?? population.recordedAt,
      grader: null,
      unavailable: String(error).slice(0, 300),
    };
  }
}

export async function listComparisons(root: string, params = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.page<ReturnType<typeof comparisonProjection>["body"]>("comparisons", {
      q: params.get("q") ?? "",
      page: Number(params.get("page")),
      limit: Number(params.get("limit")),
    });
  } finally {
    journal.close();
  }
}
