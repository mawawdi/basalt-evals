import {
  readReadinessRecord,
  type EvaluationReadinessRecord,
} from "../../eval-authoring/src/registration.js";
import { readExecutionProgress } from "./progress.js";
import type {
  PauseRecord,
  RunCriterionArtifact,
  RunOperationEvent,
  RunOperationManifest,
  RunOperationReport,
  RunOperationStatus,
  RunStage,
  RunSubject,
  RunUnit,
  SpendLedgerState,
} from "../../contracts/src/execution.js";
import { resolveExecutionFailures } from "../../artifact-store/src/failures.js";
import { projectRun } from "./catalog-projection.js";
import { runAnswerCounts } from "./answer-counts.js";
import { operationSource, readRegisteredSource } from "./sources.js";
import { verifyJudgmentArtifact } from "./judgment-artifact.js";
import { verifyProtocolGate } from "./protocol-evidence.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { readFile } from "node:fs/promises";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  assertAgentRun,
  assertStudioEvidence,
  contentHash,
  hashJson,
  MAX_PROVIDER_PAUSES,
  type AgentRun,
  type StudioEvidence,
  type Treatment,
} from "../../contracts/src/index.js";
import {
  assertManifest,
  capturePlan,
  frozenSequencePlan,
  operationSubject,
  generatedSubjects,
  subjectEval,
  manifestHash,
  unitModelId,
} from "./run-manifest.js";

import { publicEvalRevisionView, type EvalRevision } from "../../eval-authoring/src/compiler.js";
import { DurableSpendLedger, spendingProjection } from "../../model-client/src/ledger.js";
import { workloadCeiling, checkingCeiling, type RunQuote } from "../../model-client/src/quote.js";

import { loadRegisteredTask } from "../../task-registry/src/index.js";
import { gateCells, isNotReachedEvent, notReachedSubjects, stageReach } from "./stage-reach.js";
import { completedReportReason } from "./report-reason.js";
import { evaluateDeterministicCriteria } from "../../graders/src/index.js";
import { readSourceAnalysis, readsSourceAnalysis } from "../../graders/src/source-analysis.js";
import { loadStudioSession } from "../../studio-runner/src/index.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";

const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const unitPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

/**
 * The units of one stage of the run. A unit of a build whose stage the run did not reach counts
 * in `notReached`, apart from the attempted and the unattempted units.
 */
function unitSummary(
  events: RunOperationEvent[],
  stage: "builder" | "final_capture" | "grading" | "judgment",
  intended: number,
  notReached: number,
): RunOperationReport["units"][typeof stage] {
  const relevant = events.filter((event) => event.stage === stage);
  const attemptedUnits = new Set<string | null>();
  for (const event of relevant) {
    if (event.kind === "started") attemptedUnits.add(event.unitId);
    if (event.kind === "not_dispatched") attemptedUnits.delete(event.unitId);
  }
  const attempted = attemptedUnits.size;
  const completed = relevant.filter((event) => event.kind === "completed").length;
  const failed = relevant.filter((event) => event.kind === "failed").length;
  const incomplete = relevant.filter((event) => event.kind === "incomplete").length;
  return {
    intended,
    attempted,
    completed,
    failed,
    incomplete,
    notReached,
    unattempted: intended - attempted - notReached,
  };
}

/** The planned units of the builds whose stage the run did not reach. */
function notReachedUnits(
  manifest: RunOperationManifest,
  events: RunOperationEvent[],
): Record<"builder" | "final_capture" | "grading" | "judgment", Set<string>> {
  const builds = notReachedSubjects(events);
  const captures = new Set(
    manifest.captureCells.filter((cell) => builds.has(cell.treatmentId)).map((cell) => cell.id),
  );
  return {
    builder: builds,
    final_capture: captures,
    grading: new Set(
      manifest.gradingCells
        .filter((cell) => captures.has(cell.captureCellId))
        .map((cell) => cell.id),
    ),
    judgment: new Set(
      manifest.judgmentBatches
        .filter((batch) => captures.has(batch.captureCellId))
        .map((batch) => batch.id),
    ),
  };
}

// Gate and report stages verify the whole operation; other stages verify their closure.
const gateStages = new Set<RunStage>(["review", "selection", "report"]);

/** A gate or the report runs alone: it starts only when no other unit is in flight. */
export function exclusiveStage(stage: RunStage): boolean {
  return gateStages.has(stage);
}

/** A concurrent update from another process. The append can read the chain again. */
class ConcurrentOperationUpdate extends Error {
  constructor() {
    super("Concurrent operation update; this stage was not claimed");
  }
}

// Appends of one operation in this process run one at a time, in their arrival sequence.
const appendTurns = new Map<string, Promise<void>>();

function eventUnit(stage: RunStage, unitId: string): string {
  return `${stage}:${unitId}`;
}

/**
 * Each planned unit completed, or belongs to a build whose stage the run did not reach. A unit
 * that the run did not reach is not unfinished work: the gate of its parent build stopped it.
 */
export function allPlannedWorkDone(units: ReturnType<typeof operationUnitSummary>): boolean {
  return Object.values(units).every((unit) => unit.completed + unit.notReached === unit.intended);
}

export function operationUnitSummary(status: Pick<RunOperationStatus, "manifest" | "events">) {
  const notReached = notReachedUnits(status.manifest, status.events);
  return {
    builder: unitSummary(
      status.events,
      "builder",
      status.manifest.planned.independentBuilderTrials,
      notReached.builder.size,
    ),
    final_capture: unitSummary(
      status.events,
      "final_capture",
      status.manifest.captureCells.length,
      notReached.final_capture.size,
    ),
    grading: unitSummary(
      status.events,
      "grading",
      status.manifest.gradingCells.length,
      notReached.grading.size,
    ),
    judgment: unitSummary(
      status.events,
      "judgment",
      status.manifest.judgmentBatches.length,
      notReached.judgment.size,
    ),
  };
}

export function freezeRunOperation(input: {
  operationId: string;
  inputHash: string;
  revision: EvalRevision;
  validationRecord: EvaluationReadinessRecord;
  quote: RunQuote;
  quoteSelectionId?: string;
  implementationCommit: string;
  buildIdentityHash: string;
  connectorArtifactHash: string;
  selectedModelIds: string[];
  selectedHarnessIds: string[];
  modelConcurrency: RunOperationManifest["modelConcurrency"];
  treatments: Treatment[];
  retainedSources: RunSubject[];
  views: RunOperationManifest["evals"][number]["views"];
  stage: RunOperationManifest["evals"][number]["stage"];
  publicFeedbackId: string | null;
  parentSourceId: string | null;
  gradingMode: RunOperationManifest["gradingMode"];
  captureCells: Array<Omit<RunOperationManifest["captureCells"][number], "requires">>;
  gradingCells: RunOperationManifest["gradingCells"];
  judgmentBatches: RunOperationManifest["judgmentBatches"];
  ceilingUsd: number;
}): RunOperationManifest {
  if (
    !["ready", "controls_checked"].includes(input.validationRecord.validation.status) ||
    input.validationRecord.validation.preparation !== "compiled" ||
    input.validationRecord.validation.revisionId !== input.revision.id ||
    (input.validationRecord.validation.status === "controls_checked" &&
      (!input.validationRecord.check ||
        input.validationRecord.check.status !== "checked" ||
        input.validationRecord.check.revisionId !== input.revision.id ||
        input.validationRecord.check.controlSetHash !==
          input.validationRecord.validation.controlSetHash ||
        input.validationRecord.check.implementationCommit !== input.implementationCommit ||
        input.validationRecord.check.connectorArtifactHash !== input.connectorArtifactHash)) ||
    (input.validationRecord.validation.status === "ready" && input.validationRecord.check !== null)
  )
    throw new Error(
      "Execution requires a compiled evaluation with correctly bound reference evidence when present",
    );
  const { id: quoteId, ...quoteBody } = input.quote;
  if (hashJson(quoteBody) !== quoteId || input.quote.subjectId !== input.revision.id)
    throw new Error("Run quote is not bound to this eval revision");
  if (input.quote.workload.independentBuilderTrials + input.retainedSources.length < 1)
    throw new Error("An operation needs at least one generated or registered subject");
  const quotedModels = new Set(input.quote.workload.modelWork.map((item) => item.modelId));
  if (
    quotedModels.size !== input.selectedModelIds.length ||
    input.selectedModelIds.some((id) => !quotedModels.has(id))
  )
    throw new Error("Selected models must match every paid role in the frozen quote");
  const publicTaskHash = hashJson(input.revision.publicTask);
  const evaluatorHash = hashJson(input.revision.privateEvaluator);
  const collectionPlanHash = hashJson(input.revision.privateEvaluator.studio);
  if (
    input.treatments.length !== input.quote.workload.independentBuilderTrials ||
    input.captureCells.length !==
      (input.quote.workload.independentBuilderTrials + input.retainedSources.length) *
        input.quote.workload.nativeCaptureRepetitions *
        input.views.length ||
    input.gradingCells.length +
      input.judgmentBatches.reduce((sum, batch) => sum + batch.criterionIds.length, 0) !==
      input.quote.workload.criterionOutcomes ||
    input.treatments.some(
      (treatment) =>
        treatment.task.publicTaskHash !== publicTaskHash ||
        treatment.task.evaluatorHash !== evaluatorHash ||
        treatment.task.collectionPlanHash !== collectionPlanHash,
    )
  )
    throw new Error("Frozen builder treatments differ from the eval revision or quote");
  const executable = new Map([
    ...input.revision.privateEvaluator.deterministic.map(
      (item) => [item.id, "deterministic"] as const,
    ),
    ...input.revision.privateEvaluator.codeQuality.map((item) => [item.id, "code"] as const),
    ...input.revision.privateEvaluator.visual.map((item) => [item.id, "visual"] as const),
    ...input.revision.privateEvaluator.unscaled.map((item) => [item.id, "unscaled"] as const),
  ]);
  if (input.gradingCells.some((cell) => executable.get(cell.criterionId) !== cell.method))
    throw new Error("Frozen grading cell differs from the eval criterion contract");
  const requiredCriterionIds = [
    ...input.revision.privateEvaluator.deterministic,
    ...input.revision.privateEvaluator.codeQuality,
    ...input.revision.privateEvaluator.visual,
    ...input.revision.privateEvaluator.unscaled,
  ]
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id);
  const body = {
    schema: "basalt-evals/run-operation-manifest" as const,
    inputHash: input.inputHash,
    evals: [
      {
        id: input.revision.id,
        draftId: input.revision.draftId,
        taskId: `${input.revision.publicTask.slug}:${publicTaskHash.slice(0, 12)}`,
        publicContentHash: publicEvalRevisionView(input.revision).publicContentHash,
        rubricHash: input.revision.rubricHash,
        controlSetHash: input.validationRecord.validation.controlSetHash,
        validationRecordHash: hashJson(input.validationRecord),
        requiredCriterionIds,
        views: structuredClone(input.views),
        stage: structuredClone(input.stage),
      },
    ],
    gradingMode: input.gradingMode,
    subjects: [
      ...input.retainedSources,
      ...input.treatments.map((treatment) => ({
        id: treatment.id,
        evalId: input.revision.id,
        kind: input.parentSourceId ? ("repair" as const) : ("generated" as const),
        builder: structuredClone(treatment),
        sourceId: null,
        parentSourceId: input.parentSourceId,
        publicFeedbackId: input.publicFeedbackId,
        stageIndex: input.stage.index,
        // The composition of a staged run links each later stage to its parent build.
        parentSubjectId: null,
      })),
    ],
    gates: [],
    protocol: null,
    quoteId,
    quoteSelectionId: input.quoteSelectionId ?? null,
    quoteHash: hashJson(input.quote),
    workloadCeilingUsd: workloadCeiling(input.quote),
    checkingCeilingUsd: checkingCeiling(input.quote),
    implementationCommit: input.implementationCommit,
    buildIdentityHash: input.buildIdentityHash,
    connectorArtifactHash: input.connectorArtifactHash,
    modelSnapshots: input.quote.models,
    modelConcurrency: { ...input.modelConcurrency },
    selectedModelIds: [...input.selectedModelIds],
    selectedHarnessIds: [...input.selectedHarnessIds],
    captureCells: input.captureCells.map((cell) => ({ ...structuredClone(cell), requires: [] })),
    gradingCells: structuredClone(input.gradingCells),
    judgmentBatches: input.judgmentBatches,
    unreviewedClaims: [...input.validationRecord.validation.unreviewedClaims],
    ceilingUsd: input.ceilingUsd,
    planned: {
      independentBuilderTrials: input.quote.workload.independentBuilderTrials,
      nativeCaptureRepetitions: input.quote.workload.nativeCaptureRepetitions,
      capturePasses: input.quote.workload.capturePasses,
      nativeRootLaunches: input.quote.workload.nativeRootLaunches,
      nativeClientLaunches: input.quote.workload.nativeClientLaunches,
      startupRecoveryRootLaunches: input.quote.workload.startupRecoveryRootLaunches,
      startupRecoveryClientLaunches: input.quote.workload.startupRecoveryClientLaunches,
      criterionOutcomes: input.quote.workload.criterionOutcomes,
      judgmentBatches: input.quote.workload.judgmentBatches,
    },
  };
  // The store checks each manifest before it saves it. A stage after the first stage of a
  // staged evaluation is complete only in the composed manifest, with its parent builds.
  return { ...body, id: input.operationId };
}

function replay(
  events: RunOperationEvent[],
  manifest: RunOperationManifest,
): {
  inFlightUnits: RunUnit[];
  completedUnits: string[];
  stopped: boolean;
} {
  // Several units can be in flight at once. A map keeps their start sequence.
  const inFlight = new Map<string, RunUnit>();
  let stopped = false;
  let previousHash: string | null = null;
  let graded = false;
  const completed = new Set<string>();
  const attempted = new Set<string>();
  const providerPauses = new Map<string, number>();
  // Per-stage attempt counts and indexed lookups keep a replay linear in its events.
  const attempts = new Map<RunStage, number>();
  const gates = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  const captures = new Map(manifest.captureCells.map((cell) => [cell.id, cell]));
  const gradingCells = new Map(manifest.gradingCells.map((cell) => [cell.id, cell]));
  const batches = new Map(manifest.judgmentBatches.map((batch) => [batch.id, batch]));
  const builders = new Set(generatedSubjects(manifest).map((subject) => subject.id));
  const subjects = new Map(manifest.subjects.map((subject) => [subject.id, subject]));
  // Builds that the run did not reach. They never start, and they are final.
  const notReached = new Set<string>();
  const builderEnds = new Map<string, RunOperationEvent["kind"]>();
  const sealed = new Set(
    manifest.subjects.filter((subject) => subject.sourceId).map((subject) => subject.id),
  );
  const stageLimits: Partial<Record<RunStage, number>> = {
    builder: manifest.planned.independentBuilderTrials,
    seal: manifest.subjects.filter((subject) => subject.sourceId !== null).length,
    review: manifest.gates.filter((gate) => gate.kind === "review").length,
    selection: manifest.gates.filter((gate) => gate.kind === "selection").length,
    final_capture: manifest.captureCells.length,
    grading: manifest.gradingCells.length,
    judgment: manifest.judgmentBatches.length,
    report: 1,
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const { id, ...body } = event;
    if (
      event.schema !== "basalt-evals/run-operation-event" ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      hashJson(body) !== id ||
      !Number.isFinite(Date.parse(event.at)) ||
      event.artifactHashes.some((value) => !hashPattern.test(value))
    )
      throw new Error("Run operation event chain is invalid");
    previousHash = id;
    if (completed.has("report:final"))
      throw new Error("A completed report seals the run operation");
    if (event.kind === "stop_requested") {
      if (event.stage !== null || event.unitId !== null || stopped)
        throw new Error("Invalid run stop event");
      stopped = true;
    } else if (event.kind === "resumed") {
      if (event.stage !== null || event.unitId !== null || !stopped)
        throw new Error("Run cannot resume an active operation");
      stopped = false;
    } else {
      if (event.stage === null || event.unitId === null || !unitPattern.test(event.unitId))
        throw new Error("Run stage event lacks a bounded unit identity");
      const key = eventUnit(event.stage, event.unitId);
      if (event.stage === "builder" && notReached.has(event.unitId))
        throw new Error("A build that the run did not reach cannot have more events");
      if (isNotReachedEvent(event)) {
        // A later stage that the run did not reach: its parent build ended without a
        // completion, its parent was not reached, or the parent completed and has a gate.
        const subject = subjects.get(event.unitId);
        const parentId = subject?.parentSubjectId ?? null;
        const parentEnd = parentId ? builderEnds.get(parentId) : undefined;
        if (
          !subject ||
          !builders.has(event.unitId) ||
          parentId === null ||
          attempted.has(key) ||
          event.artifactHashes.length !== 0 ||
          !(
            notReached.has(parentId) ||
            parentEnd === "failed" ||
            parentEnd === "incomplete" ||
            (parentEnd === "completed" &&
              manifest.evals.find((item) => item.id === subjects.get(parentId)!.evalId)!.stage
                .gateCriterionIds.length > 0)
          )
        )
          throw new Error("Only a later stage whose parent build did not pass can be not reached");
        notReached.add(event.unitId);
        continue;
      }
      if (event.kind === "started") {
        if (event.stage === "builder" && !builders.has(event.unitId))
          throw new Error("Builder stage is not a frozen treatment");
        if (event.stage === "builder") {
          // A later stage starts from the sealed build of its parent and after its gate checks.
          const parentId = subjects.get(event.unitId)!.parentSubjectId;
          if (
            parentId !== null &&
            (!completed.has(`builder:${parentId}`) ||
              gateCells(manifest, subjects.get(parentId)!).some(
                (cell) => !completed.has(`grading:${cell.id}`),
              ))
          )
            throw new Error("A later stage needs the completed build of the stage before it");
        }
        if (event.stage === "seal" && !sealed.has(event.unitId))
          throw new Error("Source sealing is not a frozen retained subject");
        if (event.stage === "review" || event.stage === "selection") {
          const gate = gates.get(event.unitId);
          if (
            !gate ||
            gate.kind !== event.stage ||
            gate.requires.some((id) => {
              const dependency = gates.get(id)!;
              return !completed.has(`${dependency.kind}:${id}`);
            })
          )
            throw new Error("Operation gate lacks its frozen prerequisites");
        }
        if (event.stage === "final_capture") {
          const cell = captures.get(event.unitId);
          if (!cell) throw new Error("Final capture is not a frozen acquisition cell");
          const sourceStage = operationSubject(manifest, cell.treatmentId).sourceId
            ? "seal"
            : "builder";
          if (!completed.has(`${sourceStage}:${cell.treatmentId}`))
            throw new Error("Final capture requires its exact sealed source receipt");
          if (
            cell.requires.some((id) => {
              const gate = gates.get(id)!;
              return !completed.has(`${gate.kind}:${id}`);
            })
          )
            throw new Error("Capture is withheld behind an unfulfilled operation gate");
        }
        if (event.stage === "grading") {
          const cell = gradingCells.get(event.unitId);
          if (!cell) throw new Error("Grading is not a frozen criterion cell");
          if (!completed.has(`final_capture:${cell.captureCellId}`))
            throw new Error("Grading requires its exact final capture");
        }
        if (event.stage === "judgment") {
          const batch = batches.get(event.unitId);
          if (
            !batch ||
            !completed.has(`final_capture:${batch.captureCellId}`) ||
            (batch.substitution?.donorCaptureCellId &&
              !completed.has(`final_capture:${batch.substitution.donorCaptureCellId}`))
          )
            throw new Error(
              "Judgment requires its exact original and presentation capture receipts",
            );
        }
        if (event.stage === "repair" && !graded)
          throw new Error("Repair requires a completed graded candidate");
        if (event.stage === "report" && event.unitId !== "final")
          throw new Error("The report stage has one frozen identity");
        if (
          event.stage === "report" &&
          !stopped &&
          (attempts.get("builder") ?? 0) + notReached.size <
            manifest.planned.independentBuilderTrials
        )
          throw new Error(
            "A report needs all planned builder trials attempted or an explicit stop",
          );
        if ((stopped && event.stage !== "report") || attempted.has(key))
          throw new Error("Run stage cannot be started twice or after a stop");
        // Builds, observations, checks and seals can overlap. A gate or the report runs alone.
        if (
          inFlight.size &&
          (gateStages.has(event.stage) ||
            [...inFlight.values()].some((unit) => gateStages.has(unit.stage)))
        )
          throw new Error("A gate or the report cannot overlap another stage");
        const limit = stageLimits[event.stage];
        if (limit !== undefined && (attempts.get(event.stage) ?? 0) >= limit)
          throw new Error("Run stage exceeds its frozen planned denominator");
        inFlight.set(key, { stage: event.stage, unitId: event.unitId });
        attempted.add(key);
        attempts.set(event.stage, (attempts.get(event.stage) ?? 0) + 1);
      } else {
        if (!inFlight.has(key)) throw new Error("Run stage receipt has no matching start");
        if (
          event.stage === "report" &&
          event.kind === "completed" &&
          event.artifactHashes.length !== 1
        )
          throw new Error("Completed report must bind one immutable report artifact");
        if (
          event.kind === "completed" &&
          event.stage === "final_capture" &&
          event.artifactHashes.length !== 2
        )
          throw new Error("Final capture needs signed receipt and evidence hashes");
        if (
          event.kind === "completed" &&
          (event.stage === "grading" || event.stage === "judgment") &&
          event.artifactHashes.length !== 1
        )
          throw new Error("Grading needs one bound criterion result hash");
        if (event.kind === "completed") {
          completed.add(key);
          if (event.stage === "grading") graded = true;
        }
        if (event.stage === "builder" && ["completed", "failed", "incomplete"].includes(event.kind))
          builderEnds.set(event.unitId, event.kind);
        if (event.kind === "paused") {
          if (
            (event.stage !== "builder" && event.stage !== "judgment") ||
            event.artifactHashes.length !== 1
          )
            throw new Error("Only a bound build or judgment checkpoint may pause for budget");
          if (attempted.delete(key)) attempts.set(event.stage, attempts.get(event.stage)! - 1);
        }
        if (event.kind === "provider_paused") {
          if (
            (event.stage !== "builder" && event.stage !== "judgment") ||
            event.artifactHashes.length !== 1
          )
            throw new Error(
              "Only a build or judgment with one pause record may pause for a provider",
            );
          const count = (providerPauses.get(key) ?? 0) + 1;
          if (count > MAX_PROVIDER_PAUSES)
            throw new Error("A build or judgment exceeds its limit of provider pauses");
          providerPauses.set(key, count);
          if (attempted.delete(key)) attempts.set(event.stage, attempts.get(event.stage)! - 1);
        }
        if (event.kind === "not_dispatched") {
          if (event.stage !== "final_capture" || event.artifactHashes.length !== 0)
            throw new Error("Only an undispatched capture can release its attempt");
          if (attempted.delete(key)) attempts.set(event.stage, attempts.get(event.stage)! - 1);
        }
        inFlight.delete(key);
      }
    }
  }
  return { inFlightUnits: [...inFlight.values()], completedUnits: [...completed], stopped };
}

/** The latest event of each build and judgment. */
function latestPaidEvents(events: RunOperationEvent[]): RunOperationEvent[] {
  const latest = new Map<string, RunOperationEvent>();
  for (const event of events)
    if (event.stage === "builder" || event.stage === "judgment")
      latest.set(`${event.stage}:${event.unitId}`, event);
  return [...latest.values()];
}

/** Builds and judgments whose latest event paused them at the spending limit. */
export function pausedUnits(status: Pick<RunOperationStatus, "manifest" | "events">) {
  return latestPaidEvents(status.events).filter((event) => event.kind === "paused");
}

/** The sequence of the last `resumed` event, or 0. Later provider pauses still hold work. */
function lastResume(events: RunOperationEvent[]): number {
  let sequence = 0;
  for (const event of events) if (event.kind === "resumed") sequence = event.sequence;
  return sequence;
}

/**
 * Builds and judgments whose latest event paused them for a provider failure, with their
 * records. A pause before the last `resumed` event is admitted again. A later pause waits for
 * the next Resume. A higher spending limit does not admit it.
 */
export function providerPausedUnits(
  status: Pick<RunOperationStatus, "events" | "pauseRecords">,
): Array<{ event: RunOperationEvent; record: PauseRecord; admitted: boolean }> {
  const resumed = lastResume(status.events);
  return latestPaidEvents(status.events)
    .filter((event) => event.kind === "provider_paused")
    .map((event) => ({
      event,
      record: status.pauseRecords[event.artifactHashes[0]!]!,
      admitted: event.sequence < resumed,
    }));
}

/**
 * The holds of the provider pauses since the last `resumed` event. An account pause holds each
 * paid unit. A model pause, or two persistent pauses with one dependency, hold the units of
 * that model. The holds come from the durable event chain, so they survive a crash.
 */
export function providerHolds(
  status: Pick<RunOperationStatus, "events" | "manifest" | "pauseRecords">,
): { account: PauseRecord | null; models: Map<string, PauseRecord> } {
  const resumed = lastResume(status.events);
  let account: PauseRecord | null = null;
  const models = new Map<string, PauseRecord>();
  const persistent = new Map<string, number>();
  for (const event of status.events) {
    if (event.kind !== "provider_paused" || event.sequence < resumed) continue;
    const record = status.pauseRecords[event.artifactHashes[0]!]!;
    if (record.scope === "account") {
      account ??= record;
      continue;
    }
    const model = unitModelId(status.manifest, { stage: event.stage!, unitId: event.unitId! });
    if (!model || models.has(model)) continue;
    const failures = (persistent.get(`${model}\0${record.dependency}`) ?? 0) + 1;
    persistent.set(`${model}\0${record.dependency}`, failures);
    if (record.scope === "model" || failures >= 2) models.set(model, record);
  }
  return { account, models };
}

/**
 * The request ordinals of the saved failures that paused a judgment. After a resume, its
 * client sends the next ordinal instead of a replay of such a failure.
 */
export function acknowledgedOrdinals(
  status: Pick<RunOperationStatus, "events" | "pauseRecords">,
  batchId: string,
): number[] {
  return status.events
    .filter(
      (event) =>
        event.kind === "provider_paused" && event.stage === "judgment" && event.unitId === batchId,
    )
    .map((event) => status.pauseRecords[event.artifactHashes[0]!]!.ordinal)
    .filter((ordinal): ordinal is number => ordinal !== null);
}

/** The pause record that holds a paid unit before its next request, or null. */
export function unitHold(
  holds: ReturnType<typeof providerHolds>,
  manifest: RunOperationManifest,
  unit: Pick<RunUnit, "stage" | "unitId">,
): PauseRecord | null {
  if (unit.stage !== "builder" && unit.stage !== "judgment") return null;
  if (holds.account) return holds.account;
  if (!holds.models.size) return null;
  const model = unitModelId(manifest, unit);
  return (model !== null ? holds.models.get(model) : undefined) ?? null;
}

function isPauseRecord(value: unknown): value is PauseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "dependency,errorClass,failureId,ordinal,scope" &&
    ["account", "model", "persistent"].includes(String(record.scope)) &&
    (record.dependency === null ||
      (typeof record.dependency === "string" && hashPattern.test(record.dependency))) &&
    typeof record.errorClass === "string" &&
    record.errorClass.length > 0 &&
    record.errorClass.length <= 256 &&
    typeof record.failureId === "string" &&
    hashPattern.test(record.failureId) &&
    (record.ordinal === null ||
      (Number.isSafeInteger(record.ordinal) && (record.ordinal as number) >= 1))
  );
}

/** The records that the provider pauses of the chain bind, each verified against its hash. */
function boundPauseRecords(
  events: RunOperationEvent[],
  records: Record<string, PauseRecord>,
): Record<string, PauseRecord> {
  const bound: Record<string, PauseRecord> = {};
  for (const event of events) {
    if (event.kind !== "provider_paused") continue;
    const hash = event.artifactHashes[0]!;
    const record = records[hash];
    if (!isPauseRecord(record) || hashJson(record) !== hash)
      throw new Error("A provider pause does not bind its saved pause record");
    bound[hash] = record;
  }
  return bound;
}

export function operationStatus(
  manifest: RunOperationManifest,
  events: RunOperationEvent[],
  spending: SpendLedgerState,
  criterionOutcomes: RunOperationStatus["criterionOutcomes"],
  pauseRecords: Record<string, PauseRecord> = {},
  state = replay(events, manifest),
): RunOperationStatus {
  const pendingBilling = spending.entries.some((entry) => entry.status === "pending");
  const uncertainBilling = spending.entries.some((entry) => entry.status !== "billed");
  const billedUsd = spending.entries.reduce((sum, entry) => sum + (entry.billedUsd ?? 0), 0);
  const reservedUsd = spending.entries.reduce(
    (sum, entry) => sum + (entry.status !== "billed" ? entry.reservedUsd : 0),
    0,
  );
  const uncertainRequests = spending.entries.filter((entry) => entry.status !== "billed").length;
  // Cost and completeness of the measurement itself; claim review is reported separately. The
  // units of a stage that the run did not reach are outside the measurement. An insufficient
  // answer is an answer, so only an incomplete outcome leaves the measurement incomplete.
  const notReached = notReachedUnits(manifest, events);
  const measurementComplete =
    manifest.gradingMode === "all" &&
    state.completedUnits.includes("report:final") &&
    [
      ["builder", manifest.planned.independentBuilderTrials - notReached.builder.size],
      ["final_capture", manifest.captureCells.length - notReached.final_capture.size],
      ["grading", manifest.gradingCells.length - notReached.grading.size],
      ["judgment", manifest.judgmentBatches.length - notReached.judgment.size],
    ].every(
      ([stage, count]) =>
        state.completedUnits.filter((unit) => unit.startsWith(`${stage}:`)).length === count,
    ) &&
    !uncertainBilling &&
    criterionOutcomes.every((item) => item.outcome !== "incomplete");
  return {
    manifest,
    events,
    ...state,
    pauseRecords: boundPauseRecords(events, pauseRecords),
    finished: state.completedUnits.includes("report:final"),
    measurementComplete,
    uncertainBilling,
    pendingBilling,
    billedUsd,
    reservedUsd,
    uncertainRequests,
    availableUsd: Math.max(0, spending.authorizations.at(-1)!.ceilingUsd - billedUsd - reservedUsd),
    criterionOutcomes,
    authorizationHash: hashJson(spending.authorizations),
  };
}

function saveOperationProjection(journal: OperationJournal, status: RunOperationStatus): void {
  journal.put("operations", status.manifest.id, status);
  const event = status.events.at(-1);
  if (event)
    journal.project(`activity:${status.manifest.id}`, event.id, {
      search: `${event.kind} ${event.stage ?? ""} ${event.reason ?? ""}`,
      status: event.kind,
      sort: String(event.sequence).padStart(12, "0"),
      body: event,
    });
  projectOperationProgress(journal, status);
  projectRun(journal, status.manifest.id, status);
}

/** Save the bounded progress record that the console polls. `catalog rebuild` also calls it. */
export function projectOperationProgress(
  journal: OperationJournal,
  status: RunOperationStatus,
): void {
  const {
    events: _events,
    manifest,
    completedUnits,
    criterionOutcomes,
    pauseRecords: _pauseRecords,
    ...progress
  } = status;
  journal.put("operation_progress", manifest.id, {
    ...progress,
    manifest: {
      id: manifest.id,
      planned: manifest.planned,
      protocolKind: manifest.protocol?.kind ?? null,
    },
    completedStageCount: completedUnits.length,
    pausedAuthorizationHashes: pausedUnits(status).map((event) => event.artifactHashes[0]!),
    providerPauses: providerPausedUnits(status)
      .filter((pause) => !pause.admitted)
      .map(({ event, record }) => ({
        stage: event.stage as "builder" | "judgment",
        unitId: event.unitId!,
        scope: record.scope,
        errorClass: record.errorClass,
      })),
    answers: runAnswerCounts(status),
    criterionOutcomes: criterionOutcomes.slice(-20),
  });
}

/** Browser polling reads two projections, with no historical events, files, or grading. */
export async function operationProgress(root: string, operationId: string) {
  if (!operationPattern.test(operationId)) throw new Error("Invalid run operation ID");
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      return readExecutionProgress(journal, operationId);
    });
  } finally {
    journal.close();
  }
}

/** Immutable manifest and chained stage receipts; uncertain work is never auto-repeated. */
export class RunOperationStore {
  private readonly files: RepositoryFiles;
  private readonly base: string;
  private readonly root: string;
  readonly ledger: DurableSpendLedger;

  constructor(
    root: string,
    readonly operationId: string,
    readonly manifestHash: string,
    readonly inputHash: string,
  ) {
    if (
      !operationPattern.test(operationId) ||
      !hashPattern.test(manifestHash) ||
      !hashPattern.test(inputHash)
    )
      throw new Error("Invalid run operation identity");
    this.files = new RepositoryFiles(root);
    this.root = resolve(root);
    this.base = `.basalt-evals/eval-operations/${operationId}`;
    this.ledger = new DurableSpendLedger(root, operationId, hashJson({ inputHash }));
  }

  async create(manifest: RunOperationManifest): Promise<void> {
    assertManifest(manifest);
    if (
      manifest.id !== this.operationId ||
      manifest.inputHash !== this.inputHash ||
      manifestHash(manifest) !== this.manifestHash
    )
      throw new Error("Run operation manifest identity mismatch");
    await this.verifyValidationRecord(manifest);
    await this.files.directory(this.base);
    const authorization = { quoteHash: manifest.quoteHash, ceilingUsd: manifest.ceilingUsd };
    let spending;
    try {
      spending = await this.ledger.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.ledger.initialize(authorization);
      spending = await this.ledger.read();
    }
    const existingAuthorization = spending.authorizations.find(
      (item) => item.quoteHash === authorization.quoteHash,
    );
    if (existingAuthorization) {
      if (existingAuthorization.ceilingUsd < authorization.ceilingUsd)
        throw new Error("Run already has a different cumulative spending ceiling");
    } else {
      await this.ledger.authorize({
        ...authorization,
        ceilingUsd: Math.max(authorization.ceilingUsd, spending.authorizations.at(-1)!.ceilingUsd),
      });
    }
    try {
      await this.files.writeJson(`${this.base}/manifest.json`, manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.files.json<RunOperationManifest>(`${this.base}/manifest.json`);
      if (hashJson(existing) !== this.manifestHash)
        throw new Error("Operation identity already freezes different work");
    }
    const journal = await OperationJournal.open(this.root);
    try {
      journal.transaction(() => {
        const prior = journal.read<RunOperationStatus>("operations", this.operationId);
        if (prior && manifestHash(prior.manifest) !== this.manifestHash)
          throw new Error("Operation journal manifest changed");
        if (!prior) saveOperationProjection(journal, operationStatus(manifest, [], spending, []));
      });
    } finally {
      journal.close();
    }
  }

  private async events(): Promise<RunOperationEvent[]> {
    return (await this.progress()).events;
  }

  /** Projection reads never load candidates, captures, evaluators, or execute graders. */
  async progress(): Promise<RunOperationStatus> {
    const journal = await OperationJournal.open(this.root);
    try {
      return this.progressIn(journal);
    } finally {
      journal.close();
    }
  }

  /** The progress from a journal that the caller has open. */
  progressIn(journal: OperationJournal): RunOperationStatus {
    const stored = journal.read<RunOperationStatus>("operations", this.operationId);
    if (!stored || manifestHash(stored.manifest) !== this.manifestHash)
      throw new Error("No matching current operation journal; historical files are archives");
    const totals = journal.read<ReturnType<typeof spendingProjection>>(
      "spending_progress",
      this.operationId,
    );
    if (!totals) throw new Error("Operation spending projection is missing");
    return {
      ...stored,
      ...totals,
      measurementComplete: stored.measurementComplete && !totals.uncertainBilling,
    };
  }

  /**
   * The run as its events show it: the projection, with the manifest checked and the chain of
   * events replayed. It verifies no receipt of a completed unit, so it suits a view that shows
   * only events and failures.
   */
  async eventStatus(): Promise<RunOperationStatus> {
    const status = await this.progress();
    assertManifest(status.manifest);
    replay(status.events, status.manifest);
    return status;
  }

  async read(): Promise<RunOperationStatus> {
    const manifest = await this.files.json<RunOperationManifest>(`${this.base}/manifest.json`);
    assertManifest(manifest);
    if (
      manifest.id !== this.operationId ||
      manifest.inputHash !== this.inputHash ||
      manifestHash(manifest) !== this.manifestHash
    )
      throw new Error("Frozen run operation manifest changed");
    await this.verifyValidationRecord(manifest);
    const [events, spending] = await Promise.all([this.events(), this.ledger.read()]);
    const saved: Record<string, PauseRecord> = {};
    for (const event of events)
      if (event.kind === "provider_paused")
        saved[event.artifactHashes[0]!] = await this.files.json<PauseRecord>(
          `${this.base}/pauses/${event.artifactHashes[0]}.json`,
        );
    const pauseRecords = boundPauseRecords(events, saved);
    const graded: RunCriterionArtifact[] = [];
    for (const event of events)
      if (event.stage === "builder" && event.kind === "completed")
        await this.verifyBuilderReceipt(event);
      else if (event.stage === "seal" && event.kind === "completed")
        await this.verifySourceReceipt(event, manifest);
      else if (
        (event.stage === "review" || event.stage === "selection") &&
        event.kind === "completed"
      )
        await this.verifyGateReceipt(event, manifest, events);
      else if (event.stage === "final_capture" && event.kind === "completed")
        await this.verifyCaptureReceipt(event, manifest, events);
      else if (event.stage === "grading" && event.kind === "completed")
        graded.push(await this.verifyGradingReceipt(event, manifest, events));
    const criterionOutcomes: RunOperationStatus["criterionOutcomes"] = graded.map((artifact) => ({
      cellId: artifact.cellId,
      criterionId: artifact.criterion.criterionId,
      outcome:
        artifact.criterion.outcome === "incomplete" && artifact.criterion.score !== undefined
          ? ("scored" as const)
          : artifact.criterion.outcome,
      decisionAuthority: artifact.decisionAuthority,
      evidence: artifact.criterion.evidence,
    }));
    for (const event of events.filter(
      (event) => event.stage === "judgment" && event.kind === "completed",
    ))
      criterionOutcomes.push(
        ...(await this.judgmentOutcomes(
          event,
          manifest,
          acknowledgedOrdinals({ events, pauseRecords }, event.unitId!),
        )),
      );
    const reportEvent = events.find(
      (event) => event.stage === "report" && event.kind === "completed",
    );
    if (reportEvent) {
      const report = await this.files.json<RunOperationReport>(`${this.base}/report.json`);
      if (
        report.schema !== "basalt-evals/run-operation-report" ||
        report.operationId !== this.operationId ||
        report.manifestHash !== this.manifestHash ||
        hashJson(report) !== reportEvent.artifactHashes[0]
      )
        throw new Error("Completed report bytes differ from the operation receipt");
    }
    return operationStatus(manifest, events, spending, criterionOutcomes, pauseRecords);
  }

  /** Verify the consumed dependency closure, without regrading unrelated historical cells. */
  async readForStage(stage: RunStage, unitId: string): Promise<RunOperationStatus> {
    if (gateStages.has(stage)) return this.read();
    const state = await this.progress();
    replay(state.events, state.manifest);
    await this.verifyStageClosure(state, stage, unitId);
    return state;
  }

  /** The frozen manifest and the receipts one non-gate stage consumes, given a replayed chain. */
  private async verifyStageClosure(
    state: RunOperationStatus,
    stage: RunStage,
    unitId: string,
  ): Promise<void> {
    const manifest = state.manifest;
    if (hashJson(await this.files.json(`${this.base}/manifest.json`)) !== this.manifestHash)
      throw new Error("Frozen operation manifest changed");
    assertManifest(manifest);
    const verifiedEvaluations = new Set<string>();
    const completed = (stage: RunStage, id: string) =>
      state.events.find(
        (event) => event.stage === stage && event.unitId === id && event.kind === "completed",
      );
    const source = async (id: string) => {
      const evaluationId = subjectEval(manifest, id).id;
      if (!verifiedEvaluations.has(evaluationId)) {
        await this.verifyValidationRecord(manifest, evaluationId);
        verifiedEvaluations.add(evaluationId);
      }
      const subject = operationSubject(manifest, id),
        event = completed(subject.sourceId ? "seal" : "builder", id);
      if (event) {
        if (subject.sourceId) await this.verifySourceReceipt(event, manifest);
        else await this.verifyBuilderReceipt(event);
      }
    };
    const capture = async (id: string) => {
      const cell = manifest.captureCells.find((cell) => cell.id === id);
      if (!cell) throw new Error("Unknown frozen capture dependency");
      await source(cell.treatmentId);
      for (const gateId of cell.requires) {
        const gate = manifest.gates.find((gate) => gate.id === gateId)!;
        const event = completed(gate.kind, gateId);
        if (event) await this.verifyGateBinding(event, manifest);
      }
      const event = completed("final_capture", id);
      if (event) await this.verifyCaptureReceipt(event, manifest, state.events);
    };
    if (stage === "builder" || stage === "seal") await source(unitId);
    // A later stage consumes the sealed build of the stage before it.
    const parentId =
      stage === "builder" ? operationSubject(manifest, unitId).parentSubjectId : null;
    if (parentId) await source(parentId);
    if (stage === "final_capture") await capture(unitId);
    if (stage === "grading") {
      const cell = manifest.gradingCells.find((cell) => cell.id === unitId);
      if (!cell) throw new Error("Unknown frozen grading dependency");
      await capture(cell.captureCellId);
      const event = completed("grading", unitId);
      if (event) await this.verifyGradingReceipt(event, manifest, state.events);
    }
    if (stage === "judgment") {
      const batch = manifest.judgmentBatches.find((batch) => batch.id === unitId);
      if (!batch) throw new Error("Unknown frozen judgment dependency");
      await capture(batch.captureCellId);
      if (batch.substitution?.donorCaptureCellId)
        await capture(batch.substitution.donorCaptureCellId);
      const event = completed("judgment", unitId);
      if (event) await this.judgmentOutcomes(event, manifest, acknowledgedOrdinals(state, unitId));
    }
  }

  /**
   * Append one event to the chain. Concurrent units of this process append one at a time. If
   * another process appends first, for example a Stop from the console, the append reads the
   * chain again and makes its checks again.
   */
  async append(
    input: Omit<RunOperationEvent, "schema" | "id" | "sequence" | "previousHash">,
    pause?: PauseRecord,
  ): Promise<RunOperationEvent> {
    const key = `${this.root}\0${this.operationId}`;
    const previous = appendTurns.get(key) ?? Promise.resolve();
    let done!: () => void;
    const turn = new Promise<void>((resolve) => (done = resolve));
    appendTurns.set(key, turn);
    try {
      await previous;
      for (let attempt = 1; ; attempt += 1)
        try {
          return await this.appendOnce(input, pause);
        } catch (error) {
          if (!(error instanceof ConcurrentOperationUpdate) || attempt >= 5) throw error;
        }
    } finally {
      done();
      if (appendTurns.get(key) === turn) appendTurns.delete(key);
    }
  }

  /**
   * Save the record of a provider pause, then append its `provider_paused` event. The unit
   * leaves the units in flight, and only a later `resumed` event admits it again.
   */
  async appendProviderPause(input: {
    stage: "builder" | "judgment";
    unitId: string;
    record: PauseRecord;
    reason: string;
  }): Promise<RunOperationEvent> {
    const hash = hashJson(input.record);
    await this.files.writeJsonOnce(`${this.base}/pauses/${hash}.json`, input.record);
    return this.append(
      {
        kind: "provider_paused",
        stage: input.stage,
        unitId: input.unitId,
        artifactHashes: [hash],
        reason: input.reason,
        at: new Date().toISOString(),
      },
      input.record,
    );
  }

  private async appendOnce(
    input: Omit<RunOperationEvent, "schema" | "id" | "sequence" | "previousHash">,
    pause?: PauseRecord,
  ): Promise<RunOperationEvent> {
    const state = await this.progress();
    if ((input.kind === "provider_paused") !== (pause !== undefined))
      throw new Error("A provider pause needs exactly its saved pause record");
    const paidStage =
      ["preparation", "controls", "builder", "public_development", "repair", "judgment"].includes(
        input.stage ?? "",
      ) ||
      (input.stage === "grading" &&
        state.manifest.gradingCells.find((item) => item.id === input.unitId)?.method !==
          "deterministic");
    // A pending charge that a live client of this run holds does not block other units.
    const unowned = (await this.ledger.unownedPending()).length > 0;
    if (input.kind === "started" && input.stage !== "report") {
      if (state.stopped || state.finished)
        throw new Error("Run cannot start a unit while it is stopped or finished");
      if (paidStage && unowned)
        throw new Error(
          "Run cannot dispatch paid work while a request has a pending charge without an owner",
        );
    }
    if (input.kind === "resumed" && unowned)
      throw new Error("Run cannot resume while a paid request has a pending charge");
    const body = {
      schema: "basalt-evals/run-operation-event" as const,
      sequence: state.events.length + 1,
      previousHash: state.events.at(-1)?.id ?? null,
      ...input,
    };
    const event = { ...body, id: hashJson(body) };
    const events = [...state.events, event];
    const replayed = replay(events, state.manifest);
    // Stopping only withdraws permission to dispatch. Damaged retained evidence
    // must not prevent it; resume and every execution stage still verify evidence.
    // A non-gate stage verifies its closure against the state replayed here; the
    // journal transaction below rejects any concurrent update to that state.
    if (input.kind !== "stop_requested") {
      if (input.stage && input.unitId && !gateStages.has(input.stage))
        await this.verifyStageClosure(state, input.stage, input.unitId);
      else if (((await this.read()).events.at(-1)?.id ?? null) !== body.previousHash)
        throw new ConcurrentOperationUpdate();
    }
    const outcomes = [...state.criterionOutcomes];
    let builderMetrics: { costUsd: number | null; toolCalls: number } | null = null;
    if (event.stage === "builder" && event.kind === "completed") {
      await this.verifyBuilderReceipt(event);
      const run = await this.files.json<AgentRun>(
        `${this.base}/builder/${event.unitId}/agent-run.json`,
      );
      builderMetrics = {
        costUsd: run.usage.providerReportedCostUsd,
        toolCalls: run.trace.filter((item) => item.kind === "tool_call").length,
      };
    }
    if (event.stage === "seal" && event.kind === "completed")
      await this.verifySourceReceipt(event, state.manifest);
    if ((event.stage === "review" || event.stage === "selection") && event.kind === "completed")
      await this.verifyGateReceipt(event, state.manifest, events);
    if (event.stage === "final_capture" && event.kind === "completed")
      await this.verifyCaptureReceipt(event, state.manifest, events);
    if (isNotReachedEvent(event)) {
      const subject = operationSubject(state.manifest, event.unitId!);
      if (stageReach(state, subject) !== "not_reached")
        throw new Error("The run can still reach the stage of this build");
    } else if (event.kind === "not_dispatched") {
      const studio = this.base + "/capture/" + event.unitId + "/studio/native";
      if (
        (await this.files.exists(studio + "/remote-job.json")) ||
        (await this.files.exists(studio + "/manifest.json"))
      )
        throw new Error("A dispatched or signed capture must be reconciled, never repeated");
    }
    if (event.stage === "grading" && event.kind === "completed") {
      const artifact = await this.verifyGradingReceipt(event, state.manifest, events);
      outcomes.push({
        cellId: artifact.cellId,
        criterionId: artifact.criterion.criterionId,
        outcome:
          artifact.criterion.outcome === "incomplete" && artifact.criterion.score !== undefined
            ? "scored"
            : artifact.criterion.outcome,
        decisionAuthority: artifact.decisionAuthority,
        evidence: artifact.criterion.evidence,
      });
    }
    if (event.stage === "judgment" && event.kind === "completed")
      outcomes.push(
        ...(await this.judgmentOutcomes(
          event,
          state.manifest,
          acknowledgedOrdinals(state, event.unitId!),
        )),
      );
    if (event.stage === "report" && event.kind === "completed") {
      const report = await this.files.json<RunOperationReport>(`${this.base}/report.json`);
      if (
        report.operationId !== this.operationId ||
        report.manifestHash !== this.manifestHash ||
        hashJson(report) !== event.artifactHashes[0]
      )
        throw new Error("Completed report does not bind a saved operation summary");
    }
    const journal = await OperationJournal.open(this.root);
    try {
      journal.transaction(() => {
        const prior = journal.read<RunOperationStatus>("operations", this.operationId);
        if (!prior) throw new Error("No matching current operation journal");
        if ((prior.events.at(-1)?.id ?? null) !== body.previousHash)
          throw new ConcurrentOperationUpdate();
        const spending = journal.read<SpendLedgerState>("spending", this.operationId);
        if (!spending) throw new Error("Operation spending state is missing");
        if (
          (input.kind === "resumed" || (input.kind === "started" && paidStage)) &&
          this.ledger.unownedIn(spending).length
        )
          throw new Error("Pending paid work must be reconciled before dispatch");
        if (event.kind === "completed" && event.stage && event.unitId)
          resolveExecutionFailures(journal, this.operationId, event.stage, event.unitId);
        if (builderMetrics)
          journal.put("builder_metrics", `${this.operationId}:${event.unitId}`, builderMetrics);
        saveOperationProjection(
          journal,
          operationStatus(
            state.manifest,
            events,
            spending,
            outcomes,
            pause
              ? { ...state.pauseRecords, [event.artifactHashes[0]!]: pause }
              : state.pauseRecords,
            replayed,
          ),
        );
      });
    } finally {
      journal.close();
    }
    return event;
  }

  private async judgmentOutcomes(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
    acknowledged: number[],
  ): Promise<RunOperationStatus["criterionOutcomes"]> {
    if (event.artifactHashes.length !== 1)
      throw new Error("Judgment requires one immutable result");
    const artifact = await verifyJudgmentArtifact(
      this.root,
      manifest,
      event.unitId!,
      event.artifactHashes[0]!,
      this.ledger,
      acknowledged,
    );
    return artifact.decisions.map((decision) => ({
      cellId: artifact.batchId,
      criterionId: decision.criterionId,
      outcome:
        decision.verdict === "satisfied"
          ? "verified"
          : decision.verdict === "violated"
            ? "rejected"
            : decision.score !== null
              ? "scored"
              : "insufficient",
      decisionAuthority: artifact.decisionAuthorities[decision.criterionId]!,
      evidence: [...artifact.provenance.evidenceHashes, ...artifact.provenance.frameHashes],
    }));
  }

  private async verifySourceReceipt(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
  ): Promise<void> {
    const subject = operationSubject(manifest, event.unitId!);
    if (!subject.sourceId || event.artifactHashes.length !== 2)
      throw new Error("Retained source receipt is missing");
    const { source } = await readRegisteredSource(this.root, subject.sourceId);
    if (
      event.artifactHashes[0] !== source.id ||
      event.artifactHashes[1] !== source.candidate.rootHash
    )
      throw new Error("Retained source receipt differs from its frozen inventory");
  }

  /**
   * A stage that consumes a gate checks that its receipt is the exact one the chain
   * recorded. Protocol decisions are re-derived from their evidence when the gate is
   * appended and on every full read, not again for each stage behind the gate.
   */
  private async verifyGateBinding(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
  ): Promise<void> {
    if (!manifest.protocol) return this.verifyGateReceipt(event, manifest, []);
    const receipt = await this.files.json<{ manifestHash: string; gateId: string }>(
      `${this.base}/gates/${event.unitId}.json`,
    );
    if (
      event.artifactHashes.length !== 1 ||
      event.artifactHashes[0] !== hashJson(receipt) ||
      receipt.manifestHash !== manifestHash(manifest) ||
      receipt.gateId !== event.unitId
    )
      throw new Error("Gate lacks an immutable manifest-bound decision receipt");
  }

  private async verifyGateReceipt(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
    events: RunOperationEvent[],
  ): Promise<void> {
    if (manifest.protocol)
      return verifyProtocolGate({
        root: this.root,
        manifest,
        event,
        events,
        spending: await this.ledger.read(),
      });
    const gate = manifest.gates.find(
      (gate) => gate.id === event.unitId && gate.kind === event.stage,
    );
    const receipt = await this.files.json<{
      manifestHash: string;
      gateId: string;
      evidenceHashes: string[];
    }>(`${this.base}/gates/${event.unitId}.json`);
    if (
      !gate ||
      event.artifactHashes.length !== 1 ||
      event.artifactHashes[0] !== hashJson(receipt) ||
      receipt.manifestHash !== manifestHash(manifest) ||
      receipt.gateId !== gate.id ||
      !receipt.evidenceHashes.length ||
      receipt.evidenceHashes.some((hash) => !hashPattern.test(hash))
    )
      throw new Error("Gate lacks an immutable manifest-bound decision receipt");
  }

  private async verifyBuilderReceipt(event: RunOperationEvent): Promise<void> {
    if (!event.unitId || event.artifactHashes.length !== 2)
      throw new Error("Completed builder stage needs a run and sealed candidate hash");
    const base = `${this.base}/builder/${event.unitId}`;
    const run = await this.files.json<AgentRun>(`${base}/agent-run.json`);
    assertAgentRun(run);
    const inventory = await inventoryTree(resolve(this.root, base, "candidate"));
    if (
      run.treatmentId !== event.unitId ||
      hashJson(run) !== event.artifactHashes[0] ||
      run.candidate.rootHash !== event.artifactHashes[1] ||
      hashJson(inventory) !== run.candidate.rootHash ||
      hashJson(inventory) !== hashJson(run.candidate.files)
    )
      throw new Error("Completed builder stage does not bind its saved run and sealed source");
  }

  private async verifyValidationRecord(
    manifest: RunOperationManifest,
    evaluationId?: string,
  ): Promise<void> {
    const claims = new Set<string>();
    for (const evaluation of manifest.evals.filter(
      (item) => !evaluationId || item.id === evaluationId,
    )) {
      const record = await readReadinessRecord(
        this.root,
        evaluation.id,
        evaluation.validationRecordHash,
      );
      if (
        record.validation.schema !== "basalt-evals/eval-validation" ||
        !["ready", "controls_checked"].includes(record.validation.status) ||
        record.validation.controlSetHash !== evaluation.controlSetHash ||
        (record.validation.status === "ready"
          ? record.check !== null
          : !record.check ||
            record.check.status !== "checked" ||
            record.check.controlSetHash !== evaluation.controlSetHash ||
            record.check.implementationCommit !== manifest.implementationCommit ||
            record.check.connectorArtifactHash !== manifest.connectorArtifactHash)
      )
        throw new Error("Frozen run refers to a different control validation or release");
      for (const claim of record.validation.unreviewedClaims) claims.add(claim);
    }
    if (
      evaluationId
        ? [...claims].some((claim) => !manifest.unreviewedClaims.includes(claim))
        : hashJson([...claims].sort()) !== hashJson([...manifest.unreviewedClaims].sort())
    )
      throw new Error("Frozen unresolved claims differ from control validation");
  }

  private async verifyCaptureReceipt(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
    events: RunOperationEvent[],
  ): Promise<void> {
    const cell = manifest.captureCells.find((item) => item.id === event.unitId);
    if (!cell || event.artifactHashes.length !== 2)
      throw new Error("Final capture is not a frozen signed acquisition cell");
    const builder = events.find(
      (item) =>
        ["builder", "seal"].includes(item.stage ?? "") &&
        item.unitId === cell.treatmentId &&
        item.kind === "completed",
    );
    if (!builder) throw new Error("Final capture lacks its sealed source receipt");
    const studio = resolve(this.root, this.base, "capture", cell.id, "studio");
    const receiptBytes = await readFile(resolve(studio, "native/manifest.json"));
    if (contentHash(receiptBytes) !== event.artifactHashes[0])
      throw new Error("Final capture signed receipt bytes changed");
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
    await verifyWorkerArtifacts(
      studio,
      receipt,
      await readFile(
        resolve(this.root, ".basalt-evals/native-worker/isolated-public-key.pem"),
        "utf8",
      ),
    );
    const session = await loadStudioSession(studio);
    const evidence = await this.files.json<StudioEvidence>(
      `${this.base}/capture/${cell.id}/studio/evidence.json`,
    );
    assertStudioEvidence(evidence);
    if (
      receipt.manifest.status !== "complete" ||
      !receipt.manifest.completion ||
      !receipt.manifest.artifacts.some((artifact) => artifact.file === "evidence.json") ||
      receipt.manifest.sessionId !== session.id ||
      receipt.manifest.candidateHash !== builder.artifactHashes[1] ||
      receipt.manifest.collectionPlanHash !== session.collectionPlanHash ||
      session.collectionPlanHash !== hashJson(capturePlan(manifest, cell.id)) ||
      session.candidateHash !== builder.artifactHashes[1] ||
      session.treatmentId !== cell.treatmentId ||
      evidence.treatmentId !== cell.treatmentId ||
      evidence.candidateHash !== builder.artifactHashes[1] ||
      evidence.collectionPlanHash !== session.collectionPlanHash ||
      hashJson(evidence.phases.map((phase) => phase.phaseId)) !==
        hashJson(session.plan.phases.map((phase) => phase.id)) ||
      session.plan.phases.some(
        (phase, index) =>
          hashJson(evidence.phases[index]?.captures.map((capture) => capture.captureId)) !==
          hashJson(phase.captures.map((capture) => capture.id)),
      ) ||
      hashJson(evidence.scenarios.map((scenario) => scenario.scenarioId)) !==
        hashJson(session.plan.scenarios.map((scenario) => scenario.id)) ||
      hashJson(evidence) !== event.artifactHashes[1]
    )
      throw new Error("Final capture evidence differs from the signed frozen trial");
    const sequence = frozenSequencePlan(manifest, cell.id, builder.artifactHashes[1]!);
    if (sequence) await readBoundSequence(studio, receipt, sequence);
  }

  private async verifyGradingReceipt(
    event: RunOperationEvent,
    manifest: RunOperationManifest,
    events: RunOperationEvent[],
  ): Promise<RunCriterionArtifact> {
    const cell = manifest.gradingCells.find((item) => item.id === event.unitId);
    const captureCell = manifest.captureCells.find((item) => item.id === cell?.captureCellId);
    const capture = events.find(
      (item) =>
        item.stage === "final_capture" &&
        item.unitId === captureCell?.id &&
        item.kind === "completed",
    );
    const builder = events.find(
      (item) =>
        ["builder", "seal"].includes(item.stage ?? "") &&
        item.unitId === captureCell?.treatmentId &&
        item.kind === "completed",
    );
    if (!cell || !captureCell || !capture || !builder || event.artifactHashes.length !== 1)
      throw new Error("Grading lacks its frozen criterion, source or capture");
    const artifact = await this.files.json<RunCriterionArtifact>(
      `${this.base}/grading/${cell.id}/result.json`,
    );
    if (
      artifact.schema !== "basalt-evals/run-criterion-artifact" ||
      artifact.operationId !== this.operationId ||
      artifact.cellId !== cell.id ||
      artifact.treatmentId !== captureCell.treatmentId ||
      artifact.candidateHash !== builder.artifactHashes[1] ||
      artifact.captureEvidenceHash !== capture.artifactHashes[1] ||
      artifact.criterion?.criterionId !== cell.criterionId ||
      artifact.decisionAuthority !== "deterministic" ||
      !["static", "engine"].includes(artifact.criterion.layer) ||
      !["verified", "rejected", "incomplete"].includes(artifact.criterion.outcome) ||
      !Array.isArray(artifact.criterion.evidence) ||
      artifact.criterion.evidence.some((hash) => !hashPattern.test(hash)) ||
      hashJson(artifact) !== event.artifactHashes[0]
    )
      throw new Error("Grading result differs from its frozen criterion and evidence");
    const task = await loadRegisteredTask(
      this.root,
      `.basalt-evals/eval-revisions/${subjectEval(manifest, captureCell.treatmentId).id}`,
    );
    const source = await operationSource(this.root, manifest, captureCell.treatmentId);
    const evidence = await this.files.json<StudioEvidence>(
      `${this.base}/capture/${captureCell.id}/studio/evidence.json`,
    );
    const workspaceRoot = source.workspaceRoot;
    const evaluator = { ...task.evaluator, studio: capturePlan(manifest, captureCell.id) };
    if (cell.method === "deterministic") {
      if (artifact.judgment !== null || artifact.modelResponseHash !== null)
        throw new Error("Deterministic grading cannot carry a model judgment");
      // The check reads the stored analysis and never makes one, so it repeats the grading.
      const results = await evaluateDeterministicCriteria({
        workspaceRoot,
        evaluator,
        candidate: source.candidate,
        treatmentId: captureCell.treatmentId,
        evidence,
        analysis: readsSourceAnalysis(
          evaluator.deterministic.filter((item) => item.id === cell.criterionId),
        )
          ? ((await readSourceAnalysis(this.root, source.candidate)) ?? undefined)
          : undefined,
        evidenceDirectory: this.files.path(`${this.base}/capture/${captureCell.id}/studio`),
      });
      if (
        hashJson(results.find((item) => item.criterionId === cell.criterionId)) !==
        hashJson(artifact.criterion)
      )
        throw new Error("Deterministic grading differs from the fixed evaluator result");
    }
    return artifact;
  }

  /** Produce a terminal report from actual receipts, retaining every unattempted unit. */
  async completeReport(): Promise<RunOperationReport> {
    const status = await this.read();
    if (
      status.inFlightUnits.length !== 1 ||
      status.inFlightUnits[0]!.stage !== "report" ||
      status.inFlightUnits[0]!.unitId !== "final"
    )
      throw new Error(
        "Report must be started after the operation has a terminal or stopped builder population",
      );
    const spending = await this.ledger.read();
    const units = operationUnitSummary(status);
    const pending = spending.entries.filter((entry) => entry.status !== "billed");
    const executed =
      allPlannedWorkDone(units) &&
      pending.length === 0 &&
      status.criterionOutcomes.every((item) => item.outcome !== "incomplete");
    const report: RunOperationReport = {
      schema: "basalt-evals/run-operation-report",
      operationId: this.operationId,
      manifestHash: this.manifestHash,
      outcome: executed && status.manifest.unreviewedClaims.length === 0 ? "complete" : "partial",
      units,
      spending: {
        billedUsd: spending.entries.reduce((sum, entry) => sum + (entry.billedUsd ?? 0), 0),
        reservedUsd: pending.reduce((sum, entry) => sum + entry.reservedUsd, 0),
        uncertainRequests: pending.length,
      },
      criterionOutcomes: status.criterionOutcomes,
      unreviewedClaims: status.manifest.unreviewedClaims,
    };
    const file = `${this.base}/report.json`;
    try {
      await this.files.writeJson(file, report);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashJson(await this.files.json(file)) !== hashJson(report))
        throw new Error("Saved report differs from the frozen stage receipts");
    }
    await this.append({
      kind: "completed",
      stage: "report",
      unitId: "final",
      artifactHashes: [hashJson(report)],
      reason: completedReportReason(executed, status.manifest),
      at: new Date().toISOString(),
    });
    return report;
  }
}
