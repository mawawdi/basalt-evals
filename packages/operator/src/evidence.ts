import type { EvidenceItem, EvidenceView, OperationEvidence } from "../../contracts/src/review.js";
import { subjectEval, frozenSequencePlan, manifestHash } from "./run-manifest.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import type { SignedWorkerManifest } from "../../studio-runner/src/native-worker.js";
import type { SequenceAssessment } from "../../studio-runner/src/sequence.js";
import { operationSource } from "./sources.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  sceneTextNeedsReview,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { frozenRunStatus, frozenRunStageStatus } from "./run-builder.js";
export class EvidenceUnavailable extends Error {}

/** The plan label of a phase or a scenario that the evidence names. */
function planLabel(entries: Array<{ id: string; label: string }>, id: string) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error(`The evidence names ${id}, which is not in its plan`);
  return entry.label;
}

/** The evidence image ID of a recorded sequence frame: its evidence, file and hash. */
export function sequenceImageId(evidenceHash: string, frame: { file: string; hash: string }) {
  return hashJson({ evidence: evidenceHash, file: frame.file, hash: frame.hash });
}

/**
 * The measured transitions and state changes of a recorded sequence, on the clock of its frames.
 * They use the Studio clock, and frames use the host clock. Host time is Studio time plus the
 * offset of the clock alignment. Without an alignment, no event has a place on the recording.
 * The ISO times round the host time down to whole ms, so they are for display only. The judge
 * paths in rendered-evidence.ts and judgment-material.ts keep the fraction of the offset.
 */
export function sequenceEvents(
  assessment: Pick<SequenceAssessment, "clock" | "transitions" | "stateChanges">,
): Pick<EvidenceView["passes"][number], "events" | "transitions"> {
  const { clock } = assessment;
  const onFrames = <T extends { at: string }>(events: T[]) =>
    clock
      ? events.flatMap((event) =>
          Number.isFinite(Date.parse(event.at))
            ? [{ event, at: new Date(Date.parse(event.at) + clock.offsetMs).toISOString() }]
            : [],
        )
      : [];
  const transitions = onFrames(assessment.transitions).map(({ event, at }) => ({
    id: event.transitionId,
    at,
  }));
  return {
    events: [
      ...transitions,
      ...onFrames(assessment.stateChanges).map(({ event, at }) => ({
        id: `${event.context} · ${event.attribute}=${String(event.value)}`,
        at,
      })),
    ],
    transitions,
  };
}

/** Read-only verified evidence. Inspection never allocates review work or releases. */
export async function readOperationEvidence(
  root: string,
  operationId: string,
  selection?: { subjectId: string },
  /** Facts for the operator view of a pass. The evidence item and its hash leave them out. */
  projectPass?: (
    passId: string,
    facts: Pick<
      EvidenceView["passes"][number],
      "events" | "transitions" | "scenarioPlan" | "clock" | "frameBudget"
    >,
  ) => void,
): Promise<OperationEvidence> {
  let status = await frozenRunStatus(root, operationId, false);
  // Validate the shared dependency graph once. If one retained artifact is
  // corrupt, isolate individual captures below so unaffected evidence survives.
  let verifiedSnapshot = false;
  try {
    if (selection) throw new Error("Use the selected dependency closure");
    status = await frozenRunStatus(root, operationId);
    verifiedSnapshot = true;
  } catch {
    // Individual consumed closures still fail closed below.
  }
  const files = new RepositoryFiles(root);
  const items: EvidenceItem[] = [];
  const unavailable: OperationEvidence["unavailable"] = [];
  if (selection && !status.manifest.subjects.some((subject) => subject.id === selection.subjectId))
    throw new Error("Unknown selected candidate");
  for (const subject of status.manifest.subjects.filter(
    (subject) => !selection || subject.id === selection.subjectId,
  )) {
    const evaluation = subjectEval(status.manifest, subject.id);
    const revision = await new EvalDefinitionStore(root).readRevision(evaluation.id);
    const criteria = [
      ...revision.privateEvaluator.deterministic,
      ...revision.privateEvaluator.codeQuality,
      ...revision.privateEvaluator.visual,
      ...revision.privateEvaluator.unscaled,
    ].map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      required: criterion.required,
      scoreRange: "scoreRange" in criterion ? criterion.scoreRange : null,
      anchors: "anchors" in criterion ? criterion.anchors : null,
      minimumPassingScore:
        "minimumPassingScore" in criterion ? criterion.minimumPassingScore : null,
    }));
    const captured = status.manifest.captureCells.filter(
      (cell) =>
        cell.treatmentId === subject.id &&
        status.completedUnits.includes(`final_capture:${cell.id}`),
    );
    const source = await operationSource(root, status.manifest, subject.id).catch(() => null);
    if (!source) {
      unavailable.push(
        ...captured.map((cell) => ({
          captureId: cell.id,
          reason: "integrity_unavailable" as const,
        })),
      );
      continue;
    }
    const sources = source.candidate.files
      .filter((file) => /\.luau?$/u.test(file.path))
      .map((file) => ({
        id: hashJson({ candidate: source.candidate.rootHash, path: file.path }),
        path: file.path,
        hash: file.hash,
        file: `${source.relativeRoot}/${file.path}`,
      }));
    for (const view of evaluation.views) {
      const planned = status.manifest.captureCells.filter(
        (cell) =>
          cell.treatmentId === subject.id &&
          cell.viewId === view.id &&
          cell.partition === view.partition,
      );
      const passes: EvidenceItem["passes"] = [];
      for (const cell of captured.filter(
        (cell) => cell.viewId === view.id && cell.partition === view.partition,
      )) {
        try {
          if (!verifiedSnapshot)
            await frozenRunStageStatus(root, operationId, "final_capture", cell.id);
          const base = `.basalt-evals/eval-operations/${operationId}/capture/${cell.id}/studio`;
          const evidence = await files.json<StudioEvidence>(`${base}/evidence.json`);
          // One digest per capture: a recorded sequence names hundreds of frames by it.
          const evidenceHash = hashJson(evidence);
          const sequence = frozenSequencePlan(status.manifest, cell.id, source.candidate.rootHash);
          const bound = sequence
            ? await readBoundSequence(
                files.path(base),
                await files.json<SignedWorkerManifest>(`${base}/native/manifest.json`),
                sequence,
              )
            : null;
          projectPass?.(hashJson({ cell: cell.id, evidence: evidenceHash }), {
            scenarioPlan: view.plan.scenarios.map((scenario) => ({
              id: scenario.id,
              label: scenario.label,
              steps: scenario.steps.map((step) => ({
                id: step.id,
                horizonMs: step.horizonMs,
                requirement: step.requirement,
              })),
            })),
            ...(sequence ? { frameBudget: sequence.frameBudget } : {}),
            ...(bound
              ? { clock: bound.assessment.clock, ...sequenceEvents(bound.assessment) }
              : {}),
          });
          passes.push({
            id: hashJson({ cell: cell.id, evidence: evidenceHash }),
            number: cell.pass,
            evidenceHash,
            reviewRoute: sceneTextNeedsReview(
              evidence.phases.flatMap((phase) => phase.captures.map((item) => item.sceneText)),
            )
              ? "scene_text"
              : null,
            observations: {
              phases: evidence.phases.map((phase) => ({
                id: phase.phaseId,
                observations: phase.observations,
                sceneText: phase.captures.map((item) => ({
                  captureId: item.captureId,
                  ...item.sceneText,
                })),
              })),
              scenarios: evidence.scenarios,
              sequence: bound
                ? {
                    status: bound.assessment.status,
                    reasons: bound.assessment.reasons,
                    frames: bound.acquisition.frames.map((frame) => ({
                      startedAt: frame.startedAt,
                      endedAt: frame.endedAt,
                    })),
                  }
                : null,
            },
            images: [
              ...evidence.phases.flatMap((phase) =>
                phase.captures.map((capture) => ({
                  id: hashJson({ evidence: evidenceHash, capture: capture.hash }),
                  file: `${base}/${capture.file}`,
                  hash: capture.hash,
                  mediaType: capture.mediaType,
                  context: phase.phaseId,
                  label: planLabel(view.plan.phases, phase.phaseId),
                  actor: null,
                  startedAt: evidence.startedAt,
                  endedAt: evidence.endedAt,
                })),
              ),
              ...(bound
                ? bound.acquisition.frames.map((frame) => ({
                    id: sequenceImageId(evidenceHash, frame),
                    file: `${base}/${bound.prefix}${frame.file}`,
                    hash: frame.hash,
                    mediaType: frame.mediaType,
                    context: sequence!.scenarioId,
                    label: planLabel(view.plan.scenarios, sequence!.scenarioId),
                    // Each test player records its own view. The viewer keeps one track for each.
                    actor:
                      bound.assessment.actorFrames.find(
                        (actor) => actor.userId === frame.playerUserId,
                      )?.actor ?? null,
                    startedAt: frame.startedAt,
                    endedAt: frame.endedAt,
                  }))
                : []),
            ],
          });
        } catch {
          unavailable.push({ captureId: cell.id, reason: "integrity_unavailable" });
        }
      }
      if (!passes.length && captured.length) continue;
      const body = {
        subjectId: subject.id,
        viewId: view.id,
        partition: view.partition,
        releaseGateIds: [...new Set(planned.flatMap((cell) => cell.requires))].sort(),
        plannedPasses: planned.length,
        rubricHash: revision.rubricHash,
        rubric: revision.authored.rubric,
        sources,
        criteria,
        passes: passes.sort((left, right) => left.number - right.number),
      };
      items.push({ ...body, id: hashJson(body) });
    }
  }
  return { operationId, manifestHash: manifestHash(status.manifest), items, unavailable };
}

export function reviewGateSatisfied(
  item: Pick<EvidenceItem, "releaseGateIds">,
  gates: Array<{ id: string; kind: "review" | "selection" }>,
  completedUnits: string[],
): boolean {
  return item.releaseGateIds.every((id) => {
    const gate = gates.find((gate) => gate.id === id);
    return gate !== undefined && completedUnits.includes(`${gate.kind}:${id}`);
  });
}

/** Every evidence route applies the same release rule; knowing a saved URL grants no access. */
export async function releasedEvidenceItems(
  root: string,
  evidence: OperationEvidence,
  itemId?: string,
): Promise<EvidenceItem[]> {
  const status = await frozenRunStatus(root, evidence.operationId, false);
  if (manifestHash(status.manifest) !== evidence.manifestHash)
    throw new Error("Evidence belongs to another frozen operation");
  const items = evidence.items.filter(
    (item) =>
      (!itemId || item.id === itemId) &&
      reviewGateSatisfied(item, status.manifest.gates, status.completedUnits),
  );
  // Whole-population inspection shares one verified graph. A focused asset or
  // question still verifies only its consumed closure. Failed bulk verification
  // never grants release: each selected capture must then pass independently.
  const verifiedSnapshot =
    !itemId && items.length > 1
      ? await frozenRunStatus(root, evidence.operationId).catch(() => null)
      : null;
  const files = new RepositoryFiles(root);
  for (const gateId of new Set(items.flatMap((item) => item.releaseGateIds))) {
    const event = status.events.find(
      (event) =>
        event.kind === "completed" &&
        event.unitId === gateId &&
        ["selection", "review"].includes(event.stage ?? ""),
    );
    if (
      !event ||
      hashJson(
        await files.json(
          `.basalt-evals/eval-operations/${evidence.operationId}/gates/${gateId}.json`,
        ),
      ) !== event.artifactHashes[0]
    )
      throw new Error("Review gate receipt changed");
  }
  for (const item of items)
    for (const pass of item.passes) {
      const cell = status.manifest.captureCells.find(
        (cell) =>
          cell.treatmentId === item.subjectId &&
          cell.viewId === item.viewId &&
          cell.partition === item.partition &&
          cell.pass === pass.number,
      );
      if (!cell || pass.id !== hashJson({ cell: cell.id, evidence: pass.evidenceHash }))
        throw new Error("Evidence pass differs from its frozen capture");
      const verified =
        verifiedSnapshot ??
        (await frozenRunStageStatus(root, evidence.operationId, "final_capture", cell.id).catch(
          () => {
            throw new EvidenceUnavailable(
              "Basalt cannot verify the evidence for this question. Choose Cannot tell, or select End session.",
            );
          },
        ));
      const event = verified.events.find(
        (event) =>
          event.kind === "completed" && event.stage === "final_capture" && event.unitId === cell.id,
      );
      if (event?.artifactHashes[1] !== pass.evidenceHash)
        throw new Error("Evidence differs from its signed capture receipt");
    }
  return items;
}

export function evidenceView(item: EvidenceItem): EvidenceView {
  return {
    id: item.id,
    plannedPasses: item.plannedPasses,
    sources: item.sources.map(({ id, path }) => ({ id, path })),
    passes: item.passes.map((pass) => ({
      id: pass.id,
      number: pass.number,
      observations: pass.observations,
      images: pass.images.map(({ file: _file, hash: _hash, ...image }) => image),
    })),
  };
}

export async function evidenceSource(
  root: string,
  evidence: OperationEvidence,
  itemId: string,
  sourceId: string,
) {
  const source = (await releasedEvidenceItems(root, evidence, itemId))
    .find((item) => item.id === itemId)
    ?.sources.find((source) => source.id === sourceId);
  if (!source) throw new Error("Unknown bound evidence source");
  const bytes = await new RepositoryFiles(root).bytes(source.file, 512 * 1024);
  if (contentHash(bytes) !== source.hash) throw new Error("Evidence source changed");
  return { path: source.path, text: bytes.toString("utf8") };
}
export async function evidenceImage(
  root: string,
  evidence: OperationEvidence,
  itemId: string,
  passId: string,
  imageId: string,
) {
  const selected = {
    ...evidence,
    items: evidence.items
      .filter((item) => item.id === itemId)
      .map((item) => ({ ...item, passes: item.passes.filter((pass) => pass.id === passId) })),
  };
  const image = (await releasedEvidenceItems(root, selected, itemId))
    .find((item) => item.id === itemId)
    ?.passes.find((pass) => pass.id === passId)
    ?.images.find((image) => image.id === imageId);
  if (!image) throw new Error("Unknown bound evidence image");
  const bytes = await new RepositoryFiles(root).bytes(image.file);
  if (contentHash(bytes) !== image.hash) throw new Error("Evidence image changed");
  return { bytes, mediaType: image.mediaType };
}
