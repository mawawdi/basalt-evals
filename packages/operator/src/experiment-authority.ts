import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import type { ProtocolEvidence } from "../../experiments/src/controller.js";
import type { Presentation, StudySource } from "../../experiments/src/protocols.js";
import type { RegisteredExperiment } from "./experiment-plan.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import { frozenRunStatus } from "./run-builder.js";
import { readRegisteredSource } from "./sources.js";

/** Called by quotation and freeze; a hash-shaped string cannot substitute for a sealed decision. */
export async function verifyExperimentAuthority(root: string, registered: RegisteredExperiment) {
  const { plan, selectionAuthority } = registered;
  if (plan.kind === "detector_calibration") {
    if (selectionAuthority !== null || plan.configuration.presentationSelectionHash !== null)
      throw new Error("Calibration cannot inherit a later presentation choice");
    return null;
  }
  if (
    !selectionAuthority ||
    selectionAuthority.receiptHash !== plan.configuration.presentationSelectionHash
  )
    throw new Error("Experiment needs the exact prior presentation receipt");
  const status = await frozenRunStatus(root, selectionAuthority.operationId);
  if (status.manifest.protocol?.kind !== "detector_calibration")
    throw new Error("Presentation authority must come from detector development selection");
  const event = status.events.find(
    (event) =>
      event.stage === "selection" &&
      event.unitId === "presentation-selection" &&
      event.kind === "completed",
  );
  if (!event || event.artifactHashes[0] !== selectionAuthority.receiptHash)
    throw new Error("Presentation selection was not durably sealed");
  const receipt = await new RepositoryFiles(root).json<{
    decision: { selection: { id: Presentation; calibration: "eligible" | "provisional" } };
    evidence: ProtocolEvidence;
  }>(`.basalt-evals/eval-operations/${status.manifest.id}/gates/presentation-selection.json`);
  if (hashJson(receipt) !== selectionAuthority.receiptHash)
    throw new Error("Presentation decision bytes changed");
  const selection = receipt.decision.selection;
  if (plan.judgments.some((judgment) => judgment.presentation !== selection.id))
    throw new Error("Experiment changed the development-selected presentation");
  const detector = await readRegisteredExperiment(root, status.manifest.protocol.registrationId);
  const retained = retainedRepairParents(detector, receipt.evidence);
  if (plan.kind === "repair_discovery") {
    const requested = [...new Set(plan.builders.map((builder) => builder.evalId))];
    if (
      requested.some(
        (id) =>
          !detector.evaluations.some((evaluation) => evaluation.id === id) ||
          retained.some((source) => source.evalId === id),
      )
    )
      throw new Error(
        "Discovery is allowed only for detector tasks without an eligible retained generated defect",
      );
    for (const evaluation of registered.evaluations) {
      const original = detector.evaluations.find((item) => item.id === evaluation.id)!;
      if (
        evaluation.validationRecordHash !== original.validationRecordHash ||
        hashJson(evaluation.views) !==
          hashJson(original.views.filter((view) => view.partition === "development"))
      )
        throw new Error(
          "Discovery must preserve the detector's authored eval and development views",
        );
    }
    return selection;
  }
  if (plan.kind === "matched_repair") {
    if (
      plan.configuration.repairSelectionAuthority !==
      (selection.calibration === "eligible" ? "model" : "expert")
    )
      throw new Error("Provisional grading requires expert repair selection");
    const population = registered.repairPopulation;
    if (
      !population ||
      hashJson(population.map((item) => item.evalId).sort()) !==
        hashJson(detector.evaluations.map((item) => item.id).sort())
    )
      throw new Error(
        "Repair must account for every detector task, including inconclusive searches",
      );
    const selectedParents: StudySource[] = [];
    for (const evaluation of detector.evaluations) {
      const item = population.find((item) => item.evalId === evaluation.id)!;
      const existing = retained.find((source) => source.evalId === evaluation.id);
      if (existing) {
        if (
          item.outcome !== "retained_parent" ||
          item.parentId !== existing.id ||
          item.discovery !== null ||
          registered.sourceBindings[existing.id] !== detector.sourceBindings[existing.id]
        )
          throw new Error(
            "Retained repair parent must be the first expert-confirmed generated defect",
          );
        selectedParents.push(existing);
        continue;
      }
      if (!item.discovery)
        throw new Error("An absent retained defect requires the one predeclared discovery block");
      const discovery = await readDiscoverySelection(root, item.discovery);
      if (hashJson(discovery.registration.selectionAuthority) !== hashJson(selectionAuthority))
        throw new Error("Discovery belongs to a different detector selection");
      const outcome = discovery.tasks.find((task) => task.evalId === evaluation.id);
      if (!outcome) throw new Error("Discovery did not include this task");
      if (outcome.outcome === "inconclusive") {
        if (item.outcome !== "inconclusive" || item.parentId !== null)
          throw new Error("Inconclusive discovery cannot supply a repair parent");
      } else {
        if (
          item.outcome !== "discovered_parent" ||
          item.parentId !== outcome.selectedBuilderId ||
          !outcome.sourceHash
        )
          throw new Error("Repair changed the discovery-selected parent");
        const sourceId = registered.sourceBindings[outcome.selectedBuilderId!];
        if (!sourceId) throw new Error("Discovery parent lacks its saved source identity");
        const { source } = await readRegisteredSource(root, sourceId);
        const subjectId = discovery.manifest.protocol!.subjectBindings[outcome.selectedBuilderId!];
        const built = discovery.events.find(
          (event) =>
            event.stage === "builder" && event.kind === "completed" && event.unitId === subjectId,
        );
        if (
          !built ||
          source.provenance.kind !== "generated" ||
          source.candidate.rootHash !== outcome.sourceHash ||
          hashJson(source.provenance.evidenceHashes) !==
            hashJson([hashJson(discovery.manifest), built.id]) ||
          source.provenance.parentSourceId !== null
        )
          throw new Error("Discovery parent source lacks the exact sealed generation lineage");
        selectedParents.push({
          id: outcome.selectedBuilderId!,
          evalId: evaluation.id,
          kind: "generated",
          sourceHash: outcome.sourceHash,
          targetCriterionIds: [],
        });
      }
    }
    if (hashJson(plan.sources) !== hashJson(selectedParents))
      throw new Error(
        "Repair parents must follow frozen generated-source order and expert-confirmed development defects; discovery is required when none qualify",
      );
  }
  return selection;
}

export function retainedRepairParents(detector: RegisteredExperiment, evidence: ProtocolEvidence) {
  return detector.evaluations.flatMap((evaluation) => {
    const required = evidence.requiredCriteria[evaluation.id]!;
    const first = detector.plan.sources.find(
      (source) =>
        source.evalId === evaluation.id &&
        source.kind === "generated" &&
        detector.plan.captures.some(
          (capture) =>
            capture.subjectId === source.id &&
            capture.partition === "development" &&
            evidence.captures.some(
              (result) => result.id === capture.id && result.state === "completed",
            ) &&
            evidence.reviews.some(
              (review) =>
                review.captureId === capture.id &&
                review.blindingIssue === null &&
                required.some((id) => review.decisions[id] === "violated"),
            ),
        ),
    );
    return first ? [first] : [];
  });
}

export async function readDiscoverySelection(
  root: string,
  authority: { operationId: string; receiptHash: string },
) {
  const status = await frozenRunStatus(root, authority.operationId);
  if (status.manifest.protocol?.kind !== "repair_discovery")
    throw new Error("Parent selection requires a discovery operation");
  const event = status.events.find(
    (event) =>
      event.kind === "completed" &&
      event.stage === "selection" &&
      event.unitId === "parent-selection",
  );
  if (event?.artifactHashes[0] !== authority.receiptHash)
    throw new Error("Discovery selection was not sealed");
  const receipt = await new RepositoryFiles(root).json<{
    decision: {
      tasks: Array<{
        evalId: string;
        outcome: "eligible" | "inconclusive";
        selectedBuilderId: string | null;
        sourceHash: string | null;
      }>;
    };
  }>(`.basalt-evals/eval-operations/${authority.operationId}/gates/parent-selection.json`);
  if (hashJson(receipt) !== authority.receiptHash)
    throw new Error("Discovery selection bytes changed");
  return {
    tasks: receipt.decision.tasks,
    registration: await readRegisteredExperiment(root, status.manifest.protocol.registrationId),
    manifest: status.manifest,
    events: status.events,
  };
}
