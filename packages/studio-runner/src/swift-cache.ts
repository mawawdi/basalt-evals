import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { contentHash, hashJson } from "../../contracts/src/index.js";

const execFile = promisify(execFileCallback);
const MAX_HELPER_BYTES = 16 * 1024 * 1024;

/** Cache an exact Swift source/compiler pair outside the trial's signed outputs. */
export async function cachedSwiftHelper(input: {
  /** The file name of the executable, for example `focus-guard`. */
  name: string;
  source: Buffer;
  compiler: string;
  cacheDirectory: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{ executable: string; cacheHit: boolean }> {
  const compilerVersion = await execFile(input.compiler, ["--version"], {
    env: input.environment,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (!/^[a-z][a-z0-9-]*$/u.test(input.name)) throw new Error("Invalid Swift helper name");
  const identity = hashJson({
    name: input.name,
    sourceHash: contentHash(input.source),
    compiler: input.compiler,
    version: compilerVersion.stdout,
  });
  const root = resolve(input.cacheDirectory);
  await assertSafeAbsoluteDirectory(dirname(root));
  await mkdir(root, { mode: 0o700, recursive: true });
  await assertSafeAbsoluteDirectory(root);
  const cached = resolve(root, identity);
  const valid = async () => {
    try {
      const directory = await lstat(cached);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
      const marker = JSON.parse(
        (
          await readBoundedRegularFile(resolve(cached, "ready.json"), 256, "Swift cache marker")
        ).toString("utf8"),
      ) as { identity?: string; binaryHash?: string };
      const executable = resolve(cached, input.name);
      const info = await lstat(executable);
      if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) return false;
      const binary = await readBoundedRegularFile(executable, MAX_HELPER_BYTES, "Swift helper");
      return marker.identity === identity && marker.binaryHash === contentHash(binary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (await valid()) return { executable: resolve(cached, input.name), cacheHit: true };
  const temporary = await mkdtemp(resolve(root, "build-"));
  try {
    const sourceFile = resolve(temporary, "source.swift");
    const executable = resolve(temporary, input.name);
    await writeFile(sourceFile, input.source, { flag: "wx", mode: 0o600 });
    await execFile(input.compiler, [sourceFile, "-o", executable], {
      env: input.environment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const binary = await readBoundedRegularFile(executable, MAX_HELPER_BYTES, "Swift helper");
    await writeFile(
      resolve(temporary, "ready.json"),
      JSON.stringify({ identity, binaryHash: contentHash(binary) }),
      { flag: "wx", mode: 0o600 },
    );
    try {
      await rename(temporary, cached);
      return { executable: resolve(cached, input.name), cacheHit: false };
    } catch (error) {
      if (!(await valid())) throw error;
      return { executable: resolve(cached, input.name), cacheHit: true };
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
