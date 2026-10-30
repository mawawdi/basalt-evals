import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { walkRegularTree } from "../../artifact-store/src/inventory.js";
import { promisify } from "node:util";
import {
  MAX_CANDIDATE_BYTES,
  MAX_CAPTURE_BYTES,
  assertCandidateManifest,
  assertEvaluatorSpec,
  assertPublicTask,
  assertStudioEvidence,
  boundStudioObservation,
  contentHash,
  deterministicObservationBindings,
  identifiedRolePaths,
  observedValue,
  studioIdentityIssue,
  hashJson,
  stableJson,
  type CandidateManifest,
  type CriterionResult,
  type DeterministicCriterion,
  type EvaluatorSpec,
  type JsonPrimitive,
  type PublicTask,
  type ScriptDiagnostic,
  type StudioCollectionPlan,
  type StudioEvidence,
  type StudioObservation,
  type StudioObservationBinding,
} from "../../contracts/src/index.js";
import { DIAGNOSTIC_CHANNEL_LIMIT, type SourceLintCode } from "../../contracts/src/capabilities.js";
import { assertSourceAnalysis, type SourceAnalysis } from "../../contracts/src/source-analysis.js";
import type { LocalVerification } from "../../agent-runtime/src/index.js";
import { classifyBarrierTrajectory } from "./barrier.js";
import { checkGuiLayout } from "./gui-layout.js";
import { checkExposure, checkTextContrast, layoutIssue, type Raster } from "./frame-measures.js";
import { checkPerformance } from "./performance.js";
import { decodeCaptureImage } from "../../studio-runner/src/images.js";
import { buildScriptPaths, evidenceActorNames, originFromPaths } from "./script-origin.js";
import { stepRequirementOutcome } from "./step-requirement.js";
import { isRecord } from "../../contracts/src/validation.js";

const execFile = promisify(execFileCallback);
const EXECUTION_OPTIONS = { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;

export async function verifyCandidateLocally(
  workspaceRoot: string,
  task: PublicTask,
): Promise<LocalVerification> {
  assertPublicTask(task);
  const root = resolve(workspaceRoot);
  const checks: LocalVerification["checks"] = [];
  const reasons: string[] = [];
  let project: unknown;
  try {
    const projectFile = within(root, task.seed.projectFile);
    const info = await lstat(projectFile);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("project file is not regular");
    project = JSON.parse(
      (await readRegularFile(projectFile, MAX_PROJECT_BYTES, "project file")).toString("utf8"),
    ) as unknown;
    if (!isRecord(project) || !isRecord(project.tree)) throw new Error("project file has no tree");
    checks.push({ name: "project_json", outcome: "pass" });
  } catch (error) {
    checks.push({ name: "project_json", outcome: "fail" });
    reasons.push(`Project JSON: ${message(error)}`);
  }

  const sources = await collectSources(root, task.seed.sourceRoots).catch((error: unknown) => {
    reasons.push(`Source inventory: ${message(error)}`);
    return null;
  });
  if (sources === null || sources.length === 0) {
    checks.push({ name: "luau_parse", outcome: "fail" });
    if (sources?.length === 0) reasons.push("No Luau source exists in the declared roots");
  } else {
    const parse = await runTool("luau-compile", ["--only-parse", ...sources], root);
    checks.push({ name: "luau_parse", outcome: parse.outcome });
    if (parse.detail) reasons.push(`Luau parse: ${parse.detail}`);
  }

  const temporary = await mkdtemp(join(tmpdir(), "basalt-evals-rojo-"));
  try {
    const output = join(temporary, "candidate.rbxlx");
    const build = await runTool("rojo", ["build", task.seed.projectFile, "-o", output], root);
    checks.push({ name: "rojo_build", outcome: build.outcome });
    if (build.detail) reasons.push(`Rojo build: ${build.detail}`);
    if (build.outcome === "pass") await access(output);
  } catch (error) {
    checks.push({ name: "rojo_output", outcome: "fail" });
    reasons.push(`Rojo output: ${message(error)}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const hasFailure = checks.some((check) => check.outcome === "fail");
  const hasUnavailable = checks.some((check) => check.outcome === "unavailable");
  return {
    gate: hasFailure ? "rejected" : hasUnavailable ? "incomplete" : "eligible",
    reasons,
    checks,
  };
}

/**
 * Grade authored controls without inventing an AgentRun or a model treatment. `analysis` is the
 * source analysis of the same build. A rule that reads it is incomplete without it.
 * `evidenceDirectory` holds `evidence.json` and its capture files. A rule that reads the pixels
 * of a capture is incomplete without it.
 */
export async function evaluateDeterministicCriteria(input: {
  workspaceRoot: string;
  evaluator: EvaluatorSpec;
  candidate: CandidateManifest;
  treatmentId: string;
  evidence?: StudioEvidence;
  analysis?: SourceAnalysis | undefined;
  evidenceDirectory?: string | undefined;
}): Promise<CriterionResult[]> {
  assertEvaluatorSpec(input.evaluator);
  assertCandidateManifest(input.candidate);
  await assertCandidateWorkspace(input.workspaceRoot, input.candidate);
  if (input.analysis) {
    assertSourceAnalysis(input.analysis);
    if (input.analysis.candidateHash !== input.candidate.rootHash)
      throw new Error("Source analysis binding mismatch");
  }
  if (input.evidence) {
    assertStudioEvidence(input.evidence);
    if (
      input.evidence.candidateHash !== input.candidate.rootHash ||
      input.evidence.treatmentId !== input.treatmentId ||
      input.evidence.collectionPlanHash !== hashJson(input.evaluator.studio)
    )
      throw new Error("Studio evidence binding mismatch");
  }
  const criteria: CriterionResult[] = [];
  const identified = input.evidence
    ? identifiedRolePaths(input.evaluator.studio, input.evidence)
    : new Set<string>();
  for (const criterion of input.evaluator.deterministic) {
    const issues = input.evidence
      ? deterministicObservationBindings(criterion.rule).flatMap((binding) => {
          const observation = boundStudioObservation(input.evidence!, binding);
          if (observation && missingRequiredRole(observation, criterion.rule)) return [];
          const issue = studioIdentityIssue(
            input.evaluator.studio,
            binding,
            observation,
            identified,
          );
          return issue ? [{ issue, observation }] : [];
        })
      : [];
    criteria.push(
      issues.length
        ? result(
            criterion,
            "incomplete",
            issues.map((item) => item.issue).join("; "),
            issues.map((item) => hashJson(item.observation)),
          )
        : await evaluateDeterministic(
            input.workspaceRoot,
            criterion,
            input.evidence,
            input.evaluator.studio,
            input.analysis,
            input.evidenceDirectory,
          ),
    );
  }
  return criteria;
}

async function evaluateDeterministic(
  workspaceRoot: string,
  criterion: DeterministicCriterion,
  evidence: StudioEvidence | undefined,
  plan: StudioCollectionPlan,
  analysis: SourceAnalysis | undefined,
  evidenceDirectory: string | undefined,
): Promise<CriterionResult> {
  const rule = criterion.rule;
  if (rule.kind === "source_lint_absent") return sourceLintResult(criterion, rule.codes, analysis);
  if (rule.kind === "path_exists") {
    try {
      const info = await lstat(within(resolve(workspaceRoot), rule.path));
      const passed = info.isFile() && !info.isSymbolicLink();
      return result(
        criterion,
        passed ? "verified" : "rejected",
        passed ? "Path exists" : "Path is not a regular file",
      );
    } catch (error) {
      if (isMissing(error)) return result(criterion, "rejected", "Required path is absent");
      return result(criterion, "incomplete", message(error));
    }
  }
  if (rule.kind === "source_contains") {
    try {
      const source = (
        await readRegularFile(
          within(resolve(workspaceRoot), rule.path),
          MAX_SOURCE_BYTES,
          `source ${rule.path}`,
        )
      ).toString("utf8");
      const passed = contains(source, rule.text, rule.caseSensitive);
      return result(
        criterion,
        passed ? "verified" : "rejected",
        passed
          ? "Source contains the frozen literal"
          : "Source does not contain the frozen literal",
      );
    } catch (error) {
      if (isMissing(error)) return result(criterion, "rejected", "Required source is absent");
      return result(criterion, "incomplete", message(error));
    }
  }
  if (!evidence) return result(criterion, "incomplete", "Authoritative Studio evidence is absent");
  if (rule.kind === "build_errors_absent")
    return buildErrorResult(criterion, rule.facts, evidence, analysis);
  if (rule.kind === "gui_layout_holds") {
    const fact = rule.fact;
    const observation = boundStudioObservation(evidence, fact);
    if (!observation && "scenarioId" in fact)
      return result(
        criterion,
        "incomplete",
        absentScenarioFact(evidence, fact.scenarioId, fact.context, fact.stepId),
      );
    const verdict = checkGuiLayout(
      observation?.kind === "gui_layout" ? observation : null,
      rule.check,
      rule.minimum?.value ?? null,
    );
    return result(
      criterion,
      verdict.outcome,
      verdict.reason,
      observation ? [hashJson(observation)] : [],
      verdict.counts,
    );
  }
  if (rule.kind === "performance_within") {
    const binding = {
      scenarioId: rule.scenarioId,
      stepId: rule.stepId,
      context: rule.context,
      factId: rule.factId,
    };
    const observation = boundStudioObservation(evidence, binding);
    if (!observation)
      return result(
        criterion,
        "incomplete",
        absentScenarioFact(evidence, rule.scenarioId, rule.context, rule.stepId),
      );
    const verdict = checkPerformance(
      observation.kind === "performance_trace" ? observation : null,
      plannedTraceSamples(plan, binding),
      rule.metric,
      rule.aggregate,
      rule.maximum.value,
    );
    return result(
      criterion,
      verdict.outcome,
      verdict.reason,
      [hashJson(observation)],
      verdict.observed,
    );
  }
  if (rule.kind === "capture_text_contrast" || rule.kind === "capture_exposure") {
    const capture = boundCapture(evidence, rule.phaseId, rule.captureId);
    const found =
      rule.kind === "capture_text_contrast"
        ? boundStudioObservation(evidence, { phaseId: rule.phaseId, factId: rule.layoutFactId })
        : null;
    const layout = found?.kind === "gui_layout" ? found : null;
    const hashes = [...(capture ? [capture.hash] : []), ...(found ? [hashJson(found)] : [])];
    const issue =
      (rule.kind === "capture_text_contrast" ? layoutIssue(layout) : null) ??
      (capture ? null : "Required capture is absent");
    if (issue || !capture) return result(criterion, "incomplete", issue!, hashes);
    const frame = await readCaptureFrame(evidenceDirectory, capture);
    if (typeof frame === "string") return result(criterion, "incomplete", frame, hashes);
    const verdict =
      rule.kind === "capture_text_contrast"
        ? checkTextContrast(layout, capture.sceneText, frame, rule.minimum.value)
        : checkExposure(
            frame,
            rule.measure,
            rule.minimum?.value ?? null,
            rule.maximum?.value ?? null,
          );
    return result(criterion, verdict.outcome, verdict.reason, hashes, verdict.observed);
  }
  if (rule.kind === "scenario_action_succeeded") {
    const step = scenarioStepEvidence(evidence, rule.scenarioId, rule.actor, rule.stepId);
    if (!step?.action)
      return result(criterion, "incomplete", "Required scenario action receipt is absent");
    return result(
      criterion,
      step.action.succeeded ? "verified" : "rejected",
      step.action.succeeded
        ? "The scheduled player action completed"
        : "The scheduled player action failed",
      [hashJson(step)],
      [step.action.succeeded],
    );
  }
  if (rule.kind === "scenario_barrier_passage") {
    const step = scenarioStepEvidence(evidence, rule.scenarioId, rule.actor, rule.stepId);
    if (!step?.action?.succeeded || !step.action.probe)
      return result(criterion, "incomplete", "Bound barrier trajectory is absent");
    const passage = classifyBarrierTrajectory(step.action.probe);
    return result(
      criterion,
      passage.outcome === "incomplete"
        ? "incomplete"
        : passage.outcome === rule.expected
          ? "verified"
          : "rejected",
      `${passage.detail}; expected ${rule.expected}; closest front ${passage.closestFrontStuds?.toFixed(2) ?? "—"} studs; final plane ${passage.finalPlaneStuds?.toFixed(2) ?? "—"} studs`,
      [hashJson(step.action.probe)],
      [passage.outcome],
    );
  }
  if (rule.kind === "scenario_fact_equals" || rule.kind === "scenario_fact_supports_value") {
    const found = scenarioObservationEvidence(
      evidence,
      rule.scenarioId,
      rule.context,
      rule.stepId,
      rule.factId,
    );
    if (!found)
      return result(
        criterion,
        "incomplete",
        absentScenarioFact(evidence, rule.scenarioId, rule.context, rule.stepId),
      );
    if (missingRequiredRole(found.observation, rule))
      return result(criterion, "rejected", MISSING_REQUIRED_ROLE, [hashJson(found.observation)]);
    const actual = factField(found.observation, rule.field);
    if (actual === undefined)
      return result(criterion, "incomplete", "Scenario fact does not expose the expected field");
    const passed = stableJson(actual) === stableJson(rule.expected);
    return result(
      criterion,
      passed
        ? "verified"
        : rule.kind === "scenario_fact_supports_value"
          ? "incomplete"
          : "rejected",
      passed
        ? "Scenario fact matched the hidden expectation"
        : rule.kind === "scenario_fact_supports_value"
          ? "The sampled scenario fact did not establish the expected value; no authored deadline permits a failure claim"
          : "Scenario fact did not match the hidden expectation",
      [hashJson(found)],
      [actual],
    );
  }
  if (rule.kind === "scenario_fact_equals_actor_user_id") {
    const scenario = evidence.scenarios.find((entry) => entry.scenarioId === rule.scenarioId);
    const found = scenarioObservationEvidence(
      evidence,
      rule.scenarioId,
      rule.context,
      rule.stepId,
      rule.factId,
    );
    const actor = scenario?.reports[0]?.actors.find((entry) => entry.actor === rule.actor);
    if (!found || !actor)
      return result(criterion, "incomplete", "Scenario actor identity or fact is absent");
    const actual = factField(found.observation, "value");
    if (typeof actual !== "number")
      return result(
        criterion,
        "incomplete",
        "Scenario fact does not expose a numeric actor identity",
      );
    const passed = actual === actor.userId;
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed
        ? "Authoritative state names the expected test actor"
        : "Authoritative state names a different actor",
      [hashJson(found), hashJson(actor)],
      [actual],
    );
  }
  if (rule.kind === "scenario_number_delta_in_range") {
    const from = scenarioObservationEvidence(
      evidence,
      rule.scenarioId,
      rule.context,
      rule.fromStepId,
      rule.fromFactId,
    );
    const to = scenarioObservationEvidence(
      evidence,
      rule.scenarioId,
      rule.context,
      rule.toStepId,
      rule.toFactId,
    );
    if (!from || !to)
      return result(criterion, "incomplete", "Required scenario delta facts are absent");
    const before = numericField(from.observation, rule.field);
    const after = numericField(to.observation, rule.field);
    if (before === undefined || after === undefined)
      return result(criterion, "incomplete", "Scenario facts do not expose numeric values");
    const delta = after - before;
    const passed = delta >= rule.minimum && delta <= rule.maximum;
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed
        ? "Scenario measurement changed within the frozen range"
        : "Scenario measurement changed outside the frozen range",
      [hashJson(from), hashJson(to)],
      [before, after],
    );
  }
  if (rule.kind === "scenario_cross_context_equals") {
    const found = rule.contexts.map((context) =>
      scenarioObservationEvidence(evidence, rule.scenarioId, context, rule.stepId, rule.factId),
    );
    if (found.some((entry) => !entry))
      return result(criterion, "incomplete", "Cross-client scenario facts are incomplete");
    const values = found.map((entry) => factField(entry!.observation, rule.field));
    if (values.some((value) => value === undefined))
      return result(criterion, "incomplete", "Cross-client facts do not expose the expected field");
    const passed = values.every((value) => stableJson(value) === stableJson(values[0]));
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed ? "Server and clients converged on one value" : "Server and clients disagreed",
      found.map((entry, index) => hashJson({ context: rule.contexts[index], evidence: entry! })),
      values as JsonPrimitive[],
    );
  }
  if (rule.kind === "scenario_step_within") {
    const graded = stepRequirementOutcome(plan, evidence, rule.scenarioId, rule.stepId);
    return result(
      criterion,
      graded.outcome,
      graded.explanation,
      graded.records.map((record) => hashJson(record)),
      graded.observed,
    );
  }
  if (rule.kind === "capture_present") {
    const capture = evidence.phases
      .find((phase) => phase.phaseId === rule.phaseId)
      ?.captures.find((entry) => entry.captureId === rule.captureId);
    return result(
      criterion,
      capture ? "verified" : "incomplete",
      capture ? "Bound capture is present" : "Required capture is absent",
      capture ? [capture.hash] : [],
    );
  }
  const observation = evidence.phases
    .find((phase) => phase.phaseId === rule.phaseId)
    ?.observations.find((entry) => entry.factId === rule.factId);
  if (!observation) return result(criterion, "incomplete", "Required Studio fact is absent");
  const observationHash = hashJson(observation);
  if (rule.kind === "diagnostics_empty") {
    if (observation.kind !== "diagnostics")
      return result(criterion, "incomplete", "Studio fact has wrong kind");
    const passed = observation.messages.length === 0 && observation.scriptErrors.length === 0;
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed
        ? "Studio reported no diagnostics"
        : "Studio reported output errors or script errors; this rule does not attribute their cause",
      [observationHash],
      [observation.messages.length, observation.scriptErrors.length],
    );
  }
  if (rule.kind === "fact_equals") {
    if (missingRequiredRole(observation, rule))
      return result(criterion, "rejected", MISSING_REQUIRED_ROLE, [observationHash]);
    const actual = factField(observation, rule.field);
    if (actual === undefined)
      return result(criterion, "incomplete", "Studio fact does not expose the expected field");
    const passed = stableJson(actual) === stableJson(rule.expected);
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed
        ? "Studio fact matched the hidden expectation"
        : "Studio fact did not match the hidden expectation",
      [observationHash],
      [actual],
    );
  }
  if (rule.kind === "fact_contains") {
    const actual = factField(observation, rule.field);
    if (typeof actual !== "string")
      return result(criterion, "incomplete", "Studio fact does not expose text");
    const passed = contains(actual, rule.text, rule.caseSensitive);
    return result(
      criterion,
      passed ? "verified" : "rejected",
      passed
        ? "Studio text contains the frozen literal"
        : "Studio text does not contain the frozen literal",
      [observationHash],
      [actual],
    );
  }
  const actual = numericField(observation, rule.field);
  if (actual === undefined)
    return result(criterion, "incomplete", "Studio fact does not expose the numeric field");
  const passed = actual >= rule.minimum && actual <= rule.maximum;
  return result(
    criterion,
    passed ? "verified" : "rejected",
    passed
      ? "Studio measurement is within the frozen range"
      : "Studio measurement is outside the frozen range",
    [observationHash],
    [actual],
  );
}

/** The analysis that a rule can read, or the incomplete reason when there is none. */
function readableAnalysis(analysis: SourceAnalysis | undefined): SourceAnalysis | string {
  if (!analysis) return "No source analysis exists for this build";
  return analysis.status === "complete"
    ? analysis
    : `The source analysis is unavailable: ${analysis.reason ?? "no reason"}`;
}

function sourceLintResult(
  criterion: DeterministicCriterion,
  codes: readonly SourceLintCode[],
  analysis: SourceAnalysis | undefined,
): CriterionResult {
  const readable = readableAnalysis(analysis);
  if (typeof readable === "string")
    return result(criterion, "incomplete", readable, analysis ? [hashJson(analysis)] : []);
  const counts = codes.map((code) => readable.counts[code] ?? 0);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const evidence = [hashJson(readable)];
  const tool = `luau-lsp ${readable.toolchain.luauLsp}`;
  if (total === 0)
    return result(
      criterion,
      "verified",
      `${tool} found no ${codes.join(", ")} finding in the sealed source`,
      evidence,
      counts,
    );
  const examples = readable.findings
    .filter((finding) => codes.includes(finding.code))
    .slice(0, 5)
    .map(
      (finding) =>
        `${finding.file}:${finding.line}:${finding.column} ${finding.code}: ${finding.message.split("\n")[0]!.slice(0, 200)}`,
    );
  return result(
    criterion,
    "rejected",
    `${tool} found ${total} ${total === 1 ? "finding" : "findings"} of ${codes.join(", ")}` +
      (examples.length ? `: ${examples.join("; ")}` : ""),
    evidence,
    counts,
  );
}

/**
 * Attribute each script error of the bound diagnostics facts. Output messages have no origin,
 * so this rule does not read them.
 */
function buildErrorResult(
  criterion: DeterministicCriterion,
  facts: readonly StudioObservationBinding[],
  evidence: StudioEvidence,
  analysis: SourceAnalysis | undefined,
): CriterionResult {
  const readable = readableAnalysis(analysis);
  if (typeof readable === "string")
    return result(criterion, "incomplete", readable, analysis ? [hashJson(analysis)] : []);
  const paths = buildScriptPaths(readable.scripts, evidenceActorNames(evidence));
  const observations = facts.map((binding) => boundStudioObservation(evidence, binding));
  const counts = { build: 0, unknown: 0, external: 0 };
  const buildErrors: ScriptDiagnostic[] = [];
  let full = false;
  for (const observation of observations) {
    if (observation?.kind !== "diagnostics") continue;
    if (observation.scriptErrors.length >= DIAGNOSTIC_CHANNEL_LIMIT) full = true;
    for (const entry of observation.scriptErrors) {
      const origin = originFromPaths(entry, paths);
      counts[origin] += 1;
      if (origin === "build") buildErrors.push(entry);
    }
  }
  const hashes = [
    hashJson(readable),
    ...observations.flatMap((observation) => (observation ? [hashJson(observation)] : [])),
  ];
  const observed = [counts.build, counts.unknown, counts.external];
  if (counts.build > 0) {
    const examples = buildErrors.slice(0, 3).map((entry) => {
      const where = entry.source.kind === "script" ? `${entry.source.path}: ` : "";
      return `${where}${entry.message.split("\n")[0]!.slice(0, 200)}`;
    });
    return result(
      criterion,
      "rejected",
      `Studio recorded ${counts.build} script ${counts.build === 1 ? "error" : "errors"} from build scripts: ${examples.join("; ")}`,
      hashes,
      observed,
    );
  }
  if (observations.some((observation) => observation?.kind !== "diagnostics"))
    return result(criterion, "incomplete", "A bound diagnostics fact is absent", hashes, observed);
  if (full)
    return result(
      criterion,
      "incomplete",
      `A diagnostics fact kept its limit of ${DIAGNOSTIC_CHANNEL_LIMIT} script errors, so later errors are unknown`,
      hashes,
      observed,
    );
  if (counts.unknown > 0)
    return result(
      criterion,
      "incomplete",
      `${counts.unknown} script ${counts.unknown === 1 ? "error has" : "errors have"} an origin that Basalt cannot attribute to the build or to an external script`,
      hashes,
      observed,
    );
  return result(
    criterion,
    "verified",
    counts.external
      ? `No script error came from a build script; ${counts.external} came from scripts outside the place`
      : "Studio recorded no script error",
    hashes,
    observed,
  );
}

/** The sample count of the plan for one performance_trace fact. The plan validator binds it. */
function plannedTraceSamples(
  plan: StudioCollectionPlan,
  binding: { scenarioId: string; stepId: string; context: string; factId: string },
): number {
  const fact = plan.scenarios
    .find((scenario) => scenario.id === binding.scenarioId)
    ?.steps.find((step) => step.id === binding.stepId)
    ?.observations.find(
      (item) => item.context === binding.context && item.fact.id === binding.factId,
    )?.fact;
  if (fact?.kind !== "performance_trace")
    throw new Error("The plan has no performance_trace fact at the bound step");
  return fact.sampleCount;
}

type EvidenceCapture = StudioEvidence["phases"][number]["captures"][number];

function boundCapture(
  evidence: StudioEvidence,
  phaseId: string,
  captureId: string,
): EvidenceCapture | null {
  return (
    evidence.phases
      .find((phase) => phase.phaseId === phaseId)
      ?.captures.find((entry) => entry.captureId === captureId) ?? null
  );
}

/**
 * Read and decode the frame of one capture, or give the reason that the frame is not readable.
 * An absent file or an absent folder of the file is a reason. Bytes that differ from the signed
 * evidence stop the grade of all criteria.
 */
async function readCaptureFrame(
  evidenceDirectory: string | undefined,
  capture: EvidenceCapture,
): Promise<Raster | string> {
  if (!evidenceDirectory)
    return "There is no evidence directory, so the check cannot read the pixels of the capture";
  const file = within(resolve(evidenceDirectory), capture.file);
  // The safe read refuses an absent folder with an error, so look for the folder first.
  const folder = await lstat(dirname(file)).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!folder)
    return `The image file of capture ${capture.captureId} is absent, because its folder ${dirname(capture.file)} does not exist`;
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(file, MAX_CAPTURE_BYTES, `capture ${capture.captureId}`);
  } catch (error) {
    if (isMissing(error)) return `The image file of capture ${capture.captureId} is absent`;
    throw error;
  }
  if (contentHash(bytes) !== capture.hash)
    throw new Error(`Capture ${capture.captureId} differs from its signed evidence`);
  const raster = decodeCaptureImage(bytes, capture.mediaType);
  if (raster.width !== capture.width || raster.height !== capture.height)
    throw new Error(`Capture ${capture.captureId} has other dimensions than its signed evidence`);
  return raster;
}

function scenarioStepEvidence(
  evidence: StudioEvidence,
  scenarioId: string,
  context: string,
  stepId: string,
) {
  return evidence.scenarios
    .find((scenario) => scenario.scenarioId === scenarioId)
    ?.reports.find((report) => report.context === context)
    ?.steps.find((step) => step.stepId === stepId);
}

/** Name the step outcome when its observations were not captured. Expiry is not failure. */
function absentScenarioFact(
  evidence: StudioEvidence,
  scenarioId: string,
  context: string,
  stepId: string,
): string {
  const step = scenarioStepEvidence(evidence, scenarioId, context, stepId);
  return step && step.outcome !== "observed"
    ? `The step outcome is ${step.outcome}, so the runner did not capture its observations`
    : "Required scenario fact is absent";
}

function scenarioObservationEvidence(
  evidence: StudioEvidence,
  scenarioId: string,
  context: string,
  stepId: string,
  factId: string,
) {
  const step = scenarioStepEvidence(evidence, scenarioId, context, stepId);
  const observation = step?.observations.find((entry) => entry.factId === factId);
  return step && observation ? { step, observation } : undefined;
}

/**
 * One code check result. `observed` holds the Studio values that the rule read, or null when the
 * rule read no value. A long text becomes its hash.
 */
function result(
  criterion: DeterministicCriterion,
  outcome: CriterionResult["outcome"],
  explanation: string,
  evidence: string[] = [],
  observed: JsonPrimitive[] | null = null,
): CriterionResult {
  return {
    criterionId: criterion.id,
    layer: criterion.layer,
    outcome,
    explanation,
    evidence,
    observed: observed && observed.map(observedValue),
  };
}

const MISSING_REQUIRED_ROLE =
  "The required public role has no tagged target in its declared scope, so the public role contract is not satisfied. This does not show that no similar untagged object exists.";

/**
 * A required role that resolved to no tagged target is a definitive public-contract failure for
 * an exists=true check on that role. Optional absence, ambiguity, class and scope failures are not.
 */
function missingRequiredRole(
  observation: StudioObservation,
  rule: DeterministicCriterion["rule"],
): boolean {
  return (
    observation.kind === "binding_failure" &&
    observation.reason === "missing" &&
    (rule.kind === "fact_equals" || rule.kind === "scenario_fact_equals") &&
    rule.field === "exists" &&
    rule.expected === true
  );
}

function factField(observation: StudioObservation, field: string): JsonPrimitive | undefined {
  if (field === "exists" && "exists" in observation) return observation.exists;
  if ("exists" in observation && !observation.exists) return undefined;
  if (
    field === "className" &&
    (observation.kind === "instance" || observation.kind === "instance_value")
  )
    return observation.className;
  if (field === "name" && observation.kind === "instance_name") return observation.name;
  if (field === "anchored" && observation.kind === "part_physics") return observation.anchored;
  if (field === "canCollide" && observation.kind === "part_physics") return observation.canCollide;
  if (field === "everUnanchored" && observation.kind === "part_physics_trace")
    return observation.everUnanchored;
  if (field === "text" && observation.kind === "gui_text") return observation.text;
  if (field === "visible" && observation.kind === "gui_text") return observation.visible;
  if (field === "visible" && observation.kind === "gui_geometry") return observation.visible;
  if (
    (field === "x" || field === "y" || field === "z" || field === "width" || field === "height") &&
    (observation.kind === "gui_geometry" || observation.kind === "part_position") &&
    field in observation
  )
    return observation[field as keyof typeof observation] as number;
  if (field === "enabled" && observation.kind === "particle_state") return observation.enabled;
  if (field === "value" && observation.kind === "replication_probe") return observation.value;
  if (field === "value" && observation.kind === "instance_value") return observation.value;
  if (field === "value" && observation.kind === "actor_health") return observation.value;
  if (field === "value" && observation.kind === "player_count") return observation.value;
  if (field === "observedFrom" && observation.kind === "replication_probe")
    return observation.observedFrom;
  return undefined;
}

function numericField(observation: StudioObservation, field: string): number | undefined {
  if ("exists" in observation && !observation.exists) return undefined;
  if (observation.kind === "part_motion" && observation.samples.length < 2) return undefined;
  if (
    (field === "x" || field === "y" || field === "z" || field === "width" || field === "height") &&
    (observation.kind === "gui_geometry" || observation.kind === "part_position") &&
    field in observation
  )
    return observation[field as keyof typeof observation] as number;
  if (field === "delta" && observation.kind === "part_motion") return observation.delta;
  if (field === "emissionRate" && observation.kind === "particle_state")
    return observation.emissionRate;
  if (
    field === "value" &&
    (observation.kind === "replication_probe" ||
      observation.kind === "instance_value" ||
      observation.kind === "actor_health" ||
      observation.kind === "player_count") &&
    typeof observation.value === "number"
  )
    return observation.value;
  return undefined;
}

async function assertCandidateWorkspace(
  workspaceRoot: string,
  candidate: CandidateManifest,
): Promise<void> {
  const root = resolve(workspaceRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Candidate workspace is not a regular directory");
  const declaredBytes = candidate.files.reduce((sum, file) => sum + file.bytes, 0);
  if (declaredBytes > MAX_CANDIDATE_BYTES)
    throw new Error("Sealed candidate exceeds the workspace byte limit");
  const files = await walkRegularTree(root, {
    label: "Candidate workspace",
    maxFileBytes: MAX_CANDIDATE_BYTES,
  });
  if (stableJson(files) !== stableJson(candidate.files) || hashJson(files) !== candidate.rootHash)
    throw new Error("Candidate workspace no longer matches the sealed candidate");
}

async function collectSources(root: string, sourceRoots: string[]): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Source root is not regular");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Source tree has symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:lua|luau)$/.test(entry.name)) {
        const fileInfo = await lstat(path);
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > MAX_SOURCE_BYTES)
          throw new Error(`Source file is unsafe or oversized: ${relative(root, path)}`);
        files.push(path);
      }
    }
  }
  for (const sourceRoot of sourceRoots) await visit(within(root, sourceRoot));
  return files.sort();
}

async function runTool(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ outcome: "pass" | "fail" | "unavailable"; detail?: string }> {
  try {
    await execFile(executable, args, { ...EXECUTION_OPTIONS, cwd });
    return { outcome: "pass" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return { outcome: "unavailable", detail: `${executable} is unavailable` };
    const stderr = (error as { stderr?: unknown }).stderr;
    return {
      outcome: "fail",
      detail: typeof stderr === "string" ? stderr.trim().slice(0, 4_000) : message(error),
    };
  }
}

async function readRegularFile(file: string, maxBytes: number, label: string): Promise<Buffer> {
  await assertSafeAbsoluteDirectory(dirname(resolve(file)));
  if (maxBytes < 0) throw new Error(`${label} exceeds its byte limit`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error(`${label} is unsafe or exceeds its byte limit`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`${label} grew beyond its byte limit`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function within(root: string, path: string): string {
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`Path escapes candidate: ${path}`);
  return target;
}

function contains(value: string, expected: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? value.includes(expected)
    : value.toLocaleLowerCase("en-US").includes(expected.toLocaleLowerCase("en-US"));
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_000) : "Unknown error";
}
