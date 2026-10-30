import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function measuredTree(directory) {
  let files = 0;
  let bytes = 0;
  let signedReceipts = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact tree contains a symlink: ${path}`);
    if (entry.isDirectory()) {
      const child = await measuredTree(path);
      files += child.files;
      bytes += child.bytes;
      signedReceipts += child.signedReceipts;
    } else if (entry.isFile()) {
      const info = await lstat(path);
      files += 1;
      bytes += info.size;
      if (entry.name === "manifest.json" && directory.endsWith("/native")) signedReceipts += 1;
    }
  }
  return { files, bytes, signedReceipts };
}

/** Inventory only. A missing documentation reference never authorizes deletion. */
export async function inventoryLocalArtifacts(root) {
  const directory = resolve(root, ".basalt-evals");
  let entries;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe artifact root");
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const docs = resolve(root, "docs");
  const documents = [];
  try {
    for (const entry of await readdir(docs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md"))
        documents.push({
          name: entry.name,
          body: await readFile(resolve(docs, entry.name), "utf8"),
        });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Artifact root contains a symlink: ${entry.name}`);
    const path = resolve(directory, entry.name);
    const size = entry.isDirectory()
      ? await measuredTree(path)
      : { files: 1, bytes: (await lstat(path)).size, signedReceipts: 0 };
    result.push({
      path: `.basalt-evals/${entry.name}`,
      ...size,
      mentionedIn: documents
        .filter(({ body }) => body.includes(entry.name))
        .map(({ name }) => `docs/${name}`)
        .sort(),
    });
  }
  return result.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
  const items = await inventoryLocalArtifacts(root);
  process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
}
