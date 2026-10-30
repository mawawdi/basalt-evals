import { createOperationApi } from "../../../../../dist/packages/operator/src/api.js";
import { repositoryRoot } from "../../../lib/data";
import { assertLocalRequest } from "../../../../../dist/packages/operator/src/http-origin.js";
import { matchesWorkspace } from "../../../../../dist/packages/operator/src/workspace.js";
export const runtime = "nodejs";
const handle = (request: Request) => createOperationApi({ root: repositoryRoot() })(request);
export const GET = handle;
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
  } catch {
    return Response.json({ error: "A local workspace request is required." }, { status: 403 });
  }
  try {
    if (!(await matchesWorkspace(repositoryRoot(), request))) {
      return Response.json(
        { error: "This workspace has changed. Reload the page before saving or starting work." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return Response.json(
      { error: "The local workspace could not be opened. Reload the page and try again." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return handle(request);
}
