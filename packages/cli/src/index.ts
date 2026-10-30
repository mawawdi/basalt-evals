#!/usr/bin/env node
import {
  previewOperationLaunch,
  authorizeOperation,
  commandOperation,
} from "../../operator/src/launch.js";
import { listSuites, readSuite, saveSuite, setSuiteBaseline } from "../../operator/src/suites.js";
import {
  previewComparison,
  createComparison,
  comparisonReport,
  listComparisons,
} from "../../operator/src/comparisons.js";
import {
  listRegressionReferences,
  saveRegressionReference,
  readRegressionReference,
} from "../../operator/src/regressions.js";
import { readHoldoutAccess } from "../../operator/src/holdout-access.js";
import {
  chooseExemplars,
  listExemplarChoices,
  readExemplarChoice,
} from "../../operator/src/exemplars.js";
import { exemplarComparisonReport } from "../../operator/src/exemplar-comparison.js";
import { rebuildCatalogProjections } from "../../operator/src/rebuild-projections.js";
import { createReviewer, listReviewers } from "../../operator/src/reviewers.js";
import {
  createReviewSelection,
  readReviewSelection,
} from "../../operator/src/review-selections.js";
import { reviewTreatmentCatalog } from "../../operator/src/review-treatments.js";
import { execFile as callback } from "node:child_process";
import { operationView } from "../../operator/src/workbench.js";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_JUDGE_SETTINGS,
  judgeSettings,
  type JudgeSettings,
} from "../../contracts/src/judge-settings.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { showPublicTask, validateRegisteredTasks } from "../../task-registry/src/commands.js";
import {
  addModel,
  readModelRegistry,
  removeModel,
  searchModelCatalog,
  setModelConcurrency,
  setModelDefaults,
} from "../../operator/src/model-registry.js";
import { createTextDraft, textDraft } from "../../operator/src/prepare-draft.js";
import {
  authoringClarifications,
  answerAuthoringClarification,
} from "../../operator/src/clarification.js";
import {
  prepareRepairDiscovery,
  inspectRepairPopulation,
} from "../../operator/src/repair-discovery.js";
import { registerSavedPublicFeedback } from "../../operator/src/replay.js";
import { sealExperimentAnalysis } from "../../operator/src/experiment-report.js";
import { submitOperationReview } from "../../operator/src/review-service.js";
import {
  readRegisteredExperiment,
  registerExperiment,
  type RegisteredExperiment,
} from "../../operator/src/experiment-plan.js";
import { ingestSource } from "../../operator/src/sources.js";
import { evaluationCatalog } from "../../operator/src/discovery.js";
import { inspectOperationOutcomes } from "../../operator/src/run-report.js";
import { sealArchive, listArchives, readArchive } from "../../operator/src/archive.js";
import { deleteRun, listDeletedRuns, setRunArchived } from "../../operator/src/run-retention.js";
import { deleteEvaluation } from "../../operator/src/evaluation-retention.js";
import {
  createReviewBatch,
  createRoundTwoBatches,
  createSecondReviewBatch,
  reviewBatchProgress,
  listReviewBatches,
} from "../../operator/src/review-batches.js";
import { previewReviewBatch } from "../../operator/src/review-population.js";
import { reviewAuditReport } from "../../operator/src/review-report.js";
import {
  claimReviewQuestion,
  saveReviewDraft,
  reviewActivity,
  endReviewSession,
  startReviewSession,
  type ReviewDraftInput,
} from "../../operator/src/review-session.js";
import type { ReviewSelection } from "../../contracts/src/review.js";
import { auditSequenceTiming } from "../../studio-runner/src/sequence-timing.js";
import { comparisonExport, runExport, writeExportFolder } from "../../operator/src/export.js";
import { datasetExport } from "../../operator/src/dataset-export.js";
import type { SequenceAcquisition } from "../../studio-runner/src/studio-mcp.js";
import { captureWorkerTemplate } from "../../studio-runner/src/isolated-user.js";
import { outputWithHint, type ConsoleHintTarget } from "./console-hint.js";
import { previewRecheck } from "../../operator/src/recheck.js";
import { knownBuildGate } from "../../operator/src/known-build-gate.js";
import {
  listKnownBuilds,
  markKnownBuild,
  retireKnownBuild,
} from "../../operator/src/known-builds.js";
import {
  curateParityStudy,
  parityReport,
  prepareParityStudy,
} from "../../operator/src/parity-study.js";

const root = resolve(process.cwd());
const execFile = promisify(callback);
const output = (value: unknown) => process.stdout.write(`${stableJson(value)}\n`);
/** Writes the result, and then the URL where a person at a terminal can open it. */
const hinted = <T>(result: Promise<T>, target: (value: T) => ConsoleHintTarget) =>
  outputWithHint(result, output, target);
async function json(file: string): Promise<unknown> {
  const bytes = await readBoundedRegularFile(resolve(root, file), 2 * 1024 * 1024, "CLI input");
  return JSON.parse(bytes.toString("utf8"));
}
const help = `Basalt commands
  launch preview <launch-intent.json> [--judge-samples <1-5>] [--per-criterion]
  launch authorize <authorization.json>
  operation command <operation-id> <command.json>
  operation status|outcomes <operation-id>
  operation archive <operation-id> <true|false>
  operation delete <operation-id>
  operation deleted [query-string]
  suite list [query-string]
  suite read <suite-id>
  suite create <suite-input.json>
  suite save <suite-id> <suite-input.json>
  suite baseline <suite-id> <operation-id> <snapshot-id>
  comparison list [query-string]
  comparison preview <comparison-runs.json>
  comparison create <preview-id>
  comparison report <comparison-id>
  regression list [query-string]
  regression save <reference-input.json>
  regression read <reference-id>
  regression holdout <evaluation-id>
  exemplar choose <exemplar-choice.json>
  exemplar read <choice-id>
  exemplar list <evaluation-id>
  exemplar report <operation-id>
  catalog rebuild
  eval save <authoring-input.json>
  eval read <draft-id>
  eval list
  eval delete <evaluation-id>
  eval clarifications <operation-id>
  eval clarify <draft-id> <authored-answer.json>
  operation public-feedback <operation-id> <subject-id>
  experiment read <registered-plan-id>
  experiment register <protocol-input.json>
  source register <source-input.json>
  experiment report <operation-id>
  experiment discovery <detector-operation-id> <order-seed>
  experiment repair-population <detector-operation-id>
  reviewer list [query-string]
  reviewer create <display-name>
  review select <operation-id>...
  review selection <selection-id> [query-string]
  review treatments <operation-id>...
  review preview <review-selection.json>
  review create <preview-id> <idempotency-key>
  review second <batch-id> <reviewer-id> <idempotency-key>
  review round-two <batch-id> <idempotency-key>
  review list [query-string]
  review progress|report <batch-id>
  review session|end <batch-id> <reviewer-id>
  review question <batch-id> <question-id> <session-id> <reviewer-id>
  review draft|answer <batch-id> <question-id> <answer.json>
  review activity <batch-id> <activity.json>
  archive seal <operation-id>
  archive list
  archive read <archive-id>
  sequence timing <sequence-directory>
  studio template capture <worker-id>
  export run|comparison|dataset <id> <new-directory> [--private]
  task validate [task-directories...]
  task show <task-directory>
  models list
  models search <words>
  models add|remove <openrouter-model-id>
  models defaults <defaults.json>
  models concurrency <openrouter-model-id> <1-16>
  recheck preview <recheck-selection.json>
  known-build mark <known-build.json>
  known-build retire <retirement.json>
  known-build list <library-evaluation-id>
  known-build gate <evaluation-id>
  parity curate <task-directory> <source-id>...
  parity prepare <study-id> <preparation-model-id>...
  parity run <study-id> <evaluation-id>...
  parity report <study-id> <curated-operation-id> <model-id>=<operation-id>...
  doctor
The commands accept only registered IDs and limits. The run driver moves each run through its stages.`;
const misuse = `The command or its arguments are not correct. Use one of these commands.\n${help}`;
function count(args: string[], expected: number) {
  if (args.length !== expected) throw new Error(misuse);
}
async function main() {
  const [group, action, ...args] = process.argv.slice(2);
  if (group === "launch") {
    if (action === "preview" && args.length >= 1)
      return output(
        await previewOperationLaunch(root, judgeFlags(await json(args[0]!), args.slice(1))),
      );
    count(args, 1);
    if (action === "authorize")
      return hinted(authorizeOperation(root, await json(args[0]!)), (value) => ({
        kind: "run",
        id: value.operationId,
      }));
    throw new Error(misuse);
  }
  if (group === "catalog" && action === "rebuild") {
    count(args, 0);
    return output(await rebuildCatalogProjections(root));
  }
  if (group === "suite") {
    if (action === "list") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listSuites(root, new URLSearchParams(args[0] ?? "")));
    }
    if (action === "read") {
      count(args, 1);
      return output(await readSuite(root, args[0]!));
    }
    if (action === "create") {
      count(args, 1);
      return output(await saveSuite(root, await json(args[0]!)));
    }
    if (action === "save") {
      count(args, 2);
      return output(await saveSuite(root, await json(args[1]!), args[0]!));
    }
    if (action === "baseline") {
      count(args, 3);
      return output(await setSuiteBaseline(root, args[0]!, args[1]!, args[2]!));
    }
    throw new Error(misuse);
  }
  if (group === "comparison") {
    if (action === "list") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listComparisons(root, new URLSearchParams(args[0] ?? "")));
    }
    count(args, 1);
    if (action === "preview") return output(await previewComparison(root, await json(args[0]!)));
    if (action === "create")
      return hinted(createComparison(root, args[0]!), (value) => ({
        kind: "comparison",
        id: value.id,
      }));
    if (action === "report") return output(await comparisonReport(root, args[0]!));
    throw new Error(misuse);
  }
  if (group === "regression") {
    if (action === "list") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listRegressionReferences(root, new URLSearchParams(args[0] ?? "")));
    }
    count(args, 1);
    if (action === "save") return output(await saveRegressionReference(root, await json(args[0]!)));
    if (action === "read") return output(await readRegressionReference(root, args[0]!));
    if (action === "holdout") return output(await readHoldoutAccess(root, args[0]!));
    throw new Error(misuse);
  }
  if (group === "exemplar") {
    count(args, 1);
    if (action === "choose") return output(await chooseExemplars(root, await json(args[0]!)));
    if (action === "read") return output(await readExemplarChoice(root, args[0]!));
    if (action === "list") return output(await listExemplarChoices(root, args[0]!));
    if (action === "report") return output(await exemplarComparisonReport(root, args[0]!));
    throw new Error(misuse);
  }
  if (group === "source" && action === "register") {
    count(args, 1);
    return output(await ingestSource(root, await json(args[0]!)));
  }
  if (group === "experiment" && action === "register") {
    count(args, 1);
    return output(
      await registerExperiment(root, (await json(args[0]!)) as Omit<RegisteredExperiment, "id">),
    );
  }
  if (group === "experiment" && action === "discovery") {
    count(args, 2);
    return output(await prepareRepairDiscovery(root, args[0]!, Number(args[1])));
  }
  if (group === "experiment" && action === "repair-population") {
    count(args, 1);
    return output(await inspectRepairPopulation(root, args[0]!));
  }
  if (group === "experiment" && action === "read") {
    count(args, 1);
    return output(await readRegisteredExperiment(root, args[0]!));
  }
  if (group === "experiment" && action === "report") {
    count(args, 1);
    return output(await sealExperimentAnalysis(root, args[0]!));
  }

  if (!group || group === "--help") {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (group === "task" && action === "validate")
    return output(await validateRegisteredTasks(root, args));
  if (group === "task" && action === "show") {
    count(args, 1);
    return output(await showPublicTask(root, args[0]!));
  }
  if (group === "models" && action === "list") {
    count(args, 0);
    return output(await readModelRegistry(root));
  }
  if (group === "models" && action === "search")
    return output(await searchModelCatalog(root, args.join(" ")));
  if (group === "models" && action === "add") {
    count(args, 1);
    return output(await addModel(root, args[0]!));
  }
  if (group === "models" && action === "remove") {
    count(args, 1);
    return output(await removeModel(root, args[0]!));
  }
  if (group === "models" && action === "defaults") {
    count(args, 1);
    return output(await setModelDefaults(root, await json(args[0]!)));
  }
  if (group === "models" && action === "concurrency") {
    count(args, 2);
    if (!/^[0-9]{1,2}$/u.test(args[1]!)) throw new Error(misuse);
    return output(
      await setModelConcurrency(root, { id: args[0]!, maxConcurrentRequests: Number(args[1]) }),
    );
  }
  if (group === "doctor") {
    const tools: Record<string, string> = {};
    for (const command of ["node", "rojo", "luau-lsp", "lune"]) {
      try {
        const result = await execFile(command, ["--version"], { cwd: root });
        tools[command] = result.stdout.trim();
      } catch {
        tools[command] = "unavailable";
      }
    }
    return output({ tools, tasks: await validateRegisteredTasks(root, []) });
  }
  if (group === "eval") {
    if (action === "clarifications") {
      count(args, 1);
      return output(await authoringClarifications(root, args[0]!));
    }
    if (action === "clarify") {
      count(args, 2);
      return output(await answerAuthoringClarification(root, args[0]!, await json(args[1]!)));
    }
    if (action === "save") {
      count(args, 1);
      return output(await createTextDraft(root, await json(args[0]!)));
    }
    if (action === "read") {
      count(args, 1);
      return output(await textDraft(root, args[0]!));
    }
    if (action === "list") {
      count(args, 0);
      return output(await evaluationCatalog(root));
    }
    if (action === "delete") {
      count(args, 1);
      return output(await deleteEvaluation(root, args[0]!));
    }
    throw new Error(misuse);
  }
  if (group === "operation") {
    if (action === "command") {
      count(args, 2);
      return hinted(commandOperation(root, args[0]!, await json(args[1]!)), () => ({
        kind: "run",
        id: args[0]!,
      }));
    }
    if (action === "public-feedback") {
      count(args, 2);
      return output(
        await registerSavedPublicFeedback({ root, operationId: args[0]!, subjectId: args[1]! }),
      );
    }
    if (action === "archive") {
      count(args, 2);
      if (args[1] !== "true" && args[1] !== "false")
        throw new Error('The archive value is not valid. Use "true" or "false".');
      return output(await setRunArchived(root, args[0]!, args[1] === "true"));
    }
    if (action === "deleted") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listDeletedRuns(root, new URLSearchParams(args[0] ?? "")));
    }
    count(args, 1);
    if (action === "delete") return output(await deleteRun(root, args[0]!));
    if (action === "status") return output(await operationView(root, args[0]!));
    if (action === "outcomes") return output(await inspectOperationOutcomes(root, args[0]!));
    throw new Error(misuse);
  }
  if (group === "reviewer") {
    if (action === "list") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listReviewers(root, new URLSearchParams(args[0] ?? "")));
    }
    if (action === "create") {
      count(args, 1);
      return output(await createReviewer(root, args[0]!));
    }
    throw new Error(misuse);
  }
  if (group === "review") {
    if (action === "select") return output(await createReviewSelection(root, args));
    if (action === "selection") {
      if (args.length < 1 || args.length > 2) throw new Error(misuse);
      return output(await readReviewSelection(root, args[0]!, new URLSearchParams(args[1] ?? "")));
    }
    if (action === "treatments") return output(await reviewTreatmentCatalog(root, args));
    if (action === "end" || action === "session") {
      count(args, 2);
      return output(
        action === "end"
          ? await endReviewSession(root, args[0]!, args[1]!)
          : await startReviewSession(root, args[0]!, args[1]!),
      );
    }
    if (action === "second") {
      count(args, 3);
      return output(await createSecondReviewBatch(root, args[0]!, args[1]!, args[2]!));
    }
    if (action === "round-two") {
      count(args, 2);
      return output(await createRoundTwoBatches(root, args[0]!, args[1]!));
    }
    if (action === "list") {
      if (args.length > 1) throw new Error(misuse);
      return output(await listReviewBatches(root, new URLSearchParams(args[0] ?? "")));
    }
    if (action === "preview") {
      count(args, 1);
      return output(await previewReviewBatch(root, (await json(args[0]!)) as ReviewSelection));
    }
    if (action === "create") {
      count(args, 2);
      return hinted(createReviewBatch(root, args[0]!, args[1]!), (value) => ({
        kind: "review",
        id: value.id,
      }));
    }
    if (action === "question") {
      count(args, 4);
      return output(await claimReviewQuestion(root, args[0]!, args[1]!, args[2]!, args[3]!));
    }
    if (action === "answer" || action === "draft") {
      count(args, 3);
      const value = (await json(args[2]!)) as ReviewDraftInput;
      return output(
        action === "answer"
          ? await submitOperationReview(root, args[0]!, args[1]!, value)
          : await saveReviewDraft(root, args[0]!, args[1]!, value),
      );
    }
    if (action === "activity") {
      count(args, 2);
      return output(
        await reviewActivity(
          root,
          args[0]!,
          (await json(args[1]!)) as Parameters<typeof reviewActivity>[2],
        ),
      );
    }
    count(args, 1);
    if (action === "progress") return output(await reviewBatchProgress(root, args[0]!));
    if (action === "report") return output(await reviewAuditReport(root, args[0]!));
  }
  if (group === "sequence" && action === "timing") {
    count(args, 1);
    return output(
      auditSequenceTiming((await json(`${args[0]!}/index.json`)) as SequenceAcquisition),
    );
  }
  if (group === "archive") {
    if (action === "list") {
      count(args, 0);
      return output(await listArchives(root));
    }
    if (action === "seal") {
      count(args, 1);
      return output(await sealArchive(root, args[0]!));
    }
    count(args, 1);
    if (action === "read") return output(await readArchive(root, args[0]!));
  }
  if (group === "studio" && action === "template") {
    count(args, 2);
    if (args[0] !== "capture") throw new Error(misuse);
    return output(await captureWorkerTemplate(root, args[1]!));
  }
  if (group === "export" && (action === "run" || action === "comparison" || action === "dataset")) {
    const scope = args[2] === "--private" ? "private" : "public";
    if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== "--private"))
      throw new Error(misuse);
    const saved =
      action === "run"
        ? await runExport(root, args[0]!, scope)
        : action === "comparison"
          ? await comparisonExport(root, args[0]!, scope)
          : await datasetExport(root, args[0]!, scope);
    const written = writeExportFolder(resolve(root, args[1]!), saved.files).then((folder) => ({
      folder,
      scope,
      files: saved.files.length,
    }));
    // A dataset has no report page to open.
    if (action === "dataset") return output(await written);
    return hinted(written, (value) => ({ kind: "export", folder: value.folder }));
  }
  // Rechecks, known builds and the preparation parity study. Each paid part is a launch preview.
  if (group === "recheck" && action === "preview") {
    count(args, 1);
    return output(await previewRecheck(root, await json(args[0]!)));
  }
  if (group === "known-build") {
    count(args, 1);
    if (action === "mark") return output(await markKnownBuild(root, await json(args[0]!)));
    if (action === "retire") return output(await retireKnownBuild(root, await json(args[0]!)));
    if (action === "list") return output(await listKnownBuilds(root, args[0]!));
    if (action === "gate") return output(await knownBuildGate(root, args[0]!));
  }
  if (group === "parity") {
    if (args.length < 1) throw new Error(misuse);
    const [first, ...rest] = args as [string, ...string[]];
    if (action === "curate") return output(await curateParityStudy(root, first, rest));
    if (action === "prepare") {
      const previews = [];
      for (const intent of await prepareParityStudy(root, first, rest))
        previews.push(await previewOperationLaunch(root, intent));
      return output(previews);
    }
    if (action === "run") {
      const previews = [];
      for (const revisionId of rest)
        previews.push(
          await previewOperationLaunch(root, {
            kind: "parity",
            selection: { studyId: first, revisionId },
          }),
        );
      return output(previews);
    }
    if (action === "report") {
      const [curated, ...prepared] = rest;
      if (!curated) throw new Error(misuse);
      return output(
        await parityReport(
          root,
          first,
          curated,
          prepared.map((item) => {
            const separator = item.lastIndexOf("=");
            if (separator < 1) throw new Error(misuse);
            return { modelId: item.slice(0, separator), operationId: item.slice(separator + 1) };
          }),
        ),
      );
    }
  }
  throw new Error(misuse);
}

/**
 * Apply the judge flags to the launch selection of an evaluation or a regression intent.
 * `--judge-samples <1-5>` sets the identical samples of each judge request. `--per-criterion`
 * gives each judge criterion its own request.
 */
function judgeFlags(intent: unknown, flags: string[]): unknown {
  if (!flags.length) return intent;
  let samples: number | null = null;
  let perCriterion = false;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "--judge-samples" && samples === null && index + 1 < flags.length)
      samples = Number(flags[++index]);
    else if (flags[index] === "--per-criterion" && !perCriterion) perCriterion = true;
    else throw new Error(misuse);
  }
  const value = intent as { kind?: unknown; selection?: Record<string, unknown> };
  const selection =
    value.kind === "evaluation"
      ? value.selection
      : value.kind === "regression"
        ? (value.selection?.configuration as Record<string, unknown> | undefined)
        : undefined;
  if (!selection)
    throw new Error("The judge flags apply only to an evaluation or a regression launch intent.");
  const current = (selection.judgeSettings ?? DEFAULT_JUDGE_SETTINGS) as JudgeSettings;
  selection.judgeSettings = judgeSettings({
    samples: samples ?? current.samples,
    grouping: perCriterion ? "per_criterion" : current.grouping,
  });
  return intent;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
