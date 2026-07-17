import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import { setStaffAuthState, staffEmailHash } from "@/lib/security/staff-auth-state";
import { authorizeStaffEmail, resolveStaffTenantSlug } from "@/lib/staff/access";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const CHALLENGE_TTL_MS = 10 * 60 * 1_000;

export async function POST(req: NextRequest) {
  try {
    const ipLimited = rateLimitRequest(req, "staff-email-code-start-ip", 12, 60 * 60 * 1_000);
    if (ipLimited) return ipLimited;

    const body = await readJsonObject(req, 2_000);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) {
      throw new RequestError(400, "Enter a valid email address.");
    }
    const emailLimited = rateLimitRequest(req, "staff-email-code-start-address", 4, 15 * 60 * 1_000, email);
    if (emailLimited) return emailLimited;

    const tenantSlug = resolveStaffTenantSlug(req.headers.get("host"));
    const authorization = await authorizeStaffEmail(tenantSlug, email);

    if (authorization.authorized && authorization.tenantSlug === tenantSlug) {
      const client = await createSupabaseServerClient();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });

      // Deliberately do not reveal whether delivery succeeded. Verification
      // independently re-checks the exact host-bound role after OTP exchange.
      if (error) console.info("Staff email-code request was not delivered.", error.code || "auth_error");
    }

    const now = Date.now();
    const state = {
      emailHash: staffEmailHash(email),
      tenantSlug,
      nonce: crypto.randomUUID(),
      exp: now + CHALLENGE_TTL_MS,
    };
    const response = NextResponse.json(
      {
        ok: true,
        challenge_id: state.nonce,
        message: "If that email belongs to an authorized reviewer or administrator for this county workspace, a six-digit code is on its way.",
        expires_at: new Date(state.exp).toISOString(),
        resend_after: new Date(now + 60_000).toISOString(),
      },
      {
        status: 202,
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      },
    );
    setStaffAuthState(response, state);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
