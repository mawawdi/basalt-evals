/**
 * Serve stored bytes with HTTP byte ranges. A browser asks for a range when a person seeks in a
 * video. Without a 206 answer, the video plays from the start but cannot seek.
 */
export function rangeResponse(bytes: Uint8Array, range: string | null, mediaType: string) {
  const headers = {
    "Content-Type": mediaType,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  const size = bytes.length;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return new Response(new Uint8Array(bytes), { headers });
  // "bytes=-N" asks for the last N bytes.
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end)
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}
