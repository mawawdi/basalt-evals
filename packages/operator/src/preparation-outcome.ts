import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { AuthoringProgress } from "../../contracts/src/execution.js";
import type { PreparationProblem } from "../../contracts/src/console.js";
import type { PreparationReuse } from "../../eval-authoring/src/preparation-base.js";

/** Disposable projection of an already hash-verified authoring receipt. */
export function projectPreparationOutcome(
  journal: OperationJournal,
  progress: AuthoringProgress,
  result: unknown,
) {
  if (progress.action.stage !== "preparation") return;
  const receipt = result as {
    schema?: string;
    revisionId?: string | null;
    reuse?: PreparationReuse | null;
    validation?: {
      status: string;
      diagnostics: Array<{
        code: string;
        message: string;
        stage: number;
        authoredCriterionId: string | null;
      }>;
    };
  } | null;
  if (receipt?.schema !== "basalt-evals/preparation-receipt" || !receipt.validation) return;
  const { status, diagnostics } = receipt.validation;
  const gate = diagnostics.find((item) => item.code === "gate_fixed_state_sample");
  const problem: PreparationProblem | null =
    status === "ready"
      ? null
      : {
          status,
          explanation:
            status === "needs_clarification"
              ? "Some success criteria are not clear. Edit the evaluation to make the criteria clear."
              : status === "unsupported"
                ? "Basalt cannot collect the evidence that these success criteria need. Edit the evaluation to change the criteria."
                : gate
                  ? `${gateName(gate)} is a gate, and it checks a value at one moment, such as when Play starts. Code can’t check that fairly, because a correct build can create the value a little later. Change the gate to something that happens after an action, for example “the score rises by 1 when a player touches the button”. No build started.`
                  : "Basalt couldn’t turn your success criteria into checks, so no build started.",
          diagnostics: diagnostics.map((item) => item.message),
        };
  journal.put("preparation_outcomes", progress.action.id, { problem });
  if (receipt.revisionId && receipt.reuse)
    journal.put("preparation_reuse", receipt.revisionId, receipt.reuse);
}

/** How the preparation of an evaluation used the tests of an earlier version, or null. */
export async function readPreparationReuse(
  root: string,
  revisionId: string,
): Promise<PreparationReuse | null> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<PreparationReuse>("preparation_reuse", revisionId);
  } finally {
    journal.close();
  }
}

/** "Criterion 2 of stage 1" from the authored criterion ID of a gate diagnostic. */
function gateName(item: { stage: number; authoredCriterionId: string | null }): string {
  const number = /^criterion-(\d+)$/u.exec(item.authoredCriterionId ?? "")?.[1];
  return number
    ? `Criterion ${number} of stage ${item.stage}`
    : `A criterion of stage ${item.stage}`;
}

export function preparationProblem(journal: OperationJournal, id: string) {
  const authoring = journal.read<AuthoringProgress>("authoring_progress", id);
  return authoring
    ? (journal.read<{ problem: PreparationProblem | null }>(
        "preparation_outcomes",
        authoring.action.id,
      )?.problem ?? null)
    : null;
}
