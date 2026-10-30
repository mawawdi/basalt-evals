import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { BoundedAgentCheckpoint } from "../packages/agent-runtime/src/checkpoint.js";
import {
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_TOOL,
} from "../packages/agent-runtime/src/compaction.js";
import { AgentInterrupted, runAgent } from "../packages/agent-runtime/src/index.js";
import { assertAgentRun, hashJson } from "../packages/contracts/src/index.js";
import { BoundedModelClient } from "../packages/model-client/src/bounded-client.js";
import {
  modelTurnRequestHash,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import {
  assistantAnswer,
  builderDescriptor,
  builderSnapshot,
  builderTask,
  builderTreatment,
  builderWorkspace,
  reidentify,
  testHarness,
} from "./builder-fixture.js";

const eligible = async () => ({ gate: "eligible" as const, reasons: [], checks: [] });
const SUMMARIZE = { kind: "summarize_at" as const, atBytes: 16 * 1024, maxSummaries: 1 };
const list = (id: string) => [{ id, name: "workspace.list", arguments: {} }];
const finish = (id: string) => [
  { id, name: "workspace.finish", arguments: { summary: "Implemented." } },
];

/** A treatment of the fixture task whose harness has the given compaction. */
function treatmentWith(compaction: ReturnType<typeof testHarness>["compaction"]) {
  return reidentify({ ...builderTreatment(), harness: testHarness({ maxTurns: 4, compaction }) });
}

/** A model that answers each request with the next scripted answer. */
function scripted(script: Array<(request: ModelTurnRequest) => ModelTurnResult>) {
  const model = {
    descriptor: builderDescriptor,
    requests: [] as ModelTurnRequest[],
    async complete(request: ModelTurnRequest) {
      model.requests.push(structuredClone(request));
      const next = script[model.requests.length - 1];
      if (!next) throw new Error("The scripted model has no more answers");
      return next(request);
    },
  };
  return model satisfies ModelClient;
}

test("with compaction none the build stops at the context limit", async () => {
  const workspace = await builderWorkspace();
  try {
    // Two large answers make the conversation larger than the fixed 16 MiB limit.
    const large = "x".repeat(9 * 1024 * 1024);
    const model = scripted([
      (request) => assistantAnswer(request, "turn-1", list("list-1"), large),
      (request) => assistantAnswer(request, "turn-2", list("list-2"), large),
    ]);
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: treatmentWith({ kind: "none" }),
      modelClient: model,
      verify: eligible,
    });
    assertAgentRun(run);
    assert.equal(run.stopReason, "context_limit");
    assert.equal(run.failure?.classification, "harness_context_failure");
    assert.equal(model.requests.length, 2, "no summary request is sent");
    assert.ok(!run.trace.some((event) => event.kind === "boundary"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("summarize_at sends one metered summary and records a boundary", async () => {
  const workspace = await builderWorkspace();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-compaction-ledger-"));
  try {
    const ledger = new DurableSpendLedger(root, "compaction", hashJson("context"));
    await ledger.initialize({ quoteHash: hashJson("quote"), ceilingUsd: 1 });
    const model = scripted([
      (request) => assistantAnswer(request, "turn-1", list("list-1"), "y".repeat(20 * 1024)),
      (request) =>
        assistantAnswer(request, "summary", [
          { id: "summary-1", name: "context.summary", arguments: { summary: "Listed the seed." } },
        ]),
      (request) => assistantAnswer(request, "turn-2", finish("finish-2")),
    ]);
    const client = new BoundedModelClient(
      model,
      ledger,
      [builderSnapshot()],
      "builder:compaction",
      false,
    );
    const checkpoints: BoundedAgentCheckpoint[] = [];
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: treatmentWith(SUMMARIZE),
      modelClient: client,
      verify: eligible,
      checkpoint: async (state) => {
        checkpoints.push(structuredClone(state));
      },
    });
    assertAgentRun(run);
    assert.equal(run.status, "locally_eligible");
    assert.equal(run.usage.calls, 3, "the summary is a call without a turn");
    // The summary request has the fixed prompt, the whole conversation and only its answer tool.
    const summary = model.requests[1]!;
    assert.equal(summary.system, COMPACTION_SYSTEM_PROMPT);
    assert.deepEqual(summary.tools, [COMPACTION_TOOL]);
    assert.equal(summary.messages.length, 4);
    // The next turn restarts from the seed prompt and one message with the summary and workspace.
    const next = model.requests[2]!.messages;
    assert.equal(next.length, 2);
    assert.deepEqual(next[0], model.requests[0]!.messages[0]);
    assert.match(next[1]!.content, /Listed the seed\.[\s\S]*Current workspace\.list result: \{/u);
    assert.deepEqual(
      run.trace
        .filter((event) => event.kind !== "tool_call" && event.kind !== "tool_result")
        .map((event) => [event.kind, event.data.kind ?? null]),
      [
        ["model_request", null],
        ["model_response", "assistant"],
        ["model_request", "compaction"],
        ["model_response", "compaction"],
        ["boundary", null],
        ["model_request", null],
        ["model_response", "assistant"],
        ["gate", null],
      ],
    );
    const boundary = run.trace.find((event) => event.kind === "boundary")!;
    assert.equal(boundary.data.compaction, 1);
    assert.ok((boundary.data.afterBytes as number) < (boundary.data.beforeBytes as number));
    assert.equal(checkpoints.at(-1)!.compactions, 1);
    assert.deepEqual(
      (await ledger.read()).entries.map((entry) => entry.status),
      ["billed", "billed", "billed"],
      "each request, the summary too, has its own receipt",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a resume after a compaction rebuilds the same request hashes", async () => {
  const treatment = treatmentWith(SUMMARIZE);
  const answers: Array<(request: ModelTurnRequest) => ModelTurnResult> = [
    (request) => assistantAnswer(request, "turn-1", list("list-1"), "y".repeat(20 * 1024)),
    (request) =>
      assistantAnswer(request, "summary", [
        { id: "summary-1", name: "context.summary", arguments: { summary: "Listed the seed." } },
      ]),
    (request) => assistantAnswer(request, "turn-2", finish("finish-2")),
  ];
  // Interrupt the summary request, then the turn request after the summary.
  for (const interrupted of [1, 2]) {
    const workspace = await builderWorkspace();
    try {
      let saved: BoundedAgentCheckpoint | null = null;
      const first = scripted(
        answers.map((answer, index) =>
          index === interrupted
            ? () => {
                throw new AgentInterrupted();
              }
            : answer,
        ),
      );
      const input = {
        outputTokens: () => 8192,
        workspaceRoot: workspace,
        task: builderTask,
        treatment,
        verify: eligible,
        retainInterruption: true,
        checkpoint: async (state: BoundedAgentCheckpoint) => {
          saved = structuredClone(state);
        },
      };
      await assert.rejects(runAgent({ ...input, modelClient: first }), AgentInterrupted);
      const pending = saved! as BoundedAgentCheckpoint;
      assert.equal(pending.point, "before_model");
      assert.equal(pending.compactions, interrupted === 1 ? 0 : 1);
      const second = scripted(answers.slice(interrupted));
      const run = await runAgent({ ...input, modelClient: second, resume: pending });
      assertAgentRun(run);
      assert.equal(run.status, "locally_eligible");
      assert.equal(
        modelTurnRequestHash({ ...second.requests[0]! }, builderDescriptor),
        pending.pendingAction!.requestHash,
        "the resumed request is the exact interrupted request",
      );
      assert.equal(run.trace.filter((event) => event.kind === "boundary").length, 1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});
