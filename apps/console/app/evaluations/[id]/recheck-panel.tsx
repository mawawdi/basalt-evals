"use client";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import type {
  RecheckAnswer,
  RecheckCell,
  RecheckPreview,
} from "../../../../../dist/packages/contracts/src/recheck.js";
import { action, message } from "../../components/api";
import { statementText } from "../../components/result-display";
import { Arrow, Notice, ScrollRegion } from "../../components/ui";
import s from "../../components/workbench.module.css";
import { KnownBuildMark } from "./known-build-actions";
import { RecheckLaunch } from "./recheck-launch";

type Presentation = "still" | "sequence" | "grounded-sequence";
/** The saved builds of one stage of a run. A recheck checks builds of one stage. */
type SavedRun = {
  key: string;
  operationId: string;
  title: string;
  builds: Array<{ id: string; title: string }>;
};

const actionNames: Record<RecheckCell["action"], string> = {
  reuse: "Reuse",
  code_recheck: "Code check again",
  judge_recheck: "Judge again",
  new_observation: "Observe again",
  new_build: "Needs a new build",
  drop: "Removed",
  not_reached: "Not reached",
};
const reasonNames: Record<RecheckCell["reason"], string> = {
  unchanged: "Nothing changed",
  criterion_changed: "The check changed",
  criterion_added: "New criterion",
  criterion_removed: "Criterion removed",
  judge_changed: "Different judge",
  studio_plan_changed: "The Studio plan changed",
  public_content_changed: "The prompt or starting files changed",
  shared_request_changed: "Shares a judge request with a changed criterion",
  not_checked: "Not checked in that run",
  parent_gate_failed: "An earlier stage fails its gate",
  parent_gate_changed: "An earlier stage’s gate changed",
};
const answerNames: Record<RecheckAnswer, string> = {
  met: "Met",
  not_met: "Not met",
  split: "Split",
  scored: "Scored",
  insufficient: "Not enough evidence",
};
/** The words for an answer that does not exist yet. */
const pendingNames: Record<RecheckCell["action"], string> = {
  reuse: "No answer",
  code_recheck: "—",
  judge_recheck: "After the judge check",
  new_observation: "After a new observation",
  new_build: "Needs a new build",
  drop: "Removed",
  not_reached: "Not reached",
};

/** How the judge part repeats the judge settings of the run. Null for the usual settings. */
function judgeSettingsNote({ samples, grouping }: RecheckPreview["judgeSettings"]) {
  const sentences = [
    ...(samples > 1
      ? [
          `The judge answers each check ${samples} times, as in the run. If the answers disagree, the check shows as Split.`,
        ]
      : []),
    ...(grouping === "per_criterion"
      ? ["As in the run, the judge sees one criterion at a time."]
      : []),
  ];
  return sentences.length ? sentences.join(" ") : null;
}

/**
 * Check the saved builds of a run again with this version of the evaluation. Each build and
 * criterion shows its action, the reason and the answer before and after. Code checks run in
 * the free check. Judge checks and new observations are separate runs with a spending limit.
 */
export function RecheckPanel({
  revisionId,
  evaluationId,
  runs,
  models,
}: {
  revisionId: string;
  /** The library evaluation. Without it, a build can't be marked as a known build. */
  evaluationId: string | null;
  runs: SavedRun[];
  models: Array<{ id: string; name: string }>;
}) {
  const fieldId = useId();
  const working = useRef(false);
  const [choice, setChoice] = useState(runs[0]?.key ?? ""),
    [builds, setBuilds] = useState<string[]>(runs[0]?.builds.map((build) => build.id) ?? []),
    [judgeModel, setJudgeModel] = useState(""),
    [presentation, setPresentation] = useState<Presentation>("still"),
    [preview, setPreview] = useState<RecheckPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = runs.find((item) => item.key === choice);
  const title = (subjectId: string) =>
    run?.builds.find((build) => build.id === subjectId)?.title ?? subjectId;
  async function check() {
    if (working.current || !run || !builds.length) return;
    working.current = true;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      setPreview(
        await action<RecheckPreview>(`/api/evaluations/${revisionId}/recheck`, "preview_recheck", {
          operationId: run.operationId,
          subjectIds: run.builds.map((build) => build.id).filter((id) => builds.includes(id)),
          judge: judgeModel ? { modelId: judgeModel, presentation } : null,
        }),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const observations = (cells: RecheckCell[], subjectId: string) => [
    ...new Set(cells.filter((cell) => cell.subjectId === subjectId).map((cell) => cell.captureId)),
  ];
  return (
    <details id="recheck" className={s.section}>
      <summary>Check saved builds again</summary>
      <p className={s.small}>
        See what this version changes for builds you already have. Answers whose check didn’t change
        stay as they are. Code checks run again right away at no cost. Judge checks and new Studio
        observations are separate runs with their own spending limit.
      </p>
      {!runs.length ? (
        <p className={s.small}>No run has saved builds of this evaluation yet.</p>
      ) : (
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <div className={s.field}>
            <label htmlFor={fieldId + "-run"}>Run</label>
            <select
              id={fieldId + "-run"}
              disabled={busy}
              value={choice}
              onChange={(event) => {
                const next = runs.find((item) => item.key === event.target.value);
                setChoice(event.target.value);
                setBuilds(next?.builds.map((build) => build.id) ?? []);
                setPreview(null);
              }}
            >
              {runs.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          {run && (
            <fieldset>
              <legend>Builds</legend>
              <div className={s.selectionGrid}>
                {run.builds.map((build) => (
                  <label className={s.choice} key={build.id}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={builds.includes(build.id)}
                      onChange={(event) =>
                        setBuilds(
                          event.target.checked
                            ? [...builds, build.id]
                            : builds.filter((id) => id !== build.id),
                        )
                      }
                    />
                    <span>{build.title}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className={s.field}>
            <label htmlFor={fieldId + "-judge"}>Judge</label>
            <select
              id={fieldId + "-judge"}
              disabled={busy}
              value={judgeModel}
              onChange={(event) => setJudgeModel(event.target.value)}
            >
              <option value="">No new judge checks</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <small>
              A different judge checks every judge criterion again. Without a judge, only changed
              judge criteria wait for one.
            </small>
          </div>
          {judgeModel && (
            <div className={s.field}>
              <label htmlFor={fieldId + "-presentation"}>Evidence presentation</label>
              <select
                id={fieldId + "-presentation"}
                disabled={busy}
                value={presentation}
                onChange={(event) => setPresentation(event.target.value as Presentation)}
              >
                <option value="still">Still images</option>
                <option value="sequence">Recorded sequence</option>
                <option value="grounded-sequence">Notes from recorded sequence</option>
              </select>
            </div>
          )}
          <button className={s.primary} type="submit" disabled={busy || !builds.length}>
            {busy ? "Checking builds…" : "Check builds"}
          </button>
          {!builds.length && <p role="status">Choose at least one build to continue.</p>}
        </form>
      )}
      {error && <Notice>{error}</Notice>}
      {preview && (
        <>
          {preview.unavailable.map((item) => (
            <Notice key={item.part} kind="info">
              {item.reason}
            </Notice>
          ))}
          {preview.gates
            .filter((gate) => gate.state !== "passed")
            .map((gate) => (
              <Notice key={`${gate.subjectId}:${gate.stage}`} kind="info">
                {title(gate.subjectId)}: {gate.reason}
                {gate.parent && (
                  <>
                    {" "}
                    <Link
                      href={`/runs/${gate.parent.operationId}?tab=evidence&candidate=${encodeURIComponent(gate.parent.subjectId)}`}
                    >
                      Open the stage {gate.stage} build
                    </Link>
                  </>
                )}
              </Notice>
            ))}
          {preview.holdoutCaptureIds.length > 0 && (
            <p className={s.small}>
              The code checks read {preview.holdoutCaptureIds.length} withheld{" "}
              {preview.holdoutCaptureIds.length === 1 ? "observation" : "observations"}. Basalt
              records each first read as a look at the withheld observations.
            </p>
          )}
          <ScrollRegion className={s.tableWrap} label="Saved builds checked again">
            <table className={s.conditionTable}>
              <thead>
                <tr>
                  <th scope="col">Build</th>
                  <th scope="col">Criterion</th>
                  <th scope="col">Action</th>
                  <th scope="col">Reason</th>
                  <th scope="col">
                    Before <Arrow /> after
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.cells.map((cell) => {
                  const captures = observations(preview.cells, cell.subjectId);
                  return (
                    <tr
                      key={`${cell.captureId}:${cell.fromCriterionId ?? ""}:${cell.toCriterionId ?? ""}`}
                    >
                      <th scope="row">
                        {title(cell.subjectId)}
                        {captures.length > 1 &&
                          ` · Observation ${captures.indexOf(cell.captureId) + 1}`}
                      </th>
                      <td>{statementText(cell.authoredText)}</td>
                      <td>{actionNames[cell.action]}</td>
                      <td>
                        {reasonNames[cell.reason]}
                        {cell.issue && <p className={s.small}>{cell.issue}</p>}
                      </td>
                      <td>
                        {cell.before ? answerNames[cell.before] : "No answer"} <Arrow />
                        <span className={s.visuallyHidden}>then</span>{" "}
                        {cell.after ? answerNames[cell.after] : pendingNames[cell.action]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
          {preview.judge && judgeSettingsNote(preview.judgeSettings) && (
            <p className={s.small}>{judgeSettingsNote(preview.judgeSettings)}</p>
          )}
          {(preview.judge || preview.observation) && (
            <div className={s.actionList}>
              {preview.judge && (
                <RecheckLaunch
                  label="Run the judge checks"
                  part="judge"
                  models={models}
                  selection={preview.selection}
                />
              )}
              {preview.observation && (
                <RecheckLaunch
                  label="Observe the builds again"
                  part="observation"
                  models={models}
                  selection={preview.selection}
                />
              )}
            </div>
          )}
          {evaluationId && (
            <div className={s.actionList}>
              {preview.selection.subjectIds.map((subjectId) => (
                <KnownBuildMark
                  key={subjectId}
                  evaluationId={evaluationId}
                  operationId={preview.selection.operationId}
                  subjectId={subjectId}
                  title={title(subjectId)}
                  criteria={[
                    ...new Map(
                      preview.cells
                        .filter(
                          (cell) =>
                            cell.subjectId === subjectId && cell.fromAuthoredCriterionId !== null,
                        )
                        .map((cell) => [
                          cell.fromAuthoredCriterionId!,
                          { id: cell.fromAuthoredCriterionId!, text: cell.authoredText },
                        ]),
                    ).values(),
                  ]}
                />
              ))}
            </div>
          )}
        </>
      )}
    </details>
  );
}
