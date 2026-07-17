import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { assertNoPaymentCredentials } from "@/lib/integrations/payments";
import {
  type AuthoritativePaymentObligationSource,
  type ContractedPaymentWebhookVerifier,
  PaymentActivationError,
  readPaymentActivationConfig,
  SupabasePaymentHandoffStore,
  verifyAndReconcilePaymentWebhook,
} from "@/lib/integrations/payment-handoff.server";
import { InMemoryWebhookReplayGuard, verifyStandardWebhook } from "@/lib/integrations/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replayGuard = new InMemoryWebhookReplayGuard();
const STATUSES = new Set(["pending", "posted", "returned", "reversed", "refunded", "disputed", "failed", "unmatched"]);

export async function POST(request: NextRequest) {
  const paymentMode = getRuntimeConfig().providers.paymentHandoff;
  if (paymentMode === "live") return ingestLivePaymentEvidence(request);
  if (paymentMode === "disabled") {
    return NextResponse.json(
      { error: "Payment evidence ingestion is not enabled.", code: "payment_handoff_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > 256_000) {
    return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
  }
  const verification = verifyStandardWebhook({
    secret: process.env.CIVYA_PAYMENT_WEBHOOK_SECRET ?? "",
    rawBody,
    headers: request.headers,
    replayGuard,
    toleranceSeconds: 300,
  });
  if (!verification.valid) {
    return NextResponse.json(
      { error: "Invalid or replayed payment webhook.", reason: verification.reason },
      { status: verification.duplicate ? 200 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
    assertNoPaymentCredentials(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid payment event." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (payload.event_id !== verification.eventId || !STATUSES.has(String(payload.payment_status ?? ""))) {
    return NextResponse.json({ error: "Unsupported or mismatched payment event." }, { status: 400 });
  }
  return NextResponse.json(
    {
      accepted: true,
      event_id: verification.eventId,
      candidate_status: payload.payment_status,
      authority: "candidate_authoritative_record",
      may_set_completion: false,
      requires_correct_obligation_parcel_tax_year_reconciliation: true,
      synthetic_sink: true,
    },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

interface ContractedPaymentEvidenceRuntime {
  verifier: ContractedPaymentWebhookVerifier;
  obligationSource: AuthoritativePaymentObligationSource;
}

function contractedPaymentEvidenceRuntime(): ContractedPaymentEvidenceRuntime {
  // The County/J.P. Morgan webhook schema and signature method are not yet
  // available. Do not substitute Civya's synthetic HMAC contract in live mode.
  throw new PaymentActivationError("provider_contract_unavailable");
}

async function ingestLivePaymentEvidence(request: NextRequest): Promise<NextResponse> {
  try {
    const config = readPaymentActivationConfig();
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 256_000) {
      return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > 256_000) {
      return NextResponse.json({ error: "Webhook payload too large." }, { status: 413 });
    }
    const contracted = contractedPaymentEvidenceRuntime();
    const result = await verifyAndReconcilePaymentWebhook({
      rawBody,
      headers: request.headers,
      verifier: contracted.verifier,
      dependencies: {
        config,
        store: new SupabasePaymentHandoffStore(),
        obligationSource: contracted.obligationSource,
      },
    });
    return NextResponse.json(
      {
        accepted: true,
        duplicate: result.duplicate,
        verified_completion: result.decision.verifiedCompletion,
        authority: "authoritative_reconciliation",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PaymentActivationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, activation_blocker: error.reason },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Payment evidence could not be verified or reconciled." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
