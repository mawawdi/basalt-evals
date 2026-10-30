import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree, walkRegularTree } from "../packages/artifact-store/src/inventory.js";
import { SOURCE_LINT_CODES } from "../packages/contracts/src/capabilities.js";
import {
  assertEvaluatorSpec,
  hashJson,
  type CandidateManifest,
  type DeterministicCriterion,
  type EvaluatorSpec,
} from "../packages/contracts/src/index.js";
import {
  SOURCE_ANALYSIS_SCHEMA,
  assertSourceAnalysis,
  type SourceAnalysis,
} from "../packages/contracts/src/source-analysis.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import {
  ensureSourceAnalysis,
  readSourceAnalysis,
  readsSourceAnalysis,
} from "../packages/graders/src/source-analysis.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";

const repository = resolve(process.cwd());

/** A small Rojo build with lint findings, directives and configuration that Basalt ignores. */
async function lintFixture(
  root: string,
): Promise<{ workspace: string; candidate: CandidateManifest }> {
  await cp(resolve(repository, "rokit.toml"), resolve(root, "rokit.toml"));
  await mkdir(resolve(root, "packages/luau-toolchain/roblox"), { recursive: true });
  await cp(
    resolve(repository, "packages/luau-toolchain/roblox/globalTypes.d.luau"),
    resolve(root, "packages/luau-toolchain/roblox/globalTypes.d.luau"),
  );
  const workspace = resolve(root, "workspace");
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  const files: Record<string, string> = {
    "default.project.json": JSON.stringify({
      name: "LintFixture",
      tree: {
        $className: "DataModel",
        ServerScriptService: {
          $className: "ServerScriptService",
          Mechanic: { $path: "src/server/Mechanic.server.luau" },
        },
        StarterPlayer: {
          $className: "StarterPlayer",
          StarterPlayerScripts: {
            $className: "StarterPlayerScripts",
            Hud: { $path: "src/client/Hud.client.luau" },
          },
        },
        ReplicatedStorage: { $className: "ReplicatedStorage", Shared: { $path: "src/shared" } },
      },
    }),
    "src/server/Mechanic.server.luau":
      "wait(1)\nspawn(function() end)\ndelay(1, function() end)\nprint(missingGlobal)\n",
    "src/client/Hud.client.luau": "--!nolint\nwait(2)\n",
    "src/shared/Util.luau": '--!nocheck\nlocal n: number = "text"\nreturn n\n',
    // A build cannot configure its own analysis. Basalt copies neither file.
    ".luaurc": '{"lint": {"*": false}, "globals": ["missingGlobal"]}',
    "src/shared/.config.luau": 'return { luau = { lint = { ["*"] = false } } }\n',
  };
  for (const [path, text] of Object.entries(files)) await writeFile(resolve(workspace, path), text);
  const inventory = await walkRegularTree(workspace, { label: "Fixture", maxFileBytes: 1 << 20 });
  return {
    workspace,
    candidate: {
      rootHash: hashJson(inventory),
      projectFile: "default.project.json",
      files: inventory,
    },
  };
}

test("the pinned luau-lsp analyzes a copy of the sealed source and stores one result", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-source-analysis-"));
  try {
    const { workspace, candidate } = await lintFixture(root);
    // Two names of one folder make two makers of one stored record. On macOS both run the tool
    // and one of them meets the stored record of the other.
    const [first, second] = await Promise.all([
      ensureSourceAnalysis(root, workspace, candidate),
      ensureSourceAnalysis(await realpath(root), workspace, candidate),
    ]);
    assert.deepEqual(second, first);
    assertSourceAnalysis(first);
    assert.equal(first.status, "complete", first.reason ?? "");
    assert.equal(first.candidateHash, candidate.rootHash);
    assert.deepEqual(
      first.findings.map((finding) => `${finding.file}:${finding.line}:${finding.code}`),
      [
        // The neutralized --!nolint does not hide this finding.
        "src/client/Hud.client.luau:2:DeprecatedApi",
        "src/server/Mechanic.server.luau:1:DeprecatedApi",
        "src/server/Mechanic.server.luau:2:DeprecatedApi",
        "src/server/Mechanic.server.luau:3:DeprecatedApi",
        // The global of the ignored .luaurc stays unknown.
        "src/server/Mechanic.server.luau:4:UnknownGlobal",
        // The neutralized --!nocheck does not hide this type error.
        "src/shared/Util.luau:2:TypeError",
      ],
    );
    assert.deepEqual(first.counts, { DeprecatedApi: 4, TypeError: 1, UnknownGlobal: 1 });
    assert.deepEqual(first.suppressions, [
      { file: "src/client/Hud.client.luau", line: 1, directive: "nolint" },
      { file: "src/shared/Util.luau", line: 1, directive: "nocheck" },
    ]);
    assert.deepEqual(first.scripts, [
      {
        file: "src/shared/Util.luau",
        className: "ModuleScript",
        dataModelPath: "ReplicatedStorage.Shared.Util",
      },
      {
        file: "src/server/Mechanic.server.luau",
        className: "Script",
        dataModelPath: "ServerScriptService.Mechanic",
      },
      {
        file: "src/client/Hud.client.luau",
        className: "LocalScript",
        dataModelPath: "StarterPlayer.StarterPlayerScripts.Hud",
      },
    ]);
    assert.ok(first.findings.every((finding) => !finding.message.includes(root)));
    assert.equal(first.toolchain.luauLsp, "1.63.0");
    // The analysis reads a copy. The sealed files keep their bytes.
    assert.equal(
      await readFile(resolve(workspace, "src/client/Hud.client.luau"), "utf8"),
      "--!nolint\nwait(2)\n",
    );
    assert.deepEqual(await readSourceAnalysis(root, candidate), first);
    const stored = resolve(
      root,
      ".basalt-evals/source-analysis",
      `${hashJson({ candidateHash: candidate.rootHash, toolchain: first.toolchain })}.json`,
    );
    assert.equal(hashJson(JSON.parse(await readFile(stored, "utf8"))), hashJson(first));
    // A stored record is read again without a tool run.
    assert.deepEqual(await ensureSourceAnalysis(root, workspace, candidate), first);
    const other = { ...candidate, rootHash: "f".repeat(64) };
    assert.equal(await readSourceAnalysis(root, other), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function analysisFor(candidateHash: string, patch: Partial<SourceAnalysis> = {}): SourceAnalysis {
  const analysis: SourceAnalysis = {
    schema: SOURCE_ANALYSIS_SCHEMA,
    candidateHash,
    toolchain: {
      luauLsp: "1.63.0",
      rojo: "7.7.0",
      definitionsSha256: "a".repeat(64),
      flags: ["--no-strict-dm-types"],
      luaurc: '{"languageMode":"nonstrict","lint":{"*":true}}',
    },
    status: "complete",
    reason: null,
    scripts: [
      {
        file: "src/server/Mechanic.server.luau",
        className: "Script",
        dataModelPath: "ServerScriptService.Mechanic",
      },
    ],
    findings: [],
    counts: {},
    suppressions: [],
    ...patch,
  };
  assertSourceAnalysis(analysis);
  return analysis;
}

const lintRule = (codes: string[]) =>
  ({ kind: "source_lint_absent", codes }) as unknown as DeterministicCriterion["rule"];

async function movingPlatform(root: string) {
  const task = await loadRegisteredTask(repository, "tasks/pilot/moving-platform");
  const workspace = resolve(root, "workspace");
  await materializeTaskSeed(repository, task, workspace);
  const files = await inventoryTree(workspace);
  const candidate: CandidateManifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  const evaluator: EvaluatorSpec = structuredClone(task.evaluator);
  evaluator.deterministic.push({
    id: "no-deprecated-api",
    layer: "static",
    statement: "The source uses no deprecated API.",
    required: true,
    rule: lintRule(["DeprecatedApi", "UnknownGlobal"]),
  });
  assertEvaluatorSpec(evaluator);
  return { workspace, candidate, evaluator };
}

test("a source lint check reads only the bound analysis of the same build", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-source-lint-rule-"));
  try {
    const { workspace, candidate, evaluator } = await movingPlatform(root);
    const grade = async (analysis?: SourceAnalysis) =>
      (
        await evaluateDeterministicCriteria({
          workspaceRoot: workspace,
          evaluator,
          candidate,
          treatmentId: "tr-lint",
          analysis,
        })
      ).find((item) => item.criterionId === "no-deprecated-api")!;
    const findings = [
      {
        code: "DeprecatedApi" as const,
        file: "src/server/Mechanic.server.luau",
        line: 3,
        column: 1,
        message: "Function 'wait' is deprecated, use 'task.wait' instead",
      },
      {
        code: "LocalUnused" as const,
        file: "src/server/Mechanic.server.luau",
        line: 4,
        column: 7,
        message: "Variable 'x' is never used; prefix with '_' to silence",
      },
    ];
    const dirty = analysisFor(candidate.rootHash, {
      findings,
      counts: { DeprecatedApi: 1, LocalUnused: 1 },
    });
    const rejected = await grade(dirty);
    assert.equal(rejected.outcome, "rejected");
    assert.equal(rejected.layer, "static");
    assert.deepEqual(rejected.observed, [1, 0]);
    assert.deepEqual(rejected.evidence, [hashJson(dirty)]);
    assert.match(rejected.explanation, /src\/server\/Mechanic\.server\.luau:3:1 DeprecatedApi/u);
    assert.doesNotMatch(rejected.explanation, /LocalUnused/u);
    // The rule needs no Studio evidence, and other codes do not count.
    const clean = analysisFor(candidate.rootHash, {
      findings: [findings[1]!],
      counts: { LocalUnused: 1 },
    });
    const verified = await grade(clean);
    assert.equal(verified.outcome, "verified");
    assert.deepEqual(verified.observed, [0, 0]);
    const unavailable = analysisFor(candidate.rootHash, {
      status: "unavailable",
      reason: "luau-lsp reported the unknown code NewLint",
      scripts: [],
    });
    const incomplete = await grade(unavailable);
    assert.equal(incomplete.outcome, "incomplete");
    assert.match(incomplete.explanation, /unknown code NewLint/u);
    assert.deepEqual(incomplete.evidence, [hashJson(unavailable)]);
    const absent = await grade();
    assert.equal(absent.outcome, "incomplete");
    assert.match(absent.explanation, /No source analysis exists/u);
    await assert.rejects(grade(analysisFor("e".repeat(64))), /Source analysis binding mismatch/u);
    // A capped list still counts every finding, and the rule still rejects.
    const capped = analysisFor(candidate.rootHash, {
      findings: Array.from({ length: 2000 }, (_, index) => ({
        ...findings[1]!,
        line: index + 1,
      })),
      counts: { LocalUnused: 2400, DeprecatedApi: 3 },
    });
    const beyondCap = await grade(capped);
    assert.equal(beyondCap.outcome, "rejected");
    assert.deepEqual(beyondCap.observed, [3, 0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source lint rules are static, bounded and name only codes of the pinned tool", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-source-lint-contract-"));
  try {
    const { evaluator } = await movingPlatform(root);
    const criterion = evaluator.deterministic.find((item) => item.id === "no-deprecated-api")!;
    assert.ok(readsSourceAnalysis([criterion]));
    assert.ok(!readsSourceAnalysis(evaluator.deterministic.filter((item) => item !== criterion)));
    const variant = (patch: Partial<DeterministicCriterion>) => {
      const copy = structuredClone(evaluator);
      Object.assign(
        copy.deterministic.find((item) => item.id === criterion.id)!,
        patch,
      );
      return copy;
    };
    assert.throws(() => assertEvaluatorSpec(variant({ layer: "engine" })), /evidence authority/u);
    for (const codes of [
      [],
      ["NotALint"],
      ["DeprecatedApi", "DeprecatedApi"],
      SOURCE_LINT_CODES.slice(0, 17),
    ])
      assert.throws(() => assertEvaluatorSpec(variant({ rule: lintRule(codes) })), /source lint/u);
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({
            rule: {
              ...lintRule(["TypeError"]),
              path: "src/x.luau",
            } as DeterministicCriterion["rule"],
          }),
        ),
      /source lint rule fields/u,
    );
    assertEvaluatorSpec(variant({ rule: lintRule(["TypeError", "SyntaxError", "UnknownGlobal"]) }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stored analysis must match its build and its key", async () => {
  const analysis = analysisFor("b".repeat(64));
  assert.throws(
    () => assertSourceAnalysis({ ...analysis, counts: { DeprecatedApi: 1 } }),
    /counts/u,
  );
  assert.throws(
    () => assertSourceAnalysis({ ...analysis, status: "unavailable", reason: null }),
    /reason/u,
  );
  assert.throws(
    () =>
      assertSourceAnalysis({
        ...analysis,
        findings: [
          { code: "NewLint", file: "src/a.luau", line: 1, column: 1, message: "A new lint" },
        ],
        counts: { NewLint: 1 },
      }),
    /source finding/u,
  );
  assert.throws(() => assertSourceAnalysis({ ...analysis, extra: true }), /fields/u);
});
