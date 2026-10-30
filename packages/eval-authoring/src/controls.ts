import type { EvaluationReadinessRecord } from "./registration.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertStudioEvidence,
  contentHash,
  hashJson,
  stableJson,
  validRubricScore,
  type CriterionResult,
  type StudioEvidence,
  type StudioObservationBinding,
  type StudioActionBinding,
} from "../../contracts/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { evaluateDeterministicCriteria } from "../../graders/src/index.js";
import { ensureSourceAnalysis, readsSourceAnalysis } from "../../graders/src/source-analysis.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import {
  verifyWorkerArtifacts,
  type SignedWorkerManifest,
} from "../../studio-runner/src/native-worker.js";
import { loadStudioSession } from "../../studio-runner/src/index.js";
import { EvalDefinitionStore } from "./store.js";
import { stageEvalRevision } from "./stage.js";
import type { EvalRevision, EvalValidation } from "./compiler.js";
import { requiredNegativeControlIds } from "./control-specs.js";
import { readControlJudgments } from "./control-judgment.js";
import { controlSequencePlan } from "./control-sequence.js";
import { readBoundSequence } from "../../studio-runner/src/bound-sequence.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const casePattern = /^[a-z][a-z0-9-]{0,63}$/u;

export interface EvalControlSet {
  schema: "basalt-evals/eval-control-set";
  id: string;
  revisionId: string;
  batchId: string;
  implementationCommit: string;
  connectorArtifactHash: string;
  cases: Array<{
    id: string;
    kind: "working" | "negative" | "alternative";
    targetCriterionId: string | null;
    candidateHash: string;
    contrast: string;
    basis: string;
    expectedDeterministic: Record<string, "verified" | "rejected" | "incomplete">;
  }>;
}

export interface CheckedControlCase {
  id: string;
  kind: EvalControlSet["cases"][number]["kind"];
  targetCriterionId: string | null;
  candidateHash: string;
  receiptHash: string;
  criteria: CriterionResult[];
  captureIds: string[];
  observationBindings: StudioObservationBinding[];
  actionBindings: StudioActionBinding[];
}

export interface ControlCheck {
  schema: "basalt-evals/control-check";
  revisionId: string;
  batchId: string;
  controlSetHash: string;
  implementationCommit: string;
  connectorArtifactHash: string;
  status: "checked" | "failed" | "incomplete";
  acquisition: "validated" | "incomplete";
  discrimination: "validated" | "failed" | "incomplete";
  diagnostics: string[];
  unreviewedClaims: string[];
  scoreContrasts: Array<{
    criterionId: string;
    controlId: string;
    score: number | null;
    referenceScores: number[];
    expected: "distinct" | "preserved";
    result: "validated" | "failed" | "incomplete";
  }>;
  cases: CheckedControlCase[];
}

/** Distinguish executable control discrimination from still-unreviewed human claims. */
export function summarizeControls(
  revision: EvalRevision,
  set: EvalControlSet,
  cases: CheckedControlCase[],
): ControlCheck {
  if (
    set.revisionId !== revision.id ||
    !hashPattern.test(set.batchId) ||
    set.id !== hashJson(controlSetBody(set))
  )
    throw new Error("Control set is not bound to this immutable eval revision");
  if (new Set(set.cases.map((item) => item.id)).size !== set.cases.length)
    throw new Error("Control case IDs must be unique");
  for (const item of set.cases) {
    if (
      !casePattern.test(item.id) ||
      !hashPattern.test(item.candidateHash) ||
      typeof item.contrast !== "string" ||
      typeof item.basis !== "string" ||
      !item.expectedDeterministic ||
      typeof item.expectedDeterministic !== "object" ||
      Array.isArray(item.expectedDeterministic) ||
      (item.kind === "negative") !== (item.targetCriterionId !== null)
    )
      throw new Error("Invalid frozen control case");
  }
  const required = [
    ...revision.privateEvaluator.deterministic
      .filter((item) => item.required)
      .map((item) => item.id),
    ...revision.privateEvaluator.codeQuality.filter((item) => item.required).map((item) => item.id),
    ...revision.privateEvaluator.visual.filter((item) => item.required).map((item) => item.id),
    ...revision.privateEvaluator.unscaled.filter((item) => item.required).map((item) => item.id),
  ];
  if (set.cases.length < 3 || set.cases.length > 130)
    throw new Error(
      "Frozen controls need a working reference, an alternative, and negative coverage",
    );
  if (
    set.cases.some(
      (item) => item.kind === "negative" && !required.includes(item.targetCriterionId!),
    )
  )
    throw new Error("Negative control targets an unknown required criterion");
  const requiredDeterministic = new Set(
    revision.privateEvaluator.deterministic.filter((item) => item.required).map((item) => item.id),
  );
  const qualitative = new Set(required.filter((id) => !requiredDeterministic.has(id)));
  const scoringOnly = new Map(
    [...revision.privateEvaluator.visual, ...revision.privateEvaluator.codeQuality]
      .filter((criterion) => criterion.required && criterion.minimumPassingScore === null)
      .map((criterion) => [criterion.id, criterion]),
  );
  const scoreContrasts: ControlCheck["scoreContrasts"] = [];
  const diagnostics: string[] = [];
  const unreviewedClaims = [
    ...qualitative,
    ...[...scoringOnly.keys()].map((id) => "acceptance-threshold-unresolved:" + id),
    ...revision.criterionMappings
      .filter((mapping) => mapping.method === "human")
      .map((mapping) => mapping.authoredCriterionId)
      .filter((id): id is string => id !== null),
  ];
  const byId = new Map(cases.map((item) => [item.id, item]));
  if (byId.size !== cases.length || cases.length !== set.cases.length)
    diagnostics.push("Control executions do not cover the exact frozen case set");
  const expected = set.cases;
  if (expected.filter((item) => item.kind === "working").length !== 1)
    diagnostics.push("Exactly one working reference is required");
  if (expected.filter((item) => item.kind === "alternative").length !== 1)
    diagnostics.push("One independently structured valid alternative is required");
  for (const id of requiredNegativeControlIds(revision))
    if (
      !expected.some(
        (item) =>
          item.kind === "negative" &&
          (item.targetCriterionId === id || item.expectedDeterministic[id] === "rejected"),
      )
    )
      diagnostics.push("No negative contrast covers " + id);
  for (const item of expected) {
    if (!item.contrast.trim() || !item.basis.trim())
      diagnostics.push("Control contrast and source basis are required: " + item.id);
    for (const id of requiredDeterministic)
      if (!["verified", "rejected", "incomplete"].includes(item.expectedDeterministic[id] ?? ""))
        diagnostics.push("Control lacks a frozen deterministic expectation: " + item.id + "/" + id);
    if (
      item.kind !== "negative" &&
      [...requiredDeterministic].some((id) => item.expectedDeterministic[id] !== "verified")
    )
      diagnostics.push("Positive control expects a required deterministic failure: " + item.id);
    if (
      item.kind === "negative" &&
      requiredDeterministic.has(item.targetCriterionId!) &&
      item.expectedDeterministic[item.targetCriterionId!] !== "rejected"
    )
      diagnostics.push("Negative control does not target its named criterion: " + item.id);
    const run = byId.get(item.id);
    if (!run) {
      diagnostics.push("Missing native control execution: " + item.id);
      continue;
    }
    if (
      run.kind !== item.kind ||
      run.targetCriterionId !== item.targetCriterionId ||
      run.candidateHash !== item.candidateHash ||
      !hashPattern.test(run.receiptHash)
    ) {
      diagnostics.push("Control execution identity differs from freeze: " + item.id);
      continue;
    }
    const outcomes = new Map(
      run.criteria.map((criterion) => [criterion.criterionId, criterion.outcome]),
    );
    for (const id of qualitative) {
      const scale = scoringOnly.get(id);
      if (scale) {
        const observed = run.criteria.find((criterion) => criterion.criterionId === id)?.score;
        const score =
          typeof observed === "number" && validRubricScore(scale, observed) ? observed : null;
        const references = expected
          .filter((control) => control.kind !== "negative")
          .map(
            (control) =>
              byId.get(control.id)?.criteria.find((criterion) => criterion.criterionId === id)
                ?.score,
          );
        const referenceScores = references.filter(
          (value): value is number => typeof value === "number" && validRubricScore(scale, value),
        );
        const distinct = item.kind === "negative" && item.targetCriterionId === id;
        // This is a sensitivity test against the observed positive controls, not a
        // human passing score. No score direction or quality cutoff is inferred.
        const outside =
          score !== null &&
          referenceScores.length === 2 &&
          (score < Math.min(...referenceScores) || score > Math.max(...referenceScores));
        const result =
          score === null || referenceScores.length !== 2
            ? "incomplete"
            : (distinct ? outside : !outside)
              ? "validated"
              : "failed";
        scoreContrasts.push({
          criterionId: id,
          controlId: item.id,
          score,
          referenceScores,
          expected: distinct ? "distinct" : "preserved",
          result,
        });
        if (result === "incomplete")
          diagnostics.push(`Incomplete score discrimination: ${item.id}/${id}`);
        if (result === "failed")
          diagnostics.push(
            `Control ${item.id}/${id}: score contrast did not ${distinct ? "separate from" : "preserve"} the positive control range`,
          );
        continue;
      }
      const outcome = outcomes.get(id);
      const expectedOutcome =
        item.kind === "negative" && item.targetCriterionId === id ? "rejected" : "verified";
      if (!outcome || outcome === "incomplete")
        diagnostics.push(`Incomplete qualitative discrimination: ${item.id}/${id}`);
      else if (outcome !== expectedOutcome)
        diagnostics.push(`Control ${item.id}/${id}: expected ${expectedOutcome}, got ${outcome}`);
    }
    for (const id of requiredDeterministic) {
      const outcome = outcomes.get(id);
      if (outcome !== item.expectedDeterministic[id])
        diagnostics.push(
          `Control ${item.id}/${id}: expected ${item.expectedDeterministic[id]}, got ${outcome ?? "missing"}`,
        );
    }
    for (const criterion of revision.privateEvaluator.visual) {
      if (!criterion.required) continue;
      for (const captureId of criterion.captureIds)
        if (!run.captureIds.includes(captureId))
          diagnostics.push("Missing required visual capture in " + item.id + "/" + captureId);
    }
    for (const criterion of revision.privateEvaluator.unscaled) {
      if (!criterion.required) continue;
      for (const captureId of criterion.evidence.captureIds)
        if (!run.captureIds.includes(captureId))
          diagnostics.push(
            "Missing required unscaled visual capture in " + item.id + "/" + captureId,
          );
      for (const binding of criterion.evidence.facts)
        if (
          !Array.isArray(run.observationBindings) ||
          !run.observationBindings.some((item) => hashJson(item) === hashJson(binding))
        )
          diagnostics.push(
            `Missing required Studio observation in ${item.id}/${stableJson(binding)}`,
          );
      for (const binding of criterion.evidence.actions)
        if (!run.actionBindings.some((recorded) => hashJson(recorded) === hashJson(binding)))
          diagnostics.push(`Missing required Studio action in ${item.id}/${stableJson(binding)}`);
    }
    if (item.kind === "negative" && qualitative.has(item.targetCriterionId!))
      unreviewedClaims.push("control-distinction:" + item.id);
  }
  const status =
    diagnostics.length === 0
      ? "checked"
      : diagnostics.every((item) => item.startsWith("Missing") || item.startsWith("Incomplete"))
        ? "incomplete"
        : "failed";
  const acquisition =
    expected.every((item) => {
      const run = byId.get(item.id);
      if (!run || run.candidateHash !== item.candidateHash || !hashPattern.test(run.receiptHash))
        return false;
      const plan = revision.privateEvaluator.studio;
      return (
        revision.privateEvaluator.unscaled.every((criterion) =>
          criterion.evidence.actions.every((binding) =>
            run.actionBindings.some((recorded) => hashJson(recorded) === hashJson(binding)),
          ),
        ) &&
        plan.phases.every(
          (phase) =>
            phase.captures.every((capture) => run.captureIds.includes(capture.id)) &&
            phase.facts.every((fact) =>
              run.observationBindings.some(
                (binding) =>
                  "phaseId" in binding &&
                  binding.phaseId === phase.id &&
                  binding.factId === fact.id,
              ),
            ),
        ) &&
        plan.scenarios.every((scenario) =>
          scenario.steps.every((step) =>
            step.observations.every((item) =>
              run.observationBindings.some(
                (binding) =>
                  "scenarioId" in binding &&
                  binding.scenarioId === scenario.id &&
                  binding.stepId === step.id &&
                  binding.context === item.context &&
                  binding.factId === item.fact.id,
              ),
            ),
          ),
        )
      );
    }) && cases.length === expected.length
      ? "validated"
      : "incomplete";
  return {
    schema: "basalt-evals/control-check",
    revisionId: revision.id,
    batchId: set.batchId,
    controlSetHash: set.id,
    implementationCommit: set.implementationCommit,
    connectorArtifactHash: set.connectorArtifactHash,
    status: status === "checked" && acquisition === "incomplete" ? "incomplete" : status,
    acquisition,
    discrimination: status === "checked" ? "validated" : status,
    diagnostics,
    unreviewedClaims: [...new Set(unreviewedClaims)].sort(),
    scoreContrasts,
    cases,
  };
}

function controlSetBody(set: EvalControlSet): Omit<EvalControlSet, "id"> {
  const { id: _id, ...body } = set;
  return body;
}

async function boundedJson<T>(file: string, maximum = 4 * 1024 * 1024): Promise<T> {
  return JSON.parse(
    (await readBoundedRegularFile(file, maximum, "control artifact")).toString("utf8"),
  ) as T;
}

/** Read only fixed control locations, then recompute outcomes from signed native evidence. */
export async function checkEvalControls(
  root: string,
  revisionId: string,
  batchId: string,
): Promise<ControlCheck> {
  if (!hashPattern.test(revisionId) || !hashPattern.test(batchId))
    throw new Error("Invalid eval control batch identity");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(revisionId);
  const set = await boundedJson<EvalControlSet>(
    resolve(root, ".basalt-evals/eval-control-runs", revisionId, batchId, "set.json"),
  );
  if (
    set.schema !== "basalt-evals/eval-control-set" ||
    set.revisionId !== revisionId ||
    set.batchId !== batchId
  )
    throw new Error("Invalid frozen control set");
  if (
    set.id !== hashJson(controlSetBody(set)) ||
    !Array.isArray(set.cases) ||
    set.cases.length > 130 ||
    !set.cases.every(
      (item) =>
        casePattern.test(item.id) &&
        hashPattern.test(item.candidateHash) &&
        typeof item.contrast === "string" &&
        typeof item.basis === "string" &&
        item.expectedDeterministic &&
        typeof item.expectedDeterministic === "object" &&
        !Array.isArray(item.expectedDeterministic) &&
        ["working", "negative", "alternative"].includes(item.kind) &&
        (item.targetCriterionId === null || typeof item.targetCriterionId === "string"),
    )
  )
    throw new Error("Invalid control set identity or case inventory");
  const staged = await stageEvalRevision(root, revisionId);
  const task = await loadRegisteredTask(root, staged.directory);
  const pinnedKey = await readFile(
    resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    "utf8",
  );
  const checked: CheckedControlCase[] = [];
  for (const item of set.cases) {
    if (!casePattern.test(item.id)) throw new Error("Invalid control case identity");
    const directory = resolve(
      root,
      ".basalt-evals/eval-control-runs",
      revisionId,
      batchId,
      item.id,
    );
    const sessionDirectory = resolve(directory, "studio");
    const receiptBytes = await readBoundedRegularFile(
      resolve(sessionDirectory, "native/manifest.json"),
      4 * 1024 * 1024,
      "signed control receipt",
    );
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as SignedWorkerManifest;
    await verifyWorkerArtifacts(sessionDirectory, receipt, pinnedKey);
    if (receipt.manifest.status !== "complete")
      throw new Error("Native control evidence is incomplete: " + item.id);
    const session = await loadStudioSession(sessionDirectory);
    const files = await inventoryTree(resolve(directory, "workspace"));
    const candidateHash = hashJson(files);
    if (
      receipt.manifest.sessionId !== session.id ||
      receipt.manifest.candidateHash !== candidateHash ||
      receipt.manifest.collectionPlanHash !== session.collectionPlanHash ||
      session.candidateHash !== candidateHash ||
      item.candidateHash !== candidateHash ||
      session.collectionPlanHash !== hashJson(revision.privateEvaluator.studio) ||
      session.connectorArtifactHash !== set.connectorArtifactHash
    )
      throw new Error("Control source, evaluator or connector binding changed: " + item.id);
    const evidence = await boundedJson<StudioEvidence>(resolve(sessionDirectory, "evidence.json"));
    const sequence = controlSequencePlan(revision, candidateHash, set.implementationCommit);
    if (sequence) {
      const bound = await readBoundSequence(sessionDirectory, receipt, sequence);
      if (bound.assessment.status !== "sufficient" || bound.acquisition.status !== "complete")
        throw new Error("Control sequence acquisition remains incomplete: " + item.id);
    }
    assertStudioEvidence(evidence);
    const candidate = {
      projectFile: task.publicTask.seed.projectFile,
      files,
      rootHash: candidateHash,
    };
    const criteria = await evaluateDeterministicCriteria({
      workspaceRoot: resolve(directory, "workspace"),
      evaluator: task.evaluator,
      candidate,
      treatmentId: session.treatmentId,
      evidence,
      analysis: readsSourceAnalysis(task.evaluator.deterministic)
        ? await ensureSourceAnalysis(root, resolve(directory, "workspace"), candidate)
        : undefined,
      evidenceDirectory: sessionDirectory,
    });
    criteria.push(
      ...(await readControlJudgments(
        root,
        `.basalt-evals/eval-control-runs/${revisionId}/${batchId}/${item.id}`,
        revision,
        candidateHash,
        hashJson(evidence),
      )),
    );
    checked.push({
      id: item.id,
      kind: item.kind,
      targetCriterionId: item.targetCriterionId,
      candidateHash,
      receiptHash: contentHash(receiptBytes),
      criteria,
      captureIds: evidence.phases.flatMap((phase) =>
        phase.captures.map((capture) => capture.captureId),
      ),
      observationBindings: [
        ...evidence.phases.flatMap((phase) =>
          phase.observations.map((observation) => ({
            phaseId: phase.phaseId,
            factId: observation.factId,
          })),
        ),
        ...evidence.scenarios.flatMap((scenario) =>
          scenario.reports.flatMap((report) =>
            report.steps.flatMap((step) =>
              step.observations.map((observation) => ({
                scenarioId: scenario.scenarioId,
                stepId: step.stepId,
                context: report.context,
                factId: observation.factId,
              })),
            ),
          ),
        ),
      ],
      actionBindings: evidence.scenarios.flatMap((scenario) =>
        scenario.reports.flatMap((report) =>
          report.steps.flatMap((step) =>
            step.action
              ? [{ scenarioId: scenario.scenarioId, stepId: step.stepId, context: report.context }]
              : [],
          ),
        ),
      ),
    });
  }
  return summarizeControls(revision, set, checked);
}

/**
 * The checked readiness record of one stage, without the link to the next stage. Registration is
 * the final private step; the browser supplies only a revision ID. The caller saves the records
 * of all stages when every stage is checked.
 */
export async function checkedStageRecord(
  root: string,
  revisionId: string,
  batchId: string,
): Promise<Omit<EvaluationReadinessRecord, "nextRecordHash">> {
  const check = await checkEvalControls(root, revisionId, batchId);
  if (check.status !== "checked")
    throw new Error("Eval controls are not checked: " + check.diagnostics.join("; "));
  await cleanImplementationCommit(root, check.implementationCommit);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(revisionId);
  const validation: EvalValidation = {
    schema: "basalt-evals/eval-validation",
    draftId: revision.draftId,
    revisionId,
    status: "controls_checked",
    diagnostics: [],
    preparation: "compiled",
    acquisition: "validated",
    discrimination: "validated",
    humanCalibration: "unavailable",
    controlSetHash: check.controlSetHash,
    unreviewedClaims: check.unreviewedClaims,
  };
  return { validation, check };
}
