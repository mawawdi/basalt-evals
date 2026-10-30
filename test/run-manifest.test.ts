import assert from "node:assert/strict";
import test from "node:test";
import type { RunOperationManifest } from "../packages/contracts/src/execution.js";
import { unitModelId } from "../packages/operator/src/run-manifest.js";

test("each paid unit maps to the model of its frozen treatment or judgment batch", () => {
  const subject = (id: string, kind: string, model: string | null) => ({
    id,
    kind,
    evalId: "evaluation",
    builder: model === null ? null : { id, model: { id: model } },
  });
  const manifest = {
    subjects: [
      subject("generated", "generated", "openai/gpt-6-luna"),
      subject("repair", "repair", "z-ai/glm-5.3-flash"),
      subject("retained", "retained", null),
    ],
    judgmentBatches: [
      { id: "images-first", configuration: { modelId: "deepseek/deepseek-v4.1-flash" } },
    ],
  } as unknown as RunOperationManifest;
  assert.equal(
    unitModelId(manifest, { stage: "builder", unitId: "generated" }),
    "openai/gpt-6-luna",
  );
  assert.equal(unitModelId(manifest, { stage: "builder", unitId: "repair" }), "z-ai/glm-5.3-flash");
  assert.equal(
    unitModelId(manifest, { stage: "judgment", unitId: "images-first" }),
    "deepseek/deepseek-v4.1-flash",
  );
  for (const stage of ["final_capture", "grading", "seal", "report"] as const)
    assert.equal(unitModelId(manifest, { stage, unitId: "generated" }), null);
  // A retained source has no builder, so it is not a build of the run.
  assert.throws(
    () => unitModelId(manifest, { stage: "builder", unitId: "retained" }),
    /Build is absent/,
  );
  assert.throws(
    () => unitModelId(manifest, { stage: "judgment", unitId: "absent" }),
    /Judgment is absent/,
  );
});
