import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CONSOLE_PORT,
  consoleHintUrl,
  outputWithHint,
  type ConsoleHintTarget,
} from "../packages/cli/src/console-hint.js";

function terminal(isTTY: boolean) {
  const lines: string[] = [];
  return { lines, stream: { isTTY, write: (text: string) => lines.push(text) } };
}

test("each result links to its console page, and an export links to its report file", () => {
  const origin = `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}`;
  assert.equal(consoleHintUrl({ kind: "run", id: "flow-1" }), `${origin}/runs/flow-1`);
  assert.equal(consoleHintUrl({ kind: "comparison", id: "abc" }), `${origin}/comparisons/abc`);
  assert.equal(consoleHintUrl({ kind: "review", id: "batch 1" }), `${origin}/reviews/batch%201`);
  const folder = resolve("exports", "run one");
  assert.equal(
    consoleHintUrl({ kind: "export", folder }),
    pathToFileURL(resolve(folder, "index.html")).href,
  );
});

test("a terminal gets one line after the JSON output", async () => {
  const order: string[] = [];
  await outputWithHint(
    Promise.resolve({ operationId: "flow-1" }),
    (value) => order.push(`output:${value.operationId}`),
    (value): ConsoleHintTarget => ({ kind: "run", id: value.operationId }),
    { isTTY: true, write: (text: string) => order.push(`hint:${text}`) },
  );
  assert.deepEqual(order, [
    "output:flow-1",
    `hint:Open the run in the console: http://127.0.0.1:${DEFAULT_CONSOLE_PORT}/runs/flow-1\n`,
  ]);
});

test("a stream that is not a terminal gets no line", async () => {
  const { lines, stream } = terminal(false);
  const outputs: unknown[] = [];
  await outputWithHint(
    Promise.resolve({ id: "abc" }),
    (value) => outputs.push(value),
    (value): ConsoleHintTarget => ({ kind: "comparison", id: value.id }),
    stream,
  );
  assert.deepEqual(outputs, [{ id: "abc" }]);
  assert.deepEqual(lines, []);
});

test("a failed command writes no output and no line", async () => {
  const { lines, stream } = terminal(true);
  const outputs: unknown[] = [];
  await assert.rejects(
    outputWithHint(
      Promise.reject(new Error("Comparison preview changed")),
      (value) => outputs.push(value),
      (): ConsoleHintTarget => ({ kind: "comparison", id: "abc" }),
      stream,
    ),
    /Comparison preview changed/u,
  );
  assert.deepEqual(outputs, []);
  assert.deepEqual(lines, []);
});

test("the CLI links to the port where the console starts", async () => {
  const launcher = (await import(
    pathToFileURL(resolve(import.meta.dirname, "../../scripts/console.mjs")).href
  )) as { DEFAULT_CONSOLE_PORT: unknown };
  assert.equal(launcher.DEFAULT_CONSOLE_PORT, DEFAULT_CONSOLE_PORT);
  const workspace = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../apps/console/package.json"), "utf8"),
  ) as { scripts: { dev: string } };
  assert.match(workspace.scripts.dev, new RegExp(`--port ${DEFAULT_CONSOLE_PORT}(?:\\s|$)`, "u"));
});
