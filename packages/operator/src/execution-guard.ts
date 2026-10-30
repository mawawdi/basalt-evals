import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { compareCodeUnits, contentHash, hashJson } from "../../contracts/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { assertRunIdentityFree } from "./run-visibility.js";

interface BuildIdentity {
  node: string;
  platform: string;
  architecture: string;
  sources: string;
  executable: string;
  dependencies: string;
}

// Every guard rechecks the files on disk. Any write changes a file's ctime, which user
// code cannot set, so an unchanged inode, size, mtime and ctime proves unchanged bytes
// and a recheck only rereads files that changed.
const fileHashes = new Map<string, { identity: string; hash: string }>();

async function fileHash(file: string): Promise<string> {
  const info = await lstat(file, { bigint: true });
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const cached = fileHashes.get(file);
  if (cached?.identity === identity) return cached.hash;
  const hash = contentHash(await readFile(file));
  fileHashes.set(file, { identity, hash });
  return hash;
}

async function treeHash(root: string, name: string): Promise<string> {
  const files: Array<{ path: string; hash: string }> = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Implementation contains a symbolic link");
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        /\.(?:ts|js|mjs|cjs|json|luau|node)$/u.test(path) &&
        !path.endsWith("/build-identity.json")
      )
        files.push({ path, hash: await fileHash(resolve(root, path)) });
    }
  }
  await visit(name);
  return hashJson(files.sort((a, b) => compareCodeUnits(a.path, b.path)));
}

export async function measureBuildIdentity(root: string): Promise<BuildIdentity> {
  const [sources, executable, dependencies] = await Promise.all([
    treeHash(root, "packages"),
    treeHash(root, "dist/packages"),
    readFile(resolve(root, "package-lock.json")),
  ]);
  const lock = JSON.parse(dependencies.toString("utf8")) as {
    packages?: Record<string, { dependencies?: Record<string, string> }>;
  };
  const installed = await Promise.all(
    Object.keys(lock.packages?.[""]?.dependencies ?? {})
      .sort()
      .map(async (name) => {
        if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+$/iu.test(name))
          throw new Error("Invalid runtime dependency name");
        return { name, files: await treeHash(root, `node_modules/${name}`) };
      }),
  );
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sources,
    executable,
    dependencies: hashJson({ lock: contentHash(dependencies), installed }),
  };
}

export async function assertCurrentBuild(root: string): Promise<string> {
  const recorded = JSON.parse(
    await readFile(resolve(root, "dist/build-identity.json"), "utf8"),
  ) as BuildIdentity;
  const current = await measureBuildIdentity(root);
  if (hashJson(current) !== hashJson(recorded))
    throw new Error(
      "The compiled Basalt code, its dependencies or the Node.js runtime changed. Restart the console to compile Basalt again. Then start a new run.",
    );
  return hashJson(current);
}

/** The clean commit and the current build identity hash of the checkout. */
async function currentImplementation(
  root: string,
  expectedCommit?: string,
): Promise<{ implementationCommit: string; buildIdentityHash: string }> {
  // Both checks run together; a dirty or moved checkout is reported before a stale build.
  const [commit, build] = await Promise.allSettled([
    cleanImplementationCommit(root, expectedCommit),
    assertCurrentBuild(root),
  ]);
  if (commit.status === "rejected") throw commit.reason;
  if (build.status === "rejected") throw build.reason;
  return { implementationCommit: commit.value, buildIdentityHash: build.value };
}

/** Read-only inspection is separate; every new execution must pass this guard. */
export async function assertExecutionImplementation(
  root: string,
  manifest: { implementationCommit: string; buildIdentityHash: string },
): Promise<void> {
  const current = await currentImplementation(root, manifest.implementationCommit);
  if (current.buildIdentityHash !== manifest.buildIdentityHash)
    throw new Error("The compiled Basalt code changed after this run started. Start a new run.");
}

/** Preparation and controls bind the same implementation before making their first call. */
export async function bindOperationImplementation(
  root: string,
  operationId: string,
  contextHash: string,
): Promise<() => Promise<void>> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId) || !/^[a-f0-9]{64}$/u.test(contextHash))
    throw new Error("Invalid execution identity");
  await assertRunIdentityFree(root, operationId);
  const files = new RepositoryFiles(root);
  const path = `.basalt-evals/eval-operations/${operationId}/implementation.json`;
  const saved = await files.optional<{
    implementationCommit: string;
    buildIdentityHash: string;
    contextHash: string;
  }>(path);
  if (saved) {
    if (saved.contextHash !== contextHash)
      throw new Error("Operation implementation belongs to another frozen context");
    await assertExecutionImplementation(root, saved);
    return () => assertExecutionImplementation(root, saved);
  }
  // The first bind measures the clean implementation one time. That measurement is its check.
  const identity = { ...(await currentImplementation(root)), contextHash };
  await files.writeJsonOnce(path, identity);
  return () => assertExecutionImplementation(root, identity);
}
