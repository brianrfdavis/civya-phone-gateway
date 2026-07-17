import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireCaseEntitlementSession } from "@/lib/entitlement/guard";
import { REALTIME_TOOLS } from "@/lib/realtime/tools";
import {
  PRODUCTION_WAYNE_COUNTY_SYSTEM_PROMPT,
  WAYNE_COUNTY_SYSTEM_PROMPT,
} from "@/lib/wayne-county/systemPrompt";
import { createRequestPlatform } from "@/lib/platform";
import { fetchWithTimeout, rateLimitRequest, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

/**
 * Mints a short-lived Realtime client secret so the browser can open a
 * WebRTC session directly with OpenAI. The real API key never leaves the
 * server. Server VAD detects the end of speech, but response creation is kept
 * off: Civya's authoritative turn endpoint must durably process the transcript
 * before the browser asks Realtime to speak the approved answer.
 */
const MODEL = "gpt-realtime-2.1";
const CONFIGURED_MODEL = process.env.OPENAI_REALTIME_MODEL?.trim();
const CONFIGURED_VOICE = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
const QUALIFIED_VOICES = new Set(["marin", "cedar"]);
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

const TURN_DETECTION = {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
  create_response: false,
  interrupt_response: true,
} as const;

export async function POST(request: NextRequest) {
  const runtimeConfig = getRuntimeConfig();
  if (!runtimeConfig.syntheticMode
    && (runtimeConfig.providers.language !== "live"
      || !runtimeConfig.providerReadiness.providers.language.ready)) {
    return NextResponse.json(
      {
        error: "High-fidelity voice is unavailable right now. Please continue in text mode.",
        code: "REALTIME_NOT_ACTIVATED",
        text_mode_available: true,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "High-fidelity voice is unavailable right now. Please continue in text mode.",
        code: "REALTIME_NOT_CONFIGURED",
        text_mode_available: true,
      },
      { status: 503 },
    );
  }
  if (CONFIGURED_MODEL && CONFIGURED_MODEL !== MODEL) {
    return NextResponse.json(
      {
        error: `Voice is configured with an unqualified model. Set OPENAI_REALTIME_MODEL to ${MODEL} or remove the override.`,
        code: "REALTIME_MODEL_MISCONFIGURED",
        text_mode_available: true,
      },
      { status: 503 },
    );
  }
  if (!QUALIFIED_VOICES.has(CONFIGURED_VOICE)) {
    return NextResponse.json(
      {
        error: "Voice is configured with an unqualified voice. Use marin or cedar.",
        code: "REALTIME_VOICE_MISCONFIGURED",
        text_mode_available: true,
      },
      { status: 503 },
    );
  }
  const voice = CONFIGURED_VOICE as "marin" | "cedar";

  try {
    const platform = await createRequestPlatform();
    if (!platform) {
      return NextResponse.json(
        { error: "Start the conversation before enabling voice.", code: "authentication_required" },
        { status: 401 },
      );
    }
    if (!runtimeConfig.syntheticMode) {
      await requireCaseEntitlementSession(request, platform);
    }
    const limited = rateLimitRequest(
      request,
      "realtime-session",
      10,
      60 * 1_000,
      platform.principal.userId,
    );
    if (limited) return limited;
    const distributedLimit = await platform.takeRateLimit({
      key: platform.principal.userId,
      bucket: "realtime-session-hour",
      maxHits: 60,
      windowSeconds: 60 * 60,
    });
    if (!distributedLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(distributedLimit.resetAt).getTime() - Date.now()) / 1_000),
      );
      return NextResponse.json(
        {
          error: "Voice has been restarted too many times. Your progress is safe; please continue in text mode for now.",
          code: "rate_limited",
          text_mode_available: true,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const safetyIdentifier = privacyPreservingSafetyIdentifier(platform.principal.userId);
    const res = await fetchWithTimeout("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyIdentifier,
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model: MODEL,
          output_modalities: ["audio"],
          instructions: runtimeConfig.syntheticMode
            ? WAYNE_COUNTY_SYSTEM_PROMPT
            : PRODUCTION_WAYNE_COUNTY_SYSTEM_PROMPT,
          reasoning: { effort: "low" },
          ...(runtimeConfig.syntheticMode
            ? { tools: REALTIME_TOOLS, tool_choice: "auto" }
            : {}),
          audio: {
            input: {
              transcription: { model: TRANSCRIPTION_MODEL },
              turn_detection: TURN_DETECTION,
            },
            output: { voice },
          },
        },
      }),
    }, 12_000);

    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? undefined;
      const providerMessage = truncate(await res.text());
      console.error("Realtime client-secret mint failed", {
        status: res.status,
        requestId,
        model: MODEL,
        voice,
        providerMessage,
      });
      return NextResponse.json(
        {
          error: "High-fidelity voice is unavailable right now. Your progress is safe; please continue in text mode.",
          code: "REALTIME_UNAVAILABLE",
          request_id: requestId,
          text_mode_available: true,
        },
        { status: 503 },
      );
    }

    const json = (await res.json()) as {
      value: string;
      expires_at: number;
      session?: { id?: string };
    };
    return NextResponse.json(
      {
        client_secret: json.value,
        expires_at: json.expires_at,
        provider_session_id: json.session?.id,
        model: MODEL,
        voice,
        transcription_model: TRANSCRIPTION_MODEL,
        reasoning_effort: "low",
        turn_detection: TURN_DETECTION.type,
        automatic_response_creation: false,
      },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}

function privacyPreservingSafetyIdentifier(authenticatedUserId: string): string {
  return `civya_${createHash("sha256")
    .update(authenticatedUserId)
    .digest("hex")
    .slice(0, 32)}`;
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
