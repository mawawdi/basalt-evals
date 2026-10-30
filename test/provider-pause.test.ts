import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { BoundedAgentCheckpoint } from "../packages/agent-runtime/src/checkpoint.js";
import { AgentProviderPaused, runAgent } from "../packages/agent-runtime/src/index.js";
import {
  completeWithinRetries,
  ProviderPauseError,
} from "../packages/agent-runtime/src/retries.js";
import type {
  PauseRecord,
  RunOperationEvent,
  RunOperationManifest,
  RunUnit,
  SpendLedgerState,
} from "../packages/contracts/src/execution.js";
import { assertAgentRun, hashJson } from "../packages/contracts/src/index.js";
import {
  BoundedModelClient,
  ProviderHoldError,
  type RequestCheck,
} from "../packages/model-client/src/bounded-client.js";
import type { ModelTurnRequest, ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import {
  operationStatus,
  providerHolds,
  providerPausedUnits,
  unitHold,
} from "../packages/operator/src/operation.js";
import { dispatchableUnits } from "../packages/operator/src/run-scheduler.js";
import { readLifecycle } from "../packages/operator/src/lifecycle.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import {
  builderAnswer,
  builderSnapshot,
  builderTask,
  builderTreatment,
  builderWorkspace,
  FAKE_MODEL,
  providerRejection,
  scriptedTransport,
} from "./builder-fixture.js";

const eligible = async () => ({ gate: "eligible" as const, reasons: [], checks: [] });

/** One build attempt of the fixture task on a bounded client, as the builder stage runs it. */
async function attempt(input: {
  workspace: string;
  ledger: DurableSpendLedger;
  transport: ReturnType<typeof scriptedTransport>;
  saved: { state: BoundedAgentCheckpoint; completedCalls: number } | null;
  beforeRequest?: RequestCheck;
  onCheckpoint: (state: BoundedAgentCheckpoint, completedCalls: number) => void;
}) {
  const client = new BoundedModelClient(
    input.transport,
    input.ledger,
    [builderSnapshot()],
    "builder:pause",
    false,
    input.beforeRequest,
    input.saved?.completedCalls ?? 0,
  );
  return runAgent({
    outputTokens: () => 8192,
    workspaceRoot: input.workspace,
    task: builderTask,
    treatment: builderTreatment(),
    modelClient: client,
    verify: eligible,
    retainInterruption: true,
    ...(input.saved ? { resume: input.saved.state } : {}),
    checkpoint: async (state) => input.onCheckpoint(structuredClone(state), client.completedCalls),
  });
}

async function ledgerIn(root: string) {
  const ledger = new DurableSpendLedger(root, "provider-pause", hashJson("context"));
  await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
  return ledger;
}

test("a payment rejection pauses the build at its checkpoint and sends no further request", async () => {
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-provider-pause-"));
  try {
    const ledger = await ledgerIn(root);
    const transport = scriptedTransport([
      (request) => providerRejection(request, 402, "payment_required"),
      (request) => builderAnswer(request, 1),
      (request) => builderAnswer(request, 2),
    ]);
    let saved: { state: BoundedAgentCheckpoint; completedCalls: number } | null = null;
    const onCheckpoint = (state: BoundedAgentCheckpoint, completedCalls: number) => {
      saved = { state, completedCalls };
    };
    await assert.rejects(
      attempt({ workspace, ledger, transport, saved, onCheckpoint }),
      (error: unknown) =>
        error instanceof AgentProviderPaused &&
        error.pause.scope === "account" &&
        error.pause.errorClass === "http_402" &&
        error.pause.hold === null,
    );
    assert.equal(transport.dispatches, 1, "the paused build sends no further request");
    const paused = saved! as { state: BoundedAgentCheckpoint; completedCalls: number };
    assert.equal(paused.state.point, "before_model");
    assert.equal(paused.state.turn, 1);
    assert.equal(paused.state.pausedCalls, 1);
    assert.equal(paused.state.usage.calls, 1, "the rejected request is a call without a turn");
    assert.equal(paused.completedCalls, 1);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => [entry.status, entry.billedUsd]),
      [["billed", 0]],
      "the rejection is a known zero charge",
    );

    // An explicit resume continues the same turn as the next request ordinal.
    const run = await attempt({ workspace, ledger, transport, saved: paused, onCheckpoint });
    assertAgentRun(run);
    assert.equal(run.status, "locally_eligible");
    assert.equal(run.usage.calls, 3);
    assert.equal(transport.dispatches, 3);
    assert.deepEqual(
      run.trace.filter((event) => event.kind === "model_response").map((event) => event.data.kind),
      ["provider_paused", "assistant", "assistant"],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a context-length rejection keeps the incomplete outcome", async () => {
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-provider-context-"));
  try {
    const ledger = await ledgerIn(root);
    const transport = scriptedTransport([
      (request) => providerRejection(request, 400, "context_length_exceeded"),
    ]);
    const run = await attempt({
      workspace,
      ledger,
      transport,
      saved: null,
      onCheckpoint: () => {},
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.stopReason, "provider_error");
    assert.equal(run.failure?.classification, "provider_or_transport_failure");
    assert.equal(transport.dispatches, 1);
    assert.equal(
      run.trace.some((event) => event.data.kind === "provider_paused"),
      false,
      "a request failure never pauses the build",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

const spending = (ceilingUsd = 1): SpendLedgerState => ({
  schema: "basalt-evals/spend-ledger",
  operationId: "pause-run",
  contextHash: hashJson("context"),
  authorizations: [
    { quoteHash: hashJson("quote"), ceilingUsd: 1 },
    ...(ceilingUsd > 1 ? [{ quoteHash: hashJson("quote"), ceilingUsd }] : []),
  ],
  entries: [],
});

/** A frozen run whose builds use the given models. Each judgment uses the judge model. */
function manifest(builds: Record<string, string>): RunOperationManifest {
  const ids = Object.keys(builds);
  return {
    id: "pause-run",
    gradingMode: "all",
    protocol: null,
    gates: [],
    subjects: ids.map((id) => ({
      id,
      evalId: "evaluation",
      kind: "generated",
      stageIndex: 1,
      parentSubjectId: null,
      builder: { id, model: { id: builds[id] } },
      sourceId: null,
      parentSourceId: null,
      publicFeedbackId: null,
    })),
    captureCells: ids.map((id) => ({
      id: `capture-${id}`,
      treatmentId: id,
      viewId: "default",
      pass: 1,
      requires: [],
    })),
    gradingCells: [],
    judgmentBatches: ids.map((id) => ({
      id: `judgment-${id}`,
      captureCellId: `capture-${id}`,
      criterionIds: ["criterion"],
      substitution: null,
      configuration: { modelId: "judge/model" },
    })),
    planned: { independentBuilderTrials: ids.length },
  } as unknown as RunOperationManifest;
}

/** An in-memory event chain with its pause records. The real replay validates each append. */
class MemoryRun {
  readonly events: RunOperationEvent[] = [];
  readonly records: Record<string, PauseRecord> = {};
  constructor(readonly manifest: RunOperationManifest) {}

  status(ceilingUsd = 1) {
    return operationStatus(this.manifest, this.events, spending(ceilingUsd), [], this.records);
  }

  append(
    kind: RunOperationEvent["kind"],
    unit: RunUnit | null,
    artifactHashes: string[] = [],
    record?: PauseRecord,
  ) {
    const body = {
      schema: "basalt-evals/run-operation-event" as const,
      sequence: this.events.length + 1,
      previousHash: this.events.at(-1)?.id ?? null,
      kind,
      stage: unit?.stage ?? null,
      unitId: unit?.unitId ?? null,
      artifactHashes,
      reason: null,
      at: new Date().toISOString(),
    };
    const event = { ...body, id: hashJson(body) };
    const records = record ? { ...this.records, [hashJson(record)]: record } : this.records;
    operationStatus(this.manifest, [...this.events, event], spending(), [], records);
    this.events.push(event);
    if (record) this.records[hashJson(record)] = record;
  }

  complete(unit: RunUnit, artifacts: number) {
    this.append("started", unit);
    this.append(
      "completed",
      unit,
      Array.from({ length: artifacts }, (_, index) => hashJson([unit.unitId, index])),
    );
  }

  pause(unit: RunUnit, record: PauseRecord) {
    this.append("provider_paused", unit, [hashJson(record)], record);
  }
}

const pauseRecord = (
  scope: PauseRecord["scope"],
  errorClass: string,
  dependency: string | null = null,
  ordinal: number | null = 1,
): PauseRecord => ({
  scope,
  dependency,
  errorClass,
  failureId: hashJson([scope, errorClass, ordinal]),
  ordinal,
});

const idle = { running: new Set<string>(), unownedPending: false };
const builder = (unitId: string): RunUnit => ({ stage: "builder", unitId });

test("an account rejection holds every paid unit before its next request", async () => {
  const run = new MemoryRun(manifest({ done: "m1", sealed: "m1", a: "m1", b: "m2" }));
  run.complete(builder("done"), 2);
  run.complete({ stage: "final_capture", unitId: "capture-done" }, 2);
  run.complete(builder("sealed"), 2);
  run.append("started", builder("a"));
  const account = pauseRecord("account", "http_401");
  run.pause(builder("a"), account);
  const status = run.status();
  // Studio work continues. No build and no judgment of any model starts.
  assert.deepEqual(dispatchableUnits(status, idle), [
    { stage: "final_capture", unitId: "capture-sealed" },
  ]);
  const holds = providerHolds(status);
  for (const unit of [builder("b"), { stage: "judgment" as const, unitId: "judgment-done" }])
    assert.deepEqual(unitHold(holds, status.manifest, unit), account);
  assert.equal(unitHold(holds, status.manifest, { stage: "seal", unitId: "done" }), null);

  // A build in flight meets the hold before its next request and sends nothing.
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-provider-hold-"));
  try {
    const transport = scriptedTransport([]);
    let saved: BoundedAgentCheckpoint | null = null;
    await assert.rejects(
      attempt({
        workspace,
        ledger: await ledgerIn(root),
        transport,
        saved: null,
        beforeRequest: async () => {
          const hold = unitHold(providerHolds(run.status()), status.manifest, builder("b"));
          if (hold) throw new ProviderHoldError(hold);
        },
        onCheckpoint: (state) => (saved = state),
      }),
      (error: unknown) =>
        error instanceof AgentProviderPaused && hashJson(error.pause.hold) === hashJson(account),
    );
    assert.equal(transport.dispatches, 0);
    const held = saved! as BoundedAgentCheckpoint;
    assert.equal(held.point, "before_model");
    assert.equal(held.usage.calls, 0, "a hold before dispatch is no call");
    assert.equal(held.pausedCalls, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("two persistent failures of one model pause the other units of that model", () => {
  const run = new MemoryRun(manifest({ a: "m1", b: "m1", c: "m1", d: "m2" }));
  const dependency = hashJson({ model: "m1", endpoints: ["fake"] });
  run.append("started", builder("a"));
  run.pause(builder("a"), pauseRecord("persistent", "http_429", dependency, 4));
  // One persistent failure pauses only its own unit. The other builds of the model start, after
  // the first build of the other model.
  assert.equal(providerHolds(run.status()).models.size, 0);
  assert.deepEqual(
    dispatchableUnits(run.status(), { ...idle, limits: { builder: 3, judgment: 1 } }),
    [builder("d"), builder("b"), builder("c")],
  );
  run.append("started", builder("b"));
  const second = pauseRecord("persistent", "http_503", dependency, 2);
  run.pause(builder("b"), second);
  const status = run.status();
  assert.deepEqual(unitHold(providerHolds(status), status.manifest, builder("c")), second);
  assert.equal(unitHold(providerHolds(status), status.manifest, builder("d")), null);
  assert.deepEqual(dispatchableUnits(status, idle), [builder("d")]);
});

test("only an explicit resume re-admits a provider pause; a raised limit does not", () => {
  const run = new MemoryRun(manifest({ a: "m1", b: "m1" }));
  run.append("started", builder("a"));
  run.pause(builder("a"), pauseRecord("account", "http_402"));
  assert.deepEqual(dispatchableUnits(run.status(), idle), []);
  assert.deepEqual(dispatchableUnits(run.status(5), idle), [], "a raised limit admits nothing");
  run.append("stop_requested", null);
  run.append("resumed", null);
  assert.deepEqual(
    providerPausedUnits(run.status()).map((pause) => pause.admitted),
    [true],
  );
  // The paused build continues first. The resume also releases the hold for new builds.
  assert.deepEqual(dispatchableUnits(run.status(), idle), [builder("a"), builder("b")]);
});

test("a resumed judgment skips its acknowledged rejection and sends the next ordinal", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-provider-judgment-"));
  try {
    const ledger = await ledgerIn(root);
    const request: ModelTurnRequest = {
      model: FAKE_MODEL,
      seed: 1,
      system: "Check the evidence.",
      messages: [{ role: "user", content: "Check." }],
      tools: [],
      maxOutputTokens: 100,
    };
    const transport = scriptedTransport([
      (sent) => providerRejection(sent, 402, "payment_required"),
      (sent) => builderAnswer(sent, 1),
    ]);
    const client = (acknowledged: number[] = [], replayOnly = false) =>
      new BoundedModelClient(
        transport,
        ledger,
        [builderSnapshot()],
        "judgment:batch",
        replayOnly,
        undefined,
        0,
        acknowledged,
      );
    const parse = (response: ModelTurnResult) => {
      if (response.kind !== "assistant") throw new Error("The judge gave no answer");
      return response.responseHash;
    };
    await assert.rejects(
      completeWithinRetries(client(), request, parse),
      (error: unknown) =>
        error instanceof ProviderPauseError && error.scope === "account" && error.ordinal === 1,
    );
    // Without the acknowledgment, the saved rejection replays and pauses again. It is not sent.
    await assert.rejects(completeWithinRetries(client(), request, parse), ProviderPauseError);
    assert.equal(transport.dispatches, 1);
    const resumed = await completeWithinRetries(client([1]), request, parse);
    assert.equal(resumed.ordinal, 2);
    assert.equal(transport.dispatches, 2);
    // A verification replay with the same acknowledgment reads the saved answer.
    const replay = await completeWithinRetries(client([1], true), request, parse);
    assert.equal(replay.value, resumed.value);
    assert.equal(transport.dispatches, 2);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => entry.billedUsd),
      [0, 0.00001],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the event chain accepts a provider pause only for a build or judgment with one hash", () => {
  const record = pauseRecord("model", "http_404", hashJson("dependency"));
  const chain = () => {
    const run = new MemoryRun(manifest({ a: "m1" }));
    run.complete(builder("a"), 2);
    run.append("started", { stage: "final_capture", unitId: "capture-a" });
    return run;
  };
  assert.throws(
    () => chain().pause({ stage: "final_capture", unitId: "capture-a" }, record),
    /Only a build or judgment/u,
  );
  const twoHashes = new MemoryRun(manifest({ a: "m1" }));
  twoHashes.append("started", builder("a"));
  assert.throws(
    () =>
      twoHashes.append(
        "provider_paused",
        builder("a"),
        [hashJson(record), hashJson("other")],
        record,
      ),
    /Only a build or judgment/u,
  );
  assert.throws(
    () => twoHashes.append("provider_paused", builder("a"), [hashJson(record)]),
    /does not bind its saved pause record/u,
  );
  // A valid pause releases the attempt, so the build can start again after Resume.
  const run = new MemoryRun(manifest({ a: "m1" }));
  for (let pause = 1; pause <= 8; pause += 1) {
    run.append("started", builder("a"));
    run.pause(builder("a"), pauseRecord("persistent", "http_429", hashJson("dependency"), pause));
    assert.deepEqual(run.status().inFlightUnits, []);
  }
  run.append("started", builder("a"));
  assert.throws(
    () => run.pause(builder("a"), pauseRecord("persistent", "http_429", hashJson("d"), 9)),
    /limit of provider pauses/u,
  );
});

test("Resume stays available beside a provider pause at the unchanged spending limit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-provider-lifecycle-"));
  try {
    const journal = await OperationJournal.open(root);
    try {
      const lifecycle = (providerPauses: unknown[]) => {
        journal.put("operation_progress", "paused-run", {
          manifest: { id: "paused-run", planned: {} },
          stopped: false,
          finished: false,
          inFlightUnits: [],
          pausedAuthorizationHashes: [hashJson("limit")],
          providerPauses,
        });
        journal.put("spending_progress", "paused-run", {
          pendingBilling: false,
          availableUsd: 0,
          authorizationHash: hashJson("limit"),
        });
        journal.put("drivers", "paused-run", {
          token: "owner",
          pid: process.pid,
          active: false,
          error: "The run paused.",
          waiting: null,
        });
        return readLifecycle(journal, "paused-run").capabilities.resume.allowed;
      };
      assert.equal(lifecycle([]), false, "a spending pause alone needs a higher limit");
      assert.equal(
        lifecycle([{ stage: "builder", unitId: "a", scope: "account", errorClass: "http_402" }]),
        true,
      );
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
