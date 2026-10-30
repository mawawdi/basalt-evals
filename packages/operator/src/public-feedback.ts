import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  MAX_CAPTURE_BYTES,
  studioSequenceView,
} from "../../contracts/src/index.js";
import { publicRepairContext } from "../../development/src/repair-context.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import type { SignedWorkerManifest } from "../../studio-runner/src/native-worker.js";
import { presentSequenceFrames } from "../../studio-runner/src/presentation.js";
import { RunOperationStore } from "./operation.js";
import { captureView, frozenSequencePlan, subjectEval, manifestHash } from "./run-manifest.js";
import { operationSource, readRegisteredSource } from "./sources.js";

export interface RegisteredPublicFeedback {
  id: string;
  operationId: string;
  subjectId: string;
  sourceId: string;
  viewId: string;
  pass: number;
  sourceHash: string;
  publicContentHash: string;
  captureReceiptHash: string;
  selection: "evenly_spaced_four";
  contextHash: string;
}

/** This reader cannot project private criteria or judgments into a repair context. */
async function feedbackMaterial(
  root: string,
  input: Pick<
    RegisteredPublicFeedback,
    "operationId" | "subjectId" | "sourceId" | "viewId" | "pass"
  >,
) {
  const files = new RepositoryFiles(root);
  const manifest = await files.json<RunOperationManifest>(
    `.basalt-evals/eval-operations/${input.operationId}/manifest.json`,
  );
  const cell = manifest.captureCells.find(
    (cell) =>
      cell.treatmentId === input.subjectId &&
      cell.viewId === input.viewId &&
      cell.pass === input.pass,
  );
  if (!cell || cell.partition !== "development")
    throw new Error(
      "This run has no extra observation of this build. Record an extra observation of the build first.",
    );
  const operation = new RunOperationStore(
    root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const status = await operation.readForStage("final_capture", cell.id);
  const receipt = status.events.find(
    (event) =>
      event.stage === "final_capture" && event.unitId === cell.id && event.kind === "completed",
  );
  if (!receipt)
    throw new Error(
      "The extra observation of this build is not complete. When it is complete, try the repair again.",
    );
  const evaluation = subjectEval(manifest, input.subjectId);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
  const view = captureView(manifest, cell.id);
  const publicView = revision.publicDevelopment.views.find((item) => item.id === view.id);
  if (
    !publicView ||
    hashJson(view.plan) !== hashJson(revision.publicDevelopment.plan) ||
    hashJson(view.sequence) !== hashJson(studioSequenceView(publicView))
  )
    throw new Error("Repair feedback must use the prompt-only public development plan");
  const source = await operationSource(root, manifest, input.subjectId);
  const parent = await readRegisteredSource(root, input.sourceId);
  if (hashJson(source.candidate) !== hashJson(parent.source.candidate))
    throw new Error("Feedback belongs to a different repair parent");
  const plan = frozenSequencePlan(manifest, cell.id, source.candidate.rootHash);
  if (!plan) throw new Error("Public feedback requires a bound development sequence");
  const base = `.basalt-evals/eval-operations/${manifest.id}/capture/${cell.id}/studio`;
  const signed = await files.json<SignedWorkerManifest>(`${base}/native/manifest.json`);
  const bound = await readBoundSequence(files.path(base), signed, plan);
  const presented = presentSequenceFrames({ ...bound, treatment: "sequence" });
  if (presented.status === "insufficient")
    throw new Error(
      `The extra observation of this build does not have enough usable frames (${presented.reasons.join("; ")}). Record a new extra observation of the build.`,
    );
  // Fixed index selection uses no pixels, oracle values, labels, or grader decisions.
  // Transition frames come first; uniform fill frames are the pool only without transitions.
  const transitionFrames = presented.frames.filter((frame) =>
    frame.roles.some((role) => role !== "uniform"),
  );
  const pool = transitionFrames.length ? transitionFrames : presented.frames;
  const indices = new Set(
    Array.from({ length: Math.min(4, pool.length) }, (_, index) =>
      Math.round((index * (pool.length - 1)) / Math.max(1, Math.min(4, pool.length) - 1)),
    ),
  );
  const frames = pool.filter((_, index) => indices.has(index));
  const presentation = {
    ...presented,
    frames,
    context: {
      ...presented.context,
      intervals: presented.context.intervals.filter((item) =>
        frames.some((frame) => frame.id === item.frameId),
      ),
    },
  };
  const images = await Promise.all(
    frames.map(async (frame) => {
      const bytes = await files.bytes(`${base}/${bound.prefix}${frame.file}`, MAX_CAPTURE_BYTES);
      if (contentHash(bytes) !== frame.hash) throw new Error("Public repair frame changed");
      return { id: frame.id, mediaType: frame.mediaType, bytes };
    }),
  );
  return {
    context: publicRepairContext({ presentation, images }),
    sourceHash: source.candidate.rootHash,
    publicContentHash: evaluation.publicContentHash,
    captureReceiptHash: receipt.id,
  };
}

export async function registerPublicFeedback(
  root: string,
  input: Pick<
    RegisteredPublicFeedback,
    "operationId" | "subjectId" | "sourceId" | "viewId" | "pass"
  >,
) {
  const material = await feedbackMaterial(root, input);
  const body = {
    ...input,
    sourceHash: material.sourceHash,
    publicContentHash: material.publicContentHash,
    captureReceiptHash: material.captureReceiptHash,
    selection: "evenly_spaced_four" as const,
    contextHash: hashJson(material.context),
  };
  const saved = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/public-feedback/${saved.id}.json`;
  await files.writeJsonOnce(path, saved);
  return saved;
}

export async function readPublicFeedback(
  root: string,
  id: string,
  parentSourceId: string,
  publicContentHash: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid public feedback identity");
  const saved = await new RepositoryFiles(root).json<RegisteredPublicFeedback>(
    `.basalt-evals/public-feedback/${id}.json`,
  );
  const { id: savedId, ...body } = saved;
  if (
    savedId !== id ||
    hashJson(body) !== id ||
    saved.sourceId !== parentSourceId ||
    saved.publicContentHash !== publicContentHash ||
    saved.selection !== "evenly_spaced_four"
  )
    throw new Error("Public feedback binding changed");
  const material = await feedbackMaterial(root, saved);
  if (
    hashJson(material.context) !== saved.contextHash ||
    material.sourceHash !== saved.sourceHash ||
    material.captureReceiptHash !== saved.captureReceiptHash ||
    material.publicContentHash !== saved.publicContentHash
  )
    throw new Error("Public feedback no longer matches its signed acquisition");
  return { saved, context: material.context };
}
