import { NextResponse } from "next/server";
import { getRuntimeConfig, RuntimeConfigurationError } from "@/lib/config/runtime";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getRuntimeConfig();
    const database = isSupabaseConfigured() ? "configured" : config.syntheticMode ? "synthetic" : "missing";
    const ready = database !== "missing" && !config.features.pauseAll;
    return NextResponse.json(
      {
        status: ready ? "ready" : config.features.pauseAll ? "paused" : "not_ready",
        required: {
          configuration: "ok",
          database,
          pause_all: config.features.pauseAll,
        },
        release: config.releaseVersion,
        config_version: config.configVersion,
        environment: config.environment,
        checked_at: new Date().toISOString(),
      },
      { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const issues = error instanceof RuntimeConfigurationError ? error.issues : ["Runtime configuration could not be validated."];
    return NextResponse.json(
      { status: "not_ready", code: "runtime_configuration_invalid", issues, checked_at: new Date().toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
