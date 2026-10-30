import type { RunOperationEvent } from "./execution.js";
import type { analyzeExperiment } from "../../experiments/src/analysis.js";

/** Published report shape shared by the operator, CLI and console. */
export interface ExperimentAnalysisReport {
  id: string;
  operationId: string;
  manifestHash: string;
  eventHead: string | null;
  evidenceHashes: string[];
  reviewRecordIds: string[];
  activeReviewMs: number;
  selections: Array<{ hash: string; receipt: unknown }>;
  selectionAuthority: { operationId: string; receiptHash: string } | null;
  repairPopulation: Array<{
    evalId: string;
    outcome: "retained_parent" | "discovered_parent" | "inconclusive";
    parentId: string | null;
    discovery: { operationId: string; receiptHash: string } | null;
  }> | null;
  executionComplete: boolean;
  evidenceComplete: boolean;
  spending: {
    billedUsd: number;
    retainedLiabilityUsd: number;
    recordedActions: number;
    billedActions: number;
    unresolvedActions: number;
  };
  failures: Array<{
    stage: RunOperationEvent["stage"];
    unitId: string | null;
    kind: RunOperationEvent["kind"];
    reason: string | null;
    receipt: string;
  }>;
  times: Array<{
    stage: RunOperationEvent["stage"];
    unitId: string | null;
    startedAt: string;
    endedAt: string | null;
    elapsedMs: number | null;
  }>;
  analysis: ReturnType<typeof analyzeExperiment>;
}

/**
 * The analysis as the console shows it: the sealed report, and the authored statement and number
 * of each criterion of its evaluations. The sealed report and its hash do not include them.
 */
export type ExperimentAnalysisView = ExperimentAnalysisReport & {
  criteria: Array<{ evalId: string; criterionId: string; number: number; statement: string }>;
};
