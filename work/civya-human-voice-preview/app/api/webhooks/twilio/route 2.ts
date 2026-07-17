import { NextRequest, NextResponse } from "next/server";
import {
  InMemoryWebhookReplayGuard,
  type TwilioParameters,
  verifyTwilioWebhook,
} from "@/lib/integrations/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replayGuard = new InMemoryWebhookReplayGuard();

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function addParameter(target: TwilioParameters, key: string, value: string): void {
  const existing = target[key];
  if (existing === undefined) target[key] = value;
  else target[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
}

export async function POST(request: NextRequest) {
  if (process.env.CIVYA_PROVIDER_MODE !== "synthetic") {
    return NextResponse.json(
      { error: "Twilio webhook ingestion is disabled until durable receipt processing is configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const publicWebhookUrl = process.env.CIVYA_TWILIO_WEBHOOK_URL ?? "";
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > 256_000) {
    return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  let payload: Record<string, unknown> = {};
  let parameters: TwilioParameters | undefined;
  try {
    if (contentType.includes("application/json")) payload = JSON.parse(rawBody) as Record<string, unknown>;
    else {
      parameters = {};
      for (const [key, value] of new URLSearchParams(rawBody)) addParameter(parameters, key, value);
      payload = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    }
  } catch {
    return NextResponse.json({ error: "Invalid Twilio payload." }, { status: 400 });
  }
  const providerEventId = String(payload.EventSid ?? request.headers.get("x-civya-webhook-id") ?? "");
  const eventId = providerEventId || [payload.CallSid ?? payload.MessageSid, payload.SequenceNumber, payload.CallStatus ?? payload.MessageStatus ?? payload.EventType]
    .filter(Boolean)
    .join(":");
  const occurredAtSeconds = parseTimestamp(
    request.headers.get("x-civya-webhook-timestamp") ?? String(payload.Timestamp ?? payload.DateCreated ?? ""),
  );
  const verification = verifyTwilioWebhook({
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    signature: request.headers.get("x-twilio-signature") ?? undefined,
    url: publicWebhookUrl,
    rawBody,
    contentType,
    parameters,
    eventId,
    occurredAtSeconds,
    replayGuard,
    toleranceSeconds: 300,
    requireReplayTimestamp: true,
  });
  if (!verification.valid) {
    return NextResponse.json(
      { error: "Invalid or replayed Twilio webhook.", reason: verification.reason },
      { status: verification.duplicate ? 200 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
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
