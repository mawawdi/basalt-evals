import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvalDraft, EvalDefinitionStore } from "../packages/eval-authoring/src/index.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createTextDraft } from "../packages/operator/src/prepare-draft.js";
import { createOperationApi } from "../packages/operator/src/api.js";
import {
  evaluationCatalog,
  evaluationSummary,
  selectedEvaluationSummary,
} from "../packages/operator/src/discovery.js";
import { evaluationLaunchSource } from "../packages/contracts/src/catalog.js";
import { rebuildCatalogProjections } from "../packages/operator/src/rebuild-projections.js";
import { projectRegisteredEvaluation } from "../packages/eval-authoring/src/catalog.js";
import { fixtureInput, fixturePublic, fixturePrivate } from "./shared-api-fixture.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";

test("immutable authoring drafts keep their identity after subsequent edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-authoring-store-"));
  try {
    const store = new EvalDefinitionStore(root);
    const first = createEvalDraft({
      schema: "basalt-evals/eval-authoring-input",
      stages: [{ prompt: "Build a gate.", rubric: "Two players must open it together." }],
    });
    const next = createEvalDraft({
      schema: "basalt-evals/eval-authoring-input",
      stages: [
        {
          prompt: "Build a gate.",
          rubric: "Two players must open it together and both see feedback.",
        },
      ],
    });
    await store.writeDraft(first);
    await store.writeDraft(next);
    await store.writeDraft(first);
    assert.notEqual(first.id, next.id);
    assert.deepEqual(await store.readDraft(first.id), first);
    assert.deepEqual(await store.readDraft(next.id), next);
    await assert.rejects(store.readDraft("../outside"), /identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving an edit and retrying publication update one library evaluation while exact authored snapshots remain immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-evaluation-library-"));
  const handle = createOperationApi({ root });
  async function get(path: string, status = 200) {
    const result = await handle(new Request(`http://127.0.0.1:3000/api/${path}`));
    const body = await result.json();
    assert.equal(result.status, status, JSON.stringify(body));
    return body;
  }
  async function post(path: string, action: string, value: unknown, status = 200) {
    const result = await handle(
      new Request(`http://127.0.0.1:3000/api/${path}`, {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "X-Basalt-Action": action,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      }),
    );
    const body = await result.json();
    assert.equal(result.status, status, JSON.stringify(body));
    return body;
  }
  try {
    const original = await createTextDraft(root, fixtureInput);
    const initial = await evaluationCatalog(root);
    assert.equal(initial.total, 1);
    const evaluationId = initial.items[0]!.evaluationId!;
    const originalCopy = {
      evaluationId,
      baseDraftId: original.id,
      revision: 0,
      title: original.title,
      stages: [
        {
          prompt: original.stages[0]!.prompt,
          criteria: original.stages[0]!.rubric,
          gateCriterionIds: [],
        },
      ],
    };
    const stale = await post(
      "working-copies/second-editor-buffer",
      "save_working_copy",
      originalCopy,
    );
    const saved = await post("working-copies/primary-editor-buffer", "save_working_copy", {
      ...originalCopy,
      title: "Updated beacon evaluation",
      stages: [
        {
          ...originalCopy.stages[0]!,
          criteria: original.stages[0]!.rubric + "\n- The Beacon must remain visible.",
        },
      ],
    });
    const published = await post(
      "working-copies/primary-editor-buffer/publish",
      "save_evaluation",
      { revision: saved.revision },
      201,
    );
    const retry = await post(
      "working-copies/primary-editor-buffer/publish",
      "save_evaluation",
      { revision: saved.revision },
      201,
    );
    assert.equal(published.evaluation.id, evaluationId);
    assert.deepEqual(
      retry,
      published,
      "An uncertain save response can be retried without another evaluation",
    );
    const current = await evaluationCatalog(root);
    assert.equal(current.total, 1);
    assert.equal(current.items[0]!.evaluationId, evaluationId);
    assert.equal(current.items[0]!.id, published.draft.id);
    assert.equal(current.items[0]!.title, "Updated beacon evaluation");
    assert.notEqual(published.draft.id, original.id);
    assert.deepEqual(await new EvalDefinitionStore(root).readDraft(original.id), original);
    assert.equal((await evaluationSummary(root, original.id))!.title, original.title);
    assert.equal((await evaluationSummary(root, evaluationId))!.id, published.draft.id);
    assert.equal(
      (await get(`evaluations/current?ids=${evaluationId}`))[evaluationId].id,
      published.draft.id,
    );
    assert.equal((await get(`evaluations/${original.id}`)).title, original.title);
    const retained = await selectedEvaluationSummary(root, original.id, evaluationId);
    assert.equal(retained!.id, original.id, "Concurrent edits never replace the selected inputs");
    assert.equal(retained!.evaluationId, null, "A changed library binding is never guessed");
    await post(
      "working-copies/second-editor-buffer/publish",
      "save_evaluation",
      { revision: stale.revision },
      409,
    );
    assert.equal(
      (await evaluationCatalog(root)).total,
      1,
      "A conflicted edit does not leak an immutable snapshot into the library",
    );
    assert.equal((await rebuildCatalogProjections(root)).evaluations, 1);
    assert.equal((await evaluationCatalog(root)).items[0]!.id, published.draft.id);

    const duplicate = await post("working-copies/explicit-copy-buffer", "save_working_copy", {
      evaluationId: null,
      baseDraftId: null,
      revision: 0,
      title: published.draft.title,
      stages: [
        {
          prompt: published.draft.input.stages[0]!.prompt,
          criteria: published.draft.input.stages[0]!.rubric,
          gateCriterionIds: [],
        },
      ],
    });
    const copied = await post(
      "working-copies/explicit-copy-buffer/publish",
      "save_evaluation",
      { revision: duplicate.revision },
      201,
    );
    assert.notEqual(copied.evaluation.id, evaluationId);
    assert.equal(
      copied.draft.id,
      published.draft.id,
      "Deliberate copies may share exact immutable content",
    );
    assert.equal((await evaluationCatalog(root)).total, 2);
    assert.equal((await evaluationSummary(root, published.draft.id))!.evaluationId, null);
    assert.equal(
      (await selectedEvaluationSummary(root, published.draft.id, evaluationId))!.evaluationId,
      evaluationId,
    );
    assert.equal(
      (await selectedEvaluationSummary(root, published.draft.id, copied.evaluation.id))!
        .evaluationId,
      copied.evaluation.id,
    );
    const currentCopies = await get(
      `evaluations/current?ids=${evaluationId},${copied.evaluation.id}`,
    );
    assert.equal(currentCopies[evaluationId].evaluationId, evaluationId);
    assert.equal(currentCopies[copied.evaluation.id].evaluationId, copied.evaluation.id);
    await get(`evaluations/current?ids=${evaluationId},${evaluationId}`, 400);
    await get(`evaluations/current?ids=${published.draft.id}`, 400);
    await get(
      `evaluations/current?ids=${Array.from({ length: 51 }, (_, n) => `eval-${String(n).padStart(16, "0")}`).join(",")}`,
      400,
    );
    assert.deepEqual(await get("evaluations/current?ids=eval-unavailable-entry"), {
      "eval-unavailable-entry": null,
    });

    await post(`evaluations/${evaluationId}/archive`, "archive_evaluation", { archived: true });
    assert.equal(
      (await get(`evaluations/current?ids=${evaluationId}`))[evaluationId].archived,
      true,
    );
    assert.equal((await evaluationCatalog(root)).total, 1);
    assert.equal(
      (await evaluationCatalog(root, new URLSearchParams({ status: "archived" }))).total,
      1,
    );
    assert.deepEqual(await new EvalDefinitionStore(root).readDraft(original.id), original);
    await post(`evaluations/${evaluationId}/archive`, "archive_evaluation", { archived: false });
    assert.equal((await evaluationCatalog(root)).total, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparation replaces the library draft and delayed old preparation never replaces later edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-evaluation-preparation-"));
  try {
    const draft = await createTextDraft(root, fixtureInput);
    const entry = (await evaluationCatalog(root)).items[0]!;
    const { publicScene, ...publicProposal } = fixturePublic;
    const compiled = compileEvalProposal(draft, 1, {
      ...publicProposal,
      ...fixturePrivate,
      seed: neutralRojoSeed(draft.title, publicScene),
    });
    assert.ok(compiled.revision, JSON.stringify(compiled.validation));
    const store = new EvalDefinitionStore(root);
    await store.writeRevision(compiled.revision);
    const unready = (await evaluationSummary(root, entry.evaluationId!))!;
    assert.equal(unready.readiness, "needs_validation");
    assert.equal(
      evaluationLaunchSource(unready).id,
      draft.id,
      "Unfinished checks launch from authored inputs for preparation",
    );
    assert.equal(evaluationLaunchSource(unready).kind, "draft");
    await projectRegisteredEvaluation(root, compiled.revision.id, "a".repeat(64), false);
    let catalog = await evaluationCatalog(root);
    assert.equal(catalog.total, 1);
    assert.equal(catalog.items[0]!.evaluationId, entry.evaluationId);
    assert.equal(catalog.items[0]!.id, compiled.revision.id);
    assert.equal(catalog.items[0]!.readiness, "ready");
    assert.equal(evaluationLaunchSource(catalog.items[0]!).id, compiled.revision.id);
    const { saveWorkingCopy, publishWorkingCopy } =
      await import("../packages/operator/src/working-copies.js");
    const unchanged = await saveWorkingCopy(root, "unchanged-prepared-editor", {
      revision: 0,
      evaluationId: entry.evaluationId,
      baseDraftId: draft.id,
      title: draft.title,
      stages: [
        {
          prompt: draft.stages[0]!.prompt,
          criteria: draft.stages[0]!.rubric,
          gateCriterionIds: [],
        },
      ],
    });
    assert.equal(
      (await publishWorkingCopy(root, unchanged.id, { revision: unchanged.revision })).evaluation
        .revisionId,
      compiled.revision.id,
    );
    const edited = await saveWorkingCopy(root, "prepared-evaluation-editor", {
      revision: 0,
      evaluationId: entry.evaluationId,
      baseDraftId: draft.id,
      title: "Changed beacon inputs",
      stages: [
        {
          prompt: draft.stages[0]!.prompt,
          criteria: draft.stages[0]!.rubric + "\n- It must be anchored.",
          gateCriterionIds: [],
        },
      ],
    });
    const published = await publishWorkingCopy(root, edited.id, { revision: edited.revision });
    await store.writeRevision(compiled.revision);
    await projectRegisteredEvaluation(root, compiled.revision.id, "b".repeat(64), true);
    catalog = await evaluationCatalog(root);
    assert.equal(catalog.total, 1);
    assert.equal(catalog.items[0]!.id, published.draft.id);
    assert.equal(catalog.items[0]!.readiness, "draft");
    assert.deepEqual(await store.readRevision(compiled.revision.id), compiled.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving unchanged inputs preserves a draft whose title was inferred", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-evaluation-unchanged-"));
  try {
    const { saveWorkingCopy, publishWorkingCopy } =
      await import("../packages/operator/src/working-copies.js");
    const original = await createTextDraft(root, {
      schema: "basalt-evals/eval-authoring-input",
      stages: [{ prompt: "Build a visible beacon.", rubric: "- A beacon is visible." }],
    });
    const evaluation = (await evaluationCatalog(root)).items[0]!;
    const saved = await saveWorkingCopy(root, "unchanged-evaluation-editor", {
      revision: 0,
      evaluationId: evaluation.evaluationId,
      baseDraftId: original.id,
      title: original.title,
      stages: [
        {
          prompt: original.stages[0]!.prompt,
          criteria: original.stages[0]!.rubric,
          gateCriterionIds: [],
        },
      ],
    });
    const published = await publishWorkingCopy(root, saved.id, { revision: saved.revision });
    assert.deepEqual(published.draft, original);
    assert.equal(published.evaluation.id, evaluation.evaluationId);
    assert.equal((await evaluationCatalog(root)).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
