import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { compareCodeUnits, hashJson, type AgentRun } from "../../contracts/src/index.js";
import type { BenchmarkReport } from "../../contracts/src/benchmarks.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import type { BuildFacts, BuildStop, ModelReport } from "../../contracts/src/model-report.js";
import { modelReport } from "../../experiments/src/model-report.js";
import { benchmarkReport } from "./benchmarks.js";
import { buildCodeFacts, reportSourceAnalyses } from "./build-code-facts.js";
import { frozenRunRecords, type FrozenRunReader } from "./run-records.js";
import { notReachedSubjects } from "./stage-reach.js";

const OUTSIDE_STOPS = new Set<AgentRun["stopReason"]>([
  "provider_error",
  "spending_limit",
  "cancelled",
]);

/**
 * How a saved build stage ended. A stop outside the model comes first, so a gate that rejects
 * the code of a build that the provider stopped does not count against the model. A stop of
 * the model comes next. A finished build that the gate did not accept or reject stopped for a
 * cause in the environment.
 */
export function buildStopOf(run: Pick<AgentRun, "status" | "stopReason">): BuildStop {
  if (run.status === "locally_eligible") return "delivered";
  if (OUTSIDE_STOPS.has(run.stopReason)) return run.stopReason as BuildStop;
  if (run.stopReason !== "finished") return run.stopReason;
  return run.status === "rejected" ? "local_gate_rejected" : "environment";
}

/** The facts of the saved trace of one build. It reads only names, counts and check results. */
export function runFacts(run: Pick<AgentRun, "trace">): NonNullable<BuildFacts["run"]> {
  const gate = [...run.trace].reverse().find((event) => event.kind === "gate");
  const gateFailures = Array.isArray(gate?.data.checks)
    ? gate.data.checks.flatMap((check) =>
        check && typeof check === "object" && !Array.isArray(check) && check.outcome === "fail"
          ? [String(check.name)]
          : [],
      )
    : [];
  const failed = new Map<string, number>();
  // A stop records a tool result without `ok`, so only a result that says it failed counts.
  for (const event of run.trace)
    if (event.kind === "tool_result" && event.data.ok === false) {
      const tool = String(event.data.name);
      failed.set(tool, (failed.get(tool) ?? 0) + 1);
    }
  return {
    gateFailures: [...new Set(gateFailures)].sort(compareCodeUnits),
    failedToolCalls: [...failed.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([tool, calls]) => ({ tool, calls })),
    refusedBatches: run.trace.filter((event) => event.kind === "tool_rejection").length,
  };
}

/**
 * The saved facts of each generated build of a run. Each fact reads the journal events of the
 * build and the saved run that its terminal event binds by hash. The lint codes and the script
 * errors come from the stored source analysis of the sealed code of that run. The report makes
 * no analysis, so a build without a stored analysis has no lint codes and no script errors.
 */
export async function buildFacts(root: string, status: RunOperationStatus): Promise<BuildFacts[]> {
  const files = new RepositoryFiles(root);
  const analyses = await reportSourceAnalyses(root);
  const notReached = notReachedSubjects(status.events);
  const terminal = new Map<string, RunOperationStatus["events"][number]>();
  for (const event of status.events)
    if (
      event.stage === "builder" &&
      event.unitId &&
      ["completed", "failed", "incomplete"].includes(event.kind)
    )
      terminal.set(event.unitId, event);
  const facts: BuildFacts[] = [];
  for (const subject of status.manifest.subjects) {
    if (subject.kind !== "generated" || !subject.builder) continue;
    const base = { subjectId: subject.id, lint: null, scriptErrors: null };
    const event = terminal.get(subject.id);
    if (notReached.has(subject.id) || !event) {
      facts.push({
        ...base,
        stop: notReached.has(subject.id) ? "not_reached" : "not_finished",
        run: null,
      });
      continue;
    }
    const run = event.artifactHashes.length
      ? await files
          .optional<AgentRun>(
            `.basalt-evals/eval-operations/${status.manifest.id}/builder/${subject.id}/agent-run.json`,
          )
          .catch(() => null)
      : null;
    const bound = run && event.artifactHashes.includes(hashJson(run)) ? run : null;
    const code = bound
      ? await buildCodeFacts(root, status, subject.id, bound.candidate, analyses)
      : null;
    facts.push({
      ...base,
      lint: code?.lint ?? null,
      scriptErrors: code?.scriptErrors ?? null,
      stop: bound
        ? buildStopOf(bound)
        : event.kind === "completed"
          ? "delivered"
          : event.reason === "local_gate_rejected"
            ? "local_gate_rejected"
            : "unrecorded",
      run: bound ? runFacts(bound) : null,
    });
  }
  return facts;
}

/** The model report of a run from its benchmark report and its saved builds. */
export async function modelReportOf(
  root: string,
  report: BenchmarkReport,
  status: RunOperationStatus,
): Promise<ModelReport> {
  return modelReport({
    report,
    builds: await buildFacts(root, status),
    judgeModelIds: [
      ...new Set(status.manifest.judgmentBatches.map((batch) => batch.configuration.modelId)),
    ],
  });
}

/** The model report of one run. It reads saved records only and makes no model request. */
export async function operationModelReport(
  root: string,
  id: string,
  runRecords: FrozenRunReader = frozenRunRecords(root),
): Promise<ModelReport> {
  const report = await benchmarkReport(root, id, runRecords);
  return modelReportOf(root, report, (await runRecords(id)).status);
}
