import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { SOURCE_LINT_CODES, type SourceLintCode } from "../../contracts/src/capabilities.js";
import {
  MAX_CANDIDATE_FILES,
  assertCandidateManifest,
  compareCodeUnits,
  contentHash,
  hashJson,
  type CandidateManifest,
  type DeterministicCriterion,
} from "../../contracts/src/index.js";
import {
  SOURCE_ANALYSIS_SCHEMA,
  SOURCE_FINDING_LIMIT,
  assertSourceAnalysis,
  type SourceAnalysis,
  type SourceAnalysisToolchain,
  type SourceFinding,
  type SourceScript,
} from "../../contracts/src/source-analysis.js";
import { isRecord } from "../../contracts/src/validation.js";

const execFile = promisify(execFileCallback);
const DEFINITIONS = "packages/luau-toolchain/roblox/globalTypes.d.luau";
const LUAU_LSP_FLAGS = ["--no-strict-dm-types"];
/** Basalt's fixed Luau configuration. It replaces every configuration of the build. */
const LUAURC = '{"languageMode":"nonstrict","lint":{"*":true}}';
/** Luau reads these names as configuration, so the copy of a build never contains them. */
const CONFIGURATION_FILES = new Set([".luaurc", ".config.luau"]);
const STORE = ".basalt-evals/source-analysis";
const TOOL_OPTIONS = { timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true };
const MESSAGE_LIMIT = 4_096;
const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
const CODES = new Set<string>(SOURCE_LINT_CODES);
/** A hot comment that turns off lints or type checks. Its replacement keeps every column. */
const DIRECTIVE = /--!(\s*)(nolint|nocheck)\b/gu;
const FINDING = /^(.+)\(([0-9]+),([0-9]+)\): ([A-Za-z]+): (.*)$/u;
const TOOL_LOG = /^\[([A-Z]+)\] /u;
const ANALYSIS_RULES = new Set<string>(["source_lint_absent", "build_errors_absent"]);

/** True when one of these code checks reads the source analysis of the build. */
export function readsSourceAnalysis(criteria: readonly DeterministicCriterion[]): boolean {
  return criteria.some((criterion) => ANALYSIS_RULES.has(criterion.rule.kind));
}

/** The analyses that this process makes now. Two code checks of one build share one run. */
const inProcess = new Map<string, Promise<SourceAnalysis>>();

/**
 * Read the stored analysis of a sealed build, or make and store it. A missing tool or a tool
 * with another version than the pin throws and stores no record. Concurrent makers of one
 * analysis must store the same bytes.
 */
export async function ensureSourceAnalysis(
  root: string,
  workspaceRoot: string,
  candidate: CandidateManifest,
): Promise<SourceAnalysis> {
  assertCandidateManifest(candidate);
  const toolchain = await pinnedToolchain(root);
  const file = analysisFile(candidate.rootHash, toolchain);
  const key = `${resolve(root)}\0${file}`;
  const running = inProcess.get(key);
  if (running) return running;
  const made = (async () => {
    const files = new RepositoryFiles(root);
    const stored = await files.optional<unknown>(file);
    if (stored !== null) return storedAnalysis(stored, candidate, toolchain);
    const analysis = await analyzeSealedSource(root, workspaceRoot, candidate, toolchain);
    try {
      await files.writeJson(file, analysis);
      return analysis;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = storedAnalysis(await files.json<unknown>(file), candidate, toolchain);
      if (hashJson(existing) !== hashJson(analysis))
        throw new Error("Two analyses of the same build gave different results");
      return existing;
    }
  })();
  inProcess.set(key, made);
  try {
    return await made;
  } finally {
    inProcess.delete(key);
  }
}

/** Read the stored analysis of a sealed build without a tool run. Null when none is stored. */
export async function readSourceAnalysis(
  root: string,
  candidate: CandidateManifest,
): Promise<SourceAnalysis | null> {
  return (await storedSourceAnalyses(root))(candidate);
}

/**
 * A reader of the stored analyses of many builds. It reads the pins one time and runs no tool.
 * The reader gives null for a build without a stored analysis.
 */
export async function storedSourceAnalyses(
  root: string,
): Promise<(candidate: CandidateManifest) => Promise<SourceAnalysis | null>> {
  const toolchain = await pinnedToolchain(root);
  const files = new RepositoryFiles(root);
  return async (candidate) => {
    const stored = await files.optional<unknown>(analysisFile(candidate.rootHash, toolchain));
    return stored === null ? null : storedAnalysis(stored, candidate, toolchain);
  };
}

/**
 * Analyze the files of a manifest now and store no record. The lint feedback of
 * `workspace.verify` uses it on the current workspace of a build. A missing tool or a tool with
 * another version than the pin throws.
 */
export async function analyzeSource(
  root: string,
  workspaceRoot: string,
  candidate: CandidateManifest,
): Promise<SourceAnalysis> {
  assertCandidateManifest(candidate);
  return analyzeSealedSource(root, workspaceRoot, candidate, await pinnedToolchain(root));
}

/**
 * Analyze the sealed files of a build with the pinned luau-lsp. The analysis reads a copy of
 * the manifest files outside the checkout. The copy has Basalt's `.luaurc` and no configuration
 * of the build, and its `--!nolint` and `--!nocheck` comments have no effect.
 */
async function analyzeSealedSource(
  root: string,
  workspaceRoot: string,
  candidate: CandidateManifest,
  toolchain: SourceAnalysisToolchain,
): Promise<SourceAnalysis> {
  await assertPinnedTools(root, toolchain);
  // luau-lsp prints paths relative to the real working directory, so both paths are real.
  const repository = await realpath(root);
  const base = await realpath(await mkdtemp(join(tmpdir(), "basalt-evals-analysis-")));
  const unavailable = (reason: string): SourceAnalysis => ({
    schema: SOURCE_ANALYSIS_SCHEMA,
    candidateHash: candidate.rootHash,
    toolchain,
    status: "unavailable",
    reason: reason.slice(0, 4_000),
    scripts: [],
    findings: [],
    counts: {},
    suppressions: [],
  });
  try {
    const sourceRoot = join(base, "source");
    const suppressions = await copySealedSource(workspaceRoot, candidate, sourceRoot);
    await writeFile(join(sourceRoot, ".luaurc"), LUAURC, { flag: "wx" });
    const sourcemap = join(base, "sourcemap.json");
    const mapped = await run(repository, "rojo", [
      "sourcemap",
      join(sourceRoot, candidate.projectFile),
      "-o",
      sourcemap,
      "--absolute",
    ]);
    if (mapped === "output_limit") return unavailable("Rojo printed more output than Basalt reads");
    if (mapped.exitCode !== 0)
      return unavailable(
        `Rojo could not make the sourcemap: ${toolText(mapped, base, repository)}`,
      );
    let scripts: SourceScript[];
    try {
      scripts = sourceScripts(JSON.parse(await readFile(sourcemap, "utf8")) as unknown, sourceRoot);
    } catch (error) {
      return unavailable(`The sourcemap is not readable: ${errorText(error)}`);
    }
    const analyzed = await run(repository, "luau-lsp", [
      "analyze",
      ...LUAU_LSP_FLAGS,
      "--definitions",
      resolve(repository, DEFINITIONS),
      "--sourcemap",
      sourcemap,
      sourceRoot,
    ]);
    if (analyzed === "output_limit")
      return unavailable("luau-lsp printed more output than Basalt reads");
    if (analyzed.exitCode !== 0 && analyzed.exitCode !== 1)
      return unavailable(
        `luau-lsp stopped with exit code ${analyzed.exitCode}: ${toolText(analyzed, base, repository)}`,
      );
    const parsed = parseFindings(
      `${analyzed.stderr}\n${analyzed.stdout}`,
      repository,
      sourceRoot,
      base,
    );
    if (typeof parsed === "string") return unavailable(parsed);
    if (analyzed.exitCode === 1 && parsed.length === 0)
      return unavailable("luau-lsp reported a failure without a finding");
    parsed.sort(
      (left, right) =>
        compareCodeUnits(left.file, right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        compareCodeUnits(left.code, right.code) ||
        compareCodeUnits(left.message, right.message),
    );
    const counts: Partial<Record<SourceLintCode, number>> = {};
    for (const finding of parsed) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    const analysis: SourceAnalysis = {
      schema: SOURCE_ANALYSIS_SCHEMA,
      candidateHash: candidate.rootHash,
      toolchain,
      status: "complete",
      reason: null,
      scripts,
      findings: parsed.slice(0, SOURCE_FINDING_LIMIT),
      counts,
      suppressions,
    };
    try {
      assertSourceAnalysis(analysis);
    } catch (error) {
      return unavailable(`The analysis has no valid record: ${errorText(error)}`);
    }
    return analysis;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** The pinned tools and the fixed configuration. Their hash with the build is the store key. */
async function pinnedToolchain(root: string): Promise<SourceAnalysisToolchain> {
  const manifest = await readFile(resolve(root, "rokit.toml"), "utf8");
  const pin = (tool: string): string => {
    const match = new RegExp(`^${tool}\\s*=\\s*"[^"@]+@([0-9]+\\.[0-9]+\\.[0-9]+)"`, "mu").exec(
      manifest,
    );
    if (!match) throw new Error(`rokit.toml has no version pin for ${tool}`);
    return match[1]!;
  };
  return {
    luauLsp: pin("luau-lsp"),
    rojo: pin("rojo"),
    definitionsSha256: contentHash(await readFile(resolve(root, DEFINITIONS))),
    flags: [...LUAU_LSP_FLAGS],
    luaurc: LUAURC,
  };
}

function analysisFile(candidateHash: string, toolchain: SourceAnalysisToolchain): string {
  return `${STORE}/${hashJson({ candidateHash, toolchain })}.json`;
}

function storedAnalysis(
  value: unknown,
  candidate: CandidateManifest,
  toolchain: SourceAnalysisToolchain,
): SourceAnalysis {
  assertSourceAnalysis(value);
  if (
    value.candidateHash !== candidate.rootHash ||
    hashJson(value.toolchain) !== hashJson(toolchain)
  )
    throw new Error("The stored source analysis belongs to another build or toolchain");
  return value;
}

/** Refuse a tool with another version than the pin. Rokit finds the pin from the root. */
async function assertPinnedTools(root: string, toolchain: SourceAnalysisToolchain) {
  const version = async (tool: string) => {
    const result = await run(resolve(root), tool, ["--version"]);
    if (result === "output_limit" || result.exitCode !== 0)
      throw new Error(`${tool} did not report its version. Install the tools in rokit.toml.`);
    return result.stdout.trim();
  };
  const luauLsp = await version("luau-lsp");
  if (luauLsp !== toolchain.luauLsp)
    throw new Error(`Code checks need luau-lsp ${toolchain.luauLsp}, but found ${luauLsp}`);
  const rojo = await version("rojo");
  if (rojo !== `Rojo ${toolchain.rojo}`)
    throw new Error(`Code checks need Rojo ${toolchain.rojo}, but found ${rojo}`);
}

interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a pinned tool from the repository root. An absent tool, a timeout or a signal throws,
 * because the build did not cause it.
 */
async function run(
  cwd: string,
  tool: string,
  args: string[],
): Promise<ToolResult | "output_limit"> {
  try {
    const { stdout, stderr } = await execFile(tool, args, { ...TOOL_OPTIONS, cwd });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
    if (failure.code === "ENOENT")
      throw new Error(`${tool} is not installed. Install the tools in rokit.toml.`, {
        cause: error,
      });
    if (typeof failure.code !== "number" || failure.killed || failure.signal)
      throw new Error(`${tool} did not finish: ${errorText(error)}`, { cause: error });
    return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Copy the manifest files of the build and make each `--!nolint` and `--!nocheck` comment
 * ineffective. Each file must still have its sealed bytes.
 */
async function copySealedSource(
  workspaceRoot: string,
  candidate: CandidateManifest,
  target: string,
): Promise<SourceAnalysis["suppressions"]> {
  const source = new RepositoryFiles(workspaceRoot);
  const suppressions: SourceAnalysis["suppressions"] = [];
  await mkdir(target);
  for (const file of candidate.files) {
    if (CONFIGURATION_FILES.has(basename(file.path))) continue;
    const bytes = await source.bytes(file.path);
    if (bytes.length !== file.bytes || contentHash(bytes) !== file.hash)
      throw new Error("The build no longer matches its sealed manifest");
    const destination = join(target, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      destination,
      /\.luau?$/u.test(file.path) ? neutralized(bytes, file.path, suppressions) : bytes,
      { flag: "wx" },
    );
  }
  return suppressions.sort(
    (left, right) => compareCodeUnits(left.file, right.file) || left.line - right.line,
  );
}

/** Replace `--!` with `-- ` in each directive. Lines and columns stay the same. */
function neutralized(
  bytes: Buffer,
  file: string,
  suppressions: SourceAnalysis["suppressions"],
): Buffer {
  // Latin-1 maps each byte to one character, so the bytes outside a directive do not change.
  const text = bytes.toString("latin1");
  let line = 1;
  let counted = 0;
  const replaced = text.replace(
    DIRECTIVE,
    (_match, space: string, directive: "nolint" | "nocheck", offset: number) => {
      for (; counted < offset; counted += 1) if (text.charCodeAt(counted) === 10) line += 1;
      suppressions.push({ file, line, directive });
      return `-- ${space}${directive}`;
    },
  );
  return Buffer.from(replaced, "latin1");
}

/** Every script instance of the sourcemap, with its authored full name in the place. */
function sourceScripts(sourcemap: unknown, sourceRoot: string): SourceScript[] {
  const scripts: SourceScript[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (
      !isRecord(node) ||
      typeof node.name !== "string" ||
      !node.name ||
      typeof node.className !== "string"
    )
      throw new Error("an instance has no name or class");
    if (SCRIPT_CLASSES.has(node.className)) {
      const luau = Array.isArray(node.filePaths)
        ? node.filePaths.find(
            (entry): entry is string => typeof entry === "string" && /\.luau?$/u.test(entry),
          )
        : undefined;
      const local = luau === undefined ? null : relative(sourceRoot, luau);
      scripts.push({
        file:
          local === null || !local || local.startsWith("..") || isAbsolute(local)
            ? null
            : local.split(sep).join("/"),
        className: node.className as SourceScript["className"],
        dataModelPath: path.join("."),
      });
      if (scripts.length > MAX_CANDIDATE_FILES) throw new Error("it has too many scripts");
    }
    if (node.children === undefined) return;
    if (!Array.isArray(node.children)) throw new Error("an instance has invalid children");
    for (const child of node.children)
      visit(child, [...path, isRecord(child) ? String(child.name) : ""]);
  };
  // The full name of a service has no "game." prefix, so the DataModel adds no name.
  if (!isRecord(sourcemap)) throw new Error("it is not an object");
  visit(sourcemap, sourcemap.className === "DataModel" ? [] : [String(sourcemap.name)]);
  return scripts
    .filter((script) => script.dataModelPath !== "")
    .sort(
      (left, right) =>
        compareCodeUnits(left.dataModelPath, right.dataModelPath) ||
        compareCodeUnits(left.file ?? "", right.file ?? ""),
    );
}

/**
 * Read the findings that luau-lsp prints as `<path>(line,column): <Code>: <message>`. A line
 * after a finding without that form continues its message. Any other text fails closed.
 */
function parseFindings(
  output: string,
  root: string,
  sourceRoot: string,
  base: string,
): SourceFinding[] | string {
  const findings: SourceFinding[] = [];
  let current: SourceFinding | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const log = TOOL_LOG.exec(line);
    if (log) {
      if (log[1] === "INFO") continue;
      return `luau-lsp reported: ${clean(line, base, root).slice(0, 1_000)}`;
    }
    const match = FINDING.exec(line);
    if (match) {
      const local = relative(sourceRoot, resolve(root, match[1]!));
      if (!local || local.startsWith("..") || isAbsolute(local))
        return `luau-lsp reported a file outside the build: ${clean(match[1]!, base, root).slice(0, 1_000)}`;
      const message = clean(match[5]!, base, root);
      const code =
        match[4] === "TypeError" && message.startsWith("Unknown global ")
          ? "UnknownGlobal"
          : match[4]!;
      if (!CODES.has(code)) return `luau-lsp reported the unknown code ${code}`;
      current = {
        code: code as SourceLintCode,
        file: local.split(sep).join("/"),
        line: Number(match[2]),
        column: Number(match[3]),
        message,
      };
      findings.push(current);
      continue;
    }
    if (!current)
      return `luau-lsp printed an unexpected line: ${clean(line, base, root).slice(0, 1_000)}`;
    current.message = `${current.message}\n${clean(line, base, root)}`.slice(0, MESSAGE_LIMIT);
  }
  for (const finding of findings) finding.message = finding.message.slice(0, MESSAGE_LIMIT);
  return findings;
}

/** Remove the paths of the temporary copy and the checkout, so that two runs agree. */
function clean(text: string, base: string, root: string): string {
  return text
    .split(`${base}${sep}source${sep}`)
    .join("")
    .split(base)
    .join("<analysis>")
    .split(`${resolve(root)}${sep}`)
    .join("");
}

function toolText(result: ToolResult, base: string, root: string): string {
  return clean(`${result.stderr}\n${result.stdout}`.trim(), base, root).slice(0, 1_000);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "unknown error";
}
