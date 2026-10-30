"use client";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CaretLeft } from "@phosphor-icons/react";
import type {
  BuildChange,
  BuildHistoryPage,
  BuildToolCall,
  BuildTurn,
} from "../../../../dist/packages/contracts/src/build-history.js";
import { elapsedDuration } from "../../../../dist/packages/contracts/src/display.js";
import { read, message, formatMoney } from "./api";
import { EmptyState, Loading, Notice, ProblemText, Status } from "./ui";
import s from "./workbench.module.css";
import r from "./run-experience.module.css";
import h from "./build-history.module.css";

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;

/** The argument that names what a tool call worked on, in a few words. */
function subject(call: BuildToolCall): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.path === "string") return args.path;
  if (typeof args.text === "string") return `“${args.text}”`;
  if (typeof args.scenarioId === "string") return args.scenarioId;
  if (Array.isArray(args.frameIds)) return count(args.frameIds.length, "frame", "frames");
  if (typeof args.summary === "string") return args.summary;
  return "";
}

function Change({ change }: { change: BuildChange }) {
  return (
    <div className={h.change}>
      <p className={h.changeHead}>
        <strong>{change.path}</strong>
        <span>{change.kind === "created" ? "New file" : "Changed file"}</span>
        {change.added !== null && change.removed !== null && (
          <span>
            +{change.added} −{change.removed}
          </span>
        )}
      </p>
      {!change.verified ? (
        <p className={h.note}>Basalt can&apos;t verify this change.</p>
      ) : change.tooLarge || !change.hunks ? (
        <p className={h.note}>This change is too large to show.</p>
      ) : (
        <div className={h.lines} role="group" aria-label={`Change to ${change.path}`}>
          {change.hunks.map((hunk, index) => (
            <Fragment key={`${hunk.beforeStart}:${hunk.afterStart}`}>
              {index > 0 && (
                <div className={h.hunkGap} aria-hidden>
                  ⋯
                </div>
              )}
              {hunk.lines.map((line, position) => (
                <div className={h.line} data-kind={line.kind} key={position}>
                  <span aria-hidden>
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </span>
                  <span>
                    {line.kind !== "context" && (
                      <span className={s.visuallyHidden}>
                        {line.kind === "added" ? "Added: " : "Removed: "}
                      </span>
                    )}
                    {line.text}
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCall({ call, imageBase }: { call: BuildToolCall; imageBase: string }) {
  return (
    <li className={h.call}>
      <div className={h.callHead}>
        <code>{call.name}</code>
        {subject(call) && <span className={h.subject}>{subject(call)}</span>}
        {call.ok === false && <Status tone="bad">Failed</Status>}
        {call.ok === null && <Status>No result</Status>}
      </div>
      {call.luauErrors.length > 0 && (
        <ul className={h.errors} aria-label="Luau errors">
          {call.luauErrors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
      {call.change && <Change change={call.change} />}
      {call.images.length > 0 && (
        <div className={h.images}>
          {call.images.map((image) =>
            image.mediaType ? (
              <img
                key={image.hash}
                src={`${imageBase}&hash=${image.hash}`}
                loading="lazy"
                alt={`Development frame ${image.hash.slice(0, 8)}`}
              />
            ) : (
              <span key={image.hash} className={s.small}>
                Frame {image.hash.slice(0, 8)} (Basalt keeps only the latest frames)
              </span>
            ),
          )}
        </div>
      )}
      {call.result !== null && (
        <details>
          <summary>Result the builder saw</summary>
          <pre className={h.result}>{call.result}</pre>
        </details>
      )}
    </li>
  );
}

function Turn({
  turn,
  operationId,
  imageBase,
}: {
  turn: BuildTurn;
  operationId: string;
  imageBase: string;
}) {
  const tokens = [
    turn.tokens.input !== null && `${turn.tokens.input.toLocaleString("en-US")} in`,
    turn.tokens.output !== null && `${turn.tokens.output.toLocaleString("en-US")} out`,
  ].filter(Boolean);
  return (
    <li className={h.turn}>
      <div className={h.turnHead}>
        <h3>Turn {turn.number}</h3>
        <ul className={h.meta} aria-label={`Turn ${turn.number} details`}>
          <li>{tokens.length ? `${tokens.join(" · ")} tokens` : "Tokens not recorded"}</li>
          <li>{turn.chargeUsd === null ? "Charge not recorded" : formatMoney(turn.chargeUsd)}</li>
          <li>{turn.latencyMs === null ? "Time not recorded" : elapsedDuration(turn.latencyMs)}</li>
          {turn.tries > 1 && <li>{count(turn.tries, "try", "tries")}</li>}
          {turn.requestId && (
            <li>
              <Link className={s.action} href={`/runs/${operationId}/requests/${turn.requestId}`}>
                Request
              </Link>
            </li>
          )}
        </ul>
      </div>
      <div className={h.turnBody}>
        {turn.responseKind !== "assistant" ? (
          <p className={s.small}>
            {turn.responseKind === "provider_error"
              ? "The provider returned an error, so this turn has no answer."
              : turn.responseKind === "spending_limit"
                ? "The run reached its spending limit before this request."
                : "This turn has no answer from the model."}
          </p>
        ) : !turn.verified ? (
          <p className={s.small}>
            Basalt can&apos;t verify this answer against its record, so it isn&apos;t shown.
          </p>
        ) : (
          turn.text && <p className={h.text}>{turn.text}</p>
        )}
        {turn.rejectedBatch && (
          <p className={s.small}>
            Basalt refused these tool calls and asked the model to fix them.
          </p>
        )}
        {turn.toolCalls.length > 0 && (
          <ul className={h.calls} aria-label={`Tool calls of turn ${turn.number}`}>
            {turn.toolCalls.map((call) => (
              <ToolCall key={call.id} call={call} imageBase={imageBase} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** How one build was built: what the builder saw, turn by turn, with each change. */
export function BuildHistoryView({
  operationId,
  candidateId,
  title,
  page,
  navigate,
  hints,
}: {
  operationId: string;
  candidateId: string;
  title: string;
  page: number;
  navigate: (changes: Record<string, string>) => void;
  /** The keyboard shortcuts of the run page, under Build navigation. */
  hints?: ReactNode;
}) {
  const [history, setHistory] = useState<BuildHistoryPage | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!candidateId) return;
    const controller = new AbortController();
    setError("");
    void read<BuildHistoryPage>(
      `/api/operations/${operationId}/build?candidate=${encodeURIComponent(candidateId)}&page=${page}`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setHistory(null);
          setError(message(cause));
        }
      });
    return () => controller.abort();
  }, [operationId, candidateId, page, attempt]);
  useEffect(() => {
    heading.current?.focus();
  }, [candidateId, history?.page]);
  const current = history?.subjectId === candidateId ? history : null;
  return (
    <>
      <nav className={r.evidenceBar} aria-label="Build navigation">
        <button
          className={s.textButton}
          aria-keyshortcuts="Escape"
          onClick={() => navigate({ tab: "results", candidate: "", turns: "" })}
        >
          <CaretLeft size={16} aria-hidden />
          All results
        </button>
        <button
          className={s.textButton}
          onClick={() => navigate({ tab: "evidence", candidate: candidateId, turns: "" })}
        >
          View evidence
        </button>
      </nav>
      {hints}
      <div className={h.heading}>
        <h2 ref={heading} tabIndex={-1}>
          How it was built
        </h2>
        <p>{title}</p>
      </div>
      {error ? (
        <Notice>
          <ProblemText text={error} />
          <button className={s.secondary} onClick={() => setAttempt((value) => value + 1)}>
            Reload turns
          </button>
        </Notice>
      ) : !current ? (
        <Loading label="Loading turns" />
      ) : (
        <>
          <dl className={h.figures}>
            <div>
              <dt>Turns</dt>
              <dd>{current.totals.turns}</dd>
            </div>
            <div>
              <dt>Tool calls</dt>
              <dd>{current.totals.toolCalls}</dd>
            </div>
            <div>
              <dt>Changes</dt>
              <dd>{current.totals.changes}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <Status tone={current.finished ? "neutral" : "active"}>
                  {current.finished ? "Finished" : "In progress"}
                </Status>
              </dd>
            </div>
          </dl>
          {current.notices.map((notice) => (
            <Notice kind="info" key={notice}>
              {notice}
            </Notice>
          ))}
          <div className={h.prompts}>
            <details>
              <summary>Prompt</summary>
              <p className={h.text}>{current.prompt}</p>
            </details>
            {current.context && (
              <details>
                <summary>Repair notes</summary>
                <p className={h.text}>{current.context.text}</p>
              </details>
            )}
            <details>
              <summary>System prompt</summary>
              <p className={h.text}>{current.systemPrompt}</p>
            </details>
          </div>
          {!current.turns.length ? (
            <EmptyState title="No turns yet">The model hasn&apos;t answered yet.</EmptyState>
          ) : (
            <ol className={h.turns} aria-label="Turns">
              {current.turns.map((turn) => (
                <Turn
                  key={turn.number}
                  turn={turn}
                  operationId={operationId}
                  imageBase={`/api/operations/${operationId}/build-image?candidate=${encodeURIComponent(candidateId)}`}
                />
              ))}
            </ol>
          )}
          {current.pages > 1 && (
            <nav className={`${s.actions} ${s.pager}`} aria-label="Turn pages">
              <button
                className={s.secondary}
                disabled={current.page <= 1}
                onClick={() => navigate({ turns: String(current.page - 1) })}
              >
                Previous turns
              </button>
              <span>
                Page {current.page} of {current.pages}
              </span>
              <button
                className={s.secondary}
                disabled={current.page >= current.pages}
                onClick={() => navigate({ turns: String(current.page + 1) })}
              >
                Next turns
              </button>
            </nav>
          )}
        </>
      )}
    </>
  );
}
