import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import {
  contentHash,
  hashJson,
  isSafeRelativePath,
  type CandidateManifest,
} from "../../contracts/src/index.js";

/** Copy only hash-bound regular source files into a new, isolated workspace. */
export async function snapshotCandidateTree(input: {
  source: string;
  target: string;
  expectedHash: string;
  projectFile: string;
}): Promise<CandidateManifest> {
  const files = await inventoryTree(input.source);
  const rootHash = hashJson(files);
  if (rootHash !== input.expectedHash || !files.some((file) => file.path === input.projectFile))
    throw new Error("Candidate source or project file changed before snapshot");
  await mkdir(input.target, { mode: 0o700 });
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error("Candidate contains an unsafe path");
    const bytes = await readBoundedRegularFile(
      resolve(input.source, file.path),
      Math.max(1, file.bytes),
      `candidate ${file.path}`,
    );
    if (bytes.length !== file.bytes || contentHash(bytes) !== file.hash)
      throw new Error(`Candidate changed during snapshot: ${file.path}`);
    const output = resolve(input.target, file.path);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  }
  return { projectFile: input.projectFile, files, rootHash };
}
