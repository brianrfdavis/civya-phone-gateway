import { NextRequest, NextResponse } from "next/server";
import { unauthenticatedBootstrap, withAuthenticationState } from "@/lib/conversation/bootstrap";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { hasCaseEntitlementSession } from "@/lib/entitlement/guard";
import { bootstrapSession, createRequestPlatform } from "@/lib/platform";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "No active session.", code: "authentication_required" }, { status: 401 });
    if (platform.principal.isVerified) {
      return NextResponse.json(
        {
          ok: true,
          general_only: true,
          account: { state: "verified" },
          entitlement: { state: await hasCaseEntitlementSession(req, platform) ? "verified" : "required" },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const { data: current } = await platform.client.auth.getUser();
    const { error } = await platform.client.auth.updateUser({
      data: {
        ...(current.user?.user_metadata || {}),
        civya_intake_declined_at: new Date().toISOString(),
      },
    });
    if (error) throw error;
    const config = getRuntimeConfig();
    const bootstrap = config.syntheticMode
      ? withAuthenticationState(await bootstrapSession(platform), "declined")
      : withAuthenticationState(unauthenticatedBootstrap({ fictional: false }), "declined");
    if (!config.syntheticMode) bootstrap.persistence = { state: "saved" };
    return NextResponse.json(
      { ok: true, general_only: true, bootstrap },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
