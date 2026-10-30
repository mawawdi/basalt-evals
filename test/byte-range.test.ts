import assert from "node:assert/strict";
import test from "node:test";
import { rangeResponse } from "../packages/operator/src/byte-range.js";

const bytes = new TextEncoder().encode("0123456789");
async function served(range: string | null) {
  const response = rangeResponse(bytes, range, "video/mp4");
  return {
    status: response.status,
    range: response.headers.get("Content-Range"),
    accept: response.headers.get("Accept-Ranges"),
    body: await response.text(),
  };
}

test("a recording answers byte ranges, so a person can seek in the video", async () => {
  assert.deepEqual(await served(null), {
    status: 200,
    range: null,
    accept: "bytes",
    body: "0123456789",
  });
  assert.deepEqual(await served("bytes=2-4"), {
    status: 206,
    range: "bytes 2-4/10",
    accept: "bytes",
    body: "234",
  });
  assert.deepEqual((await served("bytes=7-")).body, "789", "an open range runs to the end");
  assert.deepEqual((await served("bytes=-3")).body, "789", "a suffix range is the last bytes");
  assert.deepEqual((await served("bytes=8-99")).range, "bytes 8-9/10", "the end is clamped");
  assert.deepEqual(await served("bytes=10-"), {
    status: 416,
    range: "bytes */10",
    accept: "bytes",
    body: "",
  });
  assert.equal((await served("bytes=0-1,4-5")).status, 200, "several ranges get the whole file");
});
