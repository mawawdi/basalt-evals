import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { rectanglesOverlap, validRectangle } from "../packages/contracts/src/execution.js";
import { replaceRegion } from "../packages/studio-runner/src/image-controls.js";

function gradient(width: number, height: number, blue: number) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      image.data.set([x + 10, y + 30, blue, 255], (y * width + x) * 4);
  return { bytes: PNG.sync.write(image), mediaType: "image/png" as const };
}

test("a region fill copies the same rectangle from the frame before the action", () => {
  const frame = gradient(12, 8, 70);
  const before = gradient(12, 8, 140);
  const region = { x: 2, y: 3, width: 4, height: 2 };
  const output = PNG.sync.read(
    replaceRegion({ frame, region, fill: { kind: "pixels", frame: before } }),
  );
  assert.deepEqual([output.width, output.height], [12, 8], "The frame keeps native dimensions");
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) {
      const inside = x >= 2 && x < 6 && y >= 3 && y < 5;
      const offset = (y * 12 + x) * 4;
      assert.deepEqual(
        [...output.data.subarray(offset, offset + 4)],
        [x + 10, y + 30, inside ? 140 : 70, 255],
      );
    }
  const black = PNG.sync.read(replaceRegion({ frame, region, fill: { kind: "black" } }));
  assert.deepEqual(
    [...black.data.subarray((3 * 12 + 2) * 4, (3 * 12 + 2) * 4 + 4)],
    [0, 0, 0, 255],
  );
  assert.deepEqual([...black.data.subarray(0, 4)], [10, 30, 70, 255]);
});

test("a region fill accepts JPEG frames and refuses mismatched or outside regions", () => {
  const rgba = Buffer.alloc(16 * 8 * 4, 200);
  const encoded = jpeg.encode({ data: rgba, width: 16, height: 8 }, 90).data;
  const frame = { bytes: Buffer.from(encoded), mediaType: "image/jpeg" as const };
  const output = PNG.sync.read(
    replaceRegion({ frame, region: { x: 0, y: 0, width: 2, height: 2 }, fill: { kind: "black" } }),
  );
  assert.deepEqual([output.width, output.height], [16, 8]);
  assert.throws(
    () =>
      replaceRegion({
        frame,
        region: { x: 0, y: 0, width: 2, height: 2 },
        fill: { kind: "pixels", frame: gradient(12, 8, 1) },
      }),
    /other dimensions/,
  );
  assert.throws(
    () =>
      replaceRegion({
        frame,
        region: { x: 15, y: 0, width: 2, height: 2 },
        fill: { kind: "black" },
      }),
    /outside the frame/,
  );
});

test("rectangles use whole pixels inside their bounds", () => {
  assert.ok(validRectangle({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }));
  for (const invalid of [
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 1, height: 1, extra: 1 },
  ])
    assert.ok(!validRectangle(invalid, { width: 1, height: 1 }));
  assert.ok(
    rectanglesOverlap({ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 2 }),
  );
  assert.ok(
    !rectanglesOverlap({ x: 0, y: 0, width: 2, height: 2 }, { x: 2, y: 0, width: 2, height: 2 }),
  );
});
