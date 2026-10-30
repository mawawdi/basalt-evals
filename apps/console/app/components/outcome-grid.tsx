"use client";
import Link from "next/link";
import { CaretDown } from "@phosphor-icons/react";
import type {
  BenchmarkBuild,
  BenchmarkMark,
  BenchmarkReport,
  BenchmarkTreatmentReport,
} from "../../../../dist/packages/contracts/src/benchmarks.js";
import { formatMoney } from "./api";
import { OutcomeBar, OutcomeLegend, markClass } from "./ui";
import { SplitBar } from "./split-bar";
import { countList, sampledAnswer, statementText } from "./result-display";
import s from "./workbench.module.css";
import b from "./benchmark.module.css";
import g from "./outcome-grid.module.css";

export type GridMeasure = "answers" | "charge" | "time";
export const gridMeasures: Array<[GridMeasure, string]> = [
  ["answers", "Answers"],
  ["charge", "Charge"],
  ["time", "Build time"],
];

/** Benchmark answers say "met"; the shared result marks use the evidence word "verified". */
function markOutcome(outcome: BenchmarkMark["outcome"]) {
  return outcome === "met" ? "verified" : outcome;
}
function markAnswer(mark: BenchmarkMark, active: boolean) {
  // Two or more judge samples say how many of them met the criterion: "Met 3 of 3".
  const sampled =
    mark.samples && mark.outcome !== "missing"
      ? sampledAnswer({
          ...mark.samples,
          answer: mark.outcome === "rejected" ? "not_met" : mark.outcome,
        })
      : null;
  if (sampled) return sampled;
  if (mark.outcome === "met") return "Met";
  if (mark.outcome === "rejected") return "Not met";
  if (mark.outcome === "scored") return `Score ${mark.score ?? ""}`.trim();
  if (mark.outcome === "insufficient") return "Not enough evidence";
  return active ? "Not yet checked" : "Unavailable";
}
const duration = (ms: number) =>
  ms === 0
    ? "0 s"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${(ms / 60000).toFixed(1)} min`;
const toolSet = (row: BenchmarkTreatmentReport) => row.harnessTitle;

/** The answers of a group of checks: the outcome bar, the counts and, if given, the builds. */
export function Answers({
  answers,
  settled,
  builds,
}: {
  answers: BenchmarkTreatmentReport["cases"][number]["answers"];
  settled: boolean;
  builds?: number;
}) {
  // "Not enough evidence" is an answer. Only a missing answer is unavailable or not yet checked.
  const a = answers;
  return (
    <>
      <OutcomeBar
        met={a.met}
        failed={a.rejected}
        split={a.split}
        scored={a.scored}
        insufficient={a.insufficient}
        unavailable={settled ? a.missing : 0}
        pending={settled ? 0 : a.missing}
      />
      <p className={g.counts}>
        {countList([
          `${a.met} met`,
          `${a.rejected} not met`,
          a.split > 0 && `${a.split} split`,
          a.scored > 0 && `${a.scored} scored`,
          a.insufficient > 0 && `${a.insufficient} not enough evidence`,
          a.missing > 0 && `${a.missing} ${settled ? "unavailable" : "not yet checked"}`,
        ])}
      </p>
      {builds !== undefined && (
        <small>
          {builds} {builds === 1 ? "build" : "builds"}
        </small>
      )}
    </>
  );
}

function BuildParts({
  build,
  measure,
  model,
}: {
  build: BenchmarkBuild;
  measure: "charge" | "time";
  model: string;
}) {
  const { charge, time } = build.breakdown;
  return (
    <div className={g.buildPart}>
      <span className={g.buildName}>Build {build.number}</span>
      {measure === "charge" ? (
        <SplitBar
          caption={`Charges of build ${build.number}, ${model}`}
          format={formatMoney}
          parts={[
            { label: "Builder", value: charge.builderUsd, tone: "solid" as const },
            { label: "Judge", value: charge.judgeUsd, tone: "mid" as const },
            ...(charge.pendingUsd > 0
              ? [{ label: "Pending", value: charge.pendingUsd, tone: "pending" as const }]
              : []),
          ]}
        />
      ) : (
        <SplitBar
          caption={`Time of build ${build.number}, ${model}`}
          format={duration}
          figure={{ label: "Build time", value: time.buildMs, absent: "Not timed yet" }}
          parts={[
            { group: "Build", label: "Model turns", value: time.builderTurnsMs, tone: "solid" },
            {
              group: "Build",
              label: "Waiting for Studio",
              value: time.builderStudioWaitMs,
              tone: "light",
            },
            { group: "Build", label: "Studio time", value: time.builderStudioMs, tone: "mid" },
            {
              group: "Observations",
              label: "Waiting for Studio",
              value: time.observationStudioWaitMs,
              tone: "light",
            },
            {
              group: "Observations",
              label: "Studio time",
              value: time.observationStudioMs,
              tone: "mid",
            },
            { group: "Judge", label: "Checks", value: time.judgeMs, tone: "outline" },
          ]}
        />
      )}
    </div>
  );
}

function Marks({
  report,
  builds,
  criterionId,
  statement,
  active,
}: {
  report: BenchmarkReport;
  builds: BenchmarkBuild[];
  criterionId: string;
  statement: string;
  active: boolean;
}) {
  const groups = builds
    .map((build) => ({
      build,
      marks: build.marks.filter((mark) => mark.criterionId === criterionId),
    }))
    .filter((group) => group.marks.length);
  if (!groups.length)
    return (
      <span className={g.none}>
        {builds.length && builds.every((build) => build.notReached) ? "Not reached" : "Not checked"}
      </span>
    );
  return (
    <div className={g.builds}>
      {groups.map(({ build, marks }) => (
        <div className={g.build} key={build.subjectId}>
          <span className={g.buildName} aria-hidden>
            Build {build.number}
          </span>
          <span className={g.marks}>
            {marks.map((mark) => (
              <Link
                key={mark.evidenceCellId}
                data-mark=""
                className={`${s.mark} ${markClass(markOutcome(mark.outcome), active)}`}
                href={`/runs/${report.operationId}?tab=evidence&candidate=${mark.subjectId}&criterion=${encodeURIComponent(mark.evidenceCellId)}&pass=${mark.pass}`}
                aria-label={`${statement}, build ${build.number}, observation ${mark.pass}: ${markAnswer(mark, active)}`}
                title={`Build ${build.number}, observation ${mark.pass}: ${markAnswer(mark, active)}`}
              >
                {mark.pass}
              </Link>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The builds of a later stage that started, each with a link to the build of the stage before it
 * that it continues. A build that the run did not reach is counted, never marked as a failure.
 */
function StageBuilds({
  report,
  builds,
  parents,
  stage,
}: {
  report: BenchmarkReport;
  builds: BenchmarkBuild[];
  parents: BenchmarkBuild[];
  stage: number;
}) {
  const reached = builds.filter((build) => !build.notReached);
  const notReached = builds.length - reached.length;
  return (
    <>
      {reached.map((build) => {
        const parent = parents.find((item) => item.subjectId === build.parentSubjectId);
        return parent ? (
          <small key={build.subjectId} className={g.parent}>
            Build {build.number} continues{" "}
            <Link href={`/runs/${report.operationId}?tab=evidence&candidate=${parent.subjectId}`}>
              build {parent.number} of stage {stage - 1}
            </Link>
          </small>
        ) : null;
      })}
      {notReached > 0 && reached.length > 0 && (
        <small className={g.parent}>
          {notReached} {notReached === 1 ? "build" : "builds"} not reached
        </small>
      )}
    </>
  );
}

/**
 * The results of each evaluation as a table: one column for each model and tool set, an
 * evaluation row that opens to one row for each criterion, in authored order. Nothing is
 * sorted, ranked or added across models.
 */
export function OutcomeGrid({
  report,
  harness,
  measure,
  open,
  onToggle,
}: {
  report: BenchmarkReport;
  harness: string;
  measure: GridMeasure;
  open: string[];
  onToggle: (evaluationId: string) => void;
}) {
  const settled = report.finished || report.stopped,
    active = !settled;
  const columns = report.rows.filter((row) => harness === "all" || row.harnessId === harness);
  const severalToolSets = new Set(report.rows.map((row) => row.harnessId)).size > 1;
  const label = (row: BenchmarkTreatmentReport) =>
    severalToolSets ? `${row.modelName}, ${toolSet(row)}` : row.modelName;
  const shown = (outcome: BenchmarkMark["outcome"]) =>
    columns.some((row) =>
      row.cases.some((item) =>
        item.builds.some((build) => build.marks.some((mark) => mark.outcome === outcome)),
      ),
    );
  return (
    <div className={b.cases}>
      <div className={g.intro}>
        <OutcomeLegend
          pending={active}
          scored={shown("scored")}
          split={shown("split")}
          insufficient={shown("insufficient")}
        />
        {measure === "charge" && (
          <p className={b.support}>
            Each build shows its builder and judge charges separately. A hatched part is a pending
            charge or a charge that wasn’t recorded.
          </p>
        )}
        {measure === "time" && (
          <p className={b.support}>
            Build time counts only the time the model worked on the build, without paused time.
            Observations and checks can run alongside other work, so the parts don’t add up to an
            elapsed time.
          </p>
        )}
      </div>
      {report.evaluations.map((evaluation, index) => {
        const title = evaluation.title ?? `Evaluation ${index + 1}`;
        const cases = columns.map(
          (row) => row.cases.find((item) => item.evaluationId === evaluation.evaluationId) ?? null,
        );
        // Authored criteria first. A planned criterion without a saved definition follows them.
        // Its revision could not be read, so it has no authored number, and the grid invents none.
        const authored = report.criteria.filter(
          (row) => row.evaluationId === evaluation.evaluationId,
        );
        const planned = [
          ...new Set(
            cases.flatMap(
              (item) =>
                item?.builds.flatMap((build) => build.marks.map((mark) => mark.criterionId)) ?? [],
            ),
          ),
        ].filter((id) => !authored.some((row) => row.criterionId === id));
        const criteria = [
          ...authored.map((row) => ({
            id: row.criterionId,
            statement: statementText(row.statement),
            required: row.required,
          })),
          ...planned.map((id) => ({
            id,
            statement: "Unnamed criterion",
            required: true,
          })),
        ];
        // A later stage is its own evaluation. Its builds continue the builds of the stage before.
        const stage = evaluation.stage;
        const earlier =
          stage.index > 1
            ? report.evaluations.find(
                (item) =>
                  item.stage.firstEvaluationId === stage.firstEvaluationId &&
                  item.stage.index === stage.index - 1,
              )
            : undefined;
        const expanded = open.includes(evaluation.evaluationId);
        const rowsId = `criteria-${evaluation.evaluationId}`;
        return (
          <section className={b.group} key={evaluation.evaluationId}>
            <div className={b.caseHeading}>
              <h2>{title}</h2>
              <Link
                className={s.action}
                href={`/evaluations/${stage.firstEvaluationId}${stage.count > 1 ? `#stage-${stage.index}` : ""}`}
              >
                Open evaluation
              </Link>
            </div>
            <table className={g.grid} aria-label={`Results for ${title}`}>
              <thead>
                <tr>
                  <th scope="col">Criteria</th>
                  {columns.map((row) => (
                    <th scope="col" key={row.id}>
                      {row.modelName}
                      {severalToolSets && <small>{toolSet(row)}</small>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className={g.evaluationRow}>
                  <th scope="row">
                    <button
                      type="button"
                      className={s.textButton}
                      aria-expanded={expanded}
                      aria-controls={rowsId}
                      onClick={() => onToggle(evaluation.evaluationId)}
                    >
                      <CaretDown size={14} aria-hidden className={s.expandCaret} />
                      All criteria
                      <span className={g.count}>{criteria.length}</span>
                      <span className={b.visuallyHidden}> of {title}</span>
                    </button>
                  </th>
                  {columns.map((row, column) => {
                    const item = cases[column];
                    return (
                      <td key={row.id} data-label={label(row)}>
                        {!item || !item.builds.length ? (
                          <span className={g.none}>No planned build</span>
                        ) : item.builds.every((build) => build.notReached) ? (
                          <span className={g.none}>Not reached</span>
                        ) : measure === "answers" ? (
                          <Answers
                            answers={item.answers}
                            settled={settled}
                            builds={item.builds.filter((build) => !build.notReached).length}
                          />
                        ) : (
                          item.builds
                            .filter((build) => !build.notReached)
                            .map((build) => (
                              <BuildParts
                                key={build.subjectId}
                                build={build}
                                measure={measure}
                                model={label(row)}
                              />
                            ))
                        )}
                        {item && earlier && (
                          <StageBuilds
                            report={report}
                            builds={item.builds}
                            parents={
                              row.cases.find((other) => other.evaluationId === earlier.evaluationId)
                                ?.builds ?? []
                            }
                            stage={stage.index}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
              <tbody id={rowsId} hidden={!expanded}>
                {expanded &&
                  criteria.map((criterion) => (
                    <tr key={criterion.id}>
                      <th scope="row">
                        {criterion.statement}
                        {!criterion.required && <small>Optional</small>}
                      </th>
                      {columns.map((row, column) => (
                        <td key={row.id} data-label={label(row)}>
                          <Marks
                            report={report}
                            builds={cases[column]?.builds ?? []}
                            criterionId={criterion.id}
                            statement={criterion.statement}
                            active={active}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
