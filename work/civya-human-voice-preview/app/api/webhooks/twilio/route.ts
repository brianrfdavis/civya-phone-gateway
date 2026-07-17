import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { FoundationJobClient } from "@/lib/jobs";
import { ReminderRepository } from "@/lib/reminders/repository.server";
import { phoneReferenceDigest } from "@/lib/integrations/twilio-messaging-live";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 256_000;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BYTES) {
    return NextResponse.json({ accepted: false, code: "payload_too_large" }, { status: 413 });
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("x-twilio-signature") ?? "";
  const webhookUrl = exactPublicWebhookUrl(request);
  if (!authToken || !signature || !webhookUrl) {
    return NextResponse.json(
      { accepted: false, code: "twilio_webhook_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  let payload: Record<string, string>;
  let signatureValid = false;
  try {
    if (contentType.includes("application/json")) {
      payload = JSON.parse(rawBody) as Record<string, string>;
      signatureValid = twilio.validateRequestWithBody(authToken, signature, webhookUrl, rawBody);
    } else {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
      signatureValid = twilio.validateRequest(authToken, signature, webhookUrl, payload);
    }
  } catch {
    return NextResponse.json({ accepted: false, code: "invalid_twilio_payload" }, { status: 400 });
  }
  if (!signatureValid) {
    return NextResponse.json({ accepted: false, code: "invalid_twilio_signature" }, { status: 400 });
  }

  const eventId = providerEventId(payload);
  if (!eventId) {
    return NextResponse.json({ accepted: false, code: "missing_provider_event_id" }, { status: 400 });
  }
  const messageReceipt = Boolean(payload.MessageSid);
  let providerMode: "disabled" | "synthetic" | "live";
  try {
    const providers = getRuntimeConfig().providers;
    providerMode = messageReceipt ? providers.messaging : providers.telephony;
  } catch {
    return NextResponse.json(
      { accepted: false, code: "runtime_configuration_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const synthetic = providerMode === "synthetic";
  const live = messageReceipt
    ? process.env.CIVYA_ENABLE_MESSAGES === "true" && providerMode === "live"
    : process.env.CIVYA_ENABLE_PSTN === "true" && providerMode === "live";
  if (synthetic) {
    return NextResponse.json(
      {
        accepted: true,
        event_id: eventId,
        receipt_kind: payload.MessageSid ? "message_delivery" : "call_control",
        authority: "provider_receipt_only",
        may_mutate_case_state: false,
        synthetic_sink: true,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  const tenantId = process.env.CIVYA_WAYNE_TENANT_ID?.trim();
  if (!live || !tenantId) {
    return NextResponse.json(
      { accepted: false, code: "twilio_receipt_sink_not_active" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const admin = createSupabaseAdminClient();
    const jobs = new FoundationJobClient(admin);
    const reminders = new ReminderRepository(admin);
    const processingOwner = `twilio-webhook:${randomUUID()}`;
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const receipt = await jobs.claimProviderEvent({
      tenantId,
      providerKey: "twilio",
      externalEventId: eventId,
      eventType: payload.EventType || payload.MessageStatus || payload.SmsStatus || payload.CallStatus || "provider_receipt",
      payloadSha256,
      redactedPayload: {
        kind: payload.MessageSid ? "message_delivery" : "call_control",
        status: safeStatus(payload.MessageStatus || payload.SmsStatus || payload.CallStatus || payload.EventType),
        reference_hash: createHash("sha256")
          .update(payload.MessageSid || payload.CallSid || payload.EventSid || eventId)
          .digest("base64url"),
      },
      signatureVerified: true,
      processingOwner,
      leaseSeconds: 30,
      maxAttempts: 8,
    });
    if (!receipt.claimed && receipt.state === "processed") {
      return NextResponse.json(
        {
          accepted: true,
          duplicate: true,
          receipt_kind: messageReceipt ? "message_delivery" : "call_control",
          authority: "provider_receipt_only",
          may_mutate_case_state: false,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!receipt.claimed || !receipt.processingToken) {
      const retryAfter = Math.max(1, receipt.retryAfterSeconds ?? 5);
      return NextResponse.json(
        { accepted: false, code: "provider_event_in_progress", retry_after_seconds: retryAfter },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } },
      );
    }
    let reminderReceipt: { matched: boolean; status: string; suppressionApplied: boolean } | null = null;
    if (messageReceipt) {
      const providerReferenceDigest = createHash("sha256").update(payload.MessageSid).digest("hex");
      const deliveryId = validUuid(request.nextUrl.searchParams.get("delivery"));
      try {
        const applied = await reminders.applyTwilioReceipt({
          tenantId,
          providerEventId: receipt.id,
          externalEventId: eventId,
          deliveryId,
          providerReferenceDigest,
          providerStatus: safeMessageStatus(payload.MessageStatus || payload.SmsStatus),
          payloadSha256,
        });
        reminderReceipt = {
          matched: applied.matched,
          status: applied.status,
          suppressionApplied: false,
        };
      } catch {
        const retryQueued = await jobs.finishProviderEventClaim(
          receipt.id,
          processingOwner,
          receipt.processingToken,
          "retry",
          "twilio_reminder_receipt_persistence_failed",
          15,
        );
        return NextResponse.json(
          { accepted: false, code: "durable_receipt_unavailable", retry_queued: retryQueued },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
        );
      }
      if (safeStatus(payload.OptOutType).toUpperCase() === "STOP" && payload.From) {
        try {
          const suppression = await reminders.suppressTwilioContact({
            tenantId,
            contactReferenceDigest: phoneReferenceDigest(payload.From),
            externalEventId: eventId,
            reasonCode: "provider_opt_out",
          });
          reminderReceipt = {
            ...(reminderReceipt ?? { matched: false, status: "unmatched", suppressionApplied: false }),
            suppressionApplied: suppression.suppressedResidents > 0 || suppression.duplicate,
          };
        } catch {
          const retryQueued = await jobs.finishProviderEventClaim(
            receipt.id,
            processingOwner,
            receipt.processingToken,
            "retry",
            "twilio_opt_out_persistence_failed",
            15,
          );
          return NextResponse.json(
            { accepted: false, code: "durable_suppression_unavailable", retry_queued: retryQueued },
            { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
          );
        }
      }
    }
    const finished = await jobs.finishProviderEventClaim(
      receipt.id,
      processingOwner,
      receipt.processingToken,
      "processed",
    );
    if (!finished) {
      return NextResponse.json(
        { accepted: false, code: "durable_receipt_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }
    return NextResponse.json(
      {
        accepted: true,
        duplicate: false,
        receipt_kind: messageReceipt ? "message_delivery" : "call_control",
        authority: "provider_receipt_only",
        may_mutate_case_state: false,
        reminder_receipt: reminderReceipt,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { accepted: false, code: "durable_receipt_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function exactPublicWebhookUrl(request: NextRequest): string | null {
  const configured = process.env.CIVYA_TWILIO_WEBHOOK_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.search = request.nextUrl.search;
    return url.toString();
  } catch {
    return null;
  }
}

function providerEventId(payload: Record<string, string>): string {
  const direct = payload.EventSid;
  if (direct && /^[A-Za-z0-9_.:-]{6,200}$/.test(direct)) return direct;
  const reference = payload.MessageSid || payload.CallSid;
  const state = payload.SequenceNumber || payload.MessageStatus || payload.SmsStatus || payload.CallStatus || payload.EventType;
  const composite = reference && state ? `${reference}:${state}` : "";
  return /^[A-Za-z0-9_.:-]{6,200}$/.test(composite) ? composite : "";
}

function safeStatus(value: string | undefined): string {
  return value && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : "unknown";
}

function safeMessageStatus(value: string | undefined): string {
  const status = safeStatus(value).toLowerCase();
  return ["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed"].includes(status)
    ? status
    : "unknown";
}

function validUuid(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
