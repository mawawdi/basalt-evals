import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { builderRequest, runAgent } from "../packages/agent-runtime/src/index.js";
import { quoteBuilderTurns } from "../packages/agent-runtime/src/workload.js";
import {
  assertHarnessDefinition,
  stableJson,
  type HarnessDefinition,
} from "../packages/contracts/src/index.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import { quoteRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import { readHarnessRegistry } from "../packages/operator/src/config.js";
import {
  assistantAnswer,
  builderDescriptor,
  builderSnapshot,
  builderTask,
  builderTreatment,
  builderWorkspace,
  reidentify,
  studioHarness,
  testHarness,
} from "./builder-fixture.js";
import { fixtureSnapshots } from "./shared-api-fixture.js";
import { readyRunProject } from "./run-fixture.js";

const NOTES_PACK = { id: "notes", hash: "a".repeat(64) };

test("a template needs each required slot exactly once", () => {
  assert.doesNotThrow(() => assertHarnessDefinition(testHarness()));
  assert.doesNotThrow(() => assertHarnessDefinition(studioHarness()));
  for (const [promptTemplate, message] of [
    ["{{task}}\n{{workspace}}", /include \{\{stages\}\} one time/u],
    ["{{stages}}{{task}}", /include \{\{workspace\}\} one time/u],
    ["{{stages}}{{task}}\n{{workspace}}\n{{task}}", /include \{\{task\}\} one time/u],
    ["{{stages}}{{task}}\n{{workspace}}\n{{solution}}", /\{\{solution\}\} is not a slot/u],
    ["{{stages}}{{task}}\n{{workspace}}\n{{development}}", /\{\{development\}\} is not a slot/u],
    ["{{stages}}{{task}}\n{{workspace}}\n{{ task }}", /is not a slot/u],
    ["{{stages}}{{task}}\n{{workspace}} {{", /unmatched braces/u],
  ] as const)
    assert.throws(() => assertHarnessDefinition(testHarness({ promptTemplate })), message);
  // A slot that applies must be present: Studio runs need {{development}}, a pack needs {{notes}}.
  assert.throws(
    () =>
      assertHarnessDefinition(
        studioHarness({ promptTemplate: "{{stages}}{{task}}\n{{workspace}}" }),
      ),
    /include \{\{development\}\} one time/u,
  );
  const notes = testHarness({
    tools: [...testHarness().tools, "notes.list", "notes.read"],
    notesPack: NOTES_PACK,
  });
  assert.throws(() => assertHarnessDefinition(notes), /include \{\{notes\}\} one time/u);
  assert.doesNotThrow(() =>
    assertHarnessDefinition({
      ...notes,
      promptTemplate: "{{stages}}{{notes}}\n{{task}}\n{{workspace}}",
    }),
  );
});

test("any changed harness setting changes the treatment identity", () => {
  const base = reidentify({ ...builderTreatment(), harness: testHarness() });
  const variants: Array<Partial<HarnessDefinition>> = [
    { title: "Other tools" },
    { systemPrompt: "Build the task with care." },
    { promptTemplate: "{{stages}}{{workspace}}\n{{task}}" },
    { tools: testHarness().tools.filter((tool) => tool !== "workspace.search") },
    { maxTurns: 4 },
    { reasoning: { kind: "provider_default" } },
    { reasoning: { kind: "effort", effort: "high" } },
    { compaction: { kind: "summarize_at", atBytes: 65_536, maxSummaries: 2 } },
    { compaction: { kind: "summarize_at", atBytes: 65_536, maxSummaries: 3 } },
    {
      tools: [...testHarness().tools, "notes.list", "notes.read"],
      promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{notes}}",
      notesPack: NOTES_PACK,
    },
    {
      tools: [...testHarness().tools, "notes.list", "notes.read"],
      promptTemplate: "{{stages}}{{task}}\n{{workspace}}\n{{notes}}",
      notesPack: { ...NOTES_PACK, hash: "b".repeat(64) },
    },
    { verifyLint: { codes: ["DeprecatedApi"] } },
    { verifyLint: { codes: ["UnknownGlobal", "DeprecatedApi"] } },
  ];
  const ids = new Set([base.id]);
  for (const change of variants) {
    const harness = testHarness(change);
    assertHarnessDefinition(harness);
    ids.add(reidentify({ ...base, harness }).id);
  }
  ids.add(reidentify({ ...base, harness: studioHarness() }).id);
  ids.add(reidentify({ ...base, harness: studioHarness({ developmentRuns: 2 }) }).id);
  assert.equal(ids.size, variants.length + 3, "each setting gives its own treatment");
});

test("a harness without Studio runs cannot list development tools", async () => {
  const development = [...testHarness().tools, "development.run", "development.inspect"] as const;
  assert.throws(
    () => assertHarnessDefinition(testHarness({ tools: [...development] })),
    /development tools only when the harness has development runs/u,
  );
  assert.throws(
    () => assertHarnessDefinition(studioHarness({ tools: testHarness().tools })),
    /development tools only when the harness has development runs/u,
  );
  assert.throws(
    () => assertHarnessDefinition(studioHarness({ developmentRuns: 6 })),
    /harness developmentRuns/u,
  );
  // A tool outside the harness subset is not offered, and a call to it does not run.
  const workspace = await builderWorkspace();
  try {
    const harness = testHarness({
      tools: testHarness().tools.filter((tool) => tool !== "workspace.search"),
    });
    const requests: Array<{ tools: string[] }> = [];
    const script = [
      [{ id: "search", name: "workspace.search", arguments: { text: "strict" } }],
      [{ id: "run", name: "development.run", arguments: { scenarioId: "public" } }],
      [{ id: "finish", name: "workspace.finish", arguments: { summary: "Done." } }],
    ];
    const run = await runAgent({
      outputTokens: () => 8192,
      workspaceRoot: workspace,
      task: builderTask,
      treatment: reidentify({ ...builderTreatment(), harness }),
      modelClient: {
        descriptor: builderDescriptor,
        async complete(request) {
          requests.push({ tools: request.tools.map((tool) => tool.name) });
          return assistantAnswer(request, `turn-${requests.length}`, script[requests.length - 1]!);
        },
      },
      verify: async () => ({ gate: "eligible", reasons: [], checks: [] }),
    });
    assert.deepEqual(requests[0]!.tools, harness.tools);
    assert.deepEqual(
      run.trace.filter((event) => event.kind === "tool_rejection").length,
      2,
      "both calls outside the subset are rejected without effect",
    );
    assert.equal(run.status, "locally_eligible");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the request sends the harness reasoning effort and the preview refuses an effort the endpoints reject", () => {
  const high = testHarness({ reasoning: { kind: "effort", effort: "high" } });
  const request = (harness: HarnessDefinition) =>
    builderRequest({ task: builderTask, harness, model: "fake/model-20260917", seed: 1 });
  assert.deepEqual(request(high).reasoning, { kind: "effort", effort: "high" });
  assert.deepEqual(request(testHarness({ reasoning: { kind: "provider_default" } })).reasoning, {
    kind: "provider_default",
  });
  // The balanced catalog effort sends no policy, so the transport selects the route effort.
  assert.equal("reasoning" in request(testHarness()), false);
  const quote = (harness: HarnessDefinition, snapshot: ModelSnapshot) =>
    quoteBuilderTurns({ task: builderTask, harness, snapshot, trials: 1, development: null });
  assert.throws(
    () => quote(high, builderSnapshot()),
    /The tool set Test tools asks for a reasoning effort that fake\/model-20260917 does not support/u,
  );
  const reasoning: ModelSnapshot = {
    ...builderSnapshot(),
    reasoning: {
      effortSelection: "listed",
      supportedEfforts: ["high", "low"],
      defaultEffort: "low",
      defaultEnabled: true,
      mandatory: false,
      supportsTokenBudget: false,
    },
    endpoints: builderSnapshot().endpoints.map((endpoint) => ({
      ...endpoint,
      supportedParameters: ["tools", "reasoning"],
    })),
  };
  assert.ok(quote(high, reasoning).every((work) => work.reasoning?.kind === "effort"));
  assert.throws(
    () => quote(testHarness({ reasoning: { kind: "effort", effort: "xhigh" } }), reasoning),
    /does not support/u,
  );
});

test("the preview quotes the development runs of the harness", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-harness-runs-"));
  try {
    const { selection } = await readyRunProject(root, async () => {
      const harness = studioHarness({ id: "three-runs", title: "Three runs", maxTurns: 2 });
      await writeFile(
        resolve(root, "studies/harnesses/three-runs.json"),
        stableJson({ ...harness, developmentRuns: 3, notesPack: null }),
      );
    });
    const registry = await readHarnessRegistry(root);
    assert.deepEqual(
      registry.harnesses.map((harness) => [harness.id, harness.developmentRuns]),
      [
        ["production-lint", 1],
        ["production", 1],
        ["thin", 0],
        ["three-runs", 3],
      ],
    );
    const launches = async (harnessIds: string[]) =>
      (
        await quoteRegisteredEvalRun({
          root,
          snapshots: fixtureSnapshots.filter((model) => model.id === "openai/gpt-6-luna"),
          selection: selection(harnessIds),
        })
      ).quote.workload.nativeRootLaunches;
    const [none, one, three] = await Promise.all([
      launches(["thin"]),
      launches(["production"]),
      launches(["three-runs"]),
    ]);
    assert.ok(one > none);
    assert.equal(three - none, 3 * (one - none), "each development run adds its Studio launches");
    await assert.rejects(launches(["missing"]), /The tool set missing is not registered/u);
    const prompt = builderRequest({
      task: builderTask,
      harness: registry.harnesses.find((harness) => harness.id === "three-runs")!,
      model: "fake/model-20260917",
      seed: 1,
      development: { publicScenarios: ["public"] },
    }).messages[0]!.content;
    assert.match(prompt, /at most 3 public Studio development tests/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
