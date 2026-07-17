import type { RuntimeConfig } from "@/lib/config/runtime";
import { checkPlatformHealth, type PlatformHealth } from "@/lib/platform";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkTelemetryHealth, type TelemetryHealth } from "@/lib/telemetry/otlp";

export interface RuntimeReadinessSnapshot {
  ready: boolean;
  scope: "local_synthetic" | "hosted_controlled_launch";
  database: "synthetic" | "ready" | "not_ready";
  storage: "synthetic" | "ready" | "not_ready";
  telemetry: "not_required" | "ready" | "not_ready";
  providers: "ready" | "not_ready";
  platformHealth?: PlatformHealth;
  telemetryHealth?: TelemetryHealth;
}

interface ReadinessProbes {
  platform?: () => Promise<PlatformHealth>;
  telemetry?: () => Promise<TelemetryHealth>;
  supabaseConfigured?: () => boolean;
}

function timeoutPlatformHealth(timeoutMs: number, probe: () => Promise<PlatformHealth>): Promise<PlatformHealth> {
  const timeout = new Promise<PlatformHealth>((resolve) => {
    setTimeout(() => resolve({
      ok: false,
      configured: true,
      database: { ok: false, latencyMs: timeoutMs, error: "Dependency probe timed out." },
      storage: { ok: false, latencyMs: timeoutMs, error: "Dependency probe timed out." },
    }), timeoutMs).unref?.();
  });
  return Promise.race([probe(), timeout]);
}

/** Hosted readiness verifies real database, private storage, telemetry, and enabled adapters. */
export async function probeRuntimeReadiness(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  probes: ReadinessProbes = {},
): Promise<RuntimeReadinessSnapshot> {
  const hosted = config.environment === "staging" || config.environment === "production" || Boolean(env.VERCEL);
  const explicitLocalSynthetic = config.syntheticMode
    && !hosted
    && !(probes.supabaseConfigured ?? isSupabaseConfigured)();
  if (explicitLocalSynthetic) {
    const providersReady = config.providerReadiness.ready;
    return {
      ready: !config.features.pauseAll && providersReady,
      scope: "local_synthetic",
      database: "synthetic",
      storage: "synthetic",
      telemetry: "not_required",
      providers: providersReady ? "ready" : "not_ready",
    };
  }

  const [platformHealth, telemetryHealth] = await Promise.all([
    timeoutPlatformHealth(5_000, probes.platform ?? checkPlatformHealth),
    hosted
      ? (probes.telemetry ?? (() => checkTelemetryHealth({ env })))()
      : Promise.resolve<TelemetryHealth>({
          ok: true,
          configured: false,
          adapter: "disabled",
          latencyMs: 0,
        }),
  ]);
  const providersReady = config.providerReadiness.ready;
  return {
    ready: !config.features.pauseAll && platformHealth.ok && telemetryHealth.ok && providersReady,
    scope: "hosted_controlled_launch",
    database: platformHealth.database.ok ? "ready" : "not_ready",
    storage: platformHealth.storage.ok ? "ready" : "not_ready",
    telemetry: hosted ? (telemetryHealth.ok ? "ready" : "not_ready") : "not_required",
    providers: providersReady ? "ready" : "not_ready",
    platformHealth,
    telemetryHealth,
  };
}
