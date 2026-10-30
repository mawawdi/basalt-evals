"use client";

import { useEffect, useState, type ReactNode } from "react";
import { setWorkspaceIdentity } from "./api";
import { Loading } from "./ui";
import { draftMemory } from "./draft-memory";
import { themeKey } from "./theme";

/** Mount recovery-aware forms only after the current workspace is established. */
export default function WorkspaceSession({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const [readyIdentity, setReadyIdentity] = useState<string | null>(null);
  useEffect(() => {
    for (const kind of ["localStorage", "sessionStorage"] as const) {
      try {
        const storage = window[kind];
        // Every tab owns its session recovery. Another tab may already have reset
        // shared local storage while this tab still contains the old run selection.
        if (storage.getItem("basalt-workspace") !== identity) {
          draftMemory.clear();
          for (const key of Object.keys(storage)) {
            if (key.startsWith("basalt") && key !== "basalt-run-preferences" && key !== themeKey) {
              storage.removeItem(key);
            }
          }
          storage.setItem("basalt-workspace", identity);
        }
      } catch {
        // Browser storage is optional; saved work remains on the server.
      }
    }
    setWorkspaceIdentity(identity);
    setReadyIdentity(identity);
  }, [identity]);
  return readyIdentity === identity ? children : <Loading label="Opening workspace" />;
}
