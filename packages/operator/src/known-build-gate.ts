import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import {
  knownBuildStatus,
  type KnownBuild,
  type KnownBuildGate,
  type KnownBuildGateRecord,
} from "../../contracts/src/known-builds.js";
import { finishedRecheckAnswers, recheckLaunches } from "./recheck-results.js";

/*
 * The read side of the known build gate. Preparation saves the gate of each new revision one
 * time. A read removes retired builds and adds the answers of finished judge launches. A quote of
 * a new benchmark reads the gate, so this module stays free of the run plan.
 */

const idPattern = /^[a-f0-9]{64}$/u;

export function knownBuildGateDirectory(revisionId: string): string {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  return `.basalt-evals/authoring/known-build-gates/${revisionId}`;
}

/** The saved gate of one revision, or null when preparation found no known build. */
async function readKnownBuildGateRecord(
  root: string,
  revisionId: string,
): Promise<KnownBuildGateRecord | null> {
  const record = await new RepositoryFiles(root).optional<KnownBuildGateRecord>(
    `${knownBuildGateDirectory(revisionId)}/record.json`,
  );
  if (
    record &&
    (record.schema !== "basalt-evals/known-build-gate" || record.revisionId !== revisionId)
  )
    throw new Error("The saved known build gate does not match its evaluation");
  return record;
}

/**
 * The current gate of one revision. Each result must hold to open the gate. A broken, incomplete
 * or unresolved result blocks it. The gate never changes an answer of a run.
 */
export async function knownBuildGate(root: string, revisionId: string): Promise<KnownBuildGate> {
  const record = await readKnownBuildGateRecord(root, revisionId);
  if (!record) return { revisionId, checked: false, results: [], state: "open" };
  const journal = await OperationJournal.open(root);
  try {
    const results: KnownBuildGate["results"] = [];
    for (const result of record.results) {
      if (journal.read("known_build_retirements", result.knownBuildId)) continue;
      if (result.status !== "needs_judge") {
        results.push(result);
        continue;
      }
      const known = journal.read<KnownBuild>("known_builds", result.knownBuildId);
      if (!known) throw new Error("A known build of the gate is missing");
      const answers = (
        await finishedRecheckAnswers(
          root,
          journal,
          recheckLaunches(journal, revisionId, known.build.operationId),
        )
      ).filter(
        (answer) =>
          answer.subjectId === known.build.subjectId &&
          (answer.part === "observation" || answer.captureId === known.build.captureId),
      );
      const checks = result.checks.map((check) => {
        const found = answers.filter((answer) => answer.criterionId === check.criterionId);
        return check.answer === null && found.length
          ? { ...check, answer: found.at(-1)!.answer }
          : check;
      });
      const status = knownBuildStatus(result.expectation, checks);
      results.push({
        ...result,
        checks,
        status,
        judgePart: status === "needs_judge" ? result.judgePart : null,
      });
    }
    return {
      revisionId,
      checked: true,
      results,
      state: results.every((result) => result.status === "holds") ? "open" : "blocked",
    };
  } finally {
    journal.close();
  }
}

/** Refuse a new benchmark of a revision while its known build gate is blocked. */
export async function assertKnownBuildGate(root: string, revisionId: string): Promise<void> {
  const gate = await knownBuildGate(root, revisionId);
  if (gate.state === "open") return;
  const count = (status: string) =>
    gate.results.filter((result) => result.status === status).length;
  const parts = [
    ["broken", "contradict the plan"],
    ["incomplete", "have an incomplete check"],
    ["needs_person", "need a person"],
    ["needs_judge", "wait for a judge check"],
  ]
    .filter(([status]) => count(status!) > 0)
    .map(([status, words]) => `${count(status!)} ${words}`);
  throw new Error(
    `Known builds block a new benchmark of this evaluation version: ${parts.join(", ")}. Open the evaluation to resolve them. An incomplete check blocks, but it is not a failure.`,
  );
}
