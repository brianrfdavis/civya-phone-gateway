import { createHash } from "node:crypto";
import { z } from "zod";
import type { FoundationJobClient } from "@/lib/jobs";
import {
  sendLiveTwilioReminder,
  TwilioMessagingConfigurationError,
  TwilioMessagingOutcomeUnknownError,
} from "@/lib/integrations/twilio-messaging-live";
import type { ReminderRepository } from "./repository.server";
import { REMINDER_JOB_TYPE } from "./contracts";
import type { JobHandler } from "@/workers/runtime";
import { RetryableJobError, TerminalJobError } from "@/workers/runtime";

const payloadSchema = z.object({
  reminderId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  caseId: z.string().uuid(),
  residentId: z.string().uuid(),
  templateId: z.string().uuid(),
  notBefore: z.string().datetime({ offset: true }),
  outboxEventId: z.string().uuid(),
}).strict();

export interface ReminderMessagingProvider {
  readonly providerKey: "twilio";
  readonly idempotencySemantics: "none" | "provider_enforced";
  send(input: { to: string; body: string; statusCallback: string }): Promise<{
    providerReferenceDigest: string;
    status: string;
  }>;
}

export class LiveTwilioReminderProvider implements ReminderMessagingProvider {
  readonly providerKey = "twilio" as const;
  readonly idempotencySemantics = "none" as const;

  send(input: { to: string; body: string; statusCallback: string }) {
    return sendLiveTwilioReminder(input);
  }
}

export interface ReminderWorkerActivation {
  enabled: boolean;
  paused: boolean;
  environment: "development" | "test" | "staging" | "production";
  mode: "disabled" | "synthetic" | "live";
  publicOrigin: string;
  twilioWebhookUrl: string;
}

export function createReminderDeliveryHandler(input: {
  activation: ReminderWorkerActivation;
  reminders: Pick<ReminderRepository, "prepareDelivery" | "markDeliveryOutcome">;
  jobs: Pick<FoundationJobClient, "claimExternalOperation" | "finishExternalOperationClaim">;
  provider: ReminderMessagingProvider;
}): JobHandler {
  return async (job, context) => {
    if (!input.activation.enabled || input.activation.paused) {
      throw new TerminalJobError("reminder_delivery_inactive", "Reminder delivery is not active for this release.");
    }
    if (input.activation.environment === "production" && input.activation.mode !== "live") {
      throw new TerminalJobError("reminder_delivery_mode_invalid", "Production reminders require the live approved provider mode.");
    }
    if (input.activation.mode !== "live") {
      throw new TerminalJobError("reminder_delivery_live_required", "The durable reminder worker is live-provider only.");
    }
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new TerminalJobError("reminder_job_invalid", "The reminder job did not match the approved redacted contract.");
    }
    const prepared = await input.reminders.prepareDelivery(payload.data.reminderId);
    if (prepared.reminderId !== payload.data.reminderId || prepared.deliveryId !== payload.data.deliveryId) {
      throw new TerminalJobError("reminder_job_binding_invalid", "The durable reminder binding did not match its outbox event.");
    }
    if (prepared.state === "terminal" || prepared.state === "suppressed") {
      return { reminderId: prepared.reminderId, status: prepared.status, providerCalled: false };
    }
    if (prepared.state === "deferred") {
      const delay = Math.max(5, Math.ceil((Date.parse(prepared.nextEligibleAt) - Date.now()) / 1_000));
      throw new RetryableJobError("reminder_not_yet_eligible", "The reminder is deferred by its schedule or quiet-hours policy.", delay);
    }
    if (prepared.state !== "ready") {
      throw new TerminalJobError("reminder_state_invalid", "The durable reminder store returned an unsupported state.");
    }
    if (
      prepared.caseId !== payload.data.caseId
      || prepared.residentId !== payload.data.residentId
      || prepared.templateId !== payload.data.templateId
    ) {
      throw new TerminalJobError("reminder_job_binding_invalid", "The reminder case, resident, or template binding changed.");
    }

    const body = renderApprovedTemplate(prepared.templateBody, securePortalUrl(input.activation.publicOrigin));
    const callback = reminderStatusCallback(input.activation.twilioWebhookUrl, prepared.deliveryId);
    const requestSha256 = createHash("sha256").update(JSON.stringify({
      deliveryId: prepared.deliveryId,
      templateId: prepared.templateId,
      templateVersion: prepared.templateVersion,
      contactReferenceDigest: prepared.contactReferenceDigest,
      callbackOrigin: new URL(callback).origin,
    })).digest("hex");
    const claimOwner = reminderClaimOwner(context.workerId, job.id);
    const operation = await input.jobs.claimExternalOperation({
      tenantId: prepared.tenantId,
      providerKey: "twilio",
      operationKind: "reminder.send",
      idempotencyKey: `reminder-send:${prepared.deliveryId}`,
      requestSha256,
      requestMetadata: {
        deliveryId: prepared.deliveryId,
        reminderId: prepared.reminderId,
        templateId: prepared.templateId,
        idempotencySemantics: input.provider.idempotencySemantics,
      },
      claimOwner,
      leaseSeconds: Math.max(10, Math.min(300, job.timeoutSeconds)),
    });

    if (operation.state === "succeeded" && operation.externalReference) {
      const outcome = await input.reminders.markDeliveryOutcome({
        reminderId: prepared.reminderId,
        externalOperationId: operation.id,
        outcome: "accepted",
        providerReferenceDigest: operation.externalReference,
        reasonCode: "provider_accepted",
      });
      return { reminderId: outcome.reminderId, status: outcome.status, providerCalled: false, recovered: true };
    }
    if (operation.state === "in_flight" && !operation.acquired) {
      return {
        reminderId: prepared.reminderId,
        status: prepared.status,
        providerCalled: false,
        concurrentClaim: true,
        blindRetryPrevented: true,
      };
    }
    if (operation.state === "failed_unknown") {
      await markUnknown(input, prepared.reminderId, operation.id, operation.externalReference);
      return {
        reminderId: prepared.reminderId,
        status: "failed_unknown",
        providerCalled: false,
        blindRetryPrevented: true,
        receiptReconciliationRequired: true,
      };
    }
    if (operation.state === "failed_terminal") {
      const outcome = await input.reminders.markDeliveryOutcome({
        reminderId: prepared.reminderId,
        externalOperationId: operation.id,
        outcome: "failed",
        providerReferenceDigest: operation.externalReference,
        reasonCode: "provider_terminal_failure",
      });
      return { reminderId: outcome.reminderId, status: outcome.status, providerCalled: false };
    }
    if (operation.state !== "in_flight" || !operation.acquired || !operation.claimToken) {
      throw new TerminalJobError(
        "reminder_external_claim_invalid",
        "The durable provider operation did not return an owned send claim.",
      );
    }

    const claimToken = operation.claimToken;
    try {
      const receipt = await input.provider.send({ to: prepared.destination, body, statusCallback: callback });
      const providerStatus = normalizeInitialStatus(receipt.status);
      if (providerStatus === "failed") {
        const finalized = await input.jobs.finishExternalOperationClaim({
          operationId: operation.id,
          claimOwner,
          claimToken,
          state: "failed_terminal",
          externalReference: receipt.providerReferenceDigest,
          errorCode: "provider_rejected",
          responseMetadata: { status: "failed" },
        });
        if (!finalized.finished) {
          return handleLostClaim(input, prepared.reminderId, finalized, true, receipt.providerReferenceDigest);
        }
        const outcome = await input.reminders.markDeliveryOutcome({
          reminderId: prepared.reminderId,
          externalOperationId: operation.id,
          outcome: "failed",
          providerReferenceDigest: receipt.providerReferenceDigest,
          reasonCode: "provider_rejected",
        });
        return { reminderId: outcome.reminderId, status: outcome.status, providerCalled: true };
      }
      const finalized = await input.jobs.finishExternalOperationClaim({
        operationId: operation.id,
        claimOwner,
        claimToken,
        state: "succeeded",
        externalReference: receipt.providerReferenceDigest,
        responseMetadata: { status: "accepted", deliveryAuthority: false },
      });
      if (!finalized.finished) {
        return handleLostClaim(input, prepared.reminderId, finalized, true, receipt.providerReferenceDigest);
      }
      const outcome = await input.reminders.markDeliveryOutcome({
        reminderId: prepared.reminderId,
        externalOperationId: operation.id,
        outcome: "accepted",
        providerReferenceDigest: receipt.providerReferenceDigest,
        reasonCode: "provider_accepted",
      });
      return {
        reminderId: outcome.reminderId,
        status: outcome.status,
        providerCalled: true,
        deliveryConfirmed: false,
      };
    } catch (error) {
      if (error instanceof TwilioMessagingConfigurationError) {
        const finalized = await input.jobs.finishExternalOperationClaim({
          operationId: operation.id,
          claimOwner,
          claimToken,
          state: "failed_terminal",
          errorCode: error.code,
          responseMetadata: { status: "configuration_failed" },
        });
        if (!finalized.finished) {
          return handleLostClaim(input, prepared.reminderId, finalized, false, null);
        }
        const outcome = await input.reminders.markDeliveryOutcome({
          reminderId: prepared.reminderId,
          externalOperationId: operation.id,
          outcome: "failed",
          reasonCode: error.code,
        });
        return { reminderId: outcome.reminderId, status: outcome.status, providerCalled: false };
      }
      if (error instanceof TwilioMessagingOutcomeUnknownError || input.provider.idempotencySemantics === "none") {
        const finalized = await input.jobs.finishExternalOperationClaim({
          operationId: operation.id,
          claimOwner,
          claimToken,
          state: "failed_unknown",
          errorCode: "twilio_delivery_outcome_unknown",
          responseMetadata: { receiptReconciliationRequired: true },
        });
        if (!finalized.finished && finalized.state !== "failed_unknown") {
          return handleLostClaim(input, prepared.reminderId, finalized, true, finalized.externalReference);
        }
        await markUnknown(input, prepared.reminderId, operation.id, null);
        return {
          reminderId: prepared.reminderId,
          status: "failed_unknown",
          providerCalled: true,
          blindRetryPrevented: true,
          receiptReconciliationRequired: true,
        };
      }
      throw error;
    }
  };
}

async function handleLostClaim(
  input: Parameters<typeof createReminderDeliveryHandler>[0],
  reminderId: string,
  operation: Awaited<ReturnType<FoundationJobClient["finishExternalOperationClaim"]>>,
  providerCalled: boolean,
  providerReferenceDigest: string | null,
): Promise<Record<string, unknown>> {
  if (operation.state === "succeeded" && operation.externalReference) {
    const outcome = await input.reminders.markDeliveryOutcome({
      reminderId,
      externalOperationId: operation.id,
      outcome: "accepted",
      providerReferenceDigest: operation.externalReference,
      reasonCode: "provider_accepted",
    });
    return {
      reminderId: outcome.reminderId,
      status: outcome.status,
      providerCalled,
      recovered: true,
      staleOwnerFenced: true,
    };
  }
  if (operation.state === "failed_terminal") {
    const outcome = await input.reminders.markDeliveryOutcome({
      reminderId,
      externalOperationId: operation.id,
      outcome: "failed",
      providerReferenceDigest: operation.externalReference,
      reasonCode: "provider_terminal_failure",
    });
    return {
      reminderId: outcome.reminderId,
      status: outcome.status,
      providerCalled,
      staleOwnerFenced: true,
    };
  }
  if (operation.state === "failed_unknown") {
    await markUnknown(input, reminderId, operation.id, operation.externalReference ?? providerReferenceDigest);
  }
  return {
    reminderId,
    status: operation.state === "failed_unknown" ? "failed_unknown" : "in_flight",
    providerCalled,
    blindRetryPrevented: true,
    staleOwnerFenced: true,
    receiptReconciliationRequired: true,
  };
}

async function markUnknown(
  input: Parameters<typeof createReminderDeliveryHandler>[0],
  reminderId: string,
  operationId: string,
  providerReferenceDigest: string | null,
): Promise<void> {
  await input.reminders.markDeliveryOutcome({
    reminderId,
    externalOperationId: operationId,
    outcome: "failed_unknown",
    providerReferenceDigest,
    reasonCode: "twilio_delivery_outcome_unknown",
  });
}

function securePortalUrl(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TerminalJobError("reminder_public_origin_invalid", "Reminder links require an exact HTTPS Civya origin.");
  }
  url.pathname = "/";
  return url.toString();
}

function reminderStatusCallback(base: string, deliveryId: string): string {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TerminalJobError("reminder_callback_invalid", "Reminder receipts require an exact HTTPS Twilio webhook URL.");
  }
  url.searchParams.set("delivery", deliveryId);
  return url.toString();
}

function renderApprovedTemplate(template: string, secureLink: string): string {
  if (!template.includes("{{secure_link}}") || (template.match(/{{secure_link}}/g)?.length ?? 0) !== 1) {
    throw new TerminalJobError("reminder_template_invalid", "The approved reminder template has an invalid variable contract.");
  }
  const body = template.replace("{{secure_link}}", secureLink);
  if (/{{[^}]+}}/.test(body) || Buffer.byteLength(body, "utf8") > 1_600) {
    throw new TerminalJobError("reminder_template_invalid", "The rendered reminder template is invalid.");
  }
  return body;
}

function normalizeInitialStatus(status: string): "accepted" | "failed" {
  return status === "failed" || status === "undelivered" ? "failed" : "accepted";
}

function reminderClaimOwner(workerId: string, jobId: string): string {
  return `reminder:${createHash("sha256").update(`${workerId}:${jobId}`).digest("hex")}`;
}

export { REMINDER_JOB_TYPE };
