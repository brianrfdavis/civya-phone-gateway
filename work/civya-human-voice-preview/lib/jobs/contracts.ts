export type JobState =
  | "queued"
  | "leased"
  | "retry_wait"
  | "succeeded"
  | "dead_letter"
  | "cancelled";

export interface JobEnvelope<Payload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: string;
  schemaVersion: string;
  payload: Payload;
  idempotencyKey: string;
  sourceType: string | null;
  sourceId: string | null;
  priority: number;
  deadlineAt: string | null;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  timeoutSeconds: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
}

export interface EnqueueJobInput<Payload extends Record<string, unknown> = Record<string, unknown>> {
  tenantId: string;
  type: string;
  schemaVersion?: string;
  payload: Payload;
  idempotencyKey: string;
  priority?: number;
  deadlineAt?: string | null;
  maxAttempts?: number;
  timeoutSeconds?: number;
  availableAt?: string;
  sourceType?: string | null;
  sourceId?: string | null;
}

export interface EnqueueResult<Payload extends Record<string, unknown> = Record<string, unknown>> {
  duplicate: boolean;
  job: JobEnvelope<Payload>;
}

export interface JobFailure {
  retryable: boolean;
  code: string;
  /** Must be safe for logs, support consoles, and County audit exports. */
  redactedMessage: string;
  retryDelaySeconds?: number;
}

export interface JobHealth {
  counts: Partial<Record<JobState, number>>;
  oldestReadyAgeSeconds: number;
  expiredLeases: number;
  unprocessedProviderEvents: number;
  leasedProviderEvents?: number;
  pendingOutbox: number;
}

export interface AuditChainVerification {
  valid: boolean;
  checkedEvents: number;
  brokenAtSequence?: number;
  expectedHash?: string;
  actualHash?: string;
  headSequence?: number;
  headHash?: string;
}

export interface AuditArchiveRequest {
  duplicate: boolean;
  checkpointId: string;
  jobId: string;
  state: string;
}

export type ProviderEventState = "received" | "processing" | "rejected" | "processed" | "failed";

export interface ProviderEventResult {
  id: string;
  state: ProviderEventState;
  duplicate: boolean;
}

export interface ClaimProviderEventInput {
  tenantId: string;
  providerKey: string;
  externalEventId: string;
  eventType: string;
  payloadSha256: string;
  redactedPayload?: Record<string, unknown>;
  signatureVerified: boolean;
  processingOwner: string;
  leaseSeconds?: number;
  maxAttempts?: number;
}

export interface ProviderEventClaimResult extends ProviderEventResult {
  claimed: boolean;
  busy: boolean;
  attempt: number;
  maxAttempts: number;
  processingToken: string | null;
  leaseExpiresAt: string | null;
  retryAfterSeconds?: number;
}

export interface PhoneTurnClaimResult {
  id: string;
  state: "processing" | "completed" | "failed";
  claimed: boolean;
  duplicate: boolean;
  busy: boolean;
  attempt: number;
  processingToken: string | null;
  leaseExpiresAt: string | null;
  retryAfterSeconds?: number;
  responsePayload?: Record<string, unknown> | null;
  responseSha256?: string | null;
}

export interface CallSessionResult {
  callSessionId: string;
  status: "received" | "ringing" | "connected" | "transferring" | "transferred" | "completed" | "failed";
  authorityMode: "conversational_only" | "deterministic_request" | "human_transfer";
  rowVersion: number;
  eventId?: string;
  duplicate: boolean;
}

export interface ExternalOperationResult {
  id: string;
  state: "planned" | "in_flight" | "succeeded" | "failed_unknown" | "failed_terminal";
  externalReference: string | null;
  duplicate?: boolean;
}

export interface ExternalOperationClaimResult extends ExternalOperationResult {
  acquired: boolean;
  busy: boolean;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  retryAfterSeconds?: number;
  stale?: boolean;
  reconciliationRequired?: boolean;
}

export interface ExternalOperationClaimFinishResult extends ExternalOperationResult {
  finished: boolean;
  stale: boolean;
  reconciliationRequired?: boolean;
}

export type ReconciliationCheckpointStatus = "idle" | "running" | "healthy" | "degraded" | "failed";
export type ReconciliationResult = "started" | "succeeded" | "degraded" | "failed";

export interface ReconciliationCheckpoint {
  id: string;
  tenantId: string;
  providerKey: string;
  streamKey: string;
  cursorDigest: string | null;
  throughAt: string | null;
  status: ReconciliationCheckpointStatus;
  lastRunId: string | null;
  rowVersion: number;
}

export interface AdvanceReconciliationCheckpointInput {
  tenantId: string;
  providerKey: string;
  streamKey: string;
  expectedRowVersion: number;
  runId: string;
  result: ReconciliationResult;
  cursorDigest?: string | null;
  throughAt?: string | null;
  recordsExamined?: number;
  discrepanciesFound?: number;
  errorCode?: string | null;
  summarySha256: string;
  /** Fixed-shape, non-subject metadata only. Never pass provider payloads here. */
  redactedSummary: Record<string, string | number | boolean | null>;
}

export interface AdvanceReconciliationCheckpointResult {
  checkpointId: string;
  status: ReconciliationCheckpointStatus;
  rowVersion: number;
  eventId: string;
  duplicate: boolean;
}
