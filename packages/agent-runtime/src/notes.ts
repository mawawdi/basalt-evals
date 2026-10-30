import { resolve } from "node:path";
import { walkRegularTree } from "../../artifact-store/src/inventory.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { contentHash, hashJson, isHarnessId } from "../../contracts/src/index.js";
import { assertExactRecordKeys, isRecord } from "../../contracts/src/validation.js";

// An API notes pack is public reference material for builders. A person writes it in
// studies/notes/<id>/. This module reads only that directory and the frozen copy of a pack. It
// reads no task, evaluator, fixture or solution, and a boundary test keeps it that way.

const NOTES_PACK_SCHEMA = "basalt-evals/notes-pack" as const;
/** The largest file of a pack. `notes.read` returns one whole file. */
const MAX_NOTES_FILE_BYTES = 64 * 1024;
const MAX_NOTES_FILES = 32;
const MAX_NOTES_PACK_BYTES = 512 * 1024;
const MAX_NOTES_TITLE_CHARS = 120;
const NOTES_PATH = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.md$/u;

/** A person sets `person_reviewed` after a review. A run refuses a pack that needs review. */
type NotesReview = "needs_person_review" | "person_reviewed";

/** The frozen manifest of a pack. Its hash binds the exact bytes of each file. */
interface NotesPackManifest {
  schema: typeof NOTES_PACK_SCHEMA;
  id: string;
  title: string;
  review: NotesReview;
  files: Array<{ path: string; title: string; bytes: number; hash: string }>;
}

interface LoadedNotesPack {
  manifest: NotesPackManifest;
  hash: string;
  /** The text of each file, in the order of the manifest. */
  files: Array<{ path: string; text: string }>;
}

function notesPackDirectory(id: string): string {
  if (!isHarnessId(id)) throw new Error("Invalid API notes pack ID");
  return `studies/notes/${id}`;
}

export function frozenNotesPackDirectory(hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid API notes pack hash");
  return `.basalt-evals/notes-packs/${hash}`;
}

/**
 * Read the authored pack `studies/notes/<id>/`. The directory holds `pack.json` and only the
 * Markdown files that it lists.
 */
export async function loadNotesPack(root: string, id: string): Promise<LoadedNotesPack> {
  const directory = resolve(root, notesPackDirectory(id));
  const authored = JSON.parse(
    (
      await readBoundedRegularFile(
        resolve(directory, "pack.json"),
        MAX_NOTES_FILE_BYTES,
        "API notes pack",
      )
    ).toString("utf8"),
  ) as unknown;
  if (!isRecord(authored)) throw new Error("Invalid API notes pack");
  assertExactRecordKeys(authored, ["schema", "id", "title", "review", "files"], "API notes pack");
  if (!Array.isArray(authored.files)) throw new Error("Invalid API notes pack files");
  const tree = await walkRegularTree(directory, {
    label: "API notes pack",
    maxFileBytes: MAX_NOTES_FILE_BYTES,
    accept: (path) => path === "pack.json" || path.endsWith(".md"),
  });
  const listed = authored.files.map((file: unknown) => {
    if (!isRecord(file)) throw new Error("Invalid API notes file");
    assertExactRecordKeys(file, ["path", "title"], "API notes file");
    return file;
  });
  const markdown = tree.filter((file) => file.path !== "pack.json");
  if (
    markdown.length !== listed.length ||
    markdown.some((file) => !listed.some((item) => item.path === file.path))
  )
    throw new Error("The API notes pack must list each Markdown file of its directory");
  const files: LoadedNotesPack["files"] = [];
  const manifest = {
    schema: authored.schema,
    id: authored.id,
    title: authored.title,
    review: authored.review,
    files: await Promise.all(
      listed.map(async (item) => {
        const file = markdown.find((entry) => entry.path === item.path)!;
        const bytes = await readBoundedRegularFile(
          resolve(directory, file.path),
          MAX_NOTES_FILE_BYTES,
          `API notes file ${file.path}`,
        );
        if (contentHash(bytes) !== file.hash)
          throw new Error(`API notes file ${file.path} changed while it was read`);
        files.push({ path: file.path, text: bytes.toString("utf8") });
        return { path: file.path, title: item.title, bytes: file.bytes, hash: file.hash };
      }),
    ),
  };
  assertNotesPackManifest(manifest);
  if (manifest.id !== id) throw new Error("The API notes pack ID differs from its directory");
  files.sort(
    (left, right) =>
      manifest.files.findIndex((file) => file.path === left.path) -
      manifest.files.findIndex((file) => file.path === right.path),
  );
  return { manifest, hash: hashJson(manifest), files };
}

/** Copy an authored pack into `.basalt-evals/notes-packs/<hash>/`. A repeated copy is a no-op. */
export async function freezeNotesPack(
  root: string,
  pack: { id: string; hash: string },
): Promise<LoadedNotesPack> {
  const loaded = await loadNotesPack(root, pack.id);
  if (loaded.hash !== pack.hash)
    throw new Error(
      `The API notes pack ${pack.id} changed after the harness was read. Preview the run again.`,
    );
  const files = new RepositoryFiles(root);
  const base = frozenNotesPackDirectory(loaded.hash);
  for (const [path, bytes] of [
    ...loaded.files.map((file) => [file.path, Buffer.from(file.text, "utf8")] as const),
    ["manifest.json", Buffer.from(`${JSON.stringify(loaded.manifest)}\n`, "utf8")] as const,
  ]) {
    try {
      await files.write(`${base}/${path}`, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (contentHash(await files.bytes(`${base}/${path}`)) !== contentHash(bytes))
        throw new Error(`The frozen API notes file ${path} differs from its pack`);
    }
  }
  return loaded;
}

/** Open the frozen copy of a pack and verify each file against the frozen manifest. */
export async function openFrozenNotesPack(
  root: string,
  pack: { id: string; hash: string },
): Promise<NotesPackReader> {
  const directory = resolve(root, frozenNotesPackDirectory(pack.hash));
  const manifest = JSON.parse(
    (
      await readBoundedRegularFile(
        resolve(directory, "manifest.json"),
        MAX_NOTES_FILE_BYTES,
        "frozen API notes manifest",
      )
    ).toString("utf8"),
  ) as unknown;
  assertNotesPackManifest(manifest);
  if (manifest.id !== pack.id || hashJson(manifest) !== pack.hash)
    throw new Error("The frozen API notes pack differs from the frozen harness");
  const reader = new NotesPackReader(manifest, pack.hash, directory);
  for (const file of manifest.files) await reader.read(file.path);
  return reader;
}

/** The two notes tools of one build. They read only the files of the frozen manifest. */
export class NotesPackReader {
  constructor(
    readonly manifest: NotesPackManifest,
    readonly hash: string,
    private readonly directory: string,
  ) {}

  list(): {
    pack: { id: string; title: string };
    files: Array<{ path: string; title: string; bytes: number; hash: string }>;
  } {
    return {
      pack: { id: this.manifest.id, title: this.manifest.title },
      files: structuredClone(this.manifest.files),
    };
  }

  async read(
    path: string,
  ): Promise<{ path: string; title: string; hash: string; content: string }> {
    const file = this.manifest.files.find((item) => item.path === path);
    if (!file || !NOTES_PATH.test(path))
      throw new Error("Unknown API notes path. Call notes.list for the paths of the pack.");
    const bytes = await readBoundedRegularFile(
      resolve(this.directory, file.path),
      MAX_NOTES_FILE_BYTES,
      `API notes file ${file.path}`,
    );
    if (contentHash(bytes) !== file.hash || bytes.byteLength !== file.bytes)
      throw new Error(`The frozen API notes file ${file.path} changed`);
    return { path: file.path, title: file.title, hash: file.hash, content: bytes.toString("utf8") };
  }
}

function assertNotesPackManifest(value: unknown): asserts value is NotesPackManifest {
  if (!isRecord(value)) throw new Error("Invalid API notes manifest");
  assertExactRecordKeys(value, ["schema", "id", "title", "review", "files"], "API notes manifest");
  if (
    value.schema !== NOTES_PACK_SCHEMA ||
    !isHarnessId(value.id) ||
    !isTitle(value.title) ||
    !["needs_person_review", "person_reviewed"].includes(String(value.review)) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_NOTES_FILES
  )
    throw new Error("Invalid API notes manifest");
  const paths = new Set<string>();
  let total = 0;
  for (const file of value.files as unknown[]) {
    if (!isRecord(file)) throw new Error("Invalid API notes file");
    assertExactRecordKeys(file, ["path", "title", "bytes", "hash"], "API notes file");
    if (
      typeof file.path !== "string" ||
      !NOTES_PATH.test(file.path) ||
      file.path.length > 200 ||
      paths.has(file.path) ||
      !isTitle(file.title) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_NOTES_FILE_BYTES ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.hash)
    )
      throw new Error("Invalid API notes file");
    paths.add(file.path);
    total += file.bytes;
  }
  if (total > MAX_NOTES_PACK_BYTES) throw new Error("The API notes pack exceeds 512 KiB");
}

/**
 * True when one text of `left` and one text of `right` share a run of `size` words. A word is a
 * run of letters and digits, compared in lowercase.
 */
export function sharesShingle(
  left: readonly string[],
  right: readonly string[],
  size = 12,
): boolean {
  const shingles = (texts: readonly string[]) => {
    const result = new Set<string>();
    for (const text of texts) {
      const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      for (let index = 0; index + size <= words.length; index += 1)
        result.add(words.slice(index, index + size).join(" "));
    }
    return result;
  };
  const known = shingles(left);
  for (const shingle of shingles(right)) if (known.has(shingle)) return true;
  return false;
}

function isTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_NOTES_TITLE_CHARS
  );
}
