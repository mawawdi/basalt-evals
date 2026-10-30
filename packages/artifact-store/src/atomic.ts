import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Publish complete immutable bytes without replacing a prior artifact. */
export async function publishImmutable(file: string, bytes: string | Uint8Array): Promise<void> {
  const parent = dirname(file);
  const temporary = resolve(parent, `.pending-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary);
  }
}
