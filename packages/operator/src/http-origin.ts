/** The console is a loopback reader, not an externally addressable file server. */
export function assertLocalRequest(request: Pick<Request, "url" | "headers">): void {
  const url = new URL(request.url);
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
  for (const host of [
    url.host,
    request.headers.get("host"),
    request.headers.get("x-forwarded-host"),
  ]) {
    if (host !== null && !local.test(host))
      throw new Error("The console accepts only local requests. Open the console on this Mac.");
  }
  const origin = request.headers.get("origin");
  // Next may normalize Request.url to localhost even when the browser reached
  // 127.0.0.1. The Host header is the origin the browser actually used.
  const browserOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (origin && origin !== browserOrigin)
    throw new Error(
      "The console does not accept requests from another origin. Open the console directly.",
    );
}
