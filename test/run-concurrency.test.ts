import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RunOperationEvent,
  RunOperationManifest,
  RunOperationStatus,
  RunUnit,
  SpendLedgerState,
} from "../packages/contracts/src/execution.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { BoundedModelClient } from "../packages/model-client/src/bounded-client.js";
import {
  ModelRequestPendingError,
  type ModelClient,
} from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger, SpendingCeilingError } from "../packages/model-client/src/ledger.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/openrouter-ai-sdk.js";
import { operationStatus } from "../packages/operator/src/operation.js";
import {
  dispatchableUnits,
  queuedStudioAdapter,
  runConcurrentUnits,
  StudioQueue,
  unitKey,
} from "../packages/operator/src/run-scheduler.js";
import type { StudioAdapter } from "../packages/studio-runner/src/adapter.js";
import {
  crashContext,
  crashModel,
  crashOperation,
  crashRequest,
  crashStages,
} from "./concurrent-dispatch-child.js";

const spending: SpendLedgerState = {
  schema: "basalt-evals/spend-ledger",
  operationId: "memory-run",
  contextHash: hashJson("context"),
  authorizations: [{ quoteHash: hashJson("quote"), ceilingUsd: 1 }],
  entries: [],
};

/** A frozen run of generated builds, with one observation and one judgment for each build. */
function manifest(builds: string[]): RunOperationManifest {
  return {
    id: "memory-run",
    gradingMode: "all",
    protocol: null,
    gates: [],
    subjects: builds.map((id) => ({
      id,
      evalId: "evaluation",
      kind: "generated",
      stageIndex: 1,
      parentSubjectId: null,
      builder: { id, model: { id: "model" } },
      sourceId: null,
      parentSourceId: null,
      publicFeedbackId: null,
    })),
    captureCells: builds.map((id) => ({
      id: `capture-${id}`,
      treatmentId: id,
      viewId: "default",
      pass: 1,
      requires: [],
    })),
    gradingCells: [],
    judgmentBatches: builds.map((id) => ({
      id: `judgment-${id}`,
      captureCellId: `capture-${id}`,
      criterionIds: ["criterion"],
      substitution: null,
    })),
    planned: { independentBuilderTrials: builds.length },
  } as unknown as RunOperationManifest;
}

/** An in-memory event chain. The real replay validates each append, also for overlap. */
class MemoryRun {
  readonly events: RunOperationEvent[] = [];
  constructor(readonly manifest: RunOperationManifest) {}

  status(): RunOperationStatus {
    return operationStatus(this.manifest, this.events, spending, []);
  }

  append(kind: RunOperationEvent["kind"], unit: RunUnit, artifacts = 0) {
    const body = {
      schema: "basalt-evals/run-operation-event" as const,
      sequence: this.events.length + 1,
      previousHash: this.events.at(-1)?.id ?? null,
      kind,
      stage: unit.stage,
      unitId: unit.unitId,
      artifactHashes: Array.from({ length: artifacts }, (_, index) =>
        hashJson([unit.unitId, index]),
      ),
      reason: null,
      at: new Date().toISOString(),
    };
    const event = { ...body, id: hashJson(body) };
    operationStatus(this.manifest, [...this.events, event], spending, []);
    this.events.push(event);
  }
}

interface Span {
  name: string;
  start: number;
  end: number;
}

const overlaps = (left: Span, right: Span) => left.start < right.end && right.start < left.end;

/**
 * Fake units: a build makes a model turn, one public Studio test and one more model turn. An
 * observation is one Studio job. A judgment is one long model request. Studio jobs go through
 * the queue of the run, and the fake Studio counts the jobs that run at the same time.
 */
function fakeRun(builds: string[], timing = { model: 40, studio: 20, judge: 60 }, lanes = 1) {
  const run = new MemoryRun(manifest(builds));
  const spans: Span[] = [];
  let studioActive = 0;
  let studioMaximum = 0;
  const fakeStudio: StudioAdapter = {
    async capabilities() {
      throw new Error("Not used");
    },
    async preflight() {
      return [];
    },
    async identity() {
      throw new Error("Not used");
    },
    async run(input) {
      studioActive += 1;
      studioMaximum = Math.max(studioMaximum, studioActive);
      try {
        await delay(timing.studio, undefined, input.signal ? { signal: input.signal } : {});
      } finally {
        studioActive -= 1;
      }
      return {} as Awaited<ReturnType<StudioAdapter["run"]>>;
    },
    async reconcile() {
      throw new Error("Not used");
    },
  };
  const queue = new StudioQueue(lanes);
  const studio = queuedStudioAdapter(fakeStudio, queue);
  const span = async (name: string, milliseconds: number, signal: AbortSignal) => {
    const start = performance.now();
    await delay(milliseconds, undefined, { signal });
    spans.push({ name, start, end: performance.now() });
  };
  const studioJob = async (name: string, signal: AbortSignal, admitted?: () => void) => {
    const admission = await studio.admit!({
      root: "",
      directory: name,
      purpose: name.startsWith("development:") ? "development" : "final_capture",
      signal,
    });
    try {
      admitted?.();
      const start = performance.now();
      await studio.run({ root: "", directory: name, signal });
      spans.push({ name, start, end: performance.now() });
    } finally {
      await admission.release();
    }
  };
  const execute =
    (signal: AbortSignal, drain: AbortSignal, hooks: { buildTurn?: () => Promise<void> } = {}) =>
    async (unit: RunUnit) => {
      if (unit.stage === "builder") {
        run.append("started", unit);
        await (hooks.buildTurn?.() ?? span(`model-1:${unit.unitId}`, timing.model, signal));
        // A drained build stops at its next boundary and stays in flight.
        if (drain.aborted) throw new Error("Interrupted at the next request boundary");
        await studioJob(`development:${unit.unitId}`, signal);
        await span(`model-2:${unit.unitId}`, timing.model, signal);
        run.append("completed", unit, 2);
      } else if (unit.stage === "final_capture") {
        await studioJob(`capture:${unit.unitId}`, signal, () => run.append("started", unit));
        run.append("completed", unit, 2);
      } else if (unit.stage === "judgment") {
        run.append("started", unit);
        await span(`judge:${unit.unitId}`, timing.judge, signal);
        run.append("completed", unit, 1);
      } else if (unit.stage === "report") {
        run.append("started", unit);
        run.append("completed", unit, 1);
      } else throw new Error(`Unexpected unit ${unitKey(unit)}`);
    };
  return { run, spans, queue, execute, studioMaximum: () => studioMaximum };
}

async function drive(
  fake: ReturnType<typeof fakeRun>,
  options: {
    limits?: { builder: number; judgment: number };
    signal?: AbortSignal;
    hooks?: Parameters<ReturnType<typeof fakeRun>["execute"]>[2];
  } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const drain = new AbortController();
  drain.signal.addEventListener("abort", () => fake.queue.close(new Error("Drained")));
  await runConcurrentUnits({
    status: async () => fake.run.status(),
    unownedPending: async () => false,
    execute: fake.execute(signal, drain.signal, options.hooks),
    fatal: async () => true,
    idle: async () => false,
    signal,
    drain,
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

test("a development run takes the next Studio turn before the final captures that wait", async () => {
  const queue = new StudioQueue();
  const order: string[] = [];
  const holder = await queue.acquire(false);
  const job = async (name: string, development: boolean) => {
    const end = await queue.acquire(development);
    order.push(name);
    end();
  };
  const jobs = [job("capture-1", false), job("capture-2", false)];
  await delay(1);
  jobs.push(job("development-1", true));
  await delay(1);
  jobs.push(job("development-2", true));
  await delay(1);
  holder();
  await Promise.all(jobs);
  // Inside each kind, the first caller goes first.
  assert.deepEqual(order, ["development-1", "development-2", "capture-1", "capture-2"]);
});

test("a queue with two turns runs two Studio jobs at once and keeps development first", async () => {
  const queue = new StudioQueue(2);
  const order: string[] = [];
  const first = await queue.acquire(false);
  // The second turn is free, so the next caller does not wait.
  const second = await queue.acquire(false);
  const job = async (name: string, development: boolean) => {
    const end = await queue.acquire(development);
    order.push(name);
    return end;
  };
  const capture = job("capture-1", false);
  await delay(1);
  const development = job("development-1", true);
  await delay(1);
  assert.deepEqual(order, [], "Both turns are in use");
  first();
  const developmentEnd = await development;
  assert.deepEqual(order, ["development-1"], "A free turn goes to the development run first");
  second();
  const captureEnd = await capture;
  assert.deepEqual(order, ["development-1", "capture-1"]);
  developmentEnd();
  captureEnd();
  // Each ended turn is free again, so two new jobs start without a wait.
  const again = [await queue.acquire(false), await queue.acquire(true)];
  for (const end of again) end();
  assert.throws(() => new StudioQueue(0), /at least one turn/);
});

test("with two Studio lanes, at most two Studio jobs run at the same time", async () => {
  const fake = fakeRun(["a", "b", "c", "d"], { model: 10, studio: 40, judge: 10 }, 2);
  await drive(fake);
  assert.equal(fake.studioMaximum(), 2, "Two Studio jobs overlap, and never three");
});

test("the judgment of an observation overlaps the next build, and the run ends after all units", async () => {
  const fake = fakeRun(["first", "second"]);
  // One build at a time shows the pipeline: the first judgment runs during the second build.
  await drive(fake, { limits: { builder: 1, judgment: 6 } });
  const at = (name: string) => fake.spans.find((item) => item.name === name)!;
  const second: Span = {
    name: "second",
    start: at("model-1:second").start,
    end: at("model-2:second").end,
  };
  assert.ok(overlaps(at("judge:judgment-first"), second), "Judgment waits for no later build");
  assert.ok(at("capture:capture-first").end <= at("judge:judgment-first").start);
  const status = fake.run.status();
  assert.equal(status.finished, true);
  assert.deepEqual(status.inFlightUnits, []);
  assert.equal(status.completedUnits.length, 7, "2 builds, 2 observations, 2 judgments, report");
});

test("model turns of two builds overlap, and their Studio steps never overlap", async () => {
  const fake = fakeRun(["first", "second", "third"]);
  await drive(fake);
  const at = (name: string) => fake.spans.find((item) => item.name === name)!;
  assert.ok(overlaps(at("model-1:first"), at("model-1:second")), "Model turns run together");
  assert.ok(overlaps(at("model-1:second"), at("model-1:third")));
  const studio = fake.spans.filter(
    (item) => item.name.startsWith("development:") || item.name.startsWith("capture:"),
  );
  assert.equal(studio.length, 6, "3 public Studio tests and 3 observations");
  for (const [index, left] of studio.entries())
    for (const right of studio.slice(index + 1))
      assert.ok(!overlaps(left, right), `${left.name} overlaps ${right.name}`);
  assert.equal(fake.studioMaximum(), 1, "One Studio job at a time");
  assert.equal(fake.run.status().finished, true);
});

test("Stop ends all concurrent units promptly and leaves them recoverable", async () => {
  // The test never waits for these 60 s units. Stop must end them long before they end.
  const fake = fakeRun(["done", "first", "second"], {
    model: 60_000,
    studio: 60_000,
    judge: 60_000,
  });
  // An earlier build completed, so its observation waits in the Studio queue behind a holder.
  fake.run.append("started", { stage: "builder", unitId: "done" });
  fake.run.append("completed", { stage: "builder", unitId: "done" }, 2);
  const holder = await fake.queue.acquire(false);
  const stop = new AbortController();
  const started = performance.now();
  setTimeout(() => stop.abort(new Error("Operator stopped the run")), 50);
  await drive(fake, { signal: stop.signal });
  holder();
  assert.ok(performance.now() - started < 20_000, "Stop does not wait for the model turns");
  const status = fake.run.status();
  assert.equal(status.stopped, false, "The fake run has no stop event; the driver saw the abort");
  assert.deepEqual(
    status.inFlightUnits.map(unitKey).sort(),
    ["builder:first", "builder:second"],
    "Both builds stay in flight for a later resume",
  );
  assert.ok(
    !status.events.some((event) => event.stage === "final_capture"),
    "The queued observation records nothing: it never started",
  );
  // Resume after the stop: the interrupted builds continue first.
  assert.deepEqual(
    dispatchableUnits(status, { running: new Set(), unownedPending: false }).slice(0, 2),
    [
      { stage: "builder", unitId: "first" },
      { stage: "builder", unitId: "second" },
    ],
  );
});

test("a failure that stops the run drains the other units and starts no new work", async () => {
  const fake = fakeRun(["first", "second", "third"], { model: 40, studio: 20, judge: 20 });
  let turns = 0;
  await assert.rejects(
    drive(fake, {
      limits: { builder: 2, judgment: 6 },
      hooks: {
        async buildTurn() {
          turns += 1;
          if (turns === 1) throw new Error("Studio failed for the first build");
          await delay(40);
        },
      },
    }),
    /Studio failed for the first build/,
  );
  const status = fake.run.status();
  assert.deepEqual(
    status.inFlightUnits.map(unitKey).sort(),
    ["builder:first", "builder:second"],
    "The failed build and the drained build stay in flight; the third build never started",
  );
  assert.equal(turns, 2);
});

test("the event chain accepts overlapping units, and a report or a repeat start cannot overlap", () => {
  const run = new MemoryRun(manifest(["first", "second"]));
  run.append("started", { stage: "builder", unitId: "first" });
  run.append("started", { stage: "builder", unitId: "second" });
  assert.deepEqual(run.status().inFlightUnits.map(unitKey), ["builder:first", "builder:second"]);
  assert.throws(() => run.append("started", { stage: "builder", unitId: "first" }), /twice/);
  run.append("completed", { stage: "builder", unitId: "first" }, 2);
  run.append("started", { stage: "final_capture", unitId: "capture-first" });
  assert.deepEqual(run.status().inFlightUnits.map(unitKey), [
    "builder:second",
    "final_capture:capture-first",
  ]);
  assert.throws(
    () => run.append("started", { stage: "report", unitId: "final" }),
    /cannot overlap/,
  );
  assert.throws(
    () => run.append("completed", { stage: "builder", unitId: "third" }, 2),
    /no matching start/,
  );
  run.append("completed", { stage: "final_capture", unitId: "capture-first" }, 2);
  run.append("failed", { stage: "builder", unitId: "second" });
  run.append("started", { stage: "report", unitId: "final" });
  assert.throws(
    () => run.append("started", { stage: "judgment", unitId: "judgment-first" }),
    /cannot overlap/,
    "Nothing starts beside the report",
  );
});

/** Poll a condition. Journal writes use full synchronization, so a loaded machine is slow. */
async function until(condition: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true in time");
    await delay(5);
  }
}

test("the spending limit holds under concurrent reservations, and a held request lets others wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-concurrent-ledger-"));
  // The test ends each wait before it removes the journal.
  const end = new AbortController();
  const reservations: Array<Promise<unknown>> = [];
  try {
    const ledger = new DurableSpendLedger(root, "concurrent-ledger", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const committed = async () =>
      (await ledger.read()).entries.reduce(
        (sum, entry) => sum + (entry.status === "billed" ? entry.billedUsd! : entry.reservedUsd),
        0,
      );
    const id = (index: number) => hashJson(["request", index]);
    const reserved: number[] = [];
    // Five units reserve 0.30 each at once. Three fit; two wait for held requests to settle.
    for (const index of [0, 1, 2, 3, 4])
      reservations.push(
        ledger
          .reserve({
            requestId: id(index),
            requestHash: id(index),
            stage: `builder:unit-${index}`,
            maximumUsd: 0.3,
            hold: true,
            signal: end.signal,
          })
          .then(() => reserved.push(index)),
      );
    await until(() => reserved.length === 3);
    await delay(100);
    assert.deepEqual(reserved, [0, 1, 2], "Reservations keep their arrival sequence");
    assert.equal((await ledger.read()).entries.length, 3, "The other two wait");
    assert.ok((await committed()) <= 1 + 1e-12);
    await ledger.reconcile(id(0), 0.05);
    await until(() => reserved.length === 4);
    assert.deepEqual(reserved, [0, 1, 2, 3], "The first waiter fits after a settlement");
    assert.ok((await committed()) <= 1 + 1e-12);
    await ledger.reconcile(id(1), 0.05);
    await Promise.all(reservations);
    assert.deepEqual(reserved, [0, 1, 2, 3, 4]);
    assert.ok((await committed()) <= 1 + 1e-12);
    // A request that cannot fit when all held requests settle fails at once.
    await assert.rejects(
      ledger.reserve({
        requestId: id(9),
        requestHash: id(9),
        stage: "judgment:large",
        maximumUsd: 1.5,
        hold: true,
      }),
      SpendingCeilingError,
    );
    // A stop ends a wait without an entry.
    const stop = new AbortController();
    const waiting = ledger.reserve({
      requestId: id(5),
      requestHash: id(5),
      stage: "builder:stopped",
      maximumUsd: 0.3,
      hold: true,
      signal: stop.signal,
    });
    await delay(100);
    stop.abort(new Error("Operator stopped the run"));
    await assert.rejects(waiting, /Operator stopped the run/);
    assert.ok(!(await ledger.read()).entries.some((entry) => entry.requestId === id(5)));
    // A pending charge without a live holder blocks every new reservation.
    ledger.release(id(2));
    assert.deepEqual(
      (await ledger.unownedPending()).map((entry) => entry.requestId),
      [id(2)],
    );
    await assert.rejects(
      ledger.reserve({
        requestId: id(6),
        requestHash: id(6),
        stage: "builder:blocked",
        maximumUsd: 0,
        hold: true,
      }),
      /pending charge/,
    );
  } finally {
    end.abort(new Error("The test ended"));
    await Promise.allSettled(reservations);
    await rm(root, { recursive: true, force: true });
  }
});

test("a charge that settles after a ledger read is not an unowned charge", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-settled-read-"));
  try {
    const ledger = new DurableSpendLedger(root, "settled-read", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const requestId = hashJson("settled request");
    await ledger.reserve({
      requestId,
      requestHash: requestId,
      stage: "builder:other-build",
      maximumUsd: 0.2,
      hold: true,
    });
    // A unit reads the ledger. Another build then settles its charge and releases its hold.
    const earlier = await ledger.read();
    await ledger.reconcile(requestId, 0.05);
    assert.equal(ledger.unownedIn(earlier).length, 1, "The older state shows a stale entry");
    assert.deepEqual(await ledger.unownedPending(), [], "A new read finds no unowned charge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after a crash with two dispatched requests, resume sends neither request again", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-concurrent-crash-"));
  try {
    const ledger = new DurableSpendLedger(root, crashOperation, crashContext);
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 10 });
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, "concurrent-dispatch-child.js"), root],
      { stdio: "ignore" },
    );
    const signal = await new Promise<NodeJS.Signals | null>((done) =>
      child.once("exit", (_code, killed) => done(killed)),
    );
    assert.equal(signal, "SIGKILL", "The run process crashed during two paid requests");
    assert.equal((await readFile(join(root, "dispatches.log"), "utf8")).split("\n").length - 1, 2);
    const saved = await ledger.read();
    assert.deepEqual(
      saved.entries.map((entry) => [entry.stage, entry.status]).sort(),
      crashStages.map((stage) => [stage, "pending"]).sort(),
      "Both units reserved and dispatched at the same time",
    );
    assert.equal(ledger.unownedIn(saved).length, 2, "No live process holds the requests");
    let dispatches = 0;
    const client: ModelClient = {
      observesDispatch: true,
      descriptor: openRouterModelClientDescriptor([crashModel.id]),
      async complete(_request, _signal, observer) {
        await observer!.beforeDispatch();
        dispatches += 1;
        throw new Error("A resumed unit must not dispatch");
      },
    };
    const resume = (stage: string) =>
      new BoundedModelClient(client, ledger, [crashModel], stage).complete(crashRequest);
    for (const stage of crashStages)
      await assert.rejects(resume(stage), (error) => {
        assert.ok(error instanceof ModelRequestPendingError);
        assert.match(error.message, /cannot send it again/);
        return true;
      });
    await assert.rejects(resume("builder:third"), /pending charge/);
    assert.equal(dispatches, 0);
    // Check payment status bills the requests. Their responses are lost, so they stay unsent.
    for (const entry of saved.entries) await ledger.reconcile(entry.requestId, 0.01);
    for (const stage of crashStages)
      await assert.rejects(resume(stage), /no complete response.*cannot send it again/);
    assert.equal(dispatches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed run continues interrupted units first and starts no paid unit beside an unknown charge", () => {
  const run = new MemoryRun(manifest(["first", "second", "third"]));
  run.append("started", { stage: "builder", unitId: "first" });
  run.append("completed", { stage: "builder", unitId: "first" }, 2);
  run.append("started", { stage: "builder", unitId: "second" });
  run.append("started", { stage: "final_capture", unitId: "capture-first" });
  const status = run.status();
  assert.deepEqual(dispatchableUnits(status, { running: new Set(), unownedPending: false }), [
    { stage: "builder", unitId: "second" },
    { stage: "final_capture", unitId: "capture-first" },
    { stage: "builder", unitId: "third" },
  ]);
  assert.deepEqual(
    dispatchableUnits(status, { running: new Set(), unownedPending: true }),
    [
      { stage: "builder", unitId: "second" },
      { stage: "final_capture", unitId: "capture-first" },
    ],
    "The interrupted build reconciles its charge; no new build starts",
  );
  assert.deepEqual(
    dispatchableUnits(status, {
      running: new Set(["builder:second", "final_capture:capture-first"]),
      unownedPending: false,
      limits: { builder: 1, judgment: 6 },
    }),
    [],
    "The build limit counts the builds that run",
  );
});
