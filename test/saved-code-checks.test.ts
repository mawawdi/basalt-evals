import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import {
  freezeRegisteredEvalRun,
  quoteRegisteredEvalRun,
} from "../packages/operator/src/run-plan.js";
import { savedCodeChecks } from "../packages/operator/src/saved-code-checks.js";
import { sealRegisteredSubject } from "../packages/operator/src/seal-source.js";
import { registerSource } from "../packages/operator/src/sources.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

/**
 * One registered build, observed one time in a run that makes only code checks. The run plans
 * no judge request, so it needs no judge model.
 */
async function savedObservation(root: string) {
  // The run configuration is execution source, so the fixture commits it.
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
  await writeFile(resolve(workspace, "src/server/Beacon.server.luau"), "-- Beacon\n");
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
  const adapters = fixtureAdapters(root);
  const saved = await quoteRegisteredEvalRun({
    root,
    adapters,
    selection: {
      captureScope: "final",
      publicFeedbackId: null,
      sourceIds: [source.id],
      parentSourceId: null,
      gradingMode: "code",
      continuingOperationId: null,
      revisionId: revision.id,
      validationRecordHash: record!.replace(/\.json$/u, ""),
      builderModelIds: [],
      gradingModelId: null,
      judgeSettings: DEFAULT_JUDGE_SETTINGS,
      harnessIds: [],
      repetitions: 0,
      nativeCaptureRepetitions: 1,
    },
  });
  const manifest = await freezeRegisteredEvalRun({
    root,
    quoteId: saved.id,
    operationId: "run-saved-code-checks",
    ceilingUsd: 0,
    adapters,
  });
  assert.equal(manifest.gradingMode, "code");
  assert.deepEqual(
    manifest.gradingCells.map((cell) => cell.criterionId),
    ["beacon-exists"],
    "A run with only code checks plans a grading cell for each code check",
  );
  assert.deepEqual(manifest.judgmentBatches, []);
  const capture = manifest.captureCells[0]!;
  await sealRegisteredSubject(root, manifest.id, capture.treatmentId);
  await executeFrozenCaptureCell({
    root,
    operationId: manifest.id,
    cellId: capture.id,
    studioAdapter: adapters.studio,
  });
  return { revision, operationId: manifest.id, captureCellId: capture.id };
}

/** The fixture revision with another instruction in its private Studio plan. */
function changedPlan(revision: EvalRevision): EvalRevision {
  const changed = JSON.parse(JSON.stringify(revision)) as EvalRevision;
  changed.privateEvaluator.studio.phases[0]!.instruction = "Capture the whole scene.";
  return changed;
}

test("Saved code checks run the checks of a revision on a signed observation with no cost.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-saved-code-checks-"));
  try {
    const saved = await savedObservation(root);
    const checked = await savedCodeChecks({ root, ...saved });
    assert.equal(checked.status, "checked");
    if (checked.status !== "checked") throw new Error("The saved code checks did not run");
    assert.equal(checked.partition, "withheld");
    assert.deepEqual(
      checked.results.map((result) => [result.criterionId, result.outcome, result.observed]),
      [["beacon-exists", "verified", ["Beacon"]]],
    );
    const calls = resolve(root, ".basalt-evals/synthetic-calls.jsonl");
    const kinds = existsSync(calls)
      ? (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { kind: string }).kind)
      : [];
    assert.ok(!kinds.includes("model"), "A code check sends no model request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A changed Studio plan returns plan_changed and runs no check.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-saved-code-plan-"));
  try {
    const saved = await savedObservation(root);
    const target = changedPlan(saved.revision);
    // A check of this evidence with the changed plan throws a binding mismatch. The plan
    // comparison returns first, so no check runs.
    assert.deepEqual(await savedCodeChecks({ root, ...saved, revision: target }), {
      status: "plan_changed",
      savedPlanHash: hashJson(saved.revision.privateEvaluator.studio),
      targetPlanHash: hashJson(target.privateEvaluator.studio),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Saved code checks refuse evidence that differs from its signed receipt.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-saved-code-integrity-"));
  try {
    const saved = await savedObservation(root);
    const evidence = resolve(
      root,
      `.basalt-evals/eval-operations/${saved.operationId}/capture/${saved.captureCellId}/studio/evidence.json`,
    );
    const value = JSON.parse(await readFile(evidence, "utf8")) as { endedAt: string };
    value.endedAt = "2026-09-25T00:00:03.000Z";
    await writeFile(evidence, JSON.stringify(value));
    await assert.rejects(savedCodeChecks({ root, ...saved }), /Worker artifact hash mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
