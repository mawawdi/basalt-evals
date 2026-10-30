import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { stableJson } from "../../contracts/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { loadPublicDevelopmentTask } from "../../development/src/index.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import { EvalDefinitionStore } from "./store.js";
import { materializeEvalRevision } from "./materialize.js";

const execFile = promisify(execFileCallback);
const hashPattern = /^[a-f0-9]{64}$/u;

/** Materialize and compile the frozen definition before registration or reference testing. */
export async function stageEvalRevision(
  repositoryRoot: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<{ directory: string; taskId: string }> {
  if (!hashPattern.test(revisionId)) throw new Error("Invalid eval revision ID");
  const root = resolve(repositoryRoot);
  const store = new EvalDefinitionStore(root);
  const revision = await store.readExecutableRevision(revisionId);
  const directory = ".basalt-evals/eval-staging/" + revisionId;
  const target = resolve(root, directory);
  const stagingRoot = resolve(root, ".basalt-evals/eval-materialization");
  const files = new RepositoryFiles(root);
  await files.directory(dirname(target));
  await files.directory(stagingRoot);
  const stagingName = revisionId + "-" + randomUUID();
  const staging = resolve(stagingRoot, stagingName);
  await mkdir(staging, { mode: 0o700 });
  const json = (value: unknown) => stableJson(value) + "\n";
  const metadata = json({
    schema: "basalt-evals/eval-staging",
    revisionId,
    draftId: revision.draftId,
    builderPromptHash: revision.builderPromptHash,
    rubricHash: revision.rubricHash,
    status: "ready",
  });
  try {
    await materializeEvalRevision({
      repositoryRoot: root,
      relativeDirectory: ".basalt-evals/eval-materialization/" + stagingName,
      revision,
      metadata: JSON.parse(metadata),
    });
    const task = await loadRegisteredTask(
      root,
      ".basalt-evals/eval-materialization/" + stagingName,
    );
    const temporary = await mkdtemp(join(tmpdir(), "basalt-eval-revision-"));
    try {
      for (const source of revision.seed.sources)
        await execFile("luau-compile", ["--only-parse", resolve(staging, "seed", source.path)], {
          cwd: root,
          timeout: 30_000,
          ...(signal ? { signal } : {}),
        });
      await execFile(
        "rojo",
        [
          "build",
          resolve(staging, "seed/default.project.json"),
          "-o",
          resolve(temporary, "place.rbxlx"),
        ],
        {
          cwd: root,
          timeout: 120_000,
          ...(signal ? { signal } : {}),
          maxBuffer: 1024 * 1024,
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      const existing = await loadRegisteredTask(root, directory);
      const existingDevelopment = await loadPublicDevelopmentTask(root, directory);
      const stagedDevelopment = await loadPublicDevelopmentTask(
        root,
        ".basalt-evals/eval-materialization/" + stagingName,
      );
      if (
        existing.publicTaskHash !== task.publicTaskHash ||
        existing.evaluatorHash !== task.evaluatorHash ||
        existing.seedHash !== task.seedHash ||
        existingDevelopment.recipeHash !== stagedDevelopment.recipeHash ||
        (await files.bytes(directory + "/authoring.json", 4096)).toString("utf8") !== metadata
      )
        throw new Error("Staged eval revision already contains different bytes");
    }
    return { directory, taskId: task.id };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
