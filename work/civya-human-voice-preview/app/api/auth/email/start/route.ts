import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { maskEmail } from "@/lib/conversation/privacy";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { hasCaseEntitlementSession } from "@/lib/entitlement/guard";
import { bootstrapSession, createRequestPlatform } from "@/lib/platform";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import {
  emailChallengeHash,
  setUpgradeState,
  type UpgradeState,
} from "@/lib/security/upgrade-state";

export const runtime = "nodejs";

const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

function isExistingIdentityError(error: { code?: string; message?: string }): boolean {
  return /(?:already|exists|registered|identity.*linked)/i.test(`${error.code || ""} ${error.message || ""}`);
}

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "No active conversation session.", code: "authentication_required" }, { status: 401 });
    if (platform.principal.isVerified) {
      return NextResponse.json(
        {
          ok: true,
          already_verified: true,
          account: { state: "verified" },
          entitlement: { state: await hasCaseEntitlementSession(req, platform) ? "verified" : "required" },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!getRuntimeConfig().syntheticMode) {
      throw new RequestError(
        409,
        "This controlled launch can sign in only an account already connected to a County case. Use account recovery or ask for help.",
        "county_case_binding_required",
      );
    }
    const limited = rateLimitRequest(req, "email-code-start", 4, 10 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;

    const body = await readJsonObject(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const pendingTurnId = typeof body.pending_turn_id === "string"
      ? body.pending_turn_id.slice(0, 200)
      : typeof body.pendingTurnId === "string"
        ? body.pendingTurnId.slice(0, 200)
        : undefined;
    if (!EMAIL.test(email) || email.length > 254) throw new RequestError(400, "Enter a valid email address.");
    const bootstrap = await bootstrapSession(platform);
    if (!bootstrap.resident || !bootstrap.active_case || !bootstrap.conversation) {
      throw new Error("The current case could not be prepared for verification.");
    }
    const caseAccess = await platform.getCaseAccessBinding(bootstrap.active_case.id);

    let mode: UpgradeState["mode"] = "link_anonymous";
    let transferToken: string | undefined;
    const { error: linkError } = await platform.client.auth.updateUser({ email });
    if (linkError) {
      if (!isExistingIdentityError(linkError)) throw linkError;
      mode = "existing_account";
      transferToken = (await platform.createCaseTransferGrant(bootstrap.active_case.id, 10 * 60)).token;
      const { error: signInError } = await platform.client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      if (signInError) throw signInError;
    }

    const now = Date.now();
    const state: UpgradeState = {
      mode,
      sourceUserId: platform.principal.userId,
      residentId: bootstrap.resident.id,
      caseId: bootstrap.active_case.id,
      conversationId: bootstrap.conversation.id,
      pendingTurnId,
      transferToken,
      caseAccess,
      emailHash: emailChallengeHash(email),
      exp: now + 10 * 60 * 1_000,
      nonce: crypto.randomUUID(),
    };
    const response = NextResponse.json(
      {
        ok: true,
        challenge_id: state.nonce,
        masked_email: maskEmail(email),
        expires_at: new Date(state.exp).toISOString(),
        resend_after: new Date(now + 60_000).toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    setUpgradeState(response, state);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
