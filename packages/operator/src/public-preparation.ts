import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import type { PublicPreparation } from "../../eval-authoring/src/proposals.js";

export interface PublicPreparationContext {
  /** The prompt of each stage, in stage order. */
  stagePrompts: string[];
  title: string;
  slug: string;
  buildIdentityHash: string;
  preparationIdentityHash: string;
}

/**
 * `model`: the preparation model wrote the public part. `curated`: a person curated it from task
 * files for the preparation parity study, so the preparation model writes only the private stages.
 */
type PublicPreparationProvenance = "model" | "curated";

interface PublicPreparationRecord {
  id: string;
  context: PublicPreparationContext;
  provenance: PublicPreparationProvenance;
  proposal: PublicPreparation;
}

/** The public preparation keeps the exact prompt of each stage. */
function samePrompts(proposal: PublicPreparation, context: PublicPreparationContext): boolean {
  return (
    hashJson(proposal.stages.map((stage) => stage.publicTask.prompt)) ===
    hashJson(context.stagePrompts)
  );
}

/** Cache authority is prompt/public configuration only. No private rubric or draft identity. */
export async function readPublicPreparation(
  root: string,
  context: PublicPreparationContext,
): Promise<PublicPreparation | null> {
  const files = new RepositoryFiles(root);
  const pointer = await files.optional<{ contentHash: string }>(
    `.basalt-evals/public-preparation/${hashJson(context)}.json`,
  );
  if (!pointer) return null;
  if (!/^[a-f0-9]{64}$/u.test(pointer.contentHash))
    throw new Error("Invalid public preparation pointer");
  const record = await files.json<PublicPreparationRecord>(
    `.basalt-evals/public-preparation/artifacts/${pointer.contentHash}.json`,
  );
  const { id, ...body } = record;
  if (
    id !== pointer.contentHash ||
    hashJson(body) !== id ||
    hashJson(record.context) !== hashJson(context) ||
    !samePrompts(record.proposal, context)
  )
    throw new Error("Public preparation artifact changed");
  return record.proposal;
}

/** Called only after the fixed public validation pass. */
export async function savePublicPreparation(
  root: string,
  context: PublicPreparationContext,
  proposal: PublicPreparation,
  provenance: PublicPreparationProvenance,
): Promise<void> {
  if (!samePrompts(proposal, context))
    throw new Error("Public preparation changed the builder prompt");
  const files = new RepositoryFiles(root);
  const body = { context, provenance, proposal };
  const record = { ...body, id: hashJson(body) };
  const publish = async (file: string, value: unknown) => {
    try {
      await files.writeJson(file, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashJson(await files.json(file)) !== hashJson(value))
        throw new Error("Public preparation identity is already frozen");
    }
  };
  await publish(`.basalt-evals/public-preparation/artifacts/${record.id}.json`, record);
  await publish(`.basalt-evals/public-preparation/${hashJson(context)}.json`, {
    contentHash: record.id,
  });
}
