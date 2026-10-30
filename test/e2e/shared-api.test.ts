import { workloadCeiling } from "../../packages/model-client/src/quote.js";
import { readRunQuote } from "../../packages/operator/src/run-quotes.js";
import { readCoverageNotes } from "../../packages/operator/src/coverage-notes.js";
import { preparationPath } from "../../packages/operator/src/operation-binding.js";
import { fixtureLaunchDefaults } from "../shared-api-fixture.js";
import { reviewAvailable } from "./review-http.js";
import {
  answerReviewQuestion,
  claimReviewQuestion,
  reviewActivity,
} from "../../packages/operator/src/review-session.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureInput } from "../shared-api-fixture.js";
import { createSharedApiFixture } from "../shared-api-environment.js";
import { OperationJournal } from "../../packages/artifact-store/src/journal.js";
import { contentHash } from "../../packages/contracts/src/index.js";
import type { OperatorEvidence } from "../../packages/contracts/src/console.js";
import type { ReviewBatch } from "../../packages/contracts/src/review.js";
import type { BuildHistoryPage } from "../../packages/contracts/src/build-history.js";
import type { DatasetBuild } from "../../packages/reporting/src/dataset.js";

test("real HTTP and owned child driver prepare, validate, build, capture, grade and review synthetic evidence", async () => {
  const environment = await createSharedApiFixture();
  const { root, handle } = environment;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = await handle(request);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function request(path: string, action?: string, value?: unknown, expected = 200) {
    const response = await fetch(origin + path, {
      ...(action
        ? {
            method: "POST",
            headers: {
              Origin: origin,
              "X-Basalt-Action": action,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(value ?? {}),
          }
        : {}),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  type DriverOwner = { active: boolean; error: string | null } | null;
  /**
   * Read the progress of a run until `done` accepts it. A loaded machine makes the child driver
   * slow, so only a stall fails: the progress and the driver state stay the same for 120 s.
   */
  async function progressUntil(
    id: string,
    done: (status: { state?: string; finished?: boolean }, owner: DriverOwner) => boolean,
  ) {
    let last = "";
    let changedAt = performance.now();
    for (;;) {
      const status = (await request(`/api/operations/${id}/progress`)).status;
      const journal = await OperationJournal.open(root);
      const owner = journal.read<NonNullable<DriverOwner>>("drivers", id);
      journal.close();
      if (done(status, owner)) return status;
      const current = JSON.stringify([status, owner?.active ?? null, owner?.error ?? null]);
      if (current !== last) {
        last = current;
        changedAt = performance.now();
      } else if (performance.now() - changedAt > 120_000)
        assert.fail(`Synthetic workflow stalled for 120 s at ${current}; fixture ${root}`);
      await delay(200);
    }
  }
  async function settle(id: string) {
    return progressUntil(id, (status, owner) => {
      if (owner && !owner.active && owner.error) assert.fail(owner.error + "; fixture " + root);
      return Boolean(status.finished && owner && !owner.active);
    });
  }
  try {
    const copy = {
      evaluationId: null,
      baseDraftId: null,
      title: "Working copy",
      stages: [
        {
          prompt: fixtureInput.stages[0]!.prompt,
          criteria: fixtureInput.stages[0]!.rubric,
          gateCriterionIds: [],
        },
      ],
      revision: 0,
    };
    const savedCopy = await request(
      "/api/working-copies/editor-session-fixture",
      "save_working_copy",
      copy,
    );
    assert.equal(savedCopy.revision, 1);
    assert.equal(savedCopy.parsed[0].criteria.length, 2);
    await request(
      "/api/working-copies/editor-session-fixture",
      "save_working_copy",
      { ...copy, title: "Stale tab" },
      409,
    );
    assert.equal((await request("/api/working-copies/editor-session-fixture")).title, copy.title);
    assert.equal((await request("/api/review-batches")).total, 0);
    for (const path of [
      "/api/operator",
      "/api/feedback-actions",
      "/api/operations/example/capture",
    ])
      await request(path, "start_eval_run", {}, 404);
    const draft = await request("/api/eval-authoring", "create_eval", fixtureInput, 201);
    assert.equal(
      (await request(`/api/eval-authoring/${draft.id}`)).input.stages[0]!.rubric,
      fixtureInput.stages[0]!.rubric,
    );
    const preview = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "evaluation",
        selection: { ...fixtureLaunchDefaults, sources: [{ kind: "draft", id: draft.id }] },
      },
      201,
    );
    const start = {
      previewId: preview.id,
      ceilingUsd: 5,
      idempotencyKey: "synthetic-idempotency-key",
    };
    const starts = await Promise.all(
      [1, 2].map(() => request("/api/operations", "authorize_operation", start, 202)),
    );
    assert.equal(starts[0].operationId, starts[1].operationId);
    const id = starts[0].operationId;
    assert.deepEqual(await request(`/api/launch-authorizations/${start.idempotencyKey}`), {
      previewId: preview.id,
      ceilingUsd: start.ceilingUsd,
      operationId: id,
    });
    assert.equal(await request("/api/launch-authorizations/unused-launch-identity"), null);
    const done = await settle(id);
    assert.equal(done.finished, true);
    const prepared = JSON.parse(
      await readFile(resolve(root, preparationPath(id, draft.id)), "utf8"),
    ) as {
      revisionId: string;
      stages: Array<{
        revisionId: string;
        coverage: { modelId: string; state: string };
        emptyBuild: { state: string; hollow: string[] };
      }>;
    };
    assert.equal(prepared.stages.length, 1);
    assert.equal(prepared.stages[0]!.revisionId, prepared.revisionId);
    assert.deepEqual(prepared.stages[0]!.coverage, {
      modelId: "xiaomi/mimo-v2.6-flash",
      state: "complete",
    });
    // The synthetic Studio reports a Beacon in the seed, so the required check is hollow.
    assert.deepEqual(prepared.stages[0]!.emptyBuild, {
      state: "complete",
      hollow: ["beacon-exists"],
    });
    const [coverage] = await readCoverageNotes(root, prepared.revisionId);
    assert.deepEqual(
      coverage!.criteria.map((item) => item.coverage),
      Array.from({ length: coverage!.criteria.length }, () => "matches"),
    );
    assert.ok(coverage!.criteria.length > 0);
    assert.deepEqual(
      coverage!.checks.map((item) => [item.checkId, item.support]),
      [
        ["beacon-exists", "supports"],
        ["beacon-blue", "supports"],
      ],
    );
    const benchmark = await request(`/api/benchmarks/${id}`);
    assert.equal(benchmark.rows.length, 1);
    assert.deepEqual(benchmark.rows[0].answers, {
      planned: 6,
      met: 6,
      rejected: 0,
      scored: 0,
      insufficient: 0,
      missing: 0,
      split: 0,
    });
    // One build is fewer than the two builds that a warning for every build needs.
    assert.deepEqual(
      benchmark.planWarnings.map((warning: { criterionId: string; kind: string }) => [
        warning.criterionId,
        warning.kind,
      ]),
      [["beacon-exists", "passes_empty_build"]],
    );
    assert.equal(benchmark.requiredHumanJudgments, 0);
    assert.equal(typeof benchmark.queueWaitMs, "number", "each Studio admission records its wait");
    assert.equal(
      benchmark.rows[0].cases[0].builds.flatMap((build: { marks: unknown[] }) => build.marks)
        .length,
      6,
    );
    // The saved build rule decides this build: every required answer was met.
    assert.deepEqual(benchmark.rows[0].success.macroAttemptSuccess, { lower: 1, upper: 1 });
    assert.ok((await request("/api/benchmarks")).some((row: { id: string }) => row.id === id));
    assert.deepEqual(await request("/api/notifications"), []);
    const savedJournal = await OperationJournal.open(root);
    const state = savedJournal.read<
      import("../../packages/contracts/src/execution.js").RunOperationStatus
    >("operations", id)!;
    const spendingBefore = savedJournal.read("spending", id);
    savedJournal.close();
    const firstBatch = state.manifest.judgmentBatches[0]!;
    const originalFile = resolve(
      root,
      `.basalt-evals/eval-operations/${id}/judgments/${firstBatch.id}.json`,
    );
    const originalBytes = await readFile(originalFile);
    await writeFile(
      originalFile,
      JSON.stringify({ ...JSON.parse(originalBytes.toString()), costUsd: 999 }),
    );
    const corrupt = await request(`/api/benchmarks/${id}`);
    assert.equal(corrupt.rows[0].answers.met, 6 - firstBatch.criterionIds.length);
    assert.equal(corrupt.rows[0].answers.missing, firstBatch.criterionIds.length);
    assert.match(corrupt.issues.join(" "), /hash changed/);
    await writeFile(originalFile, originalBytes);
    assert.equal((await request(`/api/benchmarks/${id}`)).rows[0].answers.met, 6);
    const after = await OperationJournal.open(root);
    assert.deepEqual(after.read("spending", id), spendingBefore);
    after.close();

    const outcomes = await request(`/api/operations/${id}/outcomes`);
    assert.equal(outcomes.outcomes.length, 6);
    assert.equal(outcomes.units.judgment.completed, 3);
    assert.deepEqual(outcomes.issues, []);
    assert.equal((await request("/api/review-batches")).total, 0);
    const reviewed = await reviewAvailable({
      root,
      request,
      operationId: id,
      inspect: (question) => {
        assert.equal(question.evidence.passes.length, 1);
        assert.equal(JSON.stringify(question).includes("openai/gpt"), false);
      },
    });
    assert.equal(reviewed.progress.state, "completed");
    assert.equal(reviewed.progress.answered, 7, "Six questions and one delayed repeat");
    assert.equal(reviewed.progress.session?.number, 1);
    const training = await request(
      "/api/review-batches/preview",
      "preview_review_batch",
      {
        purpose: "training",
        operationIds: [id],
        reviewer: reviewed.batch.reviewer,
        questionLimit: 5,
        unitIds: [],
        treatments: [],
      },
      201,
    );
    assert.equal(training.selectedUnitIds.length, 0, "Training never uses a counted item");
    // A second, independent reviewer answers the same questions in a separate blind batch.
    const secondReviewer = await request(
      "/api/reviewers",
      "create_reviewer",
      { displayName: "Second synthetic reviewer" },
      201,
    );
    const secondBatch = await request(
      `/api/review-batches/${reviewed.batch.id}/second`,
      "create_second_review",
      { reviewer: secondReviewer.id, idempotencyKey: "second-review-key" },
      201,
    );
    await request(
      `/api/review-batches/${reviewed.batch.id}/second`,
      "create_second_review",
      { reviewer: reviewed.batch.reviewer, idempotencyKey: "same-reviewer-key" },
      409,
    );
    const blue = (binding: { criterion: { id: string } }) => binding.criterion.id === "beacon-blue";
    const second = await reviewAvailable({
      root,
      request,
      operationId: id,
      batch: secondBatch,
      inspect: (question) => assert.equal(question.peer, null),
      decide: (_question, binding) => ({
        kind: "categorical",
        value: blue(binding) ? "violated" : "satisfied",
      }),
    });
    assert.equal(second.progress.state, "completed");
    const rounds = await request(
      `/api/review-batches/${reviewed.batch.id}/round-two`,
      "create_round_two",
      { idempotencyKey: "round-two-key" },
      201,
    );
    assert.deepEqual(
      rounds.map((round: { assigned: number }) => round.assigned),
      [3, 3],
      "Round 2 asks only the three questions with different answers",
    );
    const passes = new Map<string, number>();
    for (const round of rounds)
      await reviewAvailable({
        root,
        request,
        operationId: id,
        batch: round,
        inspect: (question) => {
          // Each reviewer sees only the other answer and reason, never a judge answer.
          assert.ok(question.peer);
          assert.equal(question.peer.reason.code, "other");
          assert.equal(JSON.stringify(question).includes("automatic"), false);
        },
        decide: (_question, binding) => {
          if (round.reviewer === secondReviewer.id)
            return { kind: "categorical", value: "violated" };
          passes.set(binding.pass.id, passes.get(binding.pass.id) ?? passes.size);
          // The first reviewer changes one answer and keeps two.
          return {
            kind: "categorical",
            value: passes.get(binding.pass.id) === 0 ? "violated" : "satisfied",
          };
        },
      });
    const report = await request(`/api/review-batches/${reviewed.batch.id}/report`);
    assert.equal(report.experts.items, 6);
    assert.deepEqual(
      report.experts.agreements.map(
        (item: { pair: string; acceptance: { numerator: number; denominator: number } }) => [
          item.pair,
          item.acceptance.numerator,
          item.acceptance.denominator,
        ],
      ),
      [
        ["judge_first", 6, 6],
        ["judge_second", 3, 6],
        ["first_second", 3, 6],
      ],
    );
    assert.deepEqual(
      report.experts.strata.map((item: { stratum: string; units: number }) => [
        item.stratum,
        item.units,
      ]),
      [
        ["agreed", 3],
        ["disagreed", 3],
      ],
    );
    assert.deepEqual(
      report.experts.disagreements.map((item: { status: string }) => item.status).sort(),
      ["contested", "contested", "resolved"],
    );
    assert.equal(report.experts.contested.length, 2);
    assert.equal(report.repeats.pairs.length, 1);
    assert.equal(report.repeats.agreement.numerator, 1);
    assert.equal(report.gate.metric, "candidate_acceptance_agreement");
    assert.equal(report.gate.state, "not_met");
    assert.ok(report.gate.judgeFirst.interval.lower < 1, "The exact lower bound stays reported");
    const diagnosticReviewer = await request(
      "/api/reviewers",
      "create_reviewer",
      { displayName: "Diagnostic reviewer" },
      201,
    );
    const routed = await request(
      "/api/review-batches/preview",
      "preview_review_batch",
      {
        purpose: "diagnostic",
        operationIds: [id],
        reviewer: diagnosticReviewer.id,
        questionLimit: 40,
        unitIds: [],
        treatments: [],
      },
      201,
    );
    assert.equal(
      routed.selectedUnitIds.length,
      6,
      "Visible candidate text routes met answers to optional review without a verdict",
    );
    // A session ends at 20 active minutes. The reviewer continues in a new session.
    const timed = await request(
      "/api/review-batches/create",
      "create_review_batch",
      { previewId: routed.id, idempotencyKey: "timed-session-key" },
      201,
    );
    const tab = "timed-session-tab";
    const clock = Date.parse("2026-10-02T12:00:00.000Z");
    const opened = await claimReviewQuestion(
      root,
      timed.id,
      timed.nextAssignmentId,
      tab,
      diagnosticReviewer.id,
      clock,
    );
    // test/review-session.test.ts counts the active time tick by tick to the limit. Here the
    // session starts 30 seconds before its limit: one tick opens the tab, the next one counts.
    const records = await OperationJournal.open(root);
    try {
      const batch = records.read<ReviewBatch>("review_batches", timed.id)!;
      batch.sessions.at(-1)!.activeMs = 20 * 60_000 - 30_000;
      records.put("review_batches", timed.id, batch);
    } finally {
      records.close();
    }
    for (let tick = 1; tick <= 2; tick++)
      await reviewActivity(
        root,
        timed.id,
        {
          reviewer: diagnosticReviewer.id,
          sessionId: tab,
          sequence: tick,
          visible: true,
          focused: true,
        },
        clock + tick * 30_000,
      );
    const limited = await request(`/api/reviews/${timed.id}?reviewer=${diagnosticReviewer.id}`);
    assert.equal(limited.session.state, "time_limit");
    assert.equal(limited.session.activeMs, 20 * 60_000);
    // At the limit the current answer still saves, but no new question opens.
    await answerReviewQuestion(
      root,
      timed.id,
      opened.id,
      {
        reviewer: diagnosticReviewer.id,
        sessionId: tab,
        revision: opened.draft.revision,
        decision: { kind: "abstain" },
        reason: { code: "evidence_unclear", sentence: "The frames are too dark to judge." },
        blindingIssue: null,
      },
      clock + 42 * 30_000,
    );
    const next = (await request(`/api/reviews/${timed.id}?reviewer=${diagnosticReviewer.id}`))
      .nextAssignmentId;
    await assert.rejects(
      claimReviewQuestion(root, timed.id, next, tab, diagnosticReviewer.id, clock + 43 * 30_000),
      /Start a new session/,
    );
    const resumed = await request(`/api/reviews/${timed.id}/sessions`, "start_review_session", {
      reviewer: diagnosticReviewer.id,
    });
    assert.deepEqual(
      [resumed.session.number, resumed.session.state, resumed.answered],
      [2, "open", 1],
    );
    await claimReviewQuestion(
      root,
      timed.id,
      next,
      tab,
      diagnosticReviewer.id,
      clock + 44 * 30_000,
    );
    await assert.rejects(
      claimReviewQuestion(
        root,
        timed.id,
        resumed.questions.at(-1).id,
        tab,
        diagnosticReviewer.id,
        clock + 45 * 30_000,
      ),
      /in their order/,
    );
    const ended = await request(`/api/reviews/${timed.id}/end`, "end_review_session", {
      reviewer: diagnosticReviewer.id,
    });
    assert.deepEqual([ended.session.state, ended.state], ["ended", "active"]);
    const calls = (await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const builders = calls.filter(
      (call) =>
        call.kind === "model" &&
        call.request.tools.some((tool: { name: string }) => tool.name === "workspace.finish"),
    );
    assert.equal(
      builders.length,
      4,
      "Production inspects and edits source, then uses public development and finishes",
    );
    for (const builder of builders)
      assert.equal(JSON.stringify(builder).includes(fixtureInput.stages[0]!.rubric), false);
    const finalJudgments = calls.filter(
      (call) =>
        call.kind === "model" &&
        call.request.tools.some((tool: { name: string }) => tool.name === "submit_judgment_batch"),
    );
    assert.equal(finalJudgments.length, 3);
    for (const call of finalJudgments) {
      // The judge sees evidence and sealed source, never the builder's own claims.
      assert.equal(JSON.stringify(call).includes("Synthetic builder completion."), false);
      assert.deepEqual(call.request.sampling, {
        temperature: 1,
        top_p: 0.95,
        top_k: null,
        frequency_penalty: null,
        presence_penalty: null,
        repetition_penalty: null,
      });
      for (const [index, image] of (call.request.messages[0].images ?? []).entries())
        assert.ok(image.label.startsWith(`Image ${index + 1}: frame-`), image.label);
      const payload = JSON.parse(call.request.messages[0].content).buildOutput;
      const material = payload.criterionEvidence.find(
        (item: { criterionId: string }) => item.criterionId === "beacon-blue",
      );
      const observation = payload.signedObservations.find(
        (item: { ref: string }) => item.ref === material.observations[0],
      );
      assert.deepEqual(observation.binding, { phaseId: "scene", factId: "beacon" });
      assert.equal(observation.observation.className, "Part");
      assert.equal(observation.observation.exists, true);
      assert.ok(material.sources.length > 0, "Combined judgment receives sealed source");
      for (const path of material.sources) {
        const source = payload.sealedSources.find((item: { path: string }) => item.path === path);
        assert.equal(source.hash, contentHash(Buffer.from(source.text)));
      }
    }
    assert.equal(
      calls.filter((call) => call.kind === "native").length,
      6,
      "One canary, one empty build, one public development, three final captures",
    );
    const finalCapture = calls.find(
      (call) => call.kind === "native" && call.directory.includes("/capture/"),
    );
    const evidenceFile = resolve(root, finalCapture.directory, "evidence.json"),
      originalEvidence = await readFile(evidenceFile);
    await writeFile(evidenceFile, Buffer.concat([originalEvidence, Buffer.from("\n")]));
    const tampered = await request(`/api/operations/${id}/outcomes`, undefined, undefined, 400);
    assert.match(JSON.stringify(tampered), /hash|bytes|artifact|receipt|oversized worker file/i);
    await writeFile(evidenceFile, originalEvidence);
    assert.equal((await request(`/api/operations/${id}/outcomes`)).outcomes.length, 6);
    await request("/api/operations", "authorize_operation", start, 202);
    assert.equal(
      (await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
        .trim()
        .split("\n").length,
      calls.length,
    );
    const journal = await OperationJournal.open(root);
    const frozen = journal.read<{ manifest: { subjects: Array<{ id: string }> } }>(
      "operations",
      id,
    )!;
    journal.close();
    const subjectId = frozen.manifest.subjects[0]!.id;
    // The build history reads the final checkpoint, the seed and the ledger of the build.
    const built: BuildHistoryPage = await request(
      `/api/operations/${id}/build?candidate=${subjectId}`,
    );
    assert.equal(built.finished, true);
    assert.equal(built.sealedMatch, true);
    assert.deepEqual(built.notices, []);
    assert.ok(built.turns.every((turn) => turn.verified && turn.requestId !== null));
    assert.deepEqual(
      built.turns
        .flatMap((turn) => turn.toolCalls.flatMap((call) => (call.change ? [call.change] : [])))
        .map((change) => [change.kind, change.verified, change.added]),
      [["created", true, 1]],
    );
    // The page names each frame by its hash. The image route serves the bytes of the frame.
    const frames = built.turns.flatMap((turn) => turn.toolCalls.flatMap((call) => call.images));
    assert.ok(frames.length > 0, "The build saw the frames of its development run");
    assert.ok(frames.every((image) => image.mediaType !== null && !("dataBase64" in image)));
    const frame = await fetch(
      `${origin}/api/operations/${id}/build-image?candidate=${subjectId}&hash=${frames[0]!.hash}`,
    );
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), frames[0]!.mediaType);
    assert.equal(contentHash(Buffer.from(await frame.arrayBuffer())), frames[0]!.hash);
    const exported = await fetch(`${origin}/api/operations/${id}/export?scope=public`);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/x-tar");
    const archive = Buffer.from(await exported.arrayBuffer()).toString("latin1");
    assert.ok(archive.includes(`atif/${subjectId}/agent/trajectory.json`));
    assert.ok(archive.includes('"schema_version": "ATIF-v1.7"'));
    assert.ok(archive.includes("manifest.json"));
    assert.equal(archive.includes("beacon-blue"), false, "A public export has no criterion IDs");
    // The dataset export has one JSONL line for each build, with the sealed code of the build.
    const dataset = await fetch(`${origin}/api/operations/${id}/dataset?scope=public`);
    assert.equal(dataset.status, 200);
    const datasetTar = Buffer.from(await dataset.arrayBuffer());
    assert.equal(
      datasetTar.includes("beacon-blue"),
      false,
      "A public dataset has no criterion IDs",
    );
    const lineStart = datasetTar.indexOf('{"answers":');
    const line = JSON.parse(
      datasetTar.subarray(lineStart, datasetTar.indexOf("\n", lineStart)).toString("utf8"),
    ) as DatasetBuild;
    assert.equal(line.schema, "basalt-evals/dataset-build");
    assert.equal(line.subjectId, subjectId);
    assert.equal(line.delivered, true);
    assert.equal(line.stopReason, "finished");
    assert.equal(line.trajectory, `atif/${subjectId}/agent/trajectory.json`);
    assert.ok(line.prompt.length > 0 && line.answers.length > 0);
    assert.ok(line.source?.some((file) => /\.luau?$/u.test(file.path)));
    assert.ok(line.source?.every((file) => file.sha256 === contentHash(file.content)));
    // The fixture has no tool pins, so the build has no stored analysis. That is not zero.
    assert.deepEqual(line.lint, { status: "absent", counts: null });
    assert.equal(line.buildErrors, null);
    const refused = await request(
      "/api/regressions",
      "save_regression",
      {
        title: "Blue beacon",
        purpose: "grader",
        operationId: id,
        subjectId,
        criterionIds: ["beacon-blue"],
      },
      400,
    );
    assert.match(refused.error, /only development observations/);
    const generation = await request(
      "/api/regressions",
      "save_regression",
      {
        title: "Beacon exists",
        purpose: "generation",
        operationId: id,
        subjectId,
        criterionIds: ["beacon-exists"],
      },
      201,
    );
    assert.equal(generation.withheldCaptureIds.length, 3);
    const holdout = await request(`/api/regressions/holdouts/${generation.evaluationId}`);
    assert.deepEqual(
      holdout.looks.map((look: { purpose: string; recordId: string; captureIds: string[] }) => [
        look.purpose,
        look.recordId,
        look.captureIds,
      ]),
      [["generation_regression", generation.id, generation.withheldCaptureIds]],
    );
    const replay = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "replay",
        selection: { operationId: id, subjectId: frozen.manifest.subjects[0]!.id, passes: 2 },
      },
      201,
    );
    assert.equal(workloadCeiling(replay.quote), 0);
    assert.equal(replay.quote.workload.modelWork.length, 0);
    await writeFile(
      resolve(root, ".basalt-evals/synthetic-connector.json"),
      JSON.stringify({ artifactHash: "a".repeat(64) }),
    );
    const beforeMismatch = await readFile(
      resolve(root, ".basalt-evals/synthetic-calls.jsonl"),
      "utf8",
    );
    const replayStart = await request(
      "/api/operations",
      "authorize_operation",
      { previewId: replay.id, ceilingUsd: 0, idempotencyKey: "saved-source-replay" },
      202,
    );
    const blocked = await progressUntil(
      replayStart.operationId,
      (status, owner) => status.state === "incomplete" && Boolean(owner && !owner.active),
    );
    assert.equal(blocked.state, "incomplete");
    assert.match(
      blocked.error,
      /Studio, the Basalt connector or the Studio lane count changed after the preview/,
    );
    assert.equal(
      await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"),
      beforeMismatch,
      "Connector mismatch must prevent model and native dispatch",
    );
    await rm(resolve(root, ".basalt-evals/synthetic-connector.json"));
    await request(`/api/operations/${replayStart.operationId}/commands`, "command_operation", {
      kind: "resume",
    });
    const replayDone = await settle(replayStart.operationId);
    assert.equal(replayDone.measurementComplete, false);
    const replayRows = await request(`/api/results?q=${replayStart.operationId}`);
    assert.equal(replayRows.items.length, 1);
    assert.equal(
      replayRows.items[0].kind,
      "retained",
      "new captures do not become an independent build",
    );
    const afterReplay = (
      await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      afterReplay.filter((call) => call.kind === "model").length,
      calls.filter((call) => call.kind === "model").length,
    );
    assert.equal(afterReplay.filter((call) => call.kind === "native").length, 8);
    const repair = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "repair",
        selection: {
          operationId: id,
          subjectId: frozen.manifest.subjects[0]!.id,
          modelId: "openai/gpt-6-luna",
          gradingModelId: "xiaomi/mimo-v2.6-flash",
          attempts: 1,
          passes: 3,
          publicFeedbackId: null,
        },
      },
      201,
    );
    await writeFile(
      resolve(root, ".basalt-evals/synthetic-failure.json"),
      JSON.stringify({ kind: "malformed_batch" }),
    );
    const repairStart = await request(
      "/api/operations",
      "authorize_operation",
      {
        previewId: repair.id,
        ceilingUsd: workloadCeiling(repair.quote),
        idempotencyKey: "saved-source-repair",
      },
      202,
    );
    const repairDone = await settle(repairStart.operationId);
    assert.equal(repairDone.answers.planned, 6);
    assert.equal(repairDone.answers.unavailable, 1, "The failed judgment has no answer");
    assert.equal(repairDone.manifest.planned.criterionOutcomes, 6);
    assert.equal(repairDone.pendingBilling, false);
    const repairInspection = await request(`/api/operations/${repairStart.operationId}/outcomes`);
    assert.deepEqual(repairInspection.units.judgment, {
      intended: 3,
      attempted: 3,
      completed: 2,
      failed: 0,
      incomplete: 1,
      notReached: 0,
      unattempted: 0,
    });
    assert.equal(repairInspection.issues.length, 1);
    assert.match(
      repairInspection.issues[0].reason,
      /The judge did not give exactly one answer for each criterion/,
    );
    assert.equal(repairInspection.issues[0].stage, "judgment");
    const repairJournal = await OperationJournal.open(root);
    const repairFrozen = repairJournal.read<{
      manifest: { subjects: Array<{ id: string; kind: string; parentSourceId: string }> };
    }>("operations", repairStart.operationId)!;
    repairJournal.close();
    const repairEvidence: OperatorEvidence = await request(
      `/api/operations/${repairStart.operationId}/evidence?candidate=${repairFrozen.manifest.subjects[0]!.id}`,
    );
    const repairCells = repairEvidence.candidates[0]!.cells;
    const missingChecks = repairCells.filter((cell) => cell.outcome === "missing");
    assert.equal(missingChecks.length, 1);
    assert.match(
      missingChecks[0]!.explanation!,
      /The judge did not give exactly one answer for each criterion/,
    );
    assert.ok(
      repairCells
        .filter((cell) => cell.outcome !== "missing")
        .every(
          (cell) =>
            !cell.explanation?.includes(
              "The judge did not give exactly one answer for each criterion",
            ),
        ),
      "A failed check explains only its own missing outcome, not other observations",
    );
    assert.equal(repairFrozen.manifest.subjects[0]!.kind, "repair");
    // A repair starts from its parent source, so its change replaces the parent file.
    const repaired: BuildHistoryPage = await request(
      `/api/operations/${repairStart.operationId}/build?candidate=${repairFrozen.manifest.subjects[0]!.id}`,
    );
    assert.equal(repaired.sealedMatch, true);
    assert.deepEqual(
      repaired.turns
        .flatMap((turn) => turn.toolCalls.flatMap((call) => (call.change ? [call.change] : [])))
        .map((change) => [change.kind, change.verified]),
      [["replaced", true]],
    );
    assert.equal(
      repairFrozen.manifest.subjects[0]!.parentSourceId,
      (
        (await readRunQuote(
          root,
          repair.binding.id,
        )) as import("../../packages/contracts/src/execution.js").SavedEvalRunQuote
      ).selection.parentSourceId,
    );
    const afterRepair = (
      await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const repairCalls = afterRepair
      .slice(afterReplay.length)
      .filter(
        (call) =>
          call.kind === "model" &&
          call.request.tools.some((tool: { name: string }) => tool.name === "workspace.finish"),
      );
    assert.equal(repairCalls.length, 4);
    assert.equal(
      afterRepair
        .slice(afterReplay.length)
        .filter(
          (call) =>
            call.kind === "model" && call.request.tools[0]?.name === "submit_judgment_batch",
        ).length,
      5,
      "A malformed billed judgment is retried at most twice as distinct paid requests",
    );
    const parentListing = repairCalls[1].request.messages.find(
      (message: { role: string }) => message.role === "tool",
    );
    assert.ok(
      JSON.parse(parentListing.content).files.some(
        (file: { path: string }) => file.path === "src/server/BuilderMarker.server.luau",
      ),
      "Repair starts from the modified parent, not the neutral seed",
    );
    for (const call of repairCalls)
      assert.equal(JSON.stringify(call).includes(fixtureInput.stages[0]!.rubric), false);
    assert.equal(afterRepair.filter((call) => call.kind === "native").length, 12);
    await request(
      `/api/operations/${id}/public-feedback`,
      "register_public_feedback",
      { subjectId: frozen.manifest.subjects[0]!.id },
      400,
    );
    const publicQuote = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "public_development",
        selection: { operationId: id, subjectId: frozen.manifest.subjects[0]!.id, passes: 1 },
      },
      201,
    );
    assert.equal(workloadCeiling(publicQuote.quote), 0);
    assert.equal(publicQuote.quote.workload.modelWork.length, 0);
    await writeFile(resolve(root, ".basalt-evals/synthetic-large-images"), "");
    const publicStart = await request(
      "/api/operations",
      "authorize_operation",
      { previewId: publicQuote.id, ceilingUsd: 0, idempotencyKey: "parent-public-acquisition" },
      202,
    );
    await settle(publicStart.operationId);
    await rm(resolve(root, ".basalt-evals/synthetic-large-images"));
    const publicJournal = await OperationJournal.open(root);
    const publicFrozen = publicJournal.read<{ manifest: { subjects: Array<{ id: string }> } }>(
      "operations",
      publicStart.operationId,
    )!;
    publicJournal.close();
    const feedback = await request(
      `/api/operations/${publicStart.operationId}/public-feedback`,
      "register_public_feedback",
      { subjectId: publicFrozen.manifest.subjects[0]!.id },
      201,
    );
    const assisted = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "repair",
        selection: {
          operationId: id,
          subjectId: frozen.manifest.subjects[0]!.id,
          modelId: "openai/gpt-6-luna",
          gradingModelId: "xiaomi/mimo-v2.6-flash",
          attempts: 1,
          passes: 1,
          publicFeedbackId: feedback.id,
        },
      },
      201,
    );
    assert.equal(
      (
        (await readRunQuote(
          root,
          assisted.binding.id,
        )) as import("../../packages/contracts/src/execution.js").SavedEvalRunQuote
      ).selection.publicFeedbackId,
      feedback.id,
    );
    assert.ok(
      assisted.quote.workload.modelWork.find((work: { stage: string }) => work.stage === "builder")
        .upper.images > 0,
    );
    const assistedStart = await request(
      "/api/operations",
      "authorize_operation",
      {
        previewId: assisted.id,
        ceilingUsd: workloadCeiling(assisted.quote),
        idempotencyKey: "public-report-assisted-repair",
      },
      202,
    );
    await settle(assistedStart.operationId);
    const afterAssistance = (
      await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistedCalls = afterAssistance
      .slice(afterRepair.length)
      .filter(
        (call) =>
          call.kind === "model" &&
          call.request.tools.some((tool: { name: string }) => tool.name === "workspace.finish"),
      );
    assert.equal(assistedCalls.length, 4);
    assert.ok(
      assistedCalls[0].request.messages.some(
        (message: { images?: Array<{ dataBase64: string }> }) =>
          message.images?.some(
            (image) => Buffer.from(image.dataBase64, "base64").length > 2 * 1024 * 1024,
          ),
      ),
      "Repair receives the full original development images above 2 MiB",
    );
    assert.ok(JSON.stringify(assistedCalls[0]).includes("public-repair-context"));
    // The image route refuses an image that is not a development frame of the build.
    const assistedJournal = await OperationJournal.open(root);
    const assistedSubject = assistedJournal.read<{ manifest: { subjects: Array<{ id: string }> } }>(
      "operations",
      assistedStart.operationId,
    )!.manifest.subjects[0]!.id;
    assistedJournal.close();
    const assistedBase = `/api/operations/${assistedStart.operationId}/build`;
    const assistedPage: BuildHistoryPage = await request(
      `${assistedBase}?candidate=${assistedSubject}`,
    );
    const ownFrames = new Set(
      assistedPage.turns.flatMap((turn) =>
        turn.toolCalls.flatMap((call) => call.images.map((image) => image.hash)),
      ),
    );
    // The builder saw the frames of the parent build in its context, but they are not frames of
    // its own development runs.
    const contextImage = (
      JSON.parse(assistedPage.context!.text) as { frames: Array<{ hash: string }> }
    ).frames
      .map((frame) => frame.hash)
      .find((hash) => !ownFrames.has(hash));
    assert.ok(contextImage, "The repair context names a frame of the parent build");
    for (const hash of [contextImage, "0".repeat(64), "not-a-hash"]) {
      const refusal = await request(
        `${assistedBase}-image?candidate=${assistedSubject}&hash=${hash}`,
        undefined,
        undefined,
        400,
      );
      assert.match(refusal.error, /no development frame with this hash|Invalid image hash/u);
    }
    for (const call of assistedCalls)
      assert.equal(JSON.stringify(call).includes(fixtureInput.stages[0]!.rubric), false);
    assert.equal(afterAssistance.filter((call) => call.kind === "native").length, 15);
    // A person chooses a development observation of the repair build as the anchor build.
    const anchorQuote = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "public_development",
        selection: {
          operationId: repairStart.operationId,
          subjectId: repairFrozen.manifest.subjects[0]!.id,
          passes: 1,
        },
      },
      201,
    );
    const anchorStart = await request(
      "/api/operations",
      "authorize_operation",
      { previewId: anchorQuote.id, ceilingUsd: 0, idempotencyKey: "anchor-public-acquisition" },
      202,
    );
    await settle(anchorStart.operationId);
    type FrozenCells = {
      manifest: { subjects: Array<{ id: string }>; captureCells: Array<{ id: string }> };
    };
    const cellJournal = await OperationJournal.open(root);
    const anchorFrozen = cellJournal.read<FrozenCells>("operations", anchorStart.operationId)!;
    const candidateFrozen = cellJournal.read<FrozenCells>("operations", publicStart.operationId)!;
    cellJournal.close();
    const choice = await request(
      "/api/exemplars",
      "choose_exemplars",
      {
        evaluationId: generation.evaluationId,
        criterionId: "beacon-blue",
        exemplars: [
          {
            operationId: anchorStart.operationId,
            subjectId: anchorFrozen.manifest.subjects[0]!.id,
            captureId: anchorFrozen.manifest.captureCells[0]!.id,
          },
        ],
        reviewerId: secondReviewer.id,
        reason: "The smallest blue beacon that meets the criterion.",
      },
      201,
    );
    assert.equal(choice.exemplars[0].builderModelId, "openai/gpt-6-luna");
    const choices = await request(`/api/exemplars/${generation.evaluationId}`);
    assert.equal(
      choices.criteria.find((item: { criterionId: string }) => item.criterionId === "beacon-blue")
        .choice.id,
      choice.id,
    );
    const pairSelection = {
      operationId: publicStart.operationId,
      subjectId: candidateFrozen.manifest.subjects[0]!.id,
      modelId: "z-ai/glm-5.3-flash",
      criterionIds: ["beacon-blue"],
      analysisPlanId: null,
    };
    // Without a pinned analysis plan, withheld observations stay closed.
    const withheldPairs = await request(
      "/api/launch-previews",
      "preview_launch",
      {
        kind: "exemplar_comparison",
        selection: { ...pairSelection, operationId: id, subjectId },
      },
      400,
    );
    assert.match(withheldPairs.error, /registered analysis plan/);
    const pairs = await request(
      "/api/launch-previews",
      "preview_launch",
      { kind: "exemplar_comparison", selection: pairSelection },
      201,
    );
    assert.equal(pairs.binding.kind, "exemplar_comparison");
    assert.equal(pairs.comparison.units.length, 1);
    assert.equal(pairs.comparison.calls, 2);
    assert.deepEqual(pairs.comparison.units[0].candidate.unavailable, []);
    assert.deepEqual(pairs.comparison.units[0].exemplarEvidence.unavailable, []);
    assert.ok(workloadCeiling(pairs.quote) > 0);
    const pairAuthorization = {
      previewId: pairs.id,
      ceilingUsd: workloadCeiling(pairs.quote),
      idempotencyKey: "anchor-build-pairs",
    };
    const pairStart = await request(
      "/api/operations",
      "authorize_operation",
      pairAuthorization,
      202,
    );
    const pairDone = await settle(pairStart.operationId);
    assert.equal(pairDone.kind, "comparison");
    assert.equal(pairDone.completed, 1);
    assert.equal(pairDone.incomplete, 0);
    const pairReport = await request(`/api/operations/${pairStart.operationId}/comparison`);
    assert.deepEqual(
      pairReport.results[0].result.answers.map((answer: { order: string; preference: string }) => [
        answer.order,
        answer.preference,
      ]),
      [
        ["candidate_first", "candidate"],
        ["exemplar_first", "candidate"],
      ],
    );
    assert.equal(pairReport.results[0].result.outcome, "win");
    assert.deepEqual(
      pairReport.verdicts.map((item: { verdict: string }) => item.verdict),
      ["satisfied"],
    );
    assert.equal(pairReport.spending.pendingBilling, false);
    const afterPairs = (
      await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .slice(afterAssistance.length)
      .filter((call) => call.kind === "model");
    assert.deepEqual(
      afterPairs.map((call) => call.request.tools[0].name),
      ["submit_build_comparison", "submit_build_comparison"],
      "Each order of the one pair is one paid request",
    );
    assert.equal(
      (await request("/api/operations", "authorize_operation", pairAuthorization, 202)).operationId,
      pairStart.operationId,
    );
    const pairHoldout = await request(`/api/regressions/holdouts/${generation.evaluationId}`);
    assert.equal(
      pairHoldout.looks.some((look: { purpose: string }) => look.purpose === "exemplar_comparison"),
      false,
      "A comparison of development observations is not a look at the holdout",
    );

    // Archive and delete use explicit actions. Saved work that uses a run keeps the run.
    const used = await request(`/api/operations/${id}/delete`, "delete_run", {}, 409);
    assert.match(
      used.error,
      new RegExp(`Other saved work uses this run: .*${replayStart.operationId}`),
    );
    assert.match(used.error, /Delete the runs in this list first/);
    const pairId = pairStart.operationId;
    const listedRuns = async (query = "") =>
      (await request(`/api/runs?limit=50${query}`)).items.map((row: { id: string }) => row.id);
    assert.ok((await listedRuns()).includes(pairId));
    assert.equal(
      (await request(`/api/operations/${pairId}/archive`, "archive_run", { archived: true }))
        .archived,
      true,
    );
    assert.ok(!(await listedRuns()).includes(pairId));
    assert.deepEqual(await listedRuns("&status=archived"), [pairId]);
    assert.equal(
      (await request(`/api/operations/${pairId}/progress`)).lifecycle.capabilities.resume.allowed,
      false,
    );
    await request(`/api/operations/${pairId}/archive`, "archive_run", { archived: false });
    assert.ok((await listedRuns()).includes(pairId));
    const deletedPair = await request(`/api/operations/${pairId}/delete`, "delete_run", {});
    assert.deepEqual(deletedPair.files, []);
    assert.ok(!(await listedRuns()).includes(pairId));
    await request(`/api/operations/${pairId}/progress`, undefined, undefined, 400);
    const deletedRuns = await request("/api/deleted-runs");
    assert.deepEqual(
      deletedRuns.items.map((item: { operationId: string }) => item.operationId),
      [pairId],
    );
    assert.equal(deletedRuns.billedUsd, deletedPair.billedUsd);
    const replayed = await request(
      "/api/operations",
      "authorize_operation",
      pairAuthorization,
      400,
    );
    assert.match(replayed.error, /deleted the run of this start request/);
    const published = await request(
      "/api/working-copies/editor-session-fixture/publish",
      "save_evaluation",
      { revision: savedCopy.revision },
      201,
    );
    const evaluationId = published.evaluation.id;
    await request(`/api/evaluations/${evaluationId}/delete`, "delete_evaluation", {});
    assert.equal(await request(`/api/evaluations/${evaluationId}`), null);
    assert.equal(await request("/api/working-copies/editor-session-fixture"), null);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await environment.dispose();
  }
});
