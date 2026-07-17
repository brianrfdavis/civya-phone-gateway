import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSessionPrincipal } from "@/lib/platform";
import { clearAccountFlow, readAccountFlow, setAccountResume } from "@/lib/auth/flow-state";
import { trustedPublicOrigin } from "@/lib/auth/providers";
import { setPendingEntitlement } from "@/lib/entitlement/grant";
import { getRuntimeConfig } from "@/lib/config/runtime";

export const runtime = "nodejs";

function redirect(req: NextRequest, state: "complete" | "unavailable") {
  const origin = trustedPublicOrigin(req);
  return NextResponse.redirect(`${origin}/?account=${state}`);
}

export async function GET(req: NextRequest) {
  let response: NextResponse;
  try {
    if (!getRuntimeConfig().syntheticMode) {
      response = redirect(req, "unavailable");
      clearAccountFlow(response);
      return response;
    }
    const flow = readAccountFlow(req);
    const nonce = req.nextUrl.searchParams.get("flow");
    const code = req.nextUrl.searchParams.get("code");
    if (!flow || flow.kind !== "oauth" || !nonce || nonce !== flow.nonce || !code || !flow.provider) {
      response = redirect(req, "unavailable");
      clearAccountFlow(response);
      return response;
    }
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) throw error;
    const principal = await getSessionPrincipal(client);
    if (!principal?.isVerified) throw new Error("The account provider did not produce a verified account.");

    response = redirect(req, "complete");
    const exp = Date.now() + 15 * 60 * 1_000;
    setPendingEntitlement(response, {
      userId: principal.userId,
      sourceUserId: flow.sourceUserId,
      transferToken: flow.transferToken,
      caseAccess: flow.caseAccess,
      pendingTask: flow.pendingTask,
      exp,
    });
    setAccountResume(response, { method: flow.provider, pendingTask: flow.pendingTask, exp });
    clearAccountFlow(response);
    return response;
  } catch {
    response = redirect(req, "unavailable");
    clearAccountFlow(response);
    return response;
  }
}
