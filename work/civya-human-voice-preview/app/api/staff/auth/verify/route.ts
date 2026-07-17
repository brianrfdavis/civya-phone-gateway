import { NextRequest, NextResponse } from "next/server";
import { CivyaPlatform, getSessionPrincipal, staffBootstrap } from "@/lib/platform";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import {
  clearStaffAuthState,
  readStaffAuthState,
  staffEmailHash,
} from "@/lib/security/staff-auth-state";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveStaffTenantSlug } from "@/lib/staff/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function denyAndSignOut(client: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  const response = NextResponse.json(
    {
      error: "This email is not authorized as an active reviewer or administrator for this county workspace.",
      code: "staff_access_denied",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
  clearStaffAuthState(response);
  return response;
}

export async function POST(req: NextRequest) {
  try {
    const ipLimited = rateLimitRequest(req, "staff-email-code-verify-ip", 30, 10 * 60 * 1_000);
    if (ipLimited) return ipLimited;

    const state = readStaffAuthState(req);
    if (!state) throw new RequestError(400, "The email code has expired. Request a new code.", "expired");
    const challengeLimited = rateLimitRequest(req, "staff-email-code-verify-challenge", 8, 10 * 60 * 1_000, state.nonce);
    if (challengeLimited) return challengeLimited;

    const body = await readJsonObject(req, 2_000);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    const challengeId = typeof body.challenge_id === "string" ? body.challenge_id : "";
    const expectedTenant = resolveStaffTenantSlug(req.headers.get("host"));
    if (
      !email
      || staffEmailHash(email) !== state.emailHash
      || challengeId !== state.nonce
      || state.tenantSlug !== expectedTenant
    ) {
      throw new RequestError(400, "This verification challenge is no longer active.", "expired");
    }
    if (!/^\d{6}$/.test(code)) throw new RequestError(400, "Enter the six-digit code.", "invalid_code");

    const client = await createSupabaseServerClient();
    const { error: verifyError } = await client.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (verifyError) {
      return NextResponse.json(
        { error: "That code is invalid or expired. Request a new code if needed.", code: "invalid_code" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const principal = await getSessionPrincipal(client);
    if (!principal || principal.isAnonymous || !principal.isVerified) {
      return denyAndSignOut(client);
    }

    try {
      const staff = await staffBootstrap(new CivyaPlatform(client, principal), expectedTenant);
      if (staff.tenant.slug !== expectedTenant) {
        return denyAndSignOut(client);
      }

      const response = NextResponse.json(
        {
          ok: true,
          redirect_to: "/staff",
          staff: { role: staff.role },
          tenant: {
            name: staff.tenant.name,
            slug: staff.tenant.slug,
            environment: staff.tenant.environment,
            fictional: staff.tenant.fictional,
          },
        },
        { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
      );
      clearStaffAuthState(response);
      return response;
    } catch {
      return denyAndSignOut(client);
    }
  } catch (error) {
    return requestErrorResponse(error);
  }
}
