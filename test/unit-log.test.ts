import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { MAX_FAILURE_STACK_BYTES } from "../packages/artifact-store/src/failures.js";
import type { FailureRecord } from "../packages/contracts/src/failure.js";
import type { ExecutionAdapters } from "../packages/operator/src/adapters.js";
import { driveOperation } from "../packages/operator/src/driver.js";
import { appendUnitLog, readUnitLog } from "../packages/operator/src/unit-log.js";

test("an unknown driver failure keeps a bounded stack file without the provider key", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-driver-stack-"));
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = key;
  try {
    const operationId = "stack-run";
    const journal = await OperationJournal.open(root);
    try {
      journal.put("drivers", operationId, {
        token: "owner",
        pid: process.pid,
        active: true,
        error: null,
        waiting: null,
      });
    } finally {
      journal.close();
    }
    // The first Studio call fails with a long message that names the key and a header.
    const cause = new Error(`Authorization: Bearer ${key} was refused`);
    const failure = new Error(`Studio identity failed for ${key}. ${"x".repeat(80_000)}`, {
      cause,
    });
    const adapters = {
      studio: {
        identity: async () => {
          throw failure;
        },
      },
    } as unknown as ExecutionAdapters;
    await driveOperation(root, operationId, "owner", adapters);

    const records = await OperationJournal.open(root);
    let heads: Record<string, FailureRecord>;
    try {
      heads = records.read<Record<string, FailureRecord>>("failure_heads", operationId)!;
    } finally {
      records.close();
    }
    const recorded = heads[`driver:${operationId}`]!;
    assert.equal(recorded.category, "recovery");
    assert.equal(recorded.evidenceRefs.length, 1);
    const file = resolve(
      root,
      `.basalt-evals/eval-operations/${operationId}/failures/stacks/${recorded.evidenceRefs[0]}.txt`,
    );
    const text = await readFile(file, "utf8");
    assert.ok((await stat(file)).size <= MAX_FAILURE_STACK_BYTES);
    assert.equal(text.includes(key), false, "the stack never keeps the provider key");
    assert.equal(text.includes("sk-or-"), false);
    assert.match(text, /Studio identity failed for \[redacted\]/u);
    assert.match(text, /\[The stack is longer than 64 KiB\. Basalt kept its start\.\]/u);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("each unit log stops at its byte limit with a notice", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-unit-log-"));
  try {
    const unit = { stage: "builder" as const, unitId: "tr-1" };
    const limit = 2_048;
    for (let ordinal = 1; ordinal <= 100; ordinal += 1)
      await appendUnitLog(root, "log-run", unit, { event: "model_response", ordinal }, limit);
    const text = await readUnitLog(root, "log-run", "builder-tr-1");
    assert.ok(Buffer.byteLength(text) <= limit);
    const lines = text.trim().split("\n");
    assert.equal(
      lines.filter((line) => line.includes('"event":"log_limit"')).length,
      1,
      "the log keeps one limit notice",
    );
    assert.match(lines.at(-1)!, /"event":"log_limit"/u);
    assert.match(lines[0]!, /"event":"model_response"/u);
    assert.match(lines[0]!, /"ordinal":1/u);
    await assert.rejects(readUnitLog(root, "log-run", "builder-tr-2"), /no log yet/u);
    await assert.rejects(readUnitLog(root, "log-run", "../escape"), /Invalid unit log identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
