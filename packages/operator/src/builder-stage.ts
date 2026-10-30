import type { RunOperationStatus } from "../../contracts/src/execution.js";
import { modelRoute, modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { requestOutputTokens } from "../../model-client/src/request-workload.js";
import type { NativeLaneObserver, StudioAdapter } from "../../studio-runner/src/adapter.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { operationTreatments, operationSubject, subjectEval } from "./run-manifest.js";
import { readRegisteredSource } from "./sources.js";
import { readPublicFeedback } from "./public-feedback.js";
import { mkdir } from "node:fs/promises";
import { publishSealedSource } from "../../artifact-store/src/sealed-source.js";
import { resolve } from "node:path";
import { assertExecutionImplementation } from "./execution-guard.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { BoundedAgentCheckpoint } from "../../agent-runtime/src/checkpoint.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  AgentInterrupted,
  AgentBudgetPaused,
  AgentProviderPaused,
  runAgent,
} from "../../agent-runtime/src/index.js";
import { openFrozenNotesPack } from "../../agent-runtime/src/notes.js";
import { recordExecutionFailure, recordFailureStack } from "../../artifact-store/src/failures.js";
import { providerPauseSentence } from "../../contracts/src/console.js";
import {
  assertAgentRun,
  assertTreatment,
  hashJson,
  stableJson,
  type AgentRun,
  type CandidateManifest,
  type Treatment,
} from "../../contracts/src/index.js";
import { loadPublicDevelopmentTask } from "../../development/src/index.js";
import { createPublicDevelopmentServices } from "../../development/src/service.js";
import { verifyCandidateLocally } from "../../graders/src/index.js";
import { analyzeSource, ensureSourceAnalysis } from "../../graders/src/source-analysis.js";
import {
  BoundedModelClient,
  modelDependency,
  ProviderHoldError,
} from "../../model-client/src/bounded-client.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import { ModelRequestPendingError, type ModelClient } from "../../model-client/src/contracts.js";
import { loadRegisteredTask, materializeTaskSeed } from "../../task-registry/src/index.js";
import { providerHolds, RunOperationStore, unitHold } from "./operation.js";
import { appendUnitLog } from "./unit-log.js";
import type { ModelPermits } from "./model-permits.js";

const unitPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;

/**
 * The latest checkpoint of a build, with the request ordinals of its finished model calls. A
 * call can use more than one ordinal, because the client tries a rate limit again.
 */
async function builderCheckpoint(root: string, operationId: string, treatment: Treatment) {
  const base = `.basalt-evals/eval-operations/${operationId}/builder/${treatment.id}`;
  const journal = await OperationJournal.open(root);
  let ref: { file: string; hash: string; completedCalls: number } | null;
  try {
    ref = journal.read("agent_checkpoints", `${operationId}:${treatment.id}`);
  } finally {
    journal.close();
  }
  if (!ref) return null;
  if (ref.file !== `${base}/checkpoints/${ref.hash}.json`)
    throw new Error("Checkpoint escaped its owned builder");
  if (!Number.isSafeInteger(ref.completedCalls) || ref.completedCalls < 0)
    throw new Error("Checkpoint has no count of its model requests");
  const checkpoint = await new RepositoryFiles(root).json<BoundedAgentCheckpoint>(ref.file);
  if (
    hashJson(checkpoint) !== ref.hash ||
    checkpoint.treatmentId !== treatment.id ||
    checkpoint.publicTaskHash !== treatment.task.publicTaskHash ||
    checkpoint.transportConfigurationHash !== treatment.transportConfigurationHash
  )
    throw new Error("Checkpoint is not bound to the frozen public treatment");
  return { checkpoint, completedCalls: ref.completedCalls };
}

/**
 * The sealed build of the stage before a later stage, from the same run. The completed event of
 * that build binds its saved run and its candidate, and the sealed files must still match them.
 */
export async function sealedParentBuild(
  root: string,
  status: Pick<RunOperationStatus, "manifest" | "events" | "completedUnits">,
  parentId: string,
): Promise<{ run: AgentRun; candidate: string }> {
  if (!status.completedUnits.includes(`builder:${parentId}`))
    throw new Error("The build of the stage before did not complete");
  const base = `.basalt-evals/eval-operations/${status.manifest.id}/builder/${parentId}`;
  const run = await new RepositoryFiles(root).json<AgentRun>(`${base}/agent-run.json`);
  assertAgentRun(run);
  const candidate = resolve(root, base, "candidate");
  const sealed = await inventoryTree(candidate);
  const event = status.events.find(
    (item) => item.stage === "builder" && item.unitId === parentId && item.kind === "completed",
  );
  if (
    run.treatmentId !== parentId ||
    !event?.artifactHashes.includes(hashJson(run)) ||
    !event.artifactHashes.includes(run.candidate.rootHash) ||
    stableJson(sealed) !== stableJson(run.candidate.files) ||
    hashJson(sealed) !== run.candidate.rootHash
  )
    throw new Error("The sealed build of the stage before changed after it completed");
  return { run, candidate };
}

/** Reconcile a process interruption at the builder stage boundary without replaying a paid call. */
export async function recoverEvalBuilderUnit(input: {
  root: string;
  operation: RunOperationStore;
  unitId: string;
}): Promise<"completed" | "incomplete" | "uncertain_billing" | "resumable"> {
  if (!unitPattern.test(input.unitId)) throw new Error("Invalid builder unit identity");
  const status = await input.operation.read();
  if (!operationTreatments(status.manifest).some((item) => item.id === input.unitId))
    throw new Error("Builder unit is not part of the frozen operation");
  const relativeBase = `.basalt-evals/eval-operations/${status.manifest.id}/builder/${input.unitId}`;
  const files = new RepositoryFiles(input.root);
  const complete = status.completedUnits.includes(`builder:${input.unitId}`);
  if (
    !complete &&
    !status.inFlightUnits.some((unit) => unit.stage === "builder" && unit.unitId === input.unitId)
  )
    throw new Error("Builder unit has no interrupted stage to reconcile");
  // A charge without a live holder is unknown. Basalt does not send its request again.
  if ((await input.operation.ledger.unownedPending()).length) return "uncertain_billing";
  let saved = await files.optional<AgentRun>(`${relativeBase}/agent-run.json`);
  if (!complete && !saved) {
    await assertExecutionImplementation(input.root, status.manifest);
    const treatment = operationTreatments(status.manifest).find(
      (item) => item.id === input.unitId,
    )!;
    const checkpoint = (await builderCheckpoint(input.root, status.manifest.id, treatment))
      ?.checkpoint;
    if (checkpoint) {
      if (checkpoint.completedRun) {
        assertAgentRun(checkpoint.completedRun);
        if (
          checkpoint.point !== "finished" ||
          checkpoint.pendingAction ||
          checkpoint.completedRun.treatmentId !== input.unitId ||
          hashJson(checkpoint.source) !== hashJson(checkpoint.completedRun.candidate)
        )
          throw new Error("Completed checkpoint is inconsistent");
        saved = checkpoint.completedRun;
        await publishSealedSource(
          resolve(input.root, relativeBase, "workspace"),
          resolve(input.root, relativeBase, "candidate"),
          saved.candidate,
        );
        await files.writeJson(`${relativeBase}/agent-run.json`, saved);
      } else return "resumable";
    }
  }
  if (saved) {
    assertAgentRun(saved);
    if (saved.treatmentId !== input.unitId)
      throw new Error("Saved builder run belongs to another frozen treatment");
    const sealed = await inventoryTree(resolve(input.root, relativeBase, "candidate"));
    if (
      stableJson(sealed) !== stableJson(saved.candidate.files) ||
      hashJson(sealed) !== saved.candidate.rootHash
    )
      throw new Error("Saved builder candidate no longer matches the sealed source");
  }
  if (complete) {
    if (!saved) throw new Error("Completed builder receipt is missing its saved run");
    const event = status.events.find(
      (item) =>
        item.stage === "builder" && item.unitId === input.unitId && item.kind === "completed",
    );
    if (
      !event?.artifactHashes.includes(hashJson(saved)) ||
      !event.artifactHashes.includes(saved.candidate.rootHash)
    )
      throw new Error("Completed builder receipt does not bind its exact candidate");
    return "completed";
  }
  await input.operation.append({
    kind:
      saved?.status === "locally_eligible"
        ? "completed"
        : saved?.status === "rejected"
          ? "failed"
          : "incomplete",
    stage: "builder",
    unitId: input.unitId,
    artifactHashes: saved ? [hashJson(saved), saved.candidate.rootHash] : [],
    reason:
      saved?.status === "rejected"
        ? "local_gate_rejected"
        : saved
          ? (saved.failure?.classification ?? null)
          : "The build stopped before Basalt saved it.",
    at: new Date().toISOString(),
  });
  return saved?.status === "locally_eligible" ? "completed" : "incomplete";
}

/** One builder cell under the same quote and ledger as preparation and controls. */
export async function runEvalBuilderUnit(input: {
  root: string;
  operation: RunOperationStore;
  unitId: string;
  treatment: Treatment;
  modelClient: ModelClient;
  snapshot: ModelSnapshot;
  studio?: StudioAdapter;
  signal?: AbortSignal;
  /** Aborts when the run sends no new work. The build then stops before its next request. */
  dispatch?: AbortSignal;
  lane?: NativeLaneObserver;
  /** The request permits of the run. Each new request of the build waits for a permit. */
  permits?: ModelPermits;
}): Promise<AgentRun> {
  if (!unitPattern.test(input.unitId)) throw new Error("Invalid builder unit identity");
  assertTreatment(input.treatment);
  const status = await input.operation.readForStage("builder", input.unitId);
  const manifest = status.manifest;
  const frozenTreatment = operationTreatments(manifest).find((item) => item.id === input.unitId);
  const frozenSnapshot = manifest.modelSnapshots.find((model) => model.id === input.snapshot.id);
  if (
    input.unitId !== input.treatment.id ||
    !frozenTreatment ||
    hashJson(frozenTreatment) !== hashJson(input.treatment)
  )
    throw new Error("Builder unit differs from its frozen treatment");
  if (
    input.treatment.model.id !== input.snapshot.id ||
    !manifest.selectedModelIds.includes(input.snapshot.id) ||
    !manifest.selectedHarnessIds.includes(input.treatment.harness.id) ||
    !frozenSnapshot ||
    modelTreatmentIdentity(frozenSnapshot) !== modelTreatmentIdentity(input.snapshot) ||
    hashJson(input.modelClient.descriptor.configuration.routing.routes?.[input.snapshot.id]) !==
      hashJson(modelRoute(input.snapshot)) ||
    hashJson(input.modelClient.descriptor) !== input.treatment.transportConfigurationHash
  )
    throw new Error(
      "The builder model, tools or endpoint changed after the preview. Make a new preview.",
    );
  const spending = await input.operation.ledger.read();
  if (!spending.authorizations.some((item) => item.quoteHash === manifest.quoteHash))
    throw new Error("Run spending quote has not been authorized");
  const relativeBase = `.basalt-evals/eval-operations/${manifest.id}/builder/${input.unitId}`;
  const files = new RepositoryFiles(input.root);
  const completedKey = `builder:${input.unitId}`;
  if (status.completedUnits.includes(completedKey)) {
    const saved = await files.json<AgentRun>(`${relativeBase}/agent-run.json`);
    assertAgentRun(saved);
    const sealed = await inventoryTree(resolve(input.root, relativeBase, "candidate"));
    if (
      stableJson(sealed) !== stableJson(saved.candidate.files) ||
      hashJson(sealed) !== saved.candidate.rootHash
    )
      throw new Error("Saved builder candidate no longer matches the sealed source");
    const event = status.events.find(
      (item) =>
        item.stage === "builder" && item.unitId === input.unitId && item.kind === "completed",
    );
    if (
      !event?.artifactHashes.includes(hashJson(saved)) ||
      !event.artifactHashes.includes(saved.candidate.rootHash)
    )
      throw new Error("Completed builder receipt does not bind its exact candidate");
    return saved;
  }
  await assertExecutionImplementation(input.root, manifest);
  const latest = [...status.events]
    .reverse()
    .find((event) => event.stage === "builder" && event.unitId === input.unitId)?.kind;
  const paused = latest === "paused" || latest === "provider_paused";
  const inFlight = (current: RunOperationStatus) =>
    current.inFlightUnits.some((unit) => unit.stage === "builder" && unit.unitId === input.unitId);
  const resuming = paused || inFlight(status);
  // Read the holds now: the ledger state above can show a charge that settled since then.
  if (status.stopped || status.finished || (await input.operation.ledger.unownedPending()).length)
    throw new Error("Builder unit cannot start while the run is stopped or a charge is uncertain");
  const stored = resuming
    ? await builderCheckpoint(input.root, manifest.id, input.treatment)
    : null;
  const resume = stored?.checkpoint ?? null;
  if (resuming && (!resume || resume.completedRun))
    throw new Error("Interrupted builder requires a verified unfinished checkpoint");
  const evaluation = subjectEval(manifest, input.unitId);
  const taskDirectory = `.basalt-evals/eval-revisions/${evaluation.id}`;
  const task = await loadRegisteredTask(input.root, taskDirectory);
  if (task.id !== evaluation.taskId)
    throw new Error("Registered builder task differs from the frozen run");
  for (const field of [
    "id",
    "publicTaskHash",
    "evaluatorHash",
    "seedHash",
    "collectionPlanHash",
  ] as const)
    if (task[field] !== input.treatment.task[field])
      throw new Error("Builder treatment is not bound to the registered eval revision");
  const harness = input.treatment.harness;
  const development =
    harness.developmentRuns > 0 ? await loadPublicDevelopmentTask(input.root, taskDirectory) : null;
  // The freeze copied the pack. The build reads only that frozen copy.
  const notes = harness.notesPack ? await openFrozenNotesPack(input.root, harness.notesPack) : null;
  if (development && development.taskHash !== task.publicTaskHash)
    throw new Error("Public development recipe changed the frozen builder task");
  await files.directory(relativeBase);
  const unit = { stage: "builder" as const, unitId: input.unitId };
  const log = (entry: Parameters<typeof appendUnitLog>[3]) =>
    appendUnitLog(input.root, manifest.id, unit, entry);
  if (!resuming || paused)
    await input.operation.append({
      kind: "started",
      stage: "builder",
      unitId: input.unitId,
      artifactHashes: [],
      reason: null,
      at: new Date().toISOString(),
    });
  await log({ event: "started", resumed: resuming, model: input.snapshot.id });
  try {
    const workspace = resolve(input.root, relativeBase, "workspace");
    if (!resuming) {
      const subject = operationSubject(manifest, input.unitId);
      const parentId = subject.parentSourceId;
      if (subject.parentSubjectId) {
        // A later stage continues the sealed build of the stage before it in this run.
        const parent = await sealedParentBuild(input.root, status, subject.parentSubjectId);
        if (parent.run.candidate.projectFile !== task.publicTask.seed.projectFile)
          throw new Error("The build of the stage before uses another source project contract");
        await publishSealedSource(parent.candidate, workspace, parent.run.candidate);
      } else if (parentId) {
        const parent = await readRegisteredSource(input.root, parentId);
        if (parent.source.candidate.projectFile !== task.publicTask.seed.projectFile)
          throw new Error("Repair parent uses another source project contract");
        await publishSealedSource(parent.workspaceRoot, workspace, parent.source.candidate);
      } else await materializeTaskSeed(input.root, task, workspace);
    }
    const developmentRoot = resolve(input.root, relativeBase, "development");
    const subject = operationSubject(manifest, input.unitId);
    const repairContext = subject.publicFeedbackId
      ? (
          await readPublicFeedback(
            input.root,
            subject.publicFeedbackId,
            subject.parentSourceId!,
            evaluation.publicContentHash,
          )
        ).context
      : undefined;
    if (development && !resuming) await mkdir(developmentRoot, { mode: 0o700 });
    const permits = input.permits;
    const modelClient = new BoundedModelClient(
      input.modelClient,
      input.operation.ledger,
      [input.snapshot],
      `builder:${input.unitId}`,
      false,
      async (phase) => {
        await assertExecutionImplementation(input.root, manifest);
        const current = await input.operation.progress();
        // The build keeps its checkpoint and stays in flight for a later resume.
        if (current.stopped || !inFlight(current) || input.dispatch?.aborted)
          throw new AgentInterrupted();
        // A provider pause of another unit holds this build before its next reservation.
        const hold = phase === "admission" && unitHold(providerHolds(current), manifest, unit);
        if (hold) throw new ProviderHoldError(hold);
      },
      stored?.completedCalls ?? 0,
      [],
      permits ? (signal) => permits.acquire(input.snapshot.id, signal) : undefined,
    );
    // The log gets each trace event once. A resume continues after the events of its checkpoint.
    let logged = resume?.trace.length ?? 0;
    const run = await runAgent({
      workspaceRoot: workspace,
      task: task.publicTask,
      treatment: input.treatment,
      outputTokens: (request) => requestOutputTokens(input.snapshot, request),
      modelClient,
      verify: verifyCandidateLocally,
      retainInterruption: true,
      ...(repairContext ? { repairContext } : {}),
      ...(evaluation.stage.earlierPrompts.length
        ? { earlierPrompts: evaluation.stage.earlierPrompts }
        : {}),
      ...(resume ? { resume } : {}),
      ...(notes ? { notes } : {}),
      // The lint feedback analyzes the current workspace and stores no record.
      ...(harness.verifyLint
        ? {
            sourceAnalyzer: (workspaceRoot: string, candidate: CandidateManifest) =>
              analyzeSource(input.root, workspaceRoot, candidate),
          }
        : {}),
      checkpoint: async (state) => {
        for (const event of state.trace.slice(logged))
          await log({
            event: event.kind,
            ...(event.kind === "model_request" || event.kind === "model_response"
              ? { turn: event.data.turn ?? null, kind: event.data.kind ?? null }
              : {}),
            ...(event.kind === "tool_call" || event.kind === "tool_result"
              ? { tool: event.data.name ?? null }
              : {}),
            ...(event.kind === "model_response" ? { ordinal: modelClient.completedCalls } : {}),
          });
        logged = state.trace.length;
        const hash = hashJson(state);
        const file = `${relativeBase}/checkpoints/${hash}.json`;
        try {
          await files.writeJson(file, state);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (hashJson(await files.json(file)) !== hash)
            throw new Error("Bounded agent checkpoint changed");
        }
        const journal = await OperationJournal.open(input.root);
        try {
          journal.transaction(() => {
            journal.put("agent_checkpoints", `${manifest.id}:${input.unitId}`, {
              file,
              hash,
              completedCalls: modelClient.completedCalls,
            });
          });
        } finally {
          journal.close();
        }
      },
      ...(development
        ? {
            development: createPublicDevelopmentServices({
              root: input.root,
              ...(input.studio ? { studio: input.studio } : {}),
              outputRoot: developmentRoot,
              task: development.task,
              recipe: development.recipe,
              recipeHash: development.recipeHash,
              implementationCommit: manifest.implementationCommit,
              maxRuns: harness.developmentRuns,
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.lane ? { lane: input.lane } : {}),
            }),
          }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch(async (error: unknown) => {
      if (error instanceof AgentProviderPaused) {
        const { scope, errorClass, hold } = error.pause;
        const dependency =
          hold?.dependency ?? (scope === "account" ? null : modelDependency(input.snapshot));
        const reason = providerPauseSentence([{ scope, errorClass }])!;
        const failure = await recordExecutionFailure(input.root, manifest.id, {
          causeCode: errorClass,
          category: "provider",
          dependency,
          unit: { stage: "builder", id: input.unitId },
          evidenceRefs: [],
          recoveryActions: ["resume"],
          explanation: reason,
        });
        const ordinal = hold ? null : modelClient.completedCalls;
        await input.operation.appendProviderPause({
          ...unit,
          record: { scope, dependency, errorClass, failureId: failure.id, ordinal },
          reason,
        });
        await log({ event: "provider_paused", scope, errorClass, ordinal, held: hold !== null });
      }
      throw error;
    });
    const sealedSource = resolve(input.root, relativeBase, "candidate");
    await publishSealedSource(workspace, sealedSource, run.candidate);
    // The code checks read this analysis later. A failure here does not stop the build, also
    // for a build that the local gate rejected. A code check makes the analysis again.
    await ensureSourceAnalysis(input.root, sealedSource, run.candidate).catch((error: unknown) =>
      log({
        event: "source_analysis_failed",
        reason: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      }),
    );
    await files.writeJson(`${relativeBase}/agent-run.json`, run);
    await input.operation.append({
      kind:
        run.status === "locally_eligible"
          ? "completed"
          : run.status === "rejected"
            ? "failed"
            : "incomplete",
      stage: "builder",
      unitId: input.unitId,
      artifactHashes: [hashJson(run), run.candidate.rootHash],
      reason:
        run.status === "rejected" ? "local_gate_rejected" : (run.failure?.classification ?? null),
      at: new Date().toISOString(),
    });
    await log({ event: "ended", status: run.status, stopReason: run.stopReason });
    return run;
  } catch (error) {
    if (
      error instanceof AgentInterrupted ||
      error instanceof ModelRequestPendingError ||
      error instanceof AgentProviderPaused
    ) {
      await log({ event: "stopped", reason: error.name });
      throw error;
    }
    if (error instanceof AgentBudgetPaused) {
      await input.operation.append({
        kind: "paused",
        stage: "builder",
        unitId: input.unitId,
        // Only a new authorization changes this hash. Charges of other units do not change it.
        artifactHashes: [hashJson((await input.operation.ledger.read()).authorizations)],
        reason: error.message,
        at: new Date().toISOString(),
      });
      throw error;
    }
    const current = await input.operation.read();
    if (inFlight(current)) {
      // An unknown failure keeps its redacted stack for diagnosis.
      const stack = await recordFailureStack(input.root, manifest.id, error);
      const reason = error instanceof Error ? error.message.slice(0, 512) : "The build failed.";
      await recordExecutionFailure(input.root, manifest.id, {
        causeCode: "unclassified",
        category: "unknown",
        dependency: null,
        unit: { stage: "builder", id: input.unitId },
        evidenceRefs: [stack],
        recoveryActions: ["inspect"],
        explanation: reason.slice(0, 500),
      });
      await input.operation.append({
        kind: "failed",
        stage: "builder",
        unitId: input.unitId,
        artifactHashes: [],
        reason,
        at: new Date().toISOString(),
      });
      await log({ event: "failed", stack });
    }
    throw error;
  }
}
