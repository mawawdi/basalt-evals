import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";

test("every stage shares one limit while each request reserves only its own maximum", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-shared-limit-"));
  try {
    const ledger = new DurableSpendLedger(root, "comparison", contextHash);
    await ledger.initialize({ ...initialAuthorization, ceilingUsd: 1 });
    const reserve = (stage: string, name: string, maximumUsd: number) => {
      const requestId = hashJson(name);
      return ledger.reserve({ stage, requestId, requestHash: requestId, maximumUsd });
    };
    await reserve("builder:a", "a-first", 0.35);
    await ledger.reconcile(hashJson("a-first"), 0.3);
    await reserve("builder:b", "b-first", 0.4);
    // A provider rejection settles at zero, so its retry can reserve the full amount again.
    await ledger.reconcile(hashJson("b-first"), 0);
    await reserve("builder:b", "b-retry", 0.4);
    await ledger.reconcile(hashJson("b-retry"), 0.4);
    await reserve("judgment:result", "result", 0.3);
    await ledger.reconcile(hashJson("result"), 0.1);
    await assert.rejects(reserve("judgment:other", "other", 0.21), /ceiling/);
    await reserve("builder:a", "a-next", 0.2);
    await ledger.reconcile(hashJson("a-next"), 0.2);
    await assert.rejects(reserve("builder:b", "b-next", 0.01), /ceiling/);
    await ledger.authorize({ quoteHash: hashJson("increase"), ceilingUsd: 1.2 });
    await reserve("builder:b", "b-next", 0.2);
    const rejected = (await ledger.read()).entries.find(
      (item) => item.requestId === hashJson("b-first"),
    )!;
    assert.equal(rejected.billedUsd, 0);
    assert.equal(rejected.reservedUsd, 0.4, "The record keeps the amount that the request held");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const contextHash = hashJson({ draftId: "draft", quoteId: "quote" });
const initialAuthorization = { quoteHash: hashJson("initial-quote"), ceilingUsd: 0.1 };

test("initial spending authorization and its journal guard commit or roll back together", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-initial-authorization-guard-"));
  try {
    const ledger = new DurableSpendLedger(root, "before-spending", contextHash);
    await assert.rejects(
      ledger.initialize(initialAuthorization, (journal) => {
        journal.put("guard-proof", "before-spending", { accepted: false });
        throw new Error("Synthetic stale authorization head");
      }),
      /stale authorization head/u,
    );
    await assert.rejects(ledger.read(), { code: "ENOENT" });
    const rejected = await OperationJournal.open(root);
    try {
      assert.equal(rejected.read("guard-proof", "before-spending"), null);
      assert.equal(rejected.read("spending_progress", "before-spending"), null);
    } finally {
      rejected.close();
    }
    await ledger.initialize(initialAuthorization, (journal) => {
      journal.put("guard-proof", "before-spending", { accepted: true });
    });
    const committed = await ledger.read();
    await assert.rejects(
      ledger.initialize(initialAuthorization, () => {
        throw new Error("Synthetic active owner");
      }),
      /active owner/u,
    );
    assert.deepEqual(
      await ledger.read(),
      committed,
      "A rejected reinitialization cannot reset receipts",
    );
    const accepted = await OperationJournal.open(root);
    try {
      assert.deepEqual(accepted.read("guard-proof", "before-spending"), { accepted: true });
    } finally {
      accepted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable reservations block duplicate and pending paid calls across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-spend-ledger-"));
  try {
    const ledger = new DurableSpendLedger(root, "run-test", contextHash);
    await ledger.initialize(initialAuthorization);
    const request = { stage: "preparation", request: "one" };
    const id = DurableSpendLedger.requestId(request.stage, request.request);
    await ledger.reserve({
      requestId: id,
      requestHash: id,
      stage: request.stage,
      maximumUsd: 0.06,
    });
    const resumed = new DurableSpendLedger(root, "run-test", contextHash);
    await assert.rejects(
      new DurableSpendLedger(root, "run-test", hashJson({ draftId: "other" })).initialize(
        initialAuthorization,
      ),
      /context/,
    );
    const next = DurableSpendLedger.requestId("audit", "two");
    await assert.rejects(
      resumed.reserve({ requestId: next, requestHash: next, stage: "audit", maximumUsd: 0.01 }),
      /Another request has a pending charge/,
    );
    await ledger.reconcile(id, 0.06);
    await assert.rejects(ledger.reconcile(id, 0.02), /No unresolved paid request/);
    await assert.rejects(
      resumed.reserve({ requestId: id, requestHash: id, stage: "preparation", maximumUsd: 0.01 }),
      /already used/,
    );
    await assert.rejects(
      resumed.reserve({ requestId: next, requestHash: next, stage: "audit", maximumUsd: 0.05 }),
      /ceiling/,
    );
    await resumed.reserve({ requestId: next, requestHash: next, stage: "audit", maximumUsd: 0.04 });
    assert.equal((await ledger.read()).entries[0]?.status, "billed");
    await resumed.reconcile(next, 0.03);
    const third = DurableSpendLedger.requestId("grade", "three");
    await assert.rejects(
      resumed.reserve({ requestId: third, requestHash: third, stage: "grade", maximumUsd: 0.06 }),
      /ceiling/,
    );
    assert.equal((await resumed.read()).entries.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero ceiling permits no chargeable work", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-zero-ledger-"));
  try {
    const ledger = new DurableSpendLedger(root, "run-zero", contextHash);
    await ledger.initialize({ ...initialAuthorization, ceilingUsd: 0 });
    const id = DurableSpendLedger.requestId("builder", "one");
    await assert.rejects(
      ledger.reserve({ requestId: id, requestHash: id, stage: "builder", maximumUsd: 0.0001 }),
      /ceiling/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later quote raises one cumulative ceiling without losing earlier spend", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-staged-ledger-"));
  try {
    const ledger = new DurableSpendLedger(root, "run-staged", contextHash);
    await ledger.initialize(initialAuthorization);
    const first = DurableSpendLedger.requestId("preparation", "one");
    await ledger.reserve({
      requestId: first,
      requestHash: first,
      stage: "preparation",
      maximumUsd: 0.1,
    });
    await ledger.reconcile(first, 0.08);
    const second = DurableSpendLedger.requestId("controls", "two");
    await assert.rejects(
      ledger.reserve({
        requestId: second,
        requestHash: second,
        stage: "controls",
        maximumUsd: 0.05,
      }),
      /ceiling/,
    );
    const later = { quoteHash: hashJson("control-quote"), ceilingUsd: 0.2 };
    await ledger.authorize(later);
    await assert.rejects(ledger.authorize(later), /already/);
    await assert.rejects(
      ledger.authorize({ quoteHash: hashJson("smaller-quote"), ceilingUsd: 0.1 }),
      /decrease/,
    );
    const resumed = new DurableSpendLedger(root, "run-staged", contextHash);
    await resumed.reserve({
      requestId: second,
      requestHash: second,
      stage: "controls",
      maximumUsd: 0.05,
    });
    await resumed.reconcile(second, 0.04);
    const state = await resumed.read();
    assert.deepEqual(state.authorizations, [initialAuthorization, later]);
    assert.equal(
      state.entries.reduce((sum, entry) => sum + (entry.billedUsd ?? 0), 0),
      0.12,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spending operations reject a redirected artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-ledger-link-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "basalt-ledger-target-"));
  try {
    await mkdir(join(root, ".basalt-evals"));
    await symlink(elsewhere, join(root, ".basalt-evals/eval-operations"));
    await assert.rejects(
      new DurableSpendLedger(root, "run-link", contextHash).initialize(initialAuthorization),
      /Unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("actual billing above a reservation is retained and prevents further paid dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-ledger-overcharge-"));
  try {
    const ledger = new DurableSpendLedger(root, "run-overcharge", contextHash);
    await ledger.initialize({ ...initialAuthorization, ceilingUsd: 0.1 });
    const first = DurableSpendLedger.requestId("builder", "first");
    await ledger.reserve({
      requestId: first,
      requestHash: first,
      stage: "builder",
      maximumUsd: 0.09,
    });
    await ledger.reconcile(first, 0.12);
    assert.equal((await ledger.read()).entries[0]?.billedUsd, 0.12);
    const second = DurableSpendLedger.requestId("builder", "second");
    await assert.rejects(
      ledger.reserve({
        requestId: second,
        requestHash: second,
        stage: "builder",
        maximumUsd: 0.001,
      }),
      /ceiling/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite rolls back an interrupted transaction and retains a committed reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-journal-crash-"));
  try {
    const ledger = new DurableSpendLedger(root, "interrupted", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    await ledger.reserve({
      requestId: hashJson("request"),
      requestHash: hashJson("body"),
      stage: "builder",
      maximumUsd: 0.08,
    });
    const module = new URL("../packages/artifact-store/src/journal.js", import.meta.url).href;
    const script = `import { OperationJournal } from ${JSON.stringify(module)}; const journal = await OperationJournal.open(process.argv[1]); journal.transaction(() => { journal.put('spending', 'interrupted', { corrupt: true }); process.kill(process.pid, 'SIGKILL'); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], {
      stdio: "ignore",
    });
    const signal = await new Promise<string | null>((done, fail) => {
      child.once("error", fail);
      child.once("exit", (_code, signal) => done(signal));
    });
    assert.equal(signal, "SIGKILL");
    const resumed = new DurableSpendLedger(root, "interrupted", hashJson("context"));
    assert.equal((await resumed.read()).entries[0]?.reservedUsd, 0.08);
    await assert.rejects(
      resumed.reserve({
        requestId: hashJson("second"),
        requestHash: hashJson("second"),
        stage: "builder",
        maximumUsd: 0.01,
      }),
      /Another request has a pending charge/,
    );
    const journal = await OperationJournal.open(root);
    try {
      assert.throws(
        () =>
          journal.transaction(() => {
            journal.put("check", "one", { partial: true });
            throw new Error("abort");
          }),
        /abort/,
      );
      assert.equal(journal.read("check", "one"), null);
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent request claims allow exactly one reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-journal-concurrent-"));
  try {
    const ledger = new DurableSpendLedger(root, "concurrent", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 0.1 });
    const reservation = {
      requestId: hashJson("request"),
      requestHash: hashJson("body"),
      stage: "builder",
      maximumUsd: 0.02,
    };
    const results = await Promise.allSettled([
      ledger.reserve(reservation),
      new DurableSpendLedger(root, "concurrent", hashJson("context")).reserve(reservation),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal((await ledger.read()).entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
