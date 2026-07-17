import { NextRequest, NextResponse } from "next/server";
import { unauthenticatedBootstrap, withAuthenticationState } from "@/lib/conversation/bootstrap";
import { getRuntimeConfig } from "@/lib/config/runtime";
import {
  CivyaPlatform,
  PlatformConfigurationError,
  bootstrapSession,
  getSessionPrincipal,
  isSupabaseConfigured,
} from "@/lib/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasCaseEntitlementSession } from "@/lib/entitlement/guard";
import { grantDemoAccessFromRequest } from "@/lib/security/demo-access";
import { rateLimitRequest, readJsonObject, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const limited = rateLimitRequest(req, "anonymous-identity", 8, 60 * 60 * 1_000);
    if (limited) return limited;
    if (!isSupabaseConfigured()) throw new PlatformConfigurationError();
    const runtimeConfig = getRuntimeConfig();

    const client = await createSupabaseServerClient();
    let { data: userData } = await client.auth.getUser();
    if (!userData.user) {
      const body = req.headers.get("content-length") === "0" ? {} : await readJsonObject(req);
      const turnstileToken = typeof body.turnstile_token === "string"
        ? body.turnstile_token
        : typeof body.turnstileToken === "string"
          ? body.turnstileToken
          : undefined;
      const hosted = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
      if (hosted && process.env.CIVYA_SUPABASE_CAPTCHA_ENFORCED !== "true") {
        return NextResponse.json(
          {
            error: "Anonymous access protection is not configured.",
            code: "service_misconfigured",
          },
          { status: 503 },
        );
      }
      if (hosted && !turnstileToken) {
        return NextResponse.json(
          { error: "Please complete the quick human check and try again.", code: "human_check_required" },
          { status: 403 },
        );
      }
      // Supabase Auth validates this single-use Turnstile token. Enforcing the
      // challenge at Auth itself also blocks callers that bypass this route and
      // invoke anonymous signup with the public project key.
      const { error } = await client.auth.signInAnonymously(
        turnstileToken ? { options: { captchaToken: turnstileToken } } : undefined,
      );
      if (error) throw error;
      userData = (await client.auth.getUser()).data;
    }

    const principal = await getSessionPrincipal(client);
    if (!principal) throw new Error("Anonymous session could not be established.");
    const platform = new CivyaPlatform(client, principal);
    if (principal.isVerified) {
      return NextResponse.json(
        {
          ok: true,
          account: { state: "verified" },
          entitlement: { state: await hasCaseEntitlementSession(req, platform) ? "verified" : "required" },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!runtimeConfig.syntheticMode) {
      const bootstrap = withAuthenticationState(
        unauthenticatedBootstrap({ fictional: false }),
        "anonymous",
      );
      bootstrap.persistence = { state: "saved" };
      bootstrap.capabilities.voice = false;
      bootstrap.capabilities.uploads = false;
      bootstrap.capabilities.reminders = false;
      return NextResponse.json(
        { ok: true, bootstrap },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    await grantDemoAccessFromRequest(req, platform);
    let bootstrap = await bootstrapSession(platform);
    const declined = Boolean(userData.user?.user_metadata?.civya_intake_declined_at);
    if (declined && !principal.isVerified) bootstrap = withAuthenticationState(bootstrap, "declined");
    return NextResponse.json({ ok: true, bootstrap }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
