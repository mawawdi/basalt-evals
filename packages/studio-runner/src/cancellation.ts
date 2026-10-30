import { resolve } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const NATIVE_CANCELLATION_FILE = "cancel.json";

async function identity(directory: string) {
  await assertSafeAbsoluteDirectory(directory);
  const bytes = await readBoundedRegularFile(
    resolve(directory, "session.json"),
    2 * 1024 * 1024,
    "cancelled session",
  );
  return { schema: "basalt-evals/native-cancellation", sessionHash: contentHash(bytes) };
}

/** One immutable request for one exact prepared session; this never starts a trial. */
export async function requestNativeCancellation(directory: string): Promise<void> {
  const expected = stableJson(await identity(directory));
  const file = resolve(directory, NATIVE_CANCELLATION_FILE);
  try {
    await publishImmutable(file, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readBoundedRegularFile(file, 4096, "native cancellation");
    if (existing.toString("utf8") !== expected)
      throw new Error("Native cancellation belongs to a different prepared session");
  }
}

/** Watch only this owned session. Lost SSH is not itself authority to kill or replay work. */
export async function watchNativeCancellation(directory: string) {
  const expected = stableJson(await identity(directory));
  const controller = new AbortController();
  let closed = false,
    checking = false;
  async function check() {
    if (closed || checking || controller.signal.aborted) return;
    checking = true;
    try {
      const bytes = await readBoundedRegularFile(
        resolve(directory, NATIVE_CANCELLATION_FILE),
        4096,
        "native cancellation",
      );
      if (bytes.toString("utf8") !== expected)
        throw new Error("Native cancellation belongs to a different prepared session");
      controller.abort(new Error("Cancellation requested for this prepared session"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") controller.abort(error);
    } finally {
      checking = false;
    }
  }
  await check();
  const timer = setInterval(() => {
    void check();
  }, 100);
  timer.unref();
  return {
    signal: controller.signal,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
