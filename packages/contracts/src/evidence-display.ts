import { DIAGNOSTIC_CHANNEL_LIMIT } from "./capabilities.js";
import type { ScriptDiagnostic } from "./index.js";

interface RecordingImage {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  /** The test player whose client recorded the image. Null for a separate snapshot. */
  actor: string | null;
}

/** The images of the recorded sequence, in time order. A separate snapshot is not one of them. */
function sequenceFrames(images: RecordingImage[], observations: unknown) {
  const sequence = (observations as { sequence?: { frames?: RecordingImage[] } } | null)?.sequence;
  const intervals = new Set(
    (sequence?.frames ?? []).map((frame) => `${frame.startedAt}:${frame.endedAt}`),
  );
  return images
    .flatMap((image, index) => {
      if (!intervals.has(`${image.startedAt}:${image.endedAt}`)) return [];
      const start = Date.parse(image.startedAt ?? ""),
        end = Date.parse(image.endedAt ?? "");
      return Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? [{ index, id: image.id, actor: image.actor, start, end }]
        : [];
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);
}

/** The test players that recorded the sequence, in name order. Derived display only. */
export function recordingTracks(images: RecordingImage[], observations: unknown) {
  return [...new Set(sequenceFrames(images, observations).map((frame) => frame.actor))].sort(
    (a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, "en", { numeric: true })),
  );
}

/**
 * The recorded frames of one test player. Each player records its own view, so playback follows
 * one track. Elapsed time counts from the first frame of any player, so one moment has one time
 * on every track. Derived display only: immutable evidence/review bindings are untouched.
 */
export function recordingTimeline(
  images: RecordingImage[],
  observations: unknown,
  actor: string | null,
) {
  const frames = sequenceFrames(images, observations);
  const origin = frames[0]?.start ?? 0;
  const track = frames.filter((frame) => frame.actor === actor);
  return track.map((frame, index) => ({
    ...frame,
    elapsedMs: frame.start - origin,
    gapMs: index ? Math.max(0, frame.start - track[index - 1]!.end) : 0,
  }));
}

/** One diagnostics channel, with identical entries counted together in first-seen order. */
export interface DiagnosticChannelSummary {
  channel: "messages" | "scriptErrors";
  kept: number;
  /** The channel reached its limit, so entries after the first ones were not kept. */
  full: boolean;
  groups: Array<{
    message: string;
    count: number;
    source: string | null;
    stackTrace: string | null;
  }>;
}

export interface RuntimeFactSummary {
  name: string;
  context: string;
  entries: Array<[string, string]>;
  diagnostics?: DiagnosticChannelSummary[];
  trace?: {
    columns: string[];
    samples: Array<Record<string, number>>;
    highlighted: number[];
    durationMs: number;
    maxGapMs: number;
  };
}

function describe(value: unknown): string {
  if (value === null) return "Unavailable";
  if (Array.isArray(value)) {
    if (value.length <= 4 && value.every((item) => typeof item === "number"))
      return JSON.stringify(value);
    const numbers = value.filter(
      (item): item is number => typeof item === "number" && Number.isFinite(item),
    );
    if (numbers.length === value.length && numbers.length)
      return `${value.length} recorded values · first ${numbers[0]} · last ${numbers.at(-1)} · min ${Math.min(...numbers)} · max ${Math.max(...numbers)}`;
    return `${value.length} recorded entries. Open Raw data to see all the entries.`;
  }
  if (typeof value === "object") return "Recorded structure. Open Raw data to see all the values.";
  return String(value);
}

/**
 * Group a diagnostics fact's channels by identical text and source. Channels may overlap, so
 * their counts are never added, and grouping says nothing about which code caused an error.
 */
function diagnosticChannels(row: Record<string, unknown>): DiagnosticChannelSummary[] | null {
  const { messages, scriptErrors } = row;
  if (!Array.isArray(messages) || !Array.isArray(scriptErrors)) return null;
  const channel = (
    name: DiagnosticChannelSummary["channel"],
    items: Array<{ message: string; source: string | null; stackTrace: string | null }>,
  ): DiagnosticChannelSummary => {
    const groups = new Map<string, DiagnosticChannelSummary["groups"][number]>();
    for (const item of items) {
      const key = JSON.stringify([item.message, item.source]);
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { ...item, count: 1 });
    }
    return {
      channel: name,
      kept: items.length,
      full: items.length >= DIAGNOSTIC_CHANNEL_LIMIT,
      groups: [...groups.values()],
    };
  };
  return [
    channel(
      "messages",
      messages.map((message) => ({ message: String(message), source: null, stackTrace: null })),
    ),
    channel(
      "scriptErrors",
      (scriptErrors as ScriptDiagnostic[]).map((error) => ({
        message: error.message,
        source:
          error.source.kind === "script"
            ? `${error.source.path} (${error.source.className})`
            : null,
        stackTrace: error.stackTrace || null,
      })),
    ),
  ];
}

/** Summarize measurements, never infer mechanic correctness or apply an invented threshold. */
export function runtimeFactSummaries(value: unknown): RuntimeFactSummary[] {
  const facts: RuntimeFactSummary[] = [];
  function visit(value: unknown, context: string) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context);
      return;
    }
    const row = value as Record<string, unknown>;
    // Scenario steps are containers, not facts. Keep each fact's actor/window visible.
    if (typeof row.stepId === "string" && Array.isArray(row.observations)) {
      for (const child of row.observations)
        visit(child, `${context} · ${row.stepId} · ${String(row.outcome ?? "unknown outcome")}`);
      return;
    }
    const name = [row.factId, row.stepId, row.action, row.kind].find(
      (item) => typeof item === "string",
    );
    const next =
      typeof row.id === "string"
        ? row.id
        : typeof row.scenarioId === "string"
          ? row.scenarioId
          : context;
    if (!name) {
      for (const child of Object.values(row)) visit(child, next);
      return;
    }
    const diagnostics = row.kind === "diagnostics" ? diagnosticChannels(row) : null;
    const entries: Array<[string, string]> = [];
    function summarize(row: Record<string, unknown>, prefix = "") {
      for (const [key, child] of Object.entries(row)) {
        if (["factId", "kind"].includes(key)) continue;
        const label = `${prefix}${key.replace(/Ms$/u, " (ms)").replace(/([A-Z])/g, " $1")}`;
        if (child && typeof child === "object" && !Array.isArray(child))
          summarize(child as Record<string, unknown>, label + " · ");
        else entries.push([label, describe(child)]);
      }
    }
    if (!diagnostics) summarize(row);
    let trace: RuntimeFactSummary["trace"];
    if (
      ["part_motion", "actor_part_motion"].includes(String(row.kind)) &&
      Array.isArray(row.samples)
    ) {
      const columns =
        row.kind === "actor_part_motion"
          ? ["elapsedMs", "x", "actorX", "actorY", "localX", "localY", "localZ"]
          : ["elapsedMs", "x", "y", "z"];
      const samples = row.samples as Array<Record<string, number>>;
      if (
        samples.length &&
        samples.every(
          (sample, index) =>
            columns.every((key) => Number.isFinite(sample[key])) &&
            (index === 0 || sample.elapsedMs! >= samples[index - 1]!.elapsedMs!),
        )
      ) {
        const highlighted = new Set([0, samples.length - 1]);
        let maxGapMs = 0;
        for (let index = 1; index < samples.length; index++)
          maxGapMs = Math.max(
            maxGapMs,
            samples[index]!.elapsedMs! - samples[index - 1]!.elapsedMs!,
          );
        for (const column of columns.slice(1)) {
          let largest = 0,
            at = 0;
          for (let index = 1; index < samples.length; index++) {
            const delta = Math.abs(samples[index]![column]! - samples[index - 1]![column]!);
            if (delta > largest) {
              largest = delta;
              at = index;
            }
          }
          if (at) {
            highlighted.add(at - 1);
            highlighted.add(at);
          }
        }
        trace = {
          columns,
          samples,
          highlighted: [...highlighted].sort((a, b) => a - b),
          durationMs: samples.at(-1)!.elapsedMs! - samples[0]!.elapsedMs!,
          maxGapMs,
        };
      }
    }
    facts.push({
      name: String(name),
      context: [context, row.actor].filter(Boolean).join(" · "),
      entries,
      ...(trace ? { trace } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    });
  }
  visit(value, "Recorded observation");
  return facts;
}

/** One step of a scenario as one context recorded it. Times are ms after the scenario start. */
export interface ScenarioStepSummary {
  id: string;
  outcome: "observed" | "not_observed_within_horizon" | "acquisition_failed";
  /** When the context started the step and started to look for its anchor. */
  dueMs: number;
  /** When the context saw the anchor. Null when it saw none. */
  anchorMs: number | null;
  /** The largest gap between two looks at a fact anchor, its precision. */
  pollIntervalMs: number | null;
  /** The fact already held at the first look, so the sighting is not a change. */
  anchorPreexisting: boolean;
  actedMs: number | null;
  capturedMs: number | null;
  action: { kind: string; succeeded: boolean } | null;
  /** The facts that the step recorded. */
  facts: number;
  /** How long the runner looked for the anchor, from the frozen plan. Null without the plan. */
  horizonMs: number | null;
  /** The time bound that a person set in the rubric, with its quote. */
  requirement: { withinMs: number; quote: string } | null;
}

/** The steps of each scenario and context of one observation, in recorded order. */
export function scenarioSteps(
  observations: unknown,
  plan: Array<{
    id: string;
    label: string;
    steps: Array<{
      id: string;
      horizonMs: number;
      requirement: { withinMs: number; quote: string } | null;
    }>;
  }> = [],
): Array<{
  scenarioId: string;
  label: string | null;
  context: string;
  steps: ScenarioStepSummary[];
}> {
  const scenarios = (observations as { scenarios?: unknown } | null)?.scenarios;
  if (!Array.isArray(scenarios)) return [];
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const outcomes = ["observed", "not_observed_within_horizon", "acquisition_failed"];
  return scenarios.flatMap((scenario: Record<string, unknown>) => {
    const planned = plan.find((item) => item.id === scenario.scenarioId);
    return (Array.isArray(scenario.reports) ? scenario.reports : []).flatMap(
      (report: Record<string, unknown>) => {
        const start = number(report.startAt);
        if (start === null || typeof report.context !== "string" || !Array.isArray(report.steps))
          return [];
        // Studio reports times in seconds on its server clock.
        const after = (value: unknown) => {
          const seconds = number(value);
          return seconds === null ? null : Math.round((seconds - start) * 1000);
        };
        return [
          {
            scenarioId: String(scenario.scenarioId),
            label: planned?.label ?? null,
            context: report.context,
            steps: report.steps.flatMap((step: Record<string, unknown>) => {
              const dueMs = after(step.dueAt);
              if (
                typeof step.stepId !== "string" ||
                !outcomes.includes(String(step.outcome)) ||
                dueMs === null
              )
                return [];
              const action = step.action as { kind?: unknown; succeeded?: unknown } | undefined;
              const plannedStep = planned?.steps.find((item) => item.id === step.stepId);
              return [
                {
                  id: step.stepId,
                  outcome: step.outcome as ScenarioStepSummary["outcome"],
                  dueMs,
                  anchorMs: after(step.anchorObservedAt),
                  pollIntervalMs: number(step.pollIntervalMs),
                  anchorPreexisting: step.anchorPreexisting === true,
                  actedMs: after(step.actedAt),
                  capturedMs: after(step.capturedAt),
                  action:
                    typeof action?.kind === "string" && typeof action.succeeded === "boolean"
                      ? { kind: action.kind, succeeded: action.succeeded }
                      : null,
                  facts: Array.isArray(step.observations) ? step.observations.length : 0,
                  horizonMs: plannedStep?.horizonMs ?? null,
                  requirement: plannedStep?.requirement ?? null,
                },
              ];
            }),
          },
        ];
      },
    );
  });
}

/**
 * The words for each frame role of a judge selection. A role names its event after the colon. The
 * event keeps its plan id, as the time in the caption does, because a transition has no label.
 */
const frameRoles = new Map<string, (event: string) => string>([
  ["before", (event) => `last frame before the ${event} event`],
  ["effect", (event) => `during the ${event} event`],
  ["after-effect", (event) => `first frame after the ${event} event`],
  ["after-hold", (event) => `after the ${event} event and its hold`],
  ["horizon-end", (event) => `last frame, the ${event} event never seen`],
  ["end", () => "last frame of this player"],
  ["uniform", () => "extra frame spread over the recording"],
]);

/**
 * Why the judge saw a recorded frame, as one caption line. Null for a frame that the judge did
 * not see. An unknown role adds no words, so the line never shows a code name.
 */
export function judgedFrameText(roles: readonly string[]): string | null {
  if (!roles.length) return null;
  const words = [
    ...new Set(
      roles.flatMap((role) => {
        const [kind = "", event = ""] = role.split(":");
        const text = frameRoles.get(kind);
        return text ? [text(event)] : [];
      }),
    ),
  ];
  return words.length
    ? `The judge saw this frame: ${words.join("; ")}.`
    : "The judge saw this frame.";
}
