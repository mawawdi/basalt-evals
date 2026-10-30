import type { StudioSession } from "./session.js";
import { isRecord } from "../../contracts/src/validation.js";
export type { StudioSession } from "./session.js";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { walkRegularTree } from "../../artifact-store/src/inventory.js";
import { captureMediaType, inspectCaptureImage } from "./images.js";
import { assertTrialId, createStudioTrace } from "./trace.js";
import { studioLaneConnectorUrl } from "./studio-lanes.js";
import { studioPlaceName, type ViewportCapture } from "./studio-mcp.js";
import { assertSequencePlan, sequenceSettleAtMs, type SequencePlan } from "./sequence.js";
import {
  compareCodeUnits,
  STUDIO_EVIDENCE_SCHEMA,
  MAX_CANDIDATE_BYTES,
  MAX_CAPTURE_BYTES,
  assertCandidateManifest,
  assertEvaluatorSpec,
  assertPublicTask,
  assertStudioCollectionPlan,
  assertStudioEvidence,
  assertStudioObservation,
  assertSceneTextObservation,
  assertStudioStepReport,
  isStudioClockTime,
  contentHash,
  hashJson,
  stableJson,
  type CandidateManifest,
  type PublicTask,
  type RegisteredTask,
  type StudioCollectionPlan,
  type StudioEvidence,
  type StudioObservation,
  type SceneTextObservation,
  type StudioScenario,
  type StudioScenarioReport,
  type Treatment,
} from "../../contracts/src/index.js";

const execFile = promisify(execFileCallback);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_PLACE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCEMAP_BYTES = 8 * 1024 * 1024;
const MAX_ACQUISITION_ATTEMPTS = 64;
const STUDIO_BOOTSTRAP_NAME = "BasaltEvalBootstrap";
const STUDIO_BOOTSTRAP_SCHEMA = "basalt-evals/studio-bootstrap";
/** A session without an admitted lane, for example a readiness check, uses lane 0. */
const DEFAULT_STUDIO_CONNECTOR_URL = studioLaneConnectorUrl(0);

interface StudioBootstrap {
  schema: typeof STUDIO_BOOTSTRAP_SCHEMA;
  connectorUrl: string;
  token: string;
  treatmentId: string;
  candidateHash: string;
  collectionPlanHash: string;
}

export interface StudioSubmission {
  schema: "basalt-evals/studio-submission";
  sessionId: string;
  studioVersion: string;
  startedAt: string;
  endedAt: string;
  phases: Array<{
    phaseId: string;
    observations: StudioObservation[];
    captures: Array<{ captureId: string; hash: string; sceneText: SceneTextObservation }>;
  }>;
}

export async function prepareStudioSession(input: {
  workspaceRoot: string;
  outputDirectory: string;
  task: RegisteredTask;
  treatment: Pick<Treatment, "id" | "task" | "environment">;
  candidate: CandidateManifest;
  connectorSourceHash: string;
  connectorArtifactHash: string;
  createdAt?: string;
  connectorUrl?: string;
}): Promise<StudioSession> {
  assertPublicTask(input.task.publicTask);
  assertEvaluatorSpec(input.task.evaluator);
  assertCandidateManifest(input.candidate);
  if (
    input.task.id !== input.treatment.task.id ||
    input.task.publicTaskHash !== input.treatment.task.publicTaskHash ||
    input.task.evaluatorHash !== input.treatment.task.evaluatorHash ||
    input.task.seedHash !== input.treatment.task.seedHash ||
    input.task.collectionPlanHash !== input.treatment.task.collectionPlanHash
  )
    throw new Error("Registered task does not match the frozen treatment");
  return prepareBoundStudioSession({
    ...input,
    publicTask: input.task.publicTask,
    collectionPlan: input.task.evaluator.studio,
    collectionPlanHash: input.task.collectionPlanHash,
    treatmentId: input.treatment.id,
    studioVersion: input.treatment.environment.studioVersion,
  });
}

/**
 * Basalt cannot make a Studio place from the candidate. The candidate causes this fault, so each
 * attempt with the same candidate gets it again. The message tells the builder the cause.
 */
export class StudioPlaceBuildError extends Error {}

const RESERVED_BOOTSTRAP_NAME = `The candidate must not contain an instance with the name ${STUDIO_BOOTSTRAP_NAME}. Basalt reserves this name.`;

/**
 * True only if Rojo ran to its end and rejected the project. An absent Rojo, a timeout, a stop
 * or an output limit is a fault of the host, not of the candidate.
 */
function rojoRejected(error: unknown): error is { stderr: string } {
  const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
  return (
    typeof failure.code === "number" &&
    failure.code !== 0 &&
    failure.signal === null &&
    !failure.killed &&
    typeof failure.stderr === "string"
  );
}

/**
 * Build the place of a public session in a temporary folder, then delete it. A candidate that
 * Rojo cannot build fails here, before it waits for a Studio lane.
 */
export async function checkPublicStudioPlace(
  input: Omit<
    Parameters<typeof preparePublicStudioSession>[0],
    "outputDirectory" | "connectorUrl"
  > & {
    /** The temporary folder goes below this folder. */
    scratchDirectory: string;
  },
): Promise<void> {
  const { scratchDirectory, ...session } = input;
  const scratch = await mkdtemp(resolve(scratchDirectory, "place-check-"));
  try {
    await preparePublicStudioSession({ ...session, outputDirectory: resolve(scratch, "studio") });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A builder-visible plan has its own authority and no evaluator object. */
export async function preparePublicStudioSession(input: {
  workspaceRoot: string;
  outputDirectory: string;
  publicTask: PublicTask;
  collectionPlan: StudioCollectionPlan;
  treatmentId: string;
  studioVersion: string;
  candidate: CandidateManifest;
  connectorSourceHash: string;
  connectorArtifactHash: string;
  signal?: AbortSignal;
  connectorUrl?: string;
}): Promise<StudioSession> {
  assertPublicTask(input.publicTask);
  assertStudioCollectionPlan(input.collectionPlan);
  return prepareBoundStudioSession({
    ...input,
    collectionPlanHash: hashJson(input.collectionPlan),
  });
}

export async function prepareBoundStudioSession(input: {
  workspaceRoot: string;
  outputDirectory: string;
  publicTask: PublicTask;
  collectionPlan: StudioCollectionPlan;
  collectionPlanHash: string;
  treatmentId: string;
  studioVersion: string;
  candidate: CandidateManifest;
  connectorSourceHash: string;
  connectorArtifactHash: string;
  createdAt?: string;
  signal?: AbortSignal;
  connectorUrl?: string;
}): Promise<StudioSession> {
  assertCandidateManifest(input.candidate);
  assertStudioCollectionPlan(input.collectionPlan);
  if (hashJson(input.collectionPlan) !== input.collectionPlanHash)
    throw new Error("Studio collection plan hash changed");
  if (input.candidate.projectFile !== input.publicTask.seed.projectFile)
    throw new Error("Prepared candidate project does not match the registered task");
  if (input.candidate.rootHash !== (await hashWorkspace(input.workspaceRoot)))
    throw new Error("Workspace no longer matches the exact candidate");
  const output = resolve(input.outputDirectory);
  await assertAbsent(output, "Studio session directory");
  await ensurePrivateDirectory(dirname(output));
  const temporaryOutput = await mkdtemp(`${output}.tmp-`);
  const placeName = `BasaltEval-${randomBytes(10).toString("hex")}`;
  const placeFile = resolve(temporaryOutput, `${placeName}.rbxlx`);
  const connectorUrl = input.connectorUrl ?? DEFAULT_STUDIO_CONNECTOR_URL;
  assertLoopbackConnectorUrl(connectorUrl);
  const token = randomBytes(32).toString("hex");
  const bootstrap: StudioBootstrap = {
    schema: STUDIO_BOOTSTRAP_SCHEMA,
    connectorUrl,
    token,
    treatmentId: input.treatmentId,
    candidateHash: input.candidate.rootHash,
    collectionPlanHash: input.collectionPlanHash,
  };
  const bootstrapFile = resolve(temporaryOutput, `${STUDIO_BOOTSTRAP_NAME}.server.luau`);
  const preparedProject = resolve(temporaryOutput, "prepared.project.json");
  const sourcemapFile = resolve(temporaryOutput, "prepared-sourcemap.json");
  try {
    const projectFile = resolve(input.workspaceRoot, input.publicTask.seed.projectFile);
    await writeFile(
      bootstrapFile,
      `--[[\n${STUDIO_BOOTSTRAP_SCHEMA}\n${stableJson(bootstrap)}\n]]\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await writeFile(
      preparedProject,
      `${stableJson({
        name: placeName,
        // Import the complete candidate tree unchanged. The capability stays in
        // protected root Source; native plugin messaging needs no game instances.
        tree: { $path: projectFile, [STUDIO_BOOTSTRAP_NAME]: { $path: bootstrapFile } },
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await execFile(
      "rojo",
      ["sourcemap", "--include-non-scripts", preparedProject, "-o", sourcemapFile],
      {
        cwd: resolve(input.workspaceRoot),
        timeout: 120_000,
        ...(input.signal ? { signal: input.signal } : {}),
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
    );
    const sourcemap = await readBoundedJson(
      sourcemapFile,
      "prepared Studio sourcemap",
      MAX_SOURCEMAP_BYTES,
    );
    assertPreparedBootstrapSourcemap(sourcemap, bootstrapFile);
    await execFile("rojo", ["build", preparedProject, "-o", placeFile], {
      cwd: resolve(input.workspaceRoot),
      timeout: 120_000,
      ...(input.signal ? { signal: input.signal } : {}),
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    await Promise.all([unlink(bootstrapFile), unlink(preparedProject), unlink(sourcemapFile)]);
    const placeBytes = await readBoundedRegularFile(
      placeFile,
      "generated Studio place",
      MAX_PLACE_BYTES,
    );
    assertPreparedBootstrapPlace(placeBytes, token);
    const body = {
      connectorUrl,
      treatmentId: input.treatmentId,
      candidateHash: input.candidate.rootHash,
      collectionPlanHash: input.collectionPlanHash,
      connectorSourceHash: input.connectorSourceHash,
      connectorArtifactHash: input.connectorArtifactHash,
      expectedStudioVersion: input.studioVersion,
      place: { file: basename(placeFile), hash: contentHash(placeBytes) },
      plan: input.collectionPlan,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const session: StudioSession = {
      schema: "basalt-evals/studio-session",
      id: `studio-${hashJson(body).slice(0, 20)}`,
      token,
      ...body,
    };
    assertStudioSession(session);
    await writePrivateJson(resolve(temporaryOutput, "session.json"), session);
    await rename(temporaryOutput, output);
    return session;
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true });
    if (rojoRejected(error))
      throw new StudioPlaceBuildError(
        `Rojo could not build the Studio place: ${error.stderr.trim().slice(0, 4_000)}`,
      );
    throw error;
  }
}

export async function loadStudioSession(directory: string): Promise<StudioSession> {
  const root = resolve(directory);
  await assertSafeAbsoluteDirectory(root);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Studio session root must be a regular directory");
  const value = await readBoundedJson(
    resolve(root, "session.json"),
    "Studio session",
    MAX_SESSION_BYTES,
  );
  assertStudioSession(value);
  await assertSessionPlace(root, value);
  return value;
}

export async function finalizeStudioEvidence(input: {
  sessionDirectory: string;
}): Promise<StudioEvidence> {
  const directory = resolve(input.sessionDirectory);
  const session = await loadStudioSession(directory);
  const submissionValue = await loadStudioSubmission(directory, session);
  const scenarios = await loadScenarioEvidence(directory, session.plan);
  const uploads = await readSubmittedCaptures(directory, session, submissionValue);
  const capturesByPhase = new Map<string, StudioEvidence["phases"][number]["captures"]>();
  for (const capture of uploads) {
    const entries = capturesByPhase.get(capture.phaseId) ?? [];
    entries.push({
      captureId: capture.captureId,
      file: capture.file,
      hash: capture.hash,
      bytes: capture.bytes,
      mediaType: capture.mediaType,
      width: capture.width,
      height: capture.height,
      sceneText: capture.sceneText,
    });
    capturesByPhase.set(capture.phaseId, entries);
  }
  const evidenceBody = {
    treatmentId: session.treatmentId,
    candidateHash: session.candidateHash,
    collectionPlanHash: session.collectionPlanHash,
    connectorSourceHash: session.connectorSourceHash,
    connectorArtifactHash: session.connectorArtifactHash,
    place: session.place,
    studio: { version: submissionValue.studioVersion, sessionId: session.id },
    startedAt:
      scenarios.length > 0 && scenarios[0]!.startedAt < submissionValue.startedAt
        ? scenarios[0]!.startedAt
        : submissionValue.startedAt,
    endedAt: submissionValue.endedAt,
    scenarios,
    phases: submissionValue.phases.map((phase) => ({
      phaseId: phase.phaseId,
      observations: phase.observations,
      captures: (capturesByPhase.get(phase.phaseId) ?? []).sort((a, b) =>
        compareCodeUnits(a.captureId, b.captureId),
      ),
    })),
  };
  const evidence: StudioEvidence = {
    schema: STUDIO_EVIDENCE_SCHEMA,
    id: `evidence-${hashJson(evidenceBody).slice(0, 20)}`,
    ...evidenceBody,
  };
  assertStudioEvidence(evidence);
  await writePrivateJson(resolve(directory, "evidence.json"), evidence);
  return evidence;
}

async function loadScenarioEvidence(directory: string, plan: StudioCollectionPlan) {
  const results: StudioEvidence["scenarios"] = [];
  for (const scenario of plan.scenarios) {
    const value = await readBoundedJson(
      resolve(directory, "runtime", scenario.id, "evidence.json"),
      "Studio scenario evidence",
      MAX_REQUEST_BYTES,
    );
    if (!isRecord(value)) throw new Error("Invalid Studio scenario evidence");
    assertExactKeys(value, ["scenarioId", "startedAt", "endedAt", "reports"]);
    if (
      value.scenarioId !== scenario.id ||
      typeof value.startedAt !== "string" ||
      typeof value.endedAt !== "string" ||
      !Array.isArray(value.reports) ||
      value.reports.length !== scenario.reportContexts.length
    )
      throw new Error("Studio scenario evidence binding mismatch");
    for (const [index, report] of value.reports.entries()) {
      assertStudioScenarioReport(report, scenario, plan.actors);
      if (report.context !== scenario.reportContexts[index])
        throw new Error("Studio scenario report order mismatch");
    }
    results.push(value as StudioEvidence["scenarios"][number]);
  }
  return results;
}

async function loadStudioSubmission(
  directory: string,
  session: StudioSession,
): Promise<StudioSubmission> {
  const value = await readBoundedJson(
    resolve(directory, "submission.json"),
    "Studio submission",
    MAX_REQUEST_BYTES,
  );
  assertStudioSubmission(value, session.plan);
  if (value.sessionId !== session.id) throw new Error("Submission session binding mismatch");
  return value;
}

function captureFile(phaseId: string, captureId: string, hash: string): string {
  // Keep the phase/capture binding even when two uploads have identical bytes;
  // hash the identifiers so their maximum lengths cannot exceed filename limits.
  return `captures/${hashJson({ phaseId, captureId })}-${hash}.image`;
}

// Only hashes sealed in this attempt's submission can become evidence. Orphaned
// uploads from an interrupted attempt remain unreferenced and are never inferred.
async function readSubmittedCaptures(
  directory: string,
  session: StudioSession,
  submission: StudioSubmission,
) {
  const captures = [];
  for (const phase of session.plan.phases) {
    const submitted = submission.phases.find((entry) => entry.phaseId === phase.id)!;
    for (const request of phase.captures) {
      const receipt = submitted.captures.find((entry) => entry.captureId === request.id)!;
      const file = captureFile(phase.id, request.id, receipt.hash);
      const bytes = await readBoundedRegularFile(
        resolve(directory, file),
        "uploaded capture",
        MAX_CAPTURE_BYTES,
      );
      if (contentHash(bytes) !== receipt.hash) throw new Error("Uploaded capture hash mismatch");
      const mediaType = captureMediaType(bytes);
      const dimensions = inspectCaptureImage(bytes, mediaType);
      captures.push({
        phaseId: phase.id,
        captureId: request.id,
        file,
        hash: receipt.hash,
        bytes: bytes.byteLength,
        mediaType,
        ...dimensions,
        sceneText: receipt.sceneText,
      });
    }
  }
  return captures;
}

function assertStudioScenarioReport(
  value: unknown,
  scenario: StudioScenario,
  actorIds: string[],
): asserts value is StudioScenarioReport {
  if (!isRecord(value) || !scenario.reportContexts.includes(String(value.context)))
    throw new Error("Invalid runtime report context");
  assertExactKeys(value, ["context", "startAt", "actors", "steps"]);
  if (!isStudioClockTime(value.startAt)) throw new Error("Invalid runtime report start");
  if (!Array.isArray(value.actors) || value.actors.length !== actorIds.length)
    throw new Error("Runtime actor mapping is incomplete");
  const userIds = new Set<number>();
  for (const [index, actor] of value.actors.entries()) {
    if (!isRecord(actor)) throw new Error("Invalid runtime actor mapping");
    assertExactKeys(actor, ["actor", "userId", "name"]);
    if (
      actor.actor !== actorIds[index] ||
      typeof actor.userId !== "number" ||
      !Number.isSafeInteger(actor.userId) ||
      userIds.has(actor.userId) ||
      typeof actor.name !== "string" ||
      !actor.name.trim() ||
      actor.name.length > 128
    )
      throw new Error("Runtime actor mapping does not match the plan");
    userIds.add(actor.userId);
  }
  if (!Array.isArray(value.steps) || value.steps.length !== scenario.steps.length)
    throw new Error("Runtime report must cover every planned step exactly once");
  for (const [index, planned] of scenario.steps.entries()) {
    const step: unknown = value.steps[index];
    assertStudioStepReport(step);
    if (step.stepId !== planned.id) throw new Error("Runtime report step identity mismatch");
    const actionExpected = planned.action.kind !== "wait" && planned.action.actor === value.context;
    if (step.action && !actionExpected)
      throw new Error("Runtime action receipt belongs to another context");
    if (step.action) {
      if (step.action.kind !== planned.action.kind)
        throw new Error("Runtime action receipt does not match the plan");
      if (
        planned.action.kind === "probe_barrier" &&
        step.action.succeeded &&
        step.action.probe!.barrierPath !== planned.action.barrierPath
      )
        throw new Error("Runtime trajectory barrier does not match the plan");
    }
    const expected = planned.observations.filter((entry) => entry.context === value.context);
    if (step.capturedAt !== undefined && step.observations.length !== expected.length)
      throw new Error("Runtime observations do not match the plan");
    for (const [observationIndex, request] of expected.entries()) {
      const observation = step.observations[observationIndex];
      if (observation === undefined) break;
      if (
        observation.factId !== request.fact.id ||
        (observation.kind === "binding_failure"
          ? observation.requestedKind !== request.fact.kind ||
            !("path" in request.fact) ||
            observation.path !== request.fact.path
          : observation.kind !== request.fact.kind)
      )
        throw new Error("Runtime observation identity does not match the plan");
      const fact = request.fact;
      if (fact.kind === "performance_trace" && observation.kind === "performance_trace") {
        const samples = observation.samples;
        // A rounded millisecond value can make a measured interval at most 1 ms shorter.
        if (
          samples.length !== fact.sampleCount ||
          samples.some(
            (sample, sampleIndex) =>
              sample.elapsedMs - (sampleIndex === 0 ? 0 : samples[sampleIndex - 1]!.elapsedMs) <
              fact.intervalMs - 1,
          )
        )
          throw new Error("Performance trace must contain every planned interval");
      }
    }
  }
}

export async function serveStudioSession(
  sessionDirectory: string,
  viewportCapture: ViewportCapture,
  native?: {
    jobId: string;
    complete: (receipt: { trialId: string; submissionHash: string }) => void;
    failed?: (error: string) => void;
    scenarioComplete?: (receipt: import("./studio-mcp.js").StudioScenarioCompletion) => void;
  },
): Promise<{
  server: Server;
  url: string;
  session: StudioSession;
  traceFile: string;
  resetWorkerReady: (scenarioId?: string) => number;
  markSequenceReady: (scenarioId: string, generation?: number) => void;
}> {
  const directory = resolve(sessionDirectory);
  const session = await loadStudioSession(directory);
  let sequenceView: { schema: "basalt-evals/sequence-view"; viewport: SequencePlan["viewport"] } = {
    schema: "basalt-evals/sequence-view",
    viewport: null,
  };
  const sequenceFile = resolve(directory, "sequence.json");
  let sequenceScenarioId: string | null = null;
  let sequencePlan: SequencePlan | null = null;
  let sequenceReady = false;
  let sequenceExists = false;
  try {
    const information = await lstat(sequenceFile);
    if (!information.isFile() || information.isSymbolicLink())
      throw new Error("Sequence plan must be a regular file");
    sequenceExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (sequenceExists) {
    const plan = await readBoundedJson(sequenceFile, "sequence plan", 8192);
    assertSequencePlan(plan);
    if (
      plan.sourceHash !== session.candidateHash ||
      !session.plan.scenarios.some((scenario) => scenario.id === plan.scenarioId)
    )
      throw new Error("Sequence view is not bound to this Studio session");
    sequenceView = { schema: "basalt-evals/sequence-view", viewport: plan.viewport };
    sequenceScenarioId = plan.scenarioId;
    sequencePlan = plan;
  }
  const { host, port } = assertLoopbackConnectorUrl(session.connectorUrl);
  const trace = await createStudioTrace(directory, session);
  let capturing = false;
  let editConnected = false;
  let nativeCompleted = false;
  let nativeTrialId: string | null = null;
  let nativeGeneration = 0;
  let nativeScenarioId: string | null = null;
  const scenarioReports = new Map<
    string,
    {
      startedAt: string;
      reports: Map<string, StudioScenarioReport>;
      hash: string | null;
      /** Host time after which Play can end. A recorded sequence needs its holds. */
      settleAt: number;
    }
  >();
  const scenarioQueues = new Map<string, Promise<void>>();
  async function serializeScenario<T>(scenarioId: string, operation: () => Promise<T>): Promise<T> {
    const previous = scenarioQueues.get(scenarioId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((accept) => {
      release = accept;
    });
    const tail = previous.then(() => gate);
    scenarioQueues.set(scenarioId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (scenarioQueues.get(scenarioId) === tail) scenarioQueues.delete(scenarioId);
    }
  }
  const server = createServer(async (request, response) => {
    const started = performance.now();
    const requestGeneration = nativeGeneration;
    let trialId: string | null = null;
    let route = "unknown";
    try {
      if (request.headers.authorization !== `Bearer ${session.token}`) {
        // Record the failure class, never a rejected capability (it may belong
        // to another prepared place and would not match this session's redactor).
        const authorization = request.headers.authorization;
        trace.host("request.denied", {
          status: 401,
          reason:
            authorization === undefined
              ? "missing_authorization"
              : /^Bearer [a-f0-9]{64}$/.test(authorization)
                ? "session_token_mismatch"
                : "malformed_authorization",
        });
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      route = url.pathname;
      const header = request.headers["x-basalt-trial"];
      if (header !== undefined) {
        assertTrialId(header);
        trialId = header;
      }
      if (request.method === "POST" && route === "/trace") {
        const batch = await readRequestJson(request, 256 * 1024);
        const events = trace.plugin(batch);
        // Only authenticated, validated Edit-plugin readiness can arm a CLI launch.
        // A retransmitted batch has already affected its original step. It must
        // not re-arm readiness or cancel a later owned attempt.
        editConnected ||= events.some(
          (event) =>
            event.stage === "connection.ready" &&
            event.data.transport === "http" &&
            event.data.runState === "Stopped" &&
            event.data.sessionId === session.id,
        );
        for (const event of events) {
          if (event.stage === "trial.failed" && typeof event.data.error === "string")
            native?.failed?.(event.data.error.replaceAll(session.token, "[REDACTED]"));
        }
        respond(response, 200, { accepted: true });
        return;
      }
      if (native && request.method === "GET" && route === "/worker-ready") {
        respond(response, 200, { ready: editConnected, jobId: native.jobId });
        return;
      }
      if (native && request.method === "POST" && route === "/worker-complete") {
        const body = await readRequestJson(request, 1024);
        if (!isRecord(body) || body.jobId !== native.jobId || nativeCompleted || !trialId)
          throw new Error("Invalid or duplicate native completion");
        assertExactKeys(body, ["jobId", "submissionHash"]);
        const submission = await loadStudioSubmission(directory, session);
        if (body.submissionHash !== hashJson(submission))
          throw new Error("Native completion does not match the sealed submission");
        native.complete({ trialId, submissionHash: body.submissionHash as string });
        nativeCompleted = true;
        trace.host(
          "worker.completed",
          { jobId: native.jobId, submissionHash: body.submissionHash as string },
          trialId,
        );
        respond(response, 200, { accepted: true });
        return;
      }
      trace.host("request.started", { method: request.method ?? "", route }, trialId);
      response.once("finish", () =>
        trace.host(
          "request.finished",
          {
            route,
            status: response.statusCode,
            elapsedMs: Math.round(performance.now() - started),
          },
          trialId,
        ),
      );
      if (request.method === "POST" && route === "/trial") {
        const body = await readRequestJson(request, 1024);
        if (native && isRecord(body) && body.mode === "launch") {
          if (body.clientId !== native.jobId || Object.keys(body).sort().join() !== "clientId,mode")
            throw new Error("Native launch must match the worker job");
          trialId = nativeTrialId
            ? trace.continueLaunch(nativeTrialId, native.jobId)
            : trace.begin(body);
          nativeTrialId = trialId;
        } else {
          trialId = trace.begin(body);
        }
        respond(response, 201, { trialId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/session") {
        respond(response, 200, {
          sessionId: session.id,
          treatmentId: session.treatmentId,
          candidateHash: session.candidateHash,
          collectionPlanHash: session.collectionPlanHash,
          connectorUrl: session.connectorUrl,
          expectedStudioVersion: session.expectedStudioVersion,
          plan: session.plan,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/sequence-view") {
        respond(response, 200, sequenceView);
        return;
      }
      const sequenceReadyRoute = /^\/runtime\/([^/]+)\/sequence-ready$/.exec(url.pathname);
      if (sequenceReadyRoute && request.method === "GET") {
        if (!trialId || (native && trialId !== nativeTrialId))
          throw new Error("Sequence readiness requires the bound trial");
        const scenarioId = sequenceReadyRoute[1];
        if (!session.plan.scenarios.some((scenario) => scenario.id === scenarioId))
          throw new Error("Unknown runtime scenario");
        respond(response, 200, { ready: scenarioId !== sequenceScenarioId || sequenceReady });
        return;
      }
      const runtimeRoute = /^\/runtime\/([^/]+)$/.exec(url.pathname);
      if (runtimeRoute && request.method === "POST") {
        if (!trialId) throw new Error("Runtime reports require a bound trial");
        if (native && trialId !== nativeTrialId)
          throw new Error("Runtime report belongs to another native trial");
        const scenario = session.plan.scenarios.find((entry) => entry.id === runtimeRoute[1]);
        if (!scenario) throw new Error("Unknown runtime scenario");
        if (native?.scenarioComplete && scenario.id !== nativeScenarioId)
          throw new Error("Runtime report does not match the active native scenario");
        const body = await readRequestJson(request);
        if (!isRecord(body)) throw new Error("Invalid runtime report");
        assertExactKeys(body, ["schema", "sessionId", "scenarioId", "report"]);
        if (
          body.schema !== "basalt-evals/scenario-report" ||
          body.sessionId !== session.id ||
          body.scenarioId !== scenario.id
        )
          throw new Error("Runtime report binding mismatch");
        assertStudioScenarioReport(body.report, scenario, session.plan.actors);
        const report = body.report;
        const receipt = await serializeScenario(scenario.id, async () => {
          if (native && requestGeneration !== nativeGeneration)
            throw new Error("Runtime report belongs to an earlier native attempt");
          const state = scenarioReports.get(scenario.id) ?? {
            startedAt: new Date().toISOString(),
            reports: new Map<string, StudioScenarioReport>(),
            hash: null,
            settleAt: 0,
          };
          const firstReport = state.reports.values().next().value as
            StudioScenarioReport | undefined;
          if (firstReport && stableJson(firstReport.actors) !== stableJson(report.actors))
            throw new Error("Runtime contexts disagree about actor identities");
          const existing = state.reports.get(report.context);
          if (existing && stableJson(existing) !== stableJson(report))
            throw new Error("Runtime context already submitted different evidence");
          const reportDirectory = resolve(directory, "runtime", scenario.id);
          await ensurePrivateDirectory(resolve(directory, "runtime"));
          await ensurePrivateDirectory(reportDirectory);
          if (!existing) {
            await writePrivateJson(resolve(reportDirectory, `${report.context}.json`), report);
            state.reports.set(report.context, report);
            scenarioReports.set(scenario.id, state);
          }
          if (
            state.hash === null &&
            scenario.reportContexts.every((context) => state.reports.has(context))
          ) {
            const runtimeEvidence = {
              scenarioId: scenario.id,
              startedAt: state.startedAt,
              endedAt: new Date().toISOString(),
              reports: scenario.reportContexts.map((context) => state.reports.get(context)!),
            };
            const runtimeHash = hashJson(runtimeEvidence);
            await writePrivateJson(resolve(reportDirectory, "evidence.json"), runtimeEvidence);
            state.hash = runtimeHash;
            state.settleAt =
              sequencePlan?.scenarioId === scenario.id
                ? sequenceSettleAtMs(sequencePlan, runtimeEvidence.reports, Date.now())
                : Date.now();
            if (native && requestGeneration !== nativeGeneration)
              throw new Error("Native attempt changed while sealing runtime evidence");
            trace.host(
              "runtime.completed",
              {
                scenarioId: scenario.id,
                hash: state.hash,
                contexts: scenario.reportContexts.join(","),
              },
              trialId,
            );
            // The worker stops the sequence recording at this signal. Send it after the holds.
            const signal = () =>
              native?.scenarioComplete?.({
                sessionId: session.id,
                trialId: trialId!,
                scenarioId: scenario.id,
                runtimeHash,
                completedAt: runtimeEvidence.endedAt,
                generation: requestGeneration,
              });
            const delayMs = state.settleAt - Date.now();
            if (delayMs > 0) setTimeout(signal, delayMs);
            else signal();
          }
          return {
            accepted: true,
            complete: state.hash !== null && Date.now() >= state.settleAt,
            runtimeHash: state.hash,
          };
        });
        respond(response, 201, receipt);
        return;
      }
      if (runtimeRoute && request.method === "GET") {
        if (!trialId) throw new Error("Runtime status requires a bound trial");
        if (native && trialId !== nativeTrialId)
          throw new Error("Runtime status belongs to another native trial");
        const scenario = session.plan.scenarios.find((entry) => entry.id === runtimeRoute[1]);
        if (!scenario) throw new Error("Unknown runtime scenario");
        const state = scenarioReports.get(scenario.id);
        respond(response, 200, {
          complete: state !== undefined && state.hash !== null && Date.now() >= state.settleAt,
          runtimeHash: state?.hash ?? null,
          received: scenario.reportContexts.filter((context) => state?.reports.has(context)),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/capture-ready") {
        if (capturing) throw new Error("Another viewport operation is in progress");
        capturing = true;
        try {
          trace.host("backend.started", {}, trialId);
          const preflight = await createAcquisition(directory, "preflight");
          trace.host("backend.discovery", { artifactDirectory: preflight }, trialId);
          await viewportCapture.check(preflight);
          trace.host("backend.ready", {}, trialId);
          respond(response, 200, { ready: true });
        } finally {
          capturing = false;
        }
        return;
      }
      const captureRoute = /^\/captures\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && captureRoute) {
        if (request.headers["content-type"] !== "application/json")
          throw new Error("Capture request must be application/json");
        const phaseId = captureRoute[1]!;
        const captureId = captureRoute[2]!;
        const planned = session.plan.phases
          .find((phase) => phase.id === phaseId)
          ?.captures.find((capture) => capture.id === captureId);
        if (!planned) throw new Error("Unknown capture identity");
        const body = await readRequestJson(request);
        if (!isRecord(body)) throw new Error("Invalid capture request");
        assertExactKeys(body, ["source"]);
        if (body.source !== "studio-mcp") throw new Error("Unknown capture source");
        if (capturing) throw new Error("Another viewport capture is in progress");
        capturing = true;
        let attempt: string | undefined;
        try {
          attempt = await createAcquisition(directory, "capture");
          await writePrivateJson(resolve(attempt, "binding.json"), {
            sessionId: session.id,
            trialId,
            phaseId,
            captureId,
            candidateHash: session.candidateHash,
            collectionPlanHash: session.collectionPlanHash,
            requestedAt: new Date().toISOString(),
          });
          trace.host(
            "capture.started",
            { phaseId, captureId, artifactDirectory: attempt },
            trialId,
          );
          const captured = await viewportCapture.capture(attempt);
          // Keep the acquired bytes before decoding or validating. Failed frames are diagnostics,
          // never inferred as evidence; only sealed submission hashes enter the grader.
          await writePrivateBytes(resolve(attempt, "received.image"), captured.bytes);
          const dimensions = inspectCaptureImage(captured.bytes, captured.mediaType);
          const hash = contentHash(captured.bytes);
          await writePrivateBytes(
            resolve(directory, captureFile(phaseId, captureId, hash)),
            captured.bytes,
          );
          trace.host(
            "capture.stored",
            {
              phaseId,
              captureId,
              hash,
              mediaType: captured.mediaType,
              bytes: captured.bytes.byteLength,
              ...dimensions,
              artifactDirectory: attempt,
            },
            trialId,
          );
          respond(response, 201, { captureId, hash });
        } catch (error) {
          if (attempt) {
            await writePrivateJson(resolve(attempt, "failure.json"), {
              error: errorMessage(error),
              at: new Date().toISOString(),
            });
            trace.host(
              "capture.failed",
              { phaseId, captureId, artifactDirectory: attempt, error: errorMessage(error) },
              trialId,
            );
          }
          throw error;
        } finally {
          capturing = false;
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/submission") {
        const body = await readRequestJson(request);
        assertStudioSubmission(body, session.plan);
        if (body.sessionId !== session.id) throw new Error("Submission session binding mismatch");
        await readSubmittedCaptures(directory, session, body);
        await writePrivateJson(resolve(directory, "submission.json"), body);
        trace.host(
          "submission.accepted",
          { submissionHash: hashJson(body), phases: body.phases.length },
          trialId,
        );
        respond(response, 201, { accepted: true, submissionHash: hashJson(body) });
        return;
      }
      respond(response, 404, { error: "not_found" });
    } catch (error) {
      // Capture failures terminate the owned attempt even if the Play client
      // cannot deliver its subsequent failure trace.
      if (native && (route === "/capture-ready" || /^\/captures\/[^/]+\/[^/]+$/.test(route)))
        native.failed?.(errorMessage(error).replaceAll(session.token, "[REDACTED]"));
      trace.host(
        "request.failed",
        {
          route,
          error: errorMessage(error),
          stack: error instanceof Error ? (error.stack ?? "") : "",
          elapsedMs: Math.round(performance.now() - started),
        },
        trialId,
      );
      respond(response, 400, { error: errorMessage(error) });
    }
  });
  server.once("close", () => {
    viewportCapture.close();
    trace.close();
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => accept());
    });
  } catch (error) {
    trace.host("server.failed", { error: errorMessage(error) });
    trace.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Evidence server has no TCP address");
  if (address.address !== host || address.port !== port)
    throw new Error("Evidence server did not bind the prepared connector endpoint");
  return {
    server,
    url: session.connectorUrl,
    session,
    traceFile: trace.file,
    resetWorkerReady: (scenarioId) => {
      if (
        scenarioId &&
        scenarioId !== "presentation" &&
        !session.plan.scenarios.some((scenario) => scenario.id === scenarioId)
      )
        throw new Error("Unknown native scenario");
      nativeScenarioId = scenarioId ?? null;
      nativeGeneration++;
      editConnected = false;
      sequenceReady = false;
      return nativeGeneration;
    },
    markSequenceReady: (scenarioId, generation) => {
      if (generation !== undefined && generation !== nativeGeneration)
        throw new Error("Sequence readiness belongs to an earlier native attempt");
      if (!native || scenarioId !== sequenceScenarioId)
        throw new Error("Sequence readiness does not match the native recording scenario");
      sequenceReady = true;
      trace.host("sequence.ready", { scenarioId }, nativeTrialId);
    },
  };
}

async function createAcquisition(
  directory: string,
  kind: "capture" | "preflight",
): Promise<string> {
  const root = resolve(directory, "acquisitions");
  await ensurePrivateDirectory(root);
  if ((await readdir(root)).length >= MAX_ACQUISITION_ATTEMPTS)
    throw new Error(
      `Session diagnostic limit (${MAX_ACQUISITION_ATTEMPTS} attempts) reached; archive the session and prepare a new one. No diagnostics were deleted.`,
    );
  return mkdtemp(resolve(root, `${kind}-`));
}

function assertPreparedBootstrapSourcemap(value: unknown, bootstrapFile: string): void {
  if (!isRecord(value) || value.className !== "DataModel" || !Array.isArray(value.children))
    throw new StudioPlaceBuildError("The candidate project must have a DataModel root");
  const matches = value.children.filter(
    (child) => isRecord(child) && child.name === STUDIO_BOOTSTRAP_NAME,
  );
  if (matches.length !== 1) throw new StudioPlaceBuildError(RESERVED_BOOTSTRAP_NAME);
  const bootstrap = matches[0];
  if (
    !isRecord(bootstrap) ||
    bootstrap.className !== "Script" ||
    !Array.isArray(bootstrap.filePaths) ||
    !bootstrap.filePaths.some(
      (path) => typeof path === "string" && path.endsWith(basename(bootstrapFile)),
    )
  )
    // Only a candidate instance with the same name can replace the protected bootstrap Script.
    throw new StudioPlaceBuildError(RESERVED_BOOTSTRAP_NAME);
}

function assertPreparedBootstrapPlace(placeBytes: Buffer, token: string): void {
  const xml = placeBytes.toString("utf8");
  const bootstrapNames = xml.match(/<string name="Name">BasaltEvalBootstrap<\/string>/gu);
  if (bootstrapNames?.length !== 1) throw new StudioPlaceBuildError(RESERVED_BOOTSTRAP_NAME);
  if (!xml.includes(STUDIO_BOOTSTRAP_SCHEMA) || !xml.includes(token))
    throw new Error("Prepared Studio place is missing the bound bootstrap capability");
  const publicProperties = xml.replace(/<(\w+) name="Source">[\s\S]*?<\/\1>/gu, "");
  if (publicProperties.includes(token))
    throw new Error("Prepared Studio capability must only appear in protected source");
}

function assertLoopbackConnectorUrl(value: unknown): {
  host: "127.0.0.1";
  port: number;
  url: string;
} {
  if (typeof value !== "string") throw new Error("Invalid Studio connector URL");
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  const port = match?.[1] ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("Studio connector URL must be an exact loopback URL with an explicit port");
  return { host: "127.0.0.1", port, url: value };
}

function assertStudioSession(value: unknown): asserts value is StudioSession {
  if (!isRecord(value) || value.schema !== "basalt-evals/studio-session")
    throw new Error("Invalid Studio session");
  assertExactKeys(value, [
    "schema",
    "id",
    "token",
    "connectorUrl",
    "treatmentId",
    "candidateHash",
    "collectionPlanHash",
    "connectorSourceHash",
    "connectorArtifactHash",
    "expectedStudioVersion",
    "place",
    "plan",
    "createdAt",
  ]);
  if (!isId(value.treatmentId)) throw new Error("Invalid session treatmentId");
  if (!/^[a-f0-9]{64}$/.test(String(value.token))) throw new Error("Invalid session token");
  const connector = assertLoopbackConnectorUrl(value.connectorUrl);
  for (const field of [
    "candidateHash",
    "collectionPlanHash",
    "connectorSourceHash",
    "connectorArtifactHash",
  ] as const)
    if (!isHash(value[field])) throw new Error(`Invalid session ${field}`);
  if (typeof value.expectedStudioVersion !== "string" || value.expectedStudioVersion.trim() === "")
    throw new Error("Invalid session expectedStudioVersion");
  assertStudioCollectionPlan(value.plan);
  if (!isRecord(value.place) || !isHash(value.place.hash)) throw new Error("Invalid session place");
  studioPlaceName(value.place.file);
  assertExactKeys(value.place, ["file", "hash"]);
  assertIso(value.createdAt);
  if (value.collectionPlanHash !== hashJson(value.plan))
    throw new Error("Studio session plan hash does not match its plan");
  const body = {
    connectorUrl: connector.url,
    treatmentId: value.treatmentId,
    candidateHash: value.candidateHash,
    collectionPlanHash: value.collectionPlanHash,
    connectorSourceHash: value.connectorSourceHash,
    connectorArtifactHash: value.connectorArtifactHash,
    expectedStudioVersion: value.expectedStudioVersion,
    place: value.place,
    plan: value.plan,
    createdAt: value.createdAt,
  };
  if (value.id !== `studio-${hashJson(body).slice(0, 20)}`)
    throw new Error("Studio session identity does not match its contents");
}

async function assertSessionPlace(directory: string, session: StudioSession): Promise<void> {
  const place = await readBoundedRegularFile(
    resolve(directory, session.place.file),
    "Studio session place",
    MAX_PLACE_BYTES,
  );
  if (contentHash(place) !== session.place.hash)
    throw new Error("Studio session place no longer matches the prepared candidate");
}

function assertStudioSubmission(
  value: unknown,
  plan: StudioCollectionPlan,
): asserts value is StudioSubmission {
  if (!isRecord(value) || value.schema !== "basalt-evals/studio-submission")
    throw new Error("Invalid Studio submission schema");
  assertExactKeys(value, [
    "schema",
    "sessionId",
    "studioVersion",
    "startedAt",
    "endedAt",
    "phases",
  ]);
  if (typeof value.sessionId !== "string" || typeof value.studioVersion !== "string")
    throw new Error("Invalid Studio submission identity");
  assertIso(value.startedAt);
  assertIso(value.endedAt);
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt))
    throw new Error("Studio submission ended before it started");
  if (!Array.isArray(value.phases) || value.phases.length !== plan.phases.length)
    throw new Error("Studio submission must contain every plan phase exactly once");
  for (const planned of plan.phases) {
    const submitted = value.phases.find((phase) => isRecord(phase) && phase.phaseId === planned.id);
    if (!isRecord(submitted) || !Array.isArray(submitted.observations))
      throw new Error(`Missing Studio phase ${planned.id}`);
    assertExactKeys(submitted, ["phaseId", "observations", "captures"]);
    if (!Array.isArray(submitted.captures) || submitted.captures.length !== planned.captures.length)
      throw new Error(
        `Studio phase ${planned.id} must contain every requested capture exactly once`,
      );
    const seen = new Set<string>();
    for (const capture of submitted.captures) {
      if (
        !isRecord(capture) ||
        !isId(capture.captureId) ||
        !isHash(capture.hash) ||
        seen.has(capture.captureId) ||
        !planned.captures.some((request) => request.id === capture.captureId)
      )
        throw new Error("Invalid Studio capture receipt");
      assertExactKeys(capture, ["captureId", "hash", "sceneText"]);
      assertSceneTextObservation(capture.sceneText);
      seen.add(capture.captureId);
    }
    if (submitted.observations.length !== planned.facts.length)
      throw new Error(`Studio phase ${planned.id} must contain every requested fact exactly once`);
    for (const fact of planned.facts) {
      const observation = submitted.observations.find(
        (entry) => isRecord(entry) && entry.factId === fact.id,
      );
      if (
        !isRecord(observation) ||
        (observation.kind === "binding_failure"
          ? observation.requestedKind !== fact.kind ||
            !("path" in fact) ||
            observation.path !== fact.path
          : observation.kind !== fact.kind)
      )
        throw new Error(`Missing or mismatched Studio fact ${fact.id}`);
      assertStudioObservation(observation);
      if (
        (fact.kind === "part_motion" && observation.kind === "part_motion") ||
        (fact.kind === "actor_part_motion" && observation.kind === "actor_part_motion")
      ) {
        if (observation.samples.length !== 0 && observation.samples.length !== fact.sampleCount)
          throw new Error("Motion observation must contain every planned sample");
        for (let index = 1; index < observation.samples.length; index++) {
          // Millisecond rounding can shorten a measured interval by at most 1 ms.
          if (
            observation.samples[index]!.elapsedMs - observation.samples[index - 1]!.elapsedMs <
            fact.intervalMs - 1
          )
            throw new Error("Motion samples are closer than the planned interval");
        }
      }
    }
  }
}

async function readRequestBytes(
  request: import("node:http").IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new Error("Request exceeds byte limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readRequestJson(
  request: import("node:http").IncomingMessage,
  limit = MAX_REQUEST_BYTES,
): Promise<unknown> {
  const bytes = await readRequestBytes(request, limit);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Request body is not JSON", { cause: error });
  }
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${stableJson(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writePrivateBytes(file, Buffer.from(`${stableJson(value)}\n`, "utf8"));
}

async function writePrivateBytes(file: string, value: Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, file);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readBoundedRegularFile(
        file,
        "immutable evidence target",
        Math.max(value.byteLength, 1),
      );
      if (!existing.equals(Buffer.from(value)))
        throw new Error(`Immutable evidence target already contains different bytes: ${file}`);
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const target = resolve(directory);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Unsafe private directory: ${target}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await assertSafeAbsoluteDirectory(dirname(target));
    try {
      await mkdir(target, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Unsafe private directory: ${target}`);
  }
  await assertSafeAbsoluteDirectory(target);
}

async function hashWorkspace(root: string): Promise<string> {
  return hashJson(
    await walkRegularTree(root, { label: "Candidate", maxFileBytes: MAX_CANDIDATE_BYTES }),
  );
}

async function readBoundedJson(file: string, label: string, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedRegularFile(file, label, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function readBoundedRegularFile(
  file: string,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  await assertSafeAbsoluteDirectory(dirname(resolve(file)));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new Error(`Cannot open regular ${label}: ${file}`, { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error(`${label} is not a bounded regular file: ${file}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`${label} grew beyond its byte limit: ${file}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertIso(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("Invalid canonical timestamp");
  try {
    if (new Date(value).toISOString() !== value) throw new Error("Invalid canonical timestamp");
  } catch {
    throw new Error("Invalid canonical timestamp");
  }
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
}
function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`Unexpected fields; expected exactly ${wanted.join(", ")}`);
}
async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_000) : "Unknown error";
}
