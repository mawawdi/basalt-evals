import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { implementationFixture } from "./implementation-fixture.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { quotePreparation } from "../packages/eval-authoring/src/quote.js";
import { selectModelSnapshot } from "../packages/model-client/src/catalog.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { createTextDraft } from "../packages/operator/src/prepare-draft.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import {
  authoringActionResult,
  authoringProgress,
  queueAuthoringAction,
  resumeAuthoringAction,
} from "../packages/operator/src/authoring-operation.js";
import { stopSavedOperation, resumeSavedOperation } from "../packages/operator/src/service.js";
import { operationView } from "../packages/operator/src/workbench.js";
import { runCatalog } from "../packages/operator/src/discovery.js";

function snapshot(id: string) {
  return selectModelSnapshot(
    { id, canonical_slug: `${id}-offline-fixture`, architecture: { input_modalities: ["text"] } },
    {
      data: {
        endpoints: [
          {
            model_id: id,
            tag: "offline",
            provider_name: "Offline",
            context_length: 200_000,
            max_completion_tokens: 16384,
            supported_parameters: ["tools"],
            status: 0,
            pricing: { prompt: "0.0000001", completion: "0.0000001" },
          },
        ],
      },
    },
    { tools: true },
    "2026-09-25T00:00:00.000Z",
  );
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-authoring-operation-"));
  await implementationFixture(root);
  const draft = await createTextDraft(root, {
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Build a blue cube visible from spawn.", rubric: "The cube is blue." }],
  });
  const quote = quotePreparation(draft, snapshot("openai/gpt-6-luna"), null);
  await new RepositoryFiles(root).writeJson(`.basalt-evals/eval-quotes/${quote.id}.json`, quote);
  const action = {
    operationId: "authoring-test",
    stage: "preparation" as const,
    revisionId: null,
    draftId: draft.id,
    quoteId: quote.id,
    ceilingUsd: 0.1,
  };
  return { root, draft, quote, action };
}

test("concurrent authoring starts claim one immutable action and one shared ledger without dispatch", async () => {
  const { root, action, draft } = await fixture();
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Unexpected network dispatch");
  };
  try {
    const [first, second] = await Promise.all([
      queueAuthoringAction(root, action),
      queueAuthoringAction(root, action),
    ]);
    assert.equal(first.action.id, second.action.id);
    assert.equal((await authoringProgress(root, action.operationId))?.state, "queued");
    const ledger = await new DurableSpendLedger(
      root,
      action.operationId,
      hashJson({ inputHash: draft.id }),
    ).read();
    assert.equal(ledger.authorizations.length, 1);
    assert.equal(ledger.entries.length, 0);
    assert.equal(fetches, 0);
    assert.ok((await runCatalog(root)).items.some((item) => item.id === action.operationId));
    await assert.rejects(
      queueAuthoringAction(root, { ...action, ceilingUsd: 0.2 }),
      /Preparation quote already has a different authorization/,
    );
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("authoring progress reads its projection; cancellation and resume claim preserve the action", async () => {
  const { root, action } = await fixture();
  try {
    const queued = await queueAuthoringAction(root, action);
    await stopSavedOperation(root, action.operationId, "offline cancellation");
    const stopped = (await operationView(root, action.operationId)).status;
    assert.equal(stopped.kind, "authoring");
    assert.equal(stopped.stopped, true);
    const resumed = await resumeAuthoringAction(root, action.operationId);
    assert.equal("action" in resumed && resumed.action.id, queued.action.id);
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() =>
        journal.put("drivers", action.operationId, { pid: process.pid, active: true, error: null }),
      );
    } finally {
      journal.close();
    }
    await assert.rejects(resumeSavedOperation(root, action.operationId), /did not stop yet/);
    await rm(resolve(root, "packages"), { recursive: true });
    await rm(resolve(root, ".basalt-evals/authoring"), { recursive: true });
    const cheap = (await operationView(root, action.operationId)).status;
    assert.equal(cheap.kind, "authoring");
    assert.equal(cheap.billedUsd, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reference test of an already prepared evaluation reads without a preparation of its own", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-reference-progress-"));
  const journal = await OperationJournal.open(root);
  try {
    const id = "reference-standalone";
    journal.transaction(() =>
      journal.put("authoring_progress", id, {
        action: {
          id: hashJson("action"),
          operationId: id,
          stage: "controls",
          draftId: hashJson("draft"),
          revisionId: hashJson("revision"),
          quoteId: hashJson("quote"),
          ceilingUsd: 1,
        },
        state: "incomplete",
        stopped: false,
        resultHash: null,
        error: "Studio readiness failed before paid work",
      }),
    );
    const saved = await authoringActionResult(root, id);
    assert.equal(saved.preparation, null);
    assert.equal(saved.result, null);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("authoring recovery rejects changed implementation and leaves unbound billing reserved", async () => {
  const { root, action, draft } = await fixture();
  try {
    await queueAuthoringAction(root, action);
    const ledger = new DurableSpendLedger(
      root,
      action.operationId,
      hashJson({ inputHash: draft.id }),
    );
    await ledger.reserve({
      requestId: hashJson("uncertain"),
      requestHash: hashJson("request"),
      stage: "preparation",
      maximumUsd: 0.05,
    });
    await stopSavedOperation(root, action.operationId, "offline cancellation");
    await assert.rejects(resumeSavedOperation(root, action.operationId), /pending charge/);
    assert.equal((await ledger.read()).entries[0]?.reservedUsd, 0.05);
    await ledger.reconcile(hashJson("uncertain"), 0.01);
    await writeFile(resolve(root, "packages/fixture.ts"), "changed\n");
    await assert.rejects(
      resumeSavedOperation(root, action.operationId),
      /Basalt runs only committed code/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current authored meaning cannot be forged", async () => {
  const { root, draft } = await fixture();
  try {
    const changed = structuredClone(draft);
    changed.stages[0]!.criteria[0]!.required = false;
    await assert.rejects(new EvalDefinitionStore(root).writeDraft(changed), /content identity/);
    assert.deepEqual(await new EvalDefinitionStore(root).readDraft(draft.id), draft);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
