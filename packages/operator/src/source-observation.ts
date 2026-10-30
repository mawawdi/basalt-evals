import {
  nativeStudioAdapter,
  runAdmitted,
  type StudioAdapter,
} from "../../studio-runner/src/adapter.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { publishSealedSource } from "../../artifact-store/src/sealed-source.js";
import {
  contentHash,
  hashJson,
  type CriterionResult,
  type EvaluatorSpec,
  type StudioEvidence,
  type StudyDefinition,
} from "../../contracts/src/index.js";
import { evaluateDeterministicCriteria, verifyCandidateLocally } from "../../graders/src/index.js";
import { ensureSourceAnalysis, readsSourceAnalysis } from "../../graders/src/source-analysis.js";
import { loadRegisteredTask, materializeTaskSeed } from "../../task-registry/src/index.js";
import { prepareStudioSession, loadStudioSession } from "../../studio-runner/src/index.js";
import { nativeLaneOf } from "../../studio-runner/src/native-lane.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import {
  assertControlSourceFiles,
  type ControlSourceFile,
} from "../../agent-runtime/src/control-generation.js";
import { stageEvalRevision } from "../../eval-authoring/src/stage.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { controlSequencePlan } from "../../eval-authoring/src/control-sequence.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { readRegisteredSource } from "./sources.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const treatmentPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;
const basePattern = /^\.basalt-evals\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/u;

/**
 * The reason for an observation. Only the empty build observes the seed with no added files. A
 * known build observes its registered source with a changed plan.
 */
type ObservationPurpose = "control" | "empty_build" | "known_build";

/**
 * A fixed source: Luau files on top of the seed of the revision, Luau files on top of a
 * registered parent source, or a registered source. A control of a later stage starts from the
 * working control of the stage before, its parent. The observation saves the source as given, so
 * a caller can keep its own fields in the record.
 */
type FixedSource =
  | { files: ControlSourceFile[] }
  | { files: ControlSourceFile[]; parentSourceId: string }
  | { sourceId: string };

/** The result of one observation of a fixed source in Studio. */
type FixedSourceObservation =
  | {
      /** Luau parse or Rojo build refused the source, so Studio did not observe it. */
      status: "rejected";
      candidateHash: string;
      diagnostics: string[];
    }
  | {
      status: "observed";
      candidateHash: string;
      receiptHash: string;
      evidence: StudioEvidence;
      /** The code checks of the revision on this observation. */
      results: CriterionResult[];
      /** The state of the image sequence, or null when the revision records no sequence. */
      sequence: { complete: boolean; reasons: string[] } | null;
    };

/** Zero files are allowed only for the empty build, and the empty build has no files. */
export function assertFixedSource(source: FixedSource, purpose: ObservationPurpose): void {
  if (!source || typeof source !== "object") throw new Error("Choose a fixed source to observe");
  if ("sourceId" in source) {
    if (purpose === "empty_build" || !hashPattern.test(source.sourceId))
      throw new Error("The empty build observes only the seed, not a registered source");
    return;
  }
  if (purpose === "empty_build") {
    if (!Array.isArray(source.files) || source.files.length !== 0 || "parentSourceId" in source)
      throw new Error("The empty build has no source files");
    return;
  }
  if (
    "parentSourceId" in source &&
    (purpose !== "control" || !hashPattern.test(source.parentSourceId))
  )
    throw new Error("Only a control of a later stage starts from a parent source");
  assertControlSourceFiles(source.files);
}

/**
 * Observe one fixed source with the private Studio plan of a revision, then run the code checks
 * of the revision on the signed evidence. Each observation is create-only in its directory: a
 * complete receipt replays after an interruption, and Basalt never runs Studio again for it.
 * Studio sees the purpose `control`, because the runner treats every fixed source the same.
 */
export async function observeFixedSource(input: {
  root: string;
  revisionId: string;
  /** The directory of this observation, relative to the root. The caller owns its identity. */
  base: string;
  purpose: ObservationPurpose;
  source: FixedSource;
  treatmentId: string;
  implementationCommit: string;
  connectorArtifactHash: string;
  environment: Omit<StudyDefinition["environment"], "studioVersion">;
  signal?: AbortSignal;
  studio?: StudioAdapter;
}): Promise<FixedSourceObservation> {
  if (
    !hashPattern.test(input.revisionId) ||
    !basePattern.test(input.base) ||
    !treatmentPattern.test(input.treatmentId) ||
    !hashPattern.test(input.connectorArtifactHash) ||
    !/^[a-f0-9]{40,64}$/u.test(input.implementationCommit)
  )
    throw new Error("Invalid fixed source observation identity");
  assertFixedSource(input.source, input.purpose);
  const root = resolve(input.root);
  const files = new RepositoryFiles(root);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(input.revisionId);
  const staged = await stageEvalRevision(root, revision.id);
  const task = await loadRegisteredTask(root, staged.directory);
  await cleanImplementationCommit(root, input.implementationCommit);
  const adapter = input.studio ?? nativeStudioAdapter;
  const identity = await adapter.identity(root);
  if (identity.connectorArtifactHash !== input.connectorArtifactHash)
    throw new Error(
      "The installed Basalt connector changed after this run started. Start a new run.",
    );
  const registered =
    "sourceId" in input.source
      ? await readRegisteredSource(root, input.source.sourceId)
      : "parentSourceId" in input.source
        ? await readRegisteredSource(root, input.source.parentSourceId)
        : null;
  const projectFile = registered?.source.candidate.projectFile ?? task.publicTask.seed.projectFile;
  if ("parentSourceId" in input.source && projectFile !== task.publicTask.seed.projectFile)
    throw new Error("The parent source uses another source project contract");
  const { base } = input;
  const directory = resolve(root, base);
  const sessionDirectory = resolve(directory, "studio");
  const sourceHash = hashJson(input.source);
  const recorded = () =>
    recordedObservation({
      root,
      base,
      revision,
      evaluator: task.evaluator,
      projectFile,
      sourceHash,
      connectorArtifactHash: input.connectorArtifactHash,
      implementationCommit: input.implementationCommit,
    });
  // An attempt whose prepared session never reached Studio continues from that session.
  let undispatched = false;
  try {
    await files.directory(dirname(directory));
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = await files.json<{ sourceHash: string }>(`${base}/source.json`);
    if (prior.sourceHash !== sourceHash)
      throw new Error("The existing observation has different source bytes");
    const local = await files.optional<LocalRejection>(`${base}/local.json`);
    if (local)
      return {
        status: "rejected",
        candidateHash: local.candidateHash,
        diagnostics: local.diagnostics,
      };
    const saved = await files.optional<{ sourceHash: string }>(`${base}/observation.json`);
    if (saved && saved.sourceHash !== sourceHash)
      throw new Error("The saved observation has a different source identity");
    const remoteJob = await files.optional<unknown>(`${base}/studio/native/remote-job.json`);
    const manifest = await files.optional<SignedWorkerManifest>(
      `${base}/studio/native/manifest.json`,
    );
    if (!saved && !remoteJob && !manifest) {
      // Only a written dispatch marker means Studio may have started.
      if (await files.exists(`${base}/studio/session.json`)) undispatched = true;
      // The attempt stopped before its session was prepared, for example while it waited for a
      // Studio lane. Nothing reached Studio, so the attempt starts again from its source.
      else await rm(resolve(directory, "workspace"), { recursive: true, force: true });
    } else {
      if (!saved) {
        const ownsLane =
          (await nativeLaneOf(resolve(root, ".basalt-evals"), sessionDirectory)) !== null;
        if (!manifest || ownsLane) await adapter.reconcile({ root, directory: sessionDirectory });
      }
      return recorded();
    }
  }
  const workspace = resolve(directory, "workspace");
  if (!undispatched) {
    await files.writeJsonOnce(`${base}/source.json`, { sourceHash, source: input.source });
    if (registered)
      await publishSealedSource(registered.workspaceRoot, workspace, registered.source.candidate);
    else await materializeTaskSeed(root, task, workspace);
  }
  const workspaceFiles = new RepositoryFiles(workspace);
  for (const source of undispatched || !("files" in input.source) ? [] : input.source.files) {
    const target = workspaceFiles.path(source.path);
    await workspaceFiles.directory(dirname(target));
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("A fixed source target is not a regular file");
      await handle.writeFile(source.text);
    } finally {
      await handle.close();
    }
  }
  const candidateFiles = await inventoryTree(workspace);
  const candidateHash = hashJson(candidateFiles);
  // A prepared session exists only after local verification accepted these exact bytes.
  const local = undispatched ? null : await verifyCandidateLocally(workspace, task.publicTask);
  if (local?.gate === "incomplete")
    throw new Error("Local verification is unavailable: " + local.reasons.join("; "));
  if (local?.gate === "rejected") {
    const rejection: LocalRejection = { sourceHash, candidateHash, diagnostics: local.reasons };
    await files.writeJson(`${base}/local.json`, rejection);
    return { status: "rejected", candidateHash, diagnostics: local.reasons };
  }
  const treatment = {
    id: input.treatmentId,
    task: {
      id: task.id,
      publicTaskHash: task.publicTaskHash,
      evaluatorHash: task.evaluatorHash,
      seedHash: task.seedHash,
      collectionPlanHash: task.collectionPlanHash,
    },
    environment: { ...input.environment, studioVersion: identity.studioVersion },
  };
  if (undispatched) {
    const retained = await loadStudioSession(sessionDirectory);
    if (
      retained.candidateHash !== candidateHash ||
      retained.connectorSourceHash !== identity.connectorSourceHash ||
      retained.connectorArtifactHash !== input.connectorArtifactHash ||
      retained.expectedStudioVersion !== identity.studioVersion
    )
      throw new Error("The prepared session differs from this source or Studio environment");
  }
  const receipt = await runAdmitted(adapter, {
    root,
    directory: sessionDirectory,
    purpose: "control",
    ...(input.signal ? { signal: input.signal } : {}),
    // The place holds the port of the admitted lane, so preparation follows admission.
    prepare: async (connectorUrl) => {
      if (!undispatched)
        await prepareStudioSession({
          workspaceRoot: workspace,
          outputDirectory: sessionDirectory,
          task,
          treatment,
          candidate: { projectFile, files: candidateFiles, rootHash: candidateHash },
          connectorSourceHash: identity.connectorSourceHash,
          connectorArtifactHash: input.connectorArtifactHash,
          ...(connectorUrl ? { connectorUrl } : {}),
        });
      const sequence = controlSequencePlan(revision, candidateHash, input.implementationCommit);
      if (sequence) await files.writeJsonOnce(`${base}/studio/sequence.json`, sequence);
    },
  });
  if (receipt.manifest.status !== "complete")
    throw new Error(
      "The Studio evidence of the fixed source is incomplete: " + String(receipt.manifest.failure),
    );
  return recorded();
}

interface LocalRejection {
  sourceHash: string;
  candidateHash: string;
  diagnostics: string[];
}

/** Verify the signed receipt, then run the code checks on its evidence. */
async function recordedObservation(input: {
  root: string;
  base: string;
  revision: EvalRevision;
  evaluator: EvaluatorSpec;
  projectFile: string;
  sourceHash: string;
  connectorArtifactHash: string;
  implementationCommit: string;
}): Promise<Extract<FixedSourceObservation, { status: "observed" }>> {
  const files = new RepositoryFiles(input.root);
  const directory = resolve(input.root, input.base);
  const sessionDirectory = resolve(directory, "studio");
  const pinnedKey = await readFile(
    resolve(input.root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    "utf8",
  );
  const receiptBytes = await readFile(resolve(sessionDirectory, "native/manifest.json"));
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
  await verifyWorkerArtifacts(sessionDirectory, receipt, pinnedKey);
  const session = await loadStudioSession(sessionDirectory);
  const candidateFiles = await inventoryTree(resolve(directory, "workspace"));
  const candidateHash = hashJson(candidateFiles);
  if (
    receipt.manifest.status !== "complete" ||
    receipt.manifest.sessionId !== session.id ||
    receipt.manifest.candidateHash !== candidateHash ||
    receipt.manifest.collectionPlanHash !== hashJson(input.revision.privateEvaluator.studio) ||
    session.candidateHash !== candidateHash ||
    session.connectorArtifactHash !== input.connectorArtifactHash
  )
    throw new Error("The fixed source, the Studio plan or the connector identity changed");
  const evidence = await files.json<StudioEvidence>(`${input.base}/studio/evidence.json`);
  const candidate = {
    projectFile: input.projectFile,
    files: candidateFiles,
    rootHash: candidateHash,
  };
  const results = await evaluateDeterministicCriteria({
    workspaceRoot: resolve(directory, "workspace"),
    evaluator: input.evaluator,
    candidate,
    treatmentId: session.treatmentId,
    evidence,
    analysis: readsSourceAnalysis(input.evaluator.deterministic)
      ? await ensureSourceAnalysis(input.root, resolve(directory, "workspace"), candidate)
      : undefined,
    evidenceDirectory: sessionDirectory,
  });
  const plan = controlSequencePlan(input.revision, candidateHash, input.implementationCommit);
  let sequence: { complete: boolean; reasons: string[] } | null = null;
  if (plan) {
    const bound = await readBoundSequence(sessionDirectory, receipt, plan);
    sequence = {
      complete: bound.assessment.status === "sufficient" && bound.acquisition.status === "complete",
      reasons: bound.assessment.reasons,
    };
  }
  const receiptHash = contentHash(receiptBytes);
  await files.writeJsonOnce(`${input.base}/observation.json`, {
    sourceHash: input.sourceHash,
    candidateHash,
    receiptHash,
  });
  return { status: "observed", candidateHash, receiptHash, evidence, results, sequence };
}
