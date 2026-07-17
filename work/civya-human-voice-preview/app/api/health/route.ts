import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig, RuntimeConfigurationError } from "@/lib/config/runtime";
import { probeRuntimeReadiness } from "@/lib/health/readiness.server";
import { rateLimitRequest } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limited = rateLimitRequest(req, "health", 20, 60_000);
  if (limited) return limited;

  const started = Date.now();
  try {
    const config = getRuntimeConfig();
    const readiness = await probeRuntimeReadiness(config);
    const providerSummary = Object.fromEntries(
      Object.entries(config.providerReadiness.providers).map(([name, provider]) => [name, {
        mode: provider.mode,
        required: provider.required,
        ready: provider.ready,
        contract: provider.contract,
      }]),
    );
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
        providers: providerSummary,
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
      { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const issues = error instanceof RuntimeConfigurationError
      ? error.issues
      : ["Runtime dependencies could not be validated."];
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
