import { NextRequest, NextResponse } from "next/server";
import { redeemDemoInvitation } from "@/lib/platform";
import { setDemoAccessCookie } from "@/lib/security/demo-access";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import { requireSyntheticSandboxHost } from "@/lib/security/synthetic-sandbox";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const limited = rateLimitRequest(req, "demo-invitation", 10, 60 * 60 * 1_000);
    if (limited) return limited;
    // Resolve the exact fictional tenant before the service-only redemption
    // transaction can consume one invitation use.
    const expectedTenant = requireSyntheticSandboxHost(req);
    const body = await readJsonObject(req, 2_000);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new RequestError(400, "This county demo invitation is not valid.");
    const grant = await redeemDemoInvitation(token, expectedTenant);
    if (grant.tenantSlug !== expectedTenant) {
      throw new RequestError(403, "This invitation is for a different county demo.", "forbidden");
    }
    if (!grant.scopes.some((scope) => scope === "resident_demo" || scope === "staff_demo")) {
      throw new RequestError(403, "This invitation does not grant access to the Civya demo.", "forbidden");
    }
    const invitationExpiry = new Date(grant.expiresAt);
    const maxCookieExpiry = new Date(Date.now() + 8 * 60 * 60 * 1_000);
    const expiresAt = invitationExpiry < maxCookieExpiry ? invitationExpiry : maxCookieExpiry;
    const response = NextResponse.json(
      { ok: true, tenant: grant.tenantSlug, expires_at: expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
    setDemoAccessCookie(response, {
      tenant: grant.tenantSlug,
      invitation: grant.invitationId,
      expiresAt,
    });
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
