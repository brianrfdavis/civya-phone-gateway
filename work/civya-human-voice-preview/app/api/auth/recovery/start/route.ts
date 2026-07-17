import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAdminPlatform } from "@/lib/platform";
import {
  normalizeRecoveryEmail,
  recoveryEmailDigest,
  recoveryNonceDigest,
  setAccountRecoveryState,
} from "@/lib/auth/recovery-state";
import { rateLimitRequest, readJsonObject, requestErrorResponse } from "@/lib/security/request";

const EMAIL = /^\S+@\S+\.\S+$/;

export async function POST(req: NextRequest) {
  try {
    const limited = rateLimitRequest(req, "account-recovery", 4, 15 * 60 * 1_000);
    if (limited) return limited;
    const body = await readJsonObject(req);
    const email = normalizeRecoveryEmail(body.email);
    const nonce = crypto.randomBytes(32).toString("base64url");
    const correlationId = crypto.randomUUID();
    const exp = Date.now() + 10 * 60 * 1_000;
    const emailDigest = recoveryEmailDigest(email);
    const challenge = await createAdminPlatform().createAccountRecoveryChallenge({
      emailDigest,
      nonceDigest: recoveryNonceDigest(nonce),
      correlationId,
      expiresAt: exp,
      idempotencyKey: `recovery:${crypto.randomUUID()}`,
    });
    if (EMAIL.test(email)) {
      const client = await createSupabaseServerClient();
      // Do not disclose whether an account exists. Supabase sends only for a
      // known account because account recovery must never create one.
      await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }).catch(() => undefined);
    }
    const response = NextResponse.json(
      {
        ok: true,
        challenge_id: challenge.challengeId,
        expires_at: new Date(exp).toISOString(),
        message: "If a Civya account uses that email, a sign-in code is on its way.",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
    setAccountRecoveryState(response, {
      challengeId: challenge.challengeId,
      correlationId,
      emailDigest,
      nonce,
      exp,
    });
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
