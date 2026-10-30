import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type { EvaluationSummary } from "../packages/contracts/src/catalog.js";
import type { EvaluationWorkflow } from "../packages/contracts/src/execution.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { saveLibraryDraft } from "../packages/eval-authoring/src/library.js";
import { benchmarkCatalog, consoleNotifications } from "../packages/operator/src/benchmarks.js";
import { projectRun } from "../packages/operator/src/catalog-projection.js";
import { evaluationCatalog, runCatalog } from "../packages/operator/src/discovery.js";
import { deleteEvaluation } from "../packages/operator/src/evaluation-retention.js";
import { savedLifecycle } from "../packages/operator/src/lifecycle.js";
import { lineageSpending } from "../packages/operator/src/lineage.js";
import {
  RunRetentionConflict,
  deleteRun,
  listDeletedRuns,
  setRunArchived,
} from "../packages/operator/src/run-retention.js";
import { runInbox, operationView } from "../packages/operator/src/workbench.js";
import { fixtureLaunchDefaults } from "./shared-api-fixture.js";
import { assertRunIdentityFree } from "../packages/operator/src/run-visibility.js";

const runId = (label: string) => `flow-${hashJson(label).slice(0, 32)}`;

interface RunFixture {
  id: string;
  title: string;
  state: EvaluationWorkflow["state"];
  phase?: EvaluationWorkflow["phase"];
  previewId?: string;
  parents?: string[];
  charge?: "billed" | "pending";
  draftId?: string;
}

/** A saved workflow run with a ledger, launch inputs and files, without a driver or Studio. */
async function saveRun(root: string, run: RunFixture) {
  const files = new RepositoryFiles(root);
  const quoteId = hashJson({ quote: run.id }),
    workflowPreviewId = hashJson({ workflowPreview: run.id }),
    previewId = run.previewId ?? hashJson({ preview: run.id }),
    draftId = run.draftId ?? hashJson({ draft: run.id });
  const ledger = new DurableSpendLedger(root, run.id, hashJson({ context: run.id }));
  await ledger.initialize({ quoteHash: hashJson({ authorized: run.id }), ceilingUsd: 1 });
  if (run.charge) {
    const requestId = hashJson({ request: run.id });
    await ledger.reserve({
      requestId,
      requestHash: hashJson({ input: run.id }),
      stage: "builder:one",
      maximumUsd: 0.25,
    });
    if (run.charge === "billed") await ledger.reconcile(requestId, 0.12);
  }
  // Two runs can share one launch preview and its quote. The workflow preview is the run's own.
  const previewQuoteId = hashJson({ quote: previewId });
  await files.writeJsonOnce(`.basalt-evals/launch-previews/${previewId}.json`, {
    binding: { kind: "run", id: previewQuoteId },
  });
  await files.writeJsonOnce(`.basalt-evals/eval-run-quotes/${previewQuoteId}.json`, {
    id: previewQuoteId,
  });
  await files.writeJsonOnce(`.basalt-evals/launch-previews/${workflowPreviewId}.json`, {
    run: { id: quoteId },
    evaluations: [],
  });
  await files.writeJsonOnce(`.basalt-evals/eval-run-quotes/${quoteId}.json`, { id: quoteId });
  await files.writeJson(`.basalt-evals/eval-operations/${run.id}/capture/one/evidence.json`, {
    observation: run.id,
  });
  const workflow: EvaluationWorkflow = {
    id: run.id,
    previewId: workflowPreviewId,
    title: run.title,
    inputHash: hashJson([draftId]),
    draftIds: [draftId],
    selection: { ...fixtureLaunchDefaults, sources: [{ kind: "draft", id: draftId }] },
    ceilingUsd: 1,
    authorizationHash: hashJson({ authorization: run.id }),
    requestHash: hashJson({ request: run.id }),
    phase: run.phase ?? (run.state === "complete" ? "complete" : "execution"),
    state: run.state,
    blocker: run.state === "attention" ? "The Basalt worker stopped unexpectedly." : null,
    revisions: {},
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      journal.put("workflows", run.id, workflow);
      journal.put("operation_context", run.id, {
        costScope: hashJson({ scope: "shared" }),
        previewId,
        kind: "evaluation",
        title: run.title,
        regressionId: null,
        parentOperationIds: run.parents ?? [],
      });
      journal.put("launch_authorizations", hashJson({ key: run.id }), {
        requestHash: hashJson({ request: run.id }),
        previewId,
        ceilingUsd: 1,
        operationId: run.id,
      });
      projectRun(journal, run.id);
    });
  } finally {
    journal.close();
  }
}

const listed = async (root: string, status = "") =>
  (await runCatalog(root, new URLSearchParams(status ? { status } : {}))).items.map(
    (row) => row.id,
  );

async function workspace(label: string) {
  return mkdtemp(resolve(tmpdir(), `basalt-retention-${label}-`));
}

test("archive moves a settled run out of the default lists, and restore returns it", async () => {
  const root = await workspace("archive");
  try {
    const complete = runId("complete"),
      interrupted = runId("interrupted"),
      active = runId("active");
    await saveRun(root, { id: complete, title: "Finished benchmark", state: "complete" });
    await saveRun(root, { id: interrupted, title: "Interrupted benchmark", state: "attention" });
    await saveRun(root, { id: active, title: "Queued benchmark", state: "active" });
    assert.ok((await benchmarkCatalog(root)).some((row) => row.id === complete));
    assert.equal((await runInbox(root)).attentionCount, 1);
    assert.ok(
      (await consoleNotifications(root)).some((item) => item.title.includes("Interrupted")),
    );

    const archived = await setRunArchived(root, complete, true);
    assert.equal(archived.archived, true);
    assert.equal(archived.state, "complete", "archive keeps the recorded state");
    await setRunArchived(root, interrupted, true);
    assert.deepEqual(await listed(root), [active]);
    assert.deepEqual((await listed(root, "archived")).sort(), [complete, interrupted].sort());
    assert.ok(!(await benchmarkCatalog(root)).some((row) => row.id === complete));
    assert.equal((await runInbox(root)).attentionCount, 0);
    assert.deepEqual(await consoleNotifications(root), []);
    // Evidence stays readable from the run page, and the run cannot start work while archived.
    assert.equal(
      (await operationView(root, complete)).status.workflow?.title,
      "Finished benchmark",
    );
    const lifecycle = await savedLifecycle(root, interrupted);
    assert.equal(lifecycle.capabilities.resume.allowed, false);
    assert.match(lifecycle.capabilities.resume.reason, /Restore the run/);
    await assert.rejects(
      setRunArchived(root, active, true),
      (error: unknown) =>
        error instanceof RunRetentionConflict && /can still start work/.test(error.message),
    );

    await setRunArchived(root, complete, false);
    assert.deepEqual((await listed(root)).sort(), [complete, active].sort());
    assert.deepEqual(await listed(root, "archived"), [interrupted]);
    assert.ok((await benchmarkCatalog(root)).some((row) => row.id === complete));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete refuses an active run, a run with an unknown charge and a run that other work uses", async () => {
  const root = await workspace("refusals");
  try {
    const active = runId("queued"),
      unpriced = runId("unpriced"),
      parent = runId("parent"),
      child = runId("child"),
      compared = runId("compared");
    await saveRun(root, { id: active, title: "Queued benchmark", state: "active" });
    await saveRun(root, {
      id: unpriced,
      title: "Unknown charge",
      state: "stopped",
      charge: "pending",
    });
    await saveRun(root, { id: parent, title: "Original benchmark", state: "complete" });
    await saveRun(root, {
      id: child,
      title: "Repair attempt",
      state: "complete",
      parents: [parent],
    });
    await saveRun(root, { id: compared, title: "Compared benchmark", state: "complete" });
    const journal = await OperationJournal.open(root);
    try {
      journal.put("comparisons", hashJson("comparison"), {
        baseline: { operationId: compared },
        selected: { operationId: child },
      });
    } finally {
      journal.close();
    }
    const refused = (pattern: RegExp) => (error: unknown) =>
      error instanceof RunRetentionConflict && pattern.test(error.message);
    await assert.rejects(deleteRun(root, active), refused(/can still start work/));
    await assert.rejects(
      deleteRun(root, unpriced),
      refused(/1 request without a confirmed charge.*Check payment status/),
    );
    await assert.rejects(
      deleteRun(root, parent),
      refused(
        new RegExp(`run "Repair attempt" \\(${child}\\).*Delete the runs in this list first`),
      ),
    );
    await assert.rejects(
      deleteRun(root, compared),
      refused(/saved comparison .*Archive the run to remove it from the lists/),
    );
    // A refusal changes nothing: the records, the ledger and the list rows stay.
    const after = await OperationJournal.open(root);
    try {
      for (const id of [active, unpriced, parent, compared]) {
        assert.ok(after.read("workflows", id));
        assert.ok(after.read("spending", id));
        assert.equal(after.read("deleted_runs", id), null);
      }
    } finally {
      after.close();
    }
    assert.equal((await listed(root)).length, 5);
    assert.equal((await listDeletedRuns(root)).total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete removes the records and files of a run and keeps its spending record", async () => {
  const root = await workspace("delete");
  const outside = await workspace("outside");
  try {
    const deleted = runId("deleted"),
      kept = runId("kept"),
      shared = hashJson("shared preview");
    await saveRun(root, {
      id: deleted,
      title: "Old benchmark",
      state: "complete",
      previewId: shared,
      charge: "billed",
    });
    await saveRun(root, {
      id: kept,
      title: "Current benchmark",
      state: "complete",
      previewId: shared,
    });
    await setRunArchived(root, deleted, true);
    // A link inside the run folder points outside the workspace. Delete removes only the link.
    await writeFile(resolve(outside, "keep.txt"), "outside");
    await symlink(outside, resolve(root, `.basalt-evals/eval-operations/${deleted}/linked`));
    // A replay preview copied two builds of the run. Saved research uses only the second copy.
    const files = new RepositoryFiles(root);
    const copied = hashJson("copied source"),
      planned = hashJson("planned source");
    for (const source of [copied, planned]) {
      await files.writeJson(`.basalt-evals/sources/${source}/source.json`, {
        id: source,
        provenance: { originOperationId: deleted },
      });
      await files.write(`.basalt-evals/sources/${source}/candidate/init.luau`, "return {}\n");
    }
    await files.writeJson(`.basalt-evals/experiment-plans/${hashJson("plan")}.json`, {
      sourceBindings: { builder: planned },
    });
    const journal = await OperationJournal.open(root);
    try {
      journal.put("measured_costs", hashJson({ scope: "shared" }), {
        [deleted]: 0.12,
        [kept]: 0.3,
      });
    } finally {
      journal.close();
    }

    const record = await deleteRun(root, deleted);
    assert.deepEqual(
      { ...record, deletedAt: "" },
      { operationId: deleted, title: "Old benchmark", billedUsd: 0.12, deletedAt: "", files: [] },
    );
    assert.equal(await readFile(resolve(outside, "keep.txt"), "utf8"), "outside");
    const gone = (path: string) =>
      lstat(resolve(root, path)).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    assert.ok(await gone(`.basalt-evals/eval-operations/${deleted}`));
    assert.ok(
      await gone(`.basalt-evals/launch-previews/${hashJson({ workflowPreview: deleted })}.json`),
    );
    assert.ok(await gone(`.basalt-evals/eval-run-quotes/${hashJson({ quote: deleted })}.json`));
    assert.ok(
      !(await gone(`.basalt-evals/launch-previews/${shared}.json`)),
      "another run names it",
    );
    assert.ok(
      !(await gone(`.basalt-evals/eval-run-quotes/${hashJson({ quote: shared })}.json`)),
      "a kept preview names it",
    );
    assert.ok(await gone(`.basalt-evals/sources/${copied}`), "only the deleted run used the copy");
    assert.ok(!(await gone(`.basalt-evals/sources/${planned}/source.json`)), "saved work uses it");
    assert.ok(!(await gone(`.basalt-evals/eval-operations/${kept}/capture/one/evidence.json`)));

    const after = await OperationJournal.open(root);
    try {
      assert.deepEqual(
        after.recordsKeyedBy(deleted).map((row) => row.namespace),
        ["deleted_runs"],
      );
      assert.deepEqual(after.read("measured_costs", hashJson({ scope: "shared" })), {
        [kept]: 0.3,
      });
      assert.equal(after.page("runs", { status: "archived" }).total, 0);
      assert.equal(after.page(`activity:${deleted}`).total, 0);
      // The identity of a deleted run never gets records again.
      assert.throws(() => projectRun(after, deleted), /deleted this run/);
      // Lineage totals keep the charge of a deleted ancestor.
      after.put("operation_context", kept, {
        ...after.read<Record<string, unknown>>("operation_context", kept),
        parentOperationIds: [deleted],
      });
      const lineage = lineageSpending(after, kept);
      assert.equal(lineage.billedUsd, 0.12);
      assert.deepEqual(
        lineage.operations.find((item) => item.operationId === deleted),
        {
          operationId: deleted,
          billedUsd: 0.12,
          reservedUsd: 0,
          deleted: true,
        },
      );
    } finally {
      after.close();
    }
    assert.deepEqual(await listed(root), [kept]);
    const spending = await listDeletedRuns(root);
    assert.equal(spending.total, 1);
    assert.equal(spending.billedUsd, 0.12);
    assert.deepEqual(await deleteRun(root, deleted), record, "a repeated delete changes nothing");
    // A start or a resume under the identity stops before it writes files.
    await assert.rejects(assertRunIdentityFree(root, deleted), /deleted this run/);
    await assert.rejects(setRunArchived(root, deleted, false), /deleted this run/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("delete keeps the coverage notes of a revision and removes an unfinished claim of the run", async () => {
  const root = await workspace("coverage");
  try {
    const preparation = runId("preparation");
    await saveRun(root, { id: preparation, title: "Prepared evaluation", state: "complete" });
    const complete = hashJson({ revisionId: "revision", identityHash: "first model" }),
      unfinished = hashJson({ revisionId: "revision", identityHash: "second model" });
    const journal = await OperationJournal.open(root);
    try {
      journal.put("coverage_notes", complete, {
        state: "complete",
        value: { revisionId: "revision", operationId: preparation, state: "complete" },
      });
      journal.put("coverage_notes", unfinished, {
        state: "interrupted",
        operationId: preparation,
        reason: "Stopped",
      });
    } finally {
      journal.close();
    }
    await deleteRun(root, preparation);
    const after = await OperationJournal.open(root);
    try {
      assert.ok(after.read("coverage_notes", complete), "the notes belong to the revision");
      assert.equal(after.read("coverage_notes", unfinished), null);
    } finally {
      after.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop between the journal step and the file step leaves no half run", async () => {
  const root = await workspace("crash");
  const id = runId("crash");
  const locked = resolve(root, `.basalt-evals/eval-operations/${id}/capture/one`);
  try {
    await saveRun(root, { id, title: "Interrupted delete", state: "stopped" });
    // The file step fails after the journal step, like a process that stops between them.
    await chmod(locked, 0o500);
    await assert.rejects(
      deleteRun(root, id),
      /removed the run from the lists, but it could not remove .*operation delete .*(EACCES|EPERM)/,
    );
    assert.deepEqual(await listed(root), []);
    assert.deepEqual(await listed(root, "archived"), []);
    const journal = await OperationJournal.open(root);
    try {
      assert.equal(journal.read("workflows", id), null);
      assert.equal(journal.read("spending", id), null);
      assert.deepEqual(
        journal.read<{ files: string[] }>("deleted_runs", id)!.files[0],
        `.basalt-evals/eval-operations/${id}`,
      );
    } finally {
      journal.close();
    }
    assert.ok((await lstat(resolve(locked, "evidence.json"))).isFile(), "the files wait");
    await chmod(locked, 0o700);
    const finished = await deleteRun(root, id);
    assert.deepEqual(finished.files, []);
    await assert.rejects(lstat(resolve(root, `.basalt-evals/eval-operations/${id}`)), /ENOENT/);
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation delete refuses an evaluation that a run uses and removes an unused entry", async () => {
  const root = await workspace("evaluation");
  try {
    const used = hashJson("used draft"),
      unused = hashJson("unused draft");
    const summary = (draftId: string, title: string): EvaluationSummary => ({
      id: draftId,
      evaluationId: null,
      archived: false,
      kind: "draft",
      draftId,
      title,
      description: "Synthetic evaluation",
      stages: 1,
      readiness: "draft",
      validationRecordHash: null,
      qualitative: false,
      reason: null,
      updatedAt: "2026-10-01T08:00:00.000Z",
    });
    const entries = {
      used: `eval-${"1".repeat(16)}`,
      copy: `eval-${"2".repeat(16)}`,
      unused: `eval-${"3".repeat(16)}`,
    };
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() => {
        journal.put("catalog_evaluations", used, summary(used, "Moving platform"));
        journal.put("catalog_evaluations", unused, summary(unused, "Beacon"));
        saveLibraryDraft(journal, { id: entries.used, draftId: used, expectedDraftId: null });
        saveLibraryDraft(journal, { id: entries.copy, draftId: used, expectedDraftId: null });
        saveLibraryDraft(journal, { id: entries.unused, draftId: unused, expectedDraftId: null });
        journal.put("working_copies", "copy-of-beacon", {
          id: "copy-of-beacon",
          evaluationId: entries.unused,
        });
      });
    } finally {
      journal.close();
    }
    await saveRun(root, {
      id: runId("platform"),
      title: "Platform run",
      state: "complete",
      draftId: used,
    });

    // A deliberate duplicate shares the snapshot. The other entry keeps it for the run.
    await deleteEvaluation(root, entries.copy);
    await assert.rejects(
      deleteEvaluation(root, entries.used),
      (error: unknown) =>
        error instanceof RunRetentionConflict &&
        /run "Platform run".*delete these runs first.*Archive the evaluation/.test(error.message),
    );
    const removed = await deleteEvaluation(root, entries.unused);
    assert.equal(removed.title, "Beacon");
    assert.deepEqual(
      (await evaluationCatalog(root)).items.map((item) => item.evaluationId),
      [entries.used],
    );
    const after = await OperationJournal.open(root);
    try {
      assert.equal(after.read("evaluation_library", entries.unused), null);
      assert.equal(after.read("working_copies", "copy-of-beacon"), null);
      assert.equal(after.read("evaluation_draft_members", unused), null);
      assert.deepEqual(after.read("evaluation_draft_members", used), [entries.used]);
      assert.ok(after.read("catalog_evaluations", unused), "immutable snapshots stay");
    } finally {
      after.close();
    }
    await assert.rejects(deleteEvaluation(root, entries.unused), /cannot find this evaluation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete removes only paths inside the workspace", async () => {
  const root = await workspace("boundary");
  try {
    const id = runId("boundary");
    await saveRun(root, { id, title: "Boundary", state: "complete" });
    // A tombstone with a path outside the workspace cannot remove that path.
    await mkdir(resolve(root, "outside"), { recursive: true });
    const journal = await OperationJournal.open(root);
    try {
      journal.put("deleted_runs", id, {
        operationId: id,
        title: "Boundary",
        billedUsd: 0,
        deletedAt: "2026-10-01T09:00:00.000Z",
        files: ["outside"],
      });
    } finally {
      journal.close();
    }
    await assert.rejects(deleteRun(root, id), /only inside its workspace/);
    assert.ok((await lstat(resolve(root, "outside"))).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
