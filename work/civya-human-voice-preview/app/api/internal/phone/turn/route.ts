import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { FoundationJobClient } from "@/lib/jobs";
import {
  processPublicPhoneTurn,
  validatePublicPhoneTurnRequest,
  validatePublicPhoneTurnResult,
} from "@/lib/phone/turn";
import { verifyPhoneTurnRequest } from "@/lib/phone/signing";
import { rateLimitRequest } from "@/lib/security/request";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_000;

export async function POST(req: NextRequest) {
  const rawBody = await readBody(req);
  if (rawBody === null) return response(413, { accepted: false, code: "phone_turn_payload_too_large" });
  const secret = process.env.CIVYA_PHONE_TURN_SERVICE_SECRET?.trim() ?? "";
  if (!verifyPhoneTurnRequest({
    rawBody,
    timestampHeader: req.headers.get("x-civya-phone-timestamp"),
    signatureHeader: req.headers.get("x-civya-phone-signature"),
    secret,
  })) {
    return response(401, { accepted: false, code: "phone_turn_unauthorized" });
  }
  const limited = rateLimitRequest(req, "phone-turn-service", 120, 60_000);
  if (limited) return limited;

  try {
    const config = getRuntimeConfig();
    if (!config.features.pstn || config.providers.telephony !== "live" || config.providers.language !== "live") {
      return response(503, { accepted: false, code: "phone_turn_not_active" });
    }
    const tenantId = requiredUuid(process.env.CIVYA_WAYNE_TENANT_ID);
    const parsed = validatePublicPhoneTurnRequest(JSON.parse(rawBody));
    const requestSha256 = createHash("sha256").update(rawBody).digest("hex");
    const processingOwner = `phone-turn:${randomUUID()}`;
    const jobs = new FoundationJobClient(createSupabaseAdminClient());
    const claim = await jobs.claimPhoneTurn({
      tenantId,
      callReferenceDigest: parsed.call_reference_digest,
      providerItemId: parsed.provider_item_id,
      idempotencyKey: parsed.idempotency_key,
      requestSha256,
      processingOwner,
      leaseSeconds: 20,
    });
    if (!claim.claimed && claim.state === "completed" && claim.responsePayload) {
      const replay = validatePublicPhoneTurnResult(claim.responsePayload, parsed.provider_item_id);
      return NextResponse.json(replay, {
        status: 200,
        headers: { "Cache-Control": "no-store", "Idempotent-Replay": "true" },
      });
    }
    if (!claim.claimed) {
      const retryAfter = Math.max(1, claim.retryAfterSeconds ?? 2);
      return NextResponse.json(
        { accepted: false, code: claim.busy ? "phone_turn_in_progress" : "phone_turn_retry_unavailable" },
        { status: claim.busy ? 409 : 503, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } },
      );
    }
    if (!claim.processingToken) return response(503, { accepted: false, code: "phone_turn_claim_unfenced" });

    try {
      const result = await processPublicPhoneTurn(parsed);
      const finished = await jobs.finishPhoneTurn({
        turnId: claim.id,
        processingOwner,
        processingToken: claim.processingToken,
        responsePayload: result as unknown as Record<string, unknown>,
      });
      if (!finished) return response(503, { accepted: false, code: "phone_turn_claim_lost" });
      return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch {
      await jobs.failPhoneTurn({
        turnId: claim.id,
        processingOwner,
        processingToken: claim.processingToken,
        errorCode: "phone_turn_resolution_failed",
      }).catch(() => false);
      return response(503, { accepted: false, code: "phone_turn_resolution_failed" });
    }
  } catch (error) {
    const code = error instanceof SyntaxError
      ? "phone_turn_invalid_json"
      : error instanceof Error && error.message.startsWith("invalid_")
        ? error.message
        : "phone_turn_unavailable";
    return response(code === "phone_turn_unavailable" ? 503 : 400, { accepted: false, code });
  }
}

async function readBody(req: NextRequest): Promise<string | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  const raw = await req.text();
  return Buffer.byteLength(raw, "utf8") <= MAX_BODY_BYTES ? raw : null;
}

function requiredUuid(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error("phone_turn_tenant_invalid");
  }
  return normalized;
}

function response(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
