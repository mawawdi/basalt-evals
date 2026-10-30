import { SOURCE_LINT_CODES, type SourceLintCode } from "./capabilities.js";
import { REASONING_EFFORTS, type ModelRequestReasoning } from "./reasoning.js";
import { assertExactRecordKeys, fail, isRecord, isText } from "./validation.js";

export const MAX_HARNESS_TURNS = 128;
/** Each development run is a full Studio session of the builder. */
const MAX_HARNESS_DEVELOPMENT_RUNS = 5;
/** The summaries that one build can request before its conversation reaches the context limit. */
export const MAX_HARNESS_SUMMARIES = 8;
const MIN_COMPACTION_BYTES = 16 * 1024;
const MAX_COMPACTION_BYTES = 8 * 1024 * 1024;
const MAX_HARNESS_TEXT_CHARS = 16 * 1024;
const MAX_HARNESS_TITLE_CHARS = 80;

/** The builder tools in their canonical order. A harness lists a subset in this order. */
export const BUILDER_TOOL_NAMES = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "workspace.patch",
  "workspace.write",
  "workspace.verify",
  "workspace.finish",
  "development.run",
  "development.inspect",
  "notes.list",
  "notes.read",
] as const;
export type BuilderToolName = (typeof BUILDER_TOOL_NAMES)[number];

/**
 * The slots of a prompt template. A template contains each slot that applies exactly one time.
 * `stages` lists the prompts of the earlier stages of a staged evaluation. It is empty for the
 * first stage and for an evaluation without stages, so every template has it.
 */
export const HARNESS_PROMPT_SLOTS = [
  "stages",
  "task",
  "workspace",
  "development",
  "notes",
] as const;
type HarnessPromptSlot = (typeof HARNESS_PROMPT_SLOTS)[number];

/**
 * The reasoning of builder requests. `catalog_balanced` sends no request policy, so the frozen
 * transport selects the balanced effort that the catalog advertises for each model.
 */
type HarnessReasoning = { kind: "catalog_balanced" } | ModelRequestReasoning;

/**
 * `none` keeps the full conversation until the context limit stops the build. `summarize_at`
 * replaces the conversation with a model summary when it is larger than `atBytes`.
 */
type HarnessCompaction =
  { kind: "none" } | { kind: "summarize_at"; atBytes: number; maxSummaries: number };

/**
 * The lint feedback of `workspace.verify`. The harness file declares a fixed public list of lint
 * codes in their canonical order. The list never comes from the criteria of an evaluation.
 */
export interface HarnessVerifyLint {
  codes: SourceLintCode[];
}

/** A builder harness: the fixed prompt, tools and limits of each build that uses it. */
export interface HarnessDefinition {
  id: string;
  /** The name of the tool set in the console. */
  title: string;
  systemPrompt: string;
  /**
   * The first user message. It holds `{{stages}}`, `{{task}}`, `{{workspace}}`, `{{development}}`
   * and `{{notes}}`.
   */
  promptTemplate: string;
  tools: BuilderToolName[];
  /** The public Studio development runs of each build. Zero gives no development tools. */
  developmentRuns: number;
  maxTurns: number;
  reasoning: HarnessReasoning;
  /** The frozen API notes pack, or null. The hash binds the exact files of the pack. */
  notesPack: { id: string; hash: string } | null;
  compaction: HarnessCompaction;
  /**
   * A harness without lint feedback has no `verifyLint` key. The key is optional and not null,
   * because a new setting must not change the hash of a harness that does not use it.
   */
  verifyLint?: HarnessVerifyLint;
}

/** The slots that a harness template must contain: each one exactly one time. */
function requiredPromptSlots(
  harness: Pick<HarnessDefinition, "developmentRuns" | "notesPack">,
): HarnessPromptSlot[] {
  return [
    "stages",
    "task",
    "workspace",
    ...(harness.developmentRuns > 0 ? (["development"] as const) : []),
    ...(harness.notesPack ? (["notes"] as const) : []),
  ];
}

export function isHarnessId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64
  );
}

export function assertHarnessDefinition(value: unknown): asserts value is HarnessDefinition {
  if (!isRecord(value) || !isHarnessId(value.id)) fail("harness ID");
  assertExactRecordKeys(
    value,
    [
      "id",
      "title",
      "systemPrompt",
      "promptTemplate",
      "tools",
      "developmentRuns",
      "maxTurns",
      "reasoning",
      "notesPack",
      "compaction",
      ...(Object.hasOwn(value, "verifyLint") ? ["verifyLint"] : []),
    ],
    "harness fields",
  );
  if (
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title !== value.title.trim() ||
    value.title.length > MAX_HARNESS_TITLE_CHARS
  )
    fail("harness title");
  for (const field of ["systemPrompt", "promptTemplate"] as const)
    if (!isText(value[field]) || value[field].length > MAX_HARNESS_TEXT_CHARS)
      fail(`harness ${field}`);
  if (
    typeof value.maxTurns !== "number" ||
    !Number.isSafeInteger(value.maxTurns) ||
    value.maxTurns < 1 ||
    value.maxTurns > MAX_HARNESS_TURNS
  )
    fail("harness maxTurns");
  if (
    typeof value.developmentRuns !== "number" ||
    !Number.isSafeInteger(value.developmentRuns) ||
    value.developmentRuns < 0 ||
    value.developmentRuns > MAX_HARNESS_DEVELOPMENT_RUNS
  )
    fail("harness developmentRuns");
  if (value.notesPack !== null) {
    if (!isRecord(value.notesPack)) fail("harness notes pack");
    assertExactRecordKeys(value.notesPack, ["id", "hash"], "harness notes pack fields");
    if (
      !isHarnessId(value.notesPack.id) ||
      typeof value.notesPack.hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.notesPack.hash)
    )
      fail("harness notes pack");
  }
  assertHarnessTools(value.tools, value.developmentRuns > 0, value.notesPack !== null);
  if (Object.hasOwn(value, "verifyLint"))
    assertHarnessVerifyLint(value.verifyLint, value.tools as BuilderToolName[]);
  assertHarnessReasoning(value.reasoning);
  assertHarnessCompaction(value.compaction);
  assertPromptTemplate(
    value.promptTemplate as string,
    requiredPromptSlots({
      developmentRuns: value.developmentRuns,
      notesPack: value.notesPack as HarnessDefinition["notesPack"],
    }),
  );
}

function assertHarnessTools(value: unknown, development: boolean, notes: boolean) {
  if (!Array.isArray(value)) fail("harness tools");
  let previous = -1;
  for (const name of value) {
    const index = BUILDER_TOOL_NAMES.indexOf(name as BuilderToolName);
    // The canonical order keeps one tool list, and thus one request hash, for one tool set.
    if (index <= previous) fail("harness tools: list known tools once, in the canonical order");
    previous = index;
  }
  const tools = new Set(value as BuilderToolName[]);
  if (
    !tools.has("workspace.list") ||
    !tools.has("workspace.finish") ||
    !(tools.has("workspace.write") || tools.has("workspace.patch"))
  )
    fail("harness tools: include workspace.list, workspace.finish and a write tool");
  if (
    [tools.has("development.run"), tools.has("development.inspect")].some(
      (has) => has !== development,
    )
  )
    fail("harness tools: list both development tools only when the harness has development runs");
  if ([tools.has("notes.list"), tools.has("notes.read")].some((has) => has !== notes))
    fail("harness tools: list both notes tools only when the harness has an API notes pack");
}

function assertHarnessVerifyLint(value: unknown, tools: BuilderToolName[]) {
  if (!isRecord(value)) fail("harness verifyLint");
  assertExactRecordKeys(value, ["codes"], "harness verifyLint fields");
  if (!Array.isArray(value.codes) || value.codes.length === 0)
    fail("harness verifyLint: list one or more lint codes");
  let previous = -1;
  for (const code of value.codes) {
    const index = SOURCE_LINT_CODES.indexOf(code as SourceLintCode);
    // The canonical order keeps one list, and thus one harness hash, for one set of codes.
    if (index <= previous)
      fail("harness verifyLint: list known lint codes once, in the canonical order");
    previous = index;
  }
  if (!tools.includes("workspace.verify"))
    fail("harness verifyLint: include workspace.verify, which reports the lint findings");
}

function assertHarnessReasoning(value: unknown) {
  if (!isRecord(value)) fail("harness reasoning");
  if (value.kind === "catalog_balanced" || value.kind === "provider_default") {
    assertExactRecordKeys(value, ["kind"], "harness reasoning fields");
    return;
  }
  if (value.kind !== "effort") fail("harness reasoning");
  assertExactRecordKeys(value, ["kind", "effort"], "harness reasoning fields");
  if (!(REASONING_EFFORTS as readonly unknown[]).includes(value.effort))
    fail("harness reasoning effort");
}

function assertHarnessCompaction(value: unknown) {
  if (!isRecord(value)) fail("harness compaction");
  if (value.kind === "none") {
    assertExactRecordKeys(value, ["kind"], "harness compaction fields");
    return;
  }
  if (value.kind !== "summarize_at") fail("harness compaction");
  assertExactRecordKeys(value, ["kind", "atBytes", "maxSummaries"], "harness compaction fields");
  if (
    typeof value.atBytes !== "number" ||
    !Number.isSafeInteger(value.atBytes) ||
    value.atBytes < MIN_COMPACTION_BYTES ||
    value.atBytes > MAX_COMPACTION_BYTES ||
    typeof value.maxSummaries !== "number" ||
    !Number.isSafeInteger(value.maxSummaries) ||
    value.maxSummaries < 1 ||
    value.maxSummaries > MAX_HARNESS_SUMMARIES
  )
    fail("harness compaction limits");
}

function assertPromptTemplate(template: string, required: HarnessPromptSlot[]) {
  const counts = new Map<string, number>();
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/gu))
    counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  for (const slot of counts.keys())
    if (!required.includes(slot as HarnessPromptSlot))
      fail(`harness prompt template: {{${slot.slice(0, 40)}}} is not a slot of this harness`);
  for (const slot of required)
    if (counts.get(slot) !== 1) fail(`harness prompt template: include {{${slot}}} one time`);
  if (/\{\{|\}\}/u.test(template.replace(/\{\{[a-z]+\}\}/gu, "")))
    fail("harness prompt template: unmatched braces");
}

/** One short line about what the builder model can do with a tool set. */
export function harnessSummary(harness: HarnessDefinition): string {
  return [
    harness.developmentRuns > 0
      ? "Edits code and can play the game in Studio"
      : "Edits code and runs quick local checks",
    ...(harness.notesPack ? ["reads API notes"] : []),
    ...(harness.verifyLint ? ["gets code analysis"] : []),
  ].join(", ");
}

/** The read-only settings of a tool set, as label and value rows for the run setup. */
export function harnessSettingRows(
  harness: HarnessDefinition,
): Array<{ label: string; value: string }> {
  const reasoning = harness.reasoning;
  const compaction = harness.compaction;
  return [
    { label: "Tools", value: harness.tools.join(", ") },
    {
      label: "Development runs in Studio",
      value: harness.developmentRuns === 0 ? "None" : String(harness.developmentRuns),
    },
    { label: "Turn limit", value: String(harness.maxTurns) },
    {
      label: "Reasoning effort",
      value:
        reasoning.kind === "catalog_balanced"
          ? "Balanced for each model"
          : reasoning.kind === "provider_default"
            ? "Provider default"
            : reasoning.effort[0]!.toUpperCase() + reasoning.effort.slice(1),
    },
    { label: "API notes", value: harness.notesPack ? harness.notesPack.id : "None" },
    {
      label: "Code analysis",
      value: harness.verifyLint
        ? `With each local check: ${harness.verifyLint.codes.join(", ")}`
        : "None",
    },
    {
      label: "Context summaries",
      value:
        compaction.kind === "none"
          ? "None. The build stops at the context limit"
          : `After ${Math.round(compaction.atBytes / 1024)} KiB, up to ${compaction.maxSummaries} ${compaction.maxSummaries === 1 ? "time" : "times"}`,
    },
  ];
}
