import assert from "node:assert/strict";
import test from "node:test";
import { completedReportReason } from "../packages/operator/src/report-reason.js";

const manifest = (criterionOutcomes: number, unreviewedClaims: string[]) =>
  ({ planned: { criterionOutcomes }, unreviewedClaims }) as Parameters<
    typeof completedReportReason
  >[1];

test("the end of a run says what no person confirmed, in plain words", () => {
  assert.equal(
    completedReportReason(true, manifest(4, [])),
    null,
    "A run with every claim confirmed needs no reason",
  );
  assert.equal(
    completedReportReason(false, manifest(4, ["criterion-1"])),
    "Some planned work did not complete.",
  );
  assert.equal(
    completedReportReason(
      true,
      manifest(4, [
        "Basalt did not test these checks on reference builds or compare their answers with answers from people.",
      ]),
    ),
    "All planned work completed. These checks haven’t been tried on reference builds or compared with people’s answers yet.",
  );
  assert.equal(
    completedReportReason(
      true,
      manifest(4, [
        "acceptance-threshold-unresolved:criterion-2",
        "control-distinction:negative-1",
        "control-distinction:negative-2",
        "criterion-3",
      ]),
    ),
    "All planned work completed. 1 criterion has a score but no pass mark. No one has confirmed yet that the judge tells 2 broken reference builds apart. No one has reviewed the answers to 1 criterion yet.",
  );
});

test("a run with no planned answers, such as a Studio replay, mentions no review", () => {
  assert.equal(
    completedReportReason(
      true,
      manifest(0, [
        "Basalt did not test these checks on reference builds or compare their answers with answers from people.",
      ]),
    ),
    null,
  );
});
