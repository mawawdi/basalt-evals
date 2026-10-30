import type { LaunchSelection, LaunchPreview, BudgetSummary } from "./execution.js";
import type { AssessmentSelection, AssessmentPreview } from "./assessments.js";
import type { RunQuote } from "../../model-client/src/quote.js";
import type { RegressionReference } from "./comparisons.js";
import type { RecheckPart, RecheckSelection } from "./recheck.js";

export type LaunchIntent =
  | { kind: "reference"; selection: { revisionId: string; gradingModelId: string } }
  | {
      kind: "regression";
      selection: {
        referenceId: string;
        configuration: Omit<LaunchSelection, "sources">;
        presentation: "still" | "sequence" | "grounded-sequence";
      };
    }
  | { kind: "evaluation"; selection: LaunchSelection }
  /** One paid part of a recheck of saved builds against a revision of their evaluation. */
  | { kind: "recheck"; selection: RecheckSelection & { part: RecheckPart } }
  | { kind: "sensitivity"; selection: Omit<AssessmentSelection, "revisionId"> }
  | {
      kind: "replay" | "public_development";
      selection: { operationId: string; subjectId: string; passes: number };
    }
  | {
      kind: "repair";
      selection: {
        operationId: string;
        subjectId: string;
        modelId: string;
        gradingModelId: string | null;
        attempts: number;
        passes: number;
        publicFeedbackId: string | null;
      };
    }
  | { kind: "research"; selection: { experimentId: string; gradingModelId: string } }
  | {
      kind: "exemplar_comparison";
      selection: import("./exemplars.js").ExemplarComparisonSelection;
    }
  /** One request about the flagged criteria of an evaluation version. */
  | { kind: "explain_failures"; selection: { revisionId: string; modelId: string } }
  /** The code-only run of the study builds under one plan of a preparation parity study. */
  | { kind: "parity"; selection: { studyId: string; revisionId: string } };

export interface OperationLaunchPreview {
  costScope: string;
  parentOperationIds: string[];
  regression: RegressionReference | null;
  id: string;
  kind: LaunchIntent["kind"];
  title: string;
  budget: BudgetSummary;
  quote: RunQuote | null;
  humanQuestions: number;
  evaluation: LaunchPreview | null;
  assessment: AssessmentPreview | null;
  comparison: import("./exemplars.js").ExemplarComparisonPreview | null;
  reference: { revisionId: string } | null;
  /** The recheck part of this launch, or null. Authorization records it for later reads. */
  recheck: (RecheckSelection & { part: RecheckPart }) | null;
  studio: LaunchPreview["studio"] | null;
  timeLimits: {
    readinessMs: number;
    longestStudioTrialMs: number | null;
  };
  binding: {
    kind: "workflow" | "run" | "assessment" | "reference" | "exemplar_comparison" | "explanation";
    id: string;
  };
}

export interface LaunchAuthorizationStatus {
  previewId: string;
  ceilingUsd: number;
  operationId: string | null;
}
export interface OperationContext {
  costScope: string;
  previewId: string;
  kind: LaunchIntent["kind"];
  title: string;
  parentOperationIds: string[];
  regressionId: string | null;
}
export interface LineageSpending {
  operations: Array<{
    operationId: string;
    billedUsd: number | null;
    reservedUsd: number | null;
    deleted: boolean;
  }>;
  billedUsd: number;
  reservedUsd: number;
  unavailable: number;
}
export interface OperationAuthorization {
  previewId: string;
  ceilingUsd: number;
  idempotencyKey: string;
}
export type OperationCommandInput =
  | { kind: "stop"; reason: string }
  | { kind: "resume" | "reconcile" }
  | { kind: "budget"; ceilingUsd: number }
  | { kind: "amend"; previewId: string };
