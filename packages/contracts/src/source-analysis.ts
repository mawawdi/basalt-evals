import { SOURCE_LINT_CODES, type SourceLintCode } from "./capabilities.js";
import { MAX_CANDIDATE_FILES, isSafeRelativePath } from "./index.js";
import { assertExactRecordKeys, fail, isRecord, isText } from "./validation.js";

export const SOURCE_ANALYSIS_SCHEMA = "basalt-evals/source-analysis" as const;
/** An analysis keeps its first findings up to this limit. `counts` counts every finding. */
export const SOURCE_FINDING_LIMIT = 2000;
const SOURCE_SCRIPT_CLASSES = ["Script", "LocalScript", "ModuleScript"] as const;

/** The fixed tools and configuration of an analysis. Their hash with the build is its key. */
export interface SourceAnalysisToolchain {
  /** The luau-lsp version that rokit.toml pins. The analysis refuses another version. */
  luauLsp: string;
  /** The Rojo version that rokit.toml pins. Rojo makes the sourcemap. */
  rojo: string;
  /** The SHA-256 of the Roblox type definitions file. */
  definitionsSha256: string;
  /** The luau-lsp flags that name no file. */
  flags: string[];
  /** The exact Luau configuration that replaces all configuration of the build. */
  luaurc: string;
}

/** One script instance of the sealed sourcemap. */
export interface SourceScript {
  /** The Luau file of the script, relative to the build root. Null for a script without one. */
  file: string | null;
  className: (typeof SOURCE_SCRIPT_CLASSES)[number];
  /** The authored full name in the place, for example `ServerScriptService.Mechanic`. */
  dataModelPath: string;
}

export interface SourceFinding {
  code: SourceLintCode;
  file: string;
  line: number;
  column: number;
  message: string;
}

/**
 * The origin of one script error. `build` is a script of the sealed sourcemap or a fixed Studio
 * copy of one. `external` is a script outside the place that cannot be a build script.
 * `unknown` is every other error, for example a script that the build cloned at runtime.
 */
export type ScriptErrorOrigin = "build" | "external" | "unknown";

/**
 * The script errors of each origin. `truncated` is true when the error channel of a context
 * reached `DIAGNOSTIC_CHANNEL_LIMIT`, so Studio kept no later error of that context.
 */
export type ScriptErrorCounts = Record<ScriptErrorOrigin, number> & { truncated: boolean };

/** The findings of each lint code. A code without a finding has no key. */
export type SourceLintCounts = Partial<Record<SourceLintCode, number>>;

/**
 * The static analysis of one sealed build. `status` is `unavailable` when the pinned tools ran
 * but gave no result that Basalt can read. Then `reason` tells why, and the lists are empty.
 */
export interface SourceAnalysis {
  schema: typeof SOURCE_ANALYSIS_SCHEMA;
  candidateHash: string;
  toolchain: SourceAnalysisToolchain;
  status: "complete" | "unavailable";
  reason: string | null;
  scripts: SourceScript[];
  findings: SourceFinding[];
  counts: SourceLintCounts;
  /** Each `--!nolint` or `--!nocheck` text that the analysis made ineffective. */
  suppressions: Array<{ file: string; line: number; directive: "nolint" | "nocheck" }>;
}

const CODES = new Set<string>(SOURCE_LINT_CODES);
const CLASSES = new Set<string>(SOURCE_SCRIPT_CLASSES);

export function assertSourceAnalysis(value: unknown): asserts value is SourceAnalysis {
  if (!isRecord(value) || value.schema !== SOURCE_ANALYSIS_SCHEMA) fail("source analysis schema");
  assertExactRecordKeys(
    value,
    [
      "schema",
      "candidateHash",
      "toolchain",
      "status",
      "reason",
      "scripts",
      "findings",
      "counts",
      "suppressions",
    ],
    "source analysis fields",
  );
  if (!isHash(value.candidateHash)) fail("source analysis build identity");
  assertToolchain(value.toolchain);
  if (value.status === "complete") {
    if (value.reason !== null) fail("source analysis reason");
  } else if (value.status === "unavailable") {
    if (!isText(value.reason) || value.reason.length > 4_000) fail("source analysis reason");
  } else fail("source analysis status");
  if (!Array.isArray(value.scripts) || value.scripts.length > MAX_CANDIDATE_FILES)
    fail("source analysis scripts");
  for (const script of value.scripts) {
    if (!isRecord(script)) fail("source script");
    assertExactRecordKeys(script, ["file", "className", "dataModelPath"], "source script fields");
    if (
      (script.file !== null && !isSafeRelativePath(script.file)) ||
      !CLASSES.has(String(script.className)) ||
      !isText(script.dataModelPath) ||
      script.dataModelPath.length > 2_048
    )
      fail("source script");
  }
  if (!Array.isArray(value.findings) || value.findings.length > SOURCE_FINDING_LIMIT)
    fail("source findings");
  const listed = new Map<string, number>();
  for (const finding of value.findings) {
    if (!isRecord(finding)) fail("source finding");
    assertExactRecordKeys(
      finding,
      ["code", "file", "line", "column", "message"],
      "source finding fields",
    );
    if (
      !CODES.has(String(finding.code)) ||
      !isSafeRelativePath(finding.file) ||
      !isPositiveInteger(finding.line) ||
      !isPositiveInteger(finding.column) ||
      typeof finding.message !== "string" ||
      finding.message.length > 4_096
    )
      fail("source finding");
    listed.set(String(finding.code), (listed.get(String(finding.code)) ?? 0) + 1);
  }
  if (!isRecord(value.counts)) fail("source finding counts");
  for (const [code, count] of Object.entries(value.counts))
    if (!CODES.has(code) || !isPositiveInteger(count)) fail("source finding counts");
  const counts = value.counts as Record<string, number>;
  const complete = value.findings.length < SOURCE_FINDING_LIMIT;
  for (const code of new Set([...listed.keys(), ...Object.keys(counts)])) {
    const kept = listed.get(code) ?? 0;
    if (kept > (counts[code] ?? 0) || (complete && kept !== counts[code]))
      fail("source finding counts");
  }
  if (!Array.isArray(value.suppressions) || value.suppressions.length > MAX_CANDIDATE_FILES)
    fail("source suppressions");
  for (const suppression of value.suppressions) {
    if (!isRecord(suppression)) fail("source suppression");
    assertExactRecordKeys(suppression, ["file", "line", "directive"], "source suppression fields");
    if (
      !isSafeRelativePath(suppression.file) ||
      !isPositiveInteger(suppression.line) ||
      (suppression.directive !== "nolint" && suppression.directive !== "nocheck")
    )
      fail("source suppression");
  }
  if (
    value.status === "unavailable" &&
    (value.scripts.length ||
      value.findings.length ||
      Object.keys(counts).length ||
      value.suppressions.length)
  )
    fail("unavailable source analysis content");
}

function assertToolchain(value: unknown): asserts value is SourceAnalysisToolchain {
  if (!isRecord(value)) fail("source analysis toolchain");
  assertExactRecordKeys(
    value,
    ["luauLsp", "rojo", "definitionsSha256", "flags", "luaurc"],
    "source analysis toolchain fields",
  );
  if (
    !isVersion(value.luauLsp) ||
    !isVersion(value.rojo) ||
    !isHash(value.definitionsSha256) ||
    !Array.isArray(value.flags) ||
    value.flags.length > 16 ||
    value.flags.some((flag) => !isText(flag) || flag.length > 128) ||
    !isText(value.luaurc) ||
    value.luaurc.length > 4_096
  )
    fail("source analysis toolchain");
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
