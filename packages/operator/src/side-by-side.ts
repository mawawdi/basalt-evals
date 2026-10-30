import type { OperatorEvidence, SideBySideEvidence } from "../../contracts/src/console.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { recordingTimeline, recordingTracks } from "../../contracts/src/evidence-display.js";
import {
  alignFrames,
  framePhase,
  type AlignableFrames,
} from "../../studio-runner/src/paired-evidence.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, type StudioEvidence } from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";
import type { SignedWorkerManifest } from "../../studio-runner/src/native-worker.js";
import { presentSequenceFrames } from "../../studio-runner/src/presentation.js";
import { authoredCriteria } from "./benchmarks.js";
import { reviewGateSatisfied, sequenceImageId } from "./evidence.js";
import type { RunJudgmentArtifact } from "./judgment-artifact.js";
import { renderedRequestSelection } from "./judgment-material.js";
import { operationSource } from "./sources.js";
import { operatorEvidence } from "./evidence-view.js";
import { buildMaker, buildName } from "./model-registry.js";
import { frozenRunStatus } from "./run-builder.js";
import { checkCapture, pairingToleranceMs, subjectEval } from "./run-manifest.js";

type Candidate = OperatorEvidence["candidates"][number];
type Pass = Candidate["items"][number]["passes"][number];

/**
 * The images of one observation, in the facts that pairing reads. A recorded frame keeps its
 * player and its time from the first frame of the recording. A snapshot keeps its phase.
 */
function alignable(pass: Pass, roles: ReadonlyMap<string, string[]>): AlignableFrames {
  const sequence = recordingTracks(pass.images, pass.observations).flatMap((actor) =>
    recordingTimeline(pass.images, pass.observations, actor),
  );
  // The timeline counts from the first frame of any player. Transitions use the same origin.
  const origin = sequence[0] ? sequence[0].start - sequence[0].elapsedMs : 0;
  return {
    frames: pass.images.map((image, index) => {
      const frame = sequence.find((item) => item.index === index);
      return frame
        ? {
            player: image.actor,
            clock: {
              kind: "scenario" as const,
              startMs: frame.elapsedMs,
              endMs: frame.elapsedMs + frame.end - frame.start,
            },
            roles: roles.get(image.id) ?? [],
          }
        : {
            player: null,
            clock: { kind: "presentation" as const, captureId: image.context },
            roles: [],
          };
    }),
    transitions: sequence.length
      ? (pass.transitions ?? []).map((transition) => ({
          transitionId: transition.id,
          anchorMs: Date.parse(transition.at) - origin,
        }))
      : [],
  };
}

/**
 * The roles that the judge saw for each recorded frame of one judge check, by evidence image ID.
 * The first sample of the sample group gives the selection, and all its samples send the same
 * images. The selection runs again from the bound sequence, as the judge request ran it, with no
 * model call, so no request changes. A frame that the judge did not see has no entry. A check
 * without a saved judgment, a control that changes the images, a selection that differs from the
 * saved judgment, or evidence that Basalt cannot read again gives no roles. Each frame then goes
 * with the nearest event.
 */
export async function judgedFrameRoles(
  root: string,
  manifest: RunOperationManifest,
  checkId: string,
  criterionId: string,
): Promise<Map<string, string[]>> {
  const batch = manifest.judgmentBatches
    .filter((item) => `${item.sampleGroupId}:${criterionId}` === checkId)
    .sort((a, b) => a.sample - b.sample)[0];
  const capture = manifest.captureCells.find((cell) => cell.id === batch?.captureCellId);
  if (!batch || !capture || batch.substitution) return new Map();
  try {
    const files = new RepositoryFiles(root);
    const source = await operationSource(root, manifest, capture.treatmentId);
    const revision = await new EvalDefinitionStore(root).readExecutableRevision(batch.revisionId);
    const { sequence, captureIds } = renderedRequestSelection(
      manifest,
      capture.id,
      source.candidate.rootHash,
      authoredCriteria(revision).filter((criterion) => batch.criterionIds.includes(criterion.id)),
    );
    if (!sequence) return new Map();
    const base = `.basalt-evals/eval-operations/${manifest.id}/capture/${capture.id}/studio`;
    const evidenceHash = hashJson(await files.json<StudioEvidence>(`${base}/evidence.json`));
    const bound = await readBoundSequence(
      files.path(base),
      await files.json<SignedWorkerManifest>(`${base}/native/manifest.json`),
      sequence,
    );
    const presented = presentSequenceFrames({
      ...bound,
      treatment: batch.presentation,
      phaseCaptureCount: new Set(captureIds).size,
    });
    if (presented.status === "insufficient") return new Map();
    // The saved judgment names the images that the judge saw, in request order, with the
    // sequence frames first. Roles show only when the selection here gives the same frames.
    const judged = await files.json<RunJudgmentArtifact>(
      `.basalt-evals/eval-operations/${manifest.id}/judgments/${batch.id}.json`,
    );
    const hashes = presented.frames.map((frame) => frame.hash);
    if (hashJson(judged.provenance.frameHashes.slice(0, hashes.length)) !== hashJson(hashes))
      return new Map();
    return new Map(
      presented.frames.map((frame) => [sequenceImageId(evidenceHash, frame), frame.roles]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The rows of two observations: each pair of images at the same player, recorded phase and
 * time, then each image with no image of the other build. Snapshots come first, by phase. Then
 * each player's recording runs in time order. An absent observation has no images.
 */
export function sideBySideRows(
  evidence: Array<Pass | undefined>,
  toleranceMs: number,
  /** The roles that the judge saw, by image ID, for each side. A frame without roles has none. */
  roles: Array<ReadonlyMap<string, string[]>> = [],
): SideBySideEvidence["rows"] {
  const frames = evidence.map((pass, side) =>
    pass ? alignable(pass, roles[side] ?? new Map()) : { frames: [], transitions: [] },
  );
  const alignment = alignFrames(frames[0]!, frames[1]!, toleranceMs);
  const image = (side: number, index: number, offsetMs: number) => ({
    imageId: evidence[side]!.images[index]!.id,
    offsetMs,
    roles: frames[side]!.frames[index]!.roles,
  });
  const alone = (side: number, index: number) => {
    const { player, phase, offsetMs } = framePhase(
      frames[side]!.frames[index]!,
      frames[side]!.transitions,
    );
    const sides: SideBySideEvidence["rows"][number]["sides"] = [null, null];
    sides[side] = image(side, index, offsetMs);
    return { player, phase, sides, at: frames[side]!.frames[index]!.clock };
  };
  const rows = [
    ...alignment.pairs.map((pair) => ({
      player: pair.player,
      phase: pair.phase,
      sides: [
        image(0, pair.candidate, pair.offsetsMs.candidate),
        image(1, pair.exemplar, pair.offsetsMs.exemplar),
      ],
      at: frames[0]!.frames[pair.candidate]!.clock,
    })),
    ...alignment.candidateOnly.map((index) => alone(0, index)),
    ...alignment.exemplarOnly.map((index) => alone(1, index)),
  ];
  const time = (clock: (typeof rows)[number]["at"]) =>
    clock.kind === "scenario" ? clock.startMs : -1;
  rows.sort(
    (a, b) =>
      Number(a.at.kind === "scenario") - Number(b.at.kind === "scenario") ||
      (a.player ?? "").localeCompare(b.player ?? "", "en", { numeric: true }) ||
      time(a.at) - time(b.at) ||
      JSON.stringify(a.phase).localeCompare(JSON.stringify(b.phase)),
  );
  return rows.map(({ player, phase, sides }) => {
    const side = sides.findIndex((item) => item !== null);
    const label = evidence[side]!.images.find((item) => item.id === sides[side]!.imageId)!.label;
    return { player, label, phase, sides };
  });
}

/**
 * Two builds of one evaluation, one criterion and one observation, side by side. Each side
 * reads the released evidence of the operator view, so a withheld observation stays hidden and
 * records no holdout look. Rows pair images by player, recorded phase and time.
 */
export async function sideBySideEvidence(
  root: string,
  operationId: string,
  query: URLSearchParams,
): Promise<SideBySideEvidence> {
  const subjects = [query.get("left") ?? "", query.get("right") ?? ""];
  const criterionId = query.get("criterion") ?? "";
  const pass = Number(query.get("pass"));
  if (subjects.some((id) => !id) || subjects[0] === subjects[1])
    throw new Error("Choose two different builds.");
  if (!criterionId) throw new Error("Choose a criterion.");
  if (!Number.isSafeInteger(pass) || pass < 1) throw new Error("Choose an observation.");
  const status = await frozenRunStatus(root, operationId, false);
  const views = await Promise.all(
    subjects.map((subjectId) =>
      operatorEvidence(root, operationId, undefined, { subjectId, criterionId }),
    ),
  );
  const candidates = views.map((view, index) => {
    const candidate = view.candidates.find((item) => item.id === subjects[index]);
    if (!candidate) throw new Error("Choose two builds of this run.");
    return candidate;
  });
  // The release rule of the evidence view: an item opens when every gate of its captures is done.
  const held = (capture: RunOperationManifest["captureCells"][number]) =>
    !reviewGateSatisfied(
      {
        releaseGateIds: status.manifest.captureCells
          .filter(
            (cell) =>
              cell.treatmentId === capture.treatmentId &&
              cell.viewId === capture.viewId &&
              cell.partition === capture.partition,
          )
          .flatMap((cell) => cell.requires),
      },
      status.manifest.gates,
      status.completedUnits,
    );
  if (candidates[0]!.evaluationId !== candidates[1]!.evaluationId)
    throw new Error("Choose two builds of one evaluation.");
  const cells = candidates.map(
    (candidate) => candidate.cells.find((cell) => cell.pass === pass) ?? null,
  );
  const named = cells.find((cell) => cell !== null);
  if (!named) throw new Error("Neither build has an answer for this criterion and observation.");
  const sides = candidates.map((candidate, index) => {
    const cell = cells[index]!;
    const capture = cell ? checkCapture(status.manifest, cell.id, criterionId) : null;
    const evidence = cell?.passId
      ? candidate.items
          .find((item) => item.id === cell.itemId)
          ?.passes.find((item) => item.id === cell.passId)
      : undefined;
    return {
      side: {
        candidateId: candidate.id,
        cell,
        itemId: evidence ? cell!.itemId : null,
        passId: evidence ? cell!.passId : null,
        absent: evidence
          ? null
          : candidate.notReached
            ? "This build never started."
            : !cell
              ? "This build has no answer for this criterion in this observation."
              : capture && held(capture)
                ? "This observation stays hidden until its review is complete."
                : capture &&
                    views[index]!.unavailableEvidence.some((item) => item.captureId === capture.id)
                  ? "Basalt couldn’t verify the evidence of this observation, so it stays hidden."
                  : "This observation has no recorded evidence.",
      },
      evidence,
      capture,
    };
  });
  const capture = sides.find((side) => side.capture)?.capture;
  const toleranceMs = capture ? pairingToleranceMs(status.manifest, capture.id) : 0;
  const rows = sideBySideRows(
    sides.map((side) => side.evidence),
    toleranceMs,
    await Promise.all(
      sides.map((side) =>
        side.evidence && side.side.cell?.method === "visual"
          ? judgedFrameRoles(root, status.manifest, side.side.cell.id, criterionId)
          : new Map<string, string[]>(),
      ),
    ),
  );
  return {
    criterion: { id: criterionId, statement: named.statement, method: named.method },
    pass,
    toleranceMs,
    observations: [
      ...new Set(candidates.flatMap((candidate) => candidate.cells.map((cell) => cell.pass))),
    ].sort((a, b) => a - b),
    builds: status.manifest.subjects.flatMap((subject) =>
      subjectEval(status.manifest, subject.id).id === candidates[0]!.evaluationId
        ? [
            {
              candidateId: subject.id,
              title: buildName(status.manifest, subject.id),
              model: buildMaker(status.manifest.modelSnapshots, subject),
            },
          ]
        : [],
    ),
    sides: sides.map((side) => side.side),
    rows,
  };
}
