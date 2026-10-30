import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
} from "../packages/artifact-store/src/index.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";

test("artifact store deduplicates canonical values and detects byte tampering", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-artifacts-"));
  try {
    const store = new ImmutableJsonArtifactStore(temporary);
    const first = await store.write({ b: 2, a: 1 });
    const second = await store.write({ a: 1, b: 2 });
    assert.deepEqual(first, second);
    assert.throws(() => assertArtifactReference({ ...first, unexpected: true }), /fields/);
    assert.deepEqual(await store.read(first), { a: 1, b: 2 });
    const blob = await store.writeBlob(Buffer.from("capture"), "image/png");
    assert.deepEqual(Buffer.from(await store.readBlob(blob)), Buffer.from("capture"));
    const mutableBytes = Buffer.from("original");
    const pending = store.writeBlob(mutableBytes, "image/png");
    mutableBytes.fill(0);
    assert.deepEqual(Buffer.from(await store.readBlob(await pending)), Buffer.from("original"));
    await assert.rejects(
      store.writeBlob(Buffer.from("capture"), "image/gif" as "image/png"),
      /media type/,
    );
    await writeFile(resolve(temporary, first.locator), '{"a":9}\n');
    await assert.rejects(store.read(first), /byte count mismatch|SHA-256 mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("write-once JSON accepts an identical retry and rejects a different value", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-evals-write-once-"));
  try {
    const files = new RepositoryFiles(temporary);
    await files.writeJsonOnce("capture/sequence.json", { frames: 3, actor: "a" });
    await files.writeJsonOnce("capture/sequence.json", { actor: "a", frames: 3 });
    await assert.rejects(
      files.writeJsonOnce("capture/sequence.json", { frames: 4, actor: "a" }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    assert.deepEqual(await files.json("capture/sequence.json"), { actor: "a", frames: 3 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
