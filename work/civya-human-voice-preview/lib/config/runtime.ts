import { z } from "zod";
import { evaluateProviderReadiness, providerReadinessIssues, type ProviderReadinessSnapshot } from "./provider-readiness";
import { validateProductionSecrets } from "@/lib/security/runtime-secrets";
import { inspectTelemetryConfiguration, type TelemetryAdapter } from "@/lib/telemetry/otlp";

const environmentSchema = z.enum(["development", "test", "staging", "production"]);
const providerModeSchema = z.enum(["disabled", "synthetic", "live"]);

export type DeploymentEnvironment = z.infer<typeof environmentSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;

export interface FeatureControls {
  pauseAll: boolean;
  residentWeb: boolean;
  browserVoice: boolean;
  pstn: boolean;
  messages: boolean;
  documentScanning: boolean;
  hostedHandoff: boolean;
  identityProofing: boolean;
}

export interface ProviderControls {
  countySource: ProviderMode;
  language: ProviderMode;
  messaging: ProviderMode;
  scanner: ProviderMode;
  paymentHandoff: ProviderMode;
  identityProofing: ProviderMode;
  telephony: ProviderMode;
}

export interface RuntimeConfig {
  environment: DeploymentEnvironment;
  releaseVersion: string;
  configVersion: string;
  syntheticMode: boolean;
  tenantHosts: Readonly<Record<string, string>>;
  features: FeatureControls;
  providers: ProviderControls;
  telemetryConfigured: boolean;
  telemetryAdapter: TelemetryAdapter;
  providerReadiness: ProviderReadinessSnapshot;
}

export class RuntimeConfigurationError extends Error {
  readonly code = "runtime_configuration_invalid";

  constructor(readonly issues: readonly string[]) {
    super(`Civya runtime configuration is invalid: ${issues.join(" ")}`);
    this.name = "RuntimeConfigurationError";
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RuntimeConfigurationError([`Expected true or false, received ${JSON.stringify(value)}.`]);
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

function parseTenantHosts(value: string | undefined, syntheticMode: boolean): Readonly<Record<string, string>> {
  if (!value?.trim()) {
    return syntheticMode
      ? Object.freeze({ localhost: "wayne-county-demo", "127.0.0.1": "wayne-county-demo" })
      : Object.freeze({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RuntimeConfigurationError(["CIVYA_TENANT_HOSTS must be a JSON object."]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeConfigurationError(["CIVYA_TENANT_HOSTS must map hostnames to tenant slugs."]);
  }

  const hosts: Record<string, string> = {};
  for (const [host, tenant] of Object.entries(parsed)) {
    const normalized = normalizeHost(host);
    if (!normalized || typeof tenant !== "string" || !/^[a-z0-9-]+$/.test(tenant)) {
      throw new RuntimeConfigurationError([`Invalid tenant host mapping for ${JSON.stringify(host)}.`]);
    }
    if (hosts[normalized] && hosts[normalized] !== tenant) {
      throw new RuntimeConfigurationError([`Hostname ${normalized} maps to more than one tenant.`]);
    }
    hosts[normalized] = tenant;
  }
  return Object.freeze(hosts);
}

function parseProviderMode(value: string | undefined, fallback: ProviderMode): ProviderMode {
  const result = providerModeSchema.safeParse(value?.trim() || fallback);
  if (!result.success) {
    throw new RuntimeConfigurationError([`Invalid provider mode ${JSON.stringify(value)}.`]);
  }
  return result.data;
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return /^(replace-|your-|sk-\.\.\.|https:\/\/example\.invalid)/i.test(value.trim());
}

function isExactHttpsUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const environmentResult = environmentSchema.safeParse(
    env.CIVYA_ENVIRONMENT?.trim() || (env.NODE_ENV === "test" ? "test" : "development"),
  );
  if (!environmentResult.success) {
    throw new RuntimeConfigurationError(["CIVYA_ENVIRONMENT must be development, test, staging, or production."]);
  }

  const environment = environmentResult.data;
  const syntheticMode = parseBoolean(env.CIVYA_SYNTHETIC_MODE, environment !== "production");
  const defaultProvider: ProviderMode = syntheticMode ? "synthetic" : "disabled";
  const telemetry = inspectTelemetryConfiguration(env);
  const baseConfig = {
    environment,
    releaseVersion: env.CIVYA_RELEASE_VERSION?.trim() || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "development",
    configVersion: env.CIVYA_CONFIG_VERSION?.trim() || "development",
    syntheticMode,
    tenantHosts: parseTenantHosts(env.CIVYA_TENANT_HOSTS, syntheticMode),
    features: {
      pauseAll: parseBoolean(env.CIVYA_PAUSE_ALL, false),
      residentWeb: parseBoolean(env.CIVYA_ENABLE_RESIDENT_WEB, true),
      // A controlled launch must opt into model-backed browser voice
      // explicitly; the local fictional sandbox keeps the convenient default.
      browserVoice: parseBoolean(env.CIVYA_ENABLE_BROWSER_VOICE, syntheticMode),
      pstn: parseBoolean(env.CIVYA_ENABLE_PSTN, false),
      messages: parseBoolean(env.CIVYA_ENABLE_MESSAGES, false),
      documentScanning: parseBoolean(env.CIVYA_ENABLE_DOCUMENT_SCANNING, false),
      hostedHandoff: parseBoolean(env.CIVYA_ENABLE_HOSTED_HANDOFF, false),
      identityProofing: parseBoolean(env.CIVYA_ENABLE_IDENTITY_PROOFING, false),
    },
    providers: {
      countySource: parseProviderMode(env.CIVYA_COUNTY_SOURCE_MODE, defaultProvider),
      language: parseProviderMode(env.CIVYA_LANGUAGE_MODE, "disabled"),
      messaging: parseProviderMode(env.CIVYA_MESSAGING_MODE, "disabled"),
      scanner: parseProviderMode(env.CIVYA_SCANNER_MODE, "disabled"),
      paymentHandoff: parseProviderMode(env.CIVYA_PAYMENT_HANDOFF_MODE, "disabled"),
      identityProofing: parseProviderMode(env.CIVYA_IDENTITY_PROOFING_MODE, "disabled"),
      telephony: parseProviderMode(env.CIVYA_TELEPHONY_MODE, "disabled"),
    },
    telemetryConfigured: telemetry.configured,
    telemetryAdapter: telemetry.adapter,
  };
  const providerReadiness = evaluateProviderReadiness(baseConfig, env);
  const config: RuntimeConfig = { ...baseConfig, providerReadiness };

  const issues: string[] = [...telemetry.issues];
  if (!syntheticMode) {
    for (const [name, mode] of Object.entries(config.providers)) {
      if (mode === "synthetic") issues.push(`Non-synthetic runtime provider ${name} cannot be synthetic.`);
    }
  }
  if (environment === "production") {
    if (syntheticMode) issues.push("Production cannot enable CIVYA_SYNTHETIC_MODE.");
    if (Object.keys(config.tenantHosts).length === 0) issues.push("Production requires an allowlisted tenant hostname.");
    if (!env.CIVYA_RELEASE_VERSION?.trim()) issues.push("Production requires CIVYA_RELEASE_VERSION.");
    if (!env.CIVYA_CONFIG_VERSION?.trim()) issues.push("Production requires CIVYA_CONFIG_VERSION.");
    if (!config.telemetryConfigured) {
      issues.push("Production requires the explicit otlp-http-json telemetry adapter; an endpoint or Sentry DSN alone is insufficient.");
    }
    if (env.CIVYA_DEMO_TENANT_SLUG?.trim()) issues.push("Production cannot configure CIVYA_DEMO_TENANT_SLUG.");
    if (env.CIVYA_REQUIRE_DEMO_ACCESS === "true") issues.push("Production cannot require a demo-access cookie.");
    if (env.CIVYA_DEMO_ACCESS_SECRET?.trim()) issues.push("Production cannot configure the demo invitation-cookie secret.");
    if (!isExactHttpsUrl(env.CIVYA_ENTITLEMENT_VERIFY_URL)) {
      issues.push("Production requires an exact HTTPS CIVYA_ENTITLEMENT_VERIFY_URL.");
    }
    issues.push(...validateProductionSecrets(env));
    const sensitiveNames = [
      "OPENAI_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "TWILIO_AUTH_TOKEN",
      "OPENAI_WEBHOOK_SECRET",
      "JPM_CHECKOUT_CLIENT_SECRET",
      "CLEAR_CLIENT_SECRET",
    ];
    for (const name of sensitiveNames) {
      if (isPlaceholder(env[name])) issues.push(`Production secret ${name} is still a placeholder.`);
    }
    issues.push(...providerReadinessIssues(providerReadiness));
  }

  const featureProviderPairs: Array<[boolean, ProviderMode, string]> = [
    [config.features.pstn, config.providers.telephony, "PSTN"],
    [config.features.messages, config.providers.messaging, "messaging"],
    [config.features.documentScanning, config.providers.scanner, "document scanning"],
    [config.features.hostedHandoff, config.providers.paymentHandoff, "hosted handoff"],
    [config.features.identityProofing, config.providers.identityProofing, "identity proofing"],
  ];
  for (const [enabled, provider, label] of featureProviderPairs) {
    if (enabled && provider === "disabled") issues.push(`${label} is enabled but its provider is disabled.`);
  }
  if (!syntheticMode && config.features.browserVoice && config.providers.language !== "live") {
    issues.push("Browser voice requires the live language provider in a non-synthetic runtime.");
  }
  if (issues.length > 0) throw new RuntimeConfigurationError(issues);
  return Object.freeze(config);
}

let cached: RuntimeConfig | undefined;

export function getRuntimeConfig(): RuntimeConfig {
  cached ??= readRuntimeConfig();
  return cached;
}

export function resetRuntimeConfigForTests(): void {
  cached = undefined;
}
