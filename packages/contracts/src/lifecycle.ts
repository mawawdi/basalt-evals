type OperationState = "queued" | "running" | "blocked" | "stopping" | "stopped" | "completed";
type OperationCommand = "stop" | "resume" | "reconcile" | "amend" | "budget";
interface OperationCapability {
  allowed: boolean;
  reason: string;
}
export interface OperationLifecycle {
  state: OperationState;
  phase: "readiness" | "preparation" | "controls" | "explanation" | "execution" | "complete";
  blocker: string | null;
  ownerActive: boolean;
  capabilities: Record<OperationCommand | "review" | "setup", OperationCapability>;
}

/** Stage facts describe evidence; lifecycle policy alone decides operator actions. */
interface LifecycleFacts {
  phase: OperationLifecycle["phase"];
  finished: boolean;
  stopped: boolean;
  ownerActive: boolean;
  ownerInterrupted: boolean;
  blocker: string | null;
  pendingBilling: boolean;
  hasExecution: boolean;
  hasWorkflow: boolean;
  hasBudget: boolean;
}

export function operationLifecycle(facts: LifecycleFacts): OperationLifecycle {
  const { finished, stopped, ownerActive, hasWorkflow, phase } = facts;
  const blocker =
    facts.blocker ??
    (facts.ownerInterrupted
      ? "The Basalt worker stopped unexpectedly. Select Resume to continue. Basalt examines the saved requests and evidence first."
      : facts.pendingBilling && !ownerActive
        ? "A saved request has a pending charge. Basalt cannot send it again. Select Check payment status."
        : null);
  return {
    state: finished
      ? "completed"
      : stopped
        ? ownerActive
          ? "stopping"
          : "stopped"
        : ownerActive
          ? "running"
          : blocker
            ? "blocked"
            : "queued",
    phase,
    blocker,
    ownerActive,
    capabilities: {
      setup: {
        allowed: phase === "readiness" && !ownerActive && !!blocker,
        reason: "Correct the local setup before you continue the run.",
      },
      stop: {
        allowed: !finished && !stopped,
        reason: "Basalt stops the run after it saves the current request.",
      },
      resume: {
        allowed: !finished && !ownerActive && !facts.pendingBilling,
        reason: facts.pendingBilling
          ? "Select Check payment status before you continue. Basalt will not send the saved request again."
          : "Basalt continues the run after it examines the saved requests, charges and evidence.",
      },
      reconcile: {
        allowed: !ownerActive && facts.pendingBilling,
        reason:
          "Basalt gets the status of each pending charge from the provider. It does not send a request again.",
      },
      amend: {
        allowed:
          hasWorkflow &&
          !ownerActive &&
          ["preparation", "controls"].includes(phase) &&
          (stopped || !!blocker),
        reason:
          "Basalt keeps the earlier inputs and charges. Then it starts a new attempt with the edited evaluation.",
      },
      budget: {
        allowed: facts.hasBudget && !ownerActive && !finished,
        reason: "Increase the spending limit of the run. Basalt keeps all earlier charges.",
      },
      review: { allowed: facts.hasExecution, reason: "Start a review of the available evidence." },
    },
  };
}
