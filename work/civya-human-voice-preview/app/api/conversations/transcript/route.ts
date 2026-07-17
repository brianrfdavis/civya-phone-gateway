import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { appendTurn, bootstrapSession } from "@/lib/platform";
import { requirePlatformSession } from "@/lib/security/guards";
import {
  rateLimitRequest,
  readJsonObject,
  RequestError,
  requestErrorResponse,
} from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Stores redacted fast-path conversation continuity after response creation.
 * It never decides a reply, advances workflow, or sits on first-audio latency.
 */
export async function POST(req: NextRequest) {
  try {
    const runtimeConfig = getRuntimeConfig();
    if (!runtimeConfig.syntheticMode || runtimeConfig.environment === "production") {
      throw new RequestError(409, "Direct transcript persistence is available only in the fictional preview.", "sandbox_only");
    }

    const platform = await requirePlatformSession();
    const limited = rateLimitRequest(req, "fast-transcript", 240, 60_000, platform.principal.userId);
    if (limited) return limited;
    const body = await readJsonObject(req, 16_000);
    const transcript = text(body, "transcript", 12_000);
    const clientTurnId = text(body, "client_turn_id", 200);
    const providerItemId = text(body, "provider_item_id", 200);
    const idempotencyKey = text(body, "idempotency_key", 200);
    const speaker = body.speaker === "user" ? "user" : null;
    const channel = body.channel === "text" ? "text" : body.channel === "voice" ? "voice" : null;
    if (!transcript || !clientTurnId || !idempotencyKey || !speaker || !channel) {
      throw new RequestError(400, "A resident transcript, stable turn ID, idempotency key, and channel are required.");
    }

    // This endpoint belongs to an active Realtime voice session. Typed turns
    // keep their `text` channel marker but remain in that voice conversation.
    const bootstrap = await bootstrapSession(platform, undefined, "voice");
    if (!bootstrap.active_case || !bootstrap.conversation) {
      throw new RequestError(404, "No active conversation is available.", "case_not_found");
    }
    await platform.assertSyntheticSandboxCase(bootstrap.active_case.id);
    const suppliedConversationId = text(body, "conversation_id", 100);
    if (suppliedConversationId && suppliedConversationId !== bootstrap.conversation.id) {
      throw new RequestError(403, "The conversation does not belong to this session.", "forbidden");
    }

    const persisted = await appendTurn(platform, {
      conversation_id: bootstrap.conversation.id,
      provider_item_id: providerItemId || undefined,
      client_turn_id: clientTurnId,
      transcript,
      channel,
      idempotency_key: idempotencyKey,
    }, "user");

    return NextResponse.json(
      {
        saved: true,
        duplicate: persisted.duplicate,
        turn_id: persisted.id,
        conversation_id: persisted.conversationId,
      },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
