import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import {
  assertFixedSource,
  observeFixedSource,
} from "../packages/operator/src/source-observation.js";
import { registerSource } from "../packages/operator/src/sources.js";
import { executeEvalControlSource } from "../packages/operator/src/control-execution.js";
import type { StudioAdapter } from "../packages/studio-runner/src/adapter.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";

const environment = {
  platform: "Roblox Studio" as const,
  captureProtocol: "studio-mcp-viewport" as const,
  cameraProtocol: "fixed",
};

/** A clean implementation, a signing key pair and one stored revision of the fixture. */
async function observationFixture(root: string) {
  const implementation = await implementationFixture(root);
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
  const synthetic = fixtureAdapters(root).studio;
  const runs: string[] = [];
  const studio: StudioAdapter = {
    ...synthetic,
    async run(request) {
      runs.push(request.directory);
      return synthetic.run(request);
    },
  };
  return {
    revision: compiled.revision,
    studio,
    runs,
    identity: await studio.identity(root),
    implementationCommit: implementation.implementationCommit,
  };
}

test("Zero files are allowed only for the empty build purpose.", async () => {
  const file = { path: "src/server/Beacon.server.luau", text: "-- Beacon\n" };
  assert.doesNotThrow(() => assertFixedSource({ files: [] }, "empty_build"));
  assert.throws(() => assertFixedSource({ files: [] }, "control"), /one to 64 Luau files/u);
  assert.throws(() => assertFixedSource({ files: [file] }, "empty_build"), /no source files/u);
  assert.throws(
    () => assertFixedSource({ sourceId: "a".repeat(64) }, "empty_build"),
    /only the seed/u,
  );
  assert.doesNotThrow(() => assertFixedSource({ files: [file] }, "control"));

  const root = await mkdtemp(resolve(tmpdir(), "basalt-source-observation-"));
  try {
    const fixture = await observationFixture(root);
    const observe = (purpose: "control" | "empty_build", name: string) =>
      observeFixedSource({
        root,
        revisionId: fixture.revision.id,
        base: `.basalt-evals/observation-test/${name}`,
        purpose,
        source: { files: [] },
        treatmentId: `observation-${name}`,
        implementationCommit: fixture.implementationCommit,
        connectorArtifactHash: fixture.identity.connectorArtifactHash,
        environment,
        studio: fixture.studio,
      });
    await assert.rejects(observe("control", "control-empty"), /one to 64 Luau files/u);
    assert.deepEqual(fixture.runs, [], "A refused source never reaches Studio");

    const empty = await observe("empty_build", "empty");
    assert.equal(empty.status, "observed");
    if (empty.status !== "observed") throw new Error("The empty build was not observed");
    assert.equal(fixture.runs.length, 1);
    // The seed has no Beacon, but the synthetic Studio reports one. The check records it.
    assert.deepEqual(
      empty.results.map((result) => [result.criterionId, result.outcome, result.observed]),
      [["beacon-exists", "verified", ["Beacon"]]],
    );
    assert.equal(
      empty.candidateHash,
      hashJson(
        await inventoryTree(resolve(root, ".basalt-evals/observation-test/empty/workspace")),
      ),
    );

    const replay = await observe("empty_build", "empty");
    assert.deepEqual(replay, empty, "A complete observation replays from its signed receipt");
    assert.equal(fixture.runs.length, 1, "A replay never runs Studio again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A registered source is observed with its own bytes.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-registered-observation-"));
  try {
    const fixture = await observationFixture(root);
    const workspace = resolve(root, ".basalt-evals/registered-workspace");
    const seed = fixture.revision.seed;
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await mkdir(resolve(workspace, "src/client"), { recursive: true });
    await mkdir(resolve(workspace, "src/shared"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), JSON.stringify(seed.project));
    for (const source of seed.sources)
      await writeFile(resolve(workspace, source.path), source.text);
    await writeFile(resolve(workspace, "src/server/Beacon.server.luau"), "-- Beacon\n");
    const files = await inventoryTree(workspace);
    const registered = await registerSource({
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
    const observation = await observeFixedSource({
      root,
      revisionId: fixture.revision.id,
      base: ".basalt-evals/observation-test/registered",
      purpose: "control",
      source: { sourceId: registered.id },
      treatmentId: "observation-registered",
      implementationCommit: fixture.implementationCommit,
      connectorArtifactHash: fixture.identity.connectorArtifactHash,
      environment,
      studio: fixture.studio,
    });
    assert.equal(observation.status, "observed");
    assert.equal(observation.candidateHash, registered.candidate.rootHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A control compares the observed code checks with its expected outcomes.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-control-comparison-"));
  try {
    const fixture = await observationFixture(root);
    const control = (
      id: string,
      targetCriterionId: string | null,
      expected: "verified" | "rejected",
    ) =>
      executeEvalControlSource({
        root,
        revisionId: fixture.revision.id,
        batchId: "c".repeat(64),
        source: {
          id,
          kind: targetCriterionId ? "negative" : "working",
          targetCriterionId,
          contrast: "Synthetic contrast.",
          basis: "Synthetic basis.",
          expectedDeterministic: { "beacon-exists": expected },
          files: [{ path: "src/server/Beacon.server.luau", text: `-- ${id}\n` }],
        },
        parentSourceId: null,
        implementationCommit: fixture.implementationCommit,
        connectorArtifactHash: fixture.identity.connectorArtifactHash,
        environment,
        studio: fixture.studio,
      });
    const working = await control("working", null, "verified");
    assert.deepEqual(working.diagnostics, []);
    assert.equal(working.accepted, true);
    // The synthetic Studio names the Beacon wrongly for this target, so the check fails.
    assert.equal((await control("negative", "beacon-exists", "rejected")).accepted, true);
    const wrong = await control("mistaken", null, "rejected");
    assert.equal(wrong.accepted, false);
    assert.deepEqual(wrong.diagnostics, ["beacon-exists: expected rejected, got verified"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
