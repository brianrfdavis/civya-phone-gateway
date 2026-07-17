export const REMINDER_JOB_TYPE = "outbox.reminder.delivery.requested" as const;
export const REMINDER_TEMPLATE_KEY = "civya.secure_account_reminder" as const;
export const REMINDER_TEMPLATE_VERSION = "v1" as const;
export const REMINDER_CONSENT_POLICY_VERSION = "civya-reminder-consent-v1" as const;

export type ReminderStatus =
  | "scheduled"
  | "queued"
  | "accepted"
  | "delivered"
  | "failed"
  | "failed_unknown"
  | "cancelled"
  | "suppressed";

export interface ReminderView {
  reminderId: string;
  deliveryId: string;
  status: ReminderStatus;
  scheduledFor: string;
  channel: "sms";
  acceptedAt: string | null;
  deliveredAt: string | null;
  canCancel: boolean;
}

export interface ScheduleReminderResult {
  reminderId: string;
  deliveryId: string;
  status: ReminderStatus;
  scheduledFor: string;
  duplicate: boolean;
  deliveryAuthority: "provider_receipt_required";
}

export type PreparedReminder =
  | {
      state: "terminal" | "suppressed";
      status: ReminderStatus;
      reminderId: string;
      deliveryId: string;
      reasonCode?: string;
    }
  | {
      state: "deferred";
      status: ReminderStatus;
      reminderId: string;
      deliveryId: string;
      nextEligibleAt: string;
      reasonCode?: string;
    }
  | {
      state: "ready";
      status: "queued";
      tenantId: string;
      residentId: string;
      caseId: string;
      entitlementId: string;
      reminderId: string;
      deliveryId: string;
      templateId: string;
      templateKey: string;
      templateVersion: string;
      templateBody: string;
      destination: string;
      contactReferenceDigest: string;
      quietHoursCheckedAt: string;
    };

export interface ReminderDeliveryOutcome {
  reminderId: string;
  deliveryId: string;
  status: ReminderStatus;
  duplicate: boolean;
}

export interface TwilioDeliveryReceiptResult {
  matched: boolean;
  deliveryId?: string;
  reminderId?: string;
  status: ReminderStatus | "unmatched";
  duplicate: boolean;
}

