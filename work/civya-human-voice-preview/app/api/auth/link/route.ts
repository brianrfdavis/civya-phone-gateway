import { NextRequest, NextResponse } from "next/server";
import { createRequestPlatform } from "@/lib/platform";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { clearAccountFlow, readAccountFlow, setAccountResume } from "@/lib/auth/flow-state";
import { setPendingEntitlement } from "@/lib/entitlement/grant";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    if (!getRuntimeConfig().syntheticMode) {
      throw new RequestError(409, "Passkey account linking is not active for this controlled launch.", "county_case_binding_required");
    }
    const flow = readAccountFlow(req);
    if (!flow || flow.kind !== "passkey") throw new RequestError(400, "The passkey sign-in expired. Start again.", "expired");
    const body = await readJsonObject(req);
    if (body.challenge_id !== flow.nonce) throw new RequestError(400, "The passkey sign-in is no longer active.", "expired");
    const platform = await createRequestPlatform();
    if (!platform?.principal.isVerified) throw new RequestError(401, "The passkey did not sign in a verified account.", "authentication_required");
    const exp = Date.now() + 15 * 60 * 1_000;
    const response = NextResponse.json(
      {
        ok: true,
        account: { state: "verified", method: "passkey" },
        entitlement: { state: "required" },
        resume: { pending_task: flow.pendingTask },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    setPendingEntitlement(response, {
      userId: platform.principal.userId,
      sourceUserId: flow.sourceUserId,
      transferToken: flow.transferToken,
      caseAccess: flow.caseAccess,
      pendingTask: flow.pendingTask,
      exp,
    });
    setAccountResume(response, { method: "passkey", pendingTask: flow.pendingTask, exp });
    clearAccountFlow(response);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
