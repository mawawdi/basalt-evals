import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { consoleNotifications } from "../packages/operator/src/benchmarks.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type { RunSummary } from "../packages/contracts/src/catalog.js";

for (const scenario of [
  { state: "stopped", payment: "pending", notify: true },
  { state: "stopped", payment: "billed", notify: false },
  { state: "active", payment: "pending", notify: false },
  { state: "active", payment: "billed", notify: false },
  { state: "complete", payment: "billed", notify: false },
] as const)
  test(`${scenario.state} run with ${scenario.payment} payment ${scenario.notify ? "links its unresolved request" : "does not create a billing alert"}`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-notification-"));
    try {
      const id = "notification-test",
        requestId = hashJson({ request: "retained" });
      const ledger = new DurableSpendLedger(root, id, hashJson({ context: "frozen" }));
      await ledger.initialize({
        ceilingUsd: 1,
        quoteHash: hashJson({ quote: "authorized" }),
      });
      await ledger.reserve({
        requestId,
        requestHash: hashJson({ input: "retained" }),
        stage: "builder:one",
        maximumUsd: 0.25,
      });
      if (scenario.payment === "billed") await ledger.reconcile(requestId, 0.1);
      const before = await ledger.read();
      const row: RunSummary = {
        id,
        title: "Retained benchmark",
        state: scenario.state,
        stopped: scenario.state === "stopped",
        finished: scenario.state === "complete",
        phase: "execution",
        blocker: null,
        models: ["Test model"],
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:01.000Z",
        billedUsd: scenario.payment === "billed" ? 0.1 : 0,
        reservedUsd: scenario.payment === "billed" ? 0 : 0.25,
        draftId: null,
        evaluationId: null,
        archived: false,
      };
      const journal = await OperationJournal.open(root);
      try {
        journal.put("catalog_runs", id, row);
        journal.project("runs", id, {
          body: row,
          search: row.title,
          status: row.state,
          sort: row.updatedAt,
        });
      } finally {
        journal.close();
      }
      const notifications = await consoleNotifications(root);
      assert.equal(notifications.length, scenario.notify ? 1 : 0);
      if (scenario.notify) {
        assert.equal(notifications[0]!.kind, "billing");
        assert.equal(notifications[0]!.href, `/runs/${id}/requests/${requestId}`);
        assert.equal(
          notifications[0]!.at,
          row.updatedAt,
          "A notification shows when its run changed",
        );
        assert.ok(
          notifications[0]!.detail.includes("holds $0.25 until the provider confirms the cost"),
        );
      }
      assert.deepEqual(
        await ledger.read(),
        before,
        "Listing issues never changes retained charges",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("an unreadable ledger gives one notification for its stopped run and keeps the others", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-notification-"));
  try {
    const run = async (id: string, state: RunSummary["state"], status: string) => {
      const requestId = hashJson({ request: id });
      const ledger = new DurableSpendLedger(root, id, hashJson({ context: id }));
      await ledger.initialize({ ceilingUsd: 1, quoteHash: hashJson({ quote: id }) });
      await ledger.reserve({
        requestId,
        requestHash: hashJson({ input: id }),
        stage: "builder:one",
        maximumUsd: 0.25,
      });
      const row: RunSummary = {
        id,
        title: id,
        state,
        stopped: state === "stopped",
        finished: false,
        phase: "execution",
        blocker: null,
        models: ["Test model"],
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:01.000Z",
        billedUsd: 0,
        reservedUsd: 0.25,
        draftId: null,
        evaluationId: null,
        archived: false,
      };
      const journal = await OperationJournal.open(root);
      try {
        // A status that the ledger does not know, so the ledger cannot read the record.
        const saved = journal.read<{ entries: Array<{ status: string }> }>("spending", id)!;
        saved.entries[0]!.status = status;
        journal.put("spending", id, saved);
        journal.put("catalog_runs", id, row);
        journal.project("runs", id, {
          body: row,
          search: row.title,
          status: row.state,
          sort: row.updatedAt,
        });
      } finally {
        journal.close();
      }
      return requestId;
    };
    await run("unreadable-stopped", "stopped", "uncertain");
    await run("unreadable-partial", "partial", "uncertain");
    const pending = await run("readable-stopped", "stopped", "pending");
    const notifications = await consoleNotifications(root);
    assert.deepEqual(notifications.map((item) => item.id).sort(), [
      `billing:readable-stopped:${pending}`,
      "billing:unreadable-stopped:unreadable",
    ]);
    const unreadable = notifications.find((item) => item.id.endsWith(":unreadable"))!;
    assert.equal(unreadable.title, "Unknown charges · unreadable-stopped");
    assert.equal(unreadable.href, "/runs/unreadable-stopped?tab=progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
