import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AGENT_RUN_SCHEMA, hashJson, type AgentRun } from "../packages/contracts/src/index.js";
import type { RunOperationEvent } from "../packages/contracts/src/execution.js";
import { buildStopText, savedBuildStop } from "../packages/operator/src/build-stop.js";

function run(input: Partial<AgentRun>): AgentRun {
  return {
    schema: AGENT_RUN_SCHEMA,
    id: "run",
    treatmentId: "treatment",
    startedAt: "2026-10-04T07:00:00.000Z",
    endedAt: "2026-10-04T07:10:00.000Z",
    status: "incomplete",
    stopReason: "finished",
    candidate: { rootHash: "0".repeat(64), projectFile: "default.project.json", files: [] },
    usage: {
      calls: 1,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimatedCostUsd: null,
      providerReportedCostUsd: null,
    },
    trace: [],
    ...input,
  };
}
const trace = (
  kind: AgentRun["trace"][number]["kind"],
  data: AgentRun["trace"][number]["data"],
) => ({
  sequence: 0,
  at: "2026-10-04T07:05:00.000Z",
  kind,
  data,
});

test("a build that stopped says why in plain words, from its saved run", () => {
  // The October 4 arena build: three refused tool calls, then a stop.
  const refused = run({
    stopReason: "invalid_tool_call",
    failure: {
      classification: "model_tool_use_failure",
      detail: "workspace.patch requires path, current SHA-256, before and after text",
    },
    trace: [1, 2, 3].map(() =>
      trace("tool_rejection", { proposed: 1, reason: "invalid_tool_batch", responseHash: "x" }),
    ),
  });
  assert.equal(
    buildStopText(refused),
    "The model sent 3 tool calls that Basalt refused, so the build stopped. Last refusal: workspace.patch requires path, current SHA-256, before and after text",
  );
  assert.equal(
    buildStopText(
      run({
        stopReason: "output_limit",
        failure: { classification: "budget_or_stop_failure", detail: "limit" },
        trace: [trace("model_response", { toolCalls: 0, stopReason: "max_tokens" })],
      }),
    ),
    "The model used its full output limit and called no tool, so the build stopped.",
  );
  assert.equal(
    buildStopText(
      run({
        status: "rejected",
        trace: [
          trace("gate", {
            checks: [
              { name: "project_json", outcome: "pass" },
              { name: "luau_parse", outcome: "fail" },
            ],
            gate: "rejected",
            reasons: [],
          }),
        ],
      }),
    ),
    "The build didn’t pass the local checks: Luau syntax.",
  );
  assert.equal(buildStopText(run({ status: "locally_eligible" })), null, "a passed build");
  const long = buildStopText(
    run({
      stopReason: "provider_error",
      failure: {
        classification: "provider_or_transport_failure",
        detail: `HTTP 500:\n${"x".repeat(400)}`,
      },
    }),
  )!;
  assert.match(
    long,
    /^The model provider returned an error, so the build stopped\. Recorded error: HTTP 500: x+…$/u,
  );
  assert.equal(long.split("Recorded error: ")[1]!.length, 200, "a quoted reason is bounded");
});

test("a saved build gives its reason only for the event that recorded it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-build-stop-"));
  try {
    const saved = run({ stopReason: "turn_limit" });
    const directory = resolve(root, ".basalt-evals/eval-operations/op/builder/unit");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "agent-run.json"), JSON.stringify(saved));
    const event = (id: string, kind: RunOperationEvent["kind"], hashes: string[]) =>
      ({
        id,
        kind,
        stage: "builder",
        unitId: "unit",
        artifactHashes: hashes,
        reason: "budget_or_stop_failure",
        at: "2026-10-04T07:10:00.000Z",
      }) as RunOperationEvent;
    assert.equal(
      await savedBuildStop(root, "op", event("recorded", "incomplete", [hashJson(saved)])),
      "The model used all of its turns before it finished the build.",
    );
    assert.equal(
      await savedBuildStop(root, "op", event("other", "incomplete", ["0".repeat(64)])),
      null,
      "a saved run that the event did not record",
    );
    assert.equal(
      await savedBuildStop(root, "op", event("done", "completed", [hashJson(saved)])),
      null,
      "a build that finished",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
