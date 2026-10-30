import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import {
  createLibraryEvaluation,
  saveLibraryDraft,
} from "../packages/eval-authoring/src/library.js";
import { readHoldoutAccess } from "../packages/operator/src/holdout-access.js";
import { revisionPlanWarnings } from "../packages/operator/src/plan-warnings.js";
import { knownBuildGate } from "../packages/operator/src/known-build-gate.js";
import {
  listKnownBuilds,
  markKnownBuild,
  prepareKnownBuildGate,
  retireKnownBuild,
} from "../packages/operator/src/known-builds.js";
import { createReviewer } from "../packages/operator/src/reviewers.js";
import { inspectOperationOutcomes } from "../packages/operator/src/run-report.js";
import { quoteRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import { modelCalls, savedRevision, savedRun } from "./saved-run-fixture.js";
import { fixtureInput } from "./shared-api-fixture.js";

/** A saved run, its library evaluation and a reviewer who marks one of its builds. */
async function markedBuild(root: string, expectation: "met" | "not_met", criterionIds: string[]) {
  const saved = await savedRun(root);
  const library = await createLibraryEvaluation(root, saved.revision.draftId);
  const reviewer = await createReviewer(root, "Known build reviewer");
  const known = await markKnownBuild(root, {
    evaluationId: library.id,
    operationId: saved.operationId,
    subjectId: saved.subjectId,
    criterionIds,
    expectation,
    reviewerId: reviewer.id,
    reason: "The Beacon exists and it is blue.",
  });
  const gate = (revisionId: string, draftId = saved.revision.draftId) =>
    prepareKnownBuildGate({
      root,
      operationId: "prepare-known-builds",
      revisionId,
      draftId,
      studio: saved.adapters.studio,
      signal: new AbortController().signal,
    });
  /** A quote of new builds of one revision. */
  const benchmark = (revisionId: string, validationRecordHash: string) =>
    quoteRegisteredEvalRun({
      root,
      adapters: saved.adapters,
      selection: {
        captureScope: "final",
        publicFeedbackId: null,
        sourceIds: [],
        parentSourceId: null,
        gradingMode: "code",
        continuingOperationId: null,
        revisionId,
        validationRecordHash,
        builderModelIds: ["openai/gpt-6-luna"],
        gradingModelId: null,
        judgeSettings: DEFAULT_JUDGE_SETTINGS,
        harnessIds: ["thin"],
        repetitions: 1,
        nativeCaptureRepetitions: 1,
      },
    });
  return { saved, library, reviewer, known, gate, benchmark };
}

/** A revision whose code check expects another name for the Beacon. */
function otherName(name: string) {
  return ({
    privateProposal,
  }: {
    privateProposal: import("../packages/eval-authoring/src/proposals.js").PrivateProposal;
  }) => {
    const criterion = privateProposal.privateEvaluator.deterministic[0]!;
    if (criterion.rule.kind !== "fact_equals") throw new Error("Unexpected fixture rule");
    criterion.rule.expected = name;
  };
}

test("A plan version that fails a known good build blocks a new benchmark.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-known-blocks-"));
  try {
    const { saved, reviewer, known, gate, benchmark } = await markedBuild(root, "met", [
      "criterion-1",
    ]);
    const changed = await savedRevision(root, otherName("Lighthouse"));
    const calls = await modelCalls(root);
    const record = await gate(changed.revision.id);
    assert.equal(await modelCalls(root), calls, "The gate sends no model request");
    assert.deepEqual(
      record?.results.map((result) => [result.authoredCriterionId, result.status, result.checks]),
      [
        [
          "criterion-1",
          "broken",
          [{ criterionId: "beacon-exists", method: "code", answer: "not_met" }],
        ],
      ],
    );
    assert.equal((await knownBuildGate(root, changed.revision.id)).state, "blocked");
    const disagreements = async () =>
      (await revisionPlanWarnings(root, changed.revision.id)).warnings
        .filter((warning) => warning.kind === "known_build_disagrees")
        .map((warning) => [warning.criterionId, warning.knownBuildIds]);
    assert.deepEqual(await disagreements(), [["beacon-exists", [known.id]]]);
    await assert.rejects(
      benchmark(changed.revision.id, changed.validationRecordHash),
      /Known builds block a new benchmark of this evaluation version: 1 contradict the plan/u,
    );
    // The gate read the withheld observation of the build, so it looked at the holdout.
    assert.deepEqual(
      (await readHoldoutAccess(root, saved.revision.id)).looks.map((look) => look.purpose),
      ["known_build"],
    );
    // A plan version that keeps the answer of the known build opens the gate.
    const same = await savedRevision(root, otherName("Beacon"));
    assert.equal((await gate(same.revision.id))?.results[0]?.status, "holds");
    assert.equal((await knownBuildGate(root, same.revision.id)).state, "open");
    await benchmark(same.revision.id, same.validationRecordHash);
    // A person can retire the known build. It then gates nothing.
    await retireKnownBuild(root, {
      knownBuildId: known.id,
      reviewerId: reviewer.id,
      reason: "The plan now checks the name differently.",
    });
    assert.equal((await knownBuildGate(root, changed.revision.id)).state, "open");
    assert.deepEqual(await disagreements(), [], "A retired known build gives no warning");
    await benchmark(changed.revision.id, changed.validationRecordHash);
    assert.notEqual(
      (await listKnownBuilds(root, known.evaluationId)).knownBuilds[0]!.retirement,
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("An incomplete check blocks and is not a failure.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-known-incomplete-"));
  try {
    const { gate, benchmark } = await markedBuild(root, "met", ["criterion-1", "criterion-2"]);
    // The name fact has no text field, so the changed code check cannot decide.
    const undecided = await savedRevision(root, ({ privateProposal }) => {
      const criterion = privateProposal.privateEvaluator.deterministic[0]!;
      if (criterion.rule.kind !== "fact_equals") throw new Error("Unexpected fixture rule");
      criterion.rule.field = "text";
    });
    const record = await gate(undecided.revision.id);
    assert.deepEqual(
      record?.results.map((result) => [result.authoredCriterionId, result.status]),
      [
        ["criterion-1", "incomplete"],
        ["criterion-2", "holds"],
      ],
    );
    assert.ok(record.results.every((result) => result.status !== "broken"));
    assert.deepEqual(record.results[0]!.checks, [
      { criterionId: "beacon-exists", method: "code", answer: "insufficient" },
    ]);
    await assert.rejects(
      benchmark(undecided.revision.id, undecided.validationRecordHash),
      /1 have an incomplete check.*An incomplete check blocks, but it is not a failure/u,
    );
    // A changed judge criterion waits for a judge check that a person launches. It blocks too.
    const judged = await savedRevision(root, ({ privateProposal }) => {
      privateProposal.privateEvaluator.unscaled[0]!.evidence.facts = [];
    });
    const waiting = await gate(judged.revision.id);
    assert.deepEqual(
      waiting?.results.map((result) => [
        result.authoredCriterionId,
        result.status,
        result.judgePart,
      ]),
      [
        ["criterion-1", "holds", null],
        ["criterion-2", "needs_judge", "judge"],
      ],
    );
    assert.equal((await knownBuildGate(root, judged.revision.id)).state, "blocked");
    // A changed Studio plan observes the registered source again for the code check. The judge
    // check then needs a new observation with the judge.
    const replanned = await savedRevision(root, ({ privateProposal }) => {
      privateProposal.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
    });
    const observed = await gate(replanned.revision.id);
    assert.deepEqual(
      observed?.results.map((result) => [result.status, result.judgePart, result.checks]),
      [
        ["holds", null, [{ criterionId: "beacon-exists", method: "code", answer: "met" }]],
        [
          "needs_judge",
          "observation",
          [{ criterionId: "beacon-blue", method: "judge", answer: null }],
        ],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A known build never changes an answer.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-known-answers-"));
  try {
    const { saved, gate } = await markedBuild(root, "not_met", ["criterion-1"]);
    const outcomes = await inspectOperationOutcomes(root, saved.operationId);
    const evidence = resolve(
      root,
      `.basalt-evals/eval-operations/${saved.operationId}/capture/${saved.captureId}/studio/evidence.json`,
    );
    const bytes = await readFile(evidence);
    // The run says that the Beacon exists. A person calls the build a known bad build for it,
    // so the gate is broken, and the answer of the run stays met.
    const record = await gate(saved.revision.id);
    assert.equal(record?.results[0]?.status, "broken");
    assert.deepEqual(await inspectOperationOutcomes(root, saved.operationId), outcomes);
    assert.deepEqual(
      outcomes.outcomes.map((outcome) => [outcome.criterionId, outcome.outcome]),
      [
        ["beacon-exists", "verified"],
        ["beacon-blue", "verified"],
      ],
    );
    assert.deepEqual(await readFile(evidence), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Changed criterion text needs a person.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-known-text-"));
  try {
    const { library, gate } = await markedBuild(root, "met", ["criterion-1"]);
    // A person edits the text of the first criterion. The edit is a new draft of the evaluation.
    const edited = {
      ...fixtureInput,
      stages: [
        {
          ...fixtureInput.stages[0]!,
          rubric: fixtureInput.stages[0]!.rubric.replace("object", "part"),
        },
      ],
    };
    const draft = createEvalDraft(edited);
    const revision = await savedRevision(
      root,
      ({ privateProposal }) => {
        privateProposal.privateEvaluator.deterministic[0]!.statement =
          draft.stages[0]!.criteria[0]!.text;
        privateProposal.criterionMappings = draft.stages[0]!.criteria.map((criterion, index) => ({
          ...privateProposal.criterionMappings[index]!,
          authoredClauseIds: criterion.clauses.map((clause) => clause.id),
          authority: { source: "human_rubric", start: criterion.start, end: criterion.end },
        }));
      },
      edited,
    );
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() =>
        saveLibraryDraft(journal, {
          id: library.id,
          draftId: draft.id,
          expectedDraftId: library.draftId,
        }),
      );
    } finally {
      journal.close();
    }
    const record = await gate(revision.revision.id, draft.id);
    assert.deepEqual(
      record?.results.map((result) => [result.status, result.targetCriterionId, result.checks]),
      [["needs_person", null, []]],
    );
    assert.match(record.results[0]!.reason!, /text of this criterion changed/u);
    assert.equal((await knownBuildGate(root, revision.revision.id)).state, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
