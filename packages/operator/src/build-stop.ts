import type { AgentRun } from "../../contracts/src/index.js";
import { hashJson } from "../../contracts/src/index.js";
import type { RunOperationEvent } from "../../contracts/src/execution.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";

/** The longest recorded reason that a sentence quotes. */
const MAX_QUOTED = 200;

function quoted(text: string) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > MAX_QUOTED ? `${line.slice(0, MAX_QUOTED - 1)}…` : line;
}

const localChecks: Record<string, string> = {
  project_json: "project file",
  luau_parse: "Luau syntax",
  rojo_build: "Rojo build",
};

/**
 * Why a build stopped, in the words of the console. It reads only the stop reason, the recorded
 * failure detail and the counts and check names of the trace. It never reads a request, the
 * text of the model or the arguments of a tool call. A build that passed has no text.
 */
export function buildStopText(run: AgentRun): string | null {
  if (run.status === "locally_eligible") return null;
  const detail = run.failure?.detail ? quoted(run.failure.detail) : null;
  const refused = run.trace
    .filter((event) => event.kind === "tool_rejection")
    .reduce((count, event) => count + Number(event.data.proposed ?? 1), 0);
  const last = (kind: AgentRun["trace"][number]["kind"]) =>
    [...run.trace].reverse().find((event) => event.kind === kind);
  const lastAnswer = last("model_response");
  const gate = last("gate");
  switch (run.stopReason) {
    case "invalid_tool_call":
      if (run.failure?.classification === "model_tool_use_failure" && refused > 0)
        return `The model sent ${refused === 1 ? "a tool call" : `${refused} tool calls`} that Basalt refused, so the build stopped.${detail ? ` Last refusal: ${detail}` : ""}`;
      return `Basalt couldn’t use the model’s last answer, so the build stopped.${detail ? ` Recorded reason: ${detail}` : ""}`;
    case "output_limit":
      return lastAnswer?.data.toolCalls === 0
        ? "The model used its full output limit and called no tool, so the build stopped."
        : "The model used its full output limit before it finished, so the build stopped.";
    case "turn_limit":
      return "The model used all of its turns before it finished the build.";
    case "context_limit":
      return "The conversation grew longer than the model can read, so the build stopped.";
    case "spending_limit":
      return "The build reached the spending limit of the run.";
    case "provider_error":
      return `The model provider returned an error, so the build stopped.${detail ? ` Recorded error: ${detail}` : ""}`;
    case "refusal":
      return "The model refused the task, so the build stopped.";
    case "cancelled":
      return "Basalt stopped the build before it finished.";
    case "finished": {
      const failed = Array.isArray(gate?.data.checks)
        ? gate.data.checks.flatMap((check) =>
            check && typeof check === "object" && !Array.isArray(check) && check.outcome === "fail"
              ? [localChecks[String(check.name)] ?? String(check.name).replaceAll("_", " ")]
              : [],
          )
        : [];
      if (failed.length) return `The build didn’t pass the local checks: ${failed.join(", ")}.`;
      return detail ? `The build didn’t finish. Recorded reason: ${detail}` : null;
    }
  }
}

// A saved build never changes, so the text of each event stays the same. The process keeps the
// texts of the events that it showed last.
const kept = new Map<string, string | null>();
const keptEvents = 200;

/**
 * Why the build of a builder event stopped, from the saved run of that build. The saved run must
 * be the one that the event recorded. Any other event, or a run that Basalt did not save, has no
 * text.
 */
export async function savedBuildStop(
  root: string,
  operationId: string,
  event: RunOperationEvent,
): Promise<string | null> {
  if (event.stage !== "builder" || !["failed", "incomplete"].includes(event.kind)) return null;
  if (!event.unitId || !event.artifactHashes.length) return null;
  if (kept.has(event.id)) return kept.get(event.id)!;
  const run = await new RepositoryFiles(root).optional<AgentRun>(
    `.basalt-evals/eval-operations/${operationId}/builder/${event.unitId}/agent-run.json`,
  );
  const text = run && event.artifactHashes.includes(hashJson(run)) ? buildStopText(run) : null;
  if (kept.size >= keptEvents) kept.delete(kept.keys().next().value!);
  kept.set(event.id, text);
  return text;
}

/**
 * Why the most recent build that did not finish stopped. Progress shows it beside the recent
 * failure of the run, when that failure is the same build event.
 */
export async function recentBuildStop(root: string, operationId: string, at: string) {
  const journal = await OperationJournal.open(root);
  let event: RunOperationEvent | undefined;
  try {
    event = journal.page<RunOperationEvent>(`activity:${operationId}`, {
      statuses: ["incomplete"],
      q: "builder",
      limit: 1,
    }).items[0];
  } finally {
    journal.close();
  }
  return event?.stage === "builder" && event.at === at
    ? savedBuildStop(root, operationId, event)
    : null;
}
