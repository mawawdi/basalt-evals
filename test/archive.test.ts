import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { readArchivedFile, sealArchive, listArchives } from "../packages/operator/src/archive.js";

test("archives preserve obsolete evaluator bytes without executing their schema and reject tampering", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-archive-"));
  try {
    const files = new RepositoryFiles(root);
    const base = ".basalt-evals/eval-operations/historical";
    await files.writeJson(`${base}/manifest.json`, {
      implementationCommit: "old-recorded-identity",
      evaluator: { obsoleteShape: true },
      unresolvedLiabilityUsd: 0.08,
    });
    const archive = await sealArchive(root, "historical");
    assert.equal((await listArchives(root)).items[0]?.id, archive.id);
    assert.equal(
      (await listArchives(root, new URLSearchParams({ q: "run" }))).items[0]?.id,
      archive.id,
    );
    const before = await readArchivedFile(root, archive.id, archive.files[0]!.id);
    assert.equal(JSON.parse(before.toString()).unresolvedLiabilityUsd, 0.08);
    assert.equal(archive.interpretation, "uninterpreted_archive");
    await writeFile(resolve(root, base, "manifest.json"), "tampered");
    await assert.rejects(readArchivedFile(root, archive.id, archive.files[0]!.id), /bytes changed/);
    await assert.rejects(readArchivedFile(root, archive.id, "../manifest.json"), /Unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
