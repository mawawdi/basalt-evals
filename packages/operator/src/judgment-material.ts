import {
  DONOR_SUBSTITUTION_KINDS,
  type AuthoredRegion,
  type RunJudgmentBatch,
  type RunOperationManifest,
} from "../../contracts/src/execution.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  MAX_CAPTURE_BYTES,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { scoringCriteria } from "../../eval-authoring/src/scoring.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import {
  criterionMaterial,
  type ExecutableCriterion,
} from "../../eval-authoring/src/criterion-material.js";
import { renderedEvidence } from "../../studio-runner/src/rendered-evidence.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import type { SignedWorkerManifest } from "../../studio-runner/src/native-worker.js";
import type { SequencePlan } from "../../studio-runner/src/sequence.js";
import { applyEvidenceControl, type FillFrame, type FrameInterval } from "./evidence-controls.js";
import { renderedSelection, requiresImages } from "../../eval-authoring/src/rendered-selection.js";
import { captureView, frozenSequencePlan, subjectEval } from "./run-manifest.js";
import { operationSource } from "./sources.js";

/**
 * The revision whose criteria the judge reads. It is the revision of the batch. A batch can name
 * another revision than the evaluation of its build only when the Studio plan and the image
 * sequence of the observation are the same, because the saved evidence binds to one plan.
 */
async function judgmentRevision(
  root: string,
  manifest: RunOperationManifest,
  batch: Pick<RunJudgmentBatch, "captureCellId" | "revisionId">,
) {
  const capture = manifest.captureCells.find((cell) => cell.id === batch.captureCellId);
  if (!capture) throw new Error("Judgment has no frozen capture");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(batch.revisionId);
  if (revision.id !== subjectEval(manifest, capture.treatmentId).id) {
    const view = captureView(manifest, capture.id);
    if (
      hashJson({ studio: view.plan, sequence: view.sequence }) !==
      hashJson({
        studio: revision.privateEvaluator.studio,
        sequence: revision.privateEvaluator.sequence,
      })
    )
      throw new Error(
        "Studio observed this build with a different plan. Observe the build again with the plan of this evaluation.",
      );
  }
  return revision;
}

async function judgmentCriteria(
  root: string,
  manifest: RunOperationManifest,
  batch: Omit<RunJudgmentBatch, "configuration">,
) {
  const revision = await judgmentRevision(root, manifest, batch);
  const criteria = scoringCriteria(revision, batch.criterionIds);
  return { criteria, publicTask: revision.publicTask.prompt, rubricHash: revision.rubricHash };
}

/**
 * The rendered evidence of one request about the given criteria. Protocol controllers freeze
 * an explicit presentation treatment over the study view; ordinary evaluations use the
 * declared image channels of each criterion. A request with no criterion that selects rendered
 * evidence gets no images in either case. Every grading stream uses this one rule.
 */
export function renderedRequestSelection(
  manifest: RunOperationManifest,
  cellId: string,
  sourceHash: string,
  criteria: ExecutableCriterion[],
): { sequence: SequencePlan | null; captureIds: string[] } {
  const selections = criteria.map(renderedSelection);
  const protocolView = manifest.protocol !== null;
  const sequence = (
    protocolView
      ? criteria.some((criterion) => requiresImages(criterion))
      : selections.some((selection) => selection.sequence)
  )
    ? frozenSequencePlan(manifest, cellId, sourceHash)
    : null;
  const captureIds =
    protocolView && sequence
      ? []
      : [...new Set(selections.flatMap((selection) => selection.captureIds))];
  return { sequence, captureIds };
}

/** The reasons of the unavailable rendered channels that one criterion uses. */
export function renderedGaps(
  manifest: RunOperationManifest,
  criterion: ExecutableCriterion,
  unavailable: Array<{ channel: string; reason: string }>,
): string[] {
  const selection = renderedSelection(criterion);
  return unavailable
    .filter((item) =>
      item.channel === "sequence"
        ? manifest.protocol !== null
          ? requiresImages(criterion)
          : selection.sequence
        : selection.captureIds.includes(item.channel),
    )
    .map((item) => item.reason);
}

/** Called only after signed capture verification, at consumption and again at report sealing. */
export async function judgmentMaterial(
  root: string,
  manifest: RunOperationManifest,
  batch: Omit<RunJudgmentBatch, "configuration">,
  dryRunPacket = false,
) {
  const files = new RepositoryFiles(root);
  const authored = await judgmentCriteria(root, manifest, batch);
  const targetCapture = manifest.captureCells.find((cell) => cell.id === batch.captureCellId)!;
  const targetRevision = await judgmentRevision(root, manifest, batch);
  const executableCriteria = [
    ...targetRevision.privateEvaluator.deterministic,
    ...targetRevision.privateEvaluator.visual,
    ...targetRevision.privateEvaluator.codeQuality,
    ...targetRevision.privateEvaluator.unscaled,
  ];
  /**
   * `criteria` collects the source and runtime material of the capture's own build.
   * `selection` chooses the rendered channels: the batch criteria, or every criterion when the
   * capture belongs to another evaluation (unrelated images of registered research).
   */
  async function original(
    cellId: string,
    options: { criteria: boolean; selection: "batch" | "all" } = {
      criteria: true,
      selection: "batch",
    },
  ) {
    const cell = manifest.captureCells.find((cell) => cell.id === cellId);
    if (!cell) throw new Error("Judgment has no frozen capture");
    const source = await operationSource(root, manifest, cell.treatmentId);
    const base = `.basalt-evals/eval-operations/${manifest.id}/capture/${cell.id}/studio`;
    const evidence = await files.json<StudioEvidence>(`${base}/evidence.json`);
    const criterionEvidence = await Promise.all(
      (options.criteria ? batch.criterionIds : []).map((id) =>
        criterionMaterial({
          files,
          sourceRoot: source.relativeRoot,
          sourceFiles: source.candidate.files,
          evidence,
          plan: targetRevision.privateEvaluator.studio,
          criterion: executableCriteria.find((criterion) => criterion.id === id)!,
        }),
      ),
    );
    const selectedCriteria = executableCriteria.filter(
      (criterion) => options.selection === "all" || batch.criterionIds.includes(criterion.id),
    );
    const { sequence, captureIds } = renderedRequestSelection(
      manifest,
      cell.id,
      source.candidate.rootHash,
      selectedCriteria,
    );
    const rendered = await renderedEvidence({
      files,
      base,
      evidence,
      plan: targetRevision.privateEvaluator.studio,
      captureIds,
      sequence,
      presentation: batch.presentation,
      ...(dryRunPacket ? { dryRunCriterionIds: batch.criterionIds } : {}),
    });
    for (const material of criterionEvidence)
      material.unavailable.push(
        ...renderedGaps(
          manifest,
          executableCriteria.find((criterion) => criterion.id === material.criterionId)!,
          rendered.unavailable,
        ),
      );
    const { images } = rendered;
    const context = { ...rendered.context, publicSeed: targetRevision.seed.project };
    return {
      context,
      images,
      criterionEvidence,
      evidenceHash: hashJson(evidence),
      sourceHash: source.candidate.rootHash,
      packetManifest: rendered.packetManifest,
      evidence,
      base,
      sequence,
    };
  }
  const primary = await original(batch.captureCellId);
  let presented = primary;
  const evidenceHashes = [primary.evidenceHash];
  const substitution = batch.substitution;
  if (substitution) {
    const kind = substitution.kind;
    let donor: typeof primary | null = null;
    if ((DONOR_SUBSTITUTION_KINDS as readonly string[]).includes(kind)) {
      const donorCell = manifest.captureCells.find(
        (cell) => cell.id === substitution.donorCaptureCellId,
      );
      if (!donorCell) throw new Error("This control requires a frozen donor capture");
      if (
        kind !== "unrelated" &&
        (subjectEval(manifest, donorCell.treatmentId).id !==
          subjectEval(manifest, targetCapture.treatmentId).id ||
          donorCell.treatmentId === targetCapture.treatmentId ||
          donorCell.viewId !== targetCapture.viewId ||
          donorCell.partition !== targetCapture.partition)
      )
        throw new Error("A donor must be another build of the same evaluation and view");
      donor = await original(donorCell.id, {
        criteria: kind === "canary",
        selection: kind === "unrelated" ? "all" : "batch",
      });
    }
    const needsSequence =
      kind === "phase_shuffled" ||
      (substitution.region?.view.kind === "actor" && kind !== "region_black");
    const bound =
      needsSequence && primary.sequence
        ? await boundSequence(files, primary.base, primary.sequence)
        : null;
    presented = applyEvidenceControl(
      primary,
      substitution,
      {
        donor,
        phases: kind === "phase_shuffled" ? framePhases(primary.context.intervals, bound) : null,
        fill:
          substitution.region && kind !== "region_black"
            ? await regionFill(files, primary, substitution.region, bound)
            : null,
      },
      batch.id,
    );
    if (donor) evidenceHashes.push(donor.evidenceHash);
  }
  return {
    ...(dryRunPacket ? { packetManifest: presented.packetManifest } : {}),
    context: presented.context,
    images: presented.images,
    criterionEvidence: presented.criterionEvidence,
    candidateHash: primary.sourceHash,
    provenance: {
      origin: substitution ? ("synthetic" as const) : ("native" as const),
      substitution,
      evidenceHashes,
      frameHashes: presented.images.map((image) => image.hash),
      contextHash: hashJson(presented.context),
      criterionEvidenceHash: hashJson(presented.criterionEvidence),
    },
    ...authored,
  };
}

export async function boundSequence(files: RepositoryFiles, base: string, sequence: SequencePlan) {
  const receipt = await files.json<SignedWorkerManifest>(`${base}/native/manifest.json`);
  const bound = await readBoundSequence(files.path(base), receipt, sequence);
  const clock = bound.assessment.clock;
  if (bound.assessment.status !== "sufficient" || bound.acquisition.status !== "complete" || !clock)
    throw new Error(
      "The recorded sequence of this observation is not complete, so Basalt cannot apply this control.",
    );
  // Anchors use the Studio clock and frames use the host clock. Host time is Studio time plus
  // the offset. A transition with no measured anchor has no time.
  const anchors = bound.assessment.transitions
    .filter((transition) => transition.covered && transition.at !== "")
    .map((transition) => Date.parse(transition.at) + clock.offsetMs)
    .sort((a, b) => a - b);
  return { ...bound, anchors, uncertaintyMs: clock.uncertaintyMs };
}

/**
 * The phase of each rendered frame. A phase capture is its own phase. A sequence frame belongs
 * to its actor and to the segment between two measured anchors, on the host clock.
 */
export function framePhases(
  intervals: FrameInterval[],
  bound: { acquisition: { startedAt: string }; anchors: number[] } | null,
): string[] {
  return intervals.map((interval) => {
    if (interval.actor.startsWith("presentation:")) return interval.actor;
    if (!bound) throw new Error("Sequence frames need their recorded sequence");
    const at = Date.parse(bound.acquisition.startedAt) + interval.startMs;
    return `${interval.actor}#${bound.anchors.filter((anchor) => anchor <= at).length}`;
  });
}

/** The frame of the authored view before the action, bound to its signed hash. */
async function regionFill(
  files: RepositoryFiles,
  primary: { evidence: StudioEvidence; base: string },
  region: AuthoredRegion,
  bound: Awaited<ReturnType<typeof boundSequence>> | null,
): Promise<FillFrame> {
  let file: string, hash: string, mediaType: FillFrame["mediaType"];
  if (region.view.kind === "capture") {
    const capture = primary.evidence.phases
      .flatMap((phase) => phase.captures)
      .find((capture) => capture.captureId === region.fillCaptureId);
    if (!capture) throw new Error("The authored fill capture was not recorded");
    ({ file, hash, mediaType } = capture);
  } else {
    if (!bound) throw new Error("An actor region needs its recorded sequence");
    const actor = region.view.actor;
    const userId = bound.assessment.actorFrames.find((item) => item.actor === actor)?.userId;
    const first = bound.anchors[0];
    if (userId === undefined || first === undefined)
      throw new Error("The actor or its first measured anchor is absent from the sequence");
    // The frame must end before the anchor also at the far end of the clock uncertainty.
    const before = bound.acquisition.frames
      .filter(
        (frame) =>
          frame.playerUserId === userId && Date.parse(frame.endedAt) + bound.uncertaintyMs <= first,
      )
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      .at(-1);
    if (!before) throw new Error("No frame of the actor ends before the first measured anchor");
    ({ hash, mediaType } = before);
    file = `${bound.prefix}${before.file}`;
  }
  const bytes = await files.bytes(`${primary.base}/${file}`, MAX_CAPTURE_BYTES);
  if (contentHash(bytes) !== hash) throw new Error("The fill frame differs from signed evidence");
  return { mediaType, hash, dataBase64: bytes.toString("base64") };
}
