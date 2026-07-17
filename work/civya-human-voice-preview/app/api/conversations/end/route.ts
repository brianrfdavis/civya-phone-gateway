import { NextRequest, NextResponse } from "next/server";
import { bootstrapAuthorizedResidentCase } from "@/lib/conversation/runtime-bootstrap.server";
import { createRequestPlatform, finishConversation } from "@/lib/platform";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const protectedResident = platform.principal.role === "resident" && platform.principal.isVerified;
    if (protectedResident) await requireCaseEntitlementSession(req, platform);
    const body = await readJsonObject(req);
    const supplied = typeof body.conversation_id === "string" ? body.conversation_id : "";
    const bootstrap = await bootstrapAuthorizedResidentCase(req, platform);
    if (!bootstrap.active_case) throw new Error("No active case.");
    if (protectedResident) await requireCaseEntitlement(req, platform, bootstrap.active_case.id);
    const conversationId = supplied || bootstrap.conversation?.id;
    if (!conversationId) throw new Error("No active conversation.");
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 80) : "resident_ended";
    await finishConversation(
      platform,
      conversationId,
      `Conversation ended (${reason}). Saved case facts remain authoritative.`,
    );
    return NextResponse.json({ ok: true, conversation_id: conversationId, ended: true });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
