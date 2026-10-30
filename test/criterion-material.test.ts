import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  publicTaskInstructions,
  stableJson,
  type StudioEvidence,
  type StudioCollectionPlan,
  type UnscaledCriterion,
  type PublicTask,
} from "../packages/contracts/src/index.js";
import {
  criterionMaterial,
  criterionMaterialTextBound,
} from "../packages/eval-authoring/src/criterion-material.js";

test("unresolved optional public identity cannot become an object-absence verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-role-identity-"));
  try {
    const role = {
      id: "beacon",
      className: "BasePart",
      scope: "workspace",
      cardinality: "zero_or_one",
    };
    const plan = {
      roles: [role],
      scenarios: [],
      phases: [
        {
          id: "view",
          facts: [{ id: "identity", kind: "instance", path: "role.beacon" }],
          captures: [],
        },
      ],
    } as unknown as StudioCollectionPlan;
    const observation = { factId: "identity", kind: "instance", exists: false, className: "" };
    const evidence = {
      phases: [{ phaseId: "view", observations: [observation], captures: [] }],
      scenarios: [],
    } as unknown as StudioEvidence;
    const criterion: UnscaledCriterion = {
      id: "appearance",
      statement: "The requested object is visible.",
      required: true,
      evidenceClass: null,
      polarity: "presence",
      evidence: {
        sourceSelection: null,
        facts: [{ phaseId: "view", factId: "identity" }],
        actions: [],
        captureIds: [],
        sequence: false,
      },
    };
    const input = {
      files: new RepositoryFiles(root),
      sourceRoot: "unused",
      sourceFiles: [],
      plan,
      evidence,
      criterion,
    };
    const missing = await criterionMaterial(input);
    assert.equal(missing.unavailable.length, 1);
    assert.match(missing.unavailable[0]!, /tag|identity/i);
    assert.deepEqual(
      missing.signedObservations[0]!.observation,
      observation,
      "Raw signed facts must not be rewritten",
    );
    const present = structuredClone(evidence);
    Object.assign(present.phases[0]!.observations[0]!, { exists: true, className: "Part" });
    assert.deepEqual((await criterionMaterial({ ...input, evidence: present })).unavailable, []);
    const literal = structuredClone(plan);
    const fact = literal.phases[0]!.facts[0]!;
    if ("path" in fact) fact.path = "game.Workspace.PublicSeed";
    assert.deepEqual(
      (await criterionMaterial({ ...input, plan: literal })).unavailable,
      [],
      "Literal scene absence remains observable",
    );
    // A pickup removes the tagged coin. The capture found the role before, so the later
    // absence is evidence and not an unknown identity.
    const removed = structuredClone(plan);
    removed.phases.unshift({
      id: "before",
      facts: [{ id: "identity-before", kind: "instance", path: "role.beacon" }],
      captures: [],
    } as unknown as StudioCollectionPlan["phases"][number]);
    const removedEvidence = structuredClone(evidence);
    removedEvidence.phases.unshift({
      phaseId: "before",
      observations: [
        { factId: "identity-before", kind: "instance", exists: true, className: "Part" },
      ],
      captures: [],
    } as unknown as StudioEvidence["phases"][number]);
    assert.deepEqual(
      (await criterionMaterial({ ...input, plan: removed, evidence: removedEvidence })).unavailable,
      [],
      "A removal after an identified target is observable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared public role instructions describe tagging without disclosing evaluator material", () => {
  const task = {
    title: "Public example",
    prompt: "Create the requested object.",
    acceptance: [],
    evidenceInstructions: [],
    roles: [
      {
        id: "object",
        className: "BasePart",
        scope: "workspace",
        cardinality: "zero_or_one",
      },
    ],
  } as unknown as PublicTask;
  const instructions = publicTaskInstructions(task);
  // The role id is the tag, so the example and the role line use the same one name.
  assert.match(instructions, /AddTag\(instance, "object"\)/);
  assert.match(
    instructions,
    /^- Tag object: class BasePart, scope workspace, cardinality zero or one\.$/m,
  );
  assert.match(instructions, /name/i);
  assert.doesNotMatch(instructions, /minimumPassingScore|privateEvaluator|criterionMappings/);
});

test("criterion material preserves exact facts, observed binding absence, sealed source and unavailable acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-criterion-material-"));
  try {
    await mkdir(join(root, "source/src"), { recursive: true });
    const text = "local actualName = 'Beacon'\n";
    await writeFile(join(root, "source/src/main.luau"), text);
    const evidence = {
      phases: [
        {
          phaseId: "scene",
          captures: [],
          observations: [
            { kind: "instance_name", factId: "name", exists: true, name: "Beacon" },
            {
              kind: "binding_failure",
              factId: "baseline",
              requestedKind: "instance",
              path: "role.beacon",
              reason: "missing",
            },
          ],
        },
      ],
      scenarios: [],
    } as unknown as StudioEvidence;
    const criterion: UnscaledCriterion = {
      id: "named-beacon",
      statement: "The blue Beacon is visible.",
      required: true,
      evidenceClass: "appearance",
      polarity: "presence",
      evidence: {
        sequence: false,
        actions: [],
        sourceSelection: null,
        captureIds: ["scene"],
        facts: [
          { phaseId: "scene", factId: "name" },
          { phaseId: "scene", factId: "baseline" },
        ],
      },
    };
    const input = {
      files: new RepositoryFiles(root),
      sourceRoot: "source",
      sourceFiles: [{ path: "src/main.luau", hash: contentHash(text) }],
      evidence,
      plan: { scenarios: [], phases: [] } as unknown as StudioCollectionPlan,
      criterion,
    };
    const material = await criterionMaterial(input);
    assert.equal(material.unavailable.length, 1);
    assert.match(material.unavailable[0]!, /binding.*could not be resolved/);
    assert.deepEqual(
      material.signedObservations[0]!.observation,
      evidence.phases[0]!.observations[0],
    );
    assert.equal(
      material.signedObservations[0]!.hash,
      hashJson(evidence.phases[0]!.observations[0]),
    );
    assert.equal(material.signedObservations[1]!.observation?.kind, "binding_failure");
    assert.ok(
      Buffer.byteLength(stableJson(material)) <= criterionMaterialTextBound(criterion, input.plan),
    );
    assert.ok(
      criterionMaterialTextBound(
        {
          ...criterion,
          evidence: {
            sequence: false,
            actions: [],
            sourceSelection: null,
            facts: [],
            captureIds: ["scene"],
          },
        },
        input.plan,
      ) < criterionMaterialTextBound(criterion, input.plan),
    );
    const missing = await criterionMaterial({ ...input, evidence: { ...evidence, phases: [] } });
    assert.equal(missing.unavailable.length, 2);
    assert.equal(missing.signedObservations[0]!.observation, null);
    // A source-only judgment has no Studio evidence and needs no evidence class.
    const code: UnscaledCriterion = {
      ...criterion,
      evidenceClass: null,
      evidence: {
        sequence: false,
        actions: [],
        facts: [],
        captureIds: [],
        sourceSelection: { kind: "exact_files", paths: ["src/main.luau"] },
      },
    };
    const source = await criterionMaterial({ ...input, criterion: code });
    assert.deepEqual(source.sealedSources, [{ ...input.sourceFiles[0], text }]);
    assert.deepEqual(source.signedObservations, []);
    const combined: UnscaledCriterion = {
      ...criterion,
      evidence: { ...criterion.evidence, sourceSelection: code.evidence.sourceSelection },
    };
    const combinedMaterial = await criterionMaterial({ ...input, criterion: combined });
    assert.deepEqual(combinedMaterial.sealedSources, source.sealedSources);
    assert.deepEqual(combinedMaterial.signedObservations, material.signedObservations);
    assert.ok(
      criterionMaterialTextBound(combined, input.plan) >
        criterionMaterialTextBound(code, input.plan),
    );
    assert.ok(
      criterionMaterialTextBound(combined, input.plan) >
        criterionMaterialTextBound(criterion, input.plan),
    );
    const combinedAbsent = await criterionMaterial({
      ...input,
      criterion: combined,
      sourceFiles: [],
    });
    assert.ok(combinedAbsent.unavailable.some((reason) => reason.includes("source")));
    assert.equal(combinedAbsent.signedObservations.length, 2);
    const absent = await criterionMaterial({ ...input, sourceFiles: [], criterion: code });
    assert.match(absent.unavailable[0]!, /source/);
    const fixedAbsence = await criterionMaterial({
      ...input,
      sourceFiles: [],
      criterion: {
        id: "file",
        statement: "The implementation has a main script.",
        required: true,
        layer: "static",
        rule: { kind: "path_exists", path: "src/main.luau" },
      },
    });
    assert.deepEqual(fixedAbsence.absentSourcePaths, ["src/main.luau"]);
    assert.deepEqual(fixedAbsence.unavailable, []);
    await writeFile(join(root, "source/src/main.luau"), "modified");
    await assert.rejects(
      criterionMaterial({ ...input, criterion: code }),
      /differs from the sealed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected action receipts retain timing and failures without fabricating effects or unavailable input", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-action-material-"));
  try {
    const binding = { scenarioId: "interaction", stepId: "approach", context: "primary" };
    const step = {
      stepId: "approach",
      outcome: "observed",
      dueAt: 1_790_000_000,
      anchorObservedAt: 1_790_000_000,
      scheduledAt: 1_790_000_000.5,
      actedAt: 1_790_000_000.5125,
      observations: [],
      action: { kind: "move_to", succeeded: true },
    };
    const evidence = {
      phases: [],
      scenarios: [{ scenarioId: "interaction", reports: [{ context: "primary", steps: [step] }] }],
    } as unknown as StudioEvidence;
    const criterion: UnscaledCriterion = {
      id: "interaction",
      statement: "The player can interact.",
      required: true,
      evidenceClass: null,
      polarity: "presence",
      evidence: {
        sequence: false,
        sourceSelection: null,
        facts: [],
        actions: [binding],
        captureIds: [],
      },
    };
    const input = {
      files: new RepositoryFiles(root),
      sourceRoot: "source",
      sourceFiles: [],
      evidence,
      plan: {
        scenarios: [
          {
            id: "interaction",
            steps: [
              {
                id: "approach",
                action: { kind: "move_to", actor: "primary", targetPath: "role.beacon" },
                observations: [],
              },
            ],
          },
        ],
        phases: [],
      } as unknown as StudioCollectionPlan,
      criterion,
    };
    const material = await criterionMaterial(input);
    assert.deepEqual(material.signedActions, [
      {
        binding,
        receipt: {
          requestedAction: input.plan.scenarios[0]!.steps[0]!.action,
          outcome: "observed",
          scheduledAt: step.scheduledAt,
          actedAt: step.actedAt,
          action: step.action,
        },
        hash: hashJson({
          requestedAction: input.plan.scenarios[0]!.steps[0]!.action,
          outcome: "observed",
          scheduledAt: step.scheduledAt,
          actedAt: step.actedAt,
          action: step.action,
        }),
      },
    ]);
    assert.deepEqual(material.unavailable, []);
    assert.equal(Object.hasOwn(material.signedActions[0]!.receipt!, "arrived"), false);
    assert.equal(Object.hasOwn(material.signedActions[0]!.receipt!, "elapsedMs"), false);
    assert.equal(Object.hasOwn(material.signedActions[0]!.receipt!, "actionStartedMs"), false);
    assert.equal(Object.hasOwn(material.signedActions[0]!.receipt!, "stepCompletedMs"), false);
    assert.ok(
      criterionMaterialTextBound(criterion, input.plan) >
        criterionMaterialTextBound(
          {
            ...criterion,
            evidence: { ...criterion.evidence, actions: [] },
          },
          input.plan,
        ),
    );
    assert.ok(
      Buffer.byteLength(stableJson(material)) <= criterionMaterialTextBound(criterion, input.plan),
    );
    step.action.succeeded = false;
    const failed = await criterionMaterial(input);
    assert.equal(failed.signedActions[0]!.receipt?.action.succeeded, false);
    assert.deepEqual(failed.unavailable, []);
    assert.notEqual(failed.signedActions[0]!.hash, material.signedActions[0]!.hash);
    const missing = await criterionMaterial({ ...input, evidence: { ...evidence, scenarios: [] } });
    assert.equal(missing.signedActions[0]!.receipt, null);
    assert.equal(missing.signedActions[0]!.hash, null);
    assert.match(missing.unavailable[0]!, /Required action receipt was not acquired/);
    const independent = await criterionMaterial({
      ...input,
      evidence: { ...evidence, scenarios: [] },
      criterion: { ...criterion, evidence: { ...criterion.evidence, actions: [] } },
    });
    assert.deepEqual(independent.unavailable, []);
    const changedPlan = structuredClone(input.plan);
    changedPlan.scenarios[0]!.steps[0]!.action = {
      kind: "move_to",
      actor: "primary",
      targetPath: "role.other",
    };
    const rebound = await criterionMaterial({ ...input, plan: changedPlan });
    assert.notEqual(rebound.signedActions[0]!.hash, failed.signedActions[0]!.hash);
    changedPlan.scenarios[0]!.steps[0]!.action = { kind: "wait" };
    await assert.rejects(
      criterionMaterial({ ...input, plan: changedPlan }),
      /performed input in the frozen plan/,
    );
    changedPlan.scenarios[0]!.steps[0]!.action = {
      kind: "gui_activate",
      actor: "primary",
      path: "role.button",
    };
    await assert.rejects(
      criterionMaterial({ ...input, plan: changedPlan }),
      /receipt differs from the frozen plan/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
