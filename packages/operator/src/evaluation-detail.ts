import { readReadinessRecord, stageRecordHashes } from "../../eval-authoring/src/registration.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { evaluationSummary } from "./discovery.js";

/**
 * The stages of an evaluation in the catalog and the readiness record hash of each stage, in
 * stage order, from the record of stage 1 in the catalog. Null when the catalog has no record:
 * the evaluation is not ready to run, and each caller says so in the words of its action.
 */
export async function catalogStageRecords(root: string, revisionId: string, executable = false) {
  const summary = await evaluationSummary(root, revisionId);
  if (!summary?.validationRecordHash) return null;
  const stages = await new EvalDefinitionStore(root).readStageRevisions(revisionId, executable);
  return { stages, records: await stageRecordHashes(root, stages, summary.validationRecordHash) };
}

/**
 * The reference test check of each stage of an evaluation, in stage order. Null when the
 * evaluation has no checked reference test.
 */
export async function evaluationControls(root: string, id: string) {
  const summary = await evaluationSummary(root, id);
  if (!summary?.validationRecordHash) return null;
  // The records of the stages of one evaluation have one status, so stage 1 tells if each stage
  // has a check. A record without a check needs no chain, so this comes before the chain.
  const first = await readReadinessRecord(root, id, summary.validationRecordHash);
  if (first.check === null) return null;
  const stages = await new EvalDefinitionStore(root).readStageRevisions(id);
  const hashes = await stageRecordHashes(root, stages, summary.validationRecordHash);
  const later = await Promise.all(
    stages.slice(1).map((stage, index) => readReadinessRecord(root, stage.id, hashes[index + 1]!)),
  );
  return [first, ...later].map(({ check }) => {
    if (!check) throw new Error("A checked evaluation has a stage without a reference test");
    return check;
  });
}
