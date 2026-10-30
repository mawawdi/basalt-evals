import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import {
  assertStudioEvidence,
  hashJson,
  type PublicTask,
  type StudioCollectionPlan,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { EXECUTION_LIMITS } from "../../contracts/src/execution-limits.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { neutralRojoSeed } from "../../eval-authoring/src/seed.js";
import { prepareBoundStudioSession, loadStudioSession } from "../../studio-runner/src/index.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import { NativeLaneBusy } from "../../studio-runner/src/native-lane.js";
import { ownedComputation } from "./owned-computation.js";

interface StudioReadinessReceipt {
  identityHash: string;
  completedAt: string;
  expiresAt: string;
  manifestHash: string;
  evidenceHash: string;
  directory: string;
}

const task: PublicTask = {
  schema: "basalt-evals/task",
  slug: "infrastructure-canary",
  title: "Studio readiness",
  prompt: "Inspect the fixed neutral environment.",
  seed: { projectFile: "default.project.json", sourceRoots: ["src"] },
  roles: [],
  acceptance: [],
  evidenceInstructions: [],
};
const plan: StudioCollectionPlan = {
  schema: "basalt-evals/studio-plan",
  clients: 1,
  actors: ["primary"],
  roles: [],
  scenarios: [],
  phases: [
    {
      id: "readiness",
      label: "Check Studio",
      instruction: "Observe the supplied neutral ground and capture the running scene.",
      driver: { kind: "wait_for_session", timeoutMs: 15_000 },
      facts: [{ id: "ground", kind: "instance", path: "game.Workspace.Ground" }],
      captures: [{ id: "readiness", instruction: "Capture the running neutral scene." }],
    },
  ],
};

/** Authorized native work only. Preview never calls this service. No model is involved. */
export async function ensureStudioReadiness(input: {
  root: string;
  operationId: string;
  studio: StudioAdapter;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<StudioReadinessReceipt> {
  const now = input.now ?? Date.now;
  const identity = await input.studio.identity(input.root);
  const identityHash = hashJson({ identity, plan, limits: EXECUTION_LIMITS });
  const journal = await OperationJournal.open(input.root);
  let previous: StudioReadinessReceipt | null;
  let previousAttempt: string | null;
  try {
    previous = journal.read<StudioReadinessReceipt>("studio_readiness", identityHash);
    previousAttempt = journal.read<string>("studio_readiness_attempts", identityHash);
  } finally {
    journal.close();
  }
  if (previous && Date.parse(previous.expiresAt) > now()) return previous;
  const key = hashJson({ identityHash, previous: previousAttempt });
  return ownedComputation({
    ...input,
    namespace: "studio_canaries",
    key,
    run: async () => {
      const deadline = AbortSignal.timeout(EXECUTION_LIMITS.readinessRequestMs);
      const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      try {
        const base = `.basalt-evals/studio-readiness/${key}`;
        const files = new RepositoryFiles(input.root);
        const workspace = resolve(input.root, base, "workspace");
        await files.directory(`${base}/workspace`);
        const wf = new RepositoryFiles(workspace);
        const seed = neutralRojoSeed("StudioReadiness");
        if (!(await wf.optional("default.project.json"))) {
          await wf.writeJson("default.project.json", seed.project);
          for (const source of seed.sources) await wf.write(source.path, source.text);
        }
        const candidateFiles = await inventoryTree(workspace);
        const directory = resolve(input.root, base, "studio");
        const retainedSession = await files.optional(`${base}/studio/session.json`);
        let session = retainedSession ? await loadStudioSession(directory) : null;
        const retained = await files.optional<SignedWorkerManifest>(
          `${base}/studio/native/manifest.json`,
        );
        const dispatched = await files.optional(`${base}/studio/native/remote-job.json`);
        let manifest: SignedWorkerManifest;
        if (dispatched) {
          try {
            manifest = await input.studio.reconcile({ root: input.root, directory });
          } catch (error) {
            // A lost canary has no evidence. A new attempt key lets the next check start again.
            if (error instanceof ExecutionFault && error.failure.causeCode === "studio_job_lost") {
              const attempts = await OperationJournal.open(input.root);
              try {
                attempts.put("studio_readiness_attempts", identityHash, hashJson(error.failure));
              } finally {
                attempts.close();
              }
            }
            throw error;
          }
        } else if (retained) manifest = retained;
        else {
          // The read-only setup checks come before admission. A failed check names its cause,
          // and no Studio job starts.
          const problems = await input.studio.preflight(input.root);
          if (problems.length)
            throw new ExecutionFault({
              causeCode: "studio_setup_incomplete",
              category: "startup",
              dependency: identityHash,
              unit: { stage: "readiness", id: input.operationId },
              evidenceRefs: [hashJson(problems)],
              recoveryActions: ["inspect", "resume"],
              explanation: `The Studio setup is not complete. Basalt did not start Studio or paid work. ${problems.join(" ")}`,
            });
          // Readiness takes any free lane, but it does not wait for one. If each lane is busy,
          // it reports a busy Studio at once.
          const admission = await input.studio.admit?.({
            root: input.root,
            directory,
            purpose: "readiness",
            signal,
            onWaiting: async () => {
              throw new NativeLaneBusy(resolve(input.root, ".basalt-evals"));
            },
          });
          let outcome: { manifest: SignedWorkerManifest } | { error: unknown };
          try {
            // The place holds the port of the admitted lane, so preparation follows admission.
            session ??= await prepareBoundStudioSession({
              workspaceRoot: workspace,
              outputDirectory: directory,
              publicTask: task,
              signal,
              collectionPlan: plan,
              collectionPlanHash: hashJson(plan),
              treatmentId: `readiness-${key.slice(0, 16)}`,
              ...identity,
              candidate: {
                projectFile: task.seed.projectFile,
                files: candidateFiles,
                rootHash: hashJson(candidateFiles),
              },
              ...(admission ? { connectorUrl: admission.connectorUrl } : {}),
            });
            signal.throwIfAborted();
            outcome = { manifest: await input.studio.run({ root: input.root, directory, signal }) };
          } catch (error) {
            outcome = { error };
          }
          // A failure of the release does not hide the failure of the preparation or of the run.
          try {
            await admission?.release();
          } catch (error) {
            if ("manifest" in outcome) outcome = { error };
          }
          if ("error" in outcome) throw outcome.error;
          manifest = outcome.manifest;
        }
        // A receipt exists only for a prepared session.
        if (!session) throw new Error("The readiness check has no prepared Studio session");
        const keyFile = await readFile(
          resolve(input.root, ".basalt-evals/native-worker/isolated-public-key.pem"),
          "utf8",
        );
        await verifyWorkerArtifacts(directory, manifest, keyFile);
        if (
          manifest.manifest.sessionId !== session.id ||
          manifest.manifest.candidateHash !== session.candidateHash ||
          manifest.manifest.collectionPlanHash !== session.collectionPlanHash
        )
          throw new Error("Studio readiness receipt belongs to a different frozen session");
        const attempts = await OperationJournal.open(input.root);
        try {
          attempts.put("studio_readiness_attempts", identityHash, hashJson(manifest));
        } finally {
          attempts.close();
        }
        if (manifest.manifest.status !== "complete") {
          if (manifest.manifest.failureRecord)
            throw new ExecutionFault({
              ...manifest.manifest.failureRecord,
              unit: { stage: "readiness", id: input.operationId },
              evidenceRefs: [hashJson(manifest)],
              recoveryActions: ["inspect", "resume"],
              explanation: `Studio failed the readiness check. Basalt did not start paid work. Cause: ${manifest.manifest.failureRecord.explanation}`,
            });
          throw new Error(
            manifest.manifest.failure ?? "Studio did not finish the readiness check.",
          );
        }
        const evidence = await files.json<StudioEvidence>(`${base}/studio/evidence.json`);
        assertStudioEvidence(evidence);
        const phase = evidence.phases.find((p) => p.phaseId === "readiness");
        const ground = phase?.observations.find((f) => f.factId === "ground");
        if (
          evidence.studio.sessionId !== session.id ||
          evidence.studio.version !== identity.studioVersion ||
          evidence.candidateHash !== session.candidateHash ||
          evidence.collectionPlanHash !== hashJson(plan) ||
          evidence.connectorArtifactHash !== identity.connectorArtifactHash ||
          ground?.kind !== "instance" ||
          !ground.exists ||
          ground.className !== "Part" ||
          !phase?.captures.some((c) => c.captureId === "readiness" && c.width > 0 && c.height > 0)
        )
          throw new Error(
            "The readiness check did not record the Ground part or an image of the scene.",
          );
        if (hashJson(await input.studio.identity(input.root)) !== hashJson(identity))
          throw new Error(
            "Studio, the Basalt connector or the Studio setup changed before the readiness check finished. Resume the run.",
          );
        const receipt: StudioReadinessReceipt = {
          identityHash,
          completedAt: new Date(now()).toISOString(),
          expiresAt: new Date(now() + EXECUTION_LIMITS.readinessCacheMs).toISOString(),
          manifestHash: hashJson(manifest),
          evidenceHash: hashJson(evidence),
          directory: base,
        };
        await files.writeJson(`${base}/receipt.json`, receipt);
        const completed = await OperationJournal.open(input.root);
        try {
          completed.put("studio_readiness", identityHash, receipt);
        } finally {
          completed.close();
        }
        return receipt;
      } catch (error) {
        if (error instanceof ExecutionFault)
          throw new ExecutionFault({
            ...error.failure,
            unit: { stage: "readiness", id: input.operationId },
          });
        throw new ExecutionFault({
          causeCode: deadline.aborted ? "studio_readiness_timeout" : "studio_readiness_failed",
          category: "startup",
          dependency: identityHash,
          unit: { stage: "readiness", id: input.operationId },
          evidenceRefs: [key],
          recoveryActions: ["inspect", "resume"],
          explanation: `Studio failed the readiness check. Basalt did not start paid work. Cause: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  });
}
