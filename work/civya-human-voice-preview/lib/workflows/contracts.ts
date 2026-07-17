export const WORKFLOW_KEYS = [
  "urgent_notice_response",
  "payment_plan_navigation",
  "document_readiness",
  "reminders_follow_through",
  "human_partner_handoff",
] as const;

export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

export type WorkflowActorType = "resident" | "staff" | "service" | "provider";

export interface WorkflowDefinition {
  key: WorkflowKey;
  version: string;
  displayName: string;
  initialState: string;
  transitions: Readonly<Record<string, readonly string[]>>;
  nextActions: Readonly<Record<string, string>>;
  authoritativeStates: readonly string[];
  terminalStates: readonly string[];
  completionAuthority: string;
}

export interface WorkflowInstance {
  id: string;
  tenantId: string;
  caseId: string;
  workflowKey: WorkflowKey;
  workflowVersion: string;
  sourceVersion: string;
  ruleVersion: string;
  contentVersion: string;
  state: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthoritativeEvidence {
  evidenceId: string;
  source: string;
  sourceRecordId: string;
  observedAt: string;
  status: string;
  reversible: boolean;
}

export interface TransitionRequest {
  expectedVersion: number;
  nextState: string;
  actorType: WorkflowActorType;
  idempotencyKey: string;
  correlationId: string;
  reasonCode: string;
  evidence?: AuthoritativeEvidence;
  now?: string;
}

export interface TransitionResult {
  instance: WorkflowInstance;
  nextAction: DeterministicNextAction;
  evidence?: AuthoritativeEvidence;
}

export interface DeterministicNextAction {
  workflowKey: WorkflowKey;
  workflowVersion: string;
  state: string;
  action: string;
  sourceVersion: string;
  ruleVersion: string;
  contentVersion: string;
  reasonCodes: readonly string[];
  requiresAuthoritativeEvidence: boolean;
}
