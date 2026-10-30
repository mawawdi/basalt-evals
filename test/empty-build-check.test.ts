import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { CriterionResult } from "../packages/contracts/src/index.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { evaluationSummary } from "../packages/operator/src/discovery.js";
import {
  hollowChecks,
  prepareEmptyBuildCheck,
  readEmptyBuildCheck,
} from "../packages/operator/src/empty-build-check.js";
import type { StudioAdapter } from "../packages/studio-runner/src/adapter.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

/** A clean implementation, a signing key pair and one registered revision of the fixture. */
async function registeredRevision(root: string) {
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
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(draft);
  await store.writeRevision(compiled.revision);
  await registerReadyEvaluation(root, compiled.revision.id);
  return compiled.revision;
}

/** The synthetic Studio, with a count of its runs. */
function countedStudio(root: string, run?: StudioAdapter["run"]) {
  const synthetic = fixtureAdapters(root).studio;
  const runs: string[] = [];
  const studio: StudioAdapter = {
    ...synthetic,
    async run(request) {
      runs.push(request.directory);
      return (run ?? synthetic.run)(request);
    },
  };
  return { studio, runs };
}

async function syntheticCalls(root: string): Promise<Array<{ kind: string }>> {
  const file = resolve(root, ".basalt-evals/synthetic-calls.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string });
}

test("A required code check that passes on the empty build becomes a plan warning.", async () => {
  const result = (criterionId: string, outcome: CriterionResult["outcome"]): CriterionResult => ({
    criterionId,
    layer: "engine",
    outcome,
    explanation: "Synthetic result.",
    evidence: [],
    observed: null,
  });
  assert.deepEqual(
    hollowChecks(
      [
        { id: "exists", required: true },
        { id: "optional", required: false },
        { id: "named", required: true },
      ],
      [result("exists", "verified"), result("optional", "verified"), result("named", "rejected")],
    ),
    ["exists"],
    "Only a required check that the empty build satisfies is a warning",
  );

  const root = await mkdtemp(resolve(tmpdir(), "basalt-empty-build-"));
  try {
    const revision = await registeredRevision(root);
    const { studio, runs } = countedStudio(root);
    const record = await prepareEmptyBuildCheck({
      root,
      operationId: "empty-build-test",
      revisionId: revision.id,
      studio,
      signal: new AbortController().signal,
    });
    // The seed has no Beacon, but the synthetic Studio reports one. The check passes anyway.
    assert.equal(record.state, "complete");
    assert.deepEqual(record.hollow, ["beacon-exists"]);
    assert.deepEqual(
      record.results.map((item) => [item.criterionId, item.outcome]),
      [["beacon-exists", "verified"]],
    );
    assert.match(record.receiptHash!, /^[a-f0-9]{64}$/u);
    assert.deepEqual(runs, [
      resolve(root, `.basalt-evals/authoring/empty-build-checks/${revision.id}/observation/studio`),
    ]);
    assert.deepEqual(await readEmptyBuildCheck(root, revision.id), record);
    assert.equal(await readEmptyBuildCheck(root, "b".repeat(64)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("The empty build check sends no model request.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-empty-build-model-"));
  try {
    const revision = await registeredRevision(root);
    const { studio } = countedStudio(root);
    const record = await prepareEmptyBuildCheck({
      root,
      operationId: "empty-build-model",
      revisionId: revision.id,
      studio,
      signal: new AbortController().signal,
    });
    assert.equal(record.state, "complete");
    // The synthetic adapters log each model request and each Studio run.
    assert.deepEqual(
      (await syntheticCalls(root)).map((call) => call.kind),
      ["native"],
    );
    assert.equal(
      existsSync(resolve(root, ".basalt-evals/eval-operations/empty-build-model")),
      false,
      "The check has no spending ledger",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("An incomplete empty build observation keeps the evaluation ready.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-empty-build-incomplete-"));
  try {
    const revision = await registeredRevision(root);
    const { studio, runs } = countedStudio(root, async () => {
      throw new Error("Synthetic Studio is not available.");
    });
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      prepareEmptyBuildCheck({
        root,
        operationId: "empty-build-incomplete",
        revisionId: revision.id,
        studio,
        signal: stopped.signal,
      }),
      "A stop is not a result",
    );
    assert.equal(await readEmptyBuildCheck(root, revision.id), null);
    const check = () =>
      prepareEmptyBuildCheck({
        root,
        operationId: "empty-build-incomplete",
        revisionId: revision.id,
        studio,
        signal: new AbortController().signal,
      });
    const record = await check();
    assert.equal(record.state, "incomplete");
    assert.match(record.reason!, /Synthetic Studio is not available/);
    assert.deepEqual(record.hollow, []);
    assert.equal((await evaluationSummary(root, revision.id))?.readiness, "ready");
    // The check saves its record one time. It does not observe the empty build again.
    assert.deepEqual(await check(), record);
    assert.deepEqual(await readEmptyBuildCheck(root, revision.id), record);
    assert.equal(runs.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
