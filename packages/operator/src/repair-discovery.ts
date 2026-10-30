import { hashJson } from "../../contracts/src/index.js";
import { readModelRegistry } from "./model-registry.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import {
  planRepairDiscovery,
  type Presentation,
  type StudySource,
} from "../../experiments/src/protocols.js";
import type { ProtocolEvidence } from "../../experiments/src/controller.js";
import { frozenRunStatus } from "./run-builder.js";
import {
  readRegisteredExperiment,
  registerExperiment,
  type RegisteredExperiment,
} from "./experiment-plan.js";
import { readDiscoverySelection, retainedRepairParents } from "./experiment-authority.js";
import { registerSavedSubject } from "./replay.js";
import { defaultHarness } from "./config.js";

async function detectorSelection(root: string, operationId: string) {
  const status = await frozenRunStatus(root, operationId);
  if (status.manifest.protocol?.kind !== "detector_calibration")
    throw new Error("Repair discovery starts from a detector operation");
  const event = status.events.find(
    (event) =>
      event.stage === "selection" &&
      event.unitId === "presentation-selection" &&
      event.kind === "completed",
  );
  if (!event)
    throw new Error("Complete development review and seal the detector presentation first");
  const receipt = await new RepositoryFiles(root).json<{
    evidence: ProtocolEvidence;
    decision: { selection: { id: Presentation; calibration: "eligible" | "provisional" } };
  }>(`.basalt-evals/eval-operations/${operationId}/gates/presentation-selection.json`);
  if (hashJson(receipt) !== event.artifactHashes[0]) throw new Error("Detector selection changed");
  const registered = await readRegisteredExperiment(root, status.manifest.protocol.registrationId);
  return { registered, receipt, authority: { operationId, receiptHash: hashJson(receipt) } };
}

/** Registers an executable plan through the same service; it does not dispatch or choose a ceiling. */
export async function prepareRepairDiscovery(
  root: string,
  detectorOperationId: string,
  seed: number,
) {
  const { registered, receipt, authority } = await detectorSelection(root, detectorOperationId);
  const retained = retainedRepairParents(registered, receipt.evidence);
  const affected = registered.evaluations.filter(
    (evaluation) => !retained.some((source) => source.evalId === evaluation.id),
  );
  if (!affected.length)
    throw new Error("Every task already has an eligible retained generated defect");
  const journal = await OperationJournal.open(root);
  try {
    const prior = affected
      .map((evaluation) =>
        journal.read<{ operationId: string }>(
          "repair_discovery_blocks",
          hashJson([authority, evaluation.id]),
        ),
      )
      .filter((value) => value !== null);
    if (prior.length)
      throw new Error(
        "Discovery is already frozen; continue saved operation " +
          [...new Set(prior.map((value) => value!.operationId))].join(", "),
      );
  } finally {
    journal.close();
  }
  const views = affected[0]!.views
    .filter((view) => view.partition === "development")
    .map(({ id, partition }) => ({ id, partition }));
  return registerExperiment(root, {
    reviewer: registered.reviewer,
    plan: planRepairDiscovery({
      evalIds: affected.map((evaluation) => evaluation.id),
      // The default builders of the Models page. Discovery compares two of them.
      builderModelIds: (await readModelRegistry(root)).defaults.builderModelIds,
      harness: await defaultHarness(root),
      views,
      presentation: receipt.decision.selection.id,
      presentationSelectionHash: authority.receiptHash,
      seed,
    }),
    evaluations: affected.map((evaluation) => ({
      ...evaluation,
      views: evaluation.views.filter((view) => view.partition === "development"),
    })),
    sourceBindings: {},
    publicFeedbackBindings: {},
    selectionAuthority: authority,
    repairPopulation: null,
  });
}

/** Includes inconclusive tasks; an empty population cannot be presented as an executed repair study. */
export async function inspectRepairPopulation(root: string, detectorOperationId: string) {
  const { registered, receipt, authority } = await detectorSelection(root, detectorOperationId);
  const retained = retainedRepairParents(registered, receipt.evidence),
    parents: StudySource[] = [],
    sourceBindings: Record<string, string> = {};
  const population: NonNullable<RegisteredExperiment["repairPopulation"]> = [];
  const pending: Array<{ evalId: string; operationId: string | null }> = [];
  for (const evaluation of registered.evaluations) {
    const existing = retained.find((source) => source.evalId === evaluation.id);
    if (existing) {
      parents.push(existing);
      sourceBindings[existing.id] = registered.sourceBindings[existing.id]!;
      population.push({
        evalId: evaluation.id,
        outcome: "retained_parent",
        parentId: existing.id,
        discovery: null,
      });
      continue;
    }
    const journal = await OperationJournal.open(root);
    let block: { operationId: string } | null;
    try {
      block = journal.read("repair_discovery_blocks", hashJson([authority, evaluation.id]));
    } finally {
      journal.close();
    }
    if (!block) {
      pending.push({ evalId: evaluation.id, operationId: null });
      continue;
    }
    const status = await frozenRunStatus(root, block.operationId);
    const selected = status.events.find(
      (event) =>
        event.stage === "selection" &&
        event.unitId === "parent-selection" &&
        event.kind === "completed",
    );
    if (!selected) {
      pending.push({ evalId: evaluation.id, operationId: block.operationId });
      continue;
    }
    const discovery = { operationId: block.operationId, receiptHash: selected.artifactHashes[0]! };
    const found = await readDiscoverySelection(root, discovery),
      task = found.tasks.find((task) => task.evalId === evaluation.id);
    if (!task) throw new Error("Frozen discovery omitted its intended task");
    if (task.outcome === "inconclusive")
      population.push({
        evalId: evaluation.id,
        outcome: "inconclusive",
        parentId: null,
        discovery,
      });
    else {
      const { saved } = await registerSavedSubject({
        root,
        operationId: block.operationId,
        subjectId: found.manifest.protocol!.subjectBindings[task.selectedBuilderId!]!,
      });
      if (saved.candidate.rootHash !== task.sourceHash)
        throw new Error("Discovered source differs from its selection receipt");
      parents.push({
        id: task.selectedBuilderId!,
        evalId: evaluation.id,
        kind: "generated",
        sourceHash: task.sourceHash!,
        targetCriterionIds: [],
      });
      sourceBindings[task.selectedBuilderId!] = saved.id;
      population.push({
        evalId: evaluation.id,
        outcome: "discovered_parent",
        parentId: task.selectedBuilderId,
        discovery,
      });
    }
  }
  const body = {
    detectorOperationId,
    selectionAuthority: authority,
    intendedTasks: registered.evaluations.map((evaluation) => evaluation.id),
    status: pending.length
      ? "awaiting_discovery"
      : parents.length
        ? "parents_selected"
        : "inconclusive",
    parents,
    sourceBindings,
    population,
    pending,
  };
  const record = { ...body, id: hashJson(body) },
    files = new RepositoryFiles(root),
    path = `.basalt-evals/repair-populations/${record.id}.json`;
  try {
    await files.writeJson(path, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(record))
      throw new Error("Repair population changed");
  }
  return record;
}
