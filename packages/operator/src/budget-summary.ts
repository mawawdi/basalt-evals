import type { BudgetSummary, SpendLedgerState } from "../../contracts/src/execution.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { stageTitle } from "../../contracts/src/display.js";

export function budgetSummary(journal?: OperationJournal, scope?: string): BudgetSummary {
  const samples =
    journal && scope ? journal.read<Record<string, number>>("measured_costs", scope) : null;
  const values = Object.values(samples ?? {}).sort((a, b) => a - b);
  if (values.length)
    return {
      history: {
        count: values.length,
        minimumUsd: values[0]!,
        maximumUsd: values.at(-1)!,
        medianUsd:
          values.length % 2
            ? values[Math.floor(values.length / 2)]!
            : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2,
      },
      note: "Basalt measured these costs in completed runs with the same evaluations, models, provider settings, preparation reuse and workload. A past cost does not guarantee that a run will complete.",
    };
  return {
    history: null,
    note: "Basalt has no measured cost for this setup.",
  };
}

export function spendingDetails(journal: OperationJournal, operationId: string) {
  const state = journal.read<SpendLedgerState>("spending", operationId);
  if (!state) {
    if (
      journal.read("workflows", operationId) &&
      !journal.read("authoring_progress", operationId) &&
      !journal.read("run_starts", operationId) &&
      !journal.read("operation_progress", operationId) &&
      !journal.read("assessment_progress", operationId) &&
      !journal.read("comparison_progress", operationId)
    )
      return [];
    throw new Error("Basalt has no spending record for this run.");
  }
  const run = journal.read<import("../../contracts/src/execution.js").RunOperationStatus>(
    "operations",
    operationId,
  );
  const groups = new Map<string, import("../../contracts/src/console.js").SpendingDetail>();
  const add = (key: string, name: string) => {
    if (!groups.has(key)) groups.set(key, { id: key, name, chargedUsd: 0, pendingUsd: 0 });
    return groups.get(key)!;
  };
  for (const subject of run?.manifest.subjects ?? []) {
    if (!subject.builder) continue;
    // The catalog knows a staged evaluation by its first stage.
    const stage = run!.manifest.evals.find((item) => item.id === subject.evalId)!.stage;
    const title = stageTitle(
      journal.read<import("../../contracts/src/catalog.js").EvaluationSummary>(
        "catalog_evaluations",
        stage.firstRevisionId,
      )?.title ?? "Evaluation",
      stage,
    );
    add("builder:" + subject.id, title + " · " + subject.builder.model.id);
  }
  for (const entry of state.entries) {
    const key = entry.stage.startsWith("builder:")
      ? entry.stage
      : entry.stage.startsWith("judgment:") || entry.stage.startsWith("grading:")
        ? "checking"
        : "preparation";
    const row = add(key, key === "preparation" ? "Preparation and supporting work" : "Checks");
    row.chargedUsd += entry.billedUsd ?? 0;
    if (entry.status !== "billed") row.pendingUsd += entry.reservedUsd;
  }
  return [...groups.values()];
}
