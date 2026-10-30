import { OperationJournal } from "../../artifact-store/src/journal.js";
import type {
  BenchmarkCriterionDefinition,
  BenchmarkPlanWarning,
} from "../../contracts/src/benchmarks.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import type { KnownBuildGate } from "../../contracts/src/known-builds.js";
import type { BenchmarkBuildMarks } from "../../experiments/src/benchmark-builds.js";
import { evaluationBuildMarks } from "../../experiments/src/benchmark-projection.js";
import {
  authoredWarningOrder,
  benchmarkPlanRows,
  criterionWarnings,
  type PlanWarningRow,
} from "../../experiments/src/plan-warnings.js";
import { benchmarkAnswers, benchmarkCatalog, emptyBuildRows } from "./benchmarks.js";
import { mapInOrder } from "./concurrency.js";
import { knownBuildGate } from "./known-build-gate.js";
import { frozenRunRecords, type FrozenRunReader } from "./run-records.js";

const idPattern = /^[a-f0-9]{64}$/u;

/** The plan warnings of one evaluation version across all of its benchmark runs. */
interface RevisionPlanWarnings {
  revisionId: string;
  /** The benchmark runs of the version that Basalt read, in the sequence of the run list. */
  runs: Array<{ operationId: string; title: string }>;
  /** The generated builds of the version in each run, with their marks. */
  builds: Array<BenchmarkBuildMarks & { operationId: string }>;
  /** The criteria of the version in authored order, from the first run that has them. */
  criteria: BenchmarkCriterionDefinition[];
  warnings: BenchmarkPlanWarning[];
  /** The runs that Basalt could not read. Their builds give no warning. */
  issues: string[];
  /** The known build gate that the warnings read, or null if Basalt could not read it. */
  gate: KnownBuildGate | null;
}

/**
 * Collect the plan warnings of an evaluation version. The warnings read the generated builds of
 * every benchmark run of the version together, the empty build of the version and the known
 * builds of its gate. A warning never changes an answer.
 */
export async function revisionPlanWarnings(
  root: string,
  revisionId: string,
  runRecords: FrozenRunReader = frozenRunRecords(root),
): Promise<RevisionPlanWarnings> {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  const catalog = (await benchmarkCatalog(root)).filter((entry) => entry.frozen);
  const journal = await OperationJournal.open(root);
  let selected: typeof catalog;
  try {
    selected = catalog.filter((entry) =>
      journal
        .read<RunOperationStatus>("operations", entry.id)
        ?.manifest.evals.some((evaluation) => evaluation.id === revisionId),
    );
  } finally {
    journal.close();
  }
  const runs: RevisionPlanWarnings["runs"] = [];
  const builds: RevisionPlanWarnings["builds"] = [];
  const rows: PlanWarningRow[] = [];
  const issues: string[] = [];
  let criteria: BenchmarkCriterionDefinition[] = [];
  // The warnings read only the answers. The runs are independent, so Basalt reads them at the
  // same time, in the order of the runs.
  const reads = await mapInOrder(selected, 8, (entry) =>
    benchmarkAnswers(root, entry.id, runRecords).then(
      (answers) => ({ entry, answers }),
      (cause: unknown) => ({ entry, cause }),
    ),
  );
  for (const read of reads) {
    try {
      if ("cause" in read) throw read.cause;
      const { status, title, definitions, outcomes } = read.answers;
      const operationId = status.manifest.id;
      const marked = evaluationBuildMarks(status, outcomes, revisionId);
      runs.push({ operationId, title });
      const own = definitions.filter((row) => row.evaluationId === revisionId);
      if (!criteria.length) criteria = own;
      builds.push(...marked.map((build) => ({ ...build, operationId })));
      rows.push(...benchmarkPlanRows(operationId, [{ evaluationId: revisionId, builds: marked }]));
    } catch (cause) {
      issues.push(
        `Run ${read.entry.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  rows.push(...(await emptyBuildRows(root, [revisionId])));
  let gate: KnownBuildGate | null = null;
  try {
    gate = await knownBuildGate(root, revisionId);
    rows.push(...knownBuildRows(revisionId, gate));
  } catch (cause) {
    gate = null;
    issues.push(`Known builds: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    revisionId,
    runs,
    builds,
    criteria,
    warnings: authoredWarningOrder(criterionWarnings(rows), criteria),
    issues,
    gate,
  };
}

/** One row for each definite check answer of each known build of the gate. */
function knownBuildRows(revisionId: string, gate: KnownBuildGate): PlanWarningRow[] {
  const outcome = { met: "met", not_met: "rejected" } as const;
  return gate.results.flatMap((result) =>
    result.checks.flatMap((check) =>
      check.answer === "met" || check.answer === "not_met"
        ? [
            {
              evaluationId: revisionId,
              criterionId: check.criterionId,
              origin: "known_build" as const,
              buildId: result.knownBuildId,
              answer: outcome[check.answer],
              observed: null,
              expectation: outcome[result.expectation],
            },
          ]
        : [],
    ),
  );
}
