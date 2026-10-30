import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import test from "node:test";
import { OperationJournal } from "../../packages/artifact-store/src/journal.js";
import { createSharedApiFixture } from "../shared-api-environment.js";

test("synthetic teardown removes crashed-worker fixtures and is idempotent", async () => {
  const fixture = await createSharedApiFixture();
  try {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((done, fail) => {
      child.once("error", fail);
      child.once("exit", () => done());
    });
    assert.ok(child.pid);
    const journal = await OperationJournal.open(fixture.root);
    journal.put("drivers", "crashed-synthetic-worker", { pid: child.pid, active: true });
    journal.close();
    await fixture.dispose();
    await fixture.dispose();
    await assert.rejects(access(fixture.root), { code: "ENOENT" });
  } finally {
    await fixture.dispose();
  }
});
