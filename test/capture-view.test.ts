import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorCaptureViews } from "../packages/studio-runner/src/capture-view.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { contentHash, type StudioCollectionPlan } from "../packages/contracts/src/index.js";

test("grader acquisition consumes hash-bound actor geometry and rejects missing, unstable, or altered provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-actor-view-"));
  const plan = {
    phases: [
      {
        id: "scene",
        driver: { kind: "observe_from_actor", targetPath: "role.subject", timeoutMs: 1000 },
        captures: [{ id: "frame" }],
      },
    ],
  } as StudioCollectionPlan;
  const data = {
    phaseId: "scene",
    captureId: "frame",
    originX: 2,
    originY: 5,
    originZ: 18,
    actorX: 2,
    actorY: 3,
    actorZ: 18,
    lookX: 1,
    lookY: 0,
    lookZ: 0,
    fieldOfView: 70,
  };
  const events = [
    {
      source: "plugin",
      stage: "capture.actor_view",
      sequence: 1,
      trialId: "trial",
      client: { id: "client" },
      data,
    },
    {
      source: "plugin",
      stage: "capture.actor_target",
      sequence: 2,
      trialId: "trial",
      client: { id: "client" },
      data: {
        phaseId: "scene",
        captureId: "frame",
        targetPresent: true,
        aimed: true,
        targetX: 20,
        targetY: 5,
        targetZ: 18,
      },
    },
    {
      source: "plugin",
      stage: "capture.camera_restored",
      sequence: 3,
      trialId: "trial",
      client: { id: "client" },
      data: { phaseId: "scene", captureId: "frame", stable: true },
    },
    {
      source: "plugin",
      stage: "capture.actor_view_restored",
      sequence: 4,
      trialId: "trial",
      client: { id: "client" },
      data: { phaseId: "scene", captureId: "frame", completed: true },
    },
  ];
  const base = "studio";
  try {
    await mkdir(join(root, base, "traces"), { recursive: true });
    await mkdir(join(root, base, "native"));
    const publish = async (value: unknown[]) => {
      const bytes = Buffer.from(value.map((event) => JSON.stringify(event)).join("\n") + "\n");
      await writeFile(join(root, base, "traces/trace-fixture.jsonl"), bytes);
      await writeFile(
        join(root, base, "native/manifest.json"),
        JSON.stringify({
          manifest: {
            artifacts: [
              { file: "traces/trace-fixture.jsonl", hash: contentHash(bytes), bytes: bytes.length },
            ],
          },
        }),
      );
    };
    const files = new RepositoryFiles(root);
    await publish(events);
    const views = await actorCaptureViews(files, base, plan, ["frame"]);
    assert.equal(views[0]!.geometry.originZ, 18);
    assert.equal(views[0]!.targetPath, "role.subject");
    assert.deepEqual(views[0]!.target, [20, 5, 18]);
    assert.deepEqual(await actorCaptureViews(files, base, plan, []), []);
    await writeFile(join(root, base, "traces/trace-fixture.jsonl"), "tampered");
    await assert.rejects(actorCaptureViews(files, base, plan, ["frame"]), /differs from signed/);
    await publish(events.slice(0, 3));
    await assert.rejects(actorCaptureViews(files, base, plan, ["frame"]), /stable acquisition/);
    await publish([...events, events[0]]);
    await assert.rejects(actorCaptureViews(files, base, plan, ["frame"]), /ambiguous/);
    await publish(events.filter((event) => event.stage !== "capture.actor_target"));
    await assert.rejects(actorCaptureViews(files, base, plan, ["frame"]), /stable acquisition/);
    await publish(
      events.map((event) =>
        event.stage === "capture.actor_target"
          ? { ...event, client: { id: "other-client" } }
          : event,
      ),
    );
    await assert.rejects(actorCaptureViews(files, base, plan, ["frame"]), /stable acquisition/);
    await publish(
      events.map((event, index) =>
        index === 1
          ? { ...event, data: { ...event.data, targetPresent: false, aimed: false } }
          : event,
      ),
    );
    assert.equal((await actorCaptureViews(files, base, plan, ["frame"]))[0]!.target, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
