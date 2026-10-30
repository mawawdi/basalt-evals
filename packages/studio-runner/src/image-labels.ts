import type { BuildName } from "../../contracts/src/exemplars.js";

/**
 * The one place that writes the text label of a presented image. The transport sends each
 * label immediately before its image, so a model can refer to every image by its number.
 * Add a new fact here, and every judge and builder presentation receives it.
 */
export interface LabelledFrame {
  /** The neutral build name in a request about two builds. Absent in a request about one build. */
  build?: BuildName;
  frameId: string;
  /** The bound player, or null when the frame belongs to no player. */
  player: string | null;
  clock:
    | {
        kind: "scenario";
        /** Acquisition interval after the start of the scenario recording. */
        startMs: number;
        endMs: number;
      }
    | { kind: "presentation"; captureId: string }
    | { kind: "unstated" };
  /**
   * The roles from the fixed frame selection, for example `before:<transition>` or `uniform`.
   * Empty for an image that the selection did not choose, for example a phase capture.
   */
  roles: string[];
}

/**
 * A measured transition anchor on the recording clock. An action anchor is the action start.
 * A state anchor is the observed effect. A transition with no measured anchor has no entry.
 */
export interface LabelTransition {
  /** The build whose recording measured the anchor, in a request about two builds. */
  build?: BuildName;
  transitionId: string;
  anchor: "action" | "state";
  anchorMs: number;
}

const ROLE =
  /^(?:end|uniform|(?:before|effect|after-effect|after-hold|horizon-end):[a-z][a-z0-9-]{0,63})$/u;

export function imageLabelPrefix(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid image position");
  return `Image ${index + 1}:`;
}

function seconds(milliseconds: number): string {
  return `${(Math.abs(milliseconds) / 1000).toFixed(3)} s`;
}

function offset(startMs: number, transition: LabelTransition): string {
  const difference = startMs - transition.anchorMs;
  const anchor = transition.anchor === "state" ? "the observed effect" : "the action start";
  return `acquisition starts ${seconds(difference)} ${difference < 0 ? "before" : "after"} ${anchor} of transition ${transition.transitionId}`;
}

/**
 * Labels in request order. The image number is the position of the image in the request. A
 * scenario frame states its offset from each measured transition that its roles name. If its
 * roles name no measured transition, it states the offset from the nearest measured anchor.
 * In a request about two builds, each label names the build of its image.
 */
export function evidenceImageLabels(
  frames: LabelledFrame[],
  transitions: LabelTransition[] = [],
): string[] {
  if (
    transitions.some((transition) => !Number.isFinite(transition.anchorMs)) ||
    new Set(transitions.map((transition) => `${transition.build ?? ""}:${transition.transitionId}`))
      .size !== transitions.length
  )
    throw new Error("Invalid labelled transition anchor");
  return frames.map((frame, index) => {
    if (
      frame.roles.some((role) => !ROLE.test(role)) ||
      new Set(frame.roles).size !== frame.roles.length
    )
      throw new Error("Invalid labelled frame role");
    if (frame.build !== undefined && frame.build !== "A" && frame.build !== "B")
      throw new Error("Invalid labelled build name");
    const parts = [
      `${imageLabelPrefix(index)} ${frame.build ? `Build ${frame.build}, ` : ""}${frame.frameId}`,
    ];
    if (frame.player !== null) parts.push(`player ${frame.player}`);
    if (frame.roles.length) parts.push(`roles ${frame.roles.join(", ")}`);
    if (frame.clock.kind === "presentation")
      parts.push(
        `presentation capture ${frame.clock.captureId}, a separate session that is not on the scenario clock`,
      );
    if (frame.clock.kind === "scenario") {
      const { startMs, endMs } = frame.clock;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
        throw new Error("Invalid labelled frame interval");
      parts.push(
        `acquired from ${seconds(startMs)} to ${seconds(endMs)} after the scenario recording start`,
      );
      const named = new Set(frame.roles.map((role) => role.split(":")[1]));
      // A frame states only the anchors of its own build.
      const own = transitions.filter((transition) => transition.build === frame.build);
      const served = own.filter((transition) => named.has(transition.transitionId));
      // The nearest anchor by absolute offset; the first in authored order wins a tie.
      const nearest = own.reduce<LabelTransition | null>(
        (best, transition) =>
          best && Math.abs(startMs - best.anchorMs) <= Math.abs(startMs - transition.anchorMs)
            ? best
            : transition,
        null,
      );
      for (const transition of served.length ? served : nearest ? [nearest] : [])
        parts.push(offset(startMs, transition));
    }
    return parts.join("; ") + ".";
  });
}
