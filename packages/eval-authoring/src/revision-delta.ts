import { hashJson } from "../../contracts/src/index.js";
import { publicEvalRevisionView, type EvalRevision } from "./compiler.js";
import { qualitativeCriteria, scoringCriteria } from "./scoring.js";

/** A code check runs fixed rules on saved evidence. A judge check needs a model request. */
type CheckMethod = "code" | "judge";

interface CriterionHash {
  method: CheckMethod;
  hash: string;
}

/** The content hashes that decide which saved answers stay valid in another revision. */
export interface RevisionHashes {
  /** The task, the development recipe and the seed that the builder saw. */
  publicContentHash: string;
  /** The private Studio plan and its image sequence. */
  studioPlanHash: string;
  rubricHash: string;
  /** One hash for each executable criterion, by its ID. */
  criteria: Record<string, CriterionHash>;
}

export type CellAction =
  "reuse" | "code_recheck" | "judge_recheck" | "new_observation" | "new_build" | "drop";

export type CellReason =
  | "unchanged"
  | "criterion_changed"
  | "criterion_added"
  | "criterion_removed"
  | "judge_changed"
  | "studio_plan_changed"
  | "public_content_changed";

interface CellDecision {
  action: CellAction;
  reason: CellReason;
}

/** The hashes of one build and one executable criterion on one side of a change. */
interface CellHashes {
  publicContentHash: string;
  studioPlanHash: string;
  /** Null when the criterion does not exist on this side. */
  criterion: CriterionHash | null;
}

export function revisionHashes(revision: EvalRevision): RevisionHashes {
  const evaluator = revision.privateEvaluator;
  const judged = qualitativeCriteria(revision);
  const scoring = scoringCriteria(
    revision,
    judged.map((criterion) => criterion.id),
  );
  return {
    publicContentHash: publicEvalRevisionView(revision).publicContentHash,
    studioPlanHash: hashJson({ studio: evaluator.studio, sequence: evaluator.sequence }),
    rubricHash: revision.rubricHash,
    criteria: Object.fromEntries([
      ...evaluator.deterministic.map(
        (criterion) => [criterion.id, { method: "code", hash: hashJson(criterion) }] as const,
      ),
      // The scoring criterion holds the text that the judge reads. The executable criterion
      // holds the evidence that the judge gets.
      ...judged.map(
        (criterion, index) =>
          [
            criterion.id,
            { method: "judge", hash: hashJson({ scoring: scoring[index], criterion }) },
          ] as const,
      ),
    ]),
  };
}

/** The hashes of one executable criterion, or of an absent criterion when the ID is null. */
export function cellHashes(hashes: RevisionHashes, criterionId: string | null): CellHashes {
  return {
    publicContentHash: hashes.publicContentHash,
    studioPlanHash: hashes.studioPlanHash,
    criterion: criterionId === null ? null : (hashes.criteria[criterionId] ?? null),
  };
}

/**
 * The work that one saved build needs for one criterion of the target revision. A removed
 * criterion has no target answer. A changed public contract needs a new build. A changed Studio
 * plan needs a new observation. Otherwise only the changed check runs again.
 */
export function cellAction(from: CellHashes, to: CellHashes, judgeChanged: boolean): CellDecision {
  if (to.criterion === null) return { action: "drop", reason: "criterion_removed" };
  if (from.publicContentHash !== to.publicContentHash)
    return { action: "new_build", reason: "public_content_changed" };
  if (from.studioPlanHash !== to.studioPlanHash)
    return { action: "new_observation", reason: "studio_plan_changed" };
  const recheck = to.criterion.method === "code" ? "code_recheck" : "judge_recheck";
  if (from.criterion === null) return { action: recheck, reason: "criterion_added" };
  if (from.criterion.method !== to.criterion.method || from.criterion.hash !== to.criterion.hash)
    return { action: recheck, reason: "criterion_changed" };
  if (to.criterion.method === "judge" && judgeChanged)
    return { action: "judge_recheck", reason: "judge_changed" };
  return { action: "reuse", reason: "unchanged" };
}
