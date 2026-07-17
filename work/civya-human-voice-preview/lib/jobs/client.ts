import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditArchiveRequest,
  AuditChainVerification,
  AdvanceReconciliationCheckpointInput,
  AdvanceReconciliationCheckpointResult,
  ClaimProviderEventInput,
  EnqueueJobInput,
  EnqueueResult,
  ExternalOperationClaimFinishResult,
  ExternalOperationClaimResult,
  ExternalOperationResult,
  JobEnvelope,
  JobFailure,
  JobHealth,
  CallSessionResult,
  PhoneTurnClaimResult,
  ProviderEventResult,
  ProviderEventClaimResult,
  ReconciliationCheckpoint,
} from "./contracts";

export class FoundationJobStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
    message = "The durable work store rejected the operation.",
  ) {
    super(message);
    this.name = "FoundationJobStoreError";
  }
}

/**
 * Server/worker-only RPC client. The supplied Supabase client must use the
 * service-role key; browser clients do not have EXECUTE grants on these RPCs.
 */
export class FoundationJobClient {
  constructor(private readonly supabase: SupabaseClient) {}

  private async rpc<Result>(operation: string, args: Record<string, unknown> = {}): Promise<Result> {
    const { data, error } = await this.supabase.rpc(operation, args);
    if (error) {
      throw new FoundationJobStoreError(operation, error.code ?? "job_store_error");
    }
    return data as Result;
  }

  enqueue<Payload extends Record<string, unknown>>(input: EnqueueJobInput<Payload>): Promise<EnqueueResult<Payload>> {
    return this.rpc("civya_service_enqueue_job", {
      p_tenant_id: input.tenantId,
      p_job_type: input.type,
      p_schema_version: input.schemaVersion ?? "1",
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_priority: input.priority ?? 0,
      p_deadline_at: input.deadlineAt ?? null,
      p_max_attempts: input.maxAttempts ?? 8,
      p_timeout_seconds: input.timeoutSeconds ?? 300,
      p_available_at: input.availableAt ?? new Date().toISOString(),
      p_source_type: input.sourceType ?? null,
      p_source_id: input.sourceId ?? null,
    });
  }

  claim(workerId: string, capabilities: string[], limit = 10, leaseSeconds = 60): Promise<JobEnvelope[]> {
    return this.rpc("civya_service_claim_jobs", {
      p_worker_id: workerId,
      p_capabilities: capabilities,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
  }

  heartbeat(jobId: string, workerId: string, leaseSeconds = 60): Promise<boolean> {
    return this.rpc("civya_service_heartbeat_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
  }

  complete(jobId: string, workerId: string, result: Record<string, unknown> = {}): Promise<JobEnvelope> {
    return this.rpc("civya_service_complete_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_result: result,
    });
  }

  fail(jobId: string, workerId: string, failure: JobFailure): Promise<JobEnvelope> {
    return this.rpc("civya_service_fail_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_retryable: failure.retryable,
      p_error_code: failure.code,
      p_error_redacted: failure.redactedMessage,
      p_retry_delay_seconds: failure.retryDelaySeconds ?? 30,
    });
  }

  cancel(jobId: string, actorUserId: string, reason: string): Promise<JobEnvelope> {
    return this.rpc("civya_service_cancel_job", {
      p_job_id: jobId,
      p_actor_user_id: actorUserId,
      p_reason: reason,
    });
  }

  replay(jobId: string, idempotencyKey: string, actorUserId: string, reason: string): Promise<JobEnvelope> {
    return this.rpc("civya_service_replay_job", {
      p_job_id: jobId,
      p_new_idempotency_key: idempotencyKey,
      p_actor_user_id: actorUserId,
      p_reason: reason,
    });
  }

  appendOutbox(input: {
    tenantId: string;
    aggregateType: string;
    aggregateId?: string | null;
    eventType: string;
    schemaVersion?: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ id: string; state: string; duplicate: boolean }> {
    return this.rpc("civya_service_append_outbox_event", {
      p_tenant_id: input.tenantId,
      p_aggregate_type: input.aggregateType,
      p_aggregate_id: input.aggregateId ?? null,
      p_event_type: input.eventType,
      p_schema_version: input.schemaVersion ?? "1",
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
    });
  }

  dispatchOutbox(limit = 100): Promise<JobEnvelope[]> {
    return this.rpc("civya_service_dispatch_outbox", { p_limit: limit });
  }

  reserveExternalOperation(input: {
    tenantId: string;
    providerKey: string;
    operationKind: string;
    idempotencyKey: string;
    requestSha256: string;
    requestMetadata?: Record<string, unknown>;
  }): Promise<ExternalOperationResult> {
    return this.rpc("civya_service_reserve_external_operation", {
      p_tenant_id: input.tenantId,
      p_provider_key: input.providerKey,
      p_operation_kind: input.operationKind,
      p_idempotency_key: input.idempotencyKey,
      p_request_sha256: input.requestSha256,
      p_request_metadata: input.requestMetadata ?? {},
    });
  }

  claimExternalOperation(input: {
    tenantId: string;
    providerKey: string;
    operationKind: string;
    idempotencyKey: string;
    requestSha256: string;
    requestMetadata?: Record<string, unknown>;
    claimOwner: string;
    leaseSeconds?: number;
  }): Promise<ExternalOperationClaimResult> {
    return this.rpc("civya_service_claim_external_operation", {
      p_tenant_id: input.tenantId,
      p_provider_key: input.providerKey,
      p_operation_kind: input.operationKind,
      p_idempotency_key: input.idempotencyKey,
      p_request_sha256: input.requestSha256,
      p_request_metadata: input.requestMetadata ?? {},
      p_claim_owner: input.claimOwner,
      p_lease_seconds: input.leaseSeconds ?? 60,
    });
  }

  finishExternalOperationClaim(input: {
    operationId: string;
    claimOwner: string;
    claimToken: string;
    state: "succeeded" | "failed_unknown" | "failed_terminal";
    externalReference?: string | null;
    responseMetadata?: Record<string, unknown>;
    errorCode?: string | null;
  }): Promise<ExternalOperationClaimFinishResult> {
    return this.rpc("civya_service_finish_external_operation_claim", {
      p_operation_id: input.operationId,
      p_claim_owner: input.claimOwner,
      p_claim_token: input.claimToken,
      p_state: input.state,
      p_external_reference: input.externalReference ?? null,
      p_response_metadata: input.responseMetadata ?? {},
      p_error_code: input.errorCode ?? null,
    });
  }

  finishExternalOperation(input: {
    operationId: string;
    state: "in_flight" | "succeeded" | "failed_unknown" | "failed_terminal";
    externalReference?: string | null;
    responseMetadata?: Record<string, unknown>;
    errorCode?: string | null;
  }): Promise<ExternalOperationResult> {
    return this.rpc("civya_service_finish_external_operation", {
      p_operation_id: input.operationId,
      p_state: input.state,
      p_external_reference: input.externalReference ?? null,
      p_response_metadata: input.responseMetadata ?? {},
      p_error_code: input.errorCode ?? null,
    });
  }

  recordProviderEvent(input: {
    tenantId: string;
    providerKey: string;
    externalEventId: string;
    eventType: string;
    payloadSha256: string;
    redactedPayload?: Record<string, unknown>;
    signatureVerified: boolean;
  }): Promise<ProviderEventResult> {
    return this.rpc("civya_service_record_provider_event", {
      p_tenant_id: input.tenantId,
      p_provider_key: input.providerKey,
      p_external_event_id: input.externalEventId,
      p_event_type: input.eventType,
      p_payload_sha256: input.payloadSha256,
      p_redacted_payload: input.redactedPayload ?? {},
      p_signature_verified: input.signatureVerified,
    });
  }

  claimProviderEvent(input: ClaimProviderEventInput): Promise<ProviderEventClaimResult> {
    return this.rpc("civya_service_claim_provider_event", {
      p_tenant_id: input.tenantId,
      p_provider_key: input.providerKey,
      p_external_event_id: input.externalEventId,
      p_event_type: input.eventType,
      p_payload_sha256: input.payloadSha256,
      p_redacted_payload: input.redactedPayload ?? {},
      p_signature_verified: input.signatureVerified,
      p_processing_owner: input.processingOwner,
      p_lease_seconds: input.leaseSeconds ?? 30,
      p_max_attempts: input.maxAttempts ?? 8,
    });
  }

  finishProviderEventClaim(
    eventId: string,
    processingOwner: string,
    processingToken: string,
    outcome: "processed" | "retry" | "failed",
    errorCode?: string,
    retryDelaySeconds = 15,
  ): Promise<boolean> {
    return this.rpc("civya_service_finish_provider_event_claim", {
      p_event_id: eventId,
      p_processing_owner: processingOwner,
      p_processing_token: processingToken,
      p_outcome: outcome,
      p_error_code: errorCode ?? null,
      p_retry_delay_seconds: retryDelaySeconds,
    });
  }

  markProviderEvent(eventId: string, state: "processed" | "failed", jobId?: string, errorCode?: string): Promise<boolean> {
    return this.rpc("civya_service_mark_provider_event", {
      p_event_id: eventId,
      p_state: state,
      p_job_id: jobId ?? null,
      p_error_code: errorCode ?? null,
    });
  }

  claimPhoneTurn(input: {
    tenantId: string;
    callReferenceDigest: string;
    providerItemId: string;
    idempotencyKey: string;
    requestSha256: string;
    processingOwner: string;
    leaseSeconds?: number;
  }): Promise<PhoneTurnClaimResult> {
    return this.rpc("civya_service_claim_phone_turn", {
      p_tenant_id: input.tenantId,
      p_call_reference_digest: input.callReferenceDigest,
      p_provider_item_id: input.providerItemId,
      p_idempotency_key: input.idempotencyKey,
      p_request_sha256: input.requestSha256,
      p_processing_owner: input.processingOwner,
      p_lease_seconds: input.leaseSeconds ?? 20,
    });
  }

  finishPhoneTurn(input: {
    turnId: string;
    processingOwner: string;
    processingToken: string;
    responsePayload: Record<string, unknown>;
  }): Promise<boolean> {
    return this.rpc("civya_service_finish_phone_turn", {
      p_turn_id: input.turnId,
      p_processing_owner: input.processingOwner,
      p_processing_token: input.processingToken,
      p_response_payload: input.responsePayload,
    });
  }

  failPhoneTurn(input: {
    turnId: string;
    processingOwner: string;
    processingToken: string;
    errorCode: string;
  }): Promise<boolean> {
    return this.rpc("civya_service_fail_phone_turn", {
      p_turn_id: input.turnId,
      p_processing_owner: input.processingOwner,
      p_processing_token: input.processingToken,
      p_error_code: input.errorCode,
    });
  }

  createCallSession(input: {
    tenantId: string;
    providerKey: string;
    providerCallReferenceDigest: string;
    participantReferenceDigest?: string | null;
    direction: "inbound" | "outbound";
    correlationId: string;
    idempotencyKey: string;
  }): Promise<CallSessionResult> {
    return this.rpc("civya_service_create_call_session", {
      p_tenant_id: input.tenantId,
      p_actor_user_id: null,
      p_case_id: null,
      p_workflow_instance_id: null,
      p_channel_session_id: null,
      p_provider_key: input.providerKey,
      p_provider_call_reference_digest: input.providerCallReferenceDigest,
      p_participant_reference_digest: input.participantReferenceDigest ?? null,
      p_direction: input.direction,
      p_correlation_id: input.correlationId,
      p_idempotency_key: input.idempotencyKey,
    });
  }

  controlCall(input: {
    callSessionId: string;
    expectedRowVersion: number;
    nextStatus: CallSessionResult["status"];
    authorityMode?: CallSessionResult["authorityMode"];
    transferDestinationKey?: string | null;
    eventType: string;
    providerEventId?: string | null;
    authorityEffect?: "conversation" | "deterministic_request" | "human_transfer" | "consequential_blocked";
    actorType?: "system" | "provider" | "staff";
    payloadSha256: string;
    redactedMetadata?: Record<string, unknown>;
  }): Promise<CallSessionResult> {
    return this.rpc("civya_service_control_call", {
      p_call_session_id: input.callSessionId,
      p_expected_row_version: input.expectedRowVersion,
      p_next_status: input.nextStatus,
      p_authority_mode: input.authorityMode ?? "conversational_only",
      p_transfer_destination_key: input.transferDestinationKey ?? null,
      p_event_type: input.eventType,
      p_provider_event_id: input.providerEventId ?? null,
      p_authority_effect: input.authorityEffect ?? "conversation",
      p_actor_type: input.actorType ?? "system",
      p_actor_user_id: null,
      p_payload_sha256: input.payloadSha256,
      p_redacted_metadata: input.redactedMetadata ?? {},
    });
  }

  async getReconciliationCheckpoint(
    tenantId: string,
    providerKey: string,
    streamKey: string,
  ): Promise<ReconciliationCheckpoint | null> {
    const { data, error } = await this.supabase
      .from("provider_reconciliation_checkpoints")
      .select("id,tenant_id,provider_key,stream_key,cursor_digest,through_at,status,last_run_id,row_version")
      .eq("tenant_id", tenantId)
      .eq("provider_key", providerKey)
      .eq("stream_key", streamKey)
      .maybeSingle();
    if (error) {
      throw new FoundationJobStoreError("read_reconciliation_checkpoint", error.code ?? "job_store_error");
    }
    if (!data) return null;
    return {
      id: String(data.id),
      tenantId: String(data.tenant_id),
      providerKey: String(data.provider_key),
      streamKey: String(data.stream_key),
      cursorDigest: data.cursor_digest === null ? null : String(data.cursor_digest),
      throughAt: data.through_at === null ? null : String(data.through_at),
      status: data.status as ReconciliationCheckpoint["status"],
      lastRunId: data.last_run_id === null ? null : String(data.last_run_id),
      rowVersion: Number(data.row_version),
    };
  }

  advanceReconciliationCheckpoint(
    input: AdvanceReconciliationCheckpointInput,
  ): Promise<AdvanceReconciliationCheckpointResult> {
    return this.rpc("civya_service_advance_reconciliation_checkpoint", {
      p_tenant_id: input.tenantId,
      p_provider_key: input.providerKey,
      p_stream_key: input.streamKey,
      p_expected_row_version: input.expectedRowVersion,
      p_run_id: input.runId,
      p_result: input.result,
      p_cursor_digest: input.cursorDigest ?? null,
      p_through_at: input.throughAt ?? null,
      p_records_examined: input.recordsExamined ?? 0,
      p_discrepancies_found: input.discrepanciesFound ?? 0,
      p_error_code: input.errorCode ?? null,
      p_summary_sha256: input.summarySha256,
      p_redacted_summary: input.redactedSummary,
    });
  }

  health(): Promise<JobHealth> {
    return this.rpc("civya_service_job_health");
  }

  verifyAuditChain(tenantId: string): Promise<AuditChainVerification> {
    return this.rpc("civya_service_verify_audit_chain", { p_tenant_id: tenantId });
  }

  requestAuditArchive(tenantId: string, idempotencyKey: string, throughSequence: number | null = null): Promise<AuditArchiveRequest> {
    return this.rpc("civya_service_request_audit_archive", {
      p_tenant_id: tenantId,
      p_through_sequence: throughSequence,
      p_idempotency_key: idempotencyKey,
    });
  }

  completeAuditArchive(checkpointId: string, objectReference: string, objectSha256: string): Promise<Record<string, unknown>> {
    return this.rpc("civya_service_complete_audit_archive", {
      p_checkpoint_id: checkpointId,
      p_object_reference: objectReference,
      p_object_sha256: objectSha256,
    });
  }
}
