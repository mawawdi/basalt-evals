import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { CriterionResult } from "../../contracts/src/index.js";
import { hashJson } from "../../contracts/src/index.js";
import {
  assertKnownBuild,
  KNOWN_BUILD_REASON_CHARS,
  KNOWN_EXPECTATIONS,
  knownBuildStatus,
  MAX_KNOWN_BUILD_CRITERIA,
  type KnownBuild,
  type KnownBuildCheck,
  type KnownBuildGateRecord,
  type KnownBuildResult,
  type KnownBuildRetirement,
  type KnownExpectation,
} from "../../contracts/src/known-builds.js";
import type { RecheckPart } from "../../contracts/src/recheck.js";
import { fields, hash, identity, text } from "../../contracts/src/validation.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { criterionTextHash } from "../../eval-authoring/src/criterion-pairing.js";
import { evaluationIdentity, readLibraryEvaluation } from "../../eval-authoring/src/library.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import { readOperatorStudy } from "./config.js";
import { knownBuildGateDirectory } from "./known-build-gate.js";
import { ownedComputation } from "./owned-computation.js";
import { classifyRecheck, codeAnswer } from "./recheck.js";
import { registerSavedSubject } from "./replay.js";
import { reviewerProfile } from "./reviewers.js";
import { frozenRunStatus } from "./run-builder.js";
import { manifestHash, planCaptures, subjectEval } from "./run-manifest.js";
import { observeFixedSource } from "./source-observation.js";

/*
 * Known good and known bad builds. Only a person marks a build: the mark names the reviewer
 * profile of that person and one reason. Preparation checks each known build of an evaluation
 * with each new revision. The gate gates plan revisions only. It never scores a build, and it
 * never changes an answer of a run.
 */

const KNOWN_BUILDS = "known_builds";
const RETIREMENTS = "known_build_retirements";

/** Mark a saved build of a run as a known good or a known bad build for named criteria. */
export async function markKnownBuild(root: string, value: unknown): Promise<KnownBuild> {
  const input = fields(
    value,
    [
      "evaluationId",
      "operationId",
      "subjectId",
      "criterionIds",
      "expectation",
      "reviewerId",
      "reason",
    ],
    "Known build",
  );
  const evaluationId = evaluationIdentity(input.evaluationId);
  const entry = await readLibraryEvaluation(root, evaluationId);
  if (!entry) throw new Error("Basalt cannot find this evaluation.");
  if (entry.archived)
    throw new Error("This evaluation is in the archive. Restore it before you mark a build.");
  if (!(KNOWN_EXPECTATIONS as readonly unknown[]).includes(input.expectation))
    throw new Error("Mark the build as a known good build or a known bad build.");
  const reviewerId = identity(input.reviewerId, "reviewer identity");
  await reviewerProfile(root, reviewerId);
  const reason = text(input.reason, KNOWN_BUILD_REASON_CHARS, "The reason");
  const operationId = identity(input.operationId, "run identity");
  const subjectId = identity(input.subjectId, "build identity");
  if (
    !Array.isArray(input.criterionIds) ||
    !input.criterionIds.length ||
    input.criterionIds.length > MAX_KNOWN_BUILD_CRITERIA ||
    new Set(input.criterionIds).size !== input.criterionIds.length
  )
    throw new Error("Choose one or more criteria of the build.");
  const status = await frozenRunStatus(root, operationId, false);
  const origin = subjectEval(status.manifest, subjectId);
  const store = new EvalDefinitionStore(root);
  const revision = await store.readExecutableRevision(origin.id);
  // The marked criteria must still be criteria of the same stage of the evaluation, so that a
  // later version can pair them by their text.
  const draft = await store.readDraft(entry.draftId);
  const current = new Set(
    (draft.stages[origin.stage.index - 1]?.criteria ?? []).map((criterion) =>
      criterionTextHash(criterion),
    ),
  );
  const criteria = input.criterionIds.map((id) => {
    const criterion = revision.authored.criteria.find((item) => item.id === id);
    if (!criterion)
      throw new Error("A chosen criterion is not a criterion of this build. Choose its criteria.");
    const textHash = criterionTextHash(criterion);
    if (!current.has(textHash))
      throw new Error(
        "A chosen criterion is not in the current version of the evaluation. Choose a criterion that it still has.",
      );
    return { authoredCriterionId: criterion.id, textHash };
  });
  const capture = planCaptures(status.manifest, subjectId, revision.privateEvaluator.studio).find(
    (cell) => status.completedUnits.includes(`final_capture:${cell.id}`),
  );
  if (!capture)
    throw new Error(
      "The build has no finished observation with the private tests. Choose a build with recorded evidence.",
    );
  const { saved } = await registerSavedSubject({ root, operationId, subjectId });
  const body: Omit<KnownBuild, "id"> = {
    evaluationId,
    criteria,
    expectation: input.expectation as KnownExpectation,
    build: {
      operationId,
      manifestHash: manifestHash(status.manifest),
      subjectId,
      sourceId: saved.id,
      captureId: capture.id,
    },
    originRevisionId: origin.id,
    reviewerId,
    reason,
    markedAt: new Date().toISOString(),
  };
  const known = assertKnownBuild({ ...body, id: hashJson(body) });
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => journal.put(KNOWN_BUILDS, known.id, known));
  } finally {
    journal.close();
  }
  return known;
}

/** Retire a known build. Basalt keeps the build and its mark, and it gates no later revision. */
export async function retireKnownBuild(
  root: string,
  value: unknown,
): Promise<KnownBuildRetirement> {
  const input = fields(value, ["knownBuildId", "reviewerId", "reason"], "Known build retirement");
  const knownBuildId = hash(input.knownBuildId, "known build identity");
  const reviewerId = identity(input.reviewerId, "reviewer identity");
  await reviewerProfile(root, reviewerId);
  const retirement: KnownBuildRetirement = {
    knownBuildId,
    reviewerId,
    reason: text(input.reason, KNOWN_BUILD_REASON_CHARS, "The reason"),
    retiredAt: new Date().toISOString(),
  };
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      if (!journal.read(KNOWN_BUILDS, knownBuildId))
        throw new Error("Basalt cannot find this known build.");
      if (journal.read(RETIREMENTS, knownBuildId))
        throw new Error("A person already retired this known build.");
      journal.put(RETIREMENTS, knownBuildId, retirement);
      return retirement;
    });
  } finally {
    journal.close();
  }
}

/** The known builds of one library evaluation, with the retirement of each one. */
export async function listKnownBuilds(root: string, evaluationId: string) {
  evaluationIdentity(evaluationId);
  const journal = await OperationJournal.open(root);
  try {
    return {
      evaluationId,
      knownBuilds: journal
        .list<KnownBuild>(KNOWN_BUILDS)
        .filter((known) => known.evaluationId === evaluationId)
        .map(assertKnownBuild)
        .sort((a, b) => a.markedAt.localeCompare(b.markedAt))
        .map((known) => ({
          ...known,
          retirement: journal.read<KnownBuildRetirement>(RETIREMENTS, known.id),
        })),
    };
  } finally {
    journal.close();
  }
}

/** The active known builds of the library evaluations that hold one draft. */
function activeKnownBuilds(journal: OperationJournal, draftId: string) {
  const members = journal.read<string[]>("evaluation_draft_members", draftId) ?? [];
  return {
    evaluationIds: members,
    knownBuilds: journal
      .list<KnownBuild>(KNOWN_BUILDS)
      .filter(
        (known) => members.includes(known.evaluationId) && !journal.read(RETIREMENTS, known.id),
      )
      .map(assertKnownBuild),
  };
}

/**
 * Check one known build with a version of its evaluation. The build pairs with the revision of
 * its own stage in that version. Saved evidence answers the code checks when the Studio plan did
 * not change. A changed plan observes the registered source again. A judge check keeps its saved
 * answer only when the recheck keeps it, and otherwise waits for a person. A build whose stage the
 * version does not reach, because of a gate of an earlier stage, is incomplete.
 */
async function checkKnownBuild(input: {
  root: string;
  /** The revision of stage 1 of the version. */
  revisionId: string;
  known: KnownBuild;
  observe: (revision: EvalRevision) => Promise<CriterionResult[]>;
}): Promise<KnownBuildResult[]> {
  const { known } = input;
  const result = (
    criterion: KnownBuild["criteria"][number],
    fields: Pick<
      KnownBuildResult,
      "targetCriterionId" | "checks" | "status" | "judgePart" | "reason"
    >,
  ): KnownBuildResult => ({
    knownBuildId: known.id,
    expectation: known.expectation,
    authoredCriterionId: criterion.authoredCriterionId,
    ...fields,
  });
  const classified = await classifyRecheck(
    input.root,
    {
      operationId: known.build.operationId,
      subjectIds: [known.build.subjectId],
      revisionId: input.revisionId,
      judge: null,
    },
    "known_build",
  );
  if (manifestHash(classified.manifest) !== known.build.manifestHash)
    throw new Error("The run of the known build changed");
  const { to: revision, toHashes: hashes } = classified;
  const gate = classified.gates.find((item) => item.state !== "passed");
  if (gate)
    return known.criteria.map((criterion) =>
      result(criterion, {
        targetCriterionId: null,
        checks: [],
        status: "incomplete",
        judgePart: null,
        reason: gate.reason,
      }),
    );
  let observed: CriterionResult[] | null = null;
  const results: KnownBuildResult[] = [];
  for (const criterion of known.criteria) {
    const target = revision.authored.criteria.find(
      (item) => criterionTextHash(item) === criterion.textHash,
    );
    if (!target) {
      results.push(
        result(criterion, {
          targetCriterionId: null,
          checks: [],
          status: "needs_person",
          judgePart: null,
          reason:
            "The text of this criterion changed. Mark the build again for the new text, or retire it.",
        }),
      );
      continue;
    }
    const executableIds = [
      ...new Set(
        revision.criterionMappings
          .filter(
            (mapping) =>
              mapping.authoredCriterionId === target.id &&
              mapping.executableCriterionId !== null &&
              hashes.criteria[mapping.executableCriterionId],
          )
          .map((mapping) => mapping.executableCriterionId!),
      ),
    ];
    const checks: KnownBuildCheck[] = [];
    let judgePart: RecheckPart | null = null,
      reason: string | null = null,
      rebuilt = false;
    for (const criterionId of executableIds) {
      const method = hashes.criteria[criterionId]!.method;
      const cell = classified.cells.find(
        (item) => item.captureId === known.build.captureId && item.toCriterionId === criterionId,
      );
      if (!cell || cell.action === "drop") {
        checks.push({ criterionId, method, answer: "insufficient" });
        continue;
      }
      if (cell.action === "new_build") {
        rebuilt = true;
        continue;
      }
      if (cell.action === "new_observation" && method === "code") {
        observed ??= await input.observe(revision);
        checks.push({
          criterionId,
          method,
          answer:
            codeAnswer(observed.find((item) => item.criterionId === criterionId)) ?? "insufficient",
        });
        continue;
      }
      if (cell.action === "new_observation" || cell.action === "judge_recheck") {
        judgePart = cell.action === "new_observation" ? "observation" : (judgePart ?? "judge");
        checks.push({ criterionId, method, answer: null });
        continue;
      }
      if (cell.issue) reason = cell.issue;
      checks.push({ criterionId, method, answer: cell.after ?? "insufficient" });
    }
    if (rebuilt) {
      results.push(
        result(criterion, {
          targetCriterionId: target.id,
          checks: [],
          status: "needs_person",
          judgePart: null,
          reason:
            "The prompt or the starting files changed. Check the build with the new version, then mark it again or retire it.",
        }),
      );
      continue;
    }
    const status = knownBuildStatus(known.expectation, checks);
    results.push(
      result(criterion, {
        targetCriterionId: target.id,
        checks,
        status,
        judgePart: status === "needs_judge" ? judgePart : null,
        reason:
          reason ??
          (executableIds.length
            ? null
            : "No code check or judge check of this version checks the criterion."),
      }),
    );
  }
  return results;
}

/**
 * Check every active known build of the prepared draft with the new revision, and save the gate
 * one time. The gate sends no model request. A failed check of one build makes its results
 * incomplete. Null: the evaluation has no active known build.
 */
export async function prepareKnownBuildGate(input: {
  root: string;
  operationId: string;
  revisionId: string;
  draftId: string;
  studio: StudioAdapter;
  signal: AbortSignal;
  /** Runs before Studio starts, for example the implementation guard of the run. */
  beforeObservation?: () => Promise<void>;
}): Promise<KnownBuildGateRecord | null> {
  const journal = await OperationJournal.open(input.root);
  let active: ReturnType<typeof activeKnownBuilds>;
  try {
    active = activeKnownBuilds(journal, input.draftId);
  } finally {
    journal.close();
  }
  if (!active.knownBuilds.length) return null;
  const directory = knownBuildGateDirectory(input.revisionId);
  const incomplete = (known: KnownBuild, reason: string): KnownBuildResult[] =>
    known.criteria.map((criterion) => ({
      knownBuildId: known.id,
      expectation: known.expectation,
      authoredCriterionId: criterion.authoredCriterionId,
      targetCriterionId: null,
      checks: [],
      status: "incomplete",
      judgePart: null,
      reason: reason.slice(0, 500),
    }));
  const record = (results: KnownBuildResult[]): KnownBuildGateRecord => ({
    schema: "basalt-evals/known-build-gate",
    revisionId: input.revisionId,
    operationId: input.operationId,
    evaluationIds: active.evaluationIds,
    results,
    checkedAt: new Date().toISOString(),
  });
  try {
    return await ownedComputation({
      root: input.root,
      operationId: input.operationId,
      namespace: "known_build_gates",
      key: input.revisionId,
      signal: input.signal,
      run: async () => {
        const results: KnownBuildResult[] = [];
        for (const known of active.knownBuilds)
          try {
            results.push(
              ...(await checkKnownBuild({
                root: input.root,
                revisionId: input.revisionId,
                known,
                observe: (target) => observeKnownBuild(input, target, known),
              })),
            );
          } catch (error) {
            if (input.signal.aborted) throw error;
            results.push(
              ...incomplete(known, error instanceof Error ? error.message : String(error)),
            );
          }
        const saved = record(results);
        await new RepositoryFiles(input.root).writeJsonOnce(`${directory}/record.json`, saved);
        return saved;
      },
    });
  } catch (error) {
    // Another run owns the check, or an earlier attempt failed. The receipt says incomplete.
    if (input.signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return record(active.knownBuilds.flatMap((known) => incomplete(known, reason)));
  }
}

/**
 * One observation of the registered source of a known build with the plan of a revision: the
 * revision of the stage of the build. The gate of the version keeps the observation.
 */
async function observeKnownBuild(
  input: Parameters<typeof prepareKnownBuildGate>[0],
  revision: EvalRevision,
  known: KnownBuild,
): Promise<CriterionResult[]> {
  await input.beforeObservation?.();
  const { studioVersion: _studioVersion, ...environment } = (
    await readOperatorStudy(input.root, [`.basalt-evals/eval-staging/${revision.id}`])
  ).environment;
  const observation = await observeFixedSource({
    root: input.root,
    revisionId: revision.id,
    base: `${knownBuildGateDirectory(input.revisionId)}/observations/${known.id.slice(0, 24)}`,
    purpose: "known_build",
    source: { sourceId: known.build.sourceId },
    treatmentId: `known-build-${known.id.slice(0, 12)}`,
    implementationCommit: await cleanImplementationCommit(input.root),
    connectorArtifactHash: (await input.studio.identity(input.root)).connectorArtifactHash,
    environment,
    signal: input.signal,
    studio: input.studio,
  });
  if (observation.status === "rejected")
    throw new Error(
      "The local check refused the known build: " + observation.diagnostics.join("; "),
    );
  return observation.results;
}
