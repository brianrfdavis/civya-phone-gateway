import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest, readJsonObject } from "@/lib/security/request";
import { ProductionSecureLinkStore } from "@/lib/secure-links/production";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const limited = rateLimitRequest(req, "phone-resume-consume", 8, 10 * 60 * 1_000);
  if (limited) return limited;
  try {
    const body = await readJsonObject(req, 1_000);
    const token = typeof body.token === "string" ? body.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return unavailable();
    const tenantId = process.env.CIVYA_WAYNE_TENANT_ID?.trim() ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      return unavailable(503);
    }
    const result = await new ProductionSecureLinkStore(createSupabaseAdminClient())
      .consumePhoneResume({ tenantId, token });
    if (!result.consumed || result.caseId || result.handoffSessionId) return unavailable();
    return NextResponse.json(
      {
        consumed: true,
        next: "/?help=human",
        message: "Your secure link is confirmed. You can continue in Civya or ask for a person.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable(503);
  }
}

function unavailable(status = 400): NextResponse {
  return NextResponse.json(
    { consumed: false, message: "This secure link is invalid, expired, or already used. Request a new link or ask for a person." },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
