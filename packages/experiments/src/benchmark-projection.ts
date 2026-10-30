import { EVIDENCE_CLASSES, hashJson } from "../../contracts/src/index.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import { countCauses, type OutcomeAttribution } from "./outcome-causes.js";
import type {
  BenchmarkReport,
  BenchmarkCriterionDefinition,
  BenchmarkCriterionOutcome,
  BenchmarkRequestTelemetry,
  BenchmarkOutcomeCounts,
  BenchmarkSlice,
  BenchmarkStudioSession,
  BenchmarkStudioTime,
} from "../../contracts/src/benchmarks.js";
import {
  benchmarkSuccessBounds,
  benchmarkStageTiming,
  summarizeBenchmarkTelemetry,
} from "./benchmarks.js";
import {
  caseBuildMarks,
  caseBuilds,
  combinedOutcomes,
  sampleGroups,
  type BenchmarkBuildMarks,
  type BenchmarkBuildRecords,
} from "./benchmark-builds.js";
import {
  authoredWarningOrder,
  benchmarkPlanRows,
  criterionWarnings,
  type PlanWarningRow,
} from "./plan-warnings.js";

/**
 * The single build disposition rule. Missing, insufficient and unthresholded scored answers
 * never decide a build; a builder failure other than the local gate stays unknown.
 */
export const BUILD_SUCCESS_RULE = {
  succeeded: "Every planned answer to a required criterion of the build is met.",
  failed:
    "The local gate rejected the build, or a planned answer to a required criterion is rejected.",
  unknown: "Any other build.",
} as const;
const BUILD_SUCCESS_RULE_HASH = hashJson(BUILD_SUCCESS_RULE);

/**
 * The generated builds of the report row of one builder model and harness, in plan order. The
 * model is undefined when the run has no saved record of it, and then the report has no row.
 */
function rowSubjects(manifest: RunOperationStatus["manifest"], modelId: string, harnessId: string) {
  return {
    model: manifest.modelSnapshots.find((model) => model.id === modelId),
    subjects: manifest.subjects.filter(
      (subject) =>
        subject.kind === "generated" &&
        subject.builder?.model.id === modelId &&
        subject.builder.harness.id === harnessId,
    ),
  };
}

function assertSingleAnswers(outcomes: BenchmarkCriterionOutcome[]): void {
  if (
    new Set(outcomes.map((outcome) => `${outcome.cellId}:${outcome.criterionId}`)).size !==
    outcomes.length
  )
    throw new Error("Duplicate original criterion answer identity");
}

/**
 * The marked builds of one evaluation, in the sequence of the report rows. The plan warnings read
 * them without the charges and the Studio times of the run.
 */
export function evaluationBuildMarks(
  status: RunOperationStatus,
  outcomes: BenchmarkCriterionOutcome[],
  evaluationId: string,
): BenchmarkBuildMarks[] {
  assertSingleAnswers(outcomes);
  const { manifest } = status;
  const records = { manifest, events: status.events, outcomes };
  return manifest.selectedModelIds.flatMap((modelId) =>
    manifest.selectedHarnessIds.flatMap((harnessId) => {
      const { model, subjects } = rowSubjects(manifest, modelId, harnessId);
      return model
        ? caseBuildMarks(
            records,
            subjects
              .filter((subject) => subject.evalId === evaluationId)
              .map((subject) => subject.id),
          )
        : [];
    }),
  );
}

/** Project one frozen automatic generation matrix; never pairs independent builds. */
export function projectBenchmarkReport(input: {
  status: RunOperationStatus;
  title: string;
  definitions: BenchmarkCriterionDefinition[];
  outcomes: BenchmarkCriterionOutcome[];
  requests: BenchmarkRequestTelemetry[];
  studioSessions?: BenchmarkStudioSession[];
  issues?: string[];
  evaluationTitles?: ReadonlyMap<string, string>;
  /** The answers of the empty build and of known builds for the plan warnings. */
  planRows?: PlanWarningRow[];
  /** The recorded cause of each unit that did not finish. */
  attributions?: OutcomeAttribution[];
}): BenchmarkReport {
  const sessions = input.studioSessions ?? [];
  // A sum is known only when every session it covers recorded the quantity.
  const total = (selected: BenchmarkStudioSession[], key: "activeMs" | "queueMs") =>
    selected.every((session) => session[key] !== null)
      ? selected.reduce((sum, session) => sum + session[key]!, 0)
      : null;
  const studioTime = (builders: Set<string>, captures: Set<string>): BenchmarkStudioTime => {
    const built = sessions.filter(
      (session) => session.stage === "builder" && builders.has(session.unitId),
    );
    const captured = sessions.filter(
      (session) => session.stage === "final_capture" && captures.has(session.unitId),
    );
    return {
      builderSessions: built.length,
      builderActiveMs: total(built, "activeMs"),
      builderQueueMs: total(built, "queueMs"),
      captureSessions: captured.length,
      captureActiveMs: total(captured, "activeMs"),
      captureQueueMs: total(captured, "queueMs"),
    };
  };
  const { status } = input,
    manifest = status.manifest;
  assertSingleAnswers(input.outcomes);
  // A judge check has one answer for each sample group. Its samples combine into it.
  const groups = sampleGroups(manifest);
  const cells = new Map(
    combinedOutcomes(manifest, input.outcomes).map((outcome) => [
      `${outcome.cellId}:${outcome.criterionId}`,
      outcome,
    ]),
  );
  const subjectsById = new Map(manifest.subjects.map((subject) => [subject.id, subject]));
  const planById = new Map<string, { captureCellId: string; method: "model" | "deterministic" }>([
    ...manifest.gradingCells.map(
      (cell) =>
        [cell.id, { captureCellId: cell.captureCellId, method: "deterministic" as const }] as const,
    ),
    ...groups.map(
      (group) =>
        [group.id, { captureCellId: group.captureCellId, method: "model" as const }] as const,
    ),
  ]);
  const captures = new Map(manifest.captureCells.map((capture) => [capture.id, capture]));
  const evaluationOf = (cellId: string) =>
    subjectsById.get(captures.get(planById.get(cellId)?.captureCellId ?? "")?.treatmentId ?? "")
      ?.evalId;
  const completed = new Set(status.completedUnits);
  const required = new Map(
    input.definitions.map((row) => [`${row.evaluationId}:${row.criterionId}`, row.required]),
  );
  // Criterion IDs repeat across evaluations, so the class of a planned answer needs both.
  const evidenceClasses = new Map(
    input.definitions.map((row) => [`${row.evaluationId}:${row.criterionId}`, row.evidenceClass]),
  );
  const classOf = (cell: { cellId: string; criterionId: string }) =>
    evidenceClasses.get(`${evaluationOf(cell.cellId)}:${cell.criterionId}`) ?? null;
  /** A recorded answer names its method. A planned answer without one takes the plan's. */
  const methodOf = (cell: { cellId: string; criterionId: string }) =>
    cells.get(`${cell.cellId}:${cell.criterionId}`)?.method ?? planById.get(cell.cellId)?.method;
  // An evidence class describes judge evidence, so the classes hold judge checks only. Every
  // row lists the same classes: each class with a planned judge answer in the run.
  const classList = [...EVIDENCE_CLASSES, null].filter((evidenceClass) =>
    [
      ...manifest.gradingCells.map((cell) => ({ cellId: cell.id, criterionId: cell.criterionId })),
      ...groups.flatMap((group) =>
        group.criterionIds.map((criterionId) => ({ cellId: group.id, criterionId })),
      ),
    ].some((cell) => methodOf(cell) === "model" && classOf(cell) === evidenceClass),
  );
  const subjectOf = (cellId: string) =>
    captures.get(planById.get(cellId)?.captureCellId ?? "")?.treatmentId;
  const builderTerminal = new Map<string, (typeof status.events)[number]>();
  for (const event of status.events)
    if (event.stage === "builder" && ["completed", "failed", "incomplete"].includes(event.kind))
      builderTerminal.set(event.unitId!, event);
  const notReached = new Set(
    status.events
      .filter(
        (event) =>
          event.stage === "builder" &&
          event.kind === "not_dispatched" &&
          event.reason === "stage_not_reached",
      )
      .map((event) => event.unitId!),
  );
  const buildOutcome = (
    subjectId: string,
    requiredCells: Array<{ cellId: string; criterionId: string }>,
  ): "succeeded" | "failed" | "unknown" => {
    const terminal = builderTerminal.get(subjectId);
    if (terminal?.kind === "failed" && terminal.reason === "local_gate_rejected") return "failed";
    const answers = requiredCells
      .filter((cell) => subjectOf(cell.cellId) === subjectId)
      .map((cell) => cells.get(`${cell.cellId}:${cell.criterionId}`)?.outcome);
    if (answers.includes("rejected")) return "failed";
    return answers.length && answers.every((outcome) => outcome === "met")
      ? "succeeded"
      : "unknown";
  };
  const records: BenchmarkBuildRecords = {
    manifest,
    events: status.events,
    outcomes: input.outcomes,
    requests: input.requests,
    studioSessions: sessions,
  };
  const usedRequests = new Set<string>();
  const issues = [...(input.issues ?? [])];
  const counts = (
    planned: Array<{ cellId: string; criterionId: string }>,
  ): BenchmarkOutcomeCounts => {
    const recorded = planned.map((cell) => cells.get(`${cell.cellId}:${cell.criterionId}`));
    return {
      planned: planned.length,
      met: recorded.filter((row) => row?.outcome === "met").length,
      rejected: recorded.filter((row) => row?.outcome === "rejected").length,
      scored: recorded.filter((row) => row?.outcome === "scored").length,
      insufficient: recorded.filter((row) => row?.outcome === "insufficient").length,
      missing: recorded.filter((row) => !row).length,
      split: recorded.filter((row) => row?.outcome === "split").length,
    };
  };
  const rows: BenchmarkReport["rows"] = [];
  for (const modelId of manifest.selectedModelIds)
    for (const harnessId of manifest.selectedHarnessIds) {
      const { model, subjects } = rowSubjects(manifest, modelId, harnessId);
      if (!model) {
        issues.push(`The run has no saved record of the builder model ${modelId}.`);
        continue;
      }
      const subjectIds = new Set(subjects.map((subject) => subject.id));
      const rowCaptures = manifest.captureCells.filter((capture) =>
        subjectIds.has(capture.treatmentId),
      );
      const rowCaptureIds = new Set(rowCaptures.map((capture) => capture.id));
      const deterministic = manifest.gradingCells.filter((cell) =>
        rowCaptureIds.has(cell.captureCellId),
      );
      const judgments = manifest.judgmentBatches.filter((batch) =>
        rowCaptureIds.has(batch.captureCellId),
      );
      // The build of each unit of the row, for the causes of units that did not finish.
      const captureSubject = new Map(
        rowCaptures.map((capture) => [capture.id, capture.treatmentId]),
      );
      const rowUnits = new Map<string, string | null>([
        ...subjects.map((subject) => [`builder:${subject.id}`, subject.id] as const),
        ...rowCaptures.map(
          (capture) => [`final_capture:${capture.id}`, capture.treatmentId] as const,
        ),
        ...judgments.map(
          (batch) =>
            [`judgment:${batch.id}`, captureSubject.get(batch.captureCellId) ?? null] as const,
        ),
        ...deterministic.map(
          (cell) => [`grading:${cell.id}`, captureSubject.get(cell.captureCellId) ?? null] as const,
        ),
      ]);
      const unitKey = (unit: OutcomeAttribution) => `${unit.stage}:${unit.unitId}`;
      // The planned answers of a build whose stage the run did not reach count apart: the build
      // keeps its marks and its not reached state, and the answer counts leave them out.
      const allPlanned = [
        ...deterministic.map((cell) => ({ cellId: cell.id, criterionId: cell.criterionId })),
        ...groups
          .filter((group) => rowCaptureIds.has(group.captureCellId))
          .flatMap((group) =>
            group.criterionIds.map((criterionId) => ({ cellId: group.id, criterionId })),
          ),
      ];
      const planned = allPlanned.filter((cell) => !notReached.has(subjectOf(cell.cellId) ?? ""));
      // The answers of some checks, with each evaluation that plans one of them. An evaluation
      // whose builds the run did not reach keeps its place with no planned answers.
      const slice = (chosen: (cell: (typeof allPlanned)[number]) => boolean): BenchmarkSlice => {
        const selected = planned.filter(chosen);
        const byCase = new Map<string, typeof selected>();
        for (const cell of allPlanned.filter(chosen)) byCase.set(evaluationOf(cell.cellId)!, []);
        for (const cell of selected) byCase.get(evaluationOf(cell.cellId)!)?.push(cell);
        return {
          answers: counts(selected),
          cases: manifest.evals.flatMap((evaluation) => {
            const caseCells = byCase.get(evaluation.id);
            return caseCells ? [{ evaluationId: evaluation.id, answers: counts(caseCells) }] : [];
          }),
        };
      };
      const ownedStageIds = new Set([
        ...subjects.map((subject) => `builder:${subject.id}`),
        ...deterministic.map((cell) => `grading:${cell.id}`),
        ...judgments.map((batch) => `judgment:${batch.id}`),
      ]);
      const requests = input.requests.filter((request) => ownedStageIds.has(request.stage));
      requests.forEach((request) =>
        usedRequests.add(`${request.operationId}:${request.requestId}`),
      );
      const cases = manifest.evals.map((evaluation) => {
        const caseSubjects = subjects.filter((subject) => subject.evalId === evaluation.id);
        const casePlanned = planned.filter((cell) => evaluationOf(cell.cellId) === evaluation.id);
        // The rule decides a case from its plan, also when the run did not reach some builds.
        const caseAll = allPlanned.filter((cell) => evaluationOf(cell.cellId) === evaluation.id);
        const known = caseAll.every((cell) => required.has(`${evaluation.id}:${cell.criterionId}`));
        const requiredCells = caseAll.filter((cell) =>
          required.get(`${evaluation.id}:${cell.criterionId}`),
        );
        const decided = known && requiredCells.length > 0;
        return {
          evaluationId: evaluation.id,
          builds: caseBuilds(
            records,
            caseSubjects.map((subject) => subject.id),
          ),
          answers: counts(casePlanned),
          successRuleHash: decided ? BUILD_SUCCESS_RULE_HASH : null,
          attempts: caseSubjects.map((subject) => ({
            subjectId: subject.id,
            outcome: notReached.has(subject.id)
              ? ("not_reached" as const)
              : decided
                ? buildOutcome(subject.id, requiredCells)
                : ("unknown" as const),
          })),
        };
      });
      if (cases.some((row) => !row.builds.length))
        issues.push(
          `The run has no planned build of ${modelId} with ${harnessId} for one or more evaluations.`,
        );
      const scores = input.definitions
        .filter((definition) => definition.scaleHash !== null)
        .map((definition) => {
          const matching = planned.filter(
            (cell) =>
              cell.criterionId === definition.criterionId &&
              evaluationOf(cell.cellId) === definition.evaluationId,
          );
          return {
            ...definition,
            values: matching.flatMap((cell) => {
              const value = cells.get(`${cell.cellId}:${cell.criterionId}`)?.score;
              return value !== null && value !== undefined ? [value] : [];
            }),
            planned: matching.length,
          };
        })
        .filter((group) => group.planned > 0);
      const conditionsHash = hashJson({
        model,
        harnesses: subjects.map((subject) => subject.builder!.harness),
        environments: subjects.map((subject) => subject.builder!.environment),
        transports: subjects.map((subject) => subject.builder!.transportConfigurationHash),
        grading: judgments.map((batch) => ({
          configuration: batch.configuration,
          presentation: batch.presentation,
        })),
      });
      rows.push({
        id: hashJson({ operationId: manifest.id, modelId, harnessId }),
        modelId,
        modelName: model.name,
        modelRevision: model.revision,
        providers: [...new Set(model.endpoints.map((endpoint) => endpoint.provider))],
        quantizations: [...new Set(model.endpoints.map((endpoint) => endpoint.quantization))],
        harnessId,
        harnessTitle: subjects[0]?.builder?.harness.title ?? harnessId,
        subjectIds: [...subjectIds],
        plannedBuilds: subjects.length,
        captures: {
          planned: rowCaptures.length,
          available: rowCaptures.filter((capture) => completed.has(`final_capture:${capture.id}`))
            .length,
        },
        success: benchmarkSuccessBounds(
          cases
            .filter((row) => row.builds.length)
            .map(({ evaluationId, successRuleHash, attempts }) => ({
              evaluationId,
              successRuleHash,
              attempts,
            })),
        ),
        answers: counts(planned),
        methods: {
          deterministic: slice((cell) => methodOf(cell) === "deterministic"),
          model: slice((cell) => methodOf(cell) === "model"),
        },
        classes: classList.map((evidenceClass) => ({
          evidenceClass,
          ...slice((cell) => methodOf(cell) === "model" && classOf(cell) === evidenceClass),
        })),
        scores,
        telemetry: summarizeBenchmarkTelemetry(requests),
        timing: [
          benchmarkStageTiming(status.events, "builder", [...subjectIds]),
          benchmarkStageTiming(
            status.events,
            "final_capture",
            rowCaptures.map((capture) => capture.id),
          ),
          benchmarkStageTiming(
            status.events,
            "judgment",
            judgments.map((batch) => batch.id),
          ),
          benchmarkStageTiming(
            status.events,
            "grading",
            deterministic.map((cell) => cell.id),
          ),
        ],
        studio: studioTime(subjectIds, rowCaptureIds),
        causes: countCauses(
          (input.attributions ?? []).filter((unit) => rowUnits.has(unitKey(unit))),
          (unit) => rowUnits.get(unitKey(unit)) ?? null,
        ),
        cases: cases.map(({ evaluationId, builds, answers }) => ({
          evaluationId,
          builds,
          answers,
        })),
        conditionsHash,
      });
    }
  // The campaign starts at its first recorded stage event; no earlier boundary is journaled.
  const start = status.events[0],
    end = status.events.find((event) => event.kind === "completed" && event.stage === "report");
  const startTime = Date.parse(start?.at ?? ""),
    endTime = Date.parse(end?.at ?? "");
  const campaignWallMs =
    Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime
      ? endTime - startTime
      : null;
  return {
    operationId: manifest.id,
    manifestHash: hashJson(manifest),
    title: input.title,
    suiteHash: hashJson(manifest.evals),
    caseCount: manifest.evals.length,
    evaluations: manifest.evals.map((evaluation) => ({
      evaluationId: evaluation.id,
      title: input.evaluationTitles?.get(evaluation.id) ?? null,
      stage: {
        index: evaluation.stage.index,
        count: evaluation.stage.count,
        firstEvaluationId: evaluation.stage.firstRevisionId,
      },
    })),
    criteria: input.definitions,
    plannedBuilds: manifest.planned.independentBuilderTrials,
    plannedCaptures: manifest.captureCells.length,
    finished: status.finished,
    stopped: status.stopped,
    activeUnits: status.inFlightUnits.map(({ stage, unitId }) => ({ stage, unitId })),
    campaignWallMs,
    queueWaitMs: total(sessions, "queueMs"),
    requiredHumanJudgments: 0,
    source: "retained_operation_journal_and_bound_receipts",
    conditions: {
      implementation: manifest.implementationCommit,
      build: manifest.buildIdentityHash,
      connector: manifest.connectorArtifactHash,
      gradingMode: manifest.gradingMode,
      models: manifest.modelSnapshots,
      harnessDefinitions: [
        ...new Map(
          manifest.subjects.flatMap((subject) =>
            subject.builder
              ? [[hashJson(subject.builder.harness), subject.builder.harness] as const]
              : [],
          ),
        ).values(),
      ],
      gradingConfigurations: [
        ...new Set(
          manifest.judgmentBatches.map((batch) =>
            JSON.stringify({
              configuration: batch.configuration,
              presentation: batch.presentation,
            }),
          ),
        ),
      ],
      requestedSeeds: manifest.subjects.flatMap((subject) =>
        subject.builder ? [{ subjectId: subject.id, seed: subject.builder.randomSeed }] : [],
      ),
      caseSuccessRule:
        "Basalt has no rule that combines the builds of an evaluation into one result. The criterion answers are the authority.",
    },
    rows,
    telemetry: summarizeBenchmarkTelemetry(input.requests),
    sharedTelemetry: summarizeBenchmarkTelemetry(
      input.requests.filter(
        (request) => !usedRequests.has(`${request.operationId}:${request.requestId}`),
      ),
    ),
    issues: [...new Set(issues)],
    planWarnings: authoredWarningOrder(
      criterionWarnings([
        ...benchmarkPlanRows(
          manifest.id,
          rows.flatMap((row) => row.cases),
        ),
        ...(input.planRows ?? []),
      ]),
      input.definitions,
    ),
  };
}
