export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
let workspace: string | null = null;
export function setWorkspaceIdentity(identity: string) {
  workspace = identity;
}
async function responseValue<T>(response: Response, fallback: string): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      `${fallback} The server returned an unreadable response. Try again.`,
      response.status,
    );
  }
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value ? value.error : null;
    throw new ApiError(typeof error === "string" ? error : fallback, response.status);
  }
  return value as T;
}
// A request that gets no answer rejects with the browser's own words, for example "Failed to
// fetch". The console says what happened instead. An abort stays an abort.
export async function request(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError("The connection stopped before Basalt answered.", 0);
  }
}
export async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await request(url, { cache: "no-store", signal });
  return responseValue<T>(response, "Basalt could not load this information.");
}

export async function action<T>(
  url: string,
  name: string,
  body?: unknown,
  keepalive = false,
): Promise<T> {
  if (!workspace) throw new ApiError("Reload the page to open the current workspace.", 409);
  const response = await request(url, {
    method: "POST",
    keepalive,
    headers: {
      "Content-Type": "application/json",
      "X-Basalt-Action": name,
      "X-Basalt-Workspace": workspace,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return responseValue<T>(response, "Basalt could not complete the action.");
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export { formatMoney } from "../../../../dist/packages/contracts/src/display.js";
