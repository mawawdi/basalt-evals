import type { OperationJournal } from "../../artifact-store/src/journal.js";
import type {
  AuthoringProgress,
  EvaluationWorkflow,
  RunOperationStatus,
  RunStart,
  RunUnit,
  SpendLedgerState,
} from "../../contracts/src/execution.js";
import { EXECUTION_LIMITS } from "../../contracts/src/execution-limits.js";
import { frozenModelName } from "./model-registry.js";
import { notReachedSubjects } from "./stage-reach.js";
import { nativeStepWatchdogMs } from "../../studio-runner/src/native-worker.js";
import type { JourneyActivity, JourneyProgress } from "../../contracts/src/console.js";
import type { FailureRecord } from "../../contracts/src/failure.js";

/**
 * A tested model has started once a build holds a paid request, or a started build has not
 * paused at the spending limit or at a provider failure before its first request.
 */
function evaluatedModelStarted(
  journal: OperationJournal,
  id: string,
  status: RunOperationStatus | null,
) {
  const latest = new Map<string, string>();
  for (const event of status?.events ?? [])
    if (event.stage === "builder") latest.set(event.unitId!, event.kind);
  return (
    [...latest.values()].some((kind) => kind !== "paused" && kind !== "provider_paused") ||
    !!journal
      .read<SpendLedgerState>("spending", id)
      ?.entries.some((entry) => entry.stage.startsWith("builder:"))
  );
}

/** The timeline stages of execution, in their sequence. Units of all three can run at once. */
const executionStages = ["builder", "capture", "scoring"] as const;
/** The step title of each execution stage, as the timeline shows it. */
const executionTitles = {
  builder: "Building with selected models",
  capture: "Collecting evidence",
  scoring: "Checking results",
} as const;

function timelineStage(stage: RunUnit["stage"]): JourneyActivity["stage"] {
  return stage === "builder"
    ? "builder"
    : stage === "final_capture" || stage === "public_development"
      ? "capture"
      : stage === "grading" || stage === "judgment"
        ? "scoring"
        : "execution";
}

/**
 * The step of a run that has no execution unit in flight, for example between two units or
 * while Basalt writes the report: the latest step with completed work, so the finished steps
 * stay finished. Before any work completes, it is the first step that has work.
 */
function reachedExecutionStage(status: RunOperationStatus): (typeof executionStages)[number] {
  const done = new Set(
    status.events.flatMap((event) =>
      event.kind === "completed" && event.stage ? [timelineStage(event.stage)] : [],
    ),
  );
  return (
    [...executionStages].reverse().find((stage) => done.has(stage)) ??
    (status.manifest.planned.independentBuilderTrials ? "builder" : "capture")
  );
}

/** One unit in flight, with the model of the build that it builds, observes or checks. */
function unitActivity(status: RunOperationStatus, unit: RunUnit): JourneyActivity {
  const manifest = status.manifest;
  const captureId =
    unit.stage === "final_capture"
      ? unit.unitId
      : unit.stage === "grading"
        ? manifest.gradingCells.find((cell) => cell.id === unit.unitId)?.captureCellId
        : unit.stage === "judgment"
          ? manifest.judgmentBatches.find((batch) => batch.id === unit.unitId)?.captureCellId
          : undefined;
  const capture = manifest.captureCells.find((cell) => cell.id === captureId);
  const subject = manifest.subjects.find(
    (item) => item.id === (capture?.treatmentId ?? unit.unitId),
  );
  const builder = subject?.builder;
  const model = builder ? frozenModelName(manifest.modelSnapshots, builder.model.id) : null;
  const stage = timelineStage(unit.stage);
  const view =
    unit.stage === "final_capture" && capture
      ? manifest.evals
          .find((item) => item.id === subject?.evalId)
          ?.views.find((item) => item.id === capture.viewId)
      : undefined;
  const started = [...status.events]
    .reverse()
    .find(
      (event) =>
        event.kind === "started" && event.stage === unit.stage && event.unitId === unit.unitId,
    );
  return {
    stage,
    action:
      stage === "builder"
        ? `Building with ${model ?? "selected model"}`
        : stage === "capture"
          ? `Collecting evidence${model ? ` for ${model}` : ""}`
          : stage === "scoring"
            ? `Checking results${model ? ` for ${model}` : ""}`
            : unit.stage === "report"
              ? "Writing report"
              : "Preparing run",
    startedAt: started?.at ?? status.events.at(-1)?.at ?? new Date().toISOString(),
    observationWindowMs: view?.plan.scenarios.length
      ? view.plan.scenarios.reduce((total, scenario) => total + scenario.durationMs, 0)
      : null,
    limitMs: view
      ? [
          ...(view.plan.phases.length ? ["presentation"] : []),
          ...view.plan.scenarios.map((item) => item.id),
        ].reduce((sum, id) => sum + nativeStepWatchdogMs(view.plan, id), 0)
      : null,
  };
}

/** A short state of several units, for example "Running 3 builds and 1 observation". */
function activitySummary(activity: JourneyActivity[], status: RunOperationStatus | null) {
  if (activity.length === 1) return activity[0]!.action;
  const count = (stage: JourneyActivity["stage"]) =>
    activity.filter((item) => item.stage === stage).length;
  const amount = (total: number, one: string, many: string) =>
    total ? `${total} ${total === 1 ? one : many}` : "";
  // Checks run in groups for each observation, so the summary counts the observations.
  const checked = new Set(
    (status?.inFlightUnits ?? []).flatMap((unit) => {
      const id =
        unit.stage === "grading"
          ? status!.manifest.gradingCells.find((cell) => cell.id === unit.unitId)?.captureCellId
          : unit.stage === "judgment"
            ? status!.manifest.judgmentBatches.find((batch) => batch.id === unit.unitId)
                ?.captureCellId
            : undefined;
      return id ? [id] : [];
    }),
  ).size;
  const parts = [
    amount(count("builder"), "build", "builds"),
    amount(count("capture"), "observation", "observations"),
    checked ? `the checks of ${amount(checked, "observation", "observations")}` : "",
    amount(count("execution"), "other action", "other actions"),
  ].filter(Boolean);
  return `Running ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}`;
}

/** Updated with authoritative transitions. Progress GETs never inspect whole evidence trees. */
export function projectJourney(
  journal: OperationJournal,
  id: string,
  workflow: EvaluationWorkflow | null,
  status: RunOperationStatus | null,
  authoring: AuthoringProgress | null,
) {
  const readiness = journal.read<{ state: string; at: string }>("readiness_progress", id);
  const start = journal.read<RunStart>("run_starts", id);
  const finished =
    workflow?.state === "complete" ||
    status?.finished ||
    (!workflow && authoring?.state === "completed");
  const checkingStudio = !finished && !!readiness && readiness.state !== "ready";
  // Several units can be in flight at once: builds, observations and checks overlap.
  const activity: JourneyActivity[] = finished
    ? []
    : checkingStudio
      ? [
          {
            stage: "readiness",
            action: "Checking Studio",
            startedAt: readiness.at,
            observationWindowMs: null,
            limitMs: EXECUTION_LIMITS.readinessRequestMs,
          },
        ]
      : (status?.inFlightUnits.map((unit) => unitActivity(status, unit)) ?? []);
  const activeStages = [...new Set(activity.map((item) => item.stage))];
  const stage = finished
    ? "complete"
    : checkingStudio
      ? "readiness"
      : !status
        ? authoring?.action.stage === "controls"
          ? "references"
          : authoring?.action.stage === "explanation"
            ? "explanation"
            : workflow?.phase === "execution" || start
              ? "execution"
              : "preparation"
        : (executionStages.find((item) => activeStages.includes(item)) ??
          reachedExecutionStage(status));
  const startedAt = workflow?.createdAt ?? status?.events[0]?.at ?? readiness?.at ?? null;
  const interrupted =
    workflow?.state === "attention" ||
    workflow?.state === "stopped" ||
    start?.stopped ||
    start?.state === "incomplete" ||
    status?.stopped ||
    authoring?.stopped ||
    authoring?.state === "incomplete";
  const previous = journal.read<JourneyProgress>("journey_progress", id);
  const recentEvents = status ? [...status.events].reverse() : [];
  const failure = recentEvents.find(
    (event) =>
      event.kind === "incomplete" &&
      event.reason &&
      !status?.completedUnits.includes(`${event.stage}:${event.unitId}`),
  );
  const failureRecord = failure
    ? journal.read<Record<string, FailureRecord>>("failure_heads", id)?.[
        `${failure.stage}:${failure.unitId}`
      ]
    : null;
  // A build of a later stage that the run did not reach never starts and has no observations.
  const notReached = notReachedSubjects(status?.events ?? []);
  const progress: JourneyProgress = {
    stage,
    activeStages,
    action:
      interrupted && !finished
        ? stage === "preparation"
          ? "Preparation stopped"
          : status?.stopped || workflow?.state === "stopped"
            ? "Run stopped"
            : "Run paused"
        : stage === "readiness"
          ? "Checking Studio"
          : stage === "preparation"
            ? "Preparing tests"
            : stage === "references"
              ? "Testing reference builds"
              : stage === "explanation"
                ? "Explaining failures"
                : finished
                  ? workflow?.selection.objective === "prepare"
                    ? "Checks prepared"
                    : "Results available"
                  : activity.length
                    ? activitySummary(activity, status)
                    : stage === "builder" || stage === "capture" || stage === "scoring"
                      ? executionTitles[stage]
                      : "Preparing run",
    startedAt,
    activity,
    recentFailure: failure
      ? {
          action:
            failure.stage === "judgment" || failure.stage === "grading"
              ? "Checks"
              : failure.stage === "final_capture"
                ? "Evidence collection"
                : "Build",
          reason: failureRecord?.explanation ?? failure.reason!,
          at: failure.at,
        }
      : null,
    endedAt: finished
      ? (status?.events.at(-1)?.at ?? workflow?.updatedAt ?? new Date().toISOString())
      : interrupted
        ? (previous?.endedAt ?? workflow?.updatedAt ?? status?.events.at(-1)?.at ?? null)
        : null,
    evaluatedModelStarted: evaluatedModelStarted(journal, id, status),
    preparationSkipped:
      (!authoring && (!!Object.values(workflow?.revisions ?? {})[0] || !!status || !!start)) ||
      authoring?.action.stage === "controls" ||
      authoring?.action.stage === "explanation",
    limitBasis: "per Studio workload",
    completedCandidates:
      status?.events.filter((event) => event.stage === "builder" && event.kind === "completed")
        .length ?? 0,
    plannedCandidates:
      status?.manifest.planned.independentBuilderTrials ??
      (workflow && workflow.selection.objective === "evaluate"
        ? workflow.selection.sources.length *
          workflow.selection.builderModelIds.length *
          workflow.selection.harnessIds.length *
          workflow.selection.repetitions
        : 0),
    completedCaptures:
      status?.events.filter(
        (event) => event.stage === "final_capture" && event.kind === "completed",
      ).length ?? 0,
    notReachedCandidates: notReached.size,
    plannedCaptures: status
      ? status.manifest.captureCells.filter((cell) => !notReached.has(cell.treatmentId)).length
      : null,
  };
  journal.put("journey_progress", id, progress);
}
