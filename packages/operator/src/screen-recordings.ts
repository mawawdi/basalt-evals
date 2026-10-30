import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { contentHash } from "../../contracts/src/index.js";
import { SCREEN_RECORDING_LIMITS } from "../../studio-runner/src/screen-recording.js";
import { buildMaker } from "./model-registry.js";
import { frozenRunStatus } from "./run-builder.js";

/** One screen recording of an observation. The console lists it on Details. */
export interface ScreenRecordingEntry {
  unit: string;
  build: number;
  builderName: string;
  observation: number;
  /** The lane of the job. The console shows Studio slot `lane + 1`. */
  lane: number;
  bytes: number;
}

interface ScreenRecordingRecord {
  schema: "basalt-evals/screen-recording";
  lane: number;
  worker: string;
  hash: string;
  bytes: number;
}

const cellPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;
const diagnostics = (operationId: string, unit: string) =>
  `.basalt-evals/eval-operations/${operationId}/capture/${unit}/diagnostics`;

/**
 * The screen recordings of the observations of a run. A recording is a diagnostic beside the
 * signed evidence. No review, judge or export path reads it.
 */
export async function listScreenRecordings(
  root: string,
  operationId: string,
): Promise<ScreenRecordingEntry[]> {
  // A run that has not frozen its manifest yet has no observations.
  const status = await frozenRunStatus(root, operationId, false).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!status) return [];
  const { manifest } = status;
  const files = new RepositoryFiles(root);
  const entries: ScreenRecordingEntry[] = [];
  for (const cell of manifest.captureCells) {
    const record = await files.optional<ScreenRecordingRecord>(
      `${diagnostics(manifest.id, cell.id)}/screen.json`,
    );
    if (!record) continue;
    const index = manifest.subjects.findIndex((subject) => subject.id === cell.treatmentId);
    const subject = manifest.subjects[index];
    entries.push({
      unit: cell.id,
      build: index + 1,
      builderName: subject ? buildMaker(manifest.modelSnapshots, subject) : "Build",
      observation: cell.pass,
      lane: record.lane,
      bytes: record.bytes,
    });
  }
  return entries;
}

/** The bytes of one screen recording, checked against the hash that Basalt recorded at import. */
export async function readScreenRecording(
  root: string,
  operationId: string,
  unit: string,
): Promise<Buffer> {
  if (!cellPattern.test(unit)) throw new Error("Select an observation of this run");
  const { manifest } = await frozenRunStatus(root, operationId, false);
  if (!manifest.captureCells.some((cell) => cell.id === unit))
    throw new Error("This run has no such observation");
  const files = new RepositoryFiles(root);
  const record = await files.optional<ScreenRecordingRecord>(
    `${diagnostics(manifest.id, unit)}/screen.json`,
  );
  if (!record) throw new Error("This observation has no screen recording");
  const bytes = await files.bytes(
    `${diagnostics(manifest.id, unit)}/screen.mp4`,
    SCREEN_RECORDING_LIMITS.maxBytes,
  );
  if (bytes.length !== record.bytes || contentHash(bytes) !== record.hash)
    throw new Error("The screen recording changed after Basalt imported it");
  return bytes;
}
