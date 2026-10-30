import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import type { RecheckPreview } from "../packages/contracts/src/recheck.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { executeAssessment, queueAssessment } from "../packages/operator/src/assessment.js";
import { readHoldoutAccess } from "../packages/operator/src/holdout-access.js";
import { previewOperationLaunch } from "../packages/operator/src/launch.js";
import { previewRecheck } from "../packages/operator/src/recheck.js";
import { recordRecheckLaunch } from "../packages/operator/src/recheck-results.js";
import {
  OTHER_JUDGE,
  SAVED_JUDGE,
  modelCalls,
  savedRevision,
  savedRun,
} from "./saved-run-fixture.js";
import { fixtureInput } from "./shared-api-fixture.js";

/** The action, the reason and the answers of each criterion, by executable criterion. */
function actions(preview: RecheckPreview) {
  return Object.fromEntries(
    preview.cells.map((cell) => [
      cell.toCriterionId ?? cell.fromCriterionId,
      [cell.action, cell.reason, cell.before, cell.after],
    ]),
  );
}

test("Each saved build and criterion gets its action from the hash that changed.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-recheck-actions-"));
  try {
    const saved = await savedRun(root);
    const selection = (revisionId: string, judge: string | null = null) => ({
      operationId: saved.operationId,
      subjectIds: [saved.subjectId],
      revisionId,
      judge: judge ? { modelId: judge, presentation: "still" as const } : null,
    });
    // The fixture build has a Beacon, and the fixture judge sees a blue image.
    assert.deepEqual(
      actions(await previewRecheck(root, selection(saved.revision.id), saved.adapters)),
      {
        "beacon-exists": ["reuse", "unchanged", "met", "met"],
        "beacon-blue": ["reuse", "unchanged", "met", "met"],
      },
    );
    assert.deepEqual(
      actions(
        await previewRecheck(root, selection(saved.revision.id, OTHER_JUDGE), saved.adapters),
      ),
      {
        "beacon-exists": ["reuse", "unchanged", "met", "met"],
        "beacon-blue": ["judge_recheck", "judge_changed", "met", null],
      },
    );
    const rule = await savedRevision(root, ({ privateProposal }) => {
      const criterion = privateProposal.privateEvaluator.deterministic[0]!;
      if (criterion.rule.kind !== "fact_equals") throw new Error("Unexpected fixture rule");
      criterion.rule.expected = "Lighthouse";
    });
    const ruleChecked = await previewRecheck(root, selection(rule.revision.id), saved.adapters);
    assert.deepEqual(actions(ruleChecked), {
      "beacon-exists": ["code_recheck", "criterion_changed", "met", "not_met"],
      "beacon-blue": ["reuse", "unchanged", "met", "met"],
    });
    // The fixture run withholds its final observation, so the code check looks at the holdout
    // one time. A second preview reads the saved code results.
    const looks = async () =>
      (await readHoldoutAccess(root, saved.revision.id)).looks.filter(
        (look) => look.purpose === "recheck",
      );
    assert.deepEqual(ruleChecked.holdoutCaptureIds, [saved.captureId]);
    assert.equal((await looks()).length, 1);
    await previewRecheck(root, selection(rule.revision.id), saved.adapters);
    assert.equal((await looks()).length, 1);
    const plan = await savedRevision(root, ({ privateProposal }) => {
      privateProposal.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
    });
    const observed = await previewRecheck(root, selection(plan.revision.id), saved.adapters);
    assert.deepEqual(actions(observed), {
      "beacon-exists": ["new_observation", "studio_plan_changed", "met", null],
      "beacon-blue": ["new_observation", "studio_plan_changed", "met", null],
    });
    assert.ok(observed.observation?.kind === "eval", JSON.stringify(observed.unavailable));
    assert.equal(observed.observation.selection.gradingMode, "code");
    const prompt = await savedRevision(root, ({ publicProposal }) => {
      publicProposal.publicTask.acceptance = ["Create a dark blue Beacon part."];
    });
    const rebuilt = await previewRecheck(root, selection(prompt.revision.id), saved.adapters);
    assert.deepEqual(
      rebuilt.cells.map((cell) => [cell.action, cell.reason]),
      [
        ["new_build", "public_content_changed"],
        ["new_build", "public_content_changed"],
      ],
    );
    assert.deepEqual(
      rebuilt.unavailable.map((item) => item.part),
      ["build"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Old and new answers pair by authored criterion.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-recheck-pairs-"));
  try {
    const saved = await savedRun(root);
    // The edited rubric lists the criteria in the other order, so the authored IDs change.
    const reordered = {
      ...fixtureInput,
      stages: [
        {
          ...fixtureInput.stages[0]!,
          rubric:
            "- The Beacon looks blue.\n  - Evidence class: appearance\n- A Beacon object exists.",
        },
      ],
    };
    const draft = createEvalDraft(reordered);
    const swapped = await savedRevision(
      root,
      ({ privateProposal }) => {
        privateProposal.criterionMappings = draft.stages[0]!.criteria.map((criterion, index) => ({
          authoredCriterionId: criterion.id,
          authoredClauseIds: criterion.clauses.map((clause) => clause.id),
          authority: { source: "human_rubric", start: criterion.start, end: criterion.end },
          method: index === 0 ? "unscaled" : "deterministic",
          executableCriterionId: index === 0 ? "beacon-blue" : "beacon-exists",
          rationale: "Synthetic fixture with the criteria in the other order.",
        }));
      },
      reordered,
    );
    const authored = swapped.revision.authored.criteria;
    for (const mapping of swapped.revision.criterionMappings) {
      const criterion = authored.find((item) => item.id === mapping.authoredCriterionId)!;
      assert.deepEqual(
        [mapping.authority.start, mapping.authority.end],
        [criterion.start, criterion.end],
      );
    }
    const preview = await previewRecheck(
      root,
      {
        operationId: saved.operationId,
        subjectIds: [saved.subjectId],
        revisionId: swapped.revision.id,
        judge: null,
      },
      saved.adapters,
    );
    const exists = preview.cells.find((cell) => cell.toCriterionId === "beacon-exists")!;
    assert.equal(exists.authoredCriterionId, "criterion-2");
    assert.equal(exists.authoredText, "- A Beacon object exists.");
    assert.deepEqual(
      [exists.fromCriterionId, exists.before, exists.after],
      ["beacon-exists", "met", "met"],
    );
    const blue = preview.cells.find((cell) => cell.toCriterionId === "beacon-blue")!;
    assert.equal(blue.authoredCriterionId, "criterion-1");
    assert.equal(blue.fromCriterionId, "beacon-blue");
    assert.equal(blue.before, "met");
    // No criterion was removed or added, so every old answer has a new place.
    assert.ok(
      preview.cells.every((cell) => cell.action !== "drop" && cell.reason !== "criterion_added"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Only judge rechecks have a cost.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-recheck-cost-"));
  try {
    const saved = await savedRun(root);
    const both = await savedRevision(root, ({ privateProposal }) => {
      const criterion = privateProposal.privateEvaluator.deterministic[0]!;
      if (criterion.rule.kind !== "fact_equals") throw new Error("Unexpected fixture rule");
      criterion.rule.expected = "Lighthouse";
      privateProposal.privateEvaluator.unscaled[0]!.evidence.facts = [];
    });
    const selection = {
      operationId: saved.operationId,
      subjectIds: [saved.subjectId],
      revisionId: both.revision.id,
      judge: { modelId: SAVED_JUDGE, presentation: "still" as const },
    };
    const calls = await modelCalls(root);
    const preview = await previewRecheck(root, selection, saved.adapters);
    assert.equal(await modelCalls(root), calls, "A preview sends no model request");
    assert.deepEqual(actions(preview), {
      "beacon-exists": ["code_recheck", "criterion_changed", "met", "not_met"],
      "beacon-blue": ["judge_recheck", "criterion_changed", "met", null],
    });
    assert.equal(preview.observation, null);
    assert.ok(preview.judge);
    assert.equal(preview.judge.selection.revisionId, both.revision.id);
    assert.deepEqual(
      preview.judge.units.flatMap((unit) => unit.criterionIds),
      ["beacon-blue"],
      "The judge part holds only the judge criterion",
    );
    assert.ok(preview.judge.quote.workload.modelWork.length > 0);
    // The launch of the judge part is a reassessment of the target revision. The code checks
    // already have answers, and nothing needs a new observation.
    const launch = await previewOperationLaunch(
      root,
      { kind: "recheck", selection: { ...selection, part: "judge" } },
      saved.adapters,
    );
    assert.equal(launch.binding.kind, "assessment");
    assert.ok((launch.quote?.workload.modelWork.length ?? 0) > 0);
    assert.deepEqual(launch.recheck, { ...selection, part: "judge" });
    await assert.rejects(
      previewOperationLaunch(
        root,
        { kind: "recheck", selection: { ...selection, part: "observation" } },
        saved.adapters,
      ),
      /need no new observation/u,
    );
    assert.equal(await modelCalls(root), calls, "A launch preview sends no model request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A recheck judges with the judge samples of the run and combines their answers.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-recheck-samples-"));
  try {
    const settings = { samples: 3, grouping: "shared" as const };
    const saved = await savedRun(root, SAVED_JUDGE, { judgeSettings: settings });
    const changed = await savedRevision(root, ({ privateProposal }) => {
      privateProposal.privateEvaluator.unscaled[0]!.evidence.facts = [];
    });
    const selection = {
      operationId: saved.operationId,
      subjectIds: [saved.subjectId],
      revisionId: changed.revision.id,
      judge: { modelId: SAVED_JUDGE, presentation: "still" as const },
    };
    const preview = await previewRecheck(root, selection, saved.adapters);
    assert.deepEqual(preview.judgeSettings, settings);
    // The three samples of the run met the criterion, so the saved answer is met.
    assert.deepEqual(actions(preview), {
      "beacon-exists": ["reuse", "unchanged", "met", "met"],
      "beacon-blue": ["judge_recheck", "criterion_changed", "met", null],
    });
    const units = preview.judge!.units;
    assert.deepEqual(
      units.map((unit) => [unit.criterionIds.join(), unit.batch.sample]),
      [
        ["beacon-blue", 1],
        ["beacon-blue", 2],
        ["beacon-blue", 3],
      ],
    );
    assert.equal(new Set(units.map((unit) => unit.batch.sampleGroupId)).size, 1);
    assert.equal(new Set(units.map((unit) => unit.evidenceSetId)).size, 1);
    // The quote counts each sample as its own request.
    const quoted = preview.judge!.quote.workload;
    assert.equal(quoted.judgmentBatches, 3);
    assert.equal(
      quoted.modelWork.reduce((sum, work) => sum + work.calls, 0),
      3,
    );
    // The samples of the recheck disagree. The run reads them one at a time from the queue.
    await writeFile(
      resolve(root, ".basalt-evals/synthetic-judge-answers.json"),
      JSON.stringify(["satisfied", "violated", "satisfied"]),
    );
    const calls = await modelCalls(root);
    const { operationId } = await queueAssessment(root, {
      previewId: preview.judge!.id,
      ceilingUsd: 1,
      idempotencyKey: "recheck-judge-samples",
    });
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() => {
        journal.put("drivers", operationId, { token: "driver", pid: process.pid, active: true });
        recordRecheckLaunch(journal, changed.revision.id, saved.operationId, {
          operationId,
          part: "judge",
          subjects: [{ subjectId: saved.subjectId, sourceId: null }],
          previewId: preview.judge!.id,
        });
      });
    } finally {
      journal.close();
    }
    await executeAssessment(
      root,
      operationId,
      "driver",
      new AbortController().signal,
      saved.adapters,
    );
    assert.equal((await modelCalls(root)) - calls, 3, "Each sample is its own request");
    const requests = (await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; requestHash: string })
      .filter((line) => line.kind === "model")
      .slice(-3);
    assert.equal(new Set(requests.map((line) => line.requestHash)).size, 1);
    const after = await previewRecheck(root, selection, saved.adapters);
    assert.deepEqual(actions(after)["beacon-blue"], [
      "judge_recheck",
      "criterion_changed",
      "met",
      "split",
    ]);
    // A new observation judges with the settings of the run too.
    const plan = await savedRevision(root, ({ privateProposal }) => {
      privateProposal.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
    });
    const observed = await previewRecheck(
      root,
      { ...selection, revisionId: plan.revision.id },
      saved.adapters,
    );
    assert.ok(observed.observation?.kind === "eval", JSON.stringify(observed.unavailable));
    assert.deepEqual(observed.observation.selection.judgeSettings, settings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
