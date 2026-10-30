import { hashJson } from "../../contracts/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { authoringActionResult } from "./authoring-operation.js";
import { textDraft } from "./prepare-draft.js";
import { createEvalDraft } from "../../eval-authoring/src/input.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { evaluationIdentity, saveLibraryDraft } from "../../eval-authoring/src/library.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { EvalValidation } from "../../eval-authoring/src/compiler.js";

/** Questions bind to retained preparation diagnostics, never browser-generated evaluator instructions. */
export async function authoringClarifications(root: string, operationId: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId))
    throw new Error("Invalid operation identity");
  const saved = await authoringActionResult(root, operationId),
    draft = await textDraft(root, saved.action.draftId);
  const result = saved.result as { validation?: EvalValidation } | null;
  return {
    operationId,
    draftId: draft.id,
    questions: (result?.validation?.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.code === "authority_conflict")
      .map((diagnostic) => {
        // An authored criterion ID is unique only in its stage.
        const criterion = draft.stages[diagnostic.stage - 1]?.criteria.find(
          (criterion) => criterion.id === diagnostic.authoredCriterionId,
        );
        const body = {
          operationId,
          draftId: draft.id,
          resultHash: saved.resultHash,
          message: diagnostic.message,
          stage: diagnostic.stage,
          passage: criterion
            ? { start: criterion.start, end: criterion.end, text: criterion.text }
            : null,
        };
        return { ...body, id: hashJson(body) };
      }),
  };
}

export async function answerAuthoringClarification(root: string, draftId: string, input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "answer,evaluationId,operationId,questionId,stages,title"
  )
    throw new Error("Clarification needs its saved question, authored answer, and edited stages");
  const value = input as {
    answer: string;
    evaluationId: string;
    operationId: string;
    questionId: string;
    stages: unknown;
    title: string | null;
  };
  evaluationIdentity(value.evaluationId);
  if (
    typeof value.answer !== "string" ||
    !value.answer.trim() ||
    value.answer.length > 4000 ||
    (value.title !== null && typeof value.title !== "string")
  )
    throw new Error("Clarification answer must be bounded authored text");
  const questions = await authoringClarifications(root, value.operationId),
    question = questions.questions.find((question) => question.id === value.questionId);
  if (!question || questions.draftId !== draftId)
    throw new Error("Question does not belong to this authored draft");
  const original = await textDraft(root, draftId);
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: value.stages,
    ...(value.title === null ? {} : { title: value.title }),
  });
  if (hashJson(draft.input.stages) === hashJson(original.input.stages))
    throw new Error(
      "Incorporate the clarification in the authored prompt or rubric before preparing it",
    );
  await new EvalDefinitionStore(root).writeDraft(draft);
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() =>
      saveLibraryDraft(journal, {
        id: value.evaluationId,
        draftId: draft.id,
        expectedDraftId: original.id,
      }),
    );
  } finally {
    journal.close();
  }
  const body = {
      question,
      answer: value.answer,
      originalDraftId: draftId,
      editedDraftId: draft.id,
      authorship: "human",
    },
    receipt = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(root),
    path = `.basalt-evals/clarifications/${receipt.id}.json`;
  try {
    await files.writeJson(path, receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(receipt))
      throw new Error("Clarification receipt changed");
  }
  return { draft, receipt };
}
