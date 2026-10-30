import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

/** Run `launch preview` with flags and return the error text of the CLI. */
async function preview(directory: string, intent: unknown, flags: string[]): Promise<string> {
  const file = resolve(directory, `${flags.join("_") || "none"}.json`);
  await writeFile(file, JSON.stringify(intent));
  try {
    await promisify(execFile)(
      process.execPath,
      [resolve("dist/packages/cli/src/index.js"), "launch", "preview", file, ...flags],
      { cwd: directory },
    );
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr);
  }
}

test("The judge flags change only the judge settings of an evaluation or a regression.", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "basalt-cli-flags-"));
  try {
    const evaluation = { kind: "evaluation", selection: { sources: [] } };
    const [tooMany, reference, repeated] = await Promise.all([
      preview(directory, evaluation, ["--judge-samples", "6"]),
      preview(directory, { kind: "reference", selection: {} }, ["--per-criterion"]),
      preview(directory, evaluation, ["--per-criterion", "--per-criterion"]),
    ]);
    assert.match(tooMany, /Judge samples must be between 1 and 5/);
    assert.match(reference, /apply only to an evaluation or a regression launch intent/);
    assert.match(repeated, /The command or its arguments are not correct/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
