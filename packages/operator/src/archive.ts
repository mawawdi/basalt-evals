import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { compareCodeUnits, contentHash, hashJson } from "../../contracts/src/index.js";

interface ArchiveIndex {
  id: string;
  source: { kind: "operation"; id: string };
  interpretation: "uninterpreted_archive";
  files: Array<{ id: string; path: string; hash: string; bytes: number }>;
}

/** Seal byte identities for inspection; never translate or execute historical schemas. */
export async function sealArchive(root: string, operationId: string): Promise<ArchiveIndex> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId))
    throw new Error("Invalid archive source identity");
  const source: ArchiveIndex["source"] = { kind: "operation", id: operationId };
  const journal = await OperationJournal.open(root);
  try {
    if (journal.read("operations", source.id) || journal.read("authoring_progress", source.id))
      throw new Error("Current operations use the active evidence reader");
  } finally {
    journal.close();
  }
  const files = new RepositoryFiles(root);
  const base = `.basalt-evals/eval-operations/${source.id}`;
  const directory = await lstat(resolve(root, base));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Unsafe archived operation directory");
  const entries: ArchiveIndex["files"] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Archive contains a symbolic link");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        if (entries.length >= 20_000) throw new Error("Archive exceeds the bounded file count");
        const bytes = await files.bytes(child);
        const item = { path: child, hash: contentHash(bytes), bytes: bytes.length };
        entries.push({ ...item, id: hashJson(item) });
      } else throw new Error("Archive contains a non-regular file");
    }
  }
  await visit(base);
  if (!entries.length) throw new Error("Operation has no historical bytes to archive");
  entries.sort((a, b) => compareCodeUnits(a.path, b.path));
  const body = { source, interpretation: "uninterpreted_archive" as const, files: entries };
  const index = { ...body, id: hashJson(body) };
  const target = `.basalt-evals/archives/${index.id}.json`;
  try {
    await files.writeJson(target, index);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(target)) !== hashJson(index))
      throw new Error("Archive index changed");
  }
  const catalog = await OperationJournal.open(root);
  try {
    catalog.project("archives", index.id, {
      search: `run ${index.source.id}`,
      status: "historical",
      sort: `${index.source.kind} ${index.source.id}`,
      body: { id: index.id, source: index.source, files: index.files.length },
    });
  } finally {
    catalog.close();
  }
  return index;
}

export async function listArchives(root: string, query = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.page<{ id: string; source: ArchiveIndex["source"]; files: number }>("archives", {
      q: query.get("q") ?? "",
      page: Number(query.get("page") ?? 1),
      limit: Number(query.get("limit") ?? 20),
    });
  } finally {
    journal.close();
  }
}

export async function readArchive(root: string, archiveId: string): Promise<ArchiveIndex> {
  if (!/^[a-f0-9]{64}$/u.test(archiveId)) throw new Error("Invalid archive identity");
  const index = await new RepositoryFiles(root).json<ArchiveIndex>(
    `.basalt-evals/archives/${archiveId}.json`,
  );
  const { id, ...body } = index;
  if (id !== archiveId || hashJson(body) !== id) throw new Error("Archive index bytes changed");
  if (
    !index.source ||
    index.source.kind !== "operation" ||
    !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(index.source.id) ||
    index.interpretation !== "uninterpreted_archive"
  )
    throw new Error("Archive source identity is invalid");
  const prefix = `.basalt-evals/eval-operations/${index.source.id}/`;
  if (
    !index.files.every(
      (file) =>
        file.path.startsWith(prefix) &&
        hashJson({ path: file.path, hash: file.hash, bytes: file.bytes }) === file.id,
    )
  )
    throw new Error("Archived file is outside its bound source");
  return index;
}

export async function readArchivedFile(
  root: string,
  archiveId: string,
  fileId: string,
): Promise<Buffer> {
  const index = await readArchive(root, archiveId);
  const file = index.files.find((item) => item.id === fileId);
  if (!file) throw new Error("Unknown archived file identity");
  const bytes = await new RepositoryFiles(root).bytes(file.path);
  if (bytes.length !== file.bytes || contentHash(bytes) !== file.hash)
    throw new Error("Archived artifact bytes changed");
  return bytes;
}
