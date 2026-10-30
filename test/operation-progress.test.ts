import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { operationProgress } from "../packages/operator/src/operation.js";
import { assertOperationOwnerStopped } from "../packages/operator/src/process-owner.js";
import { savedLifecycle } from "../packages/operator/src/lifecycle.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { projectRun } from "../packages/operator/src/catalog-projection.js";
import { projectJourney } from "../packages/operator/src/journey-progress.js";
import type { JourneyProgress } from "../packages/contracts/src/console.js";
import type { RunOperationStatus, RunStart } from "../packages/contracts/src/execution.js";
import { projectPreparationOutcome } from "../packages/operator/src/preparation-outcome.js";
import { operationView } from "../packages/operator/src/workbench.js";
import { fixtureLaunchDefaults, fixtureSnapshots } from "./shared-api-fixture.js";
import type { AuthoringProgress, EvaluationWorkflow } from "../packages/contracts/src/execution.js";

test("a Studio update cannot be resumed or funded under the old execution identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-progress-studio-update-"));
  const journal = await OperationJournal.open(root);
  try {
    journal.put("run_starts", "run", { stopped: false, error: "Studio requires an update" });
    journal.put("readiness_progress", "run", { state: "failed" });
    journal.put("failure_heads", "run", {
      "readiness:run": {
        causeCode: "studio_update_required",
        unit: { stage: "readiness", id: "run" },
        recoveryActions: ["inspect"],
        explanation: "Complete the Studio update, then start a new run.",
      },
    });
    const lifecycle = await savedLifecycle(root, "run");
    assert.equal(lifecycle.capabilities.resume.allowed, false);
    assert.equal(lifecycle.capabilities.budget.allowed, false);
    assert.equal(lifecycle.capabilities.setup.allowed, true);
    assert.match(lifecycle.capabilities.resume.reason, /start a new run/);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a run without model work offers no higher spending limit, and Resume and Stop still follow the run", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-progress-model-free-"));
  const journal = await OperationJournal.open(root);
  try {
    const progress = (stopped: boolean, builders: number, batches: number) => ({
      finished: false,
      stopped,
      pausedAuthorizationHashes: [],
      providerPauses: [],
      manifest: {
        id: "run",
        protocolKind: null,
        planned: {
          independentBuilderTrials: builders,
          nativeCaptureRepetitions: 1,
          capturePasses: 1,
          nativeRootLaunches: 1,
          nativeClientLaunches: 2,
          startupRecoveryRootLaunches: 0,
          startupRecoveryClientLaunches: 0,
          criterionOutcomes: batches,
          judgmentBatches: batches,
        },
      },
    });
    const spending = { pendingBilling: false, availableUsd: 0, authorizationHash: hashJson("a") };
    journal.put("operation_progress", "replay", progress(true, 0, 0));
    journal.put("spending_progress", "replay", spending);
    const replay = await savedLifecycle(root, "replay");
    assert.equal(replay.capabilities.budget.allowed, false);
    assert.match(replay.capabilities.budget.reason, /sends no model requests/);
    assert.equal(replay.capabilities.resume.allowed, true, "A stopped replay can continue");
    assert.equal(replay.capabilities.stop.allowed, false, "A stopped replay has nothing to stop");
    journal.put("operation_progress", "active-replay", progress(false, 0, 0));
    journal.put("spending_progress", "active-replay", spending);
    assert.equal((await savedLifecycle(root, "active-replay")).capabilities.stop.allowed, true);
    for (const [id, builders, batches] of [
      ["built", 1, 0],
      ["judged", 0, 3],
    ] as const) {
      journal.put("operation_progress", id, progress(true, builders, batches));
      journal.put("spending_progress", id, spending);
      assert.equal(
        (await savedLifecycle(root, id)).capabilities.budget.allowed,
        true,
        `A run with model work (${id}) can get a higher limit`,
      );
    }
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued saved-evaluation run retains its authorized ceiling and skips preparation before execution freezes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-progress-queued-source-"));
  const journal = await OperationJournal.open(root);
  try {
    const id = "queued-source";
    const start: RunStart = {
      operationId: id,
      requestHash: hashJson("request"),
      inputHash: hashJson("source"),
      request: { quoteId: hashJson("quote"), ceilingUsd: 5, idempotencyKey: "replay" },
      state: "queued",
      stopped: false,
      error: null,
    };
    journal.transaction(() => {
      journal.put("run_starts", id, start);
      projectRun(journal, id);
    });
    const queued = await operationView(root, id);
    assert.equal(queued.status.kind, "starting");
    assert.equal(queued.lifecycle.state, "queued");
    assert.equal(queued.lifecycle.phase, "execution");
    assert.equal(queued.ceilingUsd, null);
    assert.deepEqual(queued.spending, { billedUsd: 0, reservedUsd: 0, availableUsd: 5 });
    assert.equal(queued.journey?.stage, "execution");
    assert.equal(queued.journey?.action, "Preparing run");
    assert.equal(queued.journey?.preparationSkipped, true);
    assert.equal(queued.journey?.evaluatedModelStarted, false);
    assert.equal(queued.journey?.completedCaptures, 0);
    journal.transaction(() => {
      journal.put("readiness_progress", id, { state: "checking", at: new Date().toISOString() });
      projectRun(journal, id);
    });
    const readiness = await operationView(root, id);
    assert.equal(readiness.journey?.action, "Checking Studio");
    assert.equal(readiness.journey?.preparationSkipped, true);
    journal.transaction(() => {
      journal.put("readiness_progress", id, { state: "ready", at: new Date().toISOString() });
      journal.put("run_starts", id, { ...start, state: "freezing" });
      projectRun(journal, id);
    });
    assert.equal((await operationView(root, id)).journey?.stage, "execution");
    const ledger = new DurableSpendLedger(root, id, start.inputHash);
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 7 });
    const admitted = await operationView(root, id);
    assert.equal(admitted.ceilingUsd, 7);
    assert.equal(admitted.spending.availableUsd, 7);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capture progress binds timing to the selected evaluation and surfaces recorded failures while other work runs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-capture-progress-"));
  const journal = await OperationJournal.open(root);
  try {
    const plan = (durationMs: number) => ({
      schema: "basalt-evals/studio-plan",
      clients: 1,
      actors: ["player1"],
      roles: [],
      phases: [],
      scenarios: [
        { id: "observe", label: "Observe", durationMs, reportContexts: ["server"], steps: [] },
      ],
    });
    const status = {
      inFlightUnits: [{ stage: "final_capture", unitId: "capture-second" }],
      stopped: false,
      finished: false,
      completedUnits: [],
      manifest: {
        subjects: [{ id: "second-build", evalId: "second", builder: null }],
        evals: [
          { id: "first", views: [{ id: "default", plan: plan(10_000) }] },
          { id: "second", views: [{ id: "default", plan: plan(590_000) }] },
        ],
        captureCells: [
          { id: "capture-second", treatmentId: "second-build", viewId: "default", pass: 2 },
        ],
        planned: { independentBuilderTrials: 2 },
      },
      events: [
        {
          kind: "incomplete",
          stage: "judgment",
          unitId: "prior-check",
          at: "2026-09-29T15:54:00Z",
          reason: "Judgment batch omits authored criteria",
        },
        {
          kind: "started",
          stage: "final_capture",
          unitId: "capture-second",
          at: "2026-09-29T15:55:00Z",
        },
      ],
    } as unknown as RunOperationStatus;
    journal.put("failure_heads", "run", {
      "judgment:prior-check": { explanation: "Provider request failed (http_429)." },
    });
    projectJourney(journal, "run", null, status, null);
    const progress = journal.read<JourneyProgress>("journey_progress", "run")!;
    assert.equal(progress.activity[0]!.observationWindowMs, 590_000);
    assert.equal(progress.activity[0]!.startedAt, "2026-09-29T15:55:00Z");
    assert.equal(progress.activity[0]!.limitMs, 715_000);
    assert.deepEqual(progress.activeStages, ["capture"]);
    assert.equal(progress.stage, "capture");
    assert.equal(progress.recentFailure?.reason, "Provider request failed (http_429).");
    assert.equal(progress.endedAt, null);
    status.completedUnits.push("judgment:prior-check");
    projectJourney(journal, "run", null, status, null);
    assert.equal(journal.read<JourneyProgress>("journey_progress", "run")!.recentFailure, null);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("progress shows each unit in flight when builds, observations and checks overlap", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-concurrent-progress-"));
  const journal = await OperationJournal.open(root);
  try {
    const plan = {
      schema: "basalt-evals/studio-plan",
      clients: 1,
      actors: ["player1"],
      roles: [],
      phases: [],
      scenarios: [
        { id: "observe", label: "Observe", durationMs: 20_000, reportContexts: [], steps: [] },
      ],
    };
    const build = (id: string, model: string) => ({
      id,
      evalId: "evaluation",
      builder: { model: { id: model } },
    });
    const started = (stage: string, unitId: string, at: string) => ({
      kind: "started",
      stage,
      unitId,
      at,
    });
    const status = {
      inFlightUnits: [
        { stage: "judgment", unitId: "images-first" },
        { stage: "judgment", unitId: "text-first" },
        { stage: "builder", unitId: "third" },
        { stage: "final_capture", unitId: "capture-second" },
      ],
      stopped: false,
      finished: false,
      completedUnits: ["builder:first", "final_capture:capture-first", "builder:second"],
      manifest: {
        modelSnapshots: fixtureSnapshots,
        subjects: [
          build("first", "openai/gpt-6-luna"),
          build("second", "deepseek/deepseek-v4.1-flash"),
          build("third", "z-ai/glm-5.3-flash"),
        ],
        evals: [{ id: "evaluation", views: [{ id: "default", plan }] }],
        captureCells: [
          { id: "capture-first", treatmentId: "first", viewId: "default" },
          { id: "capture-second", treatmentId: "second", viewId: "default" },
        ],
        gradingCells: [],
        judgmentBatches: [
          { id: "images-first", captureCellId: "capture-first" },
          { id: "text-first", captureCellId: "capture-first" },
        ],
        planned: { independentBuilderTrials: 3 },
      },
      events: [
        started("judgment", "images-first", "2026-10-03T10:00:00Z"),
        started("judgment", "text-first", "2026-10-03T10:00:01Z"),
        started("builder", "third", "2026-10-03T10:00:02Z"),
        started("final_capture", "capture-second", "2026-10-03T10:00:03Z"),
      ],
    } as unknown as RunOperationStatus;
    projectJourney(journal, "run", null, status, null);
    const progress = journal.read<JourneyProgress>("journey_progress", "run")!;
    assert.equal(progress.stage, "builder", "The earliest stage with work in flight");
    assert.deepEqual(progress.activeStages, ["scoring", "builder", "capture"]);
    assert.equal(progress.action, "Running 1 build, 1 observation and the checks of 1 observation");
    assert.deepEqual(
      progress.activity.map((item) => [item.action, item.startedAt]),
      [
        ["Checking results for GPT-6 Luna", "2026-10-03T10:00:00Z"],
        ["Checking results for GPT-6 Luna", "2026-10-03T10:00:01Z"],
        ["Building with GLM 5.3 Flash", "2026-10-03T10:00:02Z"],
        ["Collecting evidence for DeepSeek 4.1 Flash", "2026-10-03T10:00:03Z"],
      ],
    );
    assert.equal(progress.activity[3]!.observationWindowMs, 20_000);
    assert.equal(progress.completedCandidates, 0, "Only completed build events count");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("between units, progress keeps the reached step and its finished steps", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-idle-progress-"));
  const journal = await OperationJournal.open(root);
  try {
    const event = (kind: string, stage: string, unitId: string) => ({
      kind,
      stage,
      unitId,
      at: "2026-10-05T19:56:00Z",
    });
    const status = (events: unknown[], builds: number) =>
      ({
        inFlightUnits: [],
        stopped: false,
        finished: false,
        completedUnits: [],
        manifest: {
          modelSnapshots: fixtureSnapshots,
          subjects: [],
          evals: [],
          captureCells: [],
          gradingCells: [],
          judgmentBatches: [],
          planned: { independentBuilderTrials: builds },
        },
        events,
      }) as unknown as RunOperationStatus;
    const project = (value: RunOperationStatus) => {
      projectJourney(journal, "run", null, value, null);
      return journal.read<JourneyProgress>("journey_progress", "run")!;
    };
    // Every answer is in and Basalt writes the report: the run stays at Checking results.
    const finishing = project(
      status(
        [
          event("completed", "builder", "first"),
          event("completed", "final_capture", "capture-first"),
          event("started", "judgment", "images-first"),
          event("completed", "judgment", "images-first"),
        ],
        1,
      ),
    );
    assert.equal(finishing.stage, "scoring");
    assert.equal(finishing.action, "Checking results");
    assert.deepEqual(finishing.activeStages, []);
    // Before the first unit starts, the first step that has work is reached.
    const starting = project(status([], 3));
    assert.equal(starting.stage, "builder");
    assert.equal(starting.action, "Building with selected models");
    // A run without model builds starts at Collecting evidence.
    assert.equal(project(status([], 0)).stage, "capture");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed preparation freezes elapsed time and cannot regain Resume or budget controls after Stop", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-progress-failure-"));
  try {
    const id = "preparation-failure",
      draftId = hashJson("draft");
    const ledger = new DurableSpendLedger(root, id, hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 8 });
    const workflow: EvaluationWorkflow = {
      id,
      draftIds: [draftId],
      previewId: hashJson("preview"),
      title: "Moving platform",
      inputHash: hashJson([draftId]),
      authorizationHash: hashJson("authorization"),
      requestHash: hashJson("request"),
      selection: {
        ...fixtureLaunchDefaults,
        sources: [{ kind: "draft", id: draftId }],
        repetitions: 3,
        builderModelIds: ["openai/gpt-6-luna", "openai/gpt-5.6-luna"],
      },
      ceilingUsd: 8,
      phase: "preparation",
      state: "attention",
      blocker: "Generic old message",
      revisions: {},
      createdAt: "2026-09-29T07:53:46.817Z",
      updatedAt: "2026-09-29T07:55:39.567Z",
    };
    const authoring: AuthoringProgress = {
      action: {
        id: hashJson("action"),
        operationId: id,
        draftId,
        quoteId: hashJson("quote"),
        revisionId: null,
        stage: "preparation",
        ceilingUsd: 8,
      },
      state: "completed",
      resultHash: hashJson("result"),
      stopped: false,
      error: null,
    };
    const journal = await OperationJournal.open(root);
    try {
      journal.put("workflows", id, workflow);
      journal.put("authoring_progress", id, authoring);
      projectPreparationOutcome(journal, authoring, {
        schema: "basalt-evals/preparation-receipt",
        validation: {
          status: "preparation_failed",
          diagnostics: [{ message: "/privateEvaluator/studio/phases is missing" }],
        },
      });
      projectRun(journal, id);
      const before = await operationView(root, id);
      assert.equal(before.capabilities.resume.allowed, false);
      assert.equal(before.capabilities.budget.allowed, false);
      assert.equal(before.journey?.endedAt, workflow.updatedAt);
      assert.equal(before.journey?.action, "Preparation stopped");
      assert.deepEqual(before.journey?.activity, []);
      assert.equal(before.journey?.plannedCandidates, 6);
      assert.equal(before.journey?.evaluatedModelStarted, false);
      assert.match(before.interruption!, /couldn’t turn your success criteria into checks/);
      journal.put("workflows", id, {
        ...workflow,
        state: "stopped",
        updatedAt: "2026-09-29T08:30:00.000Z",
      });
      journal.put("authoring_progress", id, { ...authoring, stopped: true });
      projectRun(journal, id);
      const after = await operationView(root, id);
      assert.equal(after.journey?.endedAt, before.journey?.endedAt, "Stop does not add idle time");
      assert.deepEqual(after.journey?.activity, []);
      assert.equal(after.capabilities.resume.allowed, false);
      assert.equal(after.capabilities.budget.allowed, false);
      assert.deepEqual(after.preparationProblem, before.preparationProblem);
      // A gate that only a fixed sample can check needs a person, so the text says what to change.
      projectPreparationOutcome(journal, authoring, {
        schema: "basalt-evals/preparation-receipt",
        validation: {
          status: "preparation_failed",
          diagnostics: [
            {
              code: "gate_fixed_state_sample",
              message: "After 3 corrections, the generated instructions still had this problem",
              stage: 1,
              authoredCriterionId: "criterion-1",
            },
          ],
        },
      });
      assert.match(
        (await operationView(root, id)).preparationProblem!.explanation,
        /^Criterion 1 of stage 1 is a gate, .* happens after an action/u,
      );
      projectPreparationOutcome(journal, authoring, {
        schema: "basalt-evals/preparation-receipt",
        validation: { status: "ready", diagnostics: [] },
      });
      assert.equal(
        (await operationView(root, id)).capabilities.resume.allowed,
        true,
        "a stop after successful compilation may continue from its retained result",
      );
      // A newly authorized input attempt cannot inherit the previous result's blocker.
      journal.put("authoring_progress", id, {
        ...authoring,
        action: { ...authoring.action, id: hashJson("new-action") },
        state: "queued",
        resultHash: null,
      });
      journal.put("workflows", id, { ...workflow, state: "active", blocker: null });
      projectRun(journal, id);
      const next = await operationView(root, id);
      assert.equal(next.preparationProblem, null);
      assert.equal(next.journey?.endedAt, null);
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress reads fixed journal projections independently of historical event or source size", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-progress-"));
  try {
    const ledger = new DurableSpendLedger(root, "progress", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() => {
        journal.put("operation_progress", "progress", {
          manifest: { id: "progress", planned: {} },
          stopped: false,
          inFlightUnits: [],
          finished: false,
          measurementComplete: false,
          criterionOutcomes: [],
          pausedAuthorizationHashes: [],
          providerPauses: [],
        });
        // Neither a frozen manifest file nor a readable history is needed by a poll.
        journal.put("operations", "progress", { deliberatelyUnreadableHistory: true });
        journal.put("drivers", "progress", {
          pid: process.pid,
          active: true,
          token: "owner",
          error: null,
        });
      });
    } finally {
      journal.close();
    }
    for (let poll = 0; poll < 20; poll += 1) {
      const progress = await operationProgress(root, "progress");
      assert.equal(progress.availableUsd, 0.1);
      assert.equal("events" in progress, false);
      assert.equal(progress.pendingBilling, false);
    }
    await assert.rejects(assertOperationOwnerStopped(root, "progress"), /did not stop yet/);
    await ledger.reserve({
      requestId: hashJson("request"),
      requestHash: hashJson("body"),
      stage: "builder",
      maximumUsd: 0.08,
    });
    assert.equal((await operationProgress(root, "progress")).pendingBilling, true);
    const active = await savedLifecycle(root, "progress");
    assert.equal(active.state, "running");
    assert.equal(active.blocker, null, "an owned in-flight request is not an interruption");
    assert.equal(active.capabilities.resume.allowed, false);
    assert.equal(active.capabilities.reconcile.allowed, false);
    const stoppedOwner = await OperationJournal.open(root);
    try {
      stoppedOwner.transaction(() => {
        stoppedOwner.put("drivers", "progress", {
          pid: process.pid,
          active: false,
          token: "owner",
          error: null,
        });
      });
    } finally {
      stoppedOwner.close();
    }
    const interrupted = await savedLifecycle(root, "progress");
    assert.equal(interrupted.state, "blocked");
    assert.match(interrupted.blocker!, /pending charge/);
    assert.equal(interrupted.capabilities.reconcile.allowed, true);
    assert.equal(interrupted.capabilities.resume.allowed, false);
    assert.equal((await operationProgress(root, "progress")).pendingBilling, true);
    await ledger.reconcile(hashJson("request"), 0.025);
    assert.equal((await operationProgress(root, "progress")).availableUsd, 0.07500000000000001);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
