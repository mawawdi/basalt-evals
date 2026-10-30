import { unresolvedFailures } from "../../artifact-store/src/failures.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import type { CauseUnits, RunCauses } from "../../contracts/src/failure.js";
import {
  attributeOutcomes,
  countCauses,
  type OutcomeAttribution,
} from "../../experiments/src/outcome-causes.js";
import { buildTitle } from "./model-registry.js";
import { unitSubjectId } from "./run-manifest.js";

/** The recorded cause of each unit of the run that did not finish. */
export async function operationAttributions(
  root: string,
  status: RunOperationStatus,
): Promise<OutcomeAttribution[]> {
  const journal = await OperationJournal.open(root);
  try {
    return attributeOutcomes(status.events, unresolvedFailures(journal, status.manifest.id));
  } finally {
    journal.close();
  }
}

/** The units of the run that did not finish, by cause. Each unit names its build. */
export async function operationCauses(
  root: string,
  status: RunOperationStatus,
): Promise<CauseUnits[]> {
  return countCauses(await operationAttributions(root, status), (unit) =>
    unitSubjectId(status.manifest, unit),
  );
}

/** The causes of a run for the console, with the title of each build, as Activity names it. */
export async function runCauses(root: string, status: RunOperationStatus): Promise<RunCauses> {
  const causes = await operationCauses(root, status);
  const named = new Set(causes.flatMap(({ units }) => units.map((unit) => unit.subjectId)));
  return {
    causes,
    buildTitles: Object.fromEntries(
      status.manifest.subjects.flatMap((subject) =>
        named.has(subject.id) ? [[subject.id, buildTitle(status.manifest, subject)]] : [],
      ),
    ),
  };
}
