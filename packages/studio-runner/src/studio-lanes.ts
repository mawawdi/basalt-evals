// This module has no imports. The isolated worker loads it, and the worker must not load the
// operation journal, because the journal needs node:sqlite.

/** The connector port of lane 0. Lane n uses the port that follows it by n. */
const STUDIO_LANE_FIRST_PORT = 43123;
/** All Studio workers together run at most this number of Studio jobs at the same time. */
export const MAX_STUDIO_LANES = 4;

/** One Studio lane and the worker that owns it. Lane numbers are global across workers. */
export interface StudioSlot {
  lane: number;
  worker: string;
}

/** The loopback connector URL of one lane. The prepared place holds it. */
export function studioLaneConnectorUrl(lane: number): string {
  if (!Number.isSafeInteger(lane) || lane < 0 || lane >= MAX_STUDIO_LANES)
    throw new Error("Studio lane is outside the supported lanes");
  return `http://127.0.0.1:${STUDIO_LANE_FIRST_PORT + lane}`;
}

/** The lane of a prepared session. Its connector port selects the lane. */
export function studioLaneOfConnectorUrl(connectorUrl: string): number {
  for (let lane = 0; lane < MAX_STUDIO_LANES; lane++)
    if (studioLaneConnectorUrl(lane) === connectorUrl) return lane;
  throw new Error("The Studio session does not use the connector port of a Studio lane");
}
