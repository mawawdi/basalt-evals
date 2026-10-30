import type { HarnessDefinition } from "../../contracts/src/index.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { freezeNotesPack, loadNotesPack, sharesShingle } from "../../agent-runtime/src/notes.js";

/** The private parts of an evaluation that a notes pack must not repeat. */
type PrivateEvaluation = Pick<EvalRevision, "privateEvaluator"> & {
  authored: Pick<EvalRevision["authored"], "rubric">;
};

/** The private text of an evaluation: the rubric, the private criteria and the Studio plan. */
function privateTexts(revision: PrivateEvaluation): string[] {
  const texts = [revision.authored.rubric];
  const visit = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(revision.privateEvaluator);
  return texts;
}

/**
 * Check the API notes packs of the selected harnesses against one evaluation. A pack must have a
 * person's review, and it must share no run of 12 words with the private text of the evaluation.
 * With `freeze`, each checked pack is copied to `.basalt-evals/notes-packs/<hash>/`.
 */
export async function checkNotesPacks(input: {
  root: string;
  harnesses: HarnessDefinition[];
  revision: PrivateEvaluation;
  freeze: boolean;
}): Promise<void> {
  const packs = new Map(
    input.harnesses.flatMap((harness) =>
      harness.notesPack ? [[harness.notesPack.hash, harness.notesPack] as const] : [],
    ),
  );
  for (const reference of packs.values()) {
    const pack = await loadNotesPack(input.root, reference.id);
    if (pack.hash !== reference.hash)
      throw new Error(
        `The API notes pack ${reference.id} changed after the tool set was read. Preview the run again.`,
      );
    if (pack.manifest.review !== "person_reviewed")
      throw new Error(
        `The API notes pack ${reference.id} needs a person's review. Read its files, then set its review to person_reviewed.`,
      );
    if (
      sharesShingle(
        pack.files.map((file) => file.text),
        privateTexts(input.revision),
      )
    )
      throw new Error(
        `The API notes pack ${reference.id} repeats text from the private criteria or the Studio plan of this evaluation. Edit the pack, or choose another tool set.`,
      );
    if (input.freeze) await freezeNotesPack(input.root, reference);
  }
}
