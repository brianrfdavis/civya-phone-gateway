import { NextResponse } from "next/server";
import { getRuntimeConfig, RuntimeConfigurationError } from "@/lib/config/runtime";
import { probeRuntimeReadiness } from "@/lib/health/readiness.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getRuntimeConfig();
    const readiness = await probeRuntimeReadiness(config);
    return NextResponse.json(
      {
        status: readiness.ready ? "ready" : config.features.pauseAll ? "paused" : "not_ready",
        scope: readiness.scope,
        required: {
          configuration: "ok",
          database: readiness.database,
          private_storage: readiness.storage,
          telemetry: readiness.telemetry,
          providers: readiness.providers,
          pause_all: config.features.pauseAll,
        },
        probes: {
          database_latency_ms: readiness.platformHealth?.database.latencyMs,
          storage_latency_ms: readiness.platformHealth?.storage.latencyMs,
          telemetry_latency_ms: readiness.telemetryHealth?.latencyMs,
        },
        release: config.releaseVersion,
        config_version: config.configVersion,
        environment: config.environment,
        checked_at: new Date().toISOString(),
      },
      { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const issues = error instanceof RuntimeConfigurationError ? error.issues : ["Runtime dependencies could not be validated."];
    return NextResponse.json(
      { status: "not_ready", code: "runtime_configuration_invalid", issues, checked_at: new Date().toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
