import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, stat } from "node:fs/promises";
import { publishImmutable } from "./atomic.js";
import { dirname, isAbsolute, normalize, parse, relative, resolve, sep, win32 } from "node:path";
import { stableJson } from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";

/**
 * A content-addressed reference to an immutable JSON artifact.
 *
 * `locator` is always relative to the store root. `artifactHash` hashes the
 * exact persisted UTF-8 bytes, including the trailing newline.
 */
export interface ArtifactReference {
  locator: string;
  artifactHash: string;
  bytes: number;
}

interface BinaryArtifactReference {
  locator: string;
  artifactHash: string;
  bytes: number;
  mediaType: "image/png" | "image/jpeg";
}

interface ImmutableJsonArtifactStoreOptions {
  /** Maximum serialized artifact size accepted by this store. */
  maxBytes?: number;
}

type JsonArtifactAssertion<T> = (value: unknown) => asserts value is T;

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ARTIFACT_DIRECTORY = "artifacts";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A local, immutable JSON evidence store. It has no process-working-directory
 * behaviour: every locator is resolved only from the root passed at creation.
 */
export class ImmutableJsonArtifactStore {
  public readonly root: string;
  public readonly maxBytes: number;

  constructor(root: string, options: ImmutableJsonArtifactStoreOptions = {}) {
    if (typeof root !== "string" || root.trim().length === 0)
      throw new Error("Artifact store root must be a non-empty path");
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Artifact store maxBytes must be a positive safe integer");
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  /** Canonically serialize and atomically persist a JSON value. */
  async write(value: unknown): Promise<ArtifactReference> {
    const serialized = serializeCanonicalJson(value);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.maxBytes)
      throw new Error(`Artifact exceeds byte limit (${bytes} > ${this.maxBytes})`);
    const artifactHash = hashBytes(serialized);
    const locator = `${ARTIFACT_DIRECTORY}/${artifactHash}.json`;
    const reference: ArtifactReference = { locator, artifactHash, bytes };

    await this.ensureRoot();
    const destination = await this.resolveForWrite(locator);
    try {
      await this.createNewArtifact(destination, serialized);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      // A competing/previous writer is valid only when its immutable bytes
      // exactly match this content address. Never overwrite a conflict.
      await this.read(reference);
    }
    return reference;
  }

  /** Persist bounded binary evidence by content hash without overwriting collisions. */
  async writeBlob(
    value: Uint8Array,
    mediaType: BinaryArtifactReference["mediaType"],
  ): Promise<BinaryArtifactReference> {
    if (!(value instanceof Uint8Array)) throw new Error("Blob must be a Uint8Array");
    if (mediaType !== "image/png" && mediaType !== "image/jpeg")
      throw new Error("Blob media type must be image/png or image/jpeg");
    const bytes = value.byteLength;
    if (bytes <= 0 || bytes > this.maxBytes)
      throw new Error(`Blob size is outside the store limit (${bytes})`);
    // Own the bytes across filesystem awaits, including when value is a Buffer view.
    const snapshot = Uint8Array.from(value);
    const artifactHash = hashBytes(snapshot);
    const extension = mediaType === "image/png" ? "png" : "jpg";
    const locator = `blobs/${artifactHash}.${extension}`;
    const reference: BinaryArtifactReference = { locator, artifactHash, bytes, mediaType };
    await this.ensureRoot();
    const destination = await this.resolveForWrite(locator);
    try {
      await this.createNewArtifact(destination, snapshot);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      await this.readBlob(reference);
    }
    return reference;
  }

  /** Read, integrity-check, parse, and optionally assert an artifact. */
  async read<T = unknown>(
    reference: ArtifactReference,
    assertion?: JsonArtifactAssertion<T>,
  ): Promise<T> {
    assertArtifactReference(reference);
    if (reference.bytes > this.maxBytes)
      throw new Error(
        `Artifact reference exceeds byte limit (${reference.bytes} > ${this.maxBytes})`,
      );
    const destination = await this.resolveForRead(reference.locator);
    const serialized = await readRegularFileWithoutFollowingTarget(
      destination,
      reference.bytes,
      this.maxBytes,
    );
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes !== reference.bytes) throw new Error("Artifact byte count mismatch");
    if (hashBytes(serialized) !== reference.artifactHash)
      throw new Error("Artifact SHA-256 mismatch");

    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("Artifact is not valid JSON");
    }
    if (serializeCanonicalJson(value) !== serialized)
      throw new Error("Artifact JSON is not canonical");
    if (assertion !== undefined) {
      const assertionCallback: JsonArtifactAssertion<T> = assertion;
      assertionCallback(value);
    }
    return value as T;
  }

  /** Validate a reference and all of its persisted integrity properties. */
  async verify(reference: ArtifactReference): Promise<void> {
    await this.read(reference);
  }

  async readBlob(reference: BinaryArtifactReference): Promise<Uint8Array> {
    assertBinaryArtifactReference(reference);
    if (reference.bytes > this.maxBytes)
      throw new Error(`Blob reference exceeds byte limit (${reference.bytes} > ${this.maxBytes})`);
    const destination = await this.resolveForRead(reference.locator);
    const value = await readRegularBytesWithoutFollowingTarget(
      destination,
      reference.bytes,
      this.maxBytes,
    );
    if (hashBytes(value) !== reference.artifactHash) throw new Error("Blob SHA-256 mismatch");
    return value;
  }

  private async ensureRoot(): Promise<void> {
    await ensureSafeAbsoluteDirectory(this.root);
  }

  private async resolveForWrite(locator: string): Promise<string> {
    const destination = resolveLocator(this.root, locator);
    const artifactDirectory = dirname(destination);
    await ensureSafeDirectoryWithinRoot(this.root, artifactDirectory);
    return destination;
  }

  private async resolveForRead(locator: string): Promise<string> {
    // Reads must validate the same absolute root chain as writes. Otherwise a
    // store constructed before an ancestor is replaced with a symlink could
    // read evidence outside of its declared root.
    await assertSafeAbsoluteDirectory(this.root);
    const destination = resolveLocator(this.root, locator);
    await assertSafeExistingPathWithinRoot(this.root, destination, true);
    return destination;
  }

  private async createNewArtifact(
    destination: string,
    serialized: string | Uint8Array,
  ): Promise<void> {
    await publishImmutable(destination, serialized);
  }
}

function assertBinaryArtifactReference(value: unknown): asserts value is BinaryArtifactReference {
  if (!isRecord(value)) throw new Error("Invalid BinaryArtifactReference");
  assertExactKeys(value, ["locator", "artifactHash", "bytes", "mediaType"]);
  const { locator, artifactHash, bytes, mediaType } = value;
  const extension = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : null;
  if (
    extension === null ||
    typeof artifactHash !== "string" ||
    !HASH_PATTERN.test(artifactHash) ||
    locator !== `blobs/${artifactHash}.${extension}` ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  )
    throw new Error("Invalid BinaryArtifactReference");
}

export function assertArtifactReference(value: unknown): asserts value is ArtifactReference {
  if (!isRecord(value)) throw new Error("Invalid ArtifactReference");
  assertExactKeys(value, ["locator", "artifactHash", "bytes"]);
  const { locator, artifactHash, bytes } = value;
  if (
    typeof locator !== "string" ||
    !isSafeLocator(locator) ||
    typeof artifactHash !== "string" ||
    !HASH_PATTERN.test(artifactHash) ||
    locator !== `${ARTIFACT_DIRECTORY}/${artifactHash}.json` ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw new Error("Invalid ArtifactReference");
  }
}

/** Exact UTF-8 artifact representation, including its terminating newline. */
function serializeCanonicalJson(value: unknown): string {
  const json = stableJson(value);
  if (typeof json !== "string") throw new Error("Artifact must be JSON-serializable");
  return `${json}\n`;
}

function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveLocator(root: string, locator: string): string {
  if (!isSafeLocator(locator))
    throw new Error("Artifact locator must be a safe root-relative path");
  const destination = resolve(root, ...locator.split("/"));
  const fromRoot = relative(root, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact locator escapes store root");
  return destination;
}

function isSafeLocator(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  )
    return false;
  const normalized = normalize(value).replaceAll("\\", "/");
  if (normalized !== value) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Build a missing absolute directory component by component. A creator-owned
 * link is never traversed: it could redirect a root-relative artifact path
 * outside the declared store. The only permitted aliases are OS-owned
 * namespace links (for example macOS's /var -> /private/var), whose parent is
 * neither writable by this process nor group/world writable.
 */
async function ensureSafeAbsoluteDirectory(directory: string): Promise<void> {
  await visitSafeAbsoluteDirectory(directory, true);
}

/** Validate every existing absolute root component before a read. */
export async function assertSafeAbsoluteDirectory(directory: string): Promise<void> {
  await visitSafeAbsoluteDirectory(directory, false);
}

// Store roots are validated once per process. Reads still check every directory
// inside the root and open files without following links; this only avoids walking
// the same ancestors outside the store on every one of thousands of reads.
const validatedDirectories = new Set<string>();

async function visitSafeAbsoluteDirectory(
  directory: string,
  createMissing: boolean,
): Promise<void> {
  const absolute = resolve(directory);
  if (validatedDirectories.has(absolute)) return;
  const parsed = parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = `${current}${current.endsWith(sep) ? "" : sep}${part}`;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        await assertTrustedNamespaceAlias(current);
        continue;
      }
      if (!info.isDirectory()) throw new Error(`Unsafe artifact store directory: ${current}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      if (!createMissing) throw new Error(`Artifact store root does not exist: ${current}`);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact store directory: ${current}`);
    }
  }
  validatedDirectories.add(absolute);
}

/**
 * Follow only a namespace alias that an unprivileged local process cannot
 * replace. This retains support for system aliases such as macOS /var while
 * failing closed for links placed in a project, .basalt, or temporary store
 * directory by the current user.
 */
async function assertTrustedNamespaceAlias(path: string): Promise<void> {
  const parent = dirname(path);
  const parentInfo = await stat(parent);
  const targetInfo = await stat(path);
  if (!parentInfo.isDirectory() || !targetInfo.isDirectory())
    throw new Error(`Unsafe artifact store directory: ${path}`);
  if (typeof process.getuid === "function" && parentInfo.uid === process.getuid())
    throw new Error(`Unsafe artifact store directory: ${path}`);
  if ((parentInfo.mode & 0o022) !== 0) throw new Error(`Unsafe artifact store directory: ${path}`);
  try {
    await access(parent, constants.W_OK);
  } catch {
    return;
  }
  throw new Error(`Unsafe artifact store directory: ${path}`);
}

async function ensureSafeDirectoryWithinRoot(root: string, directory: string): Promise<void> {
  const fromRoot = relative(root, directory);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact directory escapes store root");
  let current = root;
  for (const part of fromRoot.split(sep)) {
    if (!part) continue;
    current = `${current}${sep}${part}`;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact directory: ${current}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact directory: ${current}`);
    }
  }
}

async function assertSafeExistingPathWithinRoot(
  root: string,
  destination: string,
  includeTarget: boolean,
): Promise<void> {
  const fromRoot = relative(root, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact path escapes store root");
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (isMissing(error)) throw new Error("Artifact store root does not exist");
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Unsafe artifact store root");
  const parts = fromRoot.split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error("Invalid artifact path");
    current = `${current}${sep}${part}`;
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) throw new Error("Artifact file is missing");
      throw error;
    });
    if (info.isSymbolicLink()) throw new Error("Artifact path contains a symbolic link");
    const target = index === parts.length - 1;
    if ((!target || !includeTarget) && !info.isDirectory())
      throw new Error("Artifact path component is not a directory");
    if (target && includeTarget && !info.isFile())
      throw new Error("Artifact target is not a regular file");
  }
}

async function readRegularFileWithoutFollowingTarget(
  path: string,
  expectedBytes: number,
  maxBytes: number,
): Promise<string> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("Artifact target is not a regular file");
    if (info.size > maxBytes)
      throw new Error(`Artifact exceeds byte limit (${info.size} > ${maxBytes})`);
    if (info.size !== expectedBytes) throw new Error("Artifact byte count mismatch");
    return await descriptor.readFile({ encoding: "utf8" });
  } finally {
    await descriptor.close();
  }
}

async function readRegularBytesWithoutFollowingTarget(
  path: string,
  expectedBytes: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("Blob target is not a regular file");
    if (info.size > maxBytes)
      throw new Error(`Blob exceeds byte limit (${info.size} > ${maxBytes})`);
    if (info.size !== expectedBytes) throw new Error("Blob byte count mismatch");
    return await descriptor.readFile();
  } finally {
    await descriptor.close();
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error("Invalid artifact reference fields");
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
