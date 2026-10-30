import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type {
  EvaluationSummary,
  ResultSummary,
  RunSummary,
} from "../packages/contracts/src/catalog.js";
import { createOperationApi } from "../packages/operator/src/api.js";
import {
  createReviewSelection,
  readReviewSelection,
} from "../packages/operator/src/review-selections.js";
import { projectRun } from "../packages/operator/src/catalog-projection.js";
import { projectOperationProgress } from "../packages/operator/src/operation.js";
import { runCatalog } from "../packages/operator/src/discovery.js";

import type { FailureRecord } from "../packages/contracts/src/failure.js";
import { lineageSpending } from "../packages/operator/src/lineage.js";
import { RecordRepository } from "../packages/artifact-store/src/records.js";
import { decodeAssessmentProgress } from "../packages/contracts/src/assessments.js";

function projectTestOperation(journal: OperationJournal, id: string) {
  projectOperationProgress(journal, journal.read<RunOperationStatus>("operations", id)!);
  projectRun(journal, id);
}

test("lineage deduplicates shared ancestors and typed records reject corrupt counters", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-lineage-"));
  const journal = await OperationJournal.open(root);
  try {
    for (const [id, parents] of [
      ["root", []],
      ["left", ["root"]],
      ["right", ["root"]],
      ["final", ["left", "right"]],
    ] as const) {
      journal.put("operation_context", id, { parentOperationIds: parents });
      journal.put("spending_progress", id, { billedUsd: 2, reservedUsd: 1 });
    }
    const spending = lineageSpending(journal, "final");
    assert.equal(spending.operations.length, 4);
    assert.equal(spending.billedUsd, 8);
    assert.equal(spending.reservedUsd, 4);
    journal.put("operation_context", "root", { parentOperationIds: ["final"] });
    assert.throws(() => lineageSpending(journal, "final"), /cycle/);
    const repo = new RecordRepository(journal, "assessment_progress", decodeAssessmentProgress);
    const value = {
      operationId: "assessment",
      previewId: "a".repeat(64),
      sourceOperationId: "source",
      subjectIds: ["subject"],
      title: "Retained evidence",
      startedAt: "2026-09-25T12:00:00.000Z",
      planned: 3,
      completed: 0,
      incomplete: 0,
      inFlight: null,
      finished: false,
      stopped: false,
      error: null,
    };
    repo.put(value.operationId, value);
    assert.deepEqual(repo.require(value.operationId), value);
    assert.throws(() => repo.put(value.operationId, { ...value, completed: 4 }), /progress record/);
    journal.put("assessment_progress", value.operationId, { ...value, finished: true });
    assert.throws(() => repo.require(value.operationId), /progress record/);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("1,000 evaluations and 15,000 planned decisions remain paginated; inspection assigns no review work", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-catalog-scale-"));
  try {
    const journal = await OperationJournal.open(root);
    journal.transaction(() => {
      for (let n = 0; n < 1000; n++) {
        const id = hashJson({ evaluation: n }),
          title = `Mechanic ${String(n).padStart(4, "0")}`;
        const evaluation: EvaluationSummary = {
          id,
          evaluationId: `eval-${id.slice(0, 32)}`,
          archived: false,
          kind: "evaluation",
          draftId: id,
          title,
          description: "Synthetic catalog fixture",
          stages: 1,
          readiness: "checked",
          validationRecordHash: id,
          qualitative: true,
          reason: null,
          updatedAt: "2026-09-26T12:00:00.000Z",
        };
        journal.project("evaluations", id, {
          search: title,
          status: "checked",
          sort: title,
          body: evaluation,
        });
        const state =
          n < 5
            ? "active"
            : n < 11
              ? "attention"
              : (["stopped", "partial", "complete"] as const)[n % 3]!;
        const run: RunSummary = {
          models: ["Synthetic model"],
          startedAt: null,
          id: `run-${n}`,
          title,
          state,
          phase: "execution",
          blocker: n < 5 ? null : "Retained capture failure",
          billedUsd: 0.04,
          reservedUsd: n === 999 ? 0.2 : 0,
          updatedAt: evaluation.updatedAt,
          evaluationId: id,
          draftId: id,
          finished: state === "partial" || state === "complete",
          stopped: state === "stopped",
          archived: false,
        };
        journal.project("runs", run.id, {
          search: title,
          status: run.state,
          sort: title,
          body: run,
        });
        const result: ResultSummary = {
          id,
          operationId: `run-${n}`,
          evaluationId: id,
          evaluationTitle: title,
          candidateId: id,
          candidateTitle: "Build 1",
          kind: "generated",
          buildState: "ready",
          notReached: null,
          model: "Synthetic builder",
          harness: "production",
          captures: [1, 2, 3].map((number) => ({
            number,
            state: "collected",
            planned: 5,
            met: n % 2 ? 4 : 5,
            rejected: 0,
            scored: 0,
            split: 0,
            insufficient: 0,
            unavailable: n % 2 ? 1 : 0,
          })),
          functional: {
            planned: 9,
            met: 9,
            rejected: 0,
            scored: 0,
            split: 0,
            insufficient: 0,
            unavailable: 0,
          },
          qualitative: {
            planned: 6,
            met: n % 2 ? 3 : 6,
            rejected: 0,
            scored: 0,
            split: 0,
            insufficient: 0,
            unavailable: n % 2 ? 3 : 0,
          },
          costUsd: 0.04,
          toolCalls: 12,
          elapsedMs: 21000,
          state: n % 2 ? "incomplete" : "complete",
          updatedAt: evaluation.updatedAt,
        };
        journal.project("results", id, {
          search: title,
          status: result.state,
          sort: title,
          body: result,
        });
        journal.project("results", `matrix:${id}`, {
          search: title,
          status: result.state,
          sort: title,
          body: { ...result, id: `matrix:${id}`, operationId: "large-suite" },
        });
        if (n < 200)
          journal.replaceIssues(`run-${n}`, [
            {
              code: "server_opened_as_edit",
              dependency: "shared-studio-build",
              explanation: "Capture unavailable",
              affectedCaptures: 1,
              affectedCandidates: 1,
              action: "inspect",
            },
          ]);
      }
    });
    assert.deepEqual(
      journal.groupedIssues().items.map((item) => item.affectedCaptures),
      [200],
    );
    journal.close();
    const handle = createOperationApi({ root });
    const get = async (path: string) => {
      const response = await handle(new Request(`http://127.0.0.1:43127/api/${path}`));
      assert.equal(response.status, 200);
      return response.json();
    };
    const evaluations = await get("evaluations");
    assert.equal(evaluations.total, 1000);
    assert.equal(evaluations.items.length, 20);
    assert.equal(evaluations.pages, 50);
    assert.equal((await get("evaluations?q=Mechanic%200123")).total, 1);
    assert.equal((await get("evaluations?limit=90000")).items.length, 50);
    const inbox = await get("run-inbox");
    assert.equal(inbox.active.total, 5);
    assert.equal(inbox.active.items.length, 4, "Active work stays bounded");
    assert.equal(inbox.attentionCount, 6, "Historical failures never inflate the attention count");
    assert.equal("issues" in inbox, false, "Retained failures are not global home alerts");
    const interruptions = await get("runs?status=attention");
    assert.equal(interruptions.total, inbox.attentionCount);
    assert.ok(interruptions.items.every((run: RunSummary) => run.state === "attention"));
    const stopped = await get("runs?status=stopped&q=Mechanic%200999");
    assert.equal(stopped.items[0].blocker, "Retained capture failure");
    assert.equal(stopped.items[0].reservedUsd, 0.2, "Historical liabilities stay visible");
    const first = await get("results"),
      second = await get("results?page=2");
    assert.equal(first.total, 2000);
    const matrix = await get("operations/large-suite/results?page=19&limit=20");
    assert.equal(matrix.total, 1000);
    assert.equal(matrix.items.length, 20);
    assert.equal(matrix.page, 19);
    assert.ok(matrix.items.every((item: ResultSummary) => item.operationId === "large-suite"));
    assert.equal(
      first.items.some((row: ResultSummary) =>
        second.items.some((next: ResultSummary) => next.id === row.id),
      ),
      false,
    );
    assert.equal((await get("results?status=incomplete")).total, 1000);
    let planned = 0;
    for (let page = 1; page <= 20; page++) {
      const results = await get(`operations/large-suite/results?limit=50&page=${page}`);
      planned += results.items.reduce(
        (total: number, row: ResultSummary) =>
          total + row.functional.planned + row.qualitative.planned,
        0,
      );
    }
    assert.equal(planned, 15000);
    assert.equal((await get("review-batches")).total, 0);
    const selection = await createReviewSelection(
      root,
      Array.from({ length: 1000 }, (_, n) => `run-${n}`),
    );
    const retained = await readReviewSelection(root, selection.id);
    assert.equal(retained.total, 1000);
    assert.equal(retained.items.length, 20);
    assert.equal(
      (await readReviewSelection(root, selection.id, new URLSearchParams("page=2"))).items.length,
      20,
    );
    assert.equal(
      (await readReviewSelection(root, selection.id, new URLSearchParams("limit=5000"))).items
        .length,
      50,
    );
    assert.ok(
      retained.items.every((item) => item.unavailable !== null),
      "Unavailable runs remain selected",
    );
    const narrowed = await createReviewSelection(root, selection.operationIds.slice(1));
    assert.equal(narrowed.operationIds.length, 999);
    assert.equal(
      (await readReviewSelection(root, selection.id)).total,
      1000,
      "Back restores the original immutable selection",
    );
    await assert.rejects(
      createReviewSelection(root, [...selection.operationIds, "extra"]),
      /1,000/,
    );
    await assert.rejects(createReviewSelection(root, ["run-1", "run-1"]), /different/);
    assert.equal((await get("review-batches")).total, 0);
    const reviewJournal = await OperationJournal.open(root);
    try {
      reviewJournal.transaction(() => {
        for (let n = 0; n < 60; n++)
          reviewJournal.project("review_progress", `review-${n}`, {
            search: "Assigned research",
            status: "protocol",
            sort: String(n).padStart(2, "0"),
            body: {
              id: `review-${n}`,
              state: n === 0 ? "active" : "completed",
              remaining: n === 0 ? 3 : 0,
            },
          });
      });
    } finally {
      reviewJournal.close();
    }
    assert.equal((await get("review-batches?state=completed&purpose=protocol")).total, 59);
    const reviews = await get("review-batches?state=active");
    assert.equal(reviews.total, 1);
    assert.equal(
      reviews.items[0]!.id,
      "review-0",
      "Newer completed reviews never hide assigned work",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planned results never masquerade as executed builds or successful zero-question captures", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-result-states-"));
  const journal = await OperationJournal.open(root);
  try {
    const status = {
      manifest: {
        id: "run",
        subjects: [{ id: "build", evalId: "evaluation", kind: "generated" }],
        evals: [
          {
            id: "evaluation",
            views: [],
            stage: {
              firstRevisionId: "evaluation",
              index: 1,
              count: 1,
              earlierPrompts: [],
              gateCriterionIds: [],
            },
          },
        ],
        captureCells: [{ id: "capture", treatmentId: "build", pass: 1 }],
        gradingCells: [],
        judgmentBatches: [],
        planned: { independentBuilderTrials: 1, criterionOutcomes: 0 },
      },
      events: [],
      inFlightUnits: [],
      completedUnits: [],
      criterionOutcomes: [],
      finished: false,
      stopped: false,
    } as unknown as RunOperationStatus;
    const result = () => {
      journal.put("operations", "run", status);
      projectTestOperation(journal, "run");
      return journal.read<ResultSummary>("catalog_results", "run:build")!;
    };
    let row = result();
    assert.equal(row.buildState, "planned");
    assert.equal(row.captures[0]!.state, "planned");
    assert.equal(row.state, "incomplete");
    journal.put("drivers", "run", { active: true, pid: process.pid, error: null });
    status.events = [
      { kind: "started", stage: "builder", unitId: "build", at: new Date().toISOString() },
    ] as RunOperationStatus["events"];
    status.inFlightUnits = [{ stage: "builder", unitId: "build" }];
    assert.equal(result().buildState, "running");
    status.completedUnits = ["builder:build"];
    status.inFlightUnits = [{ stage: "final_capture", unitId: "capture" }];
    status.events.push({
      kind: "started",
      stage: "final_capture",
      unitId: "capture",
      at: new Date().toISOString(),
    } as RunOperationStatus["events"][number]);
    row = result();
    assert.equal(row.buildState, "ready");
    assert.equal(row.captures[0]!.state, "collecting");
    journal.put("drivers", "run", { active: true, pid: 2147483647, error: null });
    const response = await createOperationApi({ root })(
      new Request("http://127.0.0.1:3000/api/operations/run/results"),
    );
    assert.equal(response.status, 200);
    const interrupted = await response.json();
    assert.equal(
      interrupted.items[0].captures[0].state,
      "incomplete",
      "Direct results reads observe an exited worker without visiting the run inbox",
    );
    assert.equal(interrupted.items[0].state, "incomplete");
    assert.equal(result().state, "incomplete", "A dead process cannot retain an active result");
    assert.equal(result().captures[0]!.state, "incomplete");
    journal.put("drivers", "run", { active: false, error: null });
    assert.equal(
      result().captures[0]!.state,
      "incomplete",
      "An exited owner cannot keep capture spinning",
    );
    status.completedUnits.push("final_capture:capture");
    status.finished = true;
    status.inFlightUnits = [];
    row = result();
    assert.equal(row.captures[0]!.state, "collected");
    assert.equal(
      row.state,
      "incomplete",
      "Collected evidence with no outcomes is not a completed evaluation",
    );
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runs list newest first by their start, also after one rebuild projects them all", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-run-order-"));
  const journal = await OperationJournal.open(root);
  try {
    // The older run is projected last and has the first ID. A sort by projection time or
    // by ID puts it first.
    for (const [id, at] of [
      ["run-b", "2026-10-03T22:00:00.000Z"],
      ["run-a", "2026-10-03T21:00:00.000Z"],
    ] as const) {
      journal.put("operations", id, {
        manifest: {
          id,
          subjects: [],
          evals: [],
          captureCells: [],
          gradingCells: [],
          judgmentBatches: [],
          planned: { independentBuilderTrials: 0, criterionOutcomes: 0 },
        },
        events: [{ kind: "started", stage: "builder", unitId: "build", at }],
        inFlightUnits: [],
        completedUnits: [],
        criterionOutcomes: [],
        finished: true,
        stopped: false,
      });
      projectTestOperation(journal, id);
    }
  } finally {
    journal.close();
  }
  try {
    const runs = await runCatalog(root);
    assert.deepEqual(
      runs.items.map((run) => [run.id, run.startedAt]),
      [
        ["run-b", "2026-10-03T22:00:00.000Z"],
        ["run-a", "2026-10-03T21:00:00.000Z"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failure grouping uses recorded causes, deduplicates captures and clears recovered units", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-failure-grouping-"));
  const journal = await OperationJournal.open(root);
  try {
    const captures = Array.from({ length: 202 }, (_, n) => ({
      id: `capture-${n}`,
      treatmentId: `candidate-${n % 2}`,
    }));
    const events = captures.flatMap((c) =>
      [1, 2].map(() => ({
        kind: "incomplete",
        stage: "final_capture",
        unitId: c.id,
        reason: "Similar messages do not identify a cause",
        at: "2026-09-29T15:55:00.000Z",
      })),
    );
    const status = {
      manifest: {
        id: "run",
        subjects: [],
        evals: [],
        captureCells: captures,
        gradingCells: [],
        judgmentBatches: [],
        planned: { criterionOutcomes: 202 },
      },
      events,
      inFlightUnits: [],
      completedUnits: [],
      criterionOutcomes: [],
      finished: false,
    } as unknown as RunOperationStatus;
    const heads = Object.fromEntries(
      captures.map((c, n) => [
        `final_capture:${c.id}`,
        {
          id: hashJson(c),
          operationId: "run",
          at: new Date().toISOString(),
          causeCode:
            n < 200
              ? "server_opened_as_edit"
              : n === 200
                ? "client_opened_as_edit"
                : "unclassified",
          category: n === 201 ? "unknown" : "startup",
          dependency: "same-studio-build",
          unit: { stage: "final_capture", id: c.id },
          explanation: "Recorded startup failure",
          evidenceRefs: [],
          recoveryActions: ["inspect"],
        } as FailureRecord,
      ]),
    );
    journal.put("operations", "run", status);
    journal.put("failure_heads", "run", heads);
    projectTestOperation(journal, "run");
    const grouped = journal.groupedIssues();
    assert.equal(grouped.total, 3);
    assert.equal(grouped.items[0]!.affectedCaptures, 200);
    assert.equal(grouped.items[0]!.affectedCandidates, 2);
    assert.equal(journal.issueOperations(grouped.items[0]!.id).total, 1);
    journal.put("operations", "run", {
      ...status,
      completedUnits: captures.map((c) => `final_capture:${c.id}`),
    });
    projectTestOperation(journal, "run");
    assert.equal(journal.groupedIssues().total, 0);
    const preparation = {
      ...heads["final_capture:capture-0"]!,
      causeCode: "spending_ceiling",
      category: "budget" as const,
      unit: { stage: "prepare_public", id: "draft" },
    };
    journal.put("failure_heads", "run", { "prepare_public:draft": preparation });
    journal.put("workflows", "run", {
      draftIds: ["draft"],
      revisions: {},
      selection: {
        sources: [{ kind: "draft", id: "draft" }],
        builderModelIds: [],
        harnessIds: [],
        repetitions: 1,
      },
      phase: "complete",
      state: "complete",
      title: "Recovered preparation",
    });
    projectTestOperation(journal, "run");
    assert.equal(
      journal.groupedIssues().items.some((item) => item.code === "spending_ceiling"),
      false,
      "Completed preparation clears its former admission blocker",
    );
    const control = {
      ...preparation,
      causeCode: "preparation_invalid",
      unit: { stage: "preparation", id: "previous-input" },
      evidenceRefs: ["retained-request"],
    };
    journal.put("failure_heads", "run", { "preparation:previous-input": control });
    journal.put("workflows", "run", {
      draftIds: ["draft"],
      revisions: {},
      selection: {
        sources: [{ kind: "draft", id: "draft" }],
        builderModelIds: [],
        harnessIds: [],
        repetitions: 1,
      },
      phase: "preparation",
      state: "active",
      title: "Amended inputs",
    });
    projectTestOperation(journal, "run");
    assert.equal(
      journal.groupedIssues().total,
      0,
      "Input amendment invalidates old preparation work",
    );
    journal.put("spending", "run", {
      entries: [{ status: "pending", requestHash: "retained-request", stage: "preparation" }],
    });
    journal.put("workflows", "run", {
      draftIds: ["draft"],
      revisions: {},
      selection: {
        sources: [{ kind: "draft", id: "draft" }],
        builderModelIds: [],
        harnessIds: [],
        repetitions: 1,
      },
      phase: "execution",
      state: "active",
      title: "Distinct admitted work",
    });
    projectTestOperation(journal, "run");
    assert.equal(
      journal.groupedIssues().total,
      1,
      "An outstanding liability keeps its issue visible",
    );
    assert.equal(
      journal.read<RunOperationStatus>("operations", "run")!.events.length,
      404,
      "Historical failures remain retained",
    );
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
