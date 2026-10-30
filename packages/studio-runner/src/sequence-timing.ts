import type { ClockAlignment } from "./sequence.js";
import type { SequenceAcquisition, SequenceClockProbe } from "./studio-mcp.js";

interface SequenceTimingSummary {
  count: number;
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
}

interface SequenceTimingAudit {
  schema: "basalt-evals/sequence-timing-audit";
  status: SequenceAcquisition["status"];
  /** The alignment that the sequence assessment uses: the shortest probe of all clients. */
  clock: ClockAlignment | null;
  actors: Array<{
    playerUserId: number;
    frameCount: number;
    /** The time from each screenshot request to its response. */
    requestWidths: SequenceTimingSummary;
    /** Each interval that no screenshot request of this actor covers. */
    uncoveredGaps: SequenceTimingSummary;
    /** The alignment from the probes of this client only. */
    clock: ClockAlignment | null;
    /** Host time minus the local clock of the client process, from the same probe. */
    localClockOffsetMs: number | null;
    /**
     * The largest distance from the offset of this client to the interval of one of its
     * probes. A value above zero shows a clock step or drift during the recording.
     */
    residualMaxMs: number | null;
    probes: Array<{
      hostSentAt: string;
      roundTripMs: number;
      offsetMs: number;
      residualMs: number;
    }>;
  }>;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The interval of offsets (host minus Studio, in ms) that one probe permits. */
function probeBounds(probe: SequenceClockProbe): [number, number] {
  const sent = Date.parse(probe.hostSentAt);
  const received = Date.parse(probe.hostReceivedAt);
  if (
    !Number.isFinite(sent) ||
    !Number.isFinite(received) ||
    received < sent ||
    !Number.isFinite(probe.serverTime) ||
    !Number.isFinite(probe.clientTime)
  )
    throw new Error("Invalid Studio clock probe");
  const studio = probe.serverTime * 1000;
  return [sent - studio, received - studio];
}

function distance(value: number, [low, high]: [number, number]): number {
  return value < low ? low - value : value > high ? value - high : 0;
}

function shortest(probes: SequenceClockProbe[]): SequenceClockProbe | null {
  let best: SequenceClockProbe | null = null;
  let width = Infinity;
  for (const probe of probes) {
    const [low, high] = probeBounds(probe);
    if (high - low < width) [best, width] = [probe, high - low];
  }
  return best;
}

/**
 * Align the Studio clock with the host clock of the frames. Each client reads the replicated
 * server clock (workspace:GetServerTimeNow), so one alignment also serves server events. The
 * probe with the shortest round trip sets offsetMs at the center of its interval, and half of
 * its round trip is uncertaintyMs. Without a probe there is no alignment.
 */
export function probeClock(probes: SequenceClockProbe[]): ClockAlignment | null {
  const best = shortest(probes);
  if (!best) return null;
  const [low, high] = probeBounds(best);
  return { offsetMs: round((low + high) / 2), uncertaintyMs: round((high - low) / 2) };
}

function summary(values: number[]): SequenceTimingSummary {
  if (values.length === 0) return { count: 0, minMs: null, medianMs: null, maxMs: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    count: sorted.length,
    minMs: round(sorted[0]!),
    medianMs: round(median),
    maxMs: round(sorted.at(-1)!),
  };
}

/**
 * Measure the timing of one stored sequence acquisition. The audit only reads the
 * record. It does not decide sufficiency.
 */
export function auditSequenceTiming(acquisition: SequenceAcquisition): SequenceTimingAudit {
  if (acquisition.schema !== "basalt-evals/sequence-acquisition")
    throw new Error("The file is not a sequence acquisition");
  const players = [
    ...new Set([
      ...acquisition.frames.map((frame) => frame.playerUserId),
      ...acquisition.clockProbes.map((probe) => probe.playerUserId),
    ]),
  ].sort((left, right) => left - right);
  return {
    schema: "basalt-evals/sequence-timing-audit",
    status: acquisition.status,
    clock: probeClock(acquisition.clockProbes),
    actors: players.map((playerUserId) => {
      const intervals = acquisition.frames
        .filter((frame) => frame.playerUserId === playerUserId)
        .map((frame) => [Date.parse(frame.startedAt), Date.parse(frame.endedAt)] as const)
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
        .sort((left, right) => left[0] - right[0]);
      const gaps: number[] = [];
      let coveredUntil: number | null = null;
      for (const [start, end] of intervals) {
        if (coveredUntil !== null && start > coveredUntil) gaps.push(start - coveredUntil);
        coveredUntil = Math.max(coveredUntil ?? end, end);
      }
      const probes = acquisition.clockProbes.filter((probe) => probe.playerUserId === playerUserId);
      const clock = probeClock(probes);
      const best = shortest(probes);
      const rows = probes.map((probe) => {
        const bounds = probeBounds(probe);
        return {
          hostSentAt: probe.hostSentAt,
          roundTripMs: round(bounds[1] - bounds[0]),
          offsetMs: round((bounds[0] + bounds[1]) / 2),
          residualMs: round(clock ? distance(clock.offsetMs, bounds) : 0),
        };
      });
      return {
        playerUserId,
        frameCount: intervals.length,
        requestWidths: summary(intervals.map(([start, end]) => end - start)),
        uncoveredGaps: summary(gaps),
        clock,
        localClockOffsetMs: best
          ? round(
              (Date.parse(best.hostSentAt) + Date.parse(best.hostReceivedAt)) / 2 -
                best.clientTime * 1000,
            )
          : null,
        residualMaxMs: rows.length ? Math.max(...rows.map((row) => row.residualMs)) : null,
        probes: rows,
      };
    }),
  };
}
