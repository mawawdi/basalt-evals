import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  frozenNotesPackDirectory,
  freezeNotesPack,
  loadNotesPack,
  openFrozenNotesPack,
} from "../packages/agent-runtime/src/notes.js";
import { runAgent } from "../packages/agent-runtime/src/index.js";
import { stableJson, type HarnessDefinition } from "../packages/contracts/src/index.js";
import { readHarnessRegistry } from "../packages/operator/src/config.js";
import { checkNotesPacks } from "../packages/operator/src/harness-notes.js";
import { operationTreatments } from "../packages/operator/src/run-manifest.js";
import {
  freezeRegisteredEvalRun,
  quoteRegisteredEvalRun,
} from "../packages/operator/src/run-plan.js";
import type { ModelTurnRequest } from "../packages/model-client/src/contracts.js";
import {
  assistantAnswer,
  builderDescriptor,
  builderTask,
  builderTreatment,
  builderWorkspace,
  reidentify,
  testHarness,
} from "./builder-fixture.js";
import { fixtureAdapters, fixturePrivate, fixtureSnapshots } from "./shared-api-fixture.js";
import { readyRunProject } from "./run-fixture.js";

const NOTES =
  "# Remotes\n\nA RemoteEvent in ReplicatedStorage connects the server and each client.\n";

/** Write an authored pack and a harness that reads it. */
async function writeNotesHarness(root: string, id: string, text = NOTES) {
  await mkdir(resolve(root, `studies/notes/${id}`), { recursive: true });
  await writeFile(
    resolve(root, `studies/notes/${id}/pack.json`),
    stableJson({
      schema: "basalt-evals/notes-pack",
      id,
      title: "Test notes",
      review: "person_reviewed",
      files: [{ path: "remotes.md", title: "Remotes" }],
    }),
  );
  await writeFile(resolve(root, `studies/notes/${id}/remotes.md`), text);
  const harness = testHarness({
    id,
    title: "Notes tools",
    promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{notes}}",
    tools: [...testHarness().tools, "notes.list", "notes.read"],
  });
  await mkdir(resolve(root, "studies/harnesses"), { recursive: true });
  await writeFile(
    resolve(root, `studies/harnesses/${id}.json`),
    stableJson({ ...harness, notesPack: id }),
  );
}

test("a pack freezes its exact files into the treatment", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-notes-freeze-"));
  try {
    const { selection } = await readyRunProject(root, () => writeNotesHarness(root, "notes"));
    const pack = await loadNotesPack(root, "notes");
    const registered = (await readHarnessRegistry(root)).harnesses.find(
      (harness) => harness.id === "notes",
    )!;
    assert.deepEqual(registered.notesPack, { id: "notes", hash: pack.hash });
    const saved = await quoteRegisteredEvalRun({
      root,
      snapshots: fixtureSnapshots.filter((model) => model.id === "openai/gpt-6-luna"),
      selection: selection(["notes"]),
    });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-notes-freeze",
      ceilingUsd: 1,
      adapters: fixtureAdapters(root),
    });
    assert.deepEqual(operationTreatments(manifest)[0]!.harness.notesPack, {
      id: "notes",
      hash: pack.hash,
    });
    const frozen = resolve(root, frozenNotesPackDirectory(pack.hash));
    assert.equal(await readFile(resolve(frozen, "remotes.md"), "utf8"), NOTES);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(frozen, "manifest.json"), "utf8")),
      pack.manifest,
    );
    const reader = await openFrozenNotesPack(root, { id: "notes", hash: pack.hash });
    assert.equal((await reader.read("remotes.md")).content, NOTES);
    // One changed byte gives another pack identity, and thus another treatment.
    await writeFile(resolve(root, "studies/notes/notes/remotes.md"), NOTES + " ");
    assert.notEqual((await loadNotesPack(root, "notes")).hash, pack.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notes.read refuses paths outside the frozen pack", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-notes-read-"));
  const workspace = await builderWorkspace();
  try {
    await writeNotesHarness(root, "notes");
    const pack = await freezeNotesPack(root, {
      id: "notes",
      hash: (await loadNotesPack(root, "notes")).hash,
    });
    const notes = await openFrozenNotesPack(root, { id: "notes", hash: pack.hash });
    const harness: HarnessDefinition = testHarness({
      title: "Notes tools",
      promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{notes}}",
      tools: [...testHarness().tools, "notes.list", "notes.read"],
      notesPack: { id: "notes", hash: pack.hash },
    });
    const read = (id: string, path: string) => ({ id, name: "notes.read", arguments: { path } });
    const requests: ModelTurnRequest[] = [];
    const script = [
      [
        { id: "list", name: "notes.list", arguments: {} },
        read("parent", "../pack.json"),
        read("absolute", "/etc/hosts"),
        read("manifest", "manifest.json"),
        read("unlisted", "missing.md"),
        read("listed", "remotes.md"),
      ],
      [{ id: "finish", name: "workspace.finish", arguments: { summary: "Read the notes." } }],
    ];
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: reidentify({ ...builderTreatment(), harness }),
      notes,
      modelClient: {
        descriptor: builderDescriptor,
        async complete(request) {
          requests.push(structuredClone(request));
          return assistantAnswer(request, `turn-${requests.length}`, script[requests.length - 1]!);
        },
      },
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.equal(run.status, "locally_eligible");
    assert.deepEqual(requests[0]!.tools.map((tool) => tool.name).slice(-2), [
      "notes.list",
      "notes.read",
    ]);
    assert.match(requests[0]!.messages[0]!.content, /API notes: call notes\.list/u);
    const results = Object.fromEntries(
      requests[1]!.messages.flatMap((message) =>
        message.role === "tool" ? [[message.toolCallId, JSON.parse(message.content)]] : [],
      ),
    );
    assert.deepEqual(
      results.list.files.map((file: { path: string }) => file.path),
      ["remotes.md"],
    );
    for (const id of ["parent", "absolute", "manifest", "unlisted"])
      assert.match(results[id].error, /Unknown API notes path/u, id);
    assert.equal(results.listed.content, NOTES);
    // A frozen file that a link replaced cannot be read.
    const frozen = resolve(root, frozenNotesPackDirectory(pack.hash), "remotes.md");
    await unlink(frozen);
    await symlink(resolve(root, "studies/notes/notes/remotes.md"), frozen);
    await assert.rejects(notes.read("remotes.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a pack that repeats private criterion text cannot freeze", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-notes-leak-"));
  try {
    const criterion =
      "The gate opens only after both players stand on their plates for two full seconds.";
    const revision = {
      authored: { rubric: "- Both players can open the gate." },
      privateEvaluator: { ...fixturePrivate.privateEvaluator, humanReview: [criterion] },
    };
    const words = criterion.split(" ");
    // Eleven shared words are not a copy. Twelve words of the criterion are.
    await writeNotesHarness(root, "near", `Notes: ${words.slice(0, 11).join(" ")} and more.\n`);
    await writeNotesHarness(
      root,
      "leaky",
      `Notes: ${words.slice(2, 14).join(" ").toUpperCase()}!\n`,
    );
    const harness = async (id: string) => {
      const pack = await loadNotesPack(root, id);
      return testHarness({
        id,
        promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{notes}}",
        tools: [...testHarness().tools, "notes.list", "notes.read"],
        notesPack: { id, hash: pack.hash },
      });
    };
    const near = await harness("near");
    await checkNotesPacks({ root, harnesses: [near], revision, freeze: true });
    assert.ok(existsSync(resolve(root, frozenNotesPackDirectory(near.notesPack!.hash))));
    const leaky = await harness("leaky");
    await assert.rejects(
      checkNotesPacks({ root, harnesses: [leaky], revision, freeze: true }),
      /repeats text from the private criteria or the Studio plan/u,
    );
    assert.ok(!existsSync(resolve(root, frozenNotesPackDirectory(leaky.notesPack!.hash))));
    // The starter pack of the repository waits for the review of a person.
    const starter = await loadNotesPack(process.cwd(), "roblox-api-basics");
    assert.equal(starter.manifest.review, "needs_person_review");
    await assert.rejects(
      checkNotesPacks({
        root: process.cwd(),
        harnesses: [
          testHarness({ ...near, notesPack: { id: starter.manifest.id, hash: starter.hash } }),
        ],
        revision,
        freeze: false,
      }),
      /needs a person's review/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
