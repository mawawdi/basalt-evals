import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { publishImmutable } from "./atomic.js";
import { dirname, relative, resolve, sep } from "node:path";
import {
  assertArtifactReference,
  assertSafeAbsoluteDirectory,
  type ArtifactReference,
} from "./index.js";
import { hashJson, stableJson } from "../../contracts/src/index.js";

/** Bounded local artifact access. No browser-supplied path bypasses this boundary. */
export class RepositoryFiles {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  relative(file: string): string {
    const result = relative(this.root, resolve(this.root, file));
    if (!result || result === ".." || result.startsWith(`..${sep}`))
      throw new Error("Artifact path must remain inside the repository");
    return result.split(sep).join("/");
  }
  path(file: string): string {
    return resolve(this.root, this.relative(file));
  }
  async bytes(file: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const path = this.path(file);
    await assertSafeAbsoluteDirectory(this.root);
    let parent = this.root;
    const parts = relative(this.root, dirname(path)).split(sep).filter(Boolean);
    for (const part of parts) {
      parent = resolve(parent, part);
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe artifact directory");
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Expected bounded regular artifact");
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) throw new Error("Artifact grew beyond size limit");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async json<T>(file: string): Promise<T> {
    return JSON.parse((await this.bytes(file)).toString("utf8")) as T;
  }
  async optional<T>(file: string): Promise<T | null> {
    try {
      return await this.json<T>(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async exists(file: string): Promise<boolean> {
    try {
      await this.bytes(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async pointer(file: string): Promise<ArtifactReference> {
    const p = await this.json<{ schema: string; artifact: ArtifactReference }>(file);
    if (p.schema !== "basalt-evals/artifact-pointer" || Object.keys(p).length !== 2)
      throw new Error("Invalid artifact pointer");
    assertArtifactReference(p.artifact);
    return p.artifact;
  }
  async directory(file: string): Promise<string> {
    const target = this.path(file);
    await assertSafeAbsoluteDirectory(this.root);
    let current = this.root;
    for (const part of relative(this.root, target).split(sep)) {
      current = resolve(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
        const parent = await open(dirname(current), "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe artifact directory");
    }
    return target;
  }
  async write(file: string, bytes: string | Uint8Array): Promise<void> {
    const parent = dirname(this.path(file));
    if (parent === this.root) await assertSafeAbsoluteDirectory(parent);
    else await this.directory(parent);
    await publishImmutable(this.path(file), bytes);
  }
  async writeJson(file: string, value: unknown): Promise<void> {
    await this.write(file, `${stableJson(value)}\n`);
  }
  /** Publish immutable JSON; an identical existing value is an idempotent retry, anything else fails. */
  async writeJsonOnce(file: string, value: unknown): Promise<void> {
    try {
      await this.writeJson(file, value);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        hashJson(await this.json(file)) !== hashJson(value)
      )
        throw error;
    }
  }
}
