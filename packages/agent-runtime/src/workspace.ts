import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { walkRegularTree } from "../../artifact-store/src/inventory.js";
import {
  compareCodeUnits,
  MAX_CANDIDATE_BYTES,
  MAX_CANDIDATE_FILES,
  contentHash,
  hashJson,
  stableJson,
  type CandidateManifest,
  type PublicTask,
} from "../../contracts/src/index.js";
import { readPublicSeedScene, type PublicSeedScene } from "./public-scene.js";
import { MAX_TOOL_RESULT_BYTES, type ParsedToolCall } from "./tools.js";

const MAX_SOURCE_BYTES = 512 * 1024;
const SOURCE_EXTENSION = /\.(?:lua|luau)$/;

/**
 * The candidate workspace of one build. Each read and write stays inside the declared source
 * roots, opens only regular files and stops on a symbolic link. A replacement needs the current
 * hash of the file, and a creation needs null.
 */
export class CandidateWorkspace {
  readonly root: string;
  private readonly sourceRoots: string[];
  private scene: PublicSeedScene | null = null;

  constructor(
    root: string,
    private readonly seed: PublicTask["seed"],
  ) {
    this.root = resolve(root);
    this.sourceRoots = seed.sourceRoots;
  }

  async assertSafe(): Promise<void> {
    await assertSafeAbsoluteDirectory(this.root);
    const rootInfo = await lstat(this.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error("Candidate workspace must be a regular directory");
    const files = await this.files();
    const project = files.find((file) => file.path === this.seed.projectFile);
    if (!project) throw new Error("Public seed project is missing from the candidate workspace");
    this.scene = await readPublicSeedScene(this.root, this.seed, project.hash);
    if (
      Buffer.byteLength(stableJson({ ok: true, ...(await this.describe()) }), "utf8") >
      MAX_TOOL_RESULT_BYTES
    )
      throw new Error("Public seed scene and source inventory exceed the tool result byte limit");
  }

  async assertProjectUnchanged(): Promise<void> {
    if (!this.scene) throw new Error("Public seed scene has not been inspected");
    const bytes = await readRegularFile(
      within(this.root, this.seed.projectFile),
      MAX_CANDIDATE_BYTES,
      "public seed project",
    );
    if (contentHash(bytes) !== this.scene.projectHash)
      throw new Error("Public seed project changed during the bounded attempt");
  }

  async describe(): Promise<{
    files: Array<{ path: string; hash: string; bytes: number }>;
    scene: PublicSeedScene;
  }> {
    if (!this.scene) throw new Error("Public seed scene has not been inspected");
    return { files: await this.list(), scene: structuredClone(this.scene) };
  }

  async list(): Promise<Array<{ path: string; hash: string; bytes: number }>> {
    return this.files(true);
  }

  async read(path: string): Promise<{ path: string; content: string; hash: string }> {
    const absolute = this.sourcePath(path);
    const content = (await readRegularFile(absolute, MAX_SOURCE_BYTES, `source ${path}`)).toString(
      "utf8",
    );
    return { path, content, hash: contentHash(content) };
  }

  async search(needle: string): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!needle.trim() || needle.length > 200)
      throw new Error("Search text must be 1–200 characters");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of await this.list()) {
      const source = await this.read(file.path);
      const lines = source.content.split("\n");
      for (let index = 0; index < lines.length; index += 1)
        if (lines[index]!.includes(needle)) {
          matches.push({ path: file.path, line: index + 1, text: lines[index]!.slice(0, 400) });
          if (matches.length >= 100) return matches;
        }
    }
    return matches;
  }

  async patch(
    path: string,
    expectedHash: string,
    before: string,
    after: string,
  ): Promise<{ hash: string }> {
    if (!before || before.length > 16_384 || after.length > 32_768)
      throw new Error("Patch text exceeds its exact replacement boundary");
    const current = await this.read(path);
    if (current.hash !== expectedHash)
      throw new Error(`Hash mismatch for ${path}; found ${current.hash}`);
    const first = current.content.indexOf(before);
    if (first < 0 || current.content.indexOf(before, first + before.length) >= 0)
      throw new Error("Patch precondition must match exactly once");
    return this.write(
      path,
      current.content.slice(0, first) + after + current.content.slice(first + before.length),
      expectedHash,
    );
  }

  async write(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    const absolute = this.sourcePath(path);
    const contentBytes = Buffer.from(content, "utf8");
    if (contentBytes.byteLength > MAX_SOURCE_BYTES)
      throw new Error(`Source exceeds byte limit: ${path}`);
    const inventory = await this.files();
    const existing = inventory.find((file) => file.path === path);
    const actualHash = existing?.hash ?? null;
    if (actualHash !== expectedHash) {
      throw new Error(
        actualHash === null
          ? `Creation of ${path} requires expectedHash null`
          : `Hash mismatch for ${path}; expected ${String(expectedHash)}, found ${actualHash}`,
      );
    }
    if (existing === undefined && inventory.length >= MAX_CANDIDATE_FILES)
      throw new Error("Candidate workspace exceeds file-count limit");
    const totalBytes = inventory.reduce((sum, file) => sum + file.bytes, 0);
    const nextTotal = totalBytes - (existing?.bytes ?? 0) + contentBytes.byteLength;
    if (nextTotal > MAX_CANDIDATE_BYTES) throw new Error("Candidate workspace exceeds byte limit");
    const parent = resolve(absolute, "..");
    await assertExistingDirectoryChain(this.root, parent);
    const temporary = resolve(
      dirname(absolute),
      `.${relative(this.root, absolute).replaceAll(sep, "_")}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporary, contentBytes, { mode: 0o600, flag: "wx", flush: true });
      if (actualHash === null) {
        await link(temporary, absolute);
      } else {
        const current = await readRegularFile(absolute, MAX_SOURCE_BYTES, `source ${path}`);
        if (contentHash(current) !== actualHash)
          throw new Error(`Source changed while replacing ${path}`);
        await rename(temporary, absolute);
      }
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    await this.files();
    return { hash: contentHash(contentBytes) };
  }

  async manifest(projectFile: string): Promise<CandidateManifest> {
    const files = await this.files();
    return { rootHash: hashJson(files), projectFile, files };
  }

  /** Persist the exact admissible post-write tree before executing a mutation. */
  async expectedWrite(
    call: ParsedToolCall,
    projectFile: string,
  ): Promise<CandidateManifest | null> {
    if (call.name !== "workspace.write" && call.name !== "workspace.patch") return null;
    try {
      this.sourcePath(call.arguments.path);
      const manifest = await this.manifest(projectFile);
      const prior = manifest.files.find((file) => file.path === call.arguments.path);
      if ((prior?.hash ?? null) !== call.arguments.expectedHash) return null;
      let content: string;
      if (call.name === "workspace.write") content = call.arguments.content;
      else {
        const source = await this.read(call.arguments.path);
        const { before, after } = call.arguments;
        const index = source.content.indexOf(before);
        if (
          !before ||
          before.length > 16_384 ||
          after.length > 32_768 ||
          index < 0 ||
          source.content.indexOf(before, index + before.length) >= 0
        )
          return null;
        content =
          source.content.slice(0, index) + after + source.content.slice(index + before.length);
      }
      const bytes = Buffer.byteLength(content, "utf8");
      const files = manifest.files.filter((file) => file.path !== call.arguments.path);
      files.push({ path: call.arguments.path, hash: contentHash(content), bytes });
      files.sort((left, right) => compareCodeUnits(left.path, right.path));
      if (
        bytes > MAX_SOURCE_BYTES ||
        files.length > MAX_CANDIDATE_FILES ||
        files.reduce((sum, file) => sum + file.bytes, 0) > MAX_CANDIDATE_BYTES
      )
        return null;
      return { projectFile, files, rootHash: hashJson(files) };
    } catch {
      return null;
    }
  }

  private sourcePath(path: string): string {
    if (!isSafePath(path) || !SOURCE_EXTENSION.test(path))
      throw new Error("Workspace paths must name regular .lua or .luau source");
    if (!this.sourceRoots.some((root) => path === root || path.startsWith(`${root}/`)))
      throw new Error(`Workspace path is outside declared source roots: ${path}`);
    return within(this.root, path);
  }

  private async files(
    sourcesOnly = false,
  ): Promise<Array<{ path: string; hash: string; bytes: number }>> {
    const files = await inventoryAllFiles(this.root);
    if (
      this.scene &&
      files.find((file) => file.path === this.seed.projectFile)?.hash !== this.scene.projectHash
    )
      throw new Error("Public seed project changed during the bounded attempt");
    return sourcesOnly
      ? files.filter(
          (file) =>
            SOURCE_EXTENSION.test(file.path) &&
            this.sourceRoots.some((root) => file.path.startsWith(`${root}/`)),
        )
      : files;
  }
}

async function inventoryAllFiles(
  root: string,
): Promise<Array<{ path: string; hash: string; bytes: number }>> {
  return walkRegularTree(root, { label: "Candidate workspace", maxFileBytes: MAX_CANDIDATE_BYTES });
}

async function assertExistingDirectoryChain(root: string, destination: string): Promise<void> {
  await assertSafeAbsoluteDirectory(root);
  const relation = relative(root, destination);
  if (relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error("Directory escapes workspace");
  let current = root;
  for (const part of relation.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Unsafe workspace directory: ${current}`);
  }
}

async function readRegularFile(file: string, maxBytes: number, label: string): Promise<Buffer> {
  await assertSafeAbsoluteDirectory(dirname(resolve(file)));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new Error(`Cannot open regular ${label}`, { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error(`${label} exceeds its regular-file boundary`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`${label} grew beyond its byte limit`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function within(root: string, path: string): string {
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`Path escapes workspace: ${path}`);
  return absolute;
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
