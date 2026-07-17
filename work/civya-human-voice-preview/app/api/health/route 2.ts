import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig, RuntimeConfigurationError } from "@/lib/config/runtime";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimitRequest } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configured(value: string | undefined): "configured" | "missing" {
  return value?.trim() ? "configured" : "missing";
}

export async function GET(req: NextRequest) {
  const limited = rateLimitRequest(req, "health", 20, 60_000);
  if (limited) return limited;

  const started = Date.now();
  try {
    const config = getRuntimeConfig();
    const database = isSupabaseConfigured() ? "configured" : config.syntheticMode ? "synthetic" : "missing";
    const ready = database !== "missing" && !config.features.pauseAll;

    return NextResponse.json(
      {
        status: ready ? "ready" : config.features.pauseAll ? "paused" : "not_ready",
        scope: config.syntheticMode ? "credential_free_synthetic" : "controlled_launch",
        required: {
          configuration: "ok",
          database,
          county_source: config.providers.countySource,
          pause_all: config.features.pauseAll,
        },
        optional: {
          language: config.providers.language,
          openai: config.features.browserVoice || config.features.pstn
            ? configured(process.env.OPENAI_API_KEY)
            : "disabled",
          twilio: config.features.pstn || config.features.messages
            ? configured(process.env.TWILIO_AUTH_TOKEN)
            : "disabled",
          payment_handoff: config.providers.paymentHandoff,
          identity_proofing: config.providers.identityProofing,
          scanner: config.providers.scanner,
        },
        release: config.releaseVersion,
        config_version: config.configVersion,
        environment: config.environment,
        endpoints: {
          liveness: "/api/health/live",
          readiness: "/api/health/ready",
          dependencies: "/api/health/dependencies",
        },
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
      },
      { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const issues = error instanceof RuntimeConfigurationError
      ? error.issues
      : ["Runtime configuration could not be validated."];
    return NextResponse.json(
      {
        status: "not_ready",
        code: "runtime_configuration_invalid",
        issues,
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
