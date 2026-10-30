export const metadata = { title: "Evaluation · Basalt" };
import type { ReactNode } from "react";
import { launchCatalog } from "../../../../../dist/packages/operator/src/discovery.js";

import { launchDefaults } from "../../../../../dist/packages/operator/src/workflow.js";
import { readModelRegistry } from "../../../../../dist/packages/operator/src/model-registry.js";
import { readHarnessRegistry } from "../../../../../dist/packages/operator/src/config.js";
import { ReferenceLaunch } from "../../components/reference-launch";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvalDefinitionStore } from "../../../lib/server";
import { textDraft, evaluationSummary, runCatalog } from "../../../lib/server";
import { evaluationControls, readCoverageNotes, readEmptyBuildCheck } from "../../../lib/server";
import { readFailureExplanations, revisionPlanWarnings } from "../../../lib/server";
import { readPreparationReuse } from "../../../lib/server";
import { knownBuildGate, listKnownBuilds, savedBuildRuns } from "../../../lib/server";
import { frozenRunRecords } from "../../../lib/server";
import { listReviewBatches } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { Notice, ScrollRegion, PageHeading, Status } from "../../components/ui";
import { EvaluationActions } from "../../components/evaluation-actions";
import { MarkdownText } from "../../components/markdown-preview";
import { CatalogTable } from "../../components/catalog-table";
import s from "../../components/workbench.module.css";
import {
  modelList,
  problemSummary,
  runDetail,
  statementText,
} from "../../components/result-display";
import type { Page, RunSummary } from "../../../../../dist/packages/contracts/src/catalog.js";
import { stageTitle } from "../../../../../dist/packages/contracts/src/display.js";
import type { PreparationReuse } from "../../../../../dist/packages/eval-authoring/src/preparation-base.js";
import { CoverageTable } from "./coverage-table";
import { PlanWarnings } from "./plan-warnings";
import { ExplainFailures } from "./explain-failures";
import { FailureHypotheses } from "./failure-hypotheses";
import { KnownBuildGatePanel, knownBuildName } from "./known-build-gate";
import { RecheckPanel } from "./recheck-panel";
export const dynamic = "force-dynamic";
export default async function Evaluation({ params }: { params: Promise<{ id: string }> }) {
  const { id: routeId } = await params;
  const root = repositoryRoot();
  const catalog = await launchCatalog(root);
  const summary = await evaluationSummary(root, routeId);
  if (!summary) notFound();
  const id = summary.id;
  if (summary?.kind === "draft") {
    const [draft, related, registry] = await Promise.all([
      textDraft(root, id),
      runCatalog(root, new URLSearchParams({ q: id })),
      readModelRegistry(root),
    ]);
    // A person who comes back after a failed run sees why before they start another one.
    const latest = related.items[0];
    const criteriaCount = draft.stages.reduce((sum, stage) => sum + stage.criteria.length, 0);
    return (
      <main>
        <PageHeading
          title={draft.title}
          description="Saved. Basalt prepares the checks when you start a benchmark."
          action={
            !summary.archived && (
              <Link className={s.primary} href={"/runs/new?eval=" + routeId}>
                Run a benchmark
              </Link>
            )
          }
        />
        <div className={s.row}>
          <Status>{summary.archived ? "Archived" : "Draft"}</Status>
          <span className={s.small}>
            {draft.stages.length > 1 && `${draft.stages.length} stages · `}
            {criteriaCount} private {criteriaCount === 1 ? "criterion" : "criteria"}
          </span>
          {summary.evaluationId && (
            <EvaluationActions evaluationId={summary.evaluationId} archived={summary.archived} />
          )}
        </div>
        {latest?.state === "attention" && latest.blocker && (
          <div className={s.section}>
            <Notice kind="info">
              The last run needs attention: {problemSummary(latest.blocker)}{" "}
              <Link href={`/runs/${latest.id}`}>Open run</Link>
            </Notice>
          </div>
        )}
        {draft.stages.map((stage, index) => (
          <StageInputs
            key={index}
            index={index}
            count={draft.stages.length}
            prompt={stage.prompt}
            rubric={stage.rubric}
            criteria={stage.criteria}
            gateCriterionIds={stage.gateCriterionIds}
          />
        ))}
        <RelatedRuns
          related={related}
          query={id}
          modelNames={Object.fromEntries(registry.models.map((model) => [model.id, model.name]))}
        />
      </main>
    );
  }
  const store = new EvalDefinitionStore(root);
  const stages = await store.readStageRevisions(id);
  const revision = stages[0]!;
  const runnable = summary.readiness === "ready" || summary.readiness === "checked";
  // The plan warnings and the saved builds read each run one time.
  const runRecords = frozenRunRecords(root);
  // Rechecks and known builds: the saved builds of this version and of earlier versions with
  // the same title.
  const runLists = Promise.all([
    runCatalog(root, new URLSearchParams({ q: id })),
    runCatalog(root, new URLSearchParams({ q: revision.publicTask.title })),
  ]);
  const savedBuilds = runLists.then(([related, titledRuns]) => {
    const recheckRuns = [
      ...new Map([...related.items, ...titledRuns.items].map((item) => [item.id, item])).values(),
    ];
    return Promise.all([
      recheckRuns,
      runnable
        ? savedBuildRuns(
            root,
            recheckRuns.map((item) => item.id),
            revision.publicTask.title,
            runRecords,
          )
        : [],
    ]);
  });
  // The reads are independent, so the page starts them at the same time.
  const [
    [related],
    [recheckRuns, savedBuildIds],
    controls,
    audits,
    coverageNotes,
    emptyBuild,
    registry,
    harnesses,
    planWarnings,
    explanations,
    knownBuilds,
    reuse,
  ] = await Promise.all([
    runLists,
    savedBuilds,
    evaluationControls(root, id),
    listReviewBatches(root, new URLSearchParams({ q: id })),
    // Each stage has its own coverage notes.
    Promise.all(stages.map((stage) => readCoverageNotes(root, stage.id))),
    readEmptyBuildCheck(root, id),
    readModelRegistry(root),
    readHarnessRegistry(root),
    revisionPlanWarnings(root, id, runRecords),
    readFailureExplanations(root, id),
    summary.evaluationId ? listKnownBuilds(root, summary.evaluationId) : null,
    readPreparationReuse(root, id),
  ]);
  // The plan warnings read the known build gate. The page reads it again only if they could not.
  const knownGate = planWarnings.gate ?? (await knownBuildGate(root, id));
  const modelNames = Object.fromEntries(registry.models.map((model) => [model.id, model.name]));
  const modelChoices = registry.models.map((model) => ({ id: model.id, name: model.name }));
  // "Build 1 · GPT-6 Luna": a saved build is named by its builder model, as on the run page.
  const savedRuns = savedBuildIds.map((run) => ({
    ...run,
    builds: run.builds.map(({ modelId, ...build }) => ({
      ...build,
      title: modelId ? `${build.title} · ${modelNames[modelId] ?? modelId}` : build.title,
    })),
  }));
  const staged = stages.length > 1;
  const stageName = (stage: number) => `Stage ${stage} of ${stages.length}`;
  // A recheck checks builds of one stage, so each stage of a run is its own choice.
  const recheckChoices = savedRuns.flatMap((run) =>
    stages.flatMap(({ stage }) => {
      const builds = run.builds.filter((build) => build.stage === stage.index);
      const title =
        recheckRuns.find((item) => item.id === run.operationId)?.title ?? run.operationId;
      return builds.length
        ? [
            {
              key: `${run.operationId}:${stage.index}`,
              operationId: run.operationId,
              title: stageTitle(title, stage),
              builds,
            },
          ]
        : [];
    }),
  );
  const buildTitles = Object.fromEntries(
    savedRuns.flatMap((run) =>
      run.builds.map((build) => [
        `${run.operationId}:${build.id}`,
        staged ? `${stageName(build.stage)} · ${build.title}` : build.title,
      ]),
    ),
  );
  // The stage of each known build, from the revision of its build.
  const knownStages = Object.fromEntries(
    await Promise.all(
      (knownBuilds?.knownBuilds ?? []).map(
        async (known) =>
          [known.id, (await store.readRevision(known.originRevisionId)).stage.index] as const,
      ),
    ),
  );
  return (
    <main>
      <PageHeading
        title={revision.publicTask.title}
        description={
          summary.evaluationId
            ? "Prepared checks for your saved prompt and private success criteria."
            : "Saved evaluation inputs for benchmarks and suites."
        }
        action={
          summary.archived ? undefined : runnable ? (
            <Link className={s.primary} href={`/runs/new?eval=${routeId}`}>
              Run a benchmark
            </Link>
          ) : (
            <Link
              className={s.primary}
              href={`/runs/new?eval=${summary.evaluationId ?? revision.draftId}`}
            >
              Run a benchmark
            </Link>
          )
        }
      />
      <div className={s.row}>
        <Status tone={runnable ? "good" : "warning"}>
          {summary.archived ? "Archived" : runnable ? "Ready to run" : "Needs preparation"}
        </Status>
        {summary.readiness === "checked" && <Status tone="good">Reference tested</Status>}
        {summary.evaluationId ? (
          <EvaluationActions evaluationId={summary.evaluationId} archived={summary.archived} />
        ) : (
          <Link className={s.secondary} href={`/evaluations/new?draft=${revision.draftId}`}>
            Create editable copy
          </Link>
        )}
      </div>
      {reuse && <p className={s.small}>{reuseSentence(reuse)}</p>}
      {stages.map((stage, index) => {
        const checks = [
          ...stage.privateEvaluator.deterministic,
          ...stage.privateEvaluator.codeQuality,
          ...stage.privateEvaluator.visual,
          ...stage.privateEvaluator.unscaled,
        ];
        return (
          <StageInputs
            key={stage.id}
            index={index}
            count={stages.length}
            prompt={stage.authored.builderPrompt}
            rubric={stage.authored.rubric}
            criteria={stage.authored.criteria}
            gateCriterionIds={stage.stage.gateCriterionIds}
          >
            <details className={s.section}>
              <summary>How Basalt checks the criteria</summary>
              <p className={s.small}>
                Each success criterion gets its own answer. The rest of the prompt gives context and
                is not scored.
              </p>
              <ScrollRegion className={s.tableWrap} label="Evaluation details">
                <table className={s.stackTable}>
                  <thead>
                    <tr>
                      <th scope="col">Criterion as written</th>
                      <th scope="col">How it counts</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((criterion) => (
                      <tr key={criterion.id}>
                        <th scope="row">{statementText(criterion.statement)}</th>
                        <td data-label="How it counts">
                          {criterion.required ? "Required" : "Reported separately"}
                        </td>
                        <td data-label="Evidence">
                          {"evidence" in criterion
                            ? [
                                criterion.evidence.sourceSelection ? "Source" : "",
                                criterion.evidence.facts.length ? "Measured during play" : "",
                                criterion.evidence.captureIds.length || criterion.evidence.sequence
                                  ? "Images"
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : "Measured during play"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            </details>
            {/* Only stage 1 starts from the starting files, so only it has the empty build check. */}
            {index === 0 && (
              <PlanWarnings
                check={emptyBuild}
                warnings={planWarnings.warnings}
                runs={planWarnings.runs.length}
                checks={checks}
                knownBuildNames={Object.fromEntries(
                  (knownBuilds?.knownBuilds ?? []).map((known) => [
                    known.id,
                    knownBuildName(known, buildTitles),
                  ]),
                )}
              />
            )}
            {coverageNotes[index]!.length > 0 && (
              <CoverageTable
                id={index === 0 ? "coverage-notes" : `coverage-notes-${index + 1}`}
                records={coverageNotes[index]!}
                criteria={stage.authored.criteria}
                checks={checks}
                modelNames={modelNames}
              />
            )}
          </StageInputs>
        );
      })}
      {((planWarnings.warnings.length > 0 && !summary.archived) || explanations.length > 0) && (
        <section className={s.section} id="explain-failures">
          <h2>Explain failures</h2>
          {planWarnings.warnings.length > 0 && !summary.archived && (
            <ExplainFailures
              revisionId={id}
              criteria={new Set(planWarnings.warnings.map((warning) => warning.criterionId)).size}
              models={catalog.models}
              defaultModelId={launchDefaults(registry, harnesses).coverageModelId}
            />
          )}
          <FailureHypotheses records={explanations} modelNames={modelNames} />
        </section>
      )}
      <KnownBuildGatePanel
        gate={knownGate}
        knownBuilds={knownBuilds?.knownBuilds ?? null}
        criteria={stages.flatMap((stage) =>
          stage.authored.criteria.map((criterion) => ({
            stage: stage.stage.index,
            id: criterion.id,
            text: criterion.text,
          })),
        )}
        knownStages={knownStages}
        buildTitles={buildTitles}
        models={modelChoices}
      />
      {runnable && (
        <RecheckPanel
          revisionId={id}
          evaluationId={summary.evaluationId}
          runs={recheckChoices}
          models={modelChoices}
        />
      )}
      <details className={s.section}>
        <summary>Reference test</summary>
        <p>
          {summary?.reason ??
            (controls
              ? "Basalt tried the checks on reference builds. This shows how the checks behave on those builds, not whether people agree with their answers."
              : "Basalt prepared the checks but has not tried them on reference builds or compared them with people’s answers yet.")}
        </p>
        {controls && (
          <ScrollRegion className={s.tableWrap} label="Evaluation details">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference build</th>
                  <th scope="col">Criteria met</th>
                  <th scope="col">Criteria not met</th>
                  <th scope="col">Incomplete</th>
                </tr>
              </thead>
              <tbody>
                {/* Each stage has its own reference builds. */}
                {controls.flatMap((check, stage) =>
                  check.cases.map((control, index) => (
                    <tr key={`${stage}:${control.id}`}>
                      <th scope="row">
                        {staged && `${stageName(stage + 1)} · `}
                        {control.kind.replaceAll("_", " ")} {index + 1}
                      </th>
                      {(["verified", "rejected", "incomplete"] as const).map((outcome) => (
                        <td key={outcome}>
                          {control.criteria.filter((c) => c.outcome === outcome).length} /{" "}
                          {control.criteria.length}
                        </td>
                      ))}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <ReferenceLaunch
          revisionId={id}
          stages={stages.length}
          defaults={launchDefaults(registry, harnesses)}
          models={catalog.models}
          harnesses={catalog.harnesses}
        />
        <details className={s.section}>
          <summary>Technical IDs</summary>
          <pre className={s.code}>
            {JSON.stringify(
              {
                evaluation: id,
                draft: revision.draftId,
                validation: summary?.validationRecordHash,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </details>
      <RelatedRuns related={related} query={id} modelNames={modelNames} />
      {audits.total > 0 && (
        <section className={s.section}>
          <h2>Optional reviews</h2>
          <CatalogTable
            label="Reviews"
            rows={audits.items.map((batch) => ({
              id: batch.id,
              title:
                batch.purpose === "protocol"
                  ? "Planned research review"
                  : batch.purpose === "audit"
                    ? "Random review"
                    : "Targeted review",
              href: `/audits/${batch.id}`,
              state: batch.state,
              detail: `${batch.answered} / ${batch.assigned} questions answered`,
            }))}
          />
        </section>
      )}
    </main>
  );
}

/** The runs that used this evaluation, newest first. */
/** What the preparation kept from the earlier version of the evaluation. */
function reuseSentence(reuse: PreparationReuse): string {
  const kept = reuse.stages.filter((stage) => stage.plan === "reused");
  if (!kept.length)
    return "Basalt couldn’t keep the tests of the earlier version, so it prepared new tests.";
  if (kept.length < reuse.stages.length)
    return `Basalt kept the tests of the earlier version for ${kept.length} of ${reuse.stages.length} stages and prepared new tests for the others.`;
  const prepared = kept.reduce((sum, stage) => sum + stage.preparedCriteria, 0);
  return prepared
    ? `Basalt kept the tests of the earlier version and prepared ${prepared} new or changed ${prepared === 1 ? "criterion" : "criteria"}.`
    : "Basalt kept the tests of the earlier version.";
}

function RelatedRuns({
  related,
  query,
  modelNames,
}: {
  related: Page<RunSummary>;
  query: string;
  modelNames: Record<string, string>;
}) {
  return (
    <section className={s.section}>
      <div className={s.sectionHeading}>
        <h2>Related runs</h2>
        {/* The link appears only when the table does not show every run already. */}
        {related.total > related.items.length && (
          <Link className={s.action} href={`/?view=activity&q=${query}`}>
            View all {related.total} runs
          </Link>
        )}
      </div>
      {related.total > 0 ? (
        <CatalogTable
          label="Runs"
          rows={related.items.map((item) => ({
            id: item.id,
            title: item.title,
            href: `/runs/${item.id}`,
            state: item.state,
            description: modelList(item.models, modelNames),
            at: item.startedAt ?? item.updatedAt,
            detail: runDetail(item),
          }))}
        />
      ) : (
        <p className={s.small}>No benchmark has used this evaluation yet.</p>
      )}
    </section>
  );
}

/**
 * The authored inputs of one stage. An evaluation with one stage shows no stage heading, so it
 * looks the same as an evaluation without stages.
 */
function StageInputs({
  index,
  count,
  prompt,
  rubric,
  criteria,
  gateCriterionIds,
  children,
}: {
  index: number;
  count: number;
  prompt: string;
  rubric: string;
  criteria: Array<{ id: string; text: string }>;
  gateCriterionIds: string[];
  children?: ReactNode;
}) {
  const gate = criteria.filter((criterion) => gateCriterionIds.includes(criterion.id));
  // Under a stage heading, the field headings move one level down.
  const Heading = count === 1 ? "h2" : "h3";
  const inputs = (
    <div className={`${s.columns} ${s.section}`}>
      <section className={`${s.panel} ${s.panelBody}`}>
        <Heading>Prompt</Heading>
        <MarkdownText value={prompt} />
      </section>
      <section className={`${s.panel} ${s.panelBody} ${s.sealed}`}>
        <Heading>
          Success criteria <span className={s.privateTag}>Private</span>
        </Heading>
        <MarkdownText value={rubric} />
      </section>
    </div>
  );
  if (count === 1)
    return (
      <>
        {inputs}
        {children}
      </>
    );
  return (
    <section className={s.section} aria-labelledby={`stage-${index + 1}`} data-stage={index + 1}>
      <h2 id={`stage-${index + 1}`}>
        Stage {index + 1} of {count}
      </h2>
      {index > 0 && (
        <p className={s.small}>
          This stage continues the build of stage&nbsp;
          {index}. The model sees the earlier prompts.
        </p>
      )}
      {inputs}
      {gate.length > 0 && (
        <div className={s.stageGate}>
          <Notice kind="info">
            <strong>Gate.</strong> Stage {index + 2} starts only if the build passes these criteria.
            Otherwise,{" "}
            {count - index === 2
              ? `stage ${count} shows`
              : `stages ${index + 2} ${count - index === 3 ? "and" : "to"} ${count} show`}{" "}
            as not reached.
            <ul>
              {gate.map((criterion) => (
                <li key={criterion.id}>{statementText(criterion.text)}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}
      {children}
    </section>
  );
}
