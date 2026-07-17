import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PreparedReminder,
  ReminderDeliveryOutcome,
  ReminderView,
  ScheduleReminderResult,
  TwilioDeliveryReceiptResult,
} from "./contracts";

export class ReminderStoreError extends Error {
  constructor(readonly operation: string, readonly code: string) {
    super("The durable reminder store rejected the operation.");
    this.name = "ReminderStoreError";
  }
}

/** Service-role-only repository. Raw contact may leave prepareDelivery only
 * inside the always-on worker; it never enters an API response or job payload.
 */
export class ReminderRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  private async rpc<Result>(operation: string, args: Record<string, unknown>): Promise<Result> {
    const { data, error } = await this.supabase.rpc(operation, args);
    if (error) throw new ReminderStoreError(operation, error.code ?? "reminder_store_error");
    return data as Result;
  }

  schedule(input: {
    actorUserId: string;
    caseId: string;
    entitlementId: string;
    scheduledFor: string;
    timezone: string;
    templateKey: string;
    templateVersion: string;
    consentPolicyVersion: string;
    confirmChannelConsent: boolean;
    confirmReminderConsent: boolean;
    idempotencyKey: string;
  }): Promise<ScheduleReminderResult> {
    return this.rpc("civya_service_schedule_entitled_reminder", {
      p_actor_user_id: input.actorUserId,
      p_case_id: input.caseId,
      p_entitlement_id: input.entitlementId,
      p_channel: "sms",
      p_scheduled_for: input.scheduledFor,
      p_timezone: input.timezone,
      p_template_key: input.templateKey,
      p_template_version: input.templateVersion,
      p_consent_policy_version: input.consentPolicyVersion,
      p_confirm_channel_consent: input.confirmChannelConsent,
      p_confirm_reminder_consent: input.confirmReminderConsent,
      p_idempotency_key: input.idempotencyKey,
    });
  }

  list(actorUserId: string, caseId: string, entitlementId: string): Promise<ReminderView[]> {
    return this.rpc("civya_service_get_entitled_reminders", {
      p_actor_user_id: actorUserId,
      p_case_id: caseId,
      p_entitlement_id: entitlementId,
    });
  }

  cancel(input: {
    actorUserId: string;
    caseId: string;
    entitlementId: string;
    reminderId: string;
  }): Promise<{ reminderId: string; status: string; cancelled: boolean; duplicate: boolean }> {
    return this.rpc("civya_service_cancel_entitled_reminder", {
      p_actor_user_id: input.actorUserId,
      p_case_id: input.caseId,
      p_entitlement_id: input.entitlementId,
      p_reminder_id: input.reminderId,
      p_reason_code: "resident_cancelled",
    });
  }

  prepareDelivery(reminderId: string): Promise<PreparedReminder> {
    return this.rpc("civya_service_prepare_reminder_delivery", { p_reminder_id: reminderId });
  }

  markDeliveryOutcome(input: {
    reminderId: string;
    externalOperationId: string;
    outcome: "accepted" | "failed" | "failed_unknown";
    providerReferenceDigest?: string | null;
    reasonCode: string;
  }): Promise<ReminderDeliveryOutcome> {
    return this.rpc("civya_service_mark_reminder_delivery_outcome", {
      p_reminder_id: input.reminderId,
      p_external_operation_id: input.externalOperationId,
      p_outcome: input.outcome,
      p_provider_reference_digest: input.providerReferenceDigest ?? null,
      p_reason_code: input.reasonCode,
    });
  }

  applyTwilioReceipt(input: {
    tenantId: string;
    providerEventId: string;
    externalEventId: string;
    deliveryId?: string | null;
    providerReferenceDigest: string;
    providerStatus: string;
    payloadSha256: string;
  }): Promise<TwilioDeliveryReceiptResult> {
    return this.rpc("civya_service_apply_twilio_delivery_receipt", {
      p_tenant_id: input.tenantId,
      p_provider_event_id: input.providerEventId,
      p_external_event_id: input.externalEventId,
      p_delivery_id: input.deliveryId ?? null,
      p_provider_reference_digest: input.providerReferenceDigest,
      p_provider_status: input.providerStatus,
      p_payload_sha256: input.payloadSha256,
    });
  }

  suppressTwilioContact(input: {
    tenantId: string;
    contactReferenceDigest: string;
    externalEventId: string;
    reasonCode: string;
  }): Promise<{ suppressedResidents: number; duplicate: boolean }> {
    return this.rpc("civya_service_suppress_twilio_contact", {
      p_tenant_id: input.tenantId,
      p_contact_reference_digest: input.contactReferenceDigest,
      p_provider_event_id: input.externalEventId,
      p_reason_code: input.reasonCode,
    });
  }
}

