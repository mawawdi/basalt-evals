import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import { ensureStudioReadiness } from "../packages/operator/src/studio-readiness.js";
import {
  AgentInterrupted,
  DevelopmentCandidateError,
} from "../packages/agent-runtime/src/index.js";
import { hashJson, stableJson } from "../packages/contracts/src/index.js";
import { createPublicDevelopmentServices } from "../packages/development/src/service.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import {
  runAdmitted,
  type NativeLaneObserver,
  type StudioAdapter,
} from "../packages/studio-runner/src/adapter.js";
import type { SignedWorkerManifest } from "../packages/studio-runner/src/native-worker.js";
import { fixtureAdapters, fixturePublic } from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";

async function developmentFixture(temporary: string, project?: string) {
  const implementation = await implementationFixture(temporary);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await mkdir(resolve(temporary, ".basalt-evals/native-worker"), { recursive: true });
  await writeFile(
    resolve(temporary, ".basalt-evals/synthetic-private-key.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await writeFile(
    resolve(temporary, ".basalt-evals/native-worker/isolated-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const workspace = resolve(temporary, ".basalt-evals/candidate");
  const seed = neutralRojoSeed("Development admission fixture");
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  await writeFile(resolve(workspace, "default.project.json"), project ?? stableJson(seed.project));
  for (const source of seed.sources) await writeFile(resolve(workspace, source.path), source.text);
  const files = await inventoryTree(workspace);
  const candidate = { rootHash: hashJson(files), projectFile: "default.project.json", files };
  const outputRoot = resolve(temporary, ".basalt-evals/development");
  await mkdir(outputRoot);
  const synthetic = fixtureAdapters(temporary).studio;
  const services = (studio: StudioAdapter, lane?: NativeLaneObserver) =>
    createPublicDevelopmentServices({
      root: temporary,
      outputRoot,
      task: fixturePublic.publicTask,
      recipe: fixturePublic.publicDevelopment,
      recipeHash: hashJson(fixturePublic.publicDevelopment),
      implementationCommit: implementation.implementationCommit,
      maxRuns: 1,
      studio,
      ...(lane ? { lane } : {}),
    });
  return { workspace, candidate, outputRoot, synthetic, services };
}

test("public development waits for the native lane and resumes an undispatched attempt", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-admission-"));
  try {
    const { workspace, candidate, outputRoot, synthetic, services } =
      await developmentFixture(temporary);
    const events: string[] = [];
    let busy = true;
    const studio: StudioAdapter = {
      ...synthetic,
      async admit() {
        events.push("admit");
        return {
          lane: 1,
          connectorUrl: "http://127.0.0.1:43124",
          async release() {
            events.push("release");
          },
        };
      },
      async run(input) {
        events.push("run");
        // The first attempt fails before any dispatch marker exists.
        if (busy) {
          busy = false;
          throw new Error("Synthetic failure before Studio dispatch");
        }
        return synthetic.run(input);
      },
      async reconcile(input) {
        events.push("reconcile");
        return synthetic.reconcile(input);
      },
    };
    const development = services(studio);
    const id = `development-${"a".repeat(24)}`;
    await assert.rejects(development.run(workspace, candidate, "scene", id), AgentInterrupted);
    assert.deepEqual(events, ["admit", "run", "release"]);
    // The session is prepared after admission, for the connector port of the admitted lane.
    assert.equal(
      JSON.parse(await readFile(resolve(outputRoot, id, "studio/session.json"), "utf8"))
        .connectorUrl,
      "http://127.0.0.1:43124",
    );
    // A crash can come after the session folder and before its sequence plan.
    await rm(resolve(outputRoot, id, "studio/sequence.json"));

    const observation = await development.recover!(workspace, candidate, "scene", id);
    assert.equal(observation.evidenceId, id);
    assert.deepEqual(
      events,
      ["admit", "run", "release", "admit", "run", "release"],
      "An undispatched attempt is admitted and run again, never reconciled",
    );
    assert.ok(
      (await readFile(resolve(outputRoot, id, "studio/sequence.json"), "utf8")).length > 0,
      "The recovery writes the absent sequence plan again",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const [name, tree, message] of [
  [
    "a candidate that Rojo cannot build",
    { $className: "DataModel", Missing: { $path: "absent" } },
    /Rojo could not build the Studio place/,
  ],
  [
    "a candidate with the reserved bootstrap name",
    {
      $className: "DataModel",
      Workspace: { $className: "Workspace", BasaltEvalBootstrap: { $className: "Folder" } },
    },
    /must not contain an instance with the name BasaltEvalBootstrap/,
  ],
] as const)
  test(`${name} fails before admission, also after a resume`, async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-rojo-"));
    try {
      const { workspace, candidate, outputRoot, synthetic, services } = await developmentFixture(
        temporary,
        stableJson({ name: "Broken", tree }),
      );
      const events: string[] = [];
      const studio: StudioAdapter = {
        ...synthetic,
        async admit() {
          events.push("admit");
          throw new Error("A broken candidate must not wait for Studio");
        },
      };
      const development = services(studio);
      const id = `development-${"b".repeat(24)}`;
      const candidateFailure = (error: unknown) =>
        error instanceof DevelopmentCandidateError &&
        !(error instanceof AgentInterrupted) &&
        message.test(error.message);
      await assert.rejects(development.run(workspace, candidate, "scene", id), candidateFailure);
      // A resume after a stop finds no session, builds the place again and gets the same result.
      await assert.rejects(
        development.recover!(workspace, candidate, "scene", id),
        candidateFailure,
      );
      assert.deepEqual(events, [], "The broken candidate never took a Studio turn");
      assert.deepEqual(
        (await readdir(resolve(outputRoot, id))).sort(),
        ["candidate"],
        "The place check leaves no temporary folder and no session",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

test("an absent Rojo is a fault of the host, not of the candidate", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-no-rojo-"));
  const path = process.env.PATH;
  try {
    const { workspace, candidate, synthetic, services } = await developmentFixture(temporary);
    let admitted = false;
    const development = services({
      ...synthetic,
      async admit() {
        admitted = true;
        throw new Error("The place check must fail first");
      },
    });
    const empty = resolve(temporary, "empty-bin");
    await mkdir(empty);
    process.env.PATH = empty;
    const hostFault = (error: unknown) =>
      !(error instanceof DevelopmentCandidateError) &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    const id = `development-${"f".repeat(24)}`;
    await assert.rejects(development.run(workspace, candidate, "scene", id), hostFault);
    // The agent runtime makes this plain failure of a recovered call an interruption.
    await assert.rejects(development.recover!(workspace, candidate, "scene", id), hostFault);
    assert.equal(admitted, false);
  } finally {
    process.env.PATH = path;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a failed release does not hide the failure of the Studio test", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-development-release-"));
  try {
    const { workspace, candidate, synthetic, services } = await developmentFixture(temporary);
    let runFails = true;
    const studio: StudioAdapter = {
      ...synthetic,
      async admit() {
        return {
          lane: 0,
          connectorUrl: "http://127.0.0.1:43123",
          async release() {
            throw new Error("Synthetic release failure");
          },
        };
      },
      async run(input) {
        if (runFails) throw new Error("Synthetic run failure");
        return synthetic.run(input);
      },
    };
    const interrupted = (pattern: RegExp) => (error: unknown) =>
      error instanceof AgentInterrupted && pattern.test(error.message);
    await assert.rejects(
      services(studio).run(workspace, candidate, "scene", `development-${"c".repeat(24)}`),
      interrupted(/Synthetic run failure/),
    );
    // Without a run failure, a release failure is an interruption, as before.
    runFails = false;
    await assert.rejects(
      services(studio).run(workspace, candidate, "scene", `development-${"d".repeat(24)}`),
      interrupted(/Synthetic release failure/),
    );
    // A failure of the admission observer is an interruption too.
    await assert.rejects(
      services(
        {
          ...studio,
          admit: async () => ({
            lane: 0,
            connectorUrl: "http://127.0.0.1:43123",
            release: async () => {},
          }),
        },
        {
          onAdmitted: async () => {
            throw new Error("Synthetic observer failure");
          },
        },
      ).run(workspace, candidate, "scene", `development-${"e".repeat(24)}`),
      interrupted(/Synthetic observer failure/),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a failed release does not hide the failure of the readiness check", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "basalt-readiness-release-"));
  try {
    await mkdir(resolve(temporary, ".basalt-evals"));
    const synthetic = fixtureAdapters(temporary).studio;
    await assert.rejects(
      ensureStudioReadiness({
        root: temporary,
        operationId: "readiness-release",
        studio: {
          ...synthetic,
          async admit() {
            return {
              lane: 0,
              connectorUrl: "http://127.0.0.1:43123",
              async release() {
                throw new Error("Synthetic release failure");
              },
            };
          },
          async run() {
            throw new Error("Synthetic readiness run failure");
          },
        },
      }),
      (error) =>
        error instanceof ExecutionFault &&
        /Synthetic readiness run failure/.test(error.message) &&
        !/Synthetic release failure/.test(error.message),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reference controls wait for a native lane, prepare for it, and always release it", async () => {
  const events: string[] = [];
  let fail = false;
  const adapter = {
    async admit(input: { directory: string }) {
      events.push(`admit:${input.directory}`);
      return {
        lane: 1,
        connectorUrl: "http://127.0.0.1:43124",
        async release() {
          events.push("release");
        },
      };
    },
    async run() {
      events.push("run");
      if (fail) throw new Error("Synthetic Studio failure");
      return { manifest: { status: "complete" } } as unknown as SignedWorkerManifest;
    },
  } as unknown as StudioAdapter;
  const input = {
    root: "/repository",
    directory: "/repository/control/studio",
    purpose: "control" as const,
    prepare: async (connectorUrl: string | undefined) => {
      events.push(`prepare:${connectorUrl}`);
    },
  };
  assert.equal((await runAdmitted(adapter, input)).manifest.status, "complete");
  fail = true;
  await assert.rejects(runAdmitted(adapter, input), /Synthetic Studio failure/);
  assert.deepEqual(events, [
    "admit:/repository/control/studio",
    "prepare:http://127.0.0.1:43124",
    "run",
    "release",
    "admit:/repository/control/studio",
    "prepare:http://127.0.0.1:43124",
    "run",
    "release",
  ]);
});
