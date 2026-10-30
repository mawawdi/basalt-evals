import { randomUUID } from "node:crypto";
import { OperationJournal } from "../../artifact-store/src/journal.js";

/** A fresh journal is a fresh workspace; browser recovery must never cross that boundary. */
export async function workspaceIdentity(root: string): Promise<string> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const identity = journal.read<string>("workspace", "identity");
      if (identity) return identity;
      const created = randomUUID();
      journal.put("workspace", "identity", created);
      return created;
    });
  } finally {
    journal.close();
  }
}

export async function matchesWorkspace(root: string, request: Request): Promise<boolean> {
  return request.headers.get("X-Basalt-Workspace") === (await workspaceIdentity(root));
}
