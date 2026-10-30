"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  patternTable,
  rowPairs,
  type BuildStop,
  type ClassComparison,
  type CriterionOutcomeCounts,
  type EvidenceGroup,
  type ModelReport,
  type ModelVerdict,
  type PairComparison,
  type PairFamily,
  type PatternCounts,
  type PatternFamily,
  type PatternShare,
  type PatternTableRow,
  type PatternVerdict,
} from "../../../../../dist/packages/contracts/src/model-report.js";
import type { OutcomeCause } from "../../../../../dist/packages/contracts/src/failure.js";
import { read, message } from "../../components/api";
import { EmptyState, Loading, Notice, ProblemText, ScrollRegion } from "../../components/ui";
import { causeLabel, evidenceClassNames, statementText } from "../../components/result-display";
import s from "../../components/workbench.module.css";
import r from "../../components/run-experience.module.css";

/** The answer of one comparison, read from the selected model. No word means better or worse. */
export const verdictWords: Record<ModelVerdict, string> = {
  meets_more_often: "Meets more often",
  meets_less_often: "Meets less often",
  not_enough_builds: "Not enough builds to tell",
};

/** The answer of one failure pattern comparison, read from the selected model. */
export const patternVerdictWords: Record<PatternVerdict, string> = {
  happens_more_often: "Happens more often",
  happens_less_often: "Happens less often",
  not_enough_builds: "Not enough builds to tell",
};

const groupNames: Record<EvidenceGroup, string> = {
  ...evidenceClassNames,
  unclassified: "No evidence class",
  code: "Code checks",
};

const stopNames: Record<BuildStop, string> = {
  delivered: "Passed the local checks and finished",
  local_gate_rejected: "Didn’t pass the local checks",
  invalid_tool_call: "Tool calls refused",
  refusal: "Model refused the task",
  turn_limit: "Used all of its turns",
  context_limit: "Conversation too long for the model",
  output_limit: "Used its full output limit",
  provider_error: "Model provider error",
  spending_limit: "Reached the spending limit",
  cancelled: "Stopped before it finished",
  environment: "Local checks couldn’t run",
  unrecorded: "No saved record",
  not_reached: "Not reached",
  not_finished: "Not finished yet",
};

const localChecks: Record<string, string> = {
  project_json: "Project file",
  luau_parse: "Luau syntax",
  rojo_build: "Rojo build",
};

const familyTitles: Record<PatternFamily, string> = {
  stops: "How builds ended",
  gateFailures: "Local checks that failed",
  failedToolCalls: "Tool calls that failed",
  refusedBatches: "Tool calls refused",
  causes: "Why work didn’t finish",
  lint: "Code analysis",
  scriptErrors: "Script errors",
};

/** The builds that a pattern family can’t count, for example "2 without a code analysis". */
const uncountedNames: Record<PatternFamily, string> = {
  stops: "",
  gateFailures: "without a saved record",
  failedToolCalls: "without a saved record",
  refusedBatches: "without a saved record",
  causes: "",
  lint: "without a code analysis",
  scriptErrors: "not checked for script errors",
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const total = (counts: CriterionOutcomeCounts) => counts.met + counts.notMet + counts.unresolved;
/** "4 of 5 met · 1 unclear": an unclear build has no clear outcome for the criterion. */
const metText = (counts: CriterionOutcomeCounts) =>
  `${counts.met} of ${total(counts)} met${counts.unresolved ? ` · ${counts.unresolved} unclear` : ""}`;
const pText = (value: number) => (value < 0.001 ? "below 0.001" : value.toFixed(3));

/**
 * The Models view of a run. For a selected model, it compares each criterion with each other
 * model of the same tool set, by evidence class, and it lists the failure patterns of the model.
 * Every column has the same neutral style, so no model looks better.
 */
export function ModelReportView({
  operationId,
  selected,
  against,
  navigate,
  refresh,
}: {
  operationId: string;
  /** The row of the selected model, from the URL. */
  selected: string;
  /** "tool-sets" compares the tool sets of the selected model, from the URL. */
  against: string;
  navigate: (changes: Record<string, string>) => void;
  /** Changes when the run records new answers, so the view loads again. */
  refresh: string;
}) {
  const [report, setReport] = useState<ModelReport | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void read<ModelReport>(`/api/operations/${operationId}/model-report`, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [operationId, refresh, reload]);
  if (!report)
    return error ? (
      <Notice>
        <ProblemText text={error} />
        <button className={s.secondary} onClick={() => setReload((value) => value + 1)}>
          Reload models
        </button>
      </Notice>
    ) : (
      <Loading label="Loading models…" />
    );
  if (!report.models.length)
    return (
      <EmptyState title="No models to show">
        This run has no builds of a model yet. Progress shows the current step.
      </EmptyState>
    );
  const model = report.models.find((item) => item.rowId === selected) ?? report.models[0]!;
  const family: PairFamily =
    against === "tool-sets" && report.toolSetPairs.length ? "toolSets" : "models";
  const pairs = rowPairs(report, model.rowId, family);
  const others = pairs.map((pair) => report.models.find((item) => item.rowId === pair.otherRowId)!);
  const name = (row: { modelName: string; harnessTitle: string }) =>
    new Set(report.models.map((item) => item.harnessId)).size > 1
      ? `${row.modelName} · ${row.harnessTitle}`
      : row.modelName;
  // A tool-set pair has the same model on both sides, so its column names the tool set.
  const otherName = (row: { modelName: string; harnessTitle: string }) =>
    family === "toolSets" ? row.harnessTitle : name(row);
  return (
    <div className={s.stack}>
      {error && (
        <Notice>
          <ProblemText text={error} /> Showing the models loaded earlier.
        </Notice>
      )}
      <section className={s.section} aria-labelledby="models-heading">
        <h2 id="models-heading">Models</h2>
        <p className={s.small}>
          {family === "toolSets"
            ? `Each criterion compares ${model.harnessTitle} with each other tool set, for the builds of ${model.modelName} in this run.`
            : `Each criterion compares ${name(model)} with each other model of the same tool set in this run.`}{" "}
          “Not enough builds to tell” means the difference in these builds could still be chance.
        </p>
        {report.models.length > 1 && (
          <div className={r.sidePickers}>
            <div className={s.field}>
              <label htmlFor="model-report-model">Model</label>
              <select
                id="model-report-model"
                value={model.rowId}
                onChange={(event) => navigate({ model: event.target.value })}
              >
                {report.models.map((item) => (
                  <option key={item.rowId} value={item.rowId}>
                    {name(item)}
                  </option>
                ))}
              </select>
            </div>
            {report.toolSetPairs.length > 0 && (
              <div className={s.field}>
                <label htmlFor="model-report-against">Compare with</label>
                <select
                  id="model-report-against"
                  value={family}
                  onChange={(event) =>
                    navigate({ against: event.target.value === "toolSets" ? "tool-sets" : "" })
                  }
                >
                  <option value="models">Other models</option>
                  <option value="toolSets">Other tool sets</option>
                </select>
              </div>
            )}
          </div>
        )}
        {!report.finished && (
          <Notice kind="info">
            The run is still adding answers. Builds without a clear outcome count as unclear until
            then.
          </Notice>
        )}
        {model.judgeFamily && (
          <Notice kind="info">
            The judge comes from the same model family as {model.modelName}, so it may favor these
            builds.
          </Notice>
        )}
        {!pairs.length && (
          <p className={s.small}>
            {family === "toolSets"
              ? `${model.modelName} has no other tool set in this run, so there’s nothing to compare.`
              : `No other model in this run uses the tool set ${model.harnessTitle}, so there’s nothing to compare.`}{" "}
            {family === "models" && rowPairs(report, model.rowId, "toolSets").length
              ? "To compare its tool sets, choose Other tool sets in Compare with. "
              : ""}
            The counts and failure patterns below still apply.
          </p>
        )}
        <PairLimits
          pairs={pairs}
          name={(row) => otherName(report.models.find((item) => item.rowId === row)!)}
          side={family === "toolSets" ? "tool set" : "model"}
        />
      </section>
      {report.evaluations
        .filter((evaluation) => evaluation.criteria.length)
        .map((evaluation, index) => {
          const title = evaluation.title ?? `Evaluation ${index + 1}`;
          return (
            <section
              key={evaluation.evaluationId}
              className={s.section}
              aria-labelledby={`models-evaluation-${index}`}
            >
              <h3 id={`models-evaluation-${index}`}>{title}</h3>
              <ScrollRegion label={`Criteria of ${title}`}>
                <table className={s.stackTable}>
                  <thead>
                    <tr>
                      <th scope="col">Criterion</th>
                      <th scope="col">{name(model)}</th>
                      {others.map((other) => (
                        <th scope="col" key={other.rowId}>
                          Compared with {otherName(other)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {evaluation.criteria.map((criterion) => {
                      const own = model.outcomes.find(
                        (item) =>
                          item.evaluationId === evaluation.evaluationId &&
                          item.criterionId === criterion.criterionId,
                      );
                      return (
                        <tr key={criterion.criterionId}>
                          <th scope="row">
                            {statementText(criterion.statement) || `Criterion ${criterion.number}`}
                            <span className={s.tableMeta}>
                              {groupNames[criterion.group]}
                              {criterion.required ? "" : " · Optional"}
                            </span>
                          </th>
                          <td data-label={name(model)}>{own ? metText(own) : "No builds"}</td>
                          {pairs.map((pair, position) => {
                            const item = pair.criteria.find(
                              (entry) =>
                                entry.evaluationId === evaluation.evaluationId &&
                                entry.criterionId === criterion.criterionId,
                            );
                            const label = `Compared with ${otherName(others[position]!)}`;
                            return (
                              <td key={pair.otherRowId} data-label={label}>
                                {item ? (
                                  <>
                                    <strong>{verdictWords[item.verdict]}</strong>
                                    <span className={s.tableMeta}>{metText(item.other)}</span>
                                    {item.direction && (
                                      <span className={s.tableMeta}>
                                        p {pText(item.adjustedP)} after correction
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  "No builds to compare"
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollRegion>
            </section>
          );
        })}
      {pairs.some((pair) => pair.classes.length) && (
        <section className={s.section} aria-labelledby="models-classes">
          <h3 id="models-classes">By evidence class</h3>
          <p className={s.small}>
            Each build gets the share of the criteria of a group that it meets. The test compares
            these shares inside each evaluation. The groups don’t add up to an overall score.
          </p>
          <ScrollRegion label="Comparisons by evidence class">
            <table className={s.stackTable}>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  {others.map((other) => (
                    <th scope="col" key={other.rowId}>
                      Compared with {otherName(other)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...new Set(pairs.flatMap((pair) => pair.classes.map((item) => item.group)))].map(
                  (group) => (
                    <tr key={group}>
                      <th scope="row">{groupNames[group]}</th>
                      {pairs.map((pair, position) => {
                        const item = pair.classes.find((entry) => entry.group === group);
                        return (
                          <td
                            key={pair.otherRowId}
                            data-label={`Compared with ${otherName(others[position]!)}`}
                          >
                            {item ? <ClassCell item={item} /> : "No builds to compare"}
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </ScrollRegion>
        </section>
      )}
      <Patterns
        patterns={model.patterns}
        title={name(model)}
        rows={patternTable(model.patterns, pairs)}
        columns={others.map((other) => ({
          id: other.rowId,
          label: `Compared with ${otherName(other)}`,
        }))}
        toolSets={family === "toolSets"}
      />
      <details className={s.section}>
        <summary>How Basalt decides</summary>
        <p>Each build gets one outcome for each criterion:</p>
        <ul>
          <li>Met: {report.outcomeRule.text.met}</li>
          <li>Not met: {report.outcomeRule.text.notMet}</li>
          <li>Unclear: {report.outcomeRule.text.unresolved}</li>
        </ul>
        <p>
          For each criterion, Fisher’s exact test compares the builds of the two{" "}
          {family === "toolSets" ? "tool sets" : "models"}. Unclear builds count against the answer
          under test, so they can only make an answer harder to reach. The Holm correction covers
          all criteria of the two {family === "toolSets" ? "tool sets" : "models"}, and an answer
          needs a corrected p of {report.alpha} or less. By evidence class uses a permutation test
          inside each evaluation, with its own correction. A range shows only when each side has
          more than 40 builds.
        </p>
        <p>
          For each failure pattern, Fisher’s exact test compares the builds that show it with the
          builds that don’t. It counts only the builds that can show the pattern: a build without a
          code analysis, for example, isn’t a build without findings. The Holm correction covers all
          failure patterns of the two sides.
        </p>
        <p>
          {family === "toolSets"
            ? `Both tool sets built the same evaluations with ${model.modelName} in this run, under the same judge and limits. Basalt never ranks the tool sets or picks a winner.`
            : "The models built the same evaluations in this run, under the same judge and limits. Basalt never ranks the models or picks a winner."}
        </p>
      </details>
    </div>
  );
}

/** A sentence for each pair where no criterion can reach an answer with these build counts. */
function PairLimits({
  pairs,
  name,
  side,
}: {
  pairs: PairComparison[];
  name: (rowId: string) => string;
  /** "model" or "tool set": what each side of a pair is. */
  side: string;
}) {
  const limited = pairs.filter((pair) => !pair.decisionPossible);
  if (!limited.length) return null;
  return (
    <p className={`${s.small} ${s.tableNote}`}>
      With these build counts, no criterion can reach an answer against{" "}
      {limited.map((pair) => name(pair.otherRowId)).join(", ")}. More builds of each {side} can
      change that.
    </p>
  );
}

function ClassCell({ item }: { item: ClassComparison }) {
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return (
    <>
      <strong>{verdictWords[item.verdict]}</strong>
      <span className={s.tableMeta}>
        {metText(item.model)} in {plural(item.model.builds, "build", "builds")}, against{" "}
        {metText(item.other)} in {plural(item.other.builds, "build", "builds")}
      </span>
      <span className={s.tableMeta}>
        {item.direction ? `p ${pText(item.adjustedP)} after correction · ` : ""}
        {plural(item.evaluations, "evaluation", "evaluations")}
      </span>
      {item.interval && (
        <span className={s.tableMeta}>
          Difference in share met: {percent(item.interval.lower)} to {percent(item.interval.upper)}{" "}
          (95% range)
        </span>
      )}
    </>
  );
}

function shareText(item: PatternShare) {
  return `${item.builds} of ${item.of} ${item.of === 1 ? "build" : "builds"} · ${percent(item.builds / Math.max(1, item.of))} (${percent(item.interval.lower)}–${percent(item.interval.upper)})`;
}

/** "3 of 8 builds · 2 without a code analysis": the builds of the other side of a pattern test. */
function countsText(family: PatternFamily, counts: PatternCounts) {
  return `${counts.builds} of ${counts.of} ${counts.of === 1 ? "build" : "builds"}${counts.excluded ? ` · ${counts.excluded} ${uncountedNames[family]}` : ""}`;
}

function patternLabel({ family, key }: PatternTableRow): ReactNode {
  if (family === "stops") return stopNames[key as BuildStop];
  if (family === "gateFailures") return localChecks[key] ?? key.replaceAll("_", " ");
  if (family === "refusedBatches") return "Builds with refused tool calls";
  if (family === "causes") return causeLabel(key as OutcomeCause);
  if (family === "scriptErrors")
    return key === "build" ? "From the build’s own scripts" : "From an unknown script";
  return <code>{key}</code>;
}

/** The count of events of a pattern of the selected model, for example "3 findings". */
function eventsText({ family, own }: PatternTableRow) {
  const events = own?.events;
  if (events === null || events === undefined) return "";
  const [one, many] =
    family === "failedToolCalls"
      ? ["call", "calls"]
      : family === "refusedBatches"
        ? ["turn", "turns"]
        : ["finding", "findings"];
  return ` · ${events} ${events === 1 ? one : many}`;
}

/**
 * The failure patterns of one model, with a pattern test for each pair. Each row counts builds,
 * with an exact 95% range. A pattern that only the other side shows has a row with 0 builds.
 */
function Patterns({
  patterns,
  title,
  rows,
  columns,
  toolSets,
}: {
  patterns: ModelReport["models"][number]["patterns"];
  title: string;
  rows: PatternTableRow[];
  /** The row and the heading of the column of each pair. */
  columns: Array<{ id: string; label: string }>;
  toolSets: boolean;
}) {
  const families = [...new Set(rows.map((row) => row.family))];
  return (
    <section className={s.section} aria-labelledby="models-patterns">
      <h3 id="models-patterns">Failure patterns of {title}</h3>
      <p className={s.small}>
        Each row counts the builds that show a pattern. Local checks and tool calls count only the{" "}
        {patterns.recordedBuilds} of {patterns.builds} builds with a saved record.{" "}
        {patterns.lint.analyzed
          ? `Code analysis counts only the ${patterns.lint.analyzed} of ${patterns.builds} builds with a code analysis, and script errors only the ${patterns.scriptErrors.measured} of those with an observation that checks for errors.`
          : "No build has a code analysis, so there are no code analysis findings or script errors to show."}
      </p>
      {toolSets && families.includes("lint") && (
        <p className={s.small}>
          If a tool set shows the model its code analysis, fewer findings are expected, because the
          same analysis makes these counts. Fewer findings alone don’t show that the mechanic works.
          The criteria above show how often the builds meet each criterion.
        </p>
      )}
      <ScrollRegion label={`Failure patterns of ${title}`}>
        <table className={s.stackTable}>
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col">Builds</th>
              {columns.map((column) => (
                <th scope="col" key={column.id}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {families.map((family) => (
              <Fragment key={family}>
                <tr className={s.groupHeading}>
                  <th scope="colgroup" colSpan={2 + columns.length}>
                    {familyTitles[family]}
                  </th>
                </tr>
                {rows
                  .filter((row) => row.family === family)
                  .map((row) => (
                    <tr key={`${family}:${row.key}`}>
                      <th scope="row">{patternLabel(row)}</th>
                      <td data-label="Builds">
                        {row.own
                          ? `${shareText(row.own)}${eventsText(row)}`
                          : `0 of ${row.of} ${row.of === 1 ? "build" : "builds"}`}
                      </td>
                      {row.comparisons.map((item, position) => (
                        <td key={columns[position]!.id} data-label={columns[position]!.label}>
                          {item ? (
                            <>
                              <strong>{patternVerdictWords[item.verdict]}</strong>
                              <span className={s.tableMeta}>{countsText(family, item.other)}</span>
                              {item.direction && (
                                <span className={s.tableMeta}>
                                  p {pText(item.adjustedP)} after correction
                                </span>
                              )}
                            </>
                          ) : (
                            "No builds to compare"
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </section>
  );
}
