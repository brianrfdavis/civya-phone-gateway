import { NextRequest, NextResponse } from "next/server";
import {
  CivyaPlatform,
  createRequestPlatform,
  getSessionPrincipal,
  markIdentityVerified,
} from "@/lib/platform";
import { maskEmail } from "@/lib/conversation/privacy";
import { getRuntimeConfig } from "@/lib/config/runtime";
import {
  clearEntitlementGrant,
  setPendingEntitlement,
} from "@/lib/entitlement/grant";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import {
  clearUpgradeState,
  emailChallengeHash,
  readUpgradeState,
} from "@/lib/security/upgrade-state";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    if (!getRuntimeConfig().syntheticMode) {
      throw new RequestError(
        409,
        "This controlled launch can sign in only an account already connected to a County case. Use account recovery or ask for help.",
        "county_case_binding_required",
      );
    }
    const sourcePlatform = await createRequestPlatform();
    if (!sourcePlatform) return NextResponse.json({ error: "No active verification session.", code: "authentication_required" }, { status: 401 });
    const limited = rateLimitRequest(req, "email-code-verify", 10, 10 * 60 * 1_000, sourcePlatform.principal.userId);
    if (limited) return limited;
    const state = readUpgradeState(req);
    if (!state) throw new RequestError(400, "The email code has expired. Request a new code.", "expired");

    const body = await readJsonObject(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    const challengeId = typeof body.challenge_id === "string" ? body.challenge_id : undefined;
    if (!email || emailChallengeHash(email) !== state.emailHash) throw new RequestError(400, "This code does not match the email challenge.");
    if (!/^\d{6}$/.test(code)) throw new RequestError(400, "Enter the six-digit code.", "invalid_code");
    if (challengeId && challengeId !== state.nonce) throw new RequestError(400, "This verification challenge is no longer active.", "expired");
    if (state.mode === "link_anonymous" && sourcePlatform.principal.userId !== state.sourceUserId) {
      throw new RequestError(403, "The verification session changed. Start the account step again.", "forbidden");
    }

    const { error: verifyError } = await sourcePlatform.client.auth.verifyOtp({
      email,
      token: code,
      type: state.mode === "link_anonymous" ? "email_change" : "email",
    });
    if (verifyError) {
      return NextResponse.json(
        { error: "That code is invalid or expired. Request a new code if needed.", code: "invalid_code" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const principal = await getSessionPrincipal(sourcePlatform.client);
    if (!principal || !principal.isVerified) throw new Error("Email verification did not produce a verified session.");
    if (state.mode === "link_anonymous" && principal.userId !== state.sourceUserId) {
      throw new Error("The linked identity changed the resident user unexpectedly.");
    }
    const verifiedPlatform = new CivyaPlatform(sourcePlatform.client, principal);

    const { data: current } = await verifiedPlatform.client.auth.getUser();
    const metadata = { ...(current.user?.user_metadata || {}) };
    delete metadata.civya_intake_declined_at;
    const { error: metadataError } = await verifiedPlatform.client.auth.updateUser({ data: metadata });
    if (metadataError) throw metadataError;

    if (state.mode === "existing_account" && !state.transferToken) {
      throw new Error("The case transfer grant is missing.");
    }
    if (state.mode === "link_anonymous") {
      // This updates identity metadata only. Case data remains unavailable
      // until the exact County entitlement tuple is independently verified.
      await markIdentityVerified(verifiedPlatform);
    }
    const pendingTask = {
      turnId: state.pendingTurnId,
      action: "resume" as const,
      reason: "saved_action",
    };
    const response = NextResponse.json(
      {
        ok: true,
        code: "entitlement_required",
        auth: { state: "verified", masked_email: principal.email ? maskEmail(principal.email) : undefined },
        entitlement: { state: "required" },
        resume: { pending_task: pendingTask },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    setPendingEntitlement(response, {
      userId: principal.userId,
      sourceUserId: state.sourceUserId,
      transferToken: state.transferToken,
      caseAccess: state.caseAccess,
      pendingTask,
      exp: state.exp,
    });
    clearEntitlementGrant(response);
    clearUpgradeState(response);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
