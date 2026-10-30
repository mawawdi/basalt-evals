import type { LaunchAuthorizationStatus } from "../../../../dist/packages/contracts/src/launch.js";
import { ApiError, read } from "./api";
import { authorizeLaunch } from "./launch-preview";

export interface LaunchAttempt {
  previewId: string;
  ceilingUsd: number;
}

export function isLaunchAttempt(value: unknown): value is LaunchAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.previewId === "string" &&
    /^[a-f0-9]{64}$/u.test(attempt.previewId) &&
    typeof attempt.ceilingUsd === "number" &&
    Number.isFinite(attempt.ceilingUsd) &&
    attempt.ceilingUsd >= 0
  );
}

/** Unknown requests retain their original work and limit until the same identity is recovered. */
export async function startLaunchAttempt(identity: string, attempt: LaunchAttempt) {
  try {
    return {
      kind: "started" as const,
      ...(await authorizeLaunch(identity, attempt.previewId, attempt.ceilingUsd)),
    };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
      // A definitive first-response rejection may still have created the run. Inspect it before
      // allowing a new authorization; failures to inspect remain unresolved.
      const saved = await read<LaunchAuthorizationStatus | null>(
        `/api/launch-authorizations/${identity}`,
      );
      if (
        saved?.operationId &&
        saved.previewId === attempt.previewId &&
        saved.ceilingUsd === attempt.ceilingUsd
      )
        return { kind: "started" as const, operationId: saved.operationId };
      if (saved === null) return { kind: "rejected" as const, error: cause.message };
    }
    throw cause;
  }
}
