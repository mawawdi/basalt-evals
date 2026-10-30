import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { BoundedAgentCheckpoint } from "../packages/agent-runtime/src/checkpoint.js";
import { AgentInterrupted, runAgent } from "../packages/agent-runtime/src/index.js";
import type {
  RunOperationEvent,
  RunOperationManifest,
  RunUnit,
  SpendLedgerState,
} from "../packages/contracts/src/execution.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import {
  BoundedModelClient,
  ProviderHoldError,
} from "../packages/model-client/src/bounded-client.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import {
  ModelRequestAdmissionError,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { previewOperationLaunch } from "../packages/operator/src/launch.js";
import { ModelPermits } from "../packages/operator/src/model-permits.js";
import { setModelConcurrency } from "../packages/operator/src/model-registry.js";
import { operationStatus } from "../packages/operator/src/operation.js";
import { assertManifest } from "../packages/operator/src/run-manifest.js";
import {
  freezeRegisteredEvalRun,
  quoteRegisteredEvalRun,
} from "../packages/operator/src/run-plan.js";
import { dispatchableUnits, StudioQueue } from "../packages/operator/src/run-scheduler.js";
import { registerSource } from "../packages/operator/src/sources.js";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  builderAnswer,
  builderDescriptor,
  builderSnapshot,
  builderTask,
  builderTreatment,
  builderWorkspace,
  FAKE_MODEL,
  providerRejection,
} from "./builder-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixtureLaunchDefaults,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

const OTHER_MODEL = "other/model-20260917";

function snapshot(model: string): ModelSnapshot {
  return { ...builderSnapshot(), id: model, revision: model, hash: hashJson(model) };
}

/** A request with a name, so that a test can answer each request on its own. */
function request(model: string, name: string): ModelTurnRequest {
  return {
    model,
    seed: 1,
    system: "Build the task.",
    messages: [{ role: "user", content: name }],
    tools: [],
    maxOutputTokens: 100,
  };
}

/**
 * A transport that holds each request until the test answers it. It counts the requests of each
 * model that the provider holds at the same time.
 */
function heldTransport() {
  const waiting = new Map<string, (result: (sent: ModelTurnRequest) => ModelTurnResult) => void>();
  const arrivals = new Map<string, () => void>();
  const active = new Map<string, number>();
  const maximum = new Map<string, number>();
  const sent: string[] = [];
  const watchers: Array<{ model: string; count: number; done: () => void }> = [];
  const nameOf = (value: ModelTurnRequest) => String(value.messages[0]!.content);
  const transport: ModelClient = {
    descriptor: builderDescriptor,
    async complete(value) {
      const name = nameOf(value);
      sent.push(name);
      active.set(value.model, (active.get(value.model) ?? 0) + 1);
      maximum.set(value.model, Math.max(maximum.get(value.model) ?? 0, active.get(value.model)!));
      const answer = await new Promise<(sent: ModelTurnRequest) => ModelTurnResult>((done) => {
        waiting.set(name, done);
        const arrival = arrivals.get(name);
        arrivals.delete(name);
        arrival?.();
        for (const watcher of [...watchers])
          if (watcher.model === value.model && active.get(value.model)! >= watcher.count) {
            watchers.splice(watchers.indexOf(watcher), 1);
            watcher.done();
          }
      });
      active.set(value.model, active.get(value.model)! - 1);
      return answer(value);
    },
  };
  return {
    transport,
    sent,
    maximum,
    /** Resolve when the provider holds the named request. */
    arrived: (name: string) =>
      waiting.has(name) ? Promise.resolve() : new Promise<void>((done) => arrivals.set(name, done)),
    /** Resolve when the provider holds this number of requests of the model. */
    holds: (model: string, count: number) =>
      (active.get(model) ?? 0) >= count
        ? Promise.resolve()
        : new Promise<void>((done) => watchers.push({ model, count, done })),
    answer(name: string, result = (value: ModelTurnRequest) => builderAnswer(value, 1)) {
      const done = waiting.get(name);
      if (!done) throw new Error(`The provider does not hold ${name}`);
      waiting.delete(name);
      done(result);
    },
  };
}

async function ledgerIn(root: string) {
  const ledger = new DurableSpendLedger(root, "concurrency-run", hashJson("context"));
  await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
  return ledger;
}

/** A promise that fails if the work does not end in time, so that a held permit cannot hang. */
function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_done, fail) => {
      timer = setTimeout(() => fail(new Error(`${what} did not end in time`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** True when the promise is still unsettled after the pending callbacks run. */
async function unsettled(work: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((done) => setTimeout(done, 20));
  return !settled;
}

test("a model permit limits concurrent requests of one model and is free during Studio work", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-model-permit-"));
  try {
    const ledger = await ledgerIn(root);
    const provider = heldTransport();
    const permits = new ModelPermits({ [FAKE_MODEL]: 2, [OTHER_MODEL]: 1 });
    const client = (stage: string, model: string) =>
      new BoundedModelClient(
        provider.transport,
        ledger,
        [snapshot(model)],
        stage,
        false,
        undefined,
        0,
        [],
        (signal) => permits.acquire(model, signal),
      );

    // Three builds of one model and a judgment of another model ask at the same time. The two
    // permits of the model go to the two builds that ask first. Their file reads before the
    // permit decide which two, so the test does not expect a sequence.
    const names = ["first", "second", "third"];
    const builds = new Map(
      names.map((name) => [
        name,
        client(`builder:${name}`, FAKE_MODEL).complete(request(FAKE_MODEL, name)),
      ]),
    );
    const judge = client("judgment:check", OTHER_MODEL).complete(request(OTHER_MODEL, "judge"));
    await Promise.all([provider.arrived("judge"), provider.holds(FAKE_MODEL, 2)]);
    const [running, later] = provider.sent.filter((name) => name !== "judge") as [string, string];
    const queued = names.find((name) => !provider.sent.includes(name))!;
    assert.equal(await unsettled(builds.get(queued)!), true);
    assert.equal(provider.sent.length, 3, "the third build of the model waits for a permit");
    assert.equal(
      (await ledger.read()).entries.length,
      3,
      "a request that waits for its permit reserves nothing",
    );
    provider.answer(running);
    await builds.get(running);
    await provider.arrived(queued);
    for (const name of [later, queued, "judge"]) provider.answer(name);
    await Promise.all([...builds.values(), judge]);
    assert.deepEqual(Object.fromEntries(provider.maximum), { [FAKE_MODEL]: 2, [OTHER_MODEL]: 1 });

    // A build gives its permit back when the result settles. Its Studio job and its rate-limit
    // wait hold no permit, so another build of the same model sends its request meanwhile.
    const studio = new StudioQueue(1);
    const build = client("builder:studio", OTHER_MODEL);
    const other = client("builder:other", OTHER_MODEL);
    const answered = build.complete(request(OTHER_MODEL, "before-studio"));
    await provider.arrived("before-studio");
    provider.answer("before-studio");
    await answered;
    const endStudio = await studio.acquire(true);
    const meanwhile = other.complete(request(OTHER_MODEL, "during-studio"));
    await within(provider.arrived("during-studio"), "A request during Studio work");
    provider.answer("during-studio");
    await meanwhile;
    endStudio();
    build.pause = async () => {
      const waited = other.complete(request(OTHER_MODEL, "during-wait"));
      await within(provider.arrived("during-wait"), "A request during a rate-limit wait");
      provider.answer("during-wait");
      await waited;
    };
    const limited = build.complete(request(OTHER_MODEL, "limited"));
    await provider.arrived("limited");
    provider.answer("limited", (value) => providerRejection(value, 429, "rate_limit_exceeded"));
    await provider.arrived("limited");
    provider.answer("limited");
    assert.equal((await limited).kind, "assistant");
    assert.equal(provider.maximum.get(OTHER_MODEL), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a held model takes no permit, and a hold that starts during a wait returns the permit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-model-hold-"));
  try {
    const ledger = await ledgerIn(root);
    const provider = heldTransport();
    const permits = new ModelPermits({ [FAKE_MODEL]: 1 });
    const asked: string[] = [];
    const askers = new Map<string, () => void>();
    /** Resolve when the stage asks for a permit. */
    const askedPermit = (stage: string) =>
      asked.includes(stage)
        ? Promise.resolve()
        : new Promise<void>((done) => askers.set(stage, done));
    let held = false;
    const hold = {
      scope: "model",
      dependency: null,
      errorClass: "http_404",
      failureId: "f",
      ordinal: 1,
    };
    const client = (stage: string) =>
      new BoundedModelClient(
        provider.transport,
        ledger,
        [snapshot(FAKE_MODEL)],
        stage,
        false,
        async (phase) => {
          if (phase === "admission" && held)
            throw new ProviderHoldError(hold as ConstructorParameters<typeof ProviderHoldError>[0]);
        },
        0,
        [],
        (signal) => {
          asked.push(stage);
          askers.get(stage)?.();
          return permits.acquire(FAKE_MODEL, signal);
        },
      );
    const running = client("builder:running").complete(request(FAKE_MODEL, "running"));
    await provider.arrived("running");
    const waiting = client("builder:waiting").complete(request(FAKE_MODEL, "waiting"));
    // The request waits in the line of the model before the hold starts.
    await askedPermit("builder:waiting");
    assert.equal(await unsettled(waiting), true);
    // A pause of another unit starts while the request waits. The request meets the hold when
    // it gets the permit, and it gives the permit back at once.
    held = true;
    provider.answer("running");
    await running;
    await assert.rejects(
      waiting,
      (error: unknown) =>
        error instanceof ModelRequestAdmissionError && error.cause instanceof ProviderHoldError,
    );
    await assert.rejects(
      client("builder:held").complete(request(FAKE_MODEL, "held")),
      ModelRequestAdmissionError,
    );
    assert.deepEqual(
      asked,
      ["builder:running", "builder:waiting"],
      "a held request asks no permit",
    );
    held = false;
    const free = client("builder:free").complete(request(FAKE_MODEL, "free"));
    await within(provider.arrived("free"), "The next request");
    provider.answer("free");
    await free;
    assert.deepEqual(provider.sent, ["running", "free"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop ends a permit wait and records nothing", async () => {
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-permit-stop-"));
  try {
    const ledger = await ledgerIn(root);
    const permits = new ModelPermits({ [FAKE_MODEL]: 1 });
    // Another unit holds the only permit of the model.
    const endOther = await permits.acquire(FAKE_MODEL);
    let dispatches = 0;
    const transport: ModelClient = {
      descriptor: builderDescriptor,
      async complete(value) {
        dispatches += 1;
        return builderAnswer(value, 1);
      },
    };
    const stage = "builder:stopped";
    const stop = new AbortController();
    let waited = false;
    const client = new BoundedModelClient(
      transport,
      ledger,
      [builderSnapshot()],
      stage,
      false,
      undefined,
      0,
      [],
      (signal) => {
        // The build waits in the line of the model, and then the person selects Stop.
        const permit = permits.acquire(FAKE_MODEL, signal);
        waited = true;
        stop.abort();
        return permit;
      },
    );
    const checkpoints: BoundedAgentCheckpoint[] = [];
    const build = runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: builderTreatment(),
      modelClient: client,
      verify: async () => ({ gate: "eligible" as const, reasons: [], checks: [] }),
      retainInterruption: true,
      signal: stop.signal,
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
      },
    });
    await assert.rejects(build, AgentInterrupted);
    assert.equal(waited, true);
    assert.equal(dispatches, 0);
    assert.deepEqual((await ledger.read()).entries, [], "the stopped wait reserved nothing");
    assert.equal(
      existsSync(resolve(ledger.directory, "model-receipts", hashJson(stage))),
      false,
      "the stopped wait saved no request intent",
    );
    assert.equal(existsSync(resolve(ledger.directory, "failures")), false);
    const last = checkpoints.at(-1)!;
    assert.equal(last.point, "before_model");
    assert.equal(last.usage.calls, 0);
    assert.equal(
      last.trace.some((event) => event.kind === "model_response"),
      false,
      "the stopped wait records no response",
    );
    // The line kept no entry of the stopped build, so the permit goes to the next request.
    endOther();
    const next = await within(permits.acquire(FAKE_MODEL), "The next permit");
    next();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

const spending: SpendLedgerState = {
  schema: "basalt-evals/spend-ledger",
  operationId: "round-robin",
  contextHash: hashJson("context"),
  authorizations: [{ quoteHash: hashJson("quote"), ceilingUsd: 1 }],
  entries: [],
};

/** A frozen run whose builds use the given models, in the sequence of the run. */
function roundRobinRun(builds: Array<[string, string]>) {
  const manifest = {
    id: "round-robin",
    gradingMode: "all",
    protocol: null,
    gates: [],
    subjects: builds.map(([id, model]) => ({
      id,
      evalId: "evaluation",
      kind: "generated",
      stageIndex: 1,
      parentSubjectId: null,
      builder: { id, model: { id: model } },
      sourceId: null,
      parentSourceId: null,
      publicFeedbackId: null,
    })),
    captureCells: [],
    gradingCells: [],
    judgmentBatches: [],
    planned: { independentBuilderTrials: builds.length },
  } as unknown as RunOperationManifest;
  const events: RunOperationEvent[] = [];
  return {
    status: () => operationStatus(manifest, events, spending, []),
    append(kind: RunOperationEvent["kind"], unit: RunUnit) {
      const body = {
        schema: "basalt-evals/run-operation-event" as const,
        sequence: events.length + 1,
        previousHash: events.at(-1)?.id ?? null,
        kind,
        stage: unit.stage,
        unitId: unit.unitId,
        artifactHashes: kind === "completed" ? [hashJson(unit), hashJson([unit])] : [],
        reason: null,
        at: new Date().toISOString(),
      };
      events.push({ ...body, id: hashJson(body) });
    },
  };
}

test("new builds start round-robin across models", () => {
  const run = roundRobinRun([
    ["a1", "model-a"],
    ["a2", "model-a"],
    ["a3", "model-a"],
    ["a4", "model-a"],
    ["a5", "model-a"],
    ["b1", "model-b"],
    ["b2", "model-b"],
    ["c1", "model-c"],
  ]);
  const ids = (units: RunUnit[]) => units.map((unit) => unit.unitId);
  const idle = { running: new Set<string>(), unownedPending: false };
  // The first model of the run does not take all four builder slots.
  const first = dispatchableUnits(run.status(), idle);
  assert.deepEqual(ids(first), ["a1", "b1", "c1", "a2"]);
  for (const unit of first) run.append("started", unit);
  const running = new Set(first.map((unit) => `builder:${unit.unitId}`));
  // A slot that a build of the third model frees goes to the model with the fewest builds that
  // run and then the fewest started builds, not to the first model again.
  run.append("completed", { stage: "builder", unitId: "c1" });
  running.delete("builder:c1");
  assert.deepEqual(ids(dispatchableUnits(run.status(), { ...idle, running })), ["b2"]);
  run.append("started", { stage: "builder", unitId: "b2" });
  running.add("builder:b2");
  // When only one model has builds left, it gets each free slot.
  for (const id of ["b1", "b2"]) {
    run.append("completed", { stage: "builder", unitId: id });
    running.delete(`builder:${id}`);
  }
  assert.deepEqual(ids(dispatchableUnits(run.status(), { ...idle, running })), ["a3", "a4"]);
});

/** A registered evaluation and a saved build of it in an offline workspace. */
async function registeredEvaluation(root: string) {
  await writeRunConfiguration(root);
  await implementationFixture(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await mkdir(resolve(root, ".basalt-evals/native-worker"), { recursive: true });
  await writeFile(
    resolve(root, ".basalt-evals/synthetic-private-key.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await writeFile(
    resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const draft = createEvalDraft(fixtureInput);
  const { publicScene, ...publicProposal } = fixturePublic;
  const compiled = compileEvalProposal(draft, 1, {
    ...publicProposal,
    ...fixturePrivate,
    seed: neutralRojoSeed(draft.title, publicScene),
  });
  assert.ok(compiled.revision, JSON.stringify(compiled.validation));
  const revision = compiled.revision;
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(draft);
  await store.writeRevision(revision);
  await registerReadyEvaluation(root, revision.id);
  const [record] = await readdir(resolve(root, `.basalt-evals/eval-validations/${revision.id}`));
  const workspace = resolve(root, ".basalt-evals/saved-build");
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  await writeFile(
    resolve(workspace, "default.project.json"),
    JSON.stringify(revision.seed.project),
  );
  for (const source of revision.seed.sources)
    await writeFile(resolve(workspace, source.path), source.text);
  const files = await inventoryTree(workspace);
  const source = await registerSource({
    root,
    workspace,
    candidate: { projectFile: "default.project.json", files, rootHash: hashJson(files) },
    provenance: {
      kind: "retained",
      evidenceHashes: ["b".repeat(64)],
      originOperationId: null,
      parentSourceId: null,
    },
  });
  return { revision, validationRecordHash: record!.replace(/\.json$/u, ""), sourceId: source.id };
}

test("the manifest freezes model concurrency and the preview cost scope includes it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-model-concurrency-freeze-"));
  try {
    await seedModelRegistry(root);
    const judge = "xiaomi/mimo-v2.6-flash";
    await setModelConcurrency(root, { id: judge, maxConcurrentRequests: 2 });
    const { revision, validationRecordHash, sourceId } = await registeredEvaluation(root);
    const adapters = fixtureAdapters(root);
    const preview = () =>
      previewOperationLaunch(
        root,
        {
          kind: "evaluation",
          selection: {
            ...fixtureLaunchDefaults,
            sources: [{ kind: "evaluation", id: revision.id }],
          },
        },
        adapters,
      );
    const before = await preview();
    assert.equal((await preview()).costScope, before.costScope);

    // The judge checks of a saved build use only the judge model.
    const saved = await quoteRegisteredEvalRun({
      root,
      adapters,
      selection: {
        captureScope: "final",
        publicFeedbackId: null,
        sourceIds: [sourceId],
        parentSourceId: null,
        gradingMode: "all",
        continuingOperationId: null,
        revisionId: revision.id,
        validationRecordHash,
        builderModelIds: [],
        gradingModelId: judge,
        judgeSettings: DEFAULT_JUDGE_SETTINGS,
        harnessIds: [],
        repetitions: 0,
        nativeCaptureRepetitions: 1,
      },
    });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-model-concurrency",
      ceilingUsd: 1,
      adapters,
    });
    assert.ok(manifest.judgmentBatches.length > 0);
    assert.deepEqual(manifest.modelConcurrency, { [judge]: 2 });

    // A change on the Models page makes a new cost scope. The frozen run keeps its value.
    await setModelConcurrency(root, { id: judge, maxConcurrentRequests: 3 });
    assert.notEqual((await preview()).costScope, before.costScope);
    const stored = JSON.parse(
      await readFile(
        resolve(root, ".basalt-evals/eval-operations/run-model-concurrency/manifest.json"),
        "utf8",
      ),
    ) as RunOperationManifest;
    assert.deepEqual(stored.modelConcurrency, { [judge]: 2 });

    // Each model snapshot needs exactly one value from 1 to 16.
    for (const modelConcurrency of [{}, { [judge]: 0 }, { [judge]: 17 }, { [judge]: 2, x: 2 }])
      assert.throws(
        () => assertManifest({ ...structuredClone(stored), modelConcurrency }),
        /Invalid frozen run operation manifest/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
