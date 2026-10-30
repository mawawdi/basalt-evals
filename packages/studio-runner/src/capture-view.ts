import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { contentHash, type StudioCollectionPlan } from "../../contracts/src/index.js";
import type { SignedWorkerManifest } from "./native-worker.js";

/** Consume only after worker signature verification. Never pass raw traces to a grader. */
export async function actorCaptureViews(
  files: RepositoryFiles,
  studioBase: string,
  plan: StudioCollectionPlan,
  captureIds: string[],
) {
  const selected = plan.phases.flatMap((phase) => {
    const driver = phase.driver;
    return driver.kind === "observe_from_actor"
      ? phase.captures
          .filter((capture) => captureIds.includes(capture.id))
          .map((capture) => ({
            phaseId: phase.id,
            captureId: capture.id,
            targetPath: driver.targetPath,
          }))
      : [];
  });
  if (!selected.length) return [];
  const { manifest } = await files.json<SignedWorkerManifest>(`${studioBase}/native/manifest.json`);
  const traces = manifest.artifacts.filter((artifact) =>
    /^traces\/trace-[^/]+\.jsonl$/u.test(artifact.file),
  );
  if (traces.length !== 1) throw new Error("Actor view requires one signed acquisition trace");
  const artifact = traces[0]!;
  const bytes = await files.bytes(`${studioBase}/${artifact.file}`, 8 * 1024 * 1024);
  if (bytes.length !== artifact.bytes || contentHash(bytes) !== artifact.hash)
    throw new Error("Actor view trace differs from signed evidence");
  const events = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          source: string;
          stage: string;
          sequence: number;
          trialId: string;
          client?: { id: string };
          data: Record<string, unknown>;
        },
    );
  return selected.map((capture) => {
    const relevant = events.filter(
      (event) =>
        event.source === "plugin" &&
        event.data.phaseId === capture.phaseId &&
        event.data.captureId === capture.captureId,
    );
    const views = relevant.filter((event) => event.stage === "capture.actor_view");
    if (views.length !== 1) throw new Error("Actor view provenance is missing or ambiguous");
    const view = views[0]!;
    if (!view.trialId || !view.client?.id)
      throw new Error("Actor view has no bound acquisition identity");
    const sameAttempt = relevant.filter(
      (event) => event.trialId === view.trialId && event.client?.id === view.client!.id,
    );
    const targets = sameAttempt.filter(
      (event) => event.stage === "capture.actor_target" && event.sequence > view.sequence,
    );
    const locked = sameAttempt.filter(
      (event) =>
        event.stage === "capture.camera_restored" &&
        event.sequence > view.sequence &&
        event.data.stable === true,
    );
    const restored = sameAttempt.filter(
      (event) =>
        event.stage === "capture.actor_view_restored" &&
        event.sequence > view.sequence &&
        event.data.completed === true,
    );
    if (
      targets.length !== 1 ||
      locked.length !== 1 ||
      restored.length !== 1 ||
      targets[0]!.sequence >= locked[0]!.sequence ||
      restored[0]!.sequence <= locked[0]!.sequence
    )
      throw new Error("Actor view lacks a completed stable acquisition");
    const geometry = Object.fromEntries(
      [
        "originX",
        "originY",
        "originZ",
        "actorX",
        "actorY",
        "actorZ",
        "lookX",
        "lookY",
        "lookZ",
        "fieldOfView",
      ].map((key) => {
        const value = view.data[key];
        if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000)
          throw new Error("Actor view geometry is incomplete");
        return [key, value];
      }),
    );
    const targetData = targets[0]!.data;
    if (typeof targetData.targetPresent !== "boolean" || typeof targetData.aimed !== "boolean")
      throw new Error("Actor view target availability is incomplete");
    if (targetData.aimed && !targetData.targetPresent)
      throw new Error("Actor view cannot aim at an absent target");
    const target = targetData.aimed
      ? ["targetX", "targetY", "targetZ"].map((key) => {
          const value = targetData[key];
          if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000)
            throw new Error("Actor view target geometry is incomplete");
          return value;
        })
      : null;
    return {
      ...capture,
      mode: "actor_head_aim" as const,
      geometry,
      targetPresent: targetData.targetPresent,
      aimed: targetData.aimed,
      target,
      traceHash: artifact.hash,
      limitation:
        "One frozen viewpoint during capture; aiming alone does not establish visibility. Assess the original pixels and observed geometry.",
    };
  });
}
