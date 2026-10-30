import assert from "node:assert/strict";
import test from "node:test";
import { toolDefinitions } from "../packages/agent-runtime/src/tools.js";
import { atifTrajectory, ATIF_SCHEMA_VERSION } from "../packages/reporting/src/atif.js";
import { plannedBuild } from "./build-history-fixture.js";
import { testHarness } from "./builder-fixture.js";

// The fields of the Pydantic models of Harbor (src/harbor/models/trajectories), ATIF-v1.7.
// Each model forbids other fields.
const fields = {
  trajectory: [
    "schema_version",
    "session_id",
    "trajectory_id",
    "agent",
    "steps",
    "notes",
    "final_metrics",
    "continued_trajectory_ref",
    "extra",
    "subagent_trajectories",
  ],
  agent: ["name", "version", "model_name", "tool_definitions", "extra"],
  step: [
    "step_id",
    "timestamp",
    "source",
    "model_name",
    "reasoning_effort",
    "message",
    "reasoning_content",
    "tool_calls",
    "observation",
    "metrics",
    "is_copied_context",
    "llm_call_count",
    "extra",
  ],
  toolCall: ["tool_call_id", "function_name", "arguments", "extra"],
  observation: ["results"],
  result: ["source_call_id", "content", "subagent_trajectory_ref", "extra"],
  metrics: [
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "cost_usd",
    "prompt_token_ids",
    "completion_token_ids",
    "logprobs",
    "extra",
  ],
  finalMetrics: [
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_cached_tokens",
    "total_cost_usd",
    "total_steps",
    "extra",
  ],
};
const declared = (value: object, allowed: string[], label: string) => {
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${label}.${key}`);
  for (const [key, item] of Object.entries(value))
    assert.notEqual(item, null, `${label}.${key} is absent, not null`);
};
const options = { agentVersion: "commit", tools: toolDefinitions(testHarness()) };

test("every trajectory has exactly ATIF-v1.7", async () => {
  const { history } = await plannedBuild();
  const trajectory = JSON.parse(JSON.stringify(atifTrajectory(history, options)));
  assert.equal(ATIF_SCHEMA_VERSION, "ATIF-v1.7");
  assert.equal(trajectory.schema_version, "ATIF-v1.7");
  assert.equal(typeof trajectory.agent.name, "string");
  assert.equal(typeof trajectory.agent.version, "string");
  assert.ok(trajectory.steps.length >= 1);
});

test("steps start at 1 and are sequential", async () => {
  const { history } = await plannedBuild();
  const trajectory = atifTrajectory(history, options);
  assert.deepEqual(
    trajectory.steps.map((step) => step.step_id),
    trajectory.steps.map((_, index) => index + 1),
  );
  assert.deepEqual(
    trajectory.steps.map((step) => step.source),
    ["system", "user", "agent", "agent", "agent"],
  );
  for (const step of trajectory.steps) {
    if (step.source !== "agent")
      for (const field of [
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "metrics",
      ])
        assert.equal(field in step, false, `${field} is only on agent steps`);
    // Each result names a tool call of its own step.
    const calls = new Set(step.tool_calls?.map((call) => call.tool_call_id));
    for (const result of step.observation?.results ?? [])
      assert.ok(result.source_call_id === undefined || calls.has(result.source_call_id));
    if (step.llm_call_count === 0) assert.equal(step.metrics, undefined);
  }
});

test("no undeclared root fields", async () => {
  const { history } = await plannedBuild();
  const trajectory = JSON.parse(JSON.stringify(atifTrajectory(history, options)));
  declared(trajectory, fields.trajectory, "trajectory");
  declared(trajectory.agent, fields.agent, "agent");
  declared(trajectory.final_metrics, fields.finalMetrics, "final_metrics");
  assert.equal(trajectory.final_metrics.total_steps, trajectory.steps.length);
  assert.equal(trajectory.final_metrics.total_prompt_tokens, 600);
  for (const step of trajectory.steps) {
    declared(step, fields.step, `step ${step.step_id}`);
    for (const call of step.tool_calls ?? []) declared(call, fields.toolCall, "tool_call");
    if (step.observation) {
      declared(step.observation, fields.observation, "observation");
      for (const result of step.observation.results) declared(result, fields.result, "result");
    }
    if (step.metrics) declared(step.metrics, fields.metrics, "metrics");
  }
  // One unknown counter leaves the final metrics out.
  const unknown = atifTrajectory(
    {
      ...history,
      turns: history.turns.map((turn, index) =>
        index === 1 ? { ...turn, chargeUsd: null } : turn,
      ),
    },
    options,
  );
  assert.equal("final_metrics" in unknown, false);
});
