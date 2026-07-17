import { NextRequest, NextResponse } from "next/server";
import { InMemoryWebhookReplayGuard, verifyStandardWebhook } from "@/lib/integrations/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replayGuard = new InMemoryWebhookReplayGuard();
const ALLOWED_EVENT_TYPES = new Set(["response.completed", "response.failed", "batch.completed", "batch.failed"]);

export async function POST(request: NextRequest) {
  if (process.env.CIVYA_PROVIDER_MODE !== "synthetic") {
    return NextResponse.json(
      { error: "OpenAI webhook ingestion is disabled until a durable event sink is configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > 256_000) {
    return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
  }
  const verification = verifyStandardWebhook({
    secret: process.env.OPENAI_WEBHOOK_SECRET ?? "",
    rawBody,
    headers: request.headers,
    replayGuard,
    toleranceSeconds: 300,
  });
  if (!verification.valid) {
    return NextResponse.json(
      { error: "Invalid or replayed webhook.", reason: verification.reason },
      { status: verification.duplicate ? 200 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  let event: { id?: string; type?: string; data?: { id?: string } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!event.id || event.id !== verification.eventId || !event.type || !ALLOWED_EVENT_TYPES.has(event.type)) {
    return NextResponse.json({ error: "Unsupported or mismatched event." }, { status: 400 });
  }
  return NextResponse.json(
    {
      accepted: true,
      event_id: verification.eventId,
      event_type: event.type,
      authority: "provider_job_receipt_only",
      may_mutate_case_state: false,
      synthetic_sink: true,
    },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
