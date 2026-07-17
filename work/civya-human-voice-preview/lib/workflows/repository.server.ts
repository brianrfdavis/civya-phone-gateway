import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { WORKFLOW_KEYS, type WorkflowKey } from "./contracts";
import { getWorkflowDefinition } from "./definitions";

if (typeof window !== "undefined") {
  throw new Error("The governed workflow repository is server-only.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9_.:-]{8,180}$/;
const SAFE_ACTION = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SENSITIVE_FIELD = /(?:^|[_-])(?:ssn|social.?security|email|e.?mail|address|street|postal|zip|phone|mobile|name|first.?name|last.?name|dob|birth|parcel|account|routing|card|cvv|cvc|pan|password|secret|token)(?:$|[_-])/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?:\D|$)/,
] as const;

const RESIDENT_START_CONTEXT = Object.freeze({
  channel: "web",
  purpose: "plan_navigation",
});

const RESIDENT_ACTION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "case.entitlement_confirmed:entitled": "durable_case_entitlement",
  "handoff.requested:handoff_created": "resident_requested_official_handoff",
  "handoff.open:provider_open": "resident_opened_official_provider",
});

export const VERIFIED_PERSISTED_WORKFLOW_SLICES = ["payment_plan_navigation"] as const;
export type VerifiedPersistedWorkflowSlice = (typeof VERIFIED_PERSISTED_WORKFLOW_SLICES)[number];

export type AuthenticatedWorkflowActor =
  | { type: "resident"; userId: string }
  | { type: "staff"; userId: string };

export type WorkflowMutationActor = AuthenticatedWorkflowActor
  | { type: "system" | "provider"; userId: null };

export interface WorkflowActionRecord {
  id: string;
  sequenceNumber: number;
  actionKey: string;
  fromState: string | null;
  toState: string;
  actorType: string;
  reasonCode: string;
  correlationId: string;
  completionEvidenceId: string | null;
  createdAt: string;
}

export interface WorkflowHandoffRecord {
  id: string;
  providerKey: string;
  destinationOrigin: string;
  browserState: "created" | "opened" | "returned" | "abandoned" | "expired";
  authoritativeState: "pending" | "confirmed" | "failed";
  rowVersion: number;
  expiresAt: string;
  updatedAt: string;
}

export interface WorkflowExceptionRecord {
  id?: string;
  type?: string;
  severity?: "low" | "normal" | "high" | "urgent";
  status: string;
  reasonCode?: string;
  redactedSummary?: string;
  assignedToAuthUserId?: string | null;
  rowVersion?: number;
  residentMessage?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GovernedWorkflowSnapshot {
  id: string;
  tenantId: string;
  residentId: string;
  caseId: string;
  workflowKey: WorkflowKey;
  definitionVersion: string;
  state: string;
  status: "active" | "paused" | "escalated" | "completed" | "cancelled";
  rowVersion: number;
  correlationId: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  nextAction: string;
  completionAuthority: string;
  actions: readonly WorkflowActionRecord[];
  handoffs: readonly WorkflowHandoffRecord[];
  exception: WorkflowExceptionRecord | null;
}

export interface StartWorkflowInput {
  actor: AuthenticatedWorkflowActor;
  caseId: string;
  workflowKey: WorkflowKey;
  correlationId: string;
  idempotencyKey: string;
  redactedContext?: Record<string, unknown>;
}

export interface AdvanceWorkflowInput {
  actor: WorkflowMutationActor;
  workflowInstanceId: string;
  expectedRowVersion: number;
  actionKey: string;
  toState: string;
  reasonCode: string;
  correlationId: string;
  idempotencyKey: string;
  redactedMetadata?: Record<string, unknown>;
  completionEvidenceId?: string | null;
}

export interface CompletionEvidenceInput {
  actor: { type: "staff"; userId: string } | { type: "service"; userId: null };
  workflowInstanceId: string;
  authorityType: "county_source" | "provider_webhook" | "staff_attestation" | "synthetic_test";
  assuranceScope: "synthetic" | "county_attested" | "provider_attested";
  authoritative: boolean;
  sourceRecordId?: string | null;
  providerEventId?: string | null;
  outcomeVerificationEventId?: string | null;
  evidenceSha256: string;
  redactedEvidence?: Record<string, unknown>;
  observedAt: string;
  idempotencyKey: string;
}

export interface RaiseWorkflowExceptionInput {
  actor: Exclude<WorkflowMutationActor, { type: "resident" }>;
  workflowInstanceId: string;
  expectedRowVersion: number;
  actionKey: string;
  exceptionType: string;
  severity: "low" | "normal" | "high" | "urgent";
  reasonCode: string;
  redactedSummary: string;
  assignedToAuthUserId?: string | null;
  correlationId: string;
  dedupeKey: string;
  idempotencyKey: string;
}

export interface WorkflowMutationResult {
  workflowInstanceId: string;
  state: string;
  status: string;
  rowVersion: number;
  duplicate: boolean;
  actionId?: string;
}

export interface CompletionEvidenceResult {
  completionEvidenceId: string;
  authoritative: boolean;
  assuranceScope: string;
  duplicate: boolean;
}

export interface WorkflowExceptionResult extends WorkflowMutationResult {
  exceptionId: string;
  exceptionStatus: string;
  assignedToAuthUserId: string | null;
}

export interface WorkflowRpcFailure {
  code?: string;
  message?: string;
}

export interface WorkflowRpcResult {
  data: unknown;
  error: WorkflowRpcFailure | null;
}

export type WorkflowRpcInvoker = (
  functionName: string,
  parameters: Record<string, unknown>,
) => Promise<WorkflowRpcResult>;

export class GovernedWorkflowRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly causeCode?: string,
  ) {
    super(publicWorkflowErrorMessage(code));
    this.name = "GovernedWorkflowRepositoryError";
  }
}

export class GovernedWorkflowRepository {
  constructor(private readonly invokeRpc: WorkflowRpcInvoker) {}

  async start(input: StartWorkflowInput): Promise<WorkflowMutationResult> {
    assertAuthenticatedActor(input.actor);
    assertUuid(input.caseId, "invalid_case_id");
    assertVerifiedSlice(input.workflowKey);
    assertMutationContext(input.correlationId, input.idempotencyKey);
    const redactedContext = input.actor.type === "resident"
      ? canonicalResidentStartContext(input.workflowKey, input.redactedContext)
      : validatedRedactedObject(input.redactedContext);
    const raw = await this.rpc("civya_service_start_governed_workflow", {
      p_actor_user_id: input.actor.userId,
      p_actor_type: input.actor.type,
      p_case_id: input.caseId,
      p_workflow_key: input.workflowKey,
      p_correlation_id: input.correlationId,
      p_redacted_context: redactedContext,
      p_idempotency_key: input.idempotencyKey,
    });
    return mapMutation(raw);
  }

  async read(input: {
    actor: AuthenticatedWorkflowActor;
    workflowInstanceId: string;
  }): Promise<GovernedWorkflowSnapshot> {
    assertAuthenticatedActor(input.actor);
    assertUuid(input.workflowInstanceId, "invalid_workflow_id");
    const raw = await this.rpc("civya_service_read_governed_workflow", {
      p_actor_user_id: input.actor.userId,
      p_actor_type: input.actor.type,
      p_workflow_instance_id: input.workflowInstanceId,
    });
    return mapSnapshot(raw);
  }

  async advance(input: AdvanceWorkflowInput): Promise<WorkflowMutationResult> {
    assertMutationActor(input.actor);
    assertUuid(input.workflowInstanceId, "invalid_workflow_id");
    assertRowVersion(input.expectedRowVersion);
    assertAction(input.actionKey);
    assertState(input.toState);
    assertReason(input.reasonCode);
    assertMutationContext(input.correlationId, input.idempotencyKey);
    const redactedMetadata = input.actor.type === "resident"
      ? canonicalResidentActionMetadata(input.actionKey, input.toState, input.reasonCode, input.redactedMetadata)
      : validatedRedactedObject(input.redactedMetadata);
    if (input.completionEvidenceId) assertUuid(input.completionEvidenceId, "invalid_completion_evidence_id");
    const raw = await this.rpc("civya_service_advance_governed_workflow", {
      p_actor_user_id: input.actor.userId,
      p_actor_type: input.actor.type,
      p_workflow_instance_id: input.workflowInstanceId,
      p_expected_row_version: input.expectedRowVersion,
      p_action_key: input.actionKey,
      p_to_state: input.toState,
      p_reason_code: input.reasonCode,
      p_correlation_id: input.correlationId,
      p_redacted_metadata: redactedMetadata,
      p_completion_evidence_id: input.completionEvidenceId ?? null,
      p_idempotency_key: input.idempotencyKey,
    });
    return mapMutation(raw);
  }

  async recordCompletionEvidence(input: CompletionEvidenceInput): Promise<CompletionEvidenceResult> {
    if (input.actor.type === "staff") {
      assertUuid(input.actor.userId, "invalid_actor_id");
    } else if (input.actor.type !== "service" || input.actor.userId !== null) {
      fail("invalid_evidence_actor");
    }
    if (!SHA256.test(input.evidenceSha256)) fail("invalid_evidence_digest");
    assertUuid(input.workflowInstanceId, "invalid_workflow_id");
    for (const [value, code] of [
      [input.sourceRecordId, "invalid_source_record_id"],
      [input.providerEventId, "invalid_provider_event_id"],
      [input.outcomeVerificationEventId, "invalid_outcome_event_id"],
    ] as const) {
      if (value) assertUuid(value, code);
    }
    assertMutationContext("evidence-context", input.idempotencyKey);
    const redactedEvidence = validatedRedactedObject(input.redactedEvidence);
    const observedAt = new Date(input.observedAt);
    if (Number.isNaN(observedAt.getTime())) fail("invalid_evidence_time");
    if (input.authoritative && (input.authorityType === "synthetic_test" || input.assuranceScope === "synthetic")) {
      fail("synthetic_evidence_not_authoritative");
    }
    const raw = await this.rpc("civya_service_record_completion_evidence", {
      p_actor_user_id: input.actor.userId,
      p_workflow_instance_id: input.workflowInstanceId,
      p_authority_type: input.authorityType,
      p_assurance_scope: input.assuranceScope,
      p_authoritative: input.authoritative,
      p_source_record_id: input.sourceRecordId ?? null,
      p_provider_event_id: input.providerEventId ?? null,
      p_outcome_verification_event_id: input.outcomeVerificationEventId ?? null,
      p_evidence_sha256: input.evidenceSha256,
      p_redacted_evidence: redactedEvidence,
      p_observed_at: observedAt.toISOString(),
      p_idempotency_key: input.idempotencyKey,
    });
    const row = objectValue(raw, "invalid_evidence_response");
    return {
      completionEvidenceId: uuidValue(row.completionEvidenceId, "invalid_evidence_response"),
      authoritative: row.authoritative === true,
      assuranceScope: stringValue(row.assuranceScope, "invalid_evidence_response"),
      duplicate: row.duplicate === true,
    };
  }

  async raiseException(input: RaiseWorkflowExceptionInput): Promise<WorkflowExceptionResult> {
    assertMutationActor(input.actor);
    if (!["staff", "system", "provider"].includes(input.actor.type)) {
      fail("resident_exception_actor_forbidden");
    }
    assertUuid(input.workflowInstanceId, "invalid_workflow_id");
    assertRowVersion(input.expectedRowVersion);
    assertAction(input.actionKey);
    assertAction(input.exceptionType);
    assertReason(input.reasonCode);
    if (!input.redactedSummary.trim() || input.redactedSummary.length > 500) fail("invalid_exception_summary");
    if (input.assignedToAuthUserId) assertUuid(input.assignedToAuthUserId, "invalid_exception_owner");
    assertMutationContext(input.correlationId, input.idempotencyKey);
    if (!SAFE_KEY.test(input.dedupeKey)) fail("invalid_dedupe_key");
    const raw = await this.rpc("civya_service_raise_workflow_exception", {
      p_actor_user_id: input.actor.userId,
      p_actor_type: input.actor.type,
      p_workflow_instance_id: input.workflowInstanceId,
      p_expected_row_version: input.expectedRowVersion,
      p_action_key: input.actionKey,
      p_exception_type: input.exceptionType,
      p_severity: input.severity,
      p_reason_code: input.reasonCode,
      p_redacted_summary: input.redactedSummary.trim(),
      p_assigned_to_auth_user_id: input.assignedToAuthUserId ?? null,
      p_correlation_id: input.correlationId,
      p_dedupe_key: input.dedupeKey,
      p_idempotency_key: input.idempotencyKey,
    });
    const mutation = mapMutation(raw);
    const row = objectValue(raw, "invalid_exception_response");
    return {
      ...mutation,
      exceptionId: uuidValue(row.exceptionId, "invalid_exception_response"),
      exceptionStatus: stringValue(row.exceptionStatus, "invalid_exception_response"),
      assignedToAuthUserId: nullableUuid(row.assignedToAuthUserId, "invalid_exception_response"),
    };
  }

  private async rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.invokeRpc(name, parameters);
    if (error) throw mapRpcError(error);
    if (data === null || data === undefined) fail("empty_workflow_response");
    return data;
  }
}

export function createSupabaseGovernedWorkflowRepository(
  client: SupabaseClient = createSupabaseAdminClient(),
): GovernedWorkflowRepository {
  return new GovernedWorkflowRepository(async (functionName, parameters) => {
    const { data, error } = await client.rpc(functionName, parameters);
    return { data, error };
  });
}

export function workflowImplementationStatus(key: WorkflowKey):
  | "verified_persisted_slice"
  | "defined_not_activated" {
  return (VERIFIED_PERSISTED_WORKFLOW_SLICES as readonly string[]).includes(key)
    ? "verified_persisted_slice"
    : "defined_not_activated";
}

function mapSnapshot(value: unknown): GovernedWorkflowSnapshot {
  const row = objectValue(value, "invalid_workflow_response");
  const workflowKey = workflowKeyValue(row.workflowKey);
  const definition = getWorkflowDefinition(workflowKey);
  const definitionVersion = stringValue(row.definitionVersion, "invalid_workflow_response");
  if (definition.version !== definitionVersion) fail("workflow_definition_version_mismatch");
  const state = stringValue(row.state, "invalid_workflow_response");
  const nextAction = definition.nextActions[state];
  if (!nextAction) fail("workflow_state_unknown");
  const actions = arrayValue(row.actions).map(mapAction);
  const handoffs = arrayValue(row.handoffs).map(mapHandoff);
  return {
    id: uuidValue(row.id, "invalid_workflow_response"),
    tenantId: uuidValue(row.tenantId, "invalid_workflow_response"),
    residentId: uuidValue(row.residentId, "invalid_workflow_response"),
    caseId: uuidValue(row.caseId, "invalid_workflow_response"),
    workflowKey,
    definitionVersion,
    state,
    status: workflowStatusValue(row.status),
    rowVersion: positiveInteger(row.rowVersion, "invalid_workflow_response"),
    correlationId: stringValue(row.correlationId, "invalid_workflow_response"),
    startedAt: timestampValue(row.startedAt, "invalid_workflow_response"),
    updatedAt: timestampValue(row.updatedAt, "invalid_workflow_response"),
    completedAt: nullableTimestamp(row.completedAt, "invalid_workflow_response"),
    nextAction,
    completionAuthority: definition.completionAuthority,
    actions,
    handoffs,
    exception: row.exception === null || row.exception === undefined
      ? null
      : mapException(row.exception),
  };
}

function mapMutation(value: unknown): WorkflowMutationResult {
  const row = objectValue(value, "invalid_mutation_response");
  return {
    workflowInstanceId: uuidValue(row.workflowInstanceId, "invalid_mutation_response"),
    actionId: row.actionId ? uuidValue(row.actionId, "invalid_mutation_response") : undefined,
    state: stringValue(row.state, "invalid_mutation_response"),
    status: stringValue(row.status, "invalid_mutation_response"),
    rowVersion: positiveInteger(row.rowVersion, "invalid_mutation_response"),
    duplicate: row.duplicate === true,
  };
}

function mapAction(value: unknown): WorkflowActionRecord {
  const row = objectValue(value, "invalid_workflow_action");
  return {
    id: uuidValue(row.id, "invalid_workflow_action"),
    sequenceNumber: positiveInteger(row.sequenceNumber, "invalid_workflow_action"),
    actionKey: stringValue(row.actionKey, "invalid_workflow_action"),
    fromState: nullableString(row.fromState, "invalid_workflow_action"),
    toState: stringValue(row.toState, "invalid_workflow_action"),
    actorType: stringValue(row.actorType, "invalid_workflow_action"),
    reasonCode: stringValue(row.reasonCode, "invalid_workflow_action"),
    correlationId: stringValue(row.correlationId, "invalid_workflow_action"),
    completionEvidenceId: nullableUuid(row.completionEvidenceId, "invalid_workflow_action"),
    createdAt: timestampValue(row.createdAt, "invalid_workflow_action"),
  };
}

function mapHandoff(value: unknown): WorkflowHandoffRecord {
  const row = objectValue(value, "invalid_workflow_handoff");
  const browserState = stringValue(row.browserState, "invalid_workflow_handoff");
  const authoritativeState = stringValue(row.authoritativeState, "invalid_workflow_handoff");
  if (!["created", "opened", "returned", "abandoned", "expired"].includes(browserState)) {
    fail("invalid_workflow_handoff");
  }
  if (!["pending", "confirmed", "failed"].includes(authoritativeState)) {
    fail("invalid_workflow_handoff");
  }
  return {
    id: uuidValue(row.id, "invalid_workflow_handoff"),
    providerKey: stringValue(row.providerKey, "invalid_workflow_handoff"),
    destinationOrigin: stringValue(row.destinationOrigin, "invalid_workflow_handoff"),
    browserState: browserState as WorkflowHandoffRecord["browserState"],
    authoritativeState: authoritativeState as WorkflowHandoffRecord["authoritativeState"],
    rowVersion: positiveInteger(row.rowVersion, "invalid_workflow_handoff"),
    expiresAt: timestampValue(row.expiresAt, "invalid_workflow_handoff"),
    updatedAt: timestampValue(row.updatedAt, "invalid_workflow_handoff"),
  };
}

function mapException(value: unknown): WorkflowExceptionRecord {
  const row = objectValue(value, "invalid_workflow_exception");
  const severity = row.severity === undefined ? undefined : stringValue(row.severity, "invalid_workflow_exception");
  if (severity && !["low", "normal", "high", "urgent"].includes(severity)) {
    fail("invalid_workflow_exception");
  }
  return {
    id: row.id ? uuidValue(row.id, "invalid_workflow_exception") : undefined,
    type: optionalString(row.type),
    severity: severity as WorkflowExceptionRecord["severity"],
    status: stringValue(row.status, "invalid_workflow_exception"),
    reasonCode: optionalString(row.reasonCode),
    redactedSummary: optionalString(row.redactedSummary),
    assignedToAuthUserId: row.assignedToAuthUserId === undefined
      ? undefined
      : nullableUuid(row.assignedToAuthUserId, "invalid_workflow_exception"),
    rowVersion: row.rowVersion === undefined ? undefined : positiveInteger(row.rowVersion, "invalid_workflow_exception"),
    residentMessage: optionalString(row.residentMessage),
    createdAt: row.createdAt === undefined ? undefined : timestampValue(row.createdAt, "invalid_workflow_exception"),
    updatedAt: row.updatedAt === undefined ? undefined : timestampValue(row.updatedAt, "invalid_workflow_exception"),
  };
}

function assertVerifiedSlice(key: WorkflowKey): asserts key is VerifiedPersistedWorkflowSlice {
  if (!(VERIFIED_PERSISTED_WORKFLOW_SLICES as readonly string[]).includes(key)) {
    fail("workflow_not_activated");
  }
}

function assertAuthenticatedActor(actor: AuthenticatedWorkflowActor): void {
  if (actor.type !== "resident" && actor.type !== "staff") fail("invalid_actor_type");
  assertUuid(actor.userId, "invalid_actor_id");
}

function assertMutationActor(actor: WorkflowMutationActor): void {
  if (actor.type === "resident" || actor.type === "staff") {
    assertUuid(actor.userId, "invalid_actor_id");
  } else if ((actor.type === "system" || actor.type === "provider") && actor.userId !== null) {
    fail("invalid_actor_identity");
  } else if (actor.type !== "system" && actor.type !== "provider") {
    fail("invalid_actor_type");
  }
}

function assertUuid(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail(code);
}

function assertMutationContext(correlationId: string, idempotencyKey: string): void {
  if (!SAFE_KEY.test(correlationId)) fail("invalid_correlation_id");
  if (!SAFE_KEY.test(idempotencyKey)) fail("invalid_idempotency_key");
}

function assertAction(value: string): void {
  if (!SAFE_ACTION.test(value)) fail("invalid_action_key");
}

function assertState(value: string): void {
  if (!SAFE_ACTION.test(value)) fail("invalid_workflow_state");
}

function assertReason(value: string): void {
  if (!SAFE_ACTION.test(value) || value.length > 120) fail("invalid_reason_code");
}

function assertRowVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_row_version");
}

function validatedRedactedObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value !== undefined && (!value || Array.isArray(value) || typeof value !== "object")) {
    fail("invalid_redacted_metadata");
  }
  const redacted = value ?? {};
  const serialized = JSON.stringify(redacted);
  if (serialized.length > 8_000) fail("redacted_metadata_too_large");
  assertNoSensitiveMetadata(redacted);
  return redacted;
}

function assertNoSensitiveMetadata(value: unknown, depth = 0): void {
  if (depth > 8) fail("redacted_metadata_too_deep");
  if (typeof value === "string") {
    if (value.length > 500 || SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail("sensitive_workflow_metadata_rejected");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 50) fail("redacted_metadata_too_large");
    for (const item of value) assertNoSensitiveMetadata(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") fail("invalid_redacted_metadata");
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) fail("sensitive_workflow_metadata_rejected");
    assertNoSensitiveMetadata(nested, depth + 1);
  }
}

function canonicalResidentStartContext(
  workflowKey: WorkflowKey,
  supplied: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (workflowKey !== "payment_plan_navigation") fail("workflow_not_activated");
  if (supplied !== undefined) {
    validatedRedactedObject(supplied);
    const keys = Object.keys(supplied);
    if (keys.length !== 2
       || supplied.channel !== RESIDENT_START_CONTEXT.channel
       || supplied.purpose !== RESIDENT_START_CONTEXT.purpose) {
      fail("sensitive_workflow_metadata_rejected");
    }
  }
  return { ...RESIDENT_START_CONTEXT };
}

function canonicalResidentActionMetadata(
  actionKey: string,
  toState: string,
  reasonCode: string,
  supplied: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (supplied !== undefined) {
    validatedRedactedObject(supplied);
    if (Object.keys(supplied).length > 0) fail("sensitive_workflow_metadata_rejected");
  }
  const expectedReason = RESIDENT_ACTION_REASONS[`${actionKey}:${toState}`];
  if (expectedReason && reasonCode !== expectedReason) fail("workflow_transition_rejected");
  return {};
}

export function residentWorkflowActionReason(actionKey: string, toState: string): string {
  const reason = RESIDENT_ACTION_REASONS[`${actionKey}:${toState}`];
  if (!reason) fail("workflow_transition_rejected");
  return reason;
}

function workflowKeyValue(value: unknown): WorkflowKey {
  if (typeof value !== "string" || !(WORKFLOW_KEYS as readonly string[]).includes(value)) {
    fail("invalid_workflow_key");
  }
  return value as WorkflowKey;
}

function workflowStatusValue(value: unknown): GovernedWorkflowSnapshot["status"] {
  const status = stringValue(value, "invalid_workflow_status");
  if (!["active", "paused", "escalated", "completed", "cancelled"].includes(status)) {
    fail("invalid_workflow_status");
  }
  return status as GovernedWorkflowSnapshot["status"];
}

function mapRpcError(error: WorkflowRpcFailure): GovernedWorkflowRepositoryError {
  const cause = error.code || "workflow_store_error";
  if (cause === "40001") return new GovernedWorkflowRepositoryError("workflow_stale_state", true, cause);
  if (cause === "42501" || cause === "28000") {
    return new GovernedWorkflowRepositoryError("workflow_access_denied", false, cause);
  }
  if (cause === "P0002" || cause === "PGRST116") {
    return new GovernedWorkflowRepositoryError("workflow_not_found", false, cause);
  }
  if (cause === "23505") return new GovernedWorkflowRepositoryError("workflow_idempotency_conflict", false, cause);
  if (cause === "55000" || cause === "22023") {
    return new GovernedWorkflowRepositoryError("workflow_transition_rejected", false, cause);
  }
  return new GovernedWorkflowRepositoryError("workflow_store_unavailable", true, cause);
}

function publicWorkflowErrorMessage(code: string): string {
  switch (code) {
    case "workflow_not_activated":
      return "This workflow is defined but has not been activated as a persisted County service.";
    case "workflow_stale_state":
      return "This workflow changed. Reload the saved state before trying again.";
    case "workflow_access_denied":
      return "Verified access to this Wayne County case is required.";
    case "workflow_not_found":
      return "The saved workflow was not found.";
    case "workflow_idempotency_conflict":
      return "That request key was already used for a different workflow action.";
    case "workflow_transition_rejected":
      return "That workflow action is not allowed from the saved state.";
    default:
      return "Civya could not safely update the saved workflow.";
  }
}

function fail(code: string): never {
  throw new GovernedWorkflowRepositoryError(code, false);
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value) fail(code);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nullableString(value: unknown, code: string): string | null {
  return value === null || value === undefined ? null : stringValue(value, code);
}

function uuidValue(value: unknown, code: string): string {
  assertUuid(value, code);
  return value;
}

function nullableUuid(value: unknown, code: string): string | null {
  return value === null || value === undefined ? null : uuidValue(value, code);
}

function positiveInteger(value: unknown, code: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(code);
  return number;
}

function timestampValue(value: unknown, code: string): string {
  if (typeof value !== "string" && !(value instanceof Date)) fail(code);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) fail(code);
  return timestamp.toISOString();
}

function nullableTimestamp(value: unknown, code: string): string | null {
  return value === null || value === undefined ? null : timestampValue(value, code);
}
