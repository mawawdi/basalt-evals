import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Read the newest trace file of a Studio session. Production reads the trace file of the
 * served session directly, so only tests need this search.
 */
export async function readLatestStudioTrace(
  directory: string,
): Promise<{ file: string; text: string }> {
  const traces = resolve(directory, "traces");
  const files = await Promise.all(
    (await readdir(traces))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({
        name,
        created: (await lstat(resolve(traces, name), { bigint: true })).birthtimeNs,
      })),
  );
  files.sort((a, b) =>
    a.created !== b.created ? (a.created < b.created ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  const file = resolve(traces, files.at(-1)!.name);
  return { file, text: await readFile(file, "utf8") };
}
