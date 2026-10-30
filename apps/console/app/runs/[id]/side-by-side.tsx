"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowsLeftRight, CaretLeft } from "@phosphor-icons/react";
import type { SideBySideEvidence } from "../../../../../dist/packages/contracts/src/console.js";
import { statusLabel } from "../../../../../dist/packages/contracts/src/catalog.js";
import { judgedFrameText } from "../../../../../dist/packages/contracts/src/evidence-display.js";
import { read, message } from "../../components/api";
import { DeliveredImage } from "../../components/evidence-viewer";
import {
  checkExplanation,
  observedValues,
  problemSummary,
  sampledAnswer,
  statementText,
} from "../../components/result-display";
import { EmptyState, Loading, Notice, ProblemText, markClass } from "../../components/ui";
import s from "../../components/workbench.module.css";
import r from "../../components/run-experience.module.css";

type Side = SideBySideEvidence["sides"][number];
type Row = SideBySideEvidence["rows"][number];

const seconds = (ms: number) => `${(Math.abs(ms) / 1000).toFixed(3)} s`;
/** Where an image sits: its snapshot, or its time from the anchor of its recorded phase. */
function moment(row: Row, offsetMs: number) {
  if (row.phase.kind === "capture") return `Snapshot · ${row.label}`;
  if (row.phase.kind === "transition")
    return `${seconds(offsetMs)} ${offsetMs < 0 ? "before" : "after"} the ${row.phase.id} event`;
  // A recording without a measured transition counts from its first frame.
  return `${seconds(offsetMs)} into the recording`;
}

/**
 * Two builds of one evaluation, one criterion and one observation, on one screen. Rows pair the
 * images of the two builds by test player, recorded phase and time, never by frame number.
 */
export function SideBySide({
  operationId,
  left,
  right,
  criterionId,
  observation,
  navigate,
}: {
  operationId: string;
  left: string;
  right: string;
  criterionId: string;
  observation: string;
  navigate: (changes: Record<string, string>) => void;
}) {
  const [value, setValue] = useState<SideBySideEvidence | null>(null),
    [error, setError] = useState(""),
    [player, setPlayer] = useState("");
  const heading = useRef<HTMLHeadingElement>(null),
    focused = useRef(false);
  const base = `/api/operations/${operationId}`;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void read<SideBySideEvidence>(
      `${base}/side-by-side?${new URLSearchParams({ left, right, criterion: criterionId, pass: observation })}`,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [base, left, right, criterionId, observation]);
  // The heading takes focus once, when the comparison first opens. A later choice keeps focus.
  useEffect(() => {
    if (!value || focused.current) return;
    focused.current = true;
    heading.current?.focus();
  }, [value]);
  const back = (
    <nav className={r.evidenceBar} aria-label="Comparison navigation">
      <button
        className={s.textButton}
        onClick={() =>
          navigate({ tab: "evidence", criterion: criterionId, pass: observation, other: "" })
        }
      >
        <CaretLeft size={16} aria-hidden />
        Back to evidence
      </button>
      {value && (
        <button
          className={s.secondary}
          onClick={() => navigate({ candidate: right, other: left, pass: observation })}
        >
          <ArrowsLeftRight size={16} aria-hidden />
          Swap sides
        </button>
      )}
    </nav>
  );
  if (error && !value)
    return (
      <>
        {back}
        <Notice>
          <ProblemText text={error} />
        </Notice>
      </>
    );
  if (!value) return <Loading label="Loading the comparison" />;
  const stale =
    value.sides[0]?.candidateId !== left ||
    value.sides[1]?.candidateId !== right ||
    value.criterion.id !== criterionId ||
    String(value.pass) !== observation;
  const players = [
    ...new Set(value.rows.flatMap((row) => (row.player === null ? [] : [row.player]))),
  ].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const shown = players.includes(player) ? player : (players[0] ?? "");
  const rows = value.rows.filter((row) => row.player === null || row.player === shown);
  const code = value.criterion.method === "deterministic";
  const titleOf = (side: Side) =>
    value.builds.find((build) => build.candidateId === side.candidateId)?.title ?? "Build";
  const imageUrl = (side: Side, imageId: string) =>
    `${base}/asset?${new URLSearchParams({ candidate: side.candidateId, item: side.itemId!, pass: side.passId!, image: imageId })}`;
  const choose = (position: number, id: string) =>
    navigate(
      position === 0 ? { candidate: id, pass: observation } : { other: id, pass: observation },
    );
  return (
    <>
      {back}
      {error && (
        <Notice>
          <ProblemText text={error} /> Showing the comparison loaded earlier.
        </Notice>
      )}
      <section className={`${s.questionContext} ${r.evidenceHeading}`}>
        <h2 ref={heading} tabIndex={-1}>
          {statementText(value.criterion.statement)}
        </h2>
        <p className={s.small} role="status" aria-live="polite">
          {stale
            ? "Loading the comparison…"
            : `Observation ${value.pass} · ${code ? "Checked by code" : "Checked by a judge"}`}
        </p>
      </section>
      <div className={r.sidePickers}>
        {value.observations.length > 1 && (
          <div className={s.field}>
            <label htmlFor="side-by-side-observation">Observation</label>
            <select
              id="side-by-side-observation"
              value={observation}
              onChange={(event) => navigate({ pass: event.target.value })}
            >
              {value.observations.map((number) => (
                <option key={number} value={number}>
                  Observation {number}
                </option>
              ))}
            </select>
          </div>
        )}
        {players.length > 1 && !code && (
          <div className={s.field}>
            <label htmlFor="side-by-side-player">Test player</label>
            <select
              id="side-by-side-player"
              value={shown}
              onChange={(event) => setPlayer(event.target.value)}
            >
              {players.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className={`${r.sideBySide} ${r.sideCards}`} data-side-by-side>
        {value.sides.map((side, position) => (
          <section key={position} className={r.sideCard} aria-labelledby={`side-${position}`}>
            <div className={s.field}>
              <label id={`side-${position}`} htmlFor={`side-build-${position}`}>
                {position === 0 ? "First build" : "Second build"}
              </label>
              <select
                id={`side-build-${position}`}
                value={side.candidateId}
                onChange={(event) => choose(position, event.target.value)}
              >
                {value.builds
                  .filter(
                    (build) =>
                      build.candidateId === side.candidateId ||
                      build.candidateId !== value.sides[1 - position]?.candidateId,
                  )
                  .map((build) => (
                    <option key={build.candidateId} value={build.candidateId}>
                      {build.model} · {build.title}
                    </option>
                  ))}
              </select>
            </div>
            <p className={r.sideAnswer}>
              {side.cell && (
                <span className={`${s.mark} ${markClass(side.cell.outcome)}`} aria-hidden>
                  {side.cell.pass}
                </span>
              )}
              {side.cell
                ? (sampledAnswer(side.cell.samples) ?? statusLabel(side.cell.outcome))
                : "No answer"}
            </p>
            {side.absent && (
              <p className={r.evidenceReason} data-absent>
                {side.absent}
              </p>
            )}
            {side.cell &&
              (side.cell.outcome === "missing" || side.cell.outcome === "incomplete") &&
              side.cell.explanation && (
                <p className={r.evidenceReason}>{problemSummary(side.cell.explanation)}</p>
              )}
            {code && side.cell?.criterion && (
              <>
                <p className={s.small} data-observed>
                  {observedValues(side.cell.criterion.explanation, side.cell.criterion.observed) ??
                    "No recorded values."}
                </p>
                <p className={s.small}>{checkExplanation(side.cell.criterion.explanation)}</p>
              </>
            )}
          </section>
        ))}
      </div>
      {code ? (
        <p className={s.small}>
          A code check reads recorded values, not images, so this comparison shows the values.
        </p>
      ) : !rows.length ? (
        <EmptyState title="No images to compare">
          Neither build has images for this observation.
        </EmptyState>
      ) : (
        <>
          <p className={s.small}>
            Shows every recorded frame, not only the frames the judge saw. A frame the judge saw
            says why it was chosen and stays with the event the judge saw it with. Any other frame
            goes with the nearest event.
          </p>
          <p className={s.small}>
            Images line up by test player, by phase and by time from the start of the phase. Two
            images pair when their times differ by {seconds(value.toleranceMs)} or less. Frame
            numbers don’t pair images.
          </p>
          <ol className={r.sideRows} aria-label="Images side by side">
            {rows.map((row, index) => (
              <li key={index} className={r.sideBySide} data-side-row>
                {value.sides.map((side, position) => {
                  const image = row.sides[position];
                  const judged = image && judgedFrameText(image.roles);
                  return image && side.itemId && side.passId ? (
                    <figure key={position} className={r.sideImage}>
                      <div className={s.viewer}>
                        <DeliveredImage
                          lazy
                          url={imageUrl(side, image.imageId)}
                          alt={`${titleOf(side)}, ${row.player ? `${row.player}, ` : ""}${moment(row, image.offsetMs)}`}
                        />
                      </div>
                      <figcaption className={s.small}>
                        {titleOf(side)} · {row.player ? `${row.player} · ` : ""}
                        {moment(row, image.offsetMs)}
                        {judged && (
                          <span className={r.judgedFrame} data-judged>
                            {judged}
                          </span>
                        )}
                      </figcaption>
                    </figure>
                  ) : (
                    <div key={position} className={r.sideMissing} data-missing>
                      <p>No image at this moment</p>
                      <p className={s.small}>
                        {side.absent ??
                          `${titleOf(side)} has no image of this phase within ${seconds(value.toleranceMs)}.`}
                      </p>
                    </div>
                  );
                })}
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
