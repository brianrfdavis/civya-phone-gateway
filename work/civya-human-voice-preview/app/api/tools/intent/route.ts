import { NextRequest, NextResponse } from "next/server";
import { resolveAnswer } from "@/lib/cache/resolver";
import { requirePlatformSession } from "@/lib/security/guards";
import {
  rateLimitRequest,
  readJsonObject,
  RequestError,
  requestErrorResponse,
} from "@/lib/security/request";
import { privacyPreservingSafetyIdentifier } from "@/lib/integrations/openai-intent.server";

export const runtime = "nodejs";

/** Classification only — same resolver, but returns intent without answer. */
export async function POST(req: NextRequest) {
  try {
    const platform = await requirePlatformSession();
    const limited = rateLimitRequest(req, "intent-tool", 120, 60_000, platform.principal.userId);
    if (limited) return limited;
    const durableLimit = await platform.takeRateLimit({
      key: platform.principal.userId,
      bucket: "resident-ai-tool",
      maxHits: 180,
      windowSeconds: 60,
    });
    if (!durableLimit.allowed) {
      return NextResponse.json(
        { error: "Too many language requests. Please pause for a moment.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "2", "Cache-Control": "no-store" } },
      );
    }
    const body = await readJsonObject(req, 8_000);
    const userMessage = typeof body.user_message === "string" ? body.user_message.trim() : "";
    if (!userMessage || userMessage.length > 2_000) {
      throw new RequestError(400, "user_message must be between 1 and 2,000 characters.");
    }
    const result = await resolveAnswer(userMessage, "voice", {
      safetyIdentifier: privacyPreservingSafetyIdentifier(platform.principal.userId),
    });
    return NextResponse.json({
      intent: result.intent ?? null,
      layer: result.layer,
      similarity: result.similarity ?? null,
      escalated: result.escalated,
    });
  } catch (error) { return requestErrorResponse(error); }
}
