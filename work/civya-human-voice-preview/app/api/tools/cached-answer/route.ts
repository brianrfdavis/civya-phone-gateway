import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { resolveAnswer } from "@/lib/cache/resolver";
import { bootstrapAuthorizedResidentCase } from "@/lib/conversation/runtime-bootstrap.server";
import {
  hasCaseEntitlementSession,
  requireCaseEntitlement,
} from "@/lib/entitlement/guard";
import { requirePlatformSession } from "@/lib/security/guards";
import {
  rateLimitRequest,
  readJsonObject,
  RequestError,
  requestErrorResponse,
} from "@/lib/security/request";
import { privacyPreservingSafetyIdentifier } from "@/lib/integrations/openai-intent.server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const platform = await requirePlatformSession();
    const limited = rateLimitRequest(req, "cached-answer-tool", 120, 60_000, platform.principal.userId);
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
    const suppliedChannel = typeof body.channel === "string" ? body.channel : "voice";
    if (suppliedChannel !== "voice" && suppliedChannel !== "sms" && suppliedChannel !== "web") {
      throw new RequestError(400, "channel must be voice, sms, or web.");
    }
    const channel: "voice" | "sms" | "web" = suppliedChannel;

    const result = await resolveAnswer(userMessage, channel, {
      safetyIdentifier: privacyPreservingSafetyIdentifier(platform.principal.userId),
    });

  // L1 speed rule: a cache hit IS the spoken line — the approved answer
  // plus the current next question only after case entitlement is proven.
    let assistantFollowup: string | undefined;
    if (result.hit && result.answer) {
      let tail = result.next_step_prompt ?? "";
      if (
        platform.principal.role === "resident"
        && platform.principal.isVerified
        && await hasCaseEntitlementSession(req, platform)
      ) {
        const bootstrap = await bootstrapAuthorizedResidentCase(req, platform);
        await requireCaseEntitlement(req, platform, bootstrap.active_case?.id || "");
        tail = bootstrap.resume_context.next_question ?? tail;
      }
      assistantFollowup = tail ? `${result.answer} ${tail}` : result.answer;
    }

    const retrievedAt = new Date().toISOString();
    const spokenText = assistantFollowup || result.answer ||
      "I couldn't verify that in the current approved information. The Wayne County Treasurer should confirm it.";
    return NextResponse.json({
      ...result,
      assistant_followup: assistantFollowup,
      spoken_text: spokenText,
      verification_state: result.hit ? "verified" : "unavailable",
      authority: result.hit
        ? result.source_url ? "source-backed approved knowledge" : "Civya approved knowledge"
        : null,
      source: result.hit ? result.source_url || null : null,
      retrieved_at: retrievedAt,
      scope: "wayne_county_property_tax_help",
      fictional: getRuntimeConfig().syntheticMode,
      continue_conversation: true,
    });
  } catch (error) { return requestErrorResponse(error); }
}
