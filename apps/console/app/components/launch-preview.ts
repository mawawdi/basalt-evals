"use client";
import { useEffect, useState } from "react";
import type {
  LaunchIntent,
  LaunchAuthorizationStatus,
  OperationLaunchPreview,
} from "../../../../dist/packages/contracts/src/launch.js";
import { action, read, message, ApiError } from "./api";

/** Free, debounced previews; late responses cannot replace a newer selection. */
export function useLaunchPreview(intent: LaunchIntent | null) {
  const selection = JSON.stringify(intent);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    selection: string;
    preview: OperationLaunchPreview | null;
    loading: boolean;
    error: string;
  }>({ selection: "", preview: null, loading: false, error: "" });
  useEffect(() => {
    let active = true;
    setState({ selection, preview: null, loading: selection !== "null", error: "" });
    if (selection === "null") return;
    const timer = setTimeout(() => {
      void action<OperationLaunchPreview>(
        "/api/launch-previews",
        "preview_launch",
        JSON.parse(selection),
      )
        .then((preview) => {
          if (active) setState({ selection, preview, loading: false, error: "" });
        })
        .catch((cause) => {
          if (active) setState({ selection, preview: null, loading: false, error: message(cause) });
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selection, retry]);
  return {
    ...(state.selection === selection
      ? state
      : { preview: null, loading: selection !== "null", error: "" }),
    retry: () => setRetry((value) => value + 1),
  };
}

/** Recover only the exact authorization shown before dispatch; changed inputs need a new intent. */
export async function authorizeLaunch(
  idempotencyKey: string,
  previewId: string,
  ceilingUsd: number,
) {
  const saved = await read<LaunchAuthorizationStatus | null>(
    "/api/launch-authorizations/" + idempotencyKey,
  );
  if (saved && (saved.previewId !== previewId || saved.ceilingUsd !== ceilingUsd))
    throw new ApiError(
      "This setup already started a run with different evaluations or a different spending limit. Open that run before you start another.",
      409,
    );
  if (saved?.operationId) return { operationId: saved.operationId };
  return action<{ operationId: string }>("/api/operations", "authorize_operation", {
    previewId,
    ceilingUsd,
    idempotencyKey,
  });
}
