import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { mapInOrder } from "../packages/operator/src/concurrency.js";
import { frozenRunRecords } from "../packages/operator/src/run-records.js";

const turn = () => new Promise((done) => setImmediate(done));

test("mapInOrder keeps the order of the items and limits the calls at the same time", async () => {
  let active = 0;
  let most = 0;
  const answers = new Map<number, () => void>();
  const result = mapInOrder([1, 2, 3, 4, 5], 2, (item) => {
    active++;
    most = Math.max(most, active);
    return new Promise<number>((done) =>
      answers.set(item, () => {
        active--;
        done(item * 10);
      }),
    );
  });
  // The later call of each pair answers first.
  for (const item of [2, 1, 4, 3, 5]) {
    while (!answers.has(item)) await turn();
    answers.get(item)!();
  }
  assert.deepEqual(await result, [10, 20, 30, 40, 50]);
  assert.equal(most, 2);
});

test("mapInOrder rejects with the failure of the first failed item after all calls finish", async () => {
  const finished: number[] = [];
  await assert.rejects(
    mapInOrder([1, 2, 3], 3, async (item) => {
      // The third item fails first in time.
      if (item === 3) throw new Error("third");
      await turn();
      finished.push(item);
      if (item === 2) throw new Error("second");
      return item;
    }),
    /second/,
  );
  assert.deepEqual(finished, [1, 2]);
});

test("a frozen run reader keeps one read for each run, also a failed read", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-run-status-"));
  try {
    const runRecords = frozenRunRecords(root);
    const missing = runRecords("run-absent");
    const other = runRecords("run-other");
    assert.equal(runRecords("run-absent"), missing);
    assert.notEqual(other, missing);
    await Promise.all([assert.rejects(missing, /ENOENT/), assert.rejects(other, /ENOENT/)]);
    assert.equal(runRecords("run-other"), other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
