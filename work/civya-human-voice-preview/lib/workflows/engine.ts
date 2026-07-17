import { CivyaOperationalError } from "@/lib/operations/errors";
import type {
  DeterministicNextAction,
  TransitionRequest,
  TransitionResult,
  WorkflowInstance,
  WorkflowKey,
} from "./contracts";
import { getWorkflowDefinition } from "./definitions";

export function createWorkflowInstance(input: {
  id: string;
  tenantId: string;
  caseId: string;
  workflowKey: WorkflowKey;
  sourceVersion: string;
  ruleVersion: string;
  contentVersion: string;
  now?: string;
}): WorkflowInstance {
  const definition = getWorkflowDefinition(input.workflowKey);
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    tenantId: input.tenantId,
    caseId: input.caseId,
    workflowKey: input.workflowKey,
    workflowVersion: definition.version,
    sourceVersion: input.sourceVersion,
    ruleVersion: input.ruleVersion,
    contentVersion: input.contentVersion,
    state: definition.initialState,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function getDeterministicNextAction(instance: WorkflowInstance): DeterministicNextAction {
  const definition = getWorkflowDefinition(instance.workflowKey);
  if (definition.version !== instance.workflowVersion) {
    throw new CivyaOperationalError({
      code: "workflow_version_mismatch",
      title: "Workflow version mismatch",
      detail: "The saved workflow does not match the active approved definition.",
      retryable: false,
      nextAction: "Pause this workflow and assign a staff migration review.",
    });
  }
  const action = definition.nextActions[instance.state];
  if (!action) {
    throw new CivyaOperationalError({
      code: "workflow_state_unknown",
      title: "Unknown workflow state",
      detail: `State ${instance.state} is not part of ${definition.version}.`,
      retryable: false,
      nextAction: "Pause the workflow and review its state history.",
    });
  }
  return {
    workflowKey: instance.workflowKey,
    workflowVersion: instance.workflowVersion,
    state: instance.state,
    action,
    sourceVersion: instance.sourceVersion,
    ruleVersion: instance.ruleVersion,
    contentVersion: instance.contentVersion,
    reasonCodes: [`workflow:${instance.workflowKey}`, `state:${instance.state}`],
    requiresAuthoritativeEvidence: definition.authoritativeStates.includes(instance.state),
  };
}

export function transitionWorkflow(
  current: WorkflowInstance,
  request: TransitionRequest,
): TransitionResult {
  if (request.expectedVersion !== current.rowVersion) {
    throw new CivyaOperationalError({
      code: "workflow_concurrent_update",
      title: "Workflow changed",
      detail: "Another action updated this workflow before the current request could commit.",
      retryable: true,
      nextAction: "Reload the current workflow and retry with the same idempotency key.",
    });
  }
  if (!request.idempotencyKey.trim() || !request.correlationId.trim() || !request.reasonCode.trim()) {
    throw new CivyaOperationalError({
      code: "workflow_transition_context_missing",
      title: "Transition context missing",
      detail: "A workflow mutation requires idempotency, correlation, and reason context.",
      retryable: false,
      nextAction: "Correct the caller and do not change workflow state.",
    });
  }

  const definition = getWorkflowDefinition(current.workflowKey);
  const allowed = definition.transitions[current.state] ?? [];
  if (!allowed.includes(request.nextState)) {
    throw new CivyaOperationalError({
      code: "workflow_transition_invalid",
      title: "Transition not allowed",
      detail: `${current.state} cannot transition to ${request.nextState} in ${definition.version}.`,
      retryable: false,
      nextAction: "Use an approved transition or create an owned staff exception.",
    });
  }
  if (definition.authoritativeStates.includes(request.nextState) && !request.evidence) {
    throw new CivyaOperationalError({
      code: "authoritative_evidence_required",
      title: "Authoritative confirmation required",
      detail: `State ${request.nextState} requires evidence from ${definition.completionAuthority}.`,
      retryable: true,
      nextAction: "Keep the workflow pending and reconcile an authoritative source.",
    });
  }

  const now = request.now ?? new Date().toISOString();
  const instance: WorkflowInstance = {
    ...current,
    state: request.nextState,
    rowVersion: current.rowVersion + 1,
    updatedAt: now,
  };
  return {
    instance,
    nextAction: getDeterministicNextAction(instance),
    evidence: request.evidence,
  };
}
