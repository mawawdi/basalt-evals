import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RecordRepository } from "../../artifact-store/src/records.js";
import { compareCodeUnits, hashJson } from "../../contracts/src/index.js";
import { fields, text, hash } from "../../contracts/src/validation.js";
import {
  evaluationSuite,
  suiteMembers,
  suiteSnapshot,
  type EvaluationSuite,
  type SuiteSnapshot,
} from "../../contracts/src/suites.js";
import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { readReadinessRecord } from "../../eval-authoring/src/registration.js";

function repositories(journal: OperationJournal) {
  return {
    suites: new RecordRepository(journal, "suites", evaluationSuite),
    snapshots: new RecordRepository(journal, "suite_snapshots", suiteSnapshot),
  };
}

export async function saveSuite(root: string, value: unknown, id?: string) {
  const input = fields(
    value,
    ["title", "description", "members", "expectedSnapshotId", "actionId"],
    "Collection inputs",
  );
  const actionId = text(input.actionId, 100, "Collection save identity");
  if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(actionId))
    throw new Error("Invalid collection save identity");
  const requestHash = hashJson({ id: id ?? null, input });
  const recovery = await OperationJournal.open(root);
  try {
    const saved = recovery.read<{ requestHash: string; result: EvaluationSuite }>(
      "collection_save_actions",
      actionId,
    );
    if (saved) {
      if (saved.requestHash !== requestHash)
        throw new Error(
          "An earlier save of this suite had different content. Load the saved suite. Then save your changes again.",
        );
      return saved.result;
    }
  } finally {
    recovery.close();
  }
  const suiteId = id ?? `suite-${actionId}`;
  const title = text(input.title, 160, "Suite title");
  if (typeof input.description !== "string" || input.description.length > 2000)
    throw new Error("The suite description must contain 2,000 characters or fewer.");
  const members = suiteMembers(input.members);
  const definitions = new EvalDefinitionStore(root);
  for (const member of members) {
    const revision = await definitions.readExecutableRevision(member.revisionId);
    const validation = await readReadinessRecord(root, revision.id, member.validationRecordHash);
    if (
      !["ready", "controls_checked"].includes(validation.validation.status) ||
      (validation.validation.status === "controls_checked" &&
        validation.check?.status !== "checked")
    )
      throw new Error("Every collection member requires its exact executable readiness record");
  }
  const body = { suiteId, title, description: input.description, members };
  const snapshot: SuiteSnapshot = { ...body, id: hashJson(body) };
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const { suites, snapshots } = repositories(journal);
      const saved = journal.read<{ requestHash: string; result: EvaluationSuite }>(
        "collection_save_actions",
        actionId,
      );
      if (saved) {
        if (saved.requestHash !== requestHash)
          throw new Error(
            "An earlier save of this suite had different content. Load the saved suite. Then save your changes again.",
          );
        return saved.result;
      }
      const prior = suites.get(suiteId);
      if (
        id
          ? !prior || input.expectedSnapshotId !== prior.snapshotId
          : input.expectedSnapshotId !== null
      )
        throw new Error(
          "This suite changed in another session. Compare the current suite with your changes. Then load the current suite, or apply your changes to it again.",
        );
      snapshots.put(snapshot.id, snapshot);
      const suite: EvaluationSuite = {
        id: suiteId,
        snapshotId: snapshot.id,
        title,
        memberCount: members.length,
        baselineOperationId: prior?.snapshotId === snapshot.id ? prior.baselineOperationId : null,
        updatedAt: new Date().toISOString(),
      };
      suites.put(suite.id, suite);
      journal.put("collection_save_actions", actionId, { requestHash, result: suite });
      suites.project(suite.id, suite, `${title} ${snapshot.description}`, "ready", suite.updatedAt);
      return suite;
    });
  } finally {
    journal.close();
  }
}

export async function readSuiteSnapshot(root: string, id: string) {
  hash(id);
  const journal = await OperationJournal.open(root);
  try {
    return repositories(journal).snapshots.require(id);
  } finally {
    journal.close();
  }
}

export async function listSuites(root: string, params = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    return repositories(journal).suites.page({
      q: params.get("q") ?? "",
      page: Number(params.get("page")),
      limit: Number(params.get("limit")),
    });
  } finally {
    journal.close();
  }
}

export async function readSuite(root: string, id: string, params = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    const { suites, snapshots } = repositories(journal),
      suite = suites.require(id),
      snapshot = snapshots.require(suite.snapshotId);
    const limit = Math.min(50, Math.max(1, Math.floor(Number(params.get("limit")) || 20)));
    const pages = Math.max(1, Math.ceil(snapshot.members.length / limit)),
      page = Math.min(pages, Math.max(1, Math.floor(Number(params.get("page")) || 1)));
    const memberNames: Record<string, string> = {};
    const definitions = new EvalDefinitionStore(root);
    for (let offset = 0; offset < snapshot.members.length; offset += 25) {
      const names = await Promise.all(
        snapshot.members.slice(offset, offset + 25).map(async (member) => {
          const catalog = journal.read<import("../../contracts/src/catalog.js").EvaluationSummary>(
            "catalog_evaluations",
            member.revisionId,
          );
          return [
            member.revisionId,
            catalog?.title ??
              (await definitions.readExecutableRevision(member.revisionId)).publicTask.title,
          ] as const;
        }),
      );
      Object.assign(memberNames, Object.fromEntries(names));
    }
    return {
      suite,
      description: snapshot.description,
      memberNames,
      members: {
        total: snapshot.members.length,
        limit,
        pages,
        page,
        items: snapshot.members.slice((page - 1) * limit, page * limit).map((member) => ({
          ...member,
          evaluation: journal.read<import("../../contracts/src/catalog.js").EvaluationSummary>(
            "catalog_evaluations",
            member.revisionId,
          ),
        })),
      },
    };
  } finally {
    journal.close();
  }
}

export async function setSuiteBaseline(
  root: string,
  id: string,
  operationId: string,
  expectedSnapshotId: string,
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const { suites, snapshots } = repositories(journal),
        suite = suites.require(id);
      if (suite.snapshotId !== expectedSnapshotId)
        throw new Error("Collection changed; reload before selecting a baseline");
      const status = journal.read<{ manifest: RunOperationManifest; finished: boolean }>(
        "operations",
        operationId,
      );
      const snapshot = snapshots.require(suite.snapshotId);
      if (
        !status?.finished ||
        hashJson(
          status.manifest.evals
            .map((item) => ({
              revisionId: item.id,
              validationRecordHash: item.validationRecordHash,
            }))
            .sort((a, b) => compareCodeUnits(a.revisionId, b.revisionId)),
        ) !==
          hashJson(
            [...snapshot.members].sort((a, b) => compareCodeUnits(a.revisionId, b.revisionId)),
          )
      )
        throw new Error(
          "Select a finished run from this exact collection snapshot; partial outcomes remain partial",
        );
      const next = {
        ...suite,
        baselineOperationId: operationId,
        updatedAt: new Date().toISOString(),
      };
      suites.put(id, next);
      suites.project(id, next, next.title, "ready", next.updatedAt);
      return next;
    });
  } finally {
    journal.close();
  }
}
