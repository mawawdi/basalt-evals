import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { hash } from "../../contracts/src/validation.js";
import type {
  SavedEvalRunQuote,
  SavedExperimentRunQuote,
  SavedStageRunQuote,
} from "../../contracts/src/execution.js";
import type { SavedSelectionRunQuote } from "../../contracts/src/suites.js";

type SavedRunQuote =
  SavedEvalRunQuote | SavedExperimentRunQuote | SavedSelectionRunQuote | SavedStageRunQuote;

export async function readRunQuote(root: string, id: string): Promise<SavedRunQuote> {
  hash(id);
  const saved = await new RepositoryFiles(root).json<SavedRunQuote>(
    `.basalt-evals/eval-run-quotes/${id}.json`,
  );
  const { id: savedId, ...body } = saved;
  const { id: quoteId, ...quoteBody } = saved.quote;
  if (
    savedId !== id ||
    hashJson(body) !== id ||
    saved.schema !== "basalt-evals/saved-run-quote" ||
    !["eval", "selection", "stages", "experiment"].includes(saved.kind) ||
    hashJson(quoteBody) !== quoteId
  )
    throw new Error("Saved run quote changed");
  return saved;
}
