import type {
  BenchmarkCaseAttempts,
  BenchmarkCounter,
  BenchmarkDistribution,
  BenchmarkRequestTelemetry,
  BenchmarkRoleTelemetry,
  BenchmarkStageTiming,
  BenchmarkSuccessBounds,
  BenchmarkTelemetry,
} from "../../contracts/src/benchmarks.js";
import type { RunOperationEvent } from "../../contracts/src/execution.js";

function benchmarkDistribution(
  values: Array<number | null>,
  eligible = values.length,
): BenchmarkDistribution {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (eligible < known.length || known.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Invalid benchmark measurement population");
  const middle = Math.floor(known.length / 2);
  return {
    count: known.length,
    eligible,
    minimum: known[0] ?? null,
    median: known.length
      ? known.length % 2
        ? known[middle]!
        : (known[middle - 1]! + known[middle]!) / 2
      : null,
    maximum: known.at(-1) ?? null,
  };
}

export function summarizeBenchmarkTelemetry(
  requests: BenchmarkRequestTelemetry[],
): BenchmarkTelemetry {
  if (
    new Set(requests.map((row) => `${row.operationId}:${row.requestId}`)).size !== requests.length
  )
    throw new Error("Duplicate benchmark request identity");
  const sumKnown = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    if (known.some((value) => !Number.isFinite(value) || value < 0))
      throw new Error("Invalid retained accounting value");
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const roles: BenchmarkRoleTelemetry[] = (
    ["builder", "grader", "preparation", "other"] as const
  ).map((role) => {
    const rows = requests.filter((row) => row.role === role);
    const eligible = rows.filter((row) => row.dispatched !== false);
    function counter(
      key:
        "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens",
    ): BenchmarkCounter {
      const values = eligible.map((row) => row.usage?.[key] ?? null);
      return {
        knownTotal: sumKnown(values),
        knownRequests: values.filter((value) => value !== null).length,
        eligibleRequests: eligible.length,
      };
    }
    return {
      role,
      requests: {
        retained: rows.length,
        dispatched: rows.filter((row) => row.dispatched === true).length,
        dispatchUnknown: rows.filter((row) => row.dispatched === null).length,
        notDispatched: rows.filter((row) => row.dispatched === false).length,
      },
      charges: {
        knownUsd: sumKnown(rows.map((row) => row.billedUsd)),
        settledRequests: rows.filter((row) => row.status === "billed" && row.billedUsd !== null)
          .length,
        retainedRequests: rows.length,
        activeReservedUsd: rows
          .filter((row) => row.status === "pending")
          .reduce((sum, row) => sum + row.reservedUsd, 0),
      },
      tokens: {
        inputTokens: counter("inputTokens"),
        outputTokens: counter("outputTokens"),
        reasoningTokens: counter("reasoningTokens"),
        cacheReadTokens: counter("cacheReadTokens"),
        cacheWriteTokens: counter("cacheWriteTokens"),
      },
      modelTurnElapsedMs: benchmarkDistribution(eligible.map((row) => row.latencyMs)),
      knownFailedRequests: eligible.filter(
        (row) => row.resultKind === "provider_error" || row.resultKind === "invalid_model_response",
      ).length,
      telemetryIssues: rows.filter((row) => row.issue !== null).length,
    };
  });
  return {
    roles,
    knownChargeUsd: sumKnown(requests.map((row) => row.billedUsd)),
    activeReservedUsd: roles.reduce((sum, row) => sum + row.charges.activeReservedUsd, 0),
  };
}

/** Only caller-supplied dispositions bound to an explicit saved case rule are eligible. */
export function benchmarkSuccessBounds(cases: BenchmarkCaseAttempts[]): BenchmarkSuccessBounds {
  if (
    new Set(cases.map((row) => row.evaluationId)).size !== cases.length ||
    cases.some((row) => !row.attempts.length)
  )
    throw new Error("Benchmark cases require unique identities and planned attempts");
  const attempts = cases.flatMap((row) => row.attempts);
  if (new Set(attempts.map((row) => row.subjectId)).size !== attempts.length)
    throw new Error("Duplicate independent build identity");
  const casesWithRule = cases.filter((row) => row.successRuleHash !== null).length;
  if (
    cases.some(
      (row) =>
        row.successRuleHash === null &&
        row.attempts.some(
          (attempt) => attempt.outcome !== "unknown" && attempt.outcome !== "not_reached",
        ),
    )
  )
    throw new Error("A case without a saved success rule cannot invent a build verdict");
  // A build of a stage that the run did not reach is outside the denominator of its stage. A
  // stage that the run reached with no build is outside the bounds.
  const counts = (row: BenchmarkCaseAttempts) => ({
    s: row.attempts.filter((item) => item.outcome === "succeeded").length,
    f: row.attempts.filter((item) => item.outcome === "failed").length,
    u: row.attempts.filter((item) => item.outcome === "unknown").length,
    n: row.attempts.filter((item) => item.outcome !== "not_reached").length,
  });
  const reached = cases.filter((row) => counts(row).n > 0);
  const eligible = reached.length > 0 && casesWithRule === cases.length;
  return {
    cases: cases.length,
    casesWithRule,
    plannedAttempts: attempts.length,
    knownSuccesses: attempts.filter((row) => row.outcome === "succeeded").length,
    knownFailures: attempts.filter((row) => row.outcome === "failed").length,
    unknown: attempts.filter((row) => row.outcome === "unknown").length,
    notReached: attempts.filter((row) => row.outcome === "not_reached").length,
    macroAttemptSuccess: eligible
      ? {
          lower:
            reached.reduce((sum, row) => sum + counts(row).s / counts(row).n, 0) / reached.length,
          upper:
            reached.reduce((sum, row) => sum + (counts(row).s + counts(row).u) / counts(row).n, 0) /
            reached.length,
        }
      : null,
    allAttemptsSuccess: eligible
      ? {
          lower: reached.filter((row) => counts(row).s === counts(row).n).length / reached.length,
          upper: reached.filter((row) => counts(row).f === 0).length / reached.length,
        }
      : null,
  };
}

const closingKinds = new Set<RunOperationEvent["kind"]>([
  "paused",
  "provider_paused",
  "not_dispatched",
  "completed",
  "failed",
  "incomplete",
]);
const terminalKinds = new Set<RunOperationEvent["kind"]>(["completed", "failed", "incomplete"]);

/**
 * The one build-time rule: the sum of the intervals from each `started` event of a unit to its
 * next `paused` or terminal event. Paused time does not count. The time is null until the last
 * event of the unit is terminal, and null for an open interval or a bad boundary.
 */
export function stageActiveMs(
  events: RunOperationEvent[],
  stage: RunOperationEvent["stage"],
  unitId: string,
): number | null {
  let total = 0,
    from: number | null = null,
    last: RunOperationEvent | undefined;
  for (const event of events) {
    if (event.stage !== stage || event.unitId !== unitId) continue;
    last = event;
    const at = Date.parse(event.at);
    if (event.kind === "started") {
      if (from !== null || !Number.isFinite(at)) return null;
      from = at;
    } else if (closingKinds.has(event.kind)) {
      if (from === null || !Number.isFinite(at) || at < from) return null;
      total += at - from;
      from = null;
    }
  }
  return last && terminalKinds.has(last.kind) ? total : null;
}

/** Elapsed stage clocks include failures; unresolved or absent boundaries are not fabricated. */
export function benchmarkStageTiming(
  events: RunOperationEvent[],
  stage: BenchmarkStageTiming["stage"],
  plannedUnitIds: string[],
): BenchmarkStageTiming {
  if (new Set(plannedUnitIds).size !== plannedUnitIds.length)
    throw new Error("Duplicate planned stage unit");
  const planned = new Set(plannedUnitIds);
  const byUnit = new Map<string, RunOperationEvent[]>();
  for (const event of events)
    if (event.stage === stage && event.unitId !== null && planned.has(event.unitId)) {
      if (!byUnit.has(event.unitId)) byUnit.set(event.unitId, []);
      byUnit.get(event.unitId)!.push(event);
    }
  const values: Array<number | null> = [];
  let terminalUnits = 0,
    failedUnits = 0,
    censoredUnits = 0,
    missingBoundaries = 0;
  for (const id of plannedUnitIds) {
    const records = byUnit.get(id) ?? [];
    const last = records.at(-1);
    if (last?.kind !== "completed" && last?.kind !== "failed") {
      if (records.some((event) => event.kind === "started")) censoredUnits++;
      else missingBoundaries++;
      values.push(null);
      continue;
    }
    terminalUnits++;
    if (last.kind === "failed") failedUnits++;
    const active = stageActiveMs(records, stage, id);
    if (active === null) missingBoundaries++;
    values.push(active);
  }
  return {
    stage,
    elapsedMs: benchmarkDistribution(values),
    terminalUnits,
    failedUnits,
    censoredUnits,
    missingBoundaries,
  };
}
