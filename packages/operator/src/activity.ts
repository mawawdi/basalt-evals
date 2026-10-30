import type { RunOperationEvent, RunOperationManifest } from "../../contracts/src/execution.js";
import type { ActivityEvent } from "../../contracts/src/console.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { criterionNumbers } from "./benchmarks.js";
import { buildTitle } from "./model-registry.js";
import { savedBuildStop } from "./build-stop.js";

// The manifest of a run is frozen, so the words for its units never change. The process keeps
// the words of the runs that it showed last.
const unitNames = new Map<string, Map<string, string>>();
const keptRuns = 20;

/** "criterion 4", "criteria 1–3" or "criteria 1–3 and 5" for the numbers of a group. */
function criteriaText(numbers: number[]) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    ranges.push(end > start ? `${sorted[start]}–${sorted[end]}` : String(sorted[start]));
    start = end + 1;
  }
  const list =
    ranges.length > 1 ? `${ranges.slice(0, -1).join(", ")} and ${ranges.at(-1)}` : ranges[0];
  return `${sorted.length === 1 ? "criterion" : "criteria"} ${list}`;
}

/**
 * The words for each unit of a run, in the terms of the results table: the build, the
 * observation, the criteria and the judge sample. A criterion has its number in its revision,
 * as the reports show it: its place among all executable criteria, in the authored order.
 */
async function namesOf(root: string, manifest: RunOperationManifest) {
  const names = new Map<string, string>();
  const definitions = new EvalDefinitionStore(root);
  const captures = new Map(manifest.captureCells.map((cell) => [cell.id, cell]));
  const numbers = new Map(
    await Promise.all(
      manifest.evals.map(
        async (evaluation) =>
          [evaluation.id, criterionNumbers(await definitions.readRevision(evaluation.id))] as const,
      ),
    ),
  );
  const samples = new Map<string, number>();
  for (const batch of manifest.judgmentBatches)
    samples.set(batch.sampleGroupId, (samples.get(batch.sampleGroupId) ?? 0) + 1);
  for (const subject of manifest.subjects) {
    const build = buildTitle(manifest, subject);
    names.set(subject.id, build);
    const own = (captureCellId: string) => captures.get(captureCellId)?.treatmentId === subject.id;
    const grading = manifest.gradingCells.filter((cell) => own(cell.captureCellId));
    const judgment = manifest.judgmentBatches.filter((batch) => own(batch.captureCellId));
    const evaluationNumbers = numbers.get(subject.evalId)!;
    const number = (criterionId: string) => evaluationNumbers.get(criterionId)!;
    const observation = (captureCellId: string) =>
      `${build} · observation ${captures.get(captureCellId)!.pass}`;
    for (const cell of manifest.captureCells)
      if (cell.treatmentId === subject.id) names.set(cell.id, observation(cell.id));
    for (const cell of grading)
      names.set(
        cell.id,
        `${observation(cell.captureCellId)} · ${criteriaText([number(cell.criterionId)])}`,
      );
    for (const batch of judgment)
      names.set(
        batch.id,
        [
          observation(batch.captureCellId),
          criteriaText(batch.criterionIds.map(number)),
          ...(samples.get(batch.sampleGroupId)! > 1 ? [`judge sample ${batch.sample}`] : []),
        ].join(" · "),
      );
  }
  return names;
}

async function runUnitNames(root: string, id: string) {
  const kept = unitNames.get(id);
  if (kept) return kept;
  // A run that has not frozen its plan yet has no units to name.
  const manifest = /^[a-z0-9][a-z0-9-]{0,80}$/u.test(id)
    ? await new RepositoryFiles(root).optional<RunOperationManifest>(
        `.basalt-evals/eval-operations/${id}/manifest.json`,
      )
    : null;
  if (!manifest) return new Map<string, string>();
  const names = await namesOf(root, manifest);
  if (unitNames.size >= keptRuns) unitNames.delete(unitNames.keys().next().value!);
  unitNames.set(id, names);
  return names;
}

/**
 * A page of the events of a run. Each event names what its unit covers. A build that failed or
 * did not finish also says why it stopped.
 */
export async function operationActivity(root: string, id: string, query: URLSearchParams) {
  const journal = await OperationJournal.open(root);
  let page;
  try {
    page = journal.page<RunOperationEvent>(`activity:${id}`, {
      page: Number(query.get("page")),
      limit: Number(query.get("limit")),
    });
  } finally {
    journal.close();
  }
  const names = page.items.some((event) => event.unitId)
    ? await runUnitNames(root, id)
    : new Map<string, string>();
  return {
    ...page,
    items: await Promise.all(
      page.items.map(async (event): Promise<ActivityEvent> => ({
        ...event,
        unit: (event.unitId && names.get(event.unitId)) || null,
        buildStop: await savedBuildStop(root, id, event),
      })),
    ),
  };
}
