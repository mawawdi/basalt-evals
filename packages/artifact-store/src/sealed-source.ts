import { inventoryTree } from "./inventory.js";
import { lstat, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { hashJson, stableJson, type CandidateManifest } from "../../contracts/src/index.js";

import { RepositoryFiles } from "./repository.js";

/** Copy only the exact source recorded by the builder; final evaluation uses this copy. */
export async function publishSealedSource(
  workspace: string,
  sealedSource: string,
  candidate: CandidateManifest,
): Promise<void> {
  const inventory = await inventoryTree(workspace);
  if (
    stableJson(inventory) !== stableJson(candidate.files) ||
    hashJson(inventory) !== candidate.rootHash
  )
    throw new Error("Builder workspace changed after the candidate was recorded");
  const existing = await lstat(sealedSource).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    const prior = await inventoryTree(sealedSource);
    if (hashJson(prior) !== candidate.rootHash)
      throw new Error("Existing sealed candidate differs from the completed builder");
    return;
  }
  const parent = dirname(sealedSource);
  const stagingName = `.sealing-${randomUUID()}`;
  const files = new RepositoryFiles(parent);
  const source = new RepositoryFiles(workspace);
  await files.directory(stagingName);
  for (const file of inventory)
    await files.write(`${stagingName}/${file.path}`, await source.bytes(file.path));
  if (hashJson(await inventoryTree(resolve(parent, stagingName))) !== candidate.rootHash)
    throw new Error("Candidate changed during atomic sealing");
  await rename(resolve(parent, stagingName), files.path(basename(sealedSource)));
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const sealedInventory = await inventoryTree(sealedSource);
  if (stableJson(sealedInventory) !== stableJson(inventory))
    throw new Error("Sealed candidate differs from the completed builder workspace");
}
