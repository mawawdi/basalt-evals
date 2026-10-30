import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertSafeAbsoluteDirectory } from "./index.js";

// Content checks that passed in this process, by path, hash and size. Each value is the
// file identity before and after its check. Evidence reads verify the same signed
// captures many times. Without this record, each verification reads all files again.
const confirmedContents = new Map<string, string>();
const confirmedContentLimit = 65_536;

async function regularFileIdentity(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true });
    return info.isFile()
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      : null;
  } catch {
    return null;
  }
}

/**
 * Run each content check that did not pass for the current file identity. A file that
 * keeps its device, inode, size, modification time and change time is not read again.
 * Checks run in sequence. A failed check is not recorded.
 */
export async function confirmFileContents(
  entries: Array<{ file: string; hash: string; bytes: number; check: () => Promise<void> }>,
): Promise<void> {
  const paths = entries.map((entry) => resolve(entry.file));
  const before = await Promise.all(paths.map(regularFileIdentity));
  for (const [index, entry] of entries.entries()) {
    const key = `${paths[index]}\0${entry.hash}\0${entry.bytes}`,
      identity = before[index]!;
    if (identity === null || confirmedContents.get(key) !== identity) {
      await entry.check();
      if (identity === null || (await regularFileIdentity(paths[index]!)) !== identity) continue;
    }
    confirmedContents.delete(key);
    confirmedContents.set(key, identity);
    if (confirmedContents.size > confirmedContentLimit)
      confirmedContents.delete(confirmedContents.keys().next().value!);
  }
}

/** Read one bounded regular file without following a symlink at any path component. */
export async function readBoundedRegularFile(
  file: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error("Invalid regular-file byte limit");
  const path = resolve(file);
  await assertSafeAbsoluteDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes)
      throw new Error(`Unsafe or oversized ${label}: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes)
      throw new Error(`${label} grew beyond its byte limit: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}
