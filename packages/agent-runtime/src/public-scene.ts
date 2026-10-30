import { lstat } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import {
  contentHash,
  isSafeRelativePath,
  type JsonValue,
  type PublicTask,
} from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";

const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_DEPTH = 64;
const SOURCE_EXTENSION = /\.(?:lua|luau)$/u;

export type PublicSeedScene = {
  projectFile: string;
  projectHash: string;
  tree: Record<string, JsonValue>;
};

/** Describe only the declared public project; never follow another project or read its sources. */
export async function readPublicSeedScene(
  root: string,
  seed: PublicTask["seed"],
  expectedHash: string,
): Promise<PublicSeedScene> {
  const bytes = await readBoundedRegularFile(
    resolve(root, seed.projectFile),
    MAX_PROJECT_BYTES,
    "public seed project",
  );
  if (contentHash(bytes) !== expectedHash)
    throw new Error("Public seed project changed during inspection");
  const project: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(project) || !isRecord(project.tree))
    throw new Error("Public seed project must contain a declarative tree");

  const visit = async (node: Record<string, unknown>, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw new Error("Public seed scene exceeds its depth limit");
    for (const [key, value] of Object.entries(node)) {
      if (key === "$className") {
        if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(value))
          throw new Error("Public seed scene has an invalid class declaration");
      } else if (key === "$properties") {
        if (!isRecord(value)) throw new Error("Public seed properties must be literal JSON data");
        assertLiteralJson(value, depth + 1);
      } else if (key === "$path") {
        if (typeof value !== "string" || !isSafeRelativePath(value))
          throw new Error("Public seed source mappings must be safe relative paths");
        const path = posix.join(posix.dirname(seed.projectFile), value);
        if (
          !seed.sourceRoots.some(
            (sourceRoot) => path === sourceRoot || path.startsWith(`${sourceRoot}/`),
          )
        )
          throw new Error("Public seed source mapping is outside declared source roots");
        const absolute = resolve(root, path);
        await assertSafeAbsoluteDirectory(dirname(absolute));
        const info = await lstat(absolute);
        if (
          info.isSymbolicLink() ||
          !(info.isDirectory() || (info.isFile() && SOURCE_EXTENSION.test(path)))
        )
          throw new Error("Public seed source mapping must name a regular Luau file or directory");
      } else if (key.startsWith("$") || !key || key.includes("\0") || !isRecord(value)) {
        throw new Error("Public seed scene contains an unsupported node declaration");
      } else await visit(value, depth + 1);
    }
  };
  await visit(project.tree, 0);
  return {
    projectFile: seed.projectFile,
    projectHash: expectedHash,
    tree: project.tree as Record<string, JsonValue>,
  };
}

function assertLiteralJson(value: unknown, depth: number): void {
  if (depth > MAX_TREE_DEPTH) throw new Error("Public seed scene exceeds its depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertLiteralJson(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertLiteralJson(item, depth + 1);
    return;
  }
  throw new Error("Public seed properties must be finite literal JSON data");
}
