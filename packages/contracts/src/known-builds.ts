import { hashJson } from "./index.js";
import type { RecheckAnswer, RecheckPart } from "./recheck.js";

/*
 * Known good and known bad builds. A person marks a saved build as good or bad for named authored
 * criteria and gives a reason. Basalt pairs each criterion by the hash of its text. When Basalt
 * prepares a new revision, it checks each known build with the new plan. A plan revision that
 * contradicts a known build blocks a new benchmark. The gate never scores a build and never
 * changes an answer.
 */

export const KNOWN_BUILD_REASON_CHARS = 300;
export const MAX_KNOWN_BUILD_CRITERIA = 32;

/** Met: the build is a known good build for the criteria. Not met: a known bad build. */
export const KNOWN_EXPECTATIONS = ["met", "not_met"] as const;
export type KnownExpectation = (typeof KNOWN_EXPECTATIONS)[number];

/** One authored criterion of a known build, with the hash of its exact text. */
export interface KnownBuildCriterion {
  authoredCriterionId: string;
  textHash: string;
}

/** The saved build: its run, its registered source and one finished observation. */
export interface KnownBuildReference {
  operationId: string;
  manifestHash: string;
  subjectId: string;
  /** The registered source. A changed Studio plan observes this source again. */
  sourceId: string;
  /** The first finished observation of the build with the private plan of its run. */
  captureId: string;
}

export interface KnownBuild {
  id: string;
  /** The library evaluation. Each new revision of it checks the known builds. */
  evaluationId: string;
  criteria: KnownBuildCriterion[];
  expectation: KnownExpectation;
  build: KnownBuildReference;
  /** The revision of the run that made the build. */
  originRevisionId: string;
  /** The server identity of the reviewer profile of the person who marked the build. */
  reviewerId: string;
  reason: string;
  markedAt: string;
}

/** A person retires a known build. A retired build never gates a revision again. */
export interface KnownBuildRetirement {
  knownBuildId: string;
  reviewerId: string;
  reason: string;
  retiredAt: string;
}

/**
 * The state of one known build and one criterion against one revision.
 * - `holds`: the checks give the expected answer.
 * - `broken`: the checks give the other definite answer.
 * - `incomplete`: a check has no definite answer. It blocks, and it is not a failure.
 * - `needs_person`: the text of the criterion changed, or the prompt changed for a judge check.
 * - `needs_judge`: a judge check needs a new answer. A person launches it with a spending limit.
 */
export const KNOWN_BUILD_STATUSES = [
  "holds",
  "broken",
  "incomplete",
  "needs_person",
  "needs_judge",
] as const;
export type KnownBuildStatus = (typeof KNOWN_BUILD_STATUSES)[number];

/** One executable check of the gated revision for the criterion. */
export interface KnownBuildCheck {
  criterionId: string;
  method: "code" | "judge";
  /** Null while the judge check waits for a person to launch it. */
  answer: RecheckAnswer | null;
}

export interface KnownBuildResult {
  knownBuildId: string;
  expectation: KnownExpectation;
  /** The authored criterion where the person marked the build. */
  authoredCriterionId: string;
  /** The authored criterion of the gated revision with the same text, or null. */
  targetCriterionId: string | null;
  checks: KnownBuildCheck[];
  status: KnownBuildStatus;
  /** The paid part that gives the judge answers, for `needs_judge`. */
  judgePart: RecheckPart | null;
  reason: string | null;
}

/** The gate of one revision as preparation saved it. */
export interface KnownBuildGateRecord {
  schema: "basalt-evals/known-build-gate";
  revisionId: string;
  /** The preparation run that checked the known builds. */
  operationId: string;
  /** The library evaluations of the prepared draft. */
  evaluationIds: string[];
  results: KnownBuildResult[];
  checkedAt: string;
}

/** The current gate: the saved record without retired builds and with finished judge answers. */
export interface KnownBuildGate {
  revisionId: string;
  /** False when preparation saved no gate for this revision. */
  checked: boolean;
  results: KnownBuildResult[];
  state: "open" | "blocked";
}

const hashPattern = /^[a-f0-9]{64}$/u;
const identityPattern = /^[a-z0-9][a-z0-9-]{0,100}$/u;

/**
 * The status of one known build criterion from its checks. One not met check makes the criterion
 * not met. Every check met makes it met. Another answer gives no definite answer, so the status
 * is incomplete. Only checks that wait for the judge give `needs_judge`.
 */
export function knownBuildStatus(
  expectation: KnownExpectation,
  checks: KnownBuildCheck[],
): KnownBuildStatus {
  if (!checks.length) return "incomplete";
  const answers = checks.map((check) => check.answer);
  if (answers.includes("not_met")) return expectation === "not_met" ? "holds" : "broken";
  if (answers.every((answer) => answer === "met"))
    return expectation === "met" ? "holds" : "broken";
  if (answers.some((answer) => answer !== null && answer !== "met")) return "incomplete";
  return "needs_judge";
}

export function assertKnownBuild(value: unknown): KnownBuild {
  const row = value as KnownBuild;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !==
      "build,criteria,evaluationId,expectation,id,markedAt,originRevisionId,reason,reviewerId" ||
    typeof row.evaluationId !== "string" ||
    !/^eval-[a-z0-9-]{16,64}$/u.test(row.evaluationId) ||
    !(KNOWN_EXPECTATIONS as readonly unknown[]).includes(row.expectation) ||
    !hashPattern.test(String(row.originRevisionId)) ||
    typeof row.reviewerId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(row.reviewerId) ||
    typeof row.reason !== "string" ||
    !row.reason.trim() ||
    row.reason.length > KNOWN_BUILD_REASON_CHARS ||
    typeof row.markedAt !== "string" ||
    !Number.isFinite(Date.parse(row.markedAt)) ||
    !Array.isArray(row.criteria) ||
    !row.criteria.length ||
    row.criteria.length > MAX_KNOWN_BUILD_CRITERIA ||
    row.criteria.some(
      (criterion) =>
        !criterion ||
        Object.keys(criterion).sort().join(",") !== "authoredCriterionId,textHash" ||
        typeof criterion.authoredCriterionId !== "string" ||
        !/^criterion-[1-9][0-9]{0,3}$/u.test(criterion.authoredCriterionId) ||
        !hashPattern.test(String(criterion.textHash)),
    ) ||
    new Set(row.criteria.map((criterion) => criterion.authoredCriterionId)).size !==
      row.criteria.length ||
    !row.build ||
    Object.keys(row.build).sort().join(",") !==
      "captureId,manifestHash,operationId,sourceId,subjectId" ||
    ![row.build.operationId, row.build.subjectId, row.build.captureId].every(
      (item) => typeof item === "string" && identityPattern.test(item),
    ) ||
    ![row.build.manifestHash, row.build.sourceId].every(
      (item) => typeof item === "string" && hashPattern.test(item),
    )
  )
    throw new Error("Invalid known build");
  const { id, ...body } = row;
  if (id !== hashJson(body)) throw new Error("Known build changed");
  return row;
}
