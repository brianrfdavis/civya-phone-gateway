import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { FoundationJobClient } from "@/lib/jobs";
import {
  phoneFromSipDestination,
  phoneReferenceDigest,
  secureLinkMessage,
  sendLiveTwilioSecureLink,
} from "@/lib/integrations/twilio-messaging-live";
import { readJsonObject } from "@/lib/security/request";
import {
  createPhoneResumeUrl,
  derivePhoneResumeToken,
  ProductionSecureLinkStore,
  secureLinkTokenDigest,
} from "@/lib/secure-links/production";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDEMPOTENCY_PATTERN = /^phone_resume_[0-9a-f]{64}$/;

export async function POST(req: NextRequest) {
  if (!authorized(req.headers.get("authorization"))) return response(401, { accepted: false, code: "unauthorized" });

  try {
    const config = getRuntimeConfig();
    if (!config.features.pstn || !config.features.messages
      || config.providers.telephony !== "live" || config.providers.messaging !== "live") {
      return response(503, { accepted: false, code: "phone_resume_not_active" });
    }

    const tenantId = requiredUuid(process.env.CIVYA_WAYNE_TENANT_ID, "tenant");
    const secret = process.env.CIVYA_SECURE_LINK_SECRET?.trim() ?? "";
    const origin = process.env.CIVYA_PUBLIC_ORIGIN?.trim() ?? "";
    const body = await readJsonObject(req, 2_000);
    if (body.purpose !== "phone_resume") return response(400, { accepted: false, code: "unsupported_purpose" });
    const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      return response(400, { accepted: false, code: "invalid_idempotency_key" });
    }
    const destination = phoneFromSipDestination(typeof body.destination === "string" ? body.destination : "");
    const destinationDigest = phoneReferenceDigest(destination);
    const token = derivePhoneResumeToken({ secret, tenantId, idempotencyKey });
    const tokenDigest = secureLinkTokenDigest(token);
    const url = createPhoneResumeUrl(origin, token);
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify({ purpose: "phone_resume", destinationDigest, tokenDigest }))
      .digest("hex");

    const admin = createSupabaseAdminClient();
    const jobs = new FoundationJobClient(admin);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const links = new ProductionSecureLinkStore(admin);
    const secureLink = await links.createPhoneResume({ tenantId, tokenDigest, expiresAt, idempotencyKey });
    const claimOwner = `phone-resume:${randomUUID()}`;
    const operation = await jobs.claimExternalOperation({
      tenantId,
      providerKey: "twilio",
      operationKind: "secure_link_sms",
      idempotencyKey,
      requestSha256,
      requestMetadata: { purpose: "phone_resume", destinationDigest },
      claimOwner,
      leaseSeconds: 60,
    });
    if (operation.state === "succeeded") return response(200, { accepted: true, duplicate: true });
    if (operation.state === "in_flight" && !operation.acquired) {
      return response(409, { accepted: false, code: "delivery_outcome_pending" });
    }
    if (operation.state === "failed_unknown") {
      return response(409, { accepted: false, code: "delivery_outcome_pending" });
    }
    if (operation.state === "failed_terminal") {
      return response(409, { accepted: false, code: "delivery_not_available" });
    }
    if (!operation.acquired || !operation.claimToken) {
      return response(503, { accepted: false, code: "phone_resume_unavailable" });
    }

    try {
      const sent = await sendLiveTwilioSecureLink({ to: destination, body: secureLinkMessage(url) });
      const completed = await jobs.finishExternalOperationClaim({
        operationId: operation.id,
        claimOwner,
        claimToken: operation.claimToken,
        state: "succeeded",
        externalReference: sent.providerReferenceDigest,
        responseMetadata: { providerStatus: sent.status, purpose: "phone_resume" },
      });
      if (!completed.finished) throw new Error("The outbound operation claim became stale.");
      return response(201, { accepted: true, expires_at: secureLink.expiresAt });
    } catch {
      await jobs.finishExternalOperationClaim({
        operationId: operation.id,
        claimOwner,
        claimToken: operation.claimToken,
        state: "failed_unknown",
        errorCode: "twilio_delivery_outcome_unknown",
        responseMetadata: { purpose: "phone_resume", reconciliationRequired: true },
      }).catch(() => undefined);
      return response(503, { accepted: false, code: "delivery_outcome_unknown" });
    }
  } catch {
    return response(503, { accepted: false, code: "phone_resume_unavailable" });
  }
}

function authorized(header: string | null): boolean {
  const configured = process.env.CIVYA_INTERNAL_SERVICE_SECRET?.trim() ?? "";
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (Buffer.byteLength(configured) < 32 || !supplied) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredUuid(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`Valid ${label} identifier required.`);
  }
  return normalized;
}

function response(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
