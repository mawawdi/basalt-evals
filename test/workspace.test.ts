import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { matchesWorkspace, workspaceIdentity } from "../packages/operator/src/workspace.js";

test("workspace reset invalidates stale browser writes without reviving old recovery state", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-workspace-"));
  try {
    const identities = await Promise.all(Array.from({ length: 8 }, () => workspaceIdentity(root)));
    assert.equal(new Set(identities).size, 1, "Concurrent loads share one workspace");
    const request = new Request("http://127.0.0.1/api/working-copies", {
      headers: { "X-Basalt-Workspace": identities[0]! },
    });
    assert.equal(await matchesWorkspace(root, request), true);
    await rm(resolve(root, ".basalt-evals"), { recursive: true });
    const current = await workspaceIdentity(root);
    assert.notEqual(current, identities[0]);
    assert.equal(await matchesWorkspace(root, request), false);
    assert.equal(await matchesWorkspace(root, new Request(request.url)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
