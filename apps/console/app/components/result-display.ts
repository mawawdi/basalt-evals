import type { ResultSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import type { EvidenceClass } from "../../../../dist/packages/contracts/src/index.js";
import { formatMoney } from "./api";
import { elapsedDuration } from "../../../../dist/packages/contracts/src/display.js";
import type { OutcomeCause } from "../../../../dist/packages/contracts/src/failure.js";

/** A count with its noun: "1 observation", "3 observations". */
export function counted(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// outcomeCount() gives the met and scored answers, and outcomeAvailability() gives the rest
// on the line below it, so each count shows one time.
export function outcomeCount(counts: ResultSummary["functional"]) {
  if (!counts.planned) return "No criteria";
  if (counts.scored === counts.planned)
    return counted(counts.scored, "criterion scored", "criteria scored");
  return `${counts.met} / ${counts.planned} met${counts.scored ? ` · ${counts.scored} scored` : ""}`;
}

type Ordered = { evaluationTitle: string; evaluationId: string; candidateTitle: string };
/** The order of the results table: by evaluation, then by build number. The evidence view and
 * the build keys use the same order. */
export function evaluationOrder(a: Ordered, b: Ordered) {
  return (
    a.evaluationTitle.localeCompare(b.evaluationTitle) ||
    a.evaluationId.localeCompare(b.evaluationId)
  );
}
export function buildOrder(a: Ordered, b: Ordered) {
  return (
    evaluationOrder(a, b) ||
    a.candidateTitle.localeCompare(b.candidateTitle, undefined, { numeric: true })
  );
}
/** Counts joined by " · ". A count of three words or fewer stays on one line, so a narrow
 * column never shows "2 not" above "met". A longer count keeps its number with the next word and
 * its last two words together, so it breaks between words and never inside "evidence". */
export function countList(parts: Array<string | false>) {
  return parts
    .filter((part): part is string => !!part)
    .map((part) => {
      const words = part.split(" ");
      if (words.length <= 3) return words.join("\u00a0");
      return [
        words.slice(0, 2).join("\u00a0"),
        ...words.slice(2, -2),
        words.slice(-2).join("\u00a0"),
      ].join(" ");
    })
    .join(" · ");
}
export function outcomeAvailability(counts: ResultSummary["functional"], active = false) {
  if (!counts.planned) return "Not included in this evaluation";
  // Split and not enough evidence are answers, but neither is met nor not met.
  const rest = countList([
    counts.rejected > 0 && `${counts.rejected} not met`,
    counts.split > 0 && `${counts.split} split`,
    counts.insufficient > 0 && `${counts.insufficient} not enough evidence`,
    counts.unavailable > 0 &&
      `${counts.unavailable} ${counts.unavailable === 1 ? "answer" : "answers"} ${active ? "pending" : "unavailable"}`,
  ]);
  if (rest) return rest;
  return counts.scored ? "Scores only, no pass mark" : "All criteria met";
}

export function observationLabel(capture: ResultSummary["captures"][number], active = false) {
  if (capture.state === "planned") return "Not recorded yet";
  if (capture.state === "collecting") return "Recording";
  if (capture.state === "incomplete") return "Not fully recorded";
  if (!capture.planned) return "No checks planned";
  if (capture.unavailable) return active ? "Checking" : "Unavailable";
  if (capture.rejected) return "Not met";
  if (capture.split) return "Split";
  if (capture.insufficient) return "Not enough evidence";
  if (capture.scored) return "Scored";
  return "All met";
}

/**
 * The combined answer of the judge samples of one check: "Met 3 of 3" or "Split: 2 of 3 met".
 * One sample has no combined answer to show.
 */
export function sampledAnswer(
  samples: {
    answer: "met" | "not_met" | "split" | "scored" | "insufficient" | "missing";
    met: number;
    of: number;
  } | null,
) {
  if (!samples || samples.of < 2) return null;
  const { met, of } = samples;
  return {
    met: `Met ${met} of ${of}`,
    not_met: `Not met ${of} of ${of}`,
    split: `Split: ${met} of ${of} met`,
    scored: `Scored ${of} of ${of}`,
    insufficient: `Not enough evidence: ${met} of ${of} met`,
    missing: `Unavailable: ${met} of ${of} met`,
  }[samples.answer];
}

/**
 * The models of a run in words. Before a run freezes its models, its summary holds registry
 * IDs, so the registry names them.
 */
export function modelList(models: string[], names: Record<string, string>) {
  return models.map((model) => names[model] ?? model).join(", ");
}

/** The badge for a check whose build output contains text aimed at the judge. */
export const ADDRESSED_TO_JUDGE = "Text addressed to the judge";
export function addressedToJudge(value: { found: boolean } | null | undefined) {
  return value?.found ? ADDRESSED_TO_JUDGE : null;
}

export function buildStateLabel(state: ResultSummary["buildState"], kind?: ResultSummary["kind"]) {
  if (kind === "retained" || kind === "control")
    return {
      planned: "Saved build pending",
      running: "Loading saved build",
      ready: "Saved build ready",
      incomplete: "Saved build unavailable",
      not_reached: "Not reached",
    }[state];
  return {
    planned: "Build planned",
    running: "Building",
    ready: "Build available",
    incomplete: "Build incomplete",
    not_reached: "Not reached",
  }[state];
}

export function buildCostLabel(build: ResultSummary) {
  if (build.kind === "retained" || build.kind === "control") return "No new build";
  if (build.buildState === "planned" || build.buildState === "not_reached") return "Not started";
  if (build.costUsd === null) return build.buildState === "running" ? "Pending" : "Unavailable";
  return formatMoney(build.costUsd);
}

export function buildTimeLabel(build: ResultSummary) {
  if (build.kind === "retained" || build.kind === "control") return "Reused build";
  if (build.buildState === "planned" || build.buildState === "not_reached") return "Not started";
  if (build.elapsedMs === null)
    return build.buildState === "running" ? "In progress" : "Unavailable";
  return elapsedDuration(build.elapsedMs);
}

/** Presentation only: an authored list marker is Markdown syntax, not part of the criterion. */
export function statementText(statement: string) {
  return statement.trim().replace(/^(?:[-*+] |\d+[.)] )/u, "");
}

/** Journal stages and transitions in the words the Progress timeline uses. */
const stageNames: Record<string, string> = {
  preparation: "Preparing tests",
  controls: "Reference checks",
  explanation: "Explaining failures",
  builder: "Building",
  local_verification: "Quick local check",
  public_development: "Extra observation",
  seal: "Saving the build",
  review: "Review",
  selection: "Choosing builds",
  final_capture: "Collecting evidence",
  grading: "Code checks",
  judgment: "Judge checks",
  repair: "Repair attempt",
  report: "Results summary",
};
const transitionNames: Record<string, string> = {
  started: "started",
  completed: "finished",
  failed: "failed",
  incomplete: "did not finish",
  paused: "paused",
  provider_paused: "paused by the provider",
  not_dispatched: "not sent",
  stop_requested: "stop requested",
  resumed: "resumed",
};
export function stageLabel(stage: string) {
  return stageNames[stage] ?? stage.replaceAll("_", " ");
}
export function transitionLabel(stage: string | null, kind: string, reason?: string | null) {
  // A build whose stage gate failed was never due, so "not sent" would read as a fault.
  const transition =
    kind === "not_dispatched" && reason === "stage_not_reached"
      ? "not reached"
      : (transitionNames[kind] ?? kind.replaceAll("_", " "));
  return `${stage ? stageLabel(stage) : "Run"} ${transition}`;
}

/** A short name for each recorded cause of work that did not finish. */
const causeNames: Record<OutcomeCause, string> = {
  provider_or_transport_failure: "Model provider error",
  environment_failure: "Studio or setup problem",
  budget_or_stop_failure: "Stopped or reached a limit",
  harness_context_failure: "Conversation too long",
  harness_feedback_failure: "Feedback not returned to the model",
  task_spec_failure: "Evaluation couldn’t be done as written",
  grader_failure: "Check couldn’t answer",
  evidence_incomplete: "Evidence not recorded",
  workspace_or_security_failure: "Edit outside the workspace",
  model_refusal: "Model refused",
  model_tool_use_failure: "Tool calls refused",
  model_reasoning_failure: "Model stopped early",
  static_or_luau_failure: "Failed basic code checks",
  studio_mutation_failure: "Studio couldn’t apply the build",
  engine_runtime_failure: "Failed while the game ran",
  visual_or_interaction_failure: "Didn’t look or behave as required",
  human_product_rejection: "Rejected by a reviewer",
  unclassified: "No recorded cause",
};
export function causeLabel(cause: OutcomeCause) {
  return causeNames[cause];
}
const unitNouns: Record<string, [string, string]> = {
  builder: ["build", "builds"],
  repair: ["repair build", "repair builds"],
  public_development: ["development run", "development runs"],
  final_capture: ["observation", "observations"],
  judgment: ["judge check", "judge checks"],
  grading: ["code check", "code checks"],
  preparation: ["preparation step", "preparation steps"],
  controls: ["reference test", "reference tests"],
};
/** The units of one cause in words, for example "1 build · 2 observations". */
export function causeUnitsText(units: ReadonlyArray<{ stage: string }>) {
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.stage, (counts.get(unit.stage) ?? 0) + 1);
  return countList(
    [...counts].map(([stage, count]) => {
      const [one, many] = unitNouns[stage] ?? ["step", "steps"];
      return `${count} ${count === 1 ? one : many}`;
    }),
  );
}

const phaseNames: Record<string, string> = {
  authoring: "Preparing inputs",
  preparation: "Preparing tests",
  readiness: "Checking Studio",
  controls: "Reference checks",
  explanation: "Explaining failures",
  execution: "Building and checking",
  complete: "Finished",
  assessment: "Rechecking saved evidence",
};
/** A run's saved phase in the words Progress uses. */
export function phaseLabel(phase: string) {
  const text = phaseNames[phase] ?? phase.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a run list says about a run: its problem, where it is, or that it finished. */
export function runDetail(run: { state: string; phase: string; blocker: string | null }) {
  if (run.blocker) return problemSummary(run.blocker);
  return run.state === "complete" || run.state === "partial" ? "Finished" : phaseLabel(run.phase);
}

/** Recorded run problems in plain words, most specific first. The run page keeps the exact text. */
const problemPhrases: Array<[RegExp, string]> = [
  [
    /Basalt connector that Studio loads[^.]*not the current version/iu,
    "The Basalt connector in Studio is out of date. Install the current connector and start the run again.",
  ],
  [
    /\bENOENT\b[^]*authoring\/revisions\//u,
    "Basalt cannot find a saved version of a selected evaluation on this Mac. Choose the evaluations again, or reset the setup.",
  ],
  [/\bENOENT\b|no such file/iu, "Basalt cannot find a file that this run needs."],
  [/\bE(?:ACCES|PERM)\b|permission denied/iu, "Basalt could not open a file that this run needs."],
  [
    /\bhttp_429\b|\bHTTP 429\b/iu,
    "The model provider limited requests, so some work did not finish.",
  ],
  [
    /\bhttp_5\d\d\b|\bHTTP 5\d\d\b/iu,
    "The model provider had a server error, so some work did not finish.",
  ],
  [
    /\bhttp_40[13]\b|\bHTTP 40[13]\b/iu,
    "The model provider did not accept the API key. Check Settings.",
  ],
  [
    /does not match its saved request|do not match the provider response that Basalt saved|Retained model result changed/u,
    "This run’s saved answers no longer match the requests that produced them, usually because Basalt changed after the run. Nothing was deleted. Start a new run to get results that Basalt can check.",
  ],
  [
    /SpendingCeilingError|Spending ceiling prevents another model call/u,
    "The run reached its spending limit before the next request. Increase the spending limit to continue, or stop the run.",
  ],
  [
    /Scenario players did not join/iu,
    "The test players didn’t join the Studio game in time, so Studio couldn’t record the observation.",
  ],
  [/Studio[^.]*timed out/iu, "Studio took too long to respond."],
  [/timed out/iu, "A step took too long to respond."],
  [/Studio failed the readiness check/iu, "Studio was not ready, so no paid work started."],
  [
    /did not give exactly one answer for each criterion/iu,
    "The judge did not answer some criteria.",
  ],
  [
    /judge (?:did not call|called|wrote text that is not)/iu,
    "The judge did not give its answer in the required form.",
  ],
  [
    /score for a criterion that has no score scale/iu,
    "The judge gave a score, but the criterion needs a yes-or-no answer.",
  ],
  [
    /reference test of this evaluation used a different Basalt/iu,
    "The saved reference checks used a different setup, so Basalt cannot use them again.",
  ],
  [/native control evidence is incomplete/iu, "Studio did not finish the reference checks."],
  [/judge returned no answer/iu, "The judge model did not give an answer."],
  [/has work that did not complete/iu, "Some work did not finish."],
];
/** A failure recorded only by its classification code, in words. */
const failureClasses: Record<string, string> = {
  task_spec_failure: "The model could not do the evaluation as written.",
  model_reasoning_failure: "The model stopped before it finished a build.",
  model_refusal: "The model refused the task, so the build is incomplete.",
  judge_refusal: "The judge refused to answer, so these checks are incomplete.",
  model_tool_use_failure: "Basalt refused the model’s tool calls, so the build stopped.",
  harness_context_failure: "The conversation with the model grew too long.",
  harness_feedback_failure: "Basalt could not return feedback to the model.",
  budget_or_stop_failure:
    "Basalt stopped the build, or the build reached a spending limit or a length limit.",
  provider_or_transport_failure:
    "The model provider returned an error, or Basalt could not connect to it.",
  workspace_or_security_failure: "The model tried to change files outside its workspace.",
  static_or_luau_failure: "The build’s code did not pass basic checks.",
  studio_mutation_failure: "Studio could not apply the build.",
  engine_runtime_failure: "The build failed while the game ran.",
  visual_or_interaction_failure: "The build did not look or behave as required.",
  grader_failure: "Basalt could not check the results.",
  environment_failure: "Something in the local setup failed.",
  evidence_incomplete: "Basalt did not collect all of the evidence.",
  human_product_rejection: "A reviewer rejected the build.",
  unknown: "Basalt did not record the cause.",
  stage_not_reached: "An earlier build didn’t pass its stage gate, so this build never started.",
};
// Paths, error class names and status codes mark text written for logs, not people.
// A path, an error class, a code, several lines or a source location such as "ScenarioRunner:66"
// marks text that only a developer reads.
const technical =
  /(?:^|[\s'"(])\/[\w.@~-]+\/|\b[A-Z]\w*(?:Error|Fault|Exception)\b|\b[a-z]+_\d{3}\b|\bE[A-Z]{3,}\b|\n|\b[A-Za-z_]\w*:\d+\b/u;
export function problemSummary(text: string) {
  const code = failureClasses[text.trim()];
  if (code) return code;
  const match = problemPhrases.find(([pattern]) => pattern.test(text));
  if (match) return match[1];
  const plain = text.charAt(0).toUpperCase() + text.slice(1);
  if (!technical.test(plain)) return plain;
  return `${plain.split(/:\s|\.\s/u)[0].replace(/\.$/u, "")}.`;
}

/**
 * Code check explanations that use the words of the grader, in plain words. The stored result
 * keeps the grader text, because Basalt checks it against the hash of the result.
 */
const checkExplanations: Record<string, string> = {
  "Scenario measurement changed within the frozen range":
    "The measured change was within the expected range.",
  "Scenario measurement changed outside the frozen range":
    "The measured change was outside the expected range.",
  "Studio measurement is within the frozen range":
    "The measured value was within the expected range.",
  "Studio measurement is outside the frozen range":
    "The measured value was outside the expected range.",
  "Studio fact matched the hidden expectation": "The recorded value matched the expected value.",
  "Studio fact did not match the hidden expectation":
    "The recorded value didn’t match the expected value.",
  "Studio text contains the frozen literal": "The recorded text contains the expected text.",
  "Studio text does not contain the frozen literal":
    "The recorded text doesn’t contain the expected text.",
  "Studio reported output errors or script errors; this rule does not attribute their cause":
    "Studio reported errors while the game ran. This check doesn’t show which code caused them.",
  "Studio reported no diagnostics": "Studio reported no errors while the game ran.",
};
export function checkExplanation(text: string) {
  return checkExplanations[text] ?? text;
}
function shownValue(value: string | number | boolean | null) {
  if (value === null) return "nothing";
  if (typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  if (typeof value === "string")
    return value.startsWith("sha256:") ? "a text too long to show" : `“${value}”`;
  return String(value);
}
/**
 * The Studio values that a code check read, in words. A step rule names its time in its own
 * explanation, so it has no separate line.
 */
export function observedValues(
  explanation: string,
  observed: Array<string | number | boolean | null> | null,
) {
  if (!observed?.length || /^(?:First sighting|The runner looked)/u.test(explanation)) return null;
  const [first, second] = observed;
  if (/^Scenario measurement changed/u.test(explanation) && observed.length === 2) {
    const change =
      typeof first === "number" && typeof second === "number"
        ? `, a change of ${shownValue(second - first)}`
        : "";
    return `Recorded: ${shownValue(first!)} before and ${shownValue(second!)} after${change}.`;
  }
  if (/^Studio reported/u.test(explanation) && observed.length === 2)
    return `Studio recorded ${counted(Number(first), "output error")} and ${counted(Number(second), "script error")}.`;
  return observed.length === 1
    ? `Recorded value: ${shownValue(first!)}.`
    : `Recorded values: ${observed.map(shownValue).join(", ")}.`;
}

const presentationNames: Record<string, string> = {
  still: "still images",
  sequence: "recorded sequence",
  "grounded-sequence": "sequence notes",
  "criterion evidence": "code and recorded behavior",
  "authored source and rendered evidence": "code, recorded behavior and images",
};
/** The evidence class that the author of a criterion set, as a heading. */
export const evidenceClassNames: Record<EvidenceClass, string> = {
  appearance: "Appearance",
  timing: "Timing",
  motion: "Motion",
  causality: "Causality",
};
/**
 * The kinds of check of one criterion, with the evidence class of its judge checks, for example
 * "Judge check · Timing" or "Code check".
 */
export function checkKind(
  cells: ReadonlyArray<{ method: "deterministic" | "visual"; evidenceClass: EvidenceClass | null }>,
): string {
  const code = cells.some((cell) => cell.method === "deterministic");
  const judged = cells.some((cell) => cell.method === "visual");
  const classes = [
    ...new Set(
      cells.flatMap((cell) =>
        cell.method === "visual" && cell.evidenceClass
          ? [evidenceClassNames[cell.evidenceClass]]
          : [],
      ),
    ),
  ];
  const kinds = code && judged ? "Code check and judge check" : code ? "Code check" : "Judge check";
  return classes.length ? `${kinds} · ${classes.join(", ")}` : kinds;
}
/**
 * What the judge reads for a criterion of each evidence class. The compiler gives images only to
 * an appearance criterion. The other classes need recorded facts.
 */
export const judgeReads: Record<EvidenceClass, string> = {
  appearance: "The judge reads images.",
  timing: "The judge reads recorded behavior, not images.",
  motion: "The judge reads recorded behavior, not images.",
  causality: "The judge reads recorded behavior, not images.",
};
/** What the checker was shown under each evidence condition, as a column or choice name. */
export const evidenceConditionNames: Record<string, string> = {
  original: "As recorded",
  blank: "Blank images",
  facts_and_source: "Behavior and code only",
  text_only: "Prompt and criteria only",
  region_removed: "Region removed",
  region_sham: "Sham region removed",
  region_black: "Region in black",
  donor_swap: "Swapped images",
  unrelated: "Unrelated images",
  reversed: "Reversed frames",
  shuffled: "Shuffled frames",
  phase_shuffled: "Shuffled within phases",
  repeated_frame: "One frame repeated",
  canary: "Note to the judge",
};
/** The question that each kind of control asks, as a column value. */
export const controlLevelNames: Record<string, string> = {
  dependence: "Uses the evidence",
  localization: "Uses the region",
  direction: "Follows the images",
  order: "Uses the order",
  text: "Follows scene text",
};
/** The deliberate substitute an answer judged, or null for the original evidence. */
export function testConditionLabel(condition: string) {
  return condition === "original"
    ? null
    : (evidenceConditionNames[condition] ?? condition.replaceAll("_", " ")).toLowerCase();
}
/** A checker's answer to one criterion in plain words, with the tone it is shown in. */
export function decisionAnswer(
  decision:
    { verdict: "satisfied" | "violated" | "insufficient"; score: number | null } | undefined,
  answered: boolean,
): { text: string; tone: "neutral" | "good" | "warning" | "bad" } {
  if (!decision) return { text: answered ? "No answer" : "Not checked yet", tone: "neutral" };
  if (decision.score !== null) return { text: `Score ${decision.score}`, tone: "neutral" };
  return decision.verdict === "satisfied"
    ? { text: "Met", tone: "good" }
    : decision.verdict === "violated"
      ? { text: "Not met", tone: "bad" }
      : { text: "Not enough evidence", tone: "warning" };
}
/** A judging setup in plain words: "MiMo 2.6 Flash with still images". */
export function judgingSetup(model: string, presentation: string) {
  return `${model} with ${presentationNames[presentation] ?? presentation}`;
}
/** A checker in plain words: the judging model, what it sees, and any test condition. */
export function checkerLabel(treatment: {
  label: string;
  presentation: string;
  evidenceCondition: string;
}) {
  const end = treatment.label.lastIndexOf(` · ${treatment.presentation} · `);
  const model = end < 0 ? treatment.label : treatment.label.slice(0, end);
  const seen = presentationNames[treatment.presentation] ?? treatment.presentation;
  const condition = testConditionLabel(treatment.evidenceCondition);
  return `${model} · judges ${seen}${condition ? ` · ${condition}` : ""}`;
}

/** Why two runs can or cannot be compared, in plain words; unknown reasons keep their text. */
const comparisonPhrases: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [
    /^Both runs used the same saved evidence/u,
    () =>
      "Both runs checked the same saved evidence, so the differences come from the judge, not from new builds.",
  ],
  [
    /^The runs used the same builder models/u,
    () =>
      "The runs used the same evaluation, judge and way of recording evidence. Each run made its own builds, so the builds don’t pair up one to one.",
  ],
  [
    /^The runs used different builder models or tools/u,
    () =>
      "The runs tested different models with the same evaluation, judge and way of recording evidence. The builds don’t pair up one to one.",
  ],
  [
    /^The judge and the evidence differ between the runs/u,
    () =>
      "The judge and the recorded evidence both differ, so you cannot credit the differences to the tested model alone.",
  ],
  [
    /^The runs planned different numbers of checks/u,
    () =>
      "The runs planned different numbers of checks, so each run is counted out of its own total.",
  ],
  [
    /^The runs checked different parts of the saved evidence/u,
    () => "The runs checked different parts of the saved evidence.",
  ],
  [
    /^The evaluations or criteria differ between the runs/u,
    () =>
      "The evaluations or success criteria differ, so compare only the criteria that both runs share.",
  ],
  [
    /^The runs used different settings to record evidence/u,
    () => "The runs recorded evidence differently.",
  ],
  [
    /^Basalt did not fully record the builder environment or the provider transport/u,
    () =>
      "Basalt did not fully record the build setup, so it cannot confirm that the setup is the same.",
  ],
  [
    /^The builder environment or the provider transport differs between the runs/u,
    () => "The build setup differs. Each run’s details show what Basalt recorded.",
  ],
  [
    /^Basalt did not record the (Basalt code version|compiled Basalt code|Basalt connector version) for both runs/u,
    (match) =>
      `Basalt did not record the ${match[1]} for both runs, so it cannot tell whether it changed.`,
  ],
  [
    /^The (Basalt code version|compiled Basalt code|Basalt connector version) differs between the runs:/u,
    (match) => `The ${match[1]} differs between the runs.`,
  ],
];
export function comparisonReason(text: string) {
  for (const [pattern, phrase] of comparisonPhrases) {
    const match = text.match(pattern);
    if (match) return phrase(match);
  }
  return text;
}
/** A recorded checker description ("Model · still · original evidence") in plain words. */
export function checkerStream(text: string) {
  const match = text.match(/^(.+) · (still|sequence|grounded-sequence) · (.+)$/u);
  if (!match) return text;
  const [, model, presentation, evidence] = match;
  const kept = /^(?:original|retained) evidence$/u.test(evidence!) ? "" : ` · ${evidence}`;
  return `${model} · judges ${presentationNames[presentation!]}${kept}`;
}
