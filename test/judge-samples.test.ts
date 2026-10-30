import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import type { ExecutionProgress } from "../packages/contracts/src/console.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { selectiveOutcome } from "../packages/experiments/src/acceptance.js";
import {
  combinedOutcome,
  combineSamples,
  outcomeVote,
  sampleVote,
} from "../packages/experiments/src/judge-samples.js";
import { checkingCeiling } from "../packages/model-client/src/quote.js";
import { operatorEvidence } from "../packages/operator/src/evidence-view.js";
import type { RunJudgmentArtifact } from "../packages/operator/src/judgment-artifact.js";
import { RunOperationStore } from "../packages/operator/src/operation.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import { executeFrozenJudgmentBatch } from "../packages/operator/src/run-judgment.js";
import { manifestHash } from "../packages/operator/src/run-manifest.js";
import { freezeRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import { sealRegisteredSubject } from "../packages/operator/src/seal-source.js";
import { savedBuild } from "./judge-fixture.js";

test("Each sample is a distinct ledger request with identical bytes.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-judge-samples-"));
  try {
    const { adapters, quote } = await savedBuild(root);
    const saved = await quote({ samples: 3, grouping: "shared" });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-judge-samples",
      ceilingUsd: 1,
      adapters,
    });
    const batches = manifest.judgmentBatches;
    assert.deepEqual(
      batches.map((batch) => batch.sample),
      [1, 2, 3],
    );
    assert.equal(new Set(batches.map((batch) => batch.id)).size, 3);
    assert.equal(new Set(batches.map((batch) => batch.sampleGroupId)).size, 1);
    const capture = manifest.captureCells[0]!;
    await sealRegisteredSubject(root, manifest.id, capture.treatmentId);
    await executeFrozenCaptureCell({
      root,
      operationId: manifest.id,
      cellId: capture.id,
      studioAdapter: adapters.studio,
    });
    const artifacts = (await Promise.all(
      batches.map((batch) =>
        executeFrozenJudgmentBatch({ root, operationId: manifest.id, batchId: batch.id, adapters }),
      ),
    )) as RunJudgmentArtifact[];
    const ledger = await new RunOperationStore(
      root,
      manifest.id,
      manifestHash(manifest),
      manifest.inputHash,
    ).ledger.read();
    const entries = ledger.entries.filter((entry) => entry.stage.startsWith("judgment:"));
    assert.deepEqual(
      entries.map((entry) => entry.stage).sort(),
      batches.map((batch) => `judgment:${batch.id}`).sort(),
      "Each sample has its own ledger request",
    );
    assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 3);
    assert.equal(new Set(entries.map((entry) => entry.requestHash)).size, 1, "Identical bytes");
    const calls = (await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.request?.tools?.[0]?.name === "submit_judgment_batch");
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((call) => hashJson(call.request))).size, 1);
    // The run results show one check that combines the three samples.
    const evidence = await operatorEvidence(root, manifest.id);
    const judged = evidence.candidates[0]!.cells.filter((cell) => cell.samples);
    assert.equal(judged.length, 1);
    const verdict = artifacts[0]!.decisions[0]!.verdict;
    assert.deepEqual(judged[0]!.samples, {
      answer: verdict === "satisfied" ? "met" : "not_met",
      met: verdict === "satisfied" ? 3 : 0,
      of: 3,
      decisions: artifacts.map((artifact) => artifact.decisions[0]),
    });
    assert.equal(judged[0]!.automaticDecision.recordId, batches[0]!.sampleGroupId);
    assert.deepEqual(judged[0]!.addressedToEvaluator, { found: false, quote: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("An insufficient judge sample is an answer of the run, and a missing sample is unavailable.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-judge-insufficient-"));
  try {
    const { adapters, quote } = await savedBuild(root);
    const saved = await quote({ samples: 3, grouping: "shared" });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-insufficient-samples",
      ceilingUsd: 1,
      adapters,
    });
    const capture = manifest.captureCells[0]!;
    await sealRegisteredSubject(root, manifest.id, capture.treatmentId);
    await executeFrozenCaptureCell({
      root,
      operationId: manifest.id,
      cellId: capture.id,
      studioAdapter: adapters.studio,
    });
    const judge = (batchId: string) =>
      executeFrozenJudgmentBatch({ root, operationId: manifest.id, batchId, adapters });
    const answers = async () => {
      const journal = await OperationJournal.open(root);
      try {
        return journal.read<ExecutionProgress>("operation_progress", manifest.id)!.answers;
      } finally {
        journal.close();
      }
    };
    const judged = async () =>
      (await operatorEvidence(root, manifest.id)).candidates[0]!.cells.find(
        (cell) => cell.samples,
      )!;
    // The samples run one at a time, so each takes the next queued answer.
    await writeFile(
      resolve(root, ".basalt-evals/synthetic-judge-answers.json"),
      JSON.stringify(["insufficient", "satisfied", "satisfied"]),
    );
    const [first, second, third] = manifest.judgmentBatches;
    await judge(first!.id);
    await judge(second!.id);
    const store = new RunOperationStore(
      root,
      manifest.id,
      manifestHash(manifest),
      manifest.inputHash,
    );
    assert.deepEqual(
      (await store.read()).criterionOutcomes
        .filter(
          (item) => item.cellId !== third!.id && first!.criterionIds.includes(item.criterionId),
        )
        .map((item) => item.outcome),
      ["insufficient", "verified"],
      "The judge answer stays insufficient, never incomplete",
    );
    // The third sample has no answer yet, so the check is unavailable.
    let cell = await judged();
    assert.equal(cell.outcome, "incomplete");
    assert.equal(cell.samples!.answer, "missing");
    const code = manifest.gradingCells.length,
      checks = code + first!.criterionIds.length;
    assert.ok(checks < manifest.planned.criterionOutcomes, "The plan counts each sample");
    assert.deepEqual(await answers(), {
      planned: checks,
      met: 0,
      rejected: 0,
      split: 0,
      scored: 0,
      insufficient: 0,
      unavailable: checks,
    });
    await judge(third!.id);
    cell = await judged();
    assert.equal(cell.outcome, "insufficient");
    assert.deepEqual(
      { answer: cell.samples!.answer, met: cell.samples!.met, of: cell.samples!.of },
      { answer: "insufficient", met: 2, of: 3 },
    );
    assert.deepEqual(await answers(), {
      planned: checks,
      met: 0,
      rejected: 0,
      split: 0,
      scored: 0,
      insufficient: 1,
      // Only the code checks, which this test does not run, have no answer.
      unavailable: code,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Disagreeing samples are split, not met and not failed.", () => {
  assert.deepEqual(combineSamples(["met", "met", "met"]), { answer: "met", met: 3, of: 3 });
  assert.deepEqual(combineSamples(["not_met", "not_met"]), { answer: "not_met", met: 0, of: 2 });
  const split = combineSamples(["met", "not_met", "met"]);
  assert.deepEqual(split, { answer: "split", met: 2, of: 3 });
  assert.equal(combinedOutcome(split), "split", "A split is neither verified nor rejected");
  const missing = combineSamples(["met", null, "insufficient"]);
  assert.equal(missing.answer, "missing", "A sample without an answer is not insufficient");
  assert.equal(combinedOutcome(missing), "incomplete");
  const insufficient = combineSamples(["met", "insufficient"]);
  assert.equal(insufficient.answer, "insufficient");
  assert.equal(combinedOutcome(insufficient), "insufficient", "An answer, not a missing result");
  assert.equal(combineSamples(["scored", "scored"]).answer, "scored");
  // A scored criterion is met only when every score is at or above the authored minimum.
  const scored = (scores: number[]) =>
    combineSamples(
      scores.map((score) =>
        sampleVote({ answer: score >= 3 ? "satisfied" : "violated", score }, 3),
      ),
    ).answer;
  assert.equal(scored([4, 3, 3]), "met");
  assert.equal(scored([4, 3, 2]), "split");
  assert.equal(scored([1, 2]), "not_met");
  assert.equal(sampleVote({ answer: "insufficient", score: 5 }, null), "scored");
  assert.equal(sampleVote({ answer: "insufficient", score: null }, 3), "insufficient");
  assert.deepEqual(["verified", "rejected", "scored", "incomplete", undefined].map(outcomeVote), [
    "met",
    "not_met",
    "scored",
    "insufficient",
    null,
  ]);
  // Selective acceptance reads each sample as a repeat of one identical request.
  const decisions = ["satisfied", "violated", "satisfied"] as const;
  const outcome = selectiveOutcome(
    {
      id: "unit",
      buildId: "build",
      criterionId: "criterion",
      threshold: null,
      samples: decisions.map((decision, index) => ({
        captureId: "capture",
        repeat: index + 1,
        family: "family",
        decision,
        score: null,
        truncated: false,
      })),
      integrityIssue: false,
      evidenceUseFailed: false,
      expertsDisagree: false,
    },
    { id: "three-samples", captures: 1, repeats: 3, families: 1 },
  );
  assert.equal(outcome.outcome, "escalate");
  assert.deepEqual(outcome.reasons, ["repeat_disagreement"]);
});

test("The preview multiplies the requests.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-judge-sample-quote-"));
  try {
    const { quote, revision } = await savedBuild(root);
    const one = await quote({ samples: 1, grouping: "shared" });
    const three = await quote({ samples: 3, grouping: "shared" });
    const grading = (saved: typeof one) =>
      saved.quote.workload.modelWork.filter((work) => work.stage === "grading");
    assert.deepEqual(
      grading(three).map((work) => work.calls),
      grading(one).map((work) => 3 * work.calls),
    );
    assert.equal(three.quote.workload.judgmentBatches, 3 * one.quote.workload.judgmentBatches);
    const judged = revision.privateEvaluator.unscaled.length;
    assert.equal(
      three.quote.workload.criterionOutcomes,
      one.quote.workload.criterionOutcomes + 2 * judged,
    );
    assert.ok(
      Math.abs(checkingCeiling(three.quote) - 3 * checkingCeiling(one.quote)) <
        1e-9 * checkingCeiling(three.quote),
      "The spending limit of the checks covers each sample",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
