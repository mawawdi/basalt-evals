import { assertExactRecordKeys, fail, isRecord } from "./validation.js";

const SCENE_TEXT_ENTRY_LIMIT = 256;
const SCENE_TEXT_LENGTH_LIMIT = 1000;
const SCENE_TEXT_PATH_LIMIT = 2048;
const TEXT_CLASSES = new Set(["TextLabel", "TextButton", "TextBox"]);
const LAYERS = new Set(["ScreenGui", "BillboardGui", "SurfaceGui"]);

/**
 * One string that a text object under a GUI layer shows. The connector reads only Text,
 * and PlaceholderText of a TextBox. `visible` is the declared hierarchy visibility, not a
 * claim about occlusion, transparency or legibility.
 *
 * `owner` is "evaluator" only under the reserved BasaltEvalCaptureControls ScreenGui of
 * the local PlayerGui, and only when the frozen plan drives a literal input target in it.
 * No other runtime boundary separates seed scripts from candidate scripts.
 */
interface SceneTextEntry {
  path: string;
  className: "TextLabel" | "TextButton" | "TextBox";
  layer: "ScreenGui" | "BillboardGui" | "SurfaceGui";
  owner: "candidate" | "evaluator";
  property: "Text" | "PlaceholderText";
  text: string;
  visible: boolean;
}

/**
 * The fixed inventory at one capture, from the Workspace and the local PlayerGui.
 * `complete` is false when the connector left out an entry at the entry or path limit.
 */
export interface SceneTextObservation {
  complete: boolean;
  entries: SceneTextEntry[];
}

export function assertSceneTextObservation(value: unknown): asserts value is SceneTextObservation {
  if (!isRecord(value) || typeof value.complete !== "boolean" || !Array.isArray(value.entries))
    fail("scene text observation");
  assertExactRecordKeys(value, ["complete", "entries"], "scene text observation fields");
  if (value.entries.length > SCENE_TEXT_ENTRY_LIMIT) fail("scene text entry count");
  for (const entry of value.entries) {
    if (!isRecord(entry)) fail("scene text entry");
    assertExactRecordKeys(
      entry,
      ["path", "className", "layer", "owner", "property", "text", "visible"],
      "scene text entry fields",
    );
    if (
      typeof entry.path !== "string" ||
      !entry.path.length ||
      entry.path.length > SCENE_TEXT_PATH_LIMIT ||
      !TEXT_CLASSES.has(String(entry.className)) ||
      !LAYERS.has(String(entry.layer)) ||
      (entry.owner !== "candidate" &&
        !(entry.owner === "evaluator" && entry.layer === "ScreenGui")) ||
      (entry.property !== "Text" &&
        !(entry.property === "PlaceholderText" && entry.className === "TextBox")) ||
      typeof entry.text !== "string" ||
      !entry.text.length ||
      entry.text.length > SCENE_TEXT_LENGTH_LIMIT ||
      typeof entry.visible !== "boolean"
    )
      fail("scene text entry");
  }
}

/**
 * A routing flag for optional human review, never a verdict. Visible candidate text can
 * instruct a judge, so a capture with visible candidate text or an incomplete inventory is
 * routed. Declared evaluator capture UI does not set the route.
 */
export function sceneTextNeedsReview(observations: readonly SceneTextObservation[]): boolean {
  return observations.some(
    (observation) =>
      !observation.complete ||
      observation.entries.some((entry) => entry.visible && entry.owner === "candidate"),
  );
}
