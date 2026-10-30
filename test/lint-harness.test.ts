import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  builderRequest,
  runAgent,
  type SourceAnalyzer,
} from "../packages/agent-runtime/src/index.js";
import type { LocalVerification } from "../packages/agent-runtime/src/tools.js";
import {
  assertHarnessDefinition,
  hashJson,
  type HarnessDefinition,
} from "../packages/contracts/src/index.js";
import { harnessSettingRows, harnessSummary } from "../packages/contracts/src/harness.js";
import { SOURCE_ANALYSIS_SCHEMA } from "../packages/contracts/src/source-analysis.js";
import type { ModelTurnRequest } from "../packages/model-client/src/contracts.js";
import { analyzeSource } from "../packages/graders/src/source-analysis.js";
import { readHarnessRegistry } from "../packages/operator/src/config.js";
import {
  FAKE_MODEL,
  assistantAnswer,
  builderDescriptor,
  builderTask,
  builderTreatment,
  reidentify,
  testHarness,
} from "./builder-fixture.js";

const repository = resolve(process.cwd());

// These values come from the code at commit 764e65eb, before the lint feedback. The default
// tool sets must keep their request bytes and treatment identities, so that each stored paid
// build stays verifiable.
const PINNED = {
  production: {
    harness: "8b42cf323dadd635aaaf109e65461c5352bacc16dfe286b2061ebe561383d5ef",
    request: "1ca0a6351234a248fd92368bf35bf4da9efaea62e44f0f3f9bf112fc0778529b",
    treatment: "tr-dfeb1ac053fce06d9565",
  },
  thin: {
    harness: "7fc1fc130cc72d5a1bb458cd940d551c98969f89a0f626c5739aeb689fbe381b",
    request: "a2b5e68e8dd434520012311dcb10869a0ba6645b19da8de3fb51a1ab93e1b3bc",
    treatment: "tr-774d66e3cfcdb658a08f",
  },
};

const LINT_CODES = [
  "UnknownGlobal",
  "DeprecatedGlobal",
  "GlobalUsedAsLocal",
  "UninitializedLocal",
  "DeprecatedApi",
] as const;

function request(harness: HarnessDefinition) {
  return builderRequest({
    task: builderTask,
    harness,
    model: FAKE_MODEL,
    seed: 1,
    ...(harness.developmentRuns > 0 ? { development: { publicScenarios: ["public"] } } : {}),
  });
}

test("the default tool sets keep their request bytes and identities", async () => {
  const { harnesses } = await readHarnessRegistry(repository);
  const find = (id: string) => harnesses.find((harness) => harness.id === id)!;
  for (const id of ["production", "thin"] as const) {
    const harness = find(id);
    assert.equal(Object.hasOwn(harness, "verifyLint"), false);
    assert.equal(hashJson(harness), PINNED[id].harness);
    assert.equal(hashJson(request(harness)), PINNED[id].request);
    assert.equal(reidentify({ ...builderTreatment(), harness }).id, PINNED[id].treatment);
  }
  // The lint tool set is the production tool set with lint feedback and its own name.
  const production = find("production");
  const lint = find("production-lint");
  const { id: _id, title, verifyLint, ...settings } = lint;
  assert.equal(title, "Studio tools + code analysis");
  assert.deepEqual(verifyLint, { codes: LINT_CODES });
  assert.deepEqual(settings, (({ id: _, title: __, ...rest }) => rest)(production));
  // Its request differs only in the description of workspace.verify.
  const base = request(production);
  const changed = request(lint);
  const verify = (item: typeof base) =>
    item.tools.find((tool) => tool.name === "workspace.verify")!.description;
  assert.notEqual(verify(changed), verify(base));
  assert.ok(verify(changed).startsWith(`${verify(base)} `));
  for (const code of LINT_CODES) assert.match(verify(changed), new RegExp(code, "u"));
  assert.deepEqual(
    {
      ...changed,
      tools: changed.tools.map((tool) => ({ ...tool, description: "" })),
    },
    { ...base, tools: base.tools.map((tool) => ({ ...tool, description: "" })) },
  );
});

test("a lint setting names known codes once, in order, and needs workspace.verify", () => {
  const lint = (verifyLint: unknown, overrides: Partial<HarnessDefinition> = {}) =>
    ({ ...testHarness(overrides), verifyLint }) as HarnessDefinition;
  assert.doesNotThrow(() => assertHarnessDefinition(lint({ codes: [...LINT_CODES] })));
  for (const [value, message] of [
    [null, /harness verifyLint/u],
    [{ codes: [] }, /one or more lint codes/u],
    [{ codes: ["NotALint"] }, /canonical order/u],
    [{ codes: ["DeprecatedApi", "UnknownGlobal"] }, /canonical order/u],
    [{ codes: ["DeprecatedApi", "DeprecatedApi"] }, /canonical order/u],
    [{ codes: ["DeprecatedApi"], extra: true }, /verifyLint fields/u],
  ] as const)
    assert.throws(() => assertHarnessDefinition(lint(value)), message);
  assert.throws(
    () =>
      assertHarnessDefinition(
        lint(
          { codes: ["DeprecatedApi"] },
          { tools: testHarness().tools.filter((tool) => tool !== "workspace.verify") },
        ),
      ),
    /include workspace.verify/u,
  );
  // The console shows the code list in the read-only settings of the tool set.
  const harness = lint({ codes: ["UnknownGlobal", "DeprecatedApi"] });
  assert.deepEqual(
    harnessSettingRows(harness).find((row) => row.label === "Code analysis"),
    { label: "Code analysis", value: "With each local check: UnknownGlobal, DeprecatedApi" },
  );
  assert.equal(
    harnessSummary(harness),
    "Edits code and runs quick local checks, gets code analysis",
  );
  assert.equal(
    harnessSettingRows(testHarness()).find((row) => row.label === "Code analysis")?.value,
    "None",
  );
});

/** A small Rojo build with two findings of the lint codes and findings of other codes. */
async function lintWorkspace(): Promise<string> {
  const workspace = await mkdtemp(resolve(tmpdir(), "basalt-lint-harness-"));
  await mkdir(resolve(workspace, "src/server"), { recursive: true });
  await writeFile(
    resolve(workspace, "default.project.json"),
    JSON.stringify({
      name: "LintHarness",
      tree: {
        $className: "DataModel",
        ServerScriptService: {
          $className: "ServerScriptService",
          Mechanic: { $path: "src/server/Mechanic.server.luau" },
        },
      },
    }),
  );
  await writeFile(
    resolve(workspace, "src/server/Mechanic.server.luau"),
    'wait(1)\nprint(missingGlobal)\nlocal unused = 1\nlocal n: number = "text"\n',
  );
  return workspace;
}

const eligible: LocalVerification = {
  gate: "eligible",
  reasons: [],
  checks: [{ name: "luau_parse", outcome: "pass" }],
};

/** One build that calls workspace.verify and then workspace.finish. */
async function verifyOnce(
  workspace: string,
  harness: HarnessDefinition,
  sourceAnalyzer?: SourceAnalyzer,
) {
  const requests: ModelTurnRequest[] = [];
  const script = [
    [{ id: "verify", name: "workspace.verify", arguments: {} }],
    [{ id: "finish", name: "workspace.finish", arguments: { summary: "Done." } }],
  ];
  const run = await runAgent({
    outputTokens: () => 8192,
    workspaceRoot: workspace,
    task: builderTask,
    treatment: reidentify({ ...builderTreatment(), harness }),
    modelClient: {
      descriptor: builderDescriptor,
      async complete(item) {
        requests.push(item);
        return assistantAnswer(item, `turn-${requests.length}`, script[requests.length - 1]!);
      },
    },
    verify: async () => structuredClone(eligible),
    ...(sourceAnalyzer ? { sourceAnalyzer } : {}),
  });
  const reply = requests[1]!.messages.find(
    (message) => message.role === "tool" && message.toolCallId === "verify",
  )!;
  const traced = run.trace.find(
    (event) => event.kind === "tool_result" && event.data.id === "verify",
  )!;
  return {
    run,
    result: JSON.parse(reply.content) as Record<string, unknown>,
    traced: traced.data,
    tools: requests[0]!.tools,
  };
}

test("workspace.verify of the lint tool set adds advice for its codes and keeps the gate", async () => {
  const workspace = await lintWorkspace();
  try {
    const harness = testHarness({ verifyLint: { codes: [...LINT_CODES] } });
    // The real pinned luau-lsp runs one time, on the current workspace, and stores no record.
    const lint = await verifyOnce(workspace, harness, (root, candidate) =>
      analyzeSource(repository, root, candidate),
    );
    const plain = await verifyOnce(workspace, testHarness());
    const lines = lint.result.lint as string[];
    assert.equal(lines.length, 3, lines.join("\n"));
    assert.match(lines[0]!, /^src\/server\/Mechanic\.server\.luau:1: DeprecatedApi: .*wait/u);
    assert.match(
      lines[1]!,
      /^src\/server\/Mechanic\.server\.luau:2: UnknownGlobal: .*missingGlobal/u,
    );
    assert.equal(
      lines[2],
      `Lint: 2 findings for ${LINT_CODES.join(", ")}. Lint findings are advice and do not change the gate.`,
    );
    // Codes outside the list, for example LocalUnused and TypeError, do not show.
    assert.doesNotMatch(lines.join("\n"), /LocalUnused|TypeError/u);
    // The findings do not change the gate, the trace gate or the build status.
    const { lint: _lint, ...withoutLint } = lint.result;
    assert.deepEqual(withoutLint, plain.result);
    assert.equal(lint.traced.verificationGate, "eligible");
    assert.deepEqual(lint.traced.result, { ...(plain.traced.result as object), lint: lines });
    assert.equal(lint.run.status, "locally_eligible");
    assert.equal(plain.run.status, "locally_eligible");
    assert.equal(Object.hasOwn(plain.result, "lint"), false);
    // Only the lint tool set describes the lint lines.
    const description = (tools: typeof lint.tools) =>
      tools.find((tool) => tool.name === "workspace.verify")!.description;
    assert.match(description(lint.tools), /lint lines from luau-lsp/u);
    assert.equal(description(plain.tools), "Run the fixed local candidate gate.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an unavailable analyzer gives one line and keeps the gate", async () => {
  const workspace = await lintWorkspace();
  const empty = await mkdtemp(resolve(tmpdir(), "basalt-lint-missing-"));
  try {
    const harness = testHarness({ verifyLint: { codes: ["DeprecatedApi"] } });
    // A root without rokit.toml has no pinned tools, so the real analyzer fails before a tool run.
    const missing = await verifyOnce(workspace, harness, (root, candidate) =>
      analyzeSource(empty, root, candidate),
    );
    assert.equal((missing.result.lint as string[]).length, 1);
    assert.match(
      (missing.result.lint as string[])[0]!,
      /^Lint is unavailable, and the gate does not use it: .*rokit\.toml/u,
    );
    assert.equal(missing.result.gate, "eligible");
    assert.equal(missing.run.status, "locally_eligible");
    const unavailable = await verifyOnce(workspace, harness, async (_root, candidate) => ({
      schema: SOURCE_ANALYSIS_SCHEMA,
      candidateHash: candidate.rootHash,
      toolchain: {
        luauLsp: "1.63.0",
        rojo: "7.7.0",
        definitionsSha256: "a".repeat(64),
        flags: [],
        luaurc: "{}",
      },
      status: "unavailable",
      reason: "luau-lsp printed more output\nthan Basalt reads",
      scripts: [],
      findings: [],
      counts: {},
      suppressions: [],
    }));
    assert.deepEqual(unavailable.result.lint, [
      "Lint is unavailable, and the gate does not use it: luau-lsp printed more output than Basalt reads",
    ]);
    assert.equal(unavailable.result.gate, "eligible");
    // A lint tool set needs an analyzer, and another tool set refuses one.
    await assert.rejects(verifyOnce(workspace, harness), /needs a source analyzer/u);
    await assert.rejects(
      verifyOnce(workspace, testHarness(), async () => {
        throw new Error("not called");
      }),
      /cannot receive a source analyzer/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});
