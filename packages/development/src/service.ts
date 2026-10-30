import {
  nativeStudioAdapter,
  type NativeLaneObserver,
  type StudioAdapter,
} from "../../studio-runner/src/adapter.js";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  AgentInterrupted,
  DevelopmentCandidateError,
  MAX_DEVELOPMENT_SUMMARY_BYTES,
  type DevelopmentObservation,
  type DevelopmentServices,
} from "../../agent-runtime/src/index.js";
import {
  assertStudioEvidence,
  contentHash,
  hashJson,
  studioSequenceView,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { presentSequenceFrames } from "../../studio-runner/src/presentation.js";
import { evidenceImageLabels } from "../../studio-runner/src/image-labels.js";
import {
  checkPublicStudioPlace,
  preparePublicStudioSession,
  loadStudioSession,
  StudioPlaceBuildError,
  type StudioSession,
} from "../../studio-runner/src/index.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import {
  assertSequenceBytes,
  type SequenceAssessment,
  type SequencePlan,
} from "../../studio-runner/src/sequence.js";
import type { SequenceAcquisition, SequenceFrame } from "../../studio-runner/src/studio-mcp.js";
import type { PublicDevelopmentRecipe } from "./index.js";
import type { PublicTask } from "../../contracts/src/index.js";
import { snapshotCandidateTree } from "./snapshot.js";

interface SavedDevelopmentResult {
  id: string;
  directory: string;
  sequenceDirectory: string;
  candidateHash: string;
  summary: string;
  frames: Array<{
    id: string;
    actor: string;
    acquisitionStart: string;
    acquisitionEnd: string;
    file: string;
    hash: string;
    mediaType: "image/png" | "image/jpeg";
    source: SequenceFrame;
  }>;
}

/** One runner, shared with final evaluation, but no hidden evaluator is loaded. */
export function createPublicDevelopmentServices(input: {
  root: string;
  outputRoot: string;
  task: PublicTask;
  recipe: PublicDevelopmentRecipe;
  recipeHash: string;
  implementationCommit: string;
  /** The development runs of the frozen harness. */
  maxRuns: number;
  studio?: StudioAdapter;
  signal?: AbortSignal;
  lane?: NativeLaneObserver;
}): DevelopmentServices {
  const saved = new Map<string, SavedDevelopmentResult>();
  const files = new RepositoryFiles(input.outputRoot);
  async function collect(
    workspaceRoot: string,
    candidate: Parameters<DevelopmentServices["run"]>[1],
    scenarioId: string,
    id: string,
    recovering: boolean,
    signal?: AbortSignal,
  ): Promise<DevelopmentObservation> {
    if (!/^development-[a-f0-9]{24}$/u.test(id))
      throw new Error("Invalid owned development action");
    const view = input.recipe.views.find((item) => item.id === scenarioId);
    if (!view) throw new Error("Unknown public development view");
    await cleanImplementationCommit(input.root, input.implementationCommit);
    const adapter = input.studio ?? nativeStudioAdapter;
    const identity = await adapter.identity(input.root);
    const directory = resolve(input.outputRoot, id);
    if (!recovering) await mkdir(directory, { mode: 0o700 });
    const snapshot = resolve(directory, "candidate");
    if (!recovering)
      await snapshotCandidateTree({
        source: workspaceRoot,
        target: snapshot,
        expectedHash: candidate.rootHash,
        projectFile: candidate.projectFile,
      });
    else if (hashJson(await inventoryTree(snapshot)) !== candidate.rootHash)
      throw new Error("Interrupted development source differs from its candidate");
    const studio = resolve(directory, "studio");
    const plan: SequencePlan = {
      schema: "basalt-evals/sequence-plan",
      suiteHash: input.recipeHash,
      sourceHash: candidate.rootHash,
      implementationCommit: input.implementationCommit,
      viewId: view.id,
      ...studioSequenceView(view),
    };
    const exists = (path: string) =>
      lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    const sequenceFile = resolve(studio, "sequence.json");
    // A crash can come after the session folder and before its sequence plan. An absent plan is
    // written again; a different plan stops the recovery. The plan appears complete or not at all.
    const writeSequence = async () => {
      try {
        await publishImmutable(sequenceFile, `${JSON.stringify(plan)}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hashJson(JSON.parse(await readFile(sequenceFile, "utf8"))) !== hashJson(plan))
          throw new Error("Interrupted development acquisition plan changed");
      }
    };
    // A job prepares its session after admission, because the place holds the port of its lane.
    // A run that stopped while the job waited for Studio has no session yet.
    const prepared = recovering && (await exists(resolve(studio, "session.json")));
    let session = prepared ? await loadStudioSession(studio) : null;
    if (prepared) await writeSequence();
    const stateRoot = resolve(input.root, ".basalt-evals");
    const keyFile = resolve(stateRoot, "native-worker/isolated-public-key.pem");
    const nativeInput = {
      root: input.root,
      directory: studio,
      ...((signal ?? input.signal) ? { signal: signal ?? input.signal } : {}),
    };
    const retained = prepared
      ? await new RepositoryFiles(studio).optional<SignedWorkerManifest>("native/manifest.json")
      : null;
    // Only a written dispatch marker means Studio may have started. Without one, a fresh or
    // interrupted attempt waits for a native lane and then runs. Busy Studio is not a failure.
    const dispatched = prepared && (await exists(resolve(studio, "native/remote-job.json")));
    const toInterrupted = (error: unknown) =>
      error instanceof AgentInterrupted
        ? error
        : new AgentInterrupted(
            `The public Studio test stopped before it finished (${error instanceof Error ? error.message : String(error)}). To continue the build from this point, resume the run.`,
            { cause: error },
          );
    const interrupted = (error: unknown): never => {
      throw toInterrupted(error);
    };
    // A candidate that Rojo cannot build is a result for the builder, also after a resume.
    const candidateFailure = (error: unknown): never => {
      if (error instanceof StudioPlaceBuildError)
        throw new DevelopmentCandidateError(error.message, { cause: error });
      throw error;
    };
    const place = {
      workspaceRoot: snapshot,
      publicTask: input.task,
      collectionPlan: input.recipe.plan,
      treatmentId: id,
      studioVersion: identity.studioVersion,
      candidate,
      connectorSourceHash: identity.connectorSourceHash,
      connectorArtifactHash: identity.connectorArtifactHash,
      ...(signal ? { signal } : {}),
    };
    let receipt: SignedWorkerManifest;
    if (retained) receipt = retained;
    else if (dispatched) receipt = await adapter.reconcile(nativeInput).catch(interrupted);
    else {
      // Rojo builds the candidate before the job waits for Studio. Thus a broken candidate
      // fails at once, and it never holds a Studio turn or a lane.
      if (!session)
        await checkPublicStudioPlace({ ...place, scratchDirectory: directory }).catch(
          candidateFailure,
        );
      const admission = await adapter
        .admit?.({
          ...nativeInput,
          purpose: "development",
          ...(input.lane?.onWaiting ? { onWaiting: input.lane.onWaiting } : {}),
        })
        .catch(interrupted);
      let outcome: { receipt: SignedWorkerManifest } | { error: unknown };
      try {
        try {
          await input.lane?.onAdmitted?.();
        } catch (error) {
          interrupted(error);
        }
        session ??= await preparePublicStudioSession({
          ...place,
          outputDirectory: studio,
          ...(admission ? { connectorUrl: admission.connectorUrl } : {}),
        }).catch(candidateFailure);
        if (!prepared) await writeSequence();
        outcome = { receipt: await adapter.run(nativeInput).catch(interrupted) };
      } catch (error) {
        outcome = { error };
      }
      // A failure of the release does not hide the failure of the Studio test.
      try {
        await admission?.release();
      } catch (error) {
        if ("receipt" in outcome) outcome = { error: toInterrupted(error) };
      }
      if ("error" in outcome) throw outcome.error;
      receipt = outcome.receipt;
    }
    // A receipt exists only for a prepared session.
    if (!session) throw new Error("The development run has no prepared Studio session");
    await verifyWorkerArtifacts(studio, receipt, await readFile(keyFile, "utf8"));
    if (
      receipt.manifest.sessionId !== session.id ||
      receipt.manifest.candidateHash !== candidate.rootHash ||
      receipt.manifest.collectionPlanHash !== session.collectionPlanHash
    )
      throw new Error("Public Studio receipt differs from its frozen acquisition");
    if (receipt.manifest.status !== "complete")
      return {
        evidenceId: id,
        activeDurationMs: Math.max(
          0,
          Date.parse(receipt.manifest.completedAt) - Date.parse(receipt.manifest.startedAt),
        ),
        candidateHash: candidate.rootHash,
        frames: [],
        summary: boundedDevelopmentSummary(
          JSON.stringify({
            acquisition: "incomplete",
            failure: receipt.manifest.failure,
            receiptHash: hashJson(receipt),
            instruction: "No rendered outcome can be inferred from this incomplete acquisition.",
          }),
          0,
        ),
      };
    const evidence = await readDevelopmentEvidence(studio, receipt, session);
    if (
      evidence.candidateHash !== candidate.rootHash ||
      session.candidateHash !== candidate.rootHash
    )
      throw new Error("Public Studio evidence changed candidate identity");
    const matches = receipt.manifest.artifacts.filter((artifact) =>
      new RegExp(`^native/sequence/${view.scenarioId}-attempt-[0-9]{2}/assessment\\.json$`).test(
        artifact.file,
      ),
    );
    if (matches.length !== 1) throw new Error("Signed public sequence assessment is missing");
    const assessmentFile = matches[0]!.file;
    const sequence = resolve(studio, dirname(assessmentFile));
    const assessment = JSON.parse(
      await readFile(resolve(studio, assessmentFile), "utf8"),
    ) as SequenceAssessment;
    const acquisition = JSON.parse(
      await readFile(resolve(sequence, "index.json"), "utf8"),
    ) as SequenceAcquisition;
    if (assessment.planHash !== hashJson(plan))
      throw new Error("Public sequence assessment plan changed");
    const presentation =
      assessment.status === "sufficient"
        ? presentSequenceFrames({ plan, acquisition, assessment, treatment: "sequence" })
        : null;
    const frames = developmentFrames(acquisition, assessment);
    const result: SavedDevelopmentResult = {
      id,
      directory,
      sequenceDirectory: sequence,
      candidateHash: candidate.rootHash,
      summary: developmentSummary(evidence, assessment, frames.length),
      frames,
    };
    saved.set(id, result);
    const retainedResult = {
      schema: "basalt-evals/development-result",
      id,
      candidateHash: candidate.rootHash,
      recipeHash: input.recipeHash,
      sessionId: session.id,
      receiptHash: contentHash(await readFile(resolve(studio, "native/manifest.json"))),
      assessmentFile,
      result,
      resultHash: hashJson(result),
    };
    await files.writeJsonOnce(`${id}/development.json`, retainedResult);
    // Show transition frames first. Uniform fill frames only complete the four images.
    const chosen = [...(presentation?.frames ?? [])]
      .sort(
        (left, right) =>
          Number(left.roles.every((role) => role === "uniform")) -
          Number(right.roles.every((role) => role === "uniform")),
      )
      .slice(0, 4)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    return {
      ...(await loadFrames(
        result,
        chosen.map((item) => frames.find((frame) => frame.file === item.file)!),
        chosen.map((item) => item.roles),
      )),
      activeDurationMs: Math.max(
        0,
        Date.parse(receipt.manifest.completedAt) - Date.parse(receipt.manifest.startedAt),
      ),
    };
  }
  return {
    publicScenarios: input.recipe.views.map((view) => view.id),
    maxRuns: input.maxRuns,
    run: (workspace, candidate, scenario, id, signal) =>
      collect(workspace, candidate, scenario, id, false, signal),
    recover: (workspace, candidate, scenario, id, signal) =>
      collect(workspace, candidate, scenario, id, true, signal),
    async inspect(evidenceId, frameIds) {
      if (!/^development-[a-f0-9]{24}$/u.test(evidenceId))
        throw new Error("Unknown development evidence identifier");
      let result = saved.get(evidenceId);
      if (!result) {
        const retained = await files.json<{
          recipeHash: string;
          resultHash: string;
          result: SavedDevelopmentResult;
          assessmentFile: string;
          receiptHash: string;
        }>(`${evidenceId}/development.json`);
        const studio = resolve(input.outputRoot, evidenceId, "studio");
        if (
          retained.recipeHash !== input.recipeHash ||
          retained.resultHash !== hashJson(retained.result) ||
          retained.result.id !== evidenceId ||
          retained.result.directory !== resolve(input.outputRoot, evidenceId) ||
          !/^native\/sequence\/[a-z0-9_-]+-attempt-[0-9]{2}\/assessment\.json$/u.test(
            retained.assessmentFile,
          ) ||
          retained.result.sequenceDirectory !== resolve(studio, dirname(retained.assessmentFile))
        )
          throw new Error("Saved development result has invalid provenance");
        const receiptBytes = await new RepositoryFiles(studio).bytes("native/manifest.json");
        if (contentHash(receiptBytes) !== retained.receiptHash)
          throw new Error("Development receipt changed");
        const receipt = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
        await verifyWorkerArtifacts(
          studio,
          receipt,
          await readFile(
            resolve(input.root, ".basalt-evals/native-worker/isolated-public-key.pem"),
            "utf8",
          ),
        );
        const session = await loadStudioSession(studio);
        if (
          session.candidateHash !== retained.result.candidateHash ||
          receipt.manifest.sessionId !== session.id ||
          receipt.manifest.candidateHash !== session.candidateHash ||
          receipt.manifest.collectionPlanHash !== session.collectionPlanHash
        )
          throw new Error("Development source changed");
        const native = new RepositoryFiles(studio);
        const acquisitionFile = `${dirname(retained.assessmentFile)}/index.json`;
        if (
          ![retained.assessmentFile, acquisitionFile].every((file) =>
            receipt.manifest.artifacts.some((item) => item.file === file),
          )
        )
          throw new Error("Development observations are outside signed acquisition");
        const assessment = await native.json<SequenceAssessment>(retained.assessmentFile);
        const acquisition = await native.json<SequenceAcquisition>(acquisitionFile);
        const evidence = await readDevelopmentEvidence(studio, receipt, session);
        if (
          hashJson(retained.result.frames) !== hashJson(developmentFrames(acquisition, assessment))
        )
          throw new Error("Development presentation differs from original evidence");
        // Presentation is derived from signed evidence on every cold read. The
        // retained result hash still protects the receipt, but cached prose is
        // never an authority or a reason to rewrite immutable evidence.
        result = {
          ...retained.result,
          summary: developmentSummary(evidence, assessment, acquisition.frames.length),
        };
        saved.set(evidenceId, result);
      }
      const requested = frameIds.map((id) => {
        const frame = result.frames.find((item) => item.id === id);
        if (!frame) throw new Error(`Unknown verified frame ${id}`);
        return frame;
      });
      if (new Set(frameIds).size !== frameIds.length)
        throw new Error("Duplicate development frame IDs");
      return loadFrames(result, requested);
    },
  };
}

async function readDevelopmentEvidence(
  directory: string,
  receipt: SignedWorkerManifest,
  session: StudioSession,
): Promise<StudioEvidence> {
  if (!receipt.manifest.artifacts.some((artifact) => artifact.file === "evidence.json"))
    throw new Error("Development observations are outside signed acquisition");
  const evidence = await new RepositoryFiles(directory).json<StudioEvidence>("evidence.json");
  assertStudioEvidence(evidence);
  if (
    evidence.studio.sessionId !== session.id ||
    evidence.treatmentId !== session.treatmentId ||
    evidence.candidateHash !== session.candidateHash ||
    evidence.collectionPlanHash !== session.collectionPlanHash ||
    evidence.connectorSourceHash !== session.connectorSourceHash ||
    evidence.connectorArtifactHash !== session.connectorArtifactHash
  )
    throw new Error("Development observations differ from their frozen session");
  return evidence;
}

function developmentFrames(acquisition: SequenceAcquisition, assessment: SequenceAssessment) {
  const actors = new Map(assessment.actorFrames.map((item) => [item.userId, item.actor]));
  return acquisition.frames.map((frame, index) => {
    const actor = actors.get(frame.playerUserId);
    if (!actor) throw new Error("Public development frame has an unbound actor");
    return {
      id: `frame-${index + 1}`,
      actor,
      acquisitionStart: frame.startedAt,
      acquisitionEnd: frame.endedAt,
      file: frame.file,
      hash: frame.hash,
      mediaType: frame.mediaType,
      source: frame,
    };
  });
}

function developmentSummary(
  evidence: StudioEvidence,
  assessment: SequenceAssessment,
  frameCount: number,
) {
  const summary = JSON.stringify({
    acquisition: assessment.status,
    reasons: assessment.reasons,
    actors: assessment.actorFrames,
    transitions: assessment.transitions,
    observedScenarios: evidence.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      reports: scenario.reports.map((report) => ({
        context: report.context,
        steps: report.steps.map((step) => ({
          stepId: step.stepId,
          action: step.action,
          observations: step.observations,
        })),
      })),
    })),
  });
  return boundedDevelopmentSummary(summary, frameCount);
}

function boundedDevelopmentSummary(summary: string, frameCount: number): string {
  // developmentFrames assigns every original a contiguous one-based ID.
  const catalog =
    frameCount === 0
      ? "\nAvailable frame IDs: none."
      : `\nAvailable frame IDs: frame-1 through frame-${frameCount} (inclusive; ${frameCount} original frames). Use development.inspect with one to four exact IDs.`;
  const bytes = Buffer.from(summary, "utf8");
  if (bytes.length + Buffer.byteLength(catalog, "utf8") <= MAX_DEVELOPMENT_SUMMARY_BYTES)
    return summary + catalog;
  const suffix =
    "\n[Runtime observation summary truncated; complete observations remain in signed evidence.]" +
    catalog;
  let end = MAX_DEVELOPMENT_SUMMARY_BYTES - Buffer.byteLength(suffix, "utf8");
  // Exclude an incomplete UTF-8 code point rather than inserting a replacement.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

/** Roles are present only for frames that the fixed selection chose. */
async function loadFrames(
  result: SavedDevelopmentResult,
  requested: SavedDevelopmentResult["frames"],
  roles: string[][] = requested.map(() => []),
): Promise<DevelopmentObservation> {
  const labels = evidenceImageLabels(
    requested.map((frame, index) => ({
      frameId: frame.id,
      player: frame.actor,
      clock: { kind: "unstated" as const },
      roles: roles[index]!,
    })),
  );
  const frames = await Promise.all(
    requested.map(async (frame, index) => {
      const bytes = await readBoundedRegularFile(
        resolve(result.sequenceDirectory, frame.file),
        16 * 1024 * 1024,
        "signed development frame",
      );
      assertSequenceBytes(frame.source, bytes);
      return {
        id: frame.id,
        actor: frame.actor,
        acquisitionStart: frame.acquisitionStart,
        acquisitionEnd: frame.acquisitionEnd,
        image: {
          mediaType: frame.mediaType,
          dataBase64: bytes.toString("base64"),
          hash: frame.hash,
          label: labels[index]!,
        },
      };
    }),
  );
  return {
    evidenceId: result.id,
    candidateHash: result.candidateHash,
    summary: result.summary,
    frames,
  };
}
