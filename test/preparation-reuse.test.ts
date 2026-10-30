import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  prepareEvalDraft,
  publicPreparationErrors,
} from "../packages/agent-runtime/src/eval-preparation.js";
import { hashJson } from "../packages/contracts/src/index.js";
import type { RecheckPreview } from "../packages/contracts/src/recheck.js";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft, type EvalDraft } from "../packages/eval-authoring/src/input.js";
import {
  basePublicPreparation,
  type PreparationBase,
} from "../packages/eval-authoring/src/preparation-base.js";
import { PREPARATION_ATTEMPTS } from "../packages/eval-authoring/src/preparation-request.js";
import type {
  EvaluationStageContext,
  PrivateProposal,
  PublicPreparation,
} from "../packages/eval-authoring/src/proposals.js";
import { preparationModelWork } from "../packages/eval-authoring/src/quote.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { revisionHashes } from "../packages/eval-authoring/src/revision-delta.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { preparationBase } from "../packages/operator/src/prepare-draft.js";
import {
  projectPreparationOutcome,
  readPreparationReuse,
} from "../packages/operator/src/preparation-outcome.js";
import { previewRecheck } from "../packages/operator/src/recheck.js";
import { SAVED_JUDGE, savedRun } from "./saved-run-fixture.js";
import {
  fixturePrivate,
  fixturePublic,
  fixtureSnapshots,
  publicPreparation,
  stagedPrivateRoles,
} from "./shared-api-fixture.js";

const TITLE = "Blue Beacon";
const PROMPT = "Create a blue Beacon part.";
const rubric = (blue: string) =>
  `- A Beacon object exists.\n- ${blue}\n  - Evidence class: appearance\n- The Beacon stands upright.\n  - Evidence class: appearance`;
const input = (blue: string) => ({
  schema: "basalt-evals/eval-authoring-input" as const,
  title: TITLE,
  stages: [{ prompt: PROMPT, rubric: rubric(blue) }],
});
const BASE_INPUT = input("The Beacon looks blue.");
// Only the text of criterion 2 changes. Criterion 3 moves in the rubric.
const CHANGED_INPUT = input("The Beacon looks deep blue.");
const CHECKS = ["beacon-exists", "beacon-blue", "beacon-upright"];

/** The private proposal of one stage of a draft: one code check and one judge check each. */
function proposalFor(draft: EvalDraft, stage = 1): PrivateProposal {
  const criteria = draft.stages[stage - 1]!.criteria;
  const proposal = structuredClone(fixturePrivate);
  proposal.privateEvaluator.task.slug = draft.slug;
  proposal.privateEvaluator.deterministic[0]!.statement = criteria[0]!.text;
  const judge = proposal.privateEvaluator.unscaled[0]!;
  proposal.privateEvaluator.unscaled = criteria.slice(1).map((criterion, index) => ({
    ...structuredClone(judge),
    id: CHECKS[index + 1]!,
    statement: criterion.text,
    evidenceClass: criterion.evidenceClass,
    polarity: criterion.polarity,
  }));
  proposal.criterionMappings = criteria.map((criterion, index) => ({
    authoredCriterionId: criterion.id,
    authoredClauseIds: criterion.clauses.map((clause) => clause.id),
    authority: { source: "human_rubric" as const, start: criterion.start, end: criterion.end },
    method: index === 0 ? ("deterministic" as const) : ("unscaled" as const),
    executableCriterionId: CHECKS[index]!,
    rationale: "Synthetic integration fixture with explicitly bound evidence.",
  }));
  return proposal;
}

/**
 * The answer of a criteria request. A correction edits the carried proposal: it adds only the
 * checks that the carried proposal lacks, like the edits of the correction tool.
 */
function criteriaAnswer(
  draft: EvalDraft,
  stage: number,
  previous: PrivateProposal | null,
): PrivateProposal {
  const full = proposalFor(draft, stage);
  if (!previous) return full;
  const answer = structuredClone(previous);
  const present = new Set(answer.criterionMappings.map((mapping) => mapping.executableCriterionId));
  for (const mapping of full.criterionMappings) {
    if (present.has(mapping.executableCriterionId)) continue;
    answer.criterionMappings.push(mapping);
    answer.privateEvaluator.unscaled.push(
      ...full.privateEvaluator.unscaled.filter((item) => item.id === mapping.executableCriterionId),
    );
  }
  return answer;
}

/** A compiled one-stage revision of a draft with the fixture public part. */
function revisionFor(draft: EvalDraft, change: (proposal: PrivateProposal) => void = () => {}) {
  const proposal = proposalFor(draft);
  change(proposal);
  const { publicScene, ...publicPart } = fixturePublic;
  const compiled = compileEvalProposal(draft, 1, {
    ...publicPart,
    ...proposal,
    seed: neutralRojoSeed(draft.title, publicScene),
  });
  assert.ok(compiled.revision, JSON.stringify(compiled.validation));
  return compiled.revision;
}

const noPublic = {
  async preparePublic(): Promise<PublicPreparation> {
    throw new Error("The public part comes from the base");
  },
};
const frozen = (proposal: PublicPreparation | null) => ({
  proposal,
  accepted: async () => {},
});
const checksOf = (revision: EvalRevision) =>
  Object.fromEntries(
    [...revision.privateEvaluator.deterministic, ...revision.privateEvaluator.unscaled].map(
      (criterion) => [criterion.id, hashJson(criterion)],
    ),
  );
function actions(preview: RecheckPreview) {
  return Object.fromEntries(
    preview.cells.map((cell) => [
      cell.toCriterionId ?? cell.fromCriterionId,
      [cell.action, cell.reason],
    ]),
  );
}

test("a changed judge criterion keeps the tests of the base, and a recheck judges only what changed", async () => {
  for (const grouping of ["per_criterion", "shared"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-plan-reuse-"));
    try {
      const saved = await savedRun(root, SAVED_JUDGE, {
        input: BASE_INPUT,
        change: ({ privateProposal }) => {
          Object.assign(privateProposal, proposalFor(createEvalDraft(BASE_INPUT)));
        },
        judgeSettings: { samples: 1, grouping },
      });
      const draft = createEvalDraft(CHANGED_INPUT);
      // A draft with another prompt has no base.
      assert.equal(
        await preparationBase(root, createEvalDraft({ ...CHANGED_INPUT, title: "Other" })),
        null,
      );
      const base = await preparationBase(root, draft);
      assert.equal(base?.revisions[0]!.id, saved.revision.id);
      const publicPart = basePublicPreparation(base!);
      assert.ok(publicPart);
      assert.deepEqual(publicPreparationErrors(publicPart, draft), []);
      const requests: Array<{ stage: string; previous: string[]; diagnostics: string[] }> = [];
      const prepared = await prepareEvalDraft(
        draft,
        {
          ...noPublic,
          ...stagedPrivateRoles((value) => {
            requests.push({
              stage: value.stage,
              previous:
                value.previousPrivateProposal?.criterionMappings.map(
                  (mapping) => mapping.executableCriterionId ?? "",
                ) ?? [],
              diagnostics: value.diagnostics,
            });
            return criteriaAnswer(draft, 1, value.previousPrivateProposal);
          }),
        },
        undefined,
        frozen(publicPart),
        base,
      );
      assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
      // One correction of the carried proposal, which has no check of the changed criterion.
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.stage, "criteria");
      assert.deepEqual(requests[0]!.previous, ["beacon-exists", "beacon-upright"]);
      assert.match(requests[0]!.diagnostics.join("\n"), /criterion-2/u);
      // Criterion 3 moved in the rubric, and its carried mapping follows it.
      assert.doesNotMatch(requests[0]!.diagnostics.join("\n"), /criterion-[13]/u);
      assert.deepEqual(prepared.attempts, {
        public: 0,
        stages: [{ privatePlan: 0, privateCriteria: 1 }],
      });
      assert.deepEqual(prepared.reuse, {
        baseRevisionId: saved.revision.id,
        stages: [{ plan: "reused", carriedCriteria: 2, preparedCriteria: 1 }],
      });
      const revision = prepared.revisions[0]!;
      const [before, after] = [revisionHashes(saved.revision), revisionHashes(revision)];
      assert.equal(after.publicContentHash, before.publicContentHash);
      assert.equal(after.studioPlanHash, before.studioPlanHash);
      const [beforeChecks, afterChecks] = [checksOf(saved.revision), checksOf(revision)];
      assert.equal(afterChecks["beacon-exists"], beforeChecks["beacon-exists"]);
      assert.equal(afterChecks["beacon-upright"], beforeChecks["beacon-upright"]);
      assert.notEqual(after.criteria["beacon-blue"]!.hash, before.criteria["beacon-blue"]!.hash);
      assert.deepEqual(after.criteria["beacon-upright"], before.criteria["beacon-upright"]);
      const store = new EvalDefinitionStore(root);
      await store.writeDraft(draft);
      await store.writeRevision(revision);
      await registerReadyEvaluation(root, revision.id);
      const preview = await previewRecheck(
        root,
        {
          operationId: saved.operationId,
          subjectIds: [saved.subjectId],
          revisionId: revision.id,
          judge: { modelId: SAVED_JUDGE, presentation: "still" },
        },
        saved.adapters,
      );
      // The recheck judges with the grouping of the run.
      assert.deepEqual(
        preview.judge?.units.map((unit) => [unit.criterionIds, unit.batch.grouping]),
        grouping === "shared"
          ? [[["beacon-upright", "beacon-blue"], "shared"]]
          : [[["beacon-blue"], "per_criterion"]],
      );
      assert.deepEqual(actions(preview), {
        "beacon-exists": ["reuse", "unchanged"],
        "beacon-blue": ["judge_recheck", "criterion_changed"],
        // A shared request answered both judge criteria, so its other criterion is judged again.
        "beacon-upright":
          grouping === "shared"
            ? ["judge_recheck", "shared_request_changed"]
            : ["reuse", "unchanged"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("without a base, the preparation prepares the plan and the criteria", async () => {
  const draft = createEvalDraft(CHANGED_INPUT);
  const stages: string[] = [];
  const prepared = await prepareEvalDraft(
    draft,
    {
      ...noPublic,
      ...stagedPrivateRoles((value) => {
        stages.push(value.stage);
        return proposalFor(draft);
      }),
    },
    undefined,
    frozen(publicPreparation(fixturePublic)),
  );
  assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
  assert.deepEqual(stages, ["plan", "criteria"]);
  assert.equal(prepared.reuse, null);
});

test("a base plan that fails the current checks makes the stage prepare a plan", async () => {
  const draft = createEvalDraft(CHANGED_INPUT);
  const revision = revisionFor(createEvalDraft(BASE_INPUT));
  // A plan with a manual phase cannot run unattended under the current checks.
  const stale = structuredClone(revision);
  stale.privateEvaluator.studio.phases[0]!.driver = { kind: "manual" } as never;
  const base: PreparationBase = { draft: createEvalDraft(BASE_INPUT), revisions: [stale] };
  const stages: string[] = [];
  const prepared = await prepareEvalDraft(
    draft,
    {
      ...noPublic,
      ...stagedPrivateRoles((value) => {
        stages.push(value.stage);
        return proposalFor(draft);
      }),
    },
    undefined,
    frozen(basePublicPreparation({ draft: base.draft, revisions: [revision] })),
    base,
  );
  assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
  assert.deepEqual(stages, ["plan", "criteria"]);
  assert.deepEqual(prepared.reuse?.stages, [
    { plan: "prepared", carriedCriteria: 0, preparedCriteria: 3 },
  ]);
});

test("criteria that fail on the plan of the base fall back to a new plan and new criteria", async () => {
  const draft = createEvalDraft(CHANGED_INPUT);
  const base: PreparationBase = {
    draft: createEvalDraft(BASE_INPUT),
    revisions: [revisionFor(createEvalDraft(BASE_INPUT))],
  };
  const stages: string[] = [];
  const prepared = await prepareEvalDraft(
    draft,
    {
      ...noPublic,
      ...stagedPrivateRoles((value) => {
        stages.push(value.stage);
        const proposal = proposalFor(draft);
        // Each correction on the plan of the base leaves the changed criterion without a check.
        if (!stages.includes("plan"))
          proposal.criterionMappings = proposal.criterionMappings.filter(
            (mapping) => mapping.executableCriterionId !== "beacon-blue",
          );
        return proposal;
      }),
    },
    undefined,
    frozen(basePublicPreparation(base)),
    base,
  );
  assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
  assert.deepEqual(stages, [
    ...Array<string>(PREPARATION_ATTEMPTS).fill("criteria"),
    "plan",
    "criteria",
  ]);
  assert.deepEqual(prepared.attempts.stages, [{ privatePlan: 1, privateCriteria: 1 }]);
  assert.deepEqual(prepared.reuse?.stages, [
    { plan: "fallback", carriedCriteria: 0, preparedCriteria: 3 },
  ]);
});

test("the quote of a preparation with a base covers the carried correction and the fallback", () => {
  const draft = createEvalDraft(CHANGED_INPUT);
  const snapshot = fixtureSnapshots[0]!;
  const normal = preparationModelWork(draft, snapshot);
  const withBase = preparationModelWork(draft, snapshot, false, true);
  const publicReused = preparationModelWork(draft, snapshot, true, true);
  assert.equal(normal.length, 3 * PREPARATION_ATTEMPTS);
  assert.equal(withBase.length, 4 * PREPARATION_ATTEMPTS);
  assert.equal(publicReused.length, 3 * PREPARATION_ATTEMPTS);
  // The fallback is the normal work, so the quote with a base holds each normal request.
  const keys = new Set(withBase.map((item) => hashJson(item)));
  assert.ok(normal.every((item) => keys.has(hashJson(item))));
  // Each carried correction can hold the carried proposal, so it can be larger than a first
  // criteria request.
  const tokens = (work: typeof normal) =>
    work.reduce((sum, item) => sum + item.upper.inputTokens, 0);
  assert.ok(tokens(withBase) > tokens(normal));
});

test("each stage of a staged draft keeps the plan of its own base stage", async () => {
  const stagedInput = (blue: string) => ({
    schema: "basalt-evals/eval-authoring-input" as const,
    title: "Staged beacon",
    stages: [
      {
        prompt: PROMPT,
        rubric: rubric("The Beacon looks blue."),
        gateCriterionIds: ["criterion-1"],
      },
      { prompt: "Make the Beacon pulse once each second.", rubric: rubric(blue) },
    ],
  });
  const baseDraft = createEvalDraft(stagedInput("The Beacon looks blue."));
  const draft = createEvalDraft(stagedInput("The Beacon looks deep blue."));
  const publicPart = (target: EvalDraft): PublicPreparation => ({
    publicScene: fixturePublic.publicScene,
    stages: target.stages.map((stage) => ({
      publicTask: {
        ...structuredClone(fixturePublic.publicTask),
        prompt: stage.prompt,
        slug: target.slug,
      },
      publicDevelopment: {
        ...structuredClone(fixturePublic.publicDevelopment),
        task: { slug: target.slug },
      },
    })),
  });
  // Each stage of the base has its own plan.
  const stagedRoles = (target: EvalDraft, stages: string[]) =>
    stagedPrivateRoles((value) => {
      const index = (value as typeof value & { evaluationStage: EvaluationStageContext })
        .evaluationStage.index;
      stages.push(`${value.stage} ${index}`);
      const proposal = criteriaAnswer(target, index, value.previousPrivateProposal);
      proposal.privateEvaluator.studio.phases[0]!.instruction = `Capture stage ${index}.`;
      return proposal;
    });
  const baseRun = await prepareEvalDraft(
    baseDraft,
    { ...noPublic, ...stagedRoles(baseDraft, []) },
    undefined,
    frozen(publicPart(baseDraft)),
  );
  assert.equal(baseRun.validation.status, "ready", JSON.stringify(baseRun.validation));
  const base: PreparationBase = { draft: baseDraft, revisions: baseRun.revisions };
  const stages: string[] = [];
  const prepared = await prepareEvalDraft(
    draft,
    { ...noPublic, ...stagedRoles(draft, stages) },
    undefined,
    frozen(basePublicPreparation(base)),
    base,
  );
  assert.equal(prepared.validation.status, "ready", JSON.stringify(prepared.validation));
  // Stage 1 did not change, so it needs no request. Stage 2 corrects its carried criteria.
  assert.deepEqual(stages, ["criteria 2"]);
  assert.deepEqual(prepared.reuse?.stages, [
    { plan: "reused", carriedCriteria: 3, preparedCriteria: 0 },
    { plan: "reused", carriedCriteria: 2, preparedCriteria: 1 },
  ]);
  for (const [index, revision] of prepared.revisions.entries())
    assert.equal(
      hashJson(revision.privateEvaluator.studio),
      hashJson(baseRun.revisions[index]!.privateEvaluator.studio),
    );
  assert.notEqual(
    hashJson(prepared.revisions[0]!.privateEvaluator.studio),
    hashJson(prepared.revisions[1]!.privateEvaluator.studio),
  );
});

test("the evaluation page reads the reuse of the preparation of its revision", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-plan-reuse-projection-"));
  try {
    const revisionId = "b".repeat(64);
    const reuse = {
      baseRevisionId: "a".repeat(64),
      stages: [{ plan: "reused", carriedCriteria: 2, preparedCriteria: 1 }],
    };
    const journal = await OperationJournal.open(root);
    try {
      projectPreparationOutcome(
        journal,
        { action: { stage: "preparation", id: "preparation-action" } } as never,
        {
          schema: "basalt-evals/preparation-receipt",
          revisionId,
          reuse,
          validation: { status: "ready", diagnostics: [] },
        },
      );
    } finally {
      journal.close();
    }
    assert.deepEqual(await readPreparationReuse(root, revisionId), reuse);
    assert.equal(await readPreparationReuse(root, "c".repeat(64)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
