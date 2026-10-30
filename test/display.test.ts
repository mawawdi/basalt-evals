import assert from "node:assert/strict";
import test from "node:test";
import { elapsedDuration, formatMoney } from "../packages/contracts/src/display.js";

test("elapsed measurements and money keep readable, consistent precision", () => {
  assert.equal(elapsedDuration(1000), "1 second");
  assert.equal(elapsedDuration(61000), "1 minute 1 second");
  assert.equal(elapsedDuration(3661000), "1 hour 1 minute 1 second");
  assert.equal(formatMoney(0.0081), "$0.0081");
  assert.equal(formatMoney(1), "$1.00");
  assert.equal(formatMoney(null), "Not yet known");
  assert.equal(formatMoney(0.00001), "< $0.0001");
});
