import OpenAI, { InvalidWebhookSignatureError } from "openai";
import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { fetchWithTimeout } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 256_000;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BYTES) {
    return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
  }
  const secret = process.env.OPENAI_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { accepted: false, code: "openai_webhook_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let event: Awaited<ReturnType<OpenAI["webhooks"]["unwrap"]>>;
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "webhook-validation-only", webhookSecret: secret });
    event = await client.webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    const code = error instanceof InvalidWebhookSignatureError ? "invalid_webhook_signature" : "invalid_webhook";
    return NextResponse.json({ accepted: false, code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  if (event.type !== "realtime.call.incoming") {
    return NextResponse.json(
      { accepted: true, ignored: true, event_type: event.type },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  let telephonyMode: "disabled" | "synthetic" | "live";
  try {
    telephonyMode = getRuntimeConfig().providers.telephony;
  } catch {
    return NextResponse.json(
      { accepted: false, code: "runtime_configuration_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (telephonyMode === "synthetic") {
    return NextResponse.json(
      { accepted: true, event_type: event.type, authority: "synthetic_call_receipt_only", may_mutate_case_state: false },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  const destination = callControlWebhookUrl(process.env.CIVYA_CALL_CONTROL_BASE_URL);
  if (!destination || process.env.CIVYA_ENABLE_PSTN !== "true" || telephonyMode !== "live") {
    return NextResponse.json(
      { accepted: false, code: "call_control_not_active" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const upstream = await fetchWithTimeout(destination, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") || "application/json",
        "webhook-id": request.headers.get("webhook-id") || "",
        "webhook-timestamp": request.headers.get("webhook-timestamp") || "",
        "webhook-signature": request.headers.get("webhook-signature") || "",
      },
      body: rawBody,
      cache: "no-store",
    }, 12_000);
    return NextResponse.json(
      { accepted: upstream.ok, forwarded: true, event_type: event.type },
      { status: upstream.status, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { accepted: false, code: "call_control_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function callControlWebhookUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    const base = new URL(raw);
    const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
    if (!local && base.protocol !== "https:") return null;
    if (base.username || base.password) return null;
    base.pathname = "/webhooks/openai";
    base.search = "";
    base.hash = "";
    return base;
  } catch {
    return null;
  }
}
