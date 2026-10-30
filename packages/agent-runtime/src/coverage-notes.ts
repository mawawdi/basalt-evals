import type { ModelTurnResult } from "../../model-client/src/contracts.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import {
  COVERAGE_TOOL,
  coverageCheckIds,
  coverageNotes,
  coveragePlan,
  coverageRequest,
  coverageScopes,
  coverageStage,
  type CheckCoverage,
  type CoverageScope,
  type CriterionCoverage,
} from "../../eval-authoring/src/coverage-request.js";
import type { PreparationDispatcher } from "./preparation-models.js";

/** The state of one coverage request. */
export interface CoverageRequestResult {
  scope: CoverageScope["kind"];
  /** The authored criterion of a request for one criterion, otherwise null. */
  criterionId: string | null;
  state: "complete" | "incomplete";
  requestHash: string | null;
  reason: string | null;
}

/** The entries of each complete request. An incomplete request adds no entry. */
export interface CoverageResult {
  criteria: CriterionCoverage[];
  checks: CheckCoverage[];
  requests: CoverageRequestResult[];
}

function failed(result: ModelTurnResult): string | null {
  if (result.kind !== "assistant") return `The model request failed: ${result.errorClass}.`;
  if (result.stopReason === "max_tokens")
    return "The model reached its output limit before it completed the coverage notes.";
  return null;
}

/**
 * A second model compares the prepared plan with the authored criteria in both directions: how
 * the plan and the prompt cover each criterion, and what each private check supports. The notes
 * are hypotheses for a person. They never change the plan, the criteria or a launch. The requests
 * run in parallel. A failed request gives an incomplete entry and never stops the others.
 */
export async function writeCoverageNotes(input: {
  dispatcher: PreparationDispatcher;
  model: { id: string; maxOutputTokens: number };
  revision: EvalRevision;
}): Promise<CoverageResult> {
  const criteria = input.revision.authored.criteria;
  const plan = coveragePlan(input.revision);
  const checkIds = coverageCheckIds(plan);
  const seed = Number.parseInt(input.revision.id.slice(0, 8), 16);
  const answers = await Promise.all(
    coverageScopes(criteria).map(async (scope) => {
      const request: CoverageRequestResult = {
        scope: scope.kind,
        criterionId: scope.kind === "criterion" ? scope.criterionId : null,
        state: "incomplete",
        requestHash: null,
        reason: null,
      };
      const incomplete = (reason: string) => ({
        request: { ...request, reason },
        criteria: [],
        checks: [],
      });
      let result: ModelTurnResult;
      try {
        result = await input.dispatcher.complete(
          coverageStage(scope),
          coverageRequest(
            input.model,
            seed,
            {
              builderPrompt: input.revision.authored.builderPrompt,
              rubric: input.revision.authored.rubric,
              criteria,
              plan,
            },
            scope,
          ),
        );
      } catch (error) {
        return incomplete(error instanceof Error ? error.message : String(error));
      }
      request.requestHash = result.requestHash;
      const reason = failed(result);
      if (reason) return incomplete(reason);
      const calls = result.kind === "assistant" ? result.message.toolCalls : [];
      const call = calls.length === 1 && calls[0]!.name === COVERAGE_TOOL ? calls[0]! : null;
      if (
        !call ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)
      )
        return incomplete(`The model did not submit exactly one ${COVERAGE_TOOL} call.`);
      try {
        const notes = coverageNotes(
          call.arguments as Record<string, unknown>,
          { criteria, checkIds },
          scope,
        );
        return { request: { ...request, state: "complete" as const }, ...notes };
      } catch (error) {
        return incomplete(error instanceof Error ? error.message : String(error));
      }
    }),
  );
  const answered = new Map(
    answers.flatMap((answer) => answer.criteria).map((item) => [item.criterionId, item]),
  );
  return {
    criteria: criteria.flatMap((criterion) => answered.get(criterion.id) ?? []),
    checks: answers.flatMap((answer) => answer.checks),
    requests: answers.map((answer) => answer.request),
  };
}
