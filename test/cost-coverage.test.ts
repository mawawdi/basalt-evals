import assert from "node:assert/strict";
import test from "node:test";
import { costCoverage, valueRange } from "../packages/contracts/src/cost-coverage.js";
import type { BenchmarkReport } from "../packages/contracts/src/benchmarks.js";

type Row = BenchmarkReport["rows"][number];
type Build = Row["cases"][number]["builds"][number];
type Outcome = Build["marks"][number]["outcome"];

const build = (
  number: number,
  outcomes: Outcome[],
  charge: Build["breakdown"]["charge"],
  buildMs: number | null,
  notReached = false,
) =>
  ({
    subjectId: `s-${number}`,
    number,
    marks: outcomes.map((outcome) => ({ outcome })),
    breakdown: { charge, time: { buildMs } },
    parentSubjectId: null,
    notReached,
  }) as unknown as Build;

test("each build gives its met share with bounds for open answers, its charge and its time", () => {
  const row = {
    id: "row",
    modelName: "Model",
    harnessId: "production",
    harnessTitle: "Production",
    cases: [
      {
        evaluationId: "e",
        builds: [
          // Not enough evidence is an answer, so it is not met in both bounds. A scored answer
          // has no pass mark, so it is not in the share.
          build(
            1,
            ["met", "met", "insufficient", "rejected", "scored"],
            {
              builderUsd: 0.25,
              judgeUsd: 0.05,
              pendingUsd: 0,
            },
            60_000,
          ),
          // Missing and split answers are open: the share is a range until they are known.
          build(
            2,
            ["met", "missing", "split", "rejected"],
            {
              builderUsd: 0.5,
              judgeUsd: null,
              pendingUsd: 0.1,
            },
            null,
          ),
          build(3, ["scored"], { builderUsd: null, judgeUsd: null, pendingUsd: 0 }, 1_000),
          // A build that the run did not reach never started, so it has no point.
          build(4, ["missing"], { builderUsd: null, judgeUsd: null, pendingUsd: 0 }, null, true),
        ],
      },
    ],
  } as unknown as Row;
  const [result] = costCoverage({ rows: [row] });
  assert.deepEqual(
    result!.builds.map((item) => [
      item.number,
      item.answers,
      item.met,
      item.chargeUsd,
      item.pendingUsd,
      item.buildMs,
    ]),
    [
      [1, { met: 2, open: 0, planned: 4 }, { lower: 0.5, upper: 0.5 }, 0.3, 0, 60_000],
      [2, { met: 1, open: 2, planned: 4 }, { lower: 0.25, upper: 0.75 }, 0.5, 0.1, null],
      [3, { met: 0, open: 0, planned: 0 }, null, null, 0, 1_000],
    ],
  );
  assert.deepEqual(valueRange([0.5, null, 0.25]), { low: 0.25, high: 0.5 });
  assert.equal(valueRange([null]), null);
});
