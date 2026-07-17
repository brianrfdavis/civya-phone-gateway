import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { bootstrapSession, createRequestPlatform } from "@/lib/platform";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { sanitizePendingTask } from "@/lib/auth/contracts";
import { setAccountFlow } from "@/lib/auth/flow-state";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    if (process.env.CIVYA_AUTH_PASSKEY_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Passkeys are not available for this deployment.", code: "passkey_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const platform = await createRequestPlatform();
    if (!platform) throw new RequestError(401, "Start a Civya conversation before using a passkey.", "authentication_required");
    if (platform.principal.isVerified) throw new RequestError(409, "This Civya account is already signed in.", "already_verified");
    if (!getRuntimeConfig().syntheticMode) {
      throw new RequestError(
        409,
        "Passkey sign-in is available after County-bound account activation. Use account recovery or ask for help.",
        "county_case_binding_required",
      );
    }
    const limited = rateLimitRequest(req, "passkey-account-start", 6, 10 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;
    const body = await readJsonObject(req);
    const bootstrap = await bootstrapSession(platform);
    if (!bootstrap.active_case) throw new RequestError(409, "Your private conversation could not be prepared.", "resume_unavailable");
    const caseAccess = await platform.getCaseAccessBinding(bootstrap.active_case.id);
    const transferToken = (await platform.createCaseTransferGrant(bootstrap.active_case.id, 10 * 60)).token;
    const state = {
      kind: "passkey" as const,
      nonce: crypto.randomUUID(),
      sourceUserId: platform.principal.userId,
      transferToken,
      caseAccess,
      pendingTask: sanitizePendingTask(body.pending_task),
      exp: Date.now() + 10 * 60 * 1_000,
    };
    const response = NextResponse.json(
      { ok: true, challenge_id: state.nonce, expires_at: new Date(state.exp).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAccountFlow(response, state);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
