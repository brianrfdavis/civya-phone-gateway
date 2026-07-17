import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  CivyaPlatform,
  createAdminPlatform,
  getSessionPrincipal,
} from "@/lib/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  clearAccountRecoveryState,
  normalizeRecoveryEmail,
  readAccountRecoveryState,
  recoveryEmailDigest,
  recoveryNonceDigest,
} from "@/lib/auth/recovery-state";
import { clearAccountFlow, clearAccountResume } from "@/lib/auth/flow-state";
import {
  clearEntitlementAssistance,
  clearEntitlementGrant,
  clearEntitlementSelection,
  clearPendingEntitlement,
  setPendingEntitlement,
} from "@/lib/entitlement/grant";
import { clearUpgradeState } from "@/lib/security/upgrade-state";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const limited = rateLimitRequest(req, "account-recovery-verify", 8, 15 * 60 * 1_000);
    if (limited) return limited;
    const state = readAccountRecoveryState(req);
    if (!state) throw new RequestError(400, "The recovery code has expired. Start again.", "expired");
    const body = await readJsonObject(req);
    const email = normalizeRecoveryEmail(body.email);
    const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    if (body.challenge_id !== state.challengeId
      || !equalDigest(recoveryEmailDigest(email), state.emailDigest)) {
      throw new RequestError(400, "The recovery challenge is no longer active.", "expired");
    }
    if (!/^\d{6}$/.test(code)) throw new RequestError(400, "Enter the six-digit code.", "invalid_code");

    const client = await createSupabaseServerClient();
    const { error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) {
      await createAdminPlatform().resolveAccountRecoveryChallenge({
        challengeId: state.challengeId,
        nonceDigest: recoveryNonceDigest(state.nonce),
        result: "failed",
      }).catch(() => undefined);
      return NextResponse.json(
        { error: "That code is invalid or expired. Request a new code if needed.", code: "invalid_code" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const principal = await getSessionPrincipal(client);
    if (!principal?.isVerified) throw new Error("Recovery did not produce a verified account.");
    const resolved = await createAdminPlatform().resolveAccountRecoveryChallenge({
      challengeId: state.challengeId,
      nonceDigest: recoveryNonceDigest(state.nonce),
      result: "verified",
      actorUserId: principal.userId,
    });
    if (resolved.state !== "verified" || resolved.correlationId !== state.correlationId) {
      throw new RequestError(400, "The recovery challenge could not be completed.", "recovery_unavailable");
    }
    const platform = new CivyaPlatform(client, principal);
    const caseAccess = await platform.getRecoveryCaseAccessBinding();
    const exp = Date.now() + 10 * 60 * 1_000;
    const response = NextResponse.json(
      {
        ok: true,
        account: { state: "verified" },
        entitlement: { state: caseAccess ? "required" : "no_active_case" },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    clearEntitlementGrant(response);
    clearEntitlementSelection(response);
    clearPendingEntitlement(response);
    clearEntitlementAssistance(response);
    clearAccountFlow(response);
    clearAccountResume(response);
    clearUpgradeState(response);
    clearAccountRecoveryState(response);
    if (caseAccess) {
      setPendingEntitlement(response, {
        userId: principal.userId,
        sourceUserId: principal.userId,
        caseAccess,
        pendingTask: { action: "resume", reason: "account_recovery" },
        exp,
      });
    }
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
