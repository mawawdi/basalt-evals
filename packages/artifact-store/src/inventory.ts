import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { assertSafeAbsoluteDirectory } from "./index.js";
import { readBoundedRegularFile } from "./regular-file.js";
import {
  MAX_CANDIDATE_BYTES,
  MAX_CANDIDATE_FILES,
  compareCodeUnits,
  contentHash,
} from "../../contracts/src/index.js";

const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_SEED_EXTENSIONS = [".json", ".luau", ".lua", ".toml"];

interface TreeFile {
  path: string;
  hash: string;
  bytes: number;
}

/** Inventory a seed or candidate tree restricted to supported source extensions. */
export async function inventoryTree(directory: string): Promise<TreeFile[]> {
  return walkRegularTree(directory, {
    label: "Tree",
    maxFileBytes: MAX_SEED_FILE_BYTES,
    accept: (path) => ALLOWED_SEED_EXTENSIONS.some((extension) => path.endsWith(extension)),
  });
}

/**
 * Walk a regular directory tree without following symbolic links and return every file
 * in code-unit path order — the only order a candidate manifest accepts. Every package
 * that hashes a workspace must use this walker so the hashes agree.
 */
export async function walkRegularTree(
  directory: string,
  options: { label: string; maxFileBytes: number; accept?: (path: string) => boolean },
): Promise<TreeFile[]> {
  const root = resolve(directory);
  await assertSafeAbsoluteDirectory(root);
  const files: TreeFile[] = [];
  let totalBytes = 0;
  async function visit(current: string): Promise<void> {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`${options.label} contains an unsafe directory: ${current}`);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const path = resolve(current, entry.name);
      const logicalPath = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink())
        throw new Error(`${options.label} contains a symbolic link: ${logicalPath}`);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`${options.label} contains a non-regular file: ${logicalPath}`);
      if (options.accept && !options.accept(logicalPath))
        throw new Error(`${options.label} contains an unsupported file: ${logicalPath}`);
      if (files.length >= MAX_CANDIDATE_FILES)
        throw new Error(`${options.label} exceeds file-count limit`);
      const bytes = await readBoundedRegularFile(
        path,
        options.maxFileBytes,
        `${options.label} file ${logicalPath}`,
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_CANDIDATE_BYTES) throw new Error(`${options.label} exceeds byte limit`);
      files.push({ path: logicalPath, hash: contentHash(bytes), bytes: bytes.byteLength });
    }
  }
  await visit(root);
  return files.sort((left, right) => compareCodeUnits(left.path, right.path));
}
