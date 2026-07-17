import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { bootstrapSession, createRequestPlatform } from "@/lib/platform";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import { sanitizePendingTask } from "@/lib/auth/contracts";
import { setAccountFlow } from "@/lib/auth/flow-state";
import {
  isCivyaOAuthProvider,
  oauthCapabilities,
  oauthProviderConfig,
  trustedPublicOrigin,
} from "@/lib/auth/providers";

export const runtime = "nodejs";

export async function GET() {
  const capabilities = oauthCapabilities();
  const providers = getRuntimeConfig().syntheticMode
    ? capabilities
    : capabilities.map((provider) => ({
        ...provider,
        available: false,
        unavailable_reason: "Available after County-bound account activation.",
      }));
  return NextResponse.json({ providers }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) throw new RequestError(401, "Start a Civya conversation before choosing an account.", "authentication_required");
    if (platform.principal.isVerified) throw new RequestError(409, "This Civya account is already signed in.", "already_verified");
    if (!getRuntimeConfig().syntheticMode) {
      throw new RequestError(
        409,
        "This controlled launch can sign in only an account already connected to a County case. Use account recovery or ask for help.",
        "county_case_binding_required",
      );
    }
    const limited = rateLimitRequest(req, "oauth-account-start", 8, 10 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;
    const body = await readJsonObject(req);
    if (!isCivyaOAuthProvider(body.provider)) throw new RequestError(400, "Choose a supported account provider.", "invalid_provider");
    const provider = oauthProviderConfig(body.provider);
    if (!provider.enabled) {
      return NextResponse.json(
        { error: `${provider.label} sign-in is not available for this deployment.`, code: "provider_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const bootstrap = await bootstrapSession(platform);
    if (!bootstrap.active_case || !bootstrap.conversation) {
      throw new RequestError(409, "Your private conversation could not be prepared. Try again.", "resume_unavailable");
    }
    const caseAccess = await platform.getCaseAccessBinding(bootstrap.active_case.id);
    const transferToken = (await platform.createCaseTransferGrant(bootstrap.active_case.id, 15 * 60)).token;
    const nonce = crypto.randomUUID();
    const origin = trustedPublicOrigin(req);
    const callback = `${origin}/api/auth/oauth/callback?flow=${encodeURIComponent(nonce)}`;
    const { data, error } = await platform.client.auth.signInWithOAuth({
      provider: provider.supabase,
      options: {
        redirectTo: callback,
        scopes: provider.scopes,
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url) throw error || new Error("The account provider did not return a secure sign-in URL.");
    const state = {
      kind: "oauth" as const,
      nonce,
      sourceUserId: platform.principal.userId,
      transferToken,
      caseAccess,
      provider: body.provider,
      pendingTask: sanitizePendingTask(body.pending_task),
      exp: Date.now() + 15 * 60 * 1_000,
    };
    const response = NextResponse.json(
      { authorization_url: data.url, provider: body.provider, expires_at: new Date(state.exp).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAccountFlow(response, state);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
