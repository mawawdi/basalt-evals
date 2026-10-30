import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableJson } from "../../contracts/src/index.js";
import { loadPublicDevelopmentTask } from "../../development/src/index.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import type { EvalRevision } from "./compiler.js";

/** One materialization path for control staging and immutable publication. */
export async function materializeEvalRevision(input: {
  repositoryRoot: string;
  relativeDirectory: string;
  revision: EvalRevision;
  metadata: unknown;
}): Promise<void> {
  const target = resolve(input.repositoryRoot, input.relativeDirectory);
  const write = async (path: string, content: string) => {
    const file = resolve(target, path);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  };
  const json = (value: unknown) => stableJson(value) + "\n";
  await Promise.all([
    write("task.json", json(input.revision.publicTask)),
    write("evaluator.json", json(input.revision.privateEvaluator)),
    write("development.json", json(input.revision.publicDevelopment)),
    write("seed/default.project.json", json(input.revision.seed.project)),
    write("authoring.json", json(input.metadata)),
    ...input.revision.seed.sources.map((source) => write("seed/" + source.path, source.text)),
  ]);
  await loadRegisteredTask(input.repositoryRoot, input.relativeDirectory);
  await loadPublicDevelopmentTask(input.repositoryRoot, input.relativeDirectory);
}
