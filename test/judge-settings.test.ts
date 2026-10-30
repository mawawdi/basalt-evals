import assert from "node:assert/strict";
import test from "node:test";
import { MAX_JUDGE_SAMPLES, judgeSettings } from "../packages/contracts/src/judge-settings.js";

test("Judge settings accept 1 to 5 samples and the two groupings, and nothing else.", () => {
  assert.equal(MAX_JUDGE_SAMPLES, 5);
  for (const grouping of ["shared", "per_criterion"] as const)
    for (const samples of [1, MAX_JUDGE_SAMPLES])
      assert.deepEqual(judgeSettings({ samples, grouping }), { samples, grouping });
  for (const value of [
    { samples: 0, grouping: "shared" },
    { samples: 6, grouping: "shared" },
    { samples: 1.5, grouping: "shared" },
    { samples: 1, grouping: "each" },
    { samples: 1 },
    { samples: 1, grouping: "shared", seed: 1 },
    null,
  ])
    assert.throws(() => judgeSettings(value));
});
