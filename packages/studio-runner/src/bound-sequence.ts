import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { confirmFileContents } from "../../artifact-store/src/regular-file.js";
import { hashJson, isSafeRelativePath, MAX_SEQUENCE_FRAMES } from "../../contracts/src/index.js";
import type { SignedWorkerManifest } from "./native-worker.js";
import {
  assertSequenceBytes,
  assertSequencePlan,
  isClockAlignment,
  type SequencePlan,
  type SequenceAssessment,
} from "./sequence.js";
import type { SequenceAcquisition } from "./studio-mcp.js";

/** The caller verifies the worker signature and artifact inventory before consumption. */
export async function readBoundSequence(
  directory: string,
  receipt: SignedWorkerManifest,
  expected: SequencePlan,
) {
  assertSequencePlan(expected);
  const files = new RepositoryFiles(directory);
  const signed = new Set(receipt.manifest.artifacts.map((artifact) => artifact.file));
  if (
    !signed.has("sequence.json") ||
    hashJson(await files.json("sequence.json")) !== hashJson(expected)
  )
    throw new Error("Signed sequence differs from the frozen source, view, or acquisition plan");
  const matches = [...signed].filter((file) =>
    new RegExp(
      `^native/sequence/${expected.scenarioId}-attempt-[0-9]{2}/assessment\\.json$`,
      "u",
    ).test(file),
  );
  if (matches.length !== 1) throw new Error("Sequence assessment is missing or ambiguous");
  const assessmentFile = matches[0]!;
  const prefix = assessmentFile.slice(0, -"assessment.json".length);
  if (!signed.has(`${prefix}index.json`))
    throw new Error("Sequence acquisition index is not signed");
  const assessment = await files.json<SequenceAssessment>(assessmentFile);
  const acquisition = await files.json<SequenceAcquisition>(`${prefix}index.json`);
  if (
    assessment.schema !== "basalt-evals/sequence-assessment" ||
    assessment.planHash !== hashJson(expected) ||
    !["sufficient", "insufficient"].includes(assessment.status) ||
    !Array.isArray(assessment.reasons) ||
    // Only an insufficient assessment can lack a clock alignment.
    (assessment.clock === null
      ? assessment.status !== "insufficient"
      : !isClockAlignment(assessment.clock)) ||
    !Array.isArray(assessment.transitions) ||
    assessment.transitions.length !== expected.requiredTransitions.length ||
    assessment.transitions.some(
      (transition, index) => transition?.transitionId !== expected.requiredTransitions[index]!.id,
    ) ||
    acquisition.schema !== "basalt-evals/sequence-acquisition" ||
    !["complete", "incomplete"].includes(acquisition.status) ||
    !Array.isArray(acquisition.frames) ||
    acquisition.frames.length > MAX_SEQUENCE_FRAMES
  )
    throw new Error("Invalid bound sequence acquisition or assessment");
  const seen = new Set<string>();
  for (const frame of acquisition.frames) {
    if (
      !isSafeRelativePath(frame.file) ||
      seen.has(frame.file) ||
      !signed.has(`${prefix}${frame.file}`)
    )
      throw new Error("Sequence frame is duplicated, unsafe, or absent from the signed receipt");
    seen.add(frame.file);
  }
  await confirmFileContents(
    acquisition.frames.map((frame) => ({
      file: files.path(`${prefix}${frame.file}`),
      hash: frame.hash,
      bytes: frame.bytes,
      check: async () => assertSequenceBytes(frame, await files.bytes(`${prefix}${frame.file}`)),
    })),
  );
  // Insufficient acquisition is retained. Independent nonvisual criteria may still be judged.
  return { plan: expected, acquisition, assessment, prefix };
}
