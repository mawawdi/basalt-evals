import { OperationJournal } from "../../artifact-store/src/journal.js";
import { authoredCriteria, createEvalDraft } from "../../eval-authoring/src/input.js";
import { fields, hash, launchIdentity } from "../../contracts/src/validation.js";
import {
  MAX_EVAL_STAGES,
  type WorkingCopy,
  type WorkingCopyInput,
} from "../../contracts/src/working-copy.js";
import type { EvaluationLibraryEntry } from "../../contracts/src/catalog.js";
import { hashJson } from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { evaluationIdentity, saveLibraryDraft } from "../../eval-authoring/src/library.js";

export class WorkingCopyConflict extends Error {}

export async function readWorkingCopy(root: string, id: string): Promise<WorkingCopy | null> {
  launchIdentity(id);
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<WorkingCopy>("working_copies", id);
  } finally {
    journal.close();
  }
}

export async function saveWorkingCopy(
  root: string,
  id: string,
  value: unknown,
): Promise<WorkingCopy> {
  launchIdentity(id);
  const row = fields(
    value,
    ["revision", "evaluationId", "baseDraftId", "title", "stages"],
    "Working copy",
  ) as unknown as WorkingCopyInput;
  if (!Number.isSafeInteger(row.revision) || row.revision < 0)
    throw new Error("Invalid working copy revision");
  if (row.evaluationId !== null) evaluationIdentity(row.evaluationId);
  if (row.baseDraftId !== null) hash(row.baseDraftId);
  if ((row.evaluationId === null) !== (row.baseDraftId === null))
    throw new Error("An evaluation working copy requires its exact saved inputs");
  if (typeof row.title !== "string" || Buffer.byteLength(row.title, "utf8") > 480)
    throw new Error("The text in the Title field is longer than 480 bytes. Make the text shorter.");
  if (!Array.isArray(row.stages) || row.stages.length < 1 || row.stages.length > MAX_EVAL_STAGES)
    throw new Error(`An evaluation has 1 to ${MAX_EVAL_STAGES} stages.`);
  row.stages = row.stages.map((stage, index) => {
    const label = row.stages.length > 1 ? `Stage ${index + 1}: ` : "";
    const item = fields(stage, ["prompt", "criteria", "gateCriterionIds"], "Working copy stage");
    for (const key of ["prompt", "criteria"] as const)
      if (typeof item[key] !== "string" || Buffer.byteLength(item[key], "utf8") > 32768)
        throw new Error(
          `${label}The text in the ${key === "prompt" ? "Prompt" : "Success criteria"} field is longer than 32,768 bytes. Make the text shorter.`,
        );
    if (
      !Array.isArray(item.gateCriterionIds) ||
      item.gateCriterionIds.length > 64 ||
      item.gateCriterionIds.some((id) => typeof id !== "string" || !/^criterion-\d{1,2}$/u.test(id))
    )
      throw new Error(`${label}The gate lists criteria that Basalt cannot read.`);
    return {
      prompt: item.prompt as string,
      criteria: item.criteria as string,
      gateCriterionIds: [...new Set(item.gateCriterionIds as string[])],
    };
  });
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<WorkingCopy>("working_copies", id);
      if ((prior?.revision ?? 0) !== row.revision)
        throw new WorkingCopyConflict(
          "Another tab saved a newer version of this draft. Basalt keeps your changes in this editor. Load the saved draft before you make more changes.",
        );
      if (
        prior &&
        (prior.evaluationId !== row.evaluationId || prior.baseDraftId !== row.baseDraftId)
      )
        throw new WorkingCopyConflict(
          "This draft is for a different saved evaluation. Load the saved draft again.",
        );
      if (!prior && row.evaluationId) {
        const entry = journal.read<EvaluationLibraryEntry>("evaluation_library", row.evaluationId);
        if (!entry || entry.archived || entry.draftId !== row.baseDraftId)
          throw new WorkingCopyConflict(
            "This evaluation changed. Open its current version before you edit it.",
          );
      }
      const parsed: WorkingCopy["parsed"] = row.stages.map((stage) => {
        if (!stage.criteria.trim()) return { criteria: [], error: null };
        try {
          return {
            criteria: authoredCriteria(stage.criteria).map(
              ({ id, text, start, end, required }) => ({
                id,
                text,
                start,
                end,
                required,
              }),
            ),
            error: null,
          };
        } catch (error) {
          return { criteria: [], error: error instanceof Error ? error.message : String(error) };
        }
      });
      const saved = {
        ...row,
        id,
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
        parsed,
      };
      journal.put("working_copies", id, saved);
      return saved;
    });
  } finally {
    journal.close();
  }
}

/** Publish a saved editor buffer, guarded against both tab conflicts and other editors. */
export async function publishWorkingCopy(root: string, id: string, value: unknown) {
  launchIdentity(id);
  const input = fields(value, ["revision"], "Publish evaluation");
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1)
    throw new Error(
      "Basalt did not save this draft yet. Wait until Basalt saves the draft. Then save the evaluation again.",
    );
  const copy = await readWorkingCopy(root, id);
  if (!copy || copy.revision !== input.revision)
    throw new WorkingCopyConflict(
      "The draft changed before Basalt saved the evaluation. Save the evaluation again with the latest text.",
    );
  const definitions = new EvalDefinitionStore(root);
  const base = copy.baseDraftId ? await definitions.readDraft(copy.baseDraftId) : null;
  const authored = {
    schema: "basalt-evals/eval-authoring-input" as const,
    stages: copy.stages.map((stage) => ({
      prompt: stage.prompt,
      rubric: stage.criteria,
      ...(stage.gateCriterionIds.length ? { gateCriterionIds: stage.gateCriterionIds } : {}),
    })),
    ...(copy.title.trim() ? { title: copy.title.trim() } : {}),
  };
  const draft =
    base &&
    base.title === copy.title.trim() &&
    hashJson(base.input.stages) === hashJson(authored.stages)
      ? base
      : createEvalDraft(authored);
  await definitions.writeDraft(draft);
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const current = journal.read<WorkingCopy>("working_copies", id);
      if (!current || current.revision !== copy.revision)
        throw new WorkingCopyConflict(
          "The draft changed before Basalt saved the evaluation. Save the evaluation again with the latest text.",
        );
      const evaluationId =
        current.evaluationId ?? "eval-" + hashJson({ workingCopy: id }).slice(0, 32);
      const evaluation = saveLibraryDraft(journal, {
        id: evaluationId,
        draftId: draft.id,
        expectedDraftId: current.baseDraftId,
      });
      const workingCopy: WorkingCopy = { ...current, evaluationId, baseDraftId: draft.id };
      journal.put("working_copies", id, workingCopy);
      return { evaluation, draft, workingCopy };
    });
  } finally {
    journal.close();
  }
}
