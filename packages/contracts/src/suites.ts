import type { RunQuote } from "../../model-client/src/quote.js";
import { fields, hash, identity, text } from "./validation.js";
import { compareCodeUnits, hashJson } from "./index.js";

export interface SuiteMember {
  revisionId: string;
  validationRecordHash: string;
}
export interface SuiteSnapshot {
  id: string;
  suiteId: string;
  title: string;
  description: string;
  members: SuiteMember[];
}
export interface EvaluationSuite {
  id: string;
  snapshotId: string;
  title: string;
  memberCount: number;
  baselineOperationId: string | null;
  updatedAt: string;
}
export interface EvaluationRunSelection {
  revisionIds: string[];
  builderModelIds: string[];
  harnessIds: string[];
  repetitions: number;
  capturePasses: number;
  gradingModelId: string;
  judgeSettings: import("./judge-settings.js").JudgeSettings;
}
export interface SavedSelectionRunQuote {
  schema: "basalt-evals/saved-run-quote";
  kind: "selection";
  id: string;
  selection: EvaluationRunSelection;
  componentQuoteIds: string[];
  quote: RunQuote;
}

export function suiteMembers(value: unknown): SuiteMember[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new Error("A suite must contain 1 to 1,000 ready evaluations.");
  const members = value
    .map((item) => {
      const row = fields(item, ["revisionId", "validationRecordHash"], "Suite member");
      return {
        revisionId: hash(row.revisionId),
        validationRecordHash: hash(row.validationRecordHash),
      };
    })
    .sort((a, b) => compareCodeUnits(a.revisionId, b.revisionId));
  if (new Set(members.map((item) => item.revisionId)).size !== members.length)
    throw new Error(
      "This suite contains the same evaluation more than one time. Select each evaluation only one time.",
    );
  return members;
}

export function suiteSnapshot(value: unknown): SuiteSnapshot {
  const row = fields(value, ["id", "suiteId", "title", "description", "members"], "Suite snapshot");
  if (typeof row.description !== "string" || row.description.length > 2000)
    throw new Error("Suite description must be at most 2,000 characters");
  const body = {
    suiteId: identity(row.suiteId),
    title: text(row.title, 160, "Suite title"),
    description: row.description,
    members: suiteMembers(row.members),
  };
  if (hash(row.id) !== hashJson(body)) throw new Error("Suite snapshot content changed");
  return { ...body, id: row.id as string };
}

export function evaluationSuite(value: unknown): EvaluationSuite {
  const row = fields(
    value,
    ["id", "snapshotId", "title", "memberCount", "baselineOperationId", "updatedAt"],
    "Suite",
  );
  if (
    !Number.isSafeInteger(row.memberCount) ||
    Number(row.memberCount) < 1 ||
    Number(row.memberCount) > 1000 ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw new Error("Invalid suite metadata");
  return {
    id: identity(row.id),
    snapshotId: hash(row.snapshotId),
    title: text(row.title, 160, "Suite title"),
    memberCount: Number(row.memberCount),
    baselineOperationId:
      row.baselineOperationId === null ? null : identity(row.baselineOperationId),
    updatedAt: row.updatedAt,
  };
}
