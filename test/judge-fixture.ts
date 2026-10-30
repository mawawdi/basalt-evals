import { generateKeyPairSync } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type { JudgeSettings } from "../packages/contracts/src/judge-settings.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { quoteRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import type { Decision, ProtocolEvidence } from "../packages/experiments/src/controller.js";
import {
  planDetectorCalibration,
  type ExperimentPlan,
  type JudgmentUnit,
  type StudySource,
} from "../packages/experiments/src/protocols.js";
import { registerSource } from "../packages/operator/src/sources.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

/**
 * One registered evaluation and its saved builds, one by default. The evaluation has the judge
 * criterion of the shared fixture with images. Each extra statement adds a judge criterion that
 * reads only the sealed source, so it has no images. With `sourcesFirst`, the plan puts the
 * extra criteria before the image criterion, so the plan order differs from the authored order.
 */
export async function savedBuild(
  root: string,
  sourceCriteria: string[] = [],
  { sourcesFirst = false, builds = 1 } = {},
) {
  await writeRunConfiguration(root);
  await implementationFixture(root);
  await seedModelRegistry(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await mkdir(resolve(root, ".basalt-evals/native-worker"), { recursive: true });
  await writeFile(
    resolve(root, ".basalt-evals/synthetic-private-key.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await writeFile(
    resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const draft = createEvalDraft({
    ...fixtureInput,
    stages: [
      {
        ...fixtureInput.stages[0]!,
        rubric: [fixtureInput.stages[0]!.rubric, ...sourceCriteria.map((text) => `- ${text}`)].join(
          "\n",
        ),
      },
    ],
  });
  const ids = draft.stages[0]!.criteria.map((_, index) =>
    index === 0 ? "beacon-exists" : index === 1 ? "beacon-blue" : `source-${index - 1}`,
  );
  const { publicScene, ...publicProposal } = fixturePublic;
  const compiled = compileEvalProposal(draft, 1, {
    ...publicProposal,
    ...fixturePrivate,
    privateEvaluator: {
      ...fixturePrivate.privateEvaluator,
      unscaled: [
        ...(sourcesFirst ? [] : fixturePrivate.privateEvaluator.unscaled),
        ...draft.stages[0]!.criteria.slice(2).map((criterion, index) => ({
          id: ids[index + 2]!,
          statement: criterion.text,
          required: true,
          evidenceClass: null,
          polarity: "presence" as const,
          evidence: {
            sequence: false,
            actions: [],
            sourceSelection: { kind: "all_luau_in_roots" as const, roots: ["src"] },
            facts: [],
            captureIds: [],
          },
        })),
        ...(sourcesFirst ? fixturePrivate.privateEvaluator.unscaled : []),
      ],
    },
    criterionMappings: draft.stages[0]!.criteria.map((criterion, index) => ({
      authoredCriterionId: criterion.id,
      authoredClauseIds: criterion.clauses.map((clause) => clause.id),
      authority: { source: "human_rubric" as const, start: criterion.start, end: criterion.end },
      method: index === 0 ? ("deterministic" as const) : ("unscaled" as const),
      executableCriterionId: ids[index]!,
      rationale: "Synthetic integration fixture with explicitly bound evidence.",
    })),
    seed: neutralRojoSeed(draft.title, publicScene),
  });
  if (!compiled.revision) throw new Error(JSON.stringify(compiled.validation));
  const revision = compiled.revision;
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(draft);
  await store.writeRevision(revision);
  await registerReadyEvaluation(root, revision.id);
  const [record] = await readdir(resolve(root, `.basalt-evals/eval-validations/${revision.id}`));
  const workspace = resolve(root, ".basalt-evals/saved-build");
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  await writeFile(
    resolve(workspace, "default.project.json"),
    JSON.stringify(revision.seed.project),
  );
  for (const source of revision.seed.sources)
    await writeFile(resolve(workspace, source.path), source.text);
  const sourceIds: string[] = [];
  for (let build = 1; build <= builds; build++) {
    await writeFile(
      resolve(workspace, "src/server/Beacon.server.luau"),
      build === 1 ? "-- Beacon\n" : `-- Beacon ${build}\n`,
    );
    const files = await inventoryTree(workspace);
    const source = await registerSource({
      root,
      workspace,
      candidate: { projectFile: "default.project.json", files, rootHash: hashJson(files) },
      provenance: {
        kind: "retained",
        evidenceHashes: ["b".repeat(64)],
        originOperationId: null,
        parentSourceId: null,
      },
    });
    sourceIds.push(source.id);
  }
  const adapters = fixtureAdapters(root);
  const quote = (judgeSettings: JudgeSettings) =>
    quoteRegisteredEvalRun({
      root,
      adapters,
      selection: {
        captureScope: "final",
        publicFeedbackId: null,
        sourceIds,
        parentSourceId: null,
        gradingMode: "all",
        continuingOperationId: null,
        revisionId: revision.id,
        validationRecordHash: record!.replace(/\.json$/u, ""),
        builderModelIds: [],
        gradingModelId: "xiaomi/mimo-v2.6-flash",
        judgeSettings,
        harnessIds: [],
        repetitions: 0,
        nativeCaptureRepetitions: 1,
      },
    });
  return { adapters, quote, revision };
}

/**
 * A judge calibration of two tasks with one required criterion. With `samples` above 1, each
 * request of the original evidence has that many identical samples. The plan is sealed again.
 */
export function calibrationPlan(samples = 1): ExperimentPlan {
  const sources: StudySource[] = ["gate", "shutter"].flatMap((evalId) =>
    (["generated", "generated", "generated", "working", "negative", "negative"] as const).map(
      (kind, index) => ({
        id: `${evalId}-${index}`,
        evalId,
        kind,
        sourceHash: hashJson([evalId, index]),
        targetCriterionIds: kind === "negative" ? ["required"] : [],
      }),
    ),
  );
  const plan = planDetectorCalibration({
    sources,
    views: [
      { id: "standard", partition: "development" },
      { id: "distant", partition: "development" },
      { id: "side", partition: "withheld" },
      { id: "compact", partition: "withheld" },
    ],
    baselines: {
      measurement: { changeThreshold: 16, onsetPixels: 1, regions: [], excluded: [], timing: [] },
      reference: null,
      rules: [],
      judgeControls: [],
      secondJudgeFamily: null,
    },
    exemplarComparison: null,
  });
  if (samples === 1) return plan;
  const { id: _id, ...body } = plan;
  const judgments: JudgmentUnit[] = plan.judgments.flatMap((unit) =>
    unit.substitution
      ? [unit]
      : Array.from({ length: samples }, (_, index) => ({
          ...unit,
          sample: index + 1,
          id:
            index === 0
              ? unit.id
              : `judgment-${hashJson([unit.sampleGroupId, index + 1]).slice(0, 24)}`,
        })),
  );
  const sampled = { ...body, judgments };
  return { ...sampled, id: hashJson(sampled) };
}

/** Complete evidence where experts and the judge accept each build, unless `decide` says else. */
export function calibrationEvidence(
  plan: ExperimentPlan,
  decide: (unit: JudgmentUnit) => Decision = () => "satisfied",
  integrityIssue: (unit: JudgmentUnit) => boolean = () => false,
): ProtocolEvidence {
  return {
    requiredCriteria: { gate: ["required"], shutter: ["required"] },
    requiredPresentationCriteria: { gate: [], shutter: [] },
    completedGates: ["development-review", "presentation-selection"],
    builders: [],
    captures: plan.captures.map((capture) => ({
      id: capture.id,
      state: "completed",
      proofHash: hashJson(["capture", capture.id]),
    })),
    reviews: plan.captures.map((capture) => ({
      captureId: capture.id,
      proofHash: hashJson(["expert", capture.id]),
      decisions: { required: "satisfied" },
      blindingIssue: null,
    })),
    judgments: plan.judgments.map((unit) => ({
      id: unit.id,
      state: "completed",
      proofHash: hashJson(["judgment", unit.id]),
      decisions: { required: unit.substitution ? "insufficient" : decide(unit) },
      integrityIssue: integrityIssue(unit),
      costUsd: 0.1,
    })),
  };
}
