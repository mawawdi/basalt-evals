import { resolve } from "node:path";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { createEvalDraft, type EvalDraft } from "./input.js";
import { projectEvaluation } from "./catalog.js";
import {
  assertUnattendedEvalRevision,
  compileEvalProposal,
  type EvalProposal,
  type EvalRevision,
} from "./compiler.js";

const hashPattern = /^[a-f0-9]{64}$/u;

// Interpreting a draft and compiling a proposal are pure functions of content whose
// identity every read verifies first, so a process derives each identity only once.
const interpretedDrafts = new Map<string, string>();
const compiledRevisions = new Set<string>();

function interpretedDraftHash(input: unknown): string {
  const inputHash = hashJson(input);
  let hash = interpretedDrafts.get(inputHash);
  if (hash === undefined) {
    hash = hashJson(createEvalDraft(input));
    interpretedDrafts.set(inputHash, hash);
  }
  return hash;
}

interface DefinitionPointer {
  schema: "basalt-evals/eval-definition-pointer";
  id: string;
  artifact: ArtifactReference;
}

export class EvalDefinitionStore {
  private readonly artifacts: ImmutableJsonArtifactStore;
  private readonly files: RepositoryFiles;

  constructor(private readonly repositoryRoot: string) {
    this.files = new RepositoryFiles(repositoryRoot);
    this.artifacts = new ImmutableJsonArtifactStore(
      resolve(repositoryRoot, ".basalt-evals/eval-definition-artifacts"),
    );
  }

  private pointerFile(kind: "drafts" | "revisions", id: string): string {
    if (!hashPattern.test(id)) throw new Error("Invalid eval definition identity");
    return ".basalt-evals/authoring/" + kind + "/" + id + ".json";
  }

  private async put(kind: "drafts" | "revisions", id: string, value: unknown): Promise<void> {
    const artifact = await this.artifacts.write(value);
    const file = this.pointerFile(kind, id);
    const pointer: DefinitionPointer = {
      schema: "basalt-evals/eval-definition-pointer",
      id,
      artifact,
    };
    try {
      await this.files.writeJson(file, pointer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.files.json<DefinitionPointer>(file);
      if (hashJson(existing) !== hashJson(pointer))
        throw new Error("Eval definition identity already points to different bytes");
    }
  }

  private async get<T>(kind: "drafts" | "revisions", id: string): Promise<T> {
    const pointer = await this.files.json<DefinitionPointer>(this.pointerFile(kind, id));
    if (pointer.schema !== "basalt-evals/eval-definition-pointer" || pointer.id !== id)
      throw new Error("Eval definition pointer identity mismatch");
    return this.artifacts.read<T>(pointer.artifact);
  }

  async writeDraft(draft: EvalDraft): Promise<void> {
    if (hashJson(createEvalDraft(draft.input)) !== hashJson(draft))
      throw new Error("Eval draft content identity mismatch");
    await this.put("drafts", draft.id, draft);
    await projectEvaluation(this.repositoryRoot, {
      id: draft.id,
      evaluationId: null,
      archived: false,
      kind: "draft",
      draftId: draft.id,
      title: draft.title,
      description: draft.stages[0]!.prompt.slice(0, 600),
      stages: draft.stages.length,
      readiness: "draft",
      validationRecordHash: null,
      qualitative: false,
      reason: null,
      updatedAt: new Date().toISOString(),
    });
  }

  async readDraft(id: string): Promise<EvalDraft> {
    const draft = await this.get<EvalDraft>("drafts", id);
    if (
      draft.id !== id ||
      hashJson(draft.input) !== id ||
      interpretedDraftHash(draft.input) !== hashJson(draft) ||
      draft.stages.some(
        (stage) =>
          stage.promptHash !== hashJson(stage.prompt) ||
          stage.rubricHash !== hashJson(stage.rubric) ||
          stage.criteria.some((item) => stage.rubric.slice(item.start, item.end) !== item.text),
      )
    )
      throw new Error("Eval draft content changed");
    return draft;
  }

  /**
   * Write one stage revision. The revisions of a staged evaluation are written from the last
   * stage to the first, so the next stage revision of each one exists. Only stage 1 enters the
   * catalog, because its identity is the identity of the whole evaluation.
   */
  async writeRevision(revision: EvalRevision): Promise<void> {
    const { id, ...body } = revision;
    if (hashJson(body) !== id) throw new Error("Eval revision content identity mismatch");
    const draft = await this.readDraft(revision.draftId);
    assertAuthoredStage(revision, draft);
    if (revision.stage.nextRevisionId !== null) {
      const next = await this.readRevision(revision.stage.nextRevisionId);
      if (next.draftId !== revision.draftId || next.stage.index !== revision.stage.index + 1)
        throw new Error("The next stage revision belongs to another evaluation");
    }
    if (
      compileEvalProposal(
        draft,
        revision.stage.index,
        proposalOf(revision),
        revision.stage.nextRevisionId,
      ).revision?.id !== id
    )
      throw new Error("Eval revision no longer validates against its human authority");
    await this.put("revisions", id, revision);
    if (revision.stage.index !== 1) return;
    const stages = await this.readStageRevisions(id);
    await projectEvaluation(this.repositoryRoot, {
      id,
      evaluationId: null,
      archived: false,
      kind: "evaluation",
      draftId: revision.draftId,
      title: revision.publicTask.title,
      description: revision.authored.builderPrompt.slice(0, 600),
      stages: stages.length,
      readiness: "needs_validation",
      validationRecordHash: null,
      qualitative: stages.some(
        (stage) =>
          [
            ...stage.privateEvaluator.codeQuality,
            ...stage.privateEvaluator.visual,
            ...stage.privateEvaluator.unscaled,
          ].length > 0,
      ),
      reason: "The preparation of this evaluation is not complete.",
      updatedAt: new Date().toISOString(),
    });
  }

  async readRevision(id: string): Promise<EvalRevision> {
    const revision = await this.get<EvalRevision>("revisions", id);
    const { id: storedId, ...body } = revision;
    if (storedId !== id || hashJson(body) !== id) throw new Error("Eval revision content changed");
    const draft = await this.readDraft(revision.draftId);
    if (revision.schema !== "basalt-evals/eval-revision")
      throw new Error("Eval revision is not bound to its authored draft");
    assertAuthoredStage(revision, draft);
    // Historical revisions retain their original bytes when current compiler
    // rules become stricter. Execution checks current eligibility separately.
    return revision;
  }

  /**
   * The stage revisions of an evaluation in stage order, from the revision of stage 1. Each
   * revision names the next one, so the identity of stage 1 binds them all.
   */
  async readStageRevisions(firstId: string, executable = false): Promise<EvalRevision[]> {
    const read = (id: string) =>
      executable ? this.readExecutableRevision(id) : this.readRevision(id);
    const stages = [await read(firstId)];
    if (stages[0]!.stage.index !== 1)
      throw new Error("An evaluation starts at the revision of its first stage");
    while (stages.at(-1)!.stage.nextRevisionId !== null) {
      const previous = stages.at(-1)!;
      const next = await read(previous.stage.nextRevisionId!);
      if (next.draftId !== previous.draftId || next.stage.index !== previous.stage.index + 1)
        throw new Error("A stage revision names a revision of another evaluation");
      stages.push(next);
    }
    if (stages.length !== stages[0]!.stage.count)
      throw new Error("The stage revisions of the evaluation are incomplete");
    return stages;
  }

  /** Active execution requires current compiler validity; archive inspection does not. */
  async readExecutableRevision(id: string): Promise<EvalRevision> {
    const revision = await this.readRevision(id);
    const draft = await this.readDraft(revision.draftId);
    if (!compiledRevisions.has(id)) {
      if (
        compileEvalProposal(
          draft,
          revision.stage.index,
          proposalOf(revision),
          revision.stage.nextRevisionId,
        ).revision?.id !== id
      )
        throw new Error(
          "Basalt changed after it prepared this evaluation. The current Basalt cannot run it. Edit the evaluation and save it to prepare it again.",
        );
      compiledRevisions.add(id);
    }
    assertUnattendedEvalRevision(revision);
    return revision;
  }
}

/** The generated part of a revision, without its identity, its authority and its stage. */
function proposalOf(revision: EvalRevision): EvalProposal {
  const {
    id: _id,
    schema: _schema,
    draftId: _draftId,
    builderPromptHash: _promptHash,
    rubricHash: _rubricHash,
    authored: _authored,
    stage: _stage,
    ...proposal
  } = revision;
  return proposal;
}

/** A revision keeps the exact authored text, spans and gate of its stage of the draft. */
function assertAuthoredStage(revision: EvalRevision, draft: EvalDraft): void {
  const stage = draft.stages[revision.stage.index - 1];
  if (
    !stage ||
    revision.stage.count !== draft.stages.length ||
    (revision.stage.nextRevisionId === null) !== (revision.stage.index === revision.stage.count) ||
    revision.builderPromptHash !== stage.promptHash ||
    revision.rubricHash !== stage.rubricHash ||
    revision.publicTask.prompt !== stage.prompt ||
    hashJson(revision.stage.earlierPrompts) !==
      hashJson(draft.stages.slice(0, revision.stage.index - 1).map((item) => item.prompt)) ||
    hashJson(revision.stage.gateCriterionIds) !== hashJson(stage.gateCriterionIds) ||
    hashJson(revision.authored) !==
      hashJson({
        builderPrompt: stage.prompt,
        rubric: stage.rubric,
        criteria: stage.criteria,
        document: stage.document,
      })
  )
    throw new Error("Eval revision changed its human-authored text or criterion spans");
}
