import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { resolve } from "node:path";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { publishSealedSource } from "../../artifact-store/src/sealed-source.js";
import {
  assertAgentRun,
  assertCandidateManifest,
  hashJson,
  type AgentRun,
  type CandidateManifest,
} from "../../contracts/src/index.js";

import { operationSubject } from "./run-manifest.js";

/** Local trusted ingestion, separate from execution HTTP. Inventory is measured, never supplied. */
export async function ingestSource(root: string, value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "projectFile,provenance,workspace"
  )
    throw new Error("Source ingestion requires a workspace, project file and provenance");
  const input = value as {
    workspace: string;
    projectFile: string;
    provenance: RegisteredSource["provenance"];
  };
  if (
    typeof input.workspace !== "string" ||
    !input.workspace ||
    typeof input.projectFile !== "string" ||
    !input.provenance ||
    typeof input.provenance !== "object" ||
    Array.isArray(input.provenance) ||
    Object.keys(input.provenance).sort().join(",") !==
      "evidenceHashes,kind,originOperationId,parentSourceId" ||
    !["generated", "retained", "control"].includes(input.provenance.kind) ||
    !Array.isArray(input.provenance.evidenceHashes) ||
    !input.provenance.evidenceHashes.length ||
    input.provenance.evidenceHashes.some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash),
    ) ||
    (input.provenance.parentSourceId !== null &&
      !/^[a-f0-9]{64}$/u.test(input.provenance.parentSourceId)) ||
    (input.provenance.originOperationId !== null &&
      (typeof input.provenance.originOperationId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(input.provenance.originOperationId)))
  )
    throw new Error("Invalid source ingestion provenance");
  const workspace = resolve(root, input.workspace),
    files = await inventoryTree(workspace);
  return registerSource({
    root,
    workspace,
    candidate: { projectFile: input.projectFile, files, rootHash: hashJson(files) },
    provenance: input.provenance,
  });
}

export interface RegisteredSource {
  id: string;
  candidate: CandidateManifest;
  provenance: {
    kind: "generated" | "retained" | "control";
    evidenceHashes: string[];
    originOperationId: string | null;
    parentSourceId: string | null;
  };
}

/** Trusted ingestion only. HTTP execution requests accept the returned identity, never a directory. */
export async function registerSource(input: {
  root: string;
  workspace: string;
  candidate: CandidateManifest;
  provenance: RegisteredSource["provenance"];
}): Promise<RegisteredSource> {
  assertCandidateManifest(input.candidate);
  const body = { candidate: input.candidate, provenance: input.provenance };
  const source = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(input.root);
  await files.directory(`.basalt-evals/sources/${source.id}`);
  await publishSealedSource(
    input.workspace,
    files.path(`.basalt-evals/sources/${source.id}/candidate`),
    source.candidate,
  );
  try {
    await files.writeJson(`.basalt-evals/sources/${source.id}/source.json`, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return (await readRegisteredSource(input.root, source.id)).source;
}

export async function readRegisteredSource(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid registered source identity");
  const files = new RepositoryFiles(root);
  const base = `.basalt-evals/sources/${id}`;
  const source = await files.json<RegisteredSource>(`${base}/source.json`);
  const { id: saved, ...body } = source;
  if (
    saved !== id ||
    hashJson(body) !== id ||
    !["generated", "retained", "control"].includes(source.provenance.kind) ||
    !source.provenance.evidenceHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)) ||
    (source.provenance.parentSourceId !== null &&
      !/^[a-f0-9]{64}$/u.test(source.provenance.parentSourceId)) ||
    (source.provenance.originOperationId !== null &&
      (typeof source.provenance.originOperationId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(source.provenance.originOperationId)))
  )
    throw new Error("Registered source provenance changed");
  if (source.provenance.originOperationId) {
    const manifest = await files.json(
      `.basalt-evals/eval-operations/${source.provenance.originOperationId}/manifest.json`,
    );
    if (!source.provenance.evidenceHashes.includes(hashJson(manifest)))
      throw new Error("Source origin differs from its retained operation");
  }
  assertCandidateManifest(source.candidate);
  const workspaceRoot = files.path(`${base}/candidate`);
  const inventory = await inventoryTree(workspaceRoot);
  if (
    hashJson(inventory) !== source.candidate.rootHash ||
    hashJson(inventory) !== hashJson(source.candidate.files)
  )
    throw new Error("Registered source bytes changed");
  return { source, workspaceRoot, relativeRoot: `${base}/candidate` };
}

/** Retained sources remain sources; they never acquire a fabricated AgentRun. */
export async function operationSource(
  root: string,
  manifest: RunOperationManifest,
  subjectId: string,
) {
  const subject = operationSubject(manifest, subjectId);
  if (subject.sourceId) {
    const saved = await readRegisteredSource(root, subject.sourceId);
    return {
      candidate: saved.source.candidate,
      workspaceRoot: saved.workspaceRoot,
      relativeRoot: saved.relativeRoot,
      agentRun: null,
    };
  }
  const base = `.basalt-evals/eval-operations/${manifest.id}/builder/${subjectId}`;
  const run = await new RepositoryFiles(root).json<AgentRun>(`${base}/agent-run.json`);
  assertAgentRun(run);
  if (run.treatmentId !== subjectId) throw new Error("Source has a different builder identity");
  const workspaceRoot = resolve(root, base, "candidate");
  const inventory = await inventoryTree(workspaceRoot);
  if (
    hashJson(inventory) !== run.candidate.rootHash ||
    hashJson(inventory) !== hashJson(run.candidate.files)
  )
    throw new Error("Sealed builder source bytes changed");
  return {
    candidate: run.candidate,
    workspaceRoot,
    relativeRoot: `${base}/candidate`,
    agentRun: run,
  };
}
