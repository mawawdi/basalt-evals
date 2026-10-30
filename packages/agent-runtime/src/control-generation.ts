import { controlSourceRequest } from "../../eval-authoring/src/control-request.js";
import { hashJson, isSafeRelativePath, stableJson } from "../../contracts/src/index.js";
import { type ModelClient } from "../../model-client/src/contracts.js";
import { BoundedModelClient, isUnchargedRateLimit } from "../../model-client/src/bounded-client.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import type { EvalControlSet } from "../../eval-authoring/src/controls.js";
import {
  controlSpecs,
  controlOutcomeSchema,
  type ControlSpec,
} from "../../eval-authoring/src/control-specs.js";

/** A control attempt that stopped because the provider rejected its request for the rate limit. */
export const CONTROL_RATE_LIMIT =
  "Control generation stopped. The provider rejected the request for its rate limit after all tries. Basalt recorded no charge.";

export interface ControlSourceFile {
  path: string;
  text: string;
}

export interface ProposedControlSource {
  id: string;
  kind: "working" | "negative" | "alternative";
  targetCriterionId: string | null;
  contrast: string;
  basis: string;
  expectedDeterministic: Record<string, "verified" | "rejected" | "incomplete">;
  files: ControlSourceFile[];
}

export interface ControlAttemptResult {
  accepted: boolean;
  candidateHash: string | null;
  diagnostics: string[];
}

export interface RetainedControlAttempt {
  id: string;
  kind: ProposedControlSource["kind"];
  targetCriterionId: string | null;
  attempt: number;
  sourceHash: string | null;
  result: ControlAttemptResult;
}

export interface ControlPreparationResult {
  status: "ready_to_check" | "incomplete";
  set: EvalControlSet | null;
  attempts: RetainedControlAttempt[];
  diagnostics: string[];
}

export function assertControlSourceFiles(files: unknown): asserts files is ControlSourceFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > 64)
    throw new Error("Control source must contain one to 64 Luau files");
  let bytes = 0;
  const seen = new Set<string>();
  for (const item of files) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "path,text" ||
      typeof item.path !== "string" ||
      !isSafeRelativePath(item.path) ||
      !/^src\/(?:server|client|shared)\/[A-Za-z0-9_./-]+\.luau?$/u.test(item.path) ||
      seen.has(item.path) ||
      typeof item.text !== "string" ||
      item.text.includes("\0")
    )
      throw new Error("Control source contains an unsafe or duplicate Luau file");
    seen.add(item.path);
    bytes += Buffer.byteLength(item.text, "utf8");
    if (bytes > 512 * 1024) throw new Error("Control source exceeds 512 KiB");
  }
}

/** Canonicalize a provider's explained status without changing the frozen contrast. */
export function normalizeControlExpectations(
  value: unknown,
  capturePresentCriterionIds: ReadonlySet<string> = new Set(),
  passingValues: ReadonlyMap<string, unknown> = new Map(),
): ProposedControlSource["expectedDeterministic"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Control generator returned no bounded contrast expectations");
  const normalized: ProposedControlSource["expectedDeterministic"] = {};
  for (const [id, raw] of Object.entries(value)) {
    if (["verified", "rejected", "incomplete"].includes(String(raw))) {
      normalized[id] = raw as "verified" | "rejected" | "incomplete";
      continue;
    }
    if (raw === "pass" || (raw === "present" && capturePresentCriterionIds.has(id))) {
      normalized[id] = "verified";
      continue;
    }
    if (raw === "fail" || (raw === "absent" && capturePresentCriterionIds.has(id))) {
      normalized[id] = "rejected";
      continue;
    }
    if (passingValues.has(id) && stableJson(raw) === stableJson(passingValues.get(id))) {
      normalized[id] = "verified";
      continue;
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !Object.keys(raw).every((key) =>
        ["outcome", "reason", "expected", "observed"].includes(key),
      ) ||
      !("outcome" in raw) ||
      !("reason" in raw)
    )
      throw new Error("Control generator returned an invalid contrast expectation");
    const explained = raw as { outcome: unknown; reason: unknown };
    if (typeof explained.reason !== "string" || !explained.reason.trim())
      throw new Error("Control generator returned an invalid contrast expectation");
    const outcomes = {
      pass: "verified",
      fail: "rejected",
      incomplete: "incomplete",
      abstain: "incomplete",
    } as const;
    if (!Object.hasOwn(outcomes, String(explained.outcome)))
      throw new Error("Control generator returned an invalid contrast expectation");
    normalized[id] = outcomes[explained.outcome as keyof typeof outcomes];
  }
  return normalized;
}

type DeterministicCriterion = EvalRevision["privateEvaluator"]["deterministic"][number];

function equalityFactBinding(revision: EvalRevision, criterion: DeterministicCriterion) {
  const rule = criterion.rule;
  if (rule.kind === "scenario_fact_equals") {
    const fact = revision.privateEvaluator.studio.scenarios
      .find((scenario) => scenario.id === rule.scenarioId)
      ?.steps.find((step) => step.id === rule.stepId)
      ?.observations.find(
        (observation) =>
          observation.context === rule.context && observation.fact.id === rule.factId,
      )?.fact;
    return fact
      ? { window: `scenario:${rule.scenarioId}:${rule.stepId}:${rule.context}`, fact }
      : null;
  }
  if (rule.kind === "fact_equals") {
    const fact = revision.privateEvaluator.studio.phases
      .find((phase) => phase.id === rule.phaseId)
      ?.facts.find((item) => item.id === rule.factId);
    return fact ? { window: `phase:${rule.phaseId}`, fact } : null;
  }
  return null;
}

/** Confirmed absence can violate existence; dependent name/value judgments lack evidence. */
export function closeMissingRoleControlOutcomes(
  revision: EvalRevision,
  expected: ProposedControlSource["expectedDeterministic"],
): { outcomes: ProposedControlSource["expectedDeterministic"]; derivations: string[] } {
  const outcomes = { ...expected };
  const derivations: string[] = [];
  const criteria = revision.privateEvaluator.deterministic.filter((item) => item.required);
  for (const existence of criteria) {
    if (
      outcomes[existence.id] !== "rejected" ||
      !["scenario_fact_equals", "fact_equals"].includes(existence.rule.kind) ||
      !("field" in existence.rule) ||
      existence.rule.field !== "exists" ||
      !("expected" in existence.rule) ||
      existence.rule.expected !== true
    )
      continue;
    const missing = equalityFactBinding(revision, existence);
    if (missing?.fact.kind !== "instance" || !missing.fact.path.startsWith("role.")) continue;
    for (const dependent of criteria) {
      if (
        dependent.id === existence.id ||
        !["scenario_fact_equals", "fact_equals"].includes(dependent.rule.kind) ||
        !("field" in dependent.rule) ||
        dependent.rule.field !== "name" ||
        !("expected" in dependent.rule) ||
        typeof dependent.rule.expected !== "string" ||
        dependent.rule.expected === ""
      )
        continue;
      const name = equalityFactBinding(revision, dependent);
      if (
        name?.fact.kind !== "instance_name" ||
        name.fact.path !== missing.fact.path ||
        name.window !== missing.window ||
        outcomes[dependent.id] === "incomplete"
      )
        continue;
      outcomes[dependent.id] = "incomplete";
      derivations.push(
        `${dependent.id} is incomplete when ${existence.id} rejects the same missing role: no object name was observed`,
      );
    }
  }
  return { outcomes, derivations };
}

export class ModelControlProposer {
  constructor(
    private readonly client: ModelClient,
    private readonly ledger: DurableSpendLedger,
    private readonly snapshot: ModelSnapshot,
    private readonly seed: number,
    private readonly batchId: string,
    private readonly beforeRequest?: () => Promise<void>,
    private readonly signal?: AbortSignal,
  ) {}

  async propose(input: {
    revision: EvalRevision;
    spec: ControlSpec;
    attempt: number;
    diagnostics: string[];
    workingFiles: ControlSourceFile[] | null;
    /** The source tree of the working control of the stage before. Null for stage 1. */
    startingFiles: ControlSourceFile[] | null;
  }): Promise<ProposedControlSource> {
    const stage = `control_${this.batchId.slice(0, 20)}_${input.spec.id}_${input.attempt}`;
    const bounded = new BoundedModelClient(
      this.client,
      this.ledger,
      [this.snapshot],
      stage,
      false,
      this.beforeRequest,
    );
    const request = controlSourceRequest(
      {
        model: this.snapshot.id,
        seed: this.seed,
        maxOutputTokens: modelLimits(this.snapshot).maxOutputTokens,
      },
      input,
    );
    const requiredDeterministicIds = controlOutcomeSchema(input.revision).required;
    const result = await bounded.complete(request, this.signal);
    if (isUnchargedRateLimit(result)) throw new Error(CONTROL_RATE_LIMIT);
    if (
      result.kind !== "assistant" ||
      result.message.toolCalls.length !== 1 ||
      result.message.toolCalls[0]?.name !== "submit_control_source"
    )
      throw new Error("Control generator did not submit one source proposal");
    const argumentsValue = result.message.toolCalls[0].arguments;
    if (
      !argumentsValue ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue) ||
      Object.keys(argumentsValue).sort().join(",") !== "basis,contrast,expectedDeterministic,files"
    )
      throw new Error("Control generator returned invalid source fields");
    const files = (argumentsValue as Record<string, unknown>).files;
    assertControlSourceFiles(files);
    const contrast = (argumentsValue as Record<string, unknown>).contrast;
    const basis = (argumentsValue as Record<string, unknown>).basis;
    const expectedDeterministic = (argumentsValue as Record<string, unknown>).expectedDeterministic;
    if (
      typeof contrast !== "string" ||
      !contrast.trim() ||
      typeof basis !== "string" ||
      !basis.trim() ||
      !expectedDeterministic
    )
      throw new Error("Control generator returned no bounded contrast expectations");
    if (typeof expectedDeterministic !== "object" || Array.isArray(expectedDeterministic))
      throw new Error("Control generator returned an invalid contrast expectation");
    const ignoredNonDeterministicKeys =
      requiredDeterministicIds.length === 0 && Object.keys(expectedDeterministic).length > 0;
    if (
      requiredDeterministicIds.length > 0 &&
      Object.keys(expectedDeterministic).sort().join(",") !== requiredDeterministicIds.join(",")
    )
      throw new Error("Control generator returned an invalid contrast expectation");
    const normalized = normalizeControlExpectations(
      requiredDeterministicIds.length === 0 ? {} : expectedDeterministic,
      new Set(
        input.revision.privateEvaluator.deterministic
          .filter((criterion) => criterion.rule.kind === "capture_present")
          .map((criterion) => criterion.id),
      ),
      new Map(
        input.spec.kind === "negative"
          ? []
          : input.revision.privateEvaluator.deterministic.flatMap((criterion) =>
              criterion.required && "expected" in criterion.rule
                ? [[criterion.id, criterion.rule.expected] as const]
                : [],
            ),
      ),
    );
    const closed = closeMissingRoleControlOutcomes(input.revision, normalized);
    return {
      ...input.spec,
      id: `${input.spec.id}-attempt-${input.attempt}`,
      files,
      contrast,
      basis: [
        basis,
        ...(ignoredNonDeterministicKeys
          ? [
              "Basalt discarded non-deterministic keys from the empty expectedDeterministic map before freezing this control.",
            ]
          : []),
        ...(closed.derivations.length === 0
          ? []
          : [`Basalt derived before native execution: ${closed.derivations.join("; ")}.`]),
      ].join("\n"),
      expectedDeterministic: closed.outcomes,
    };
  }
}

/**
 * A verifier owns local checks and signed native execution; its failures are retained for
 * correction. Each control of a later stage starts from `startingFiles`.
 */
export async function prepareControlCases(input: {
  revision: EvalRevision;
  startingFiles: ControlSourceFile[] | null;
  batchId: string;
  implementationCommit: string;
  connectorArtifactHash: string;
  propose: ModelControlProposer["propose"];
  verify: (source: ProposedControlSource) => Promise<ControlAttemptResult>;
  recordAttempt?: (attempt: RetainedControlAttempt) => Promise<void>;
  readAttempt?: (id: string) => Promise<RetainedControlAttempt | null>;
}): Promise<ControlPreparationResult> {
  if (!/^[a-f0-9]{64}$/u.test(input.batchId))
    throw new Error("Invalid eval control batch identity");
  const attempts: RetainedControlAttempt[] = [];
  const selected: EvalControlSet["cases"] = [];
  let workingFiles: ControlSourceFile[] | null = null;
  const diagnostics: string[] = [];
  for (const spec of controlSpecs(input.revision)) {
    if (spec.kind === "negative" && workingFiles === null) {
      diagnostics.push("Working reference did not pass; targeted negatives cannot be prepared");
      break;
    }
    let accepted = false;
    let rateLimited = false;
    let corrections: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptId = `${spec.id}-attempt-${attempt}`;
      const prior = await input.readAttempt?.(attemptId);
      if (
        prior &&
        prior.id === attemptId &&
        prior.kind === spec.kind &&
        prior.targetCriterionId === spec.targetCriterionId &&
        prior.attempt === attempt &&
        prior.sourceHash === null &&
        prior.result.candidateHash === null &&
        prior.result.diagnostics[0] === CONTROL_RATE_LIMIT
      ) {
        attempts.push(prior);
        corrections = prior.result.diagnostics;
        continue;
      }
      let source: ProposedControlSource;
      try {
        source = await input.propose({
          revision: input.revision,
          spec,
          attempt,
          diagnostics: corrections,
          workingFiles: spec.kind === "working" ? null : workingFiles,
          startingFiles: input.startingFiles,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/^Control (?:generator|source|generation) /u.test(message)) throw error;
        const retained: RetainedControlAttempt = {
          id: `${spec.id}-attempt-${attempt}`,
          kind: spec.kind,
          targetCriterionId: spec.targetCriterionId,
          attempt,
          sourceHash: null,
          result: { accepted: false, candidateHash: null, diagnostics: [message] },
        };
        attempts.push(retained);
        if (input.recordAttempt) await input.recordAttempt(retained);
        corrections = [message];
        if (message === CONTROL_RATE_LIMIT) {
          rateLimited = true;
          break;
        }
        continue;
      }
      if (
        source.kind !== spec.kind ||
        source.targetCriterionId !== spec.targetCriterionId ||
        source.id !== `${spec.id}-attempt-${attempt}`
      )
        throw new Error("Control proposer changed the frozen control identity");
      assertControlSourceFiles(source.files);
      const requiredDeterministic = input.revision.privateEvaluator.deterministic
        .filter((item) => item.required)
        .map((item) => item.id)
        .sort();
      if (
        !source.contrast.trim() ||
        !source.basis.trim() ||
        Object.keys(source.expectedDeterministic).sort().join(",") !==
          requiredDeterministic.join(",") ||
        Object.values(source.expectedDeterministic).some(
          (value) => !["verified", "rejected", "incomplete"].includes(value),
        ) ||
        (source.kind !== "negative" &&
          Object.values(source.expectedDeterministic).some((value) => value !== "verified")) ||
        (source.kind === "negative" &&
          requiredDeterministic.includes(source.targetCriterionId!) &&
          source.expectedDeterministic[source.targetCriterionId!] !== "rejected")
      ) {
        const message = "Control proposal has invalid frozen contrast expectations";
        const retained: RetainedControlAttempt = {
          id: source.id,
          kind: spec.kind,
          targetCriterionId: spec.targetCriterionId,
          attempt,
          sourceHash: hashJson(source.files),
          result: { accepted: false, candidateHash: null, diagnostics: [message] },
        };
        attempts.push(retained);
        if (input.recordAttempt) await input.recordAttempt(retained);
        corrections = [message];
        continue;
      }
      const result = await input.verify(source);
      if (
        result.accepted &&
        (!result.candidateHash || !/^[a-f0-9]{64}$/u.test(result.candidateHash))
      )
        throw new Error("Accepted control lacks a candidate source hash");
      const retained: RetainedControlAttempt = {
        id: source.id,
        kind: spec.kind,
        targetCriterionId: spec.targetCriterionId,
        attempt,
        sourceHash: hashJson(source.files),
        result,
      };
      attempts.push(retained);
      if (input.recordAttempt) await input.recordAttempt(retained);
      if (result.accepted) {
        selected.push({
          id: source.id,
          kind: spec.kind,
          targetCriterionId: spec.targetCriterionId,
          candidateHash: result.candidateHash!,
          contrast: source.contrast,
          basis: source.basis,
          expectedDeterministic: source.expectedDeterministic,
        });
        if (spec.kind === "working") workingFiles = source.files;
        accepted = true;
        break;
      }
      corrections = result.diagnostics;
    }
    if (!accepted) {
      diagnostics.push(
        rateLimited
          ? `Control ${spec.id} paused after provider rate limit`
          : `Control ${spec.id} exhausted two correction cycles`,
      );
      if (spec.kind === "working" || rateLimited) break;
    }
  }
  if (selected.length !== controlSpecs(input.revision).length)
    return { status: "incomplete", set: null, attempts, diagnostics };
  const body = {
    schema: "basalt-evals/eval-control-set" as const,
    revisionId: input.revision.id,
    batchId: input.batchId,
    implementationCommit: input.implementationCommit,
    connectorArtifactHash: input.connectorArtifactHash,
    cases: selected,
  };
  return {
    status: "ready_to_check",
    set: { ...body, id: hashJson(body) },
    attempts,
    diagnostics,
  };
}
