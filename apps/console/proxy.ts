import { NextResponse, type NextRequest } from "next/server";
import { assertLocalRequest } from "../../dist/packages/operator/src/http-origin.js";

export function proxy(request: NextRequest) {
  try {
    assertLocalRequest(request);
    return NextResponse.next();
  } catch {
    return new Response("The console accepts only local requests. Open the console on this Mac.", {
      status: 403,
    });
  }
}
