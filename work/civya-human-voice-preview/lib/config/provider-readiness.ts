import type { DeploymentEnvironment, FeatureControls, ProviderControls, ProviderMode } from "./runtime";
import { isKnownDevelopmentSecret } from "@/lib/security/runtime-secrets";

export type ProviderKey = keyof ProviderControls;

export interface ProviderReadinessEntry {
  mode: ProviderMode;
  required: boolean;
  configured: boolean;
  adapterAvailable: boolean;
  ready: boolean;
  contract: string;
  issues: readonly string[];
}

export interface ProviderReadinessSnapshot {
  ready: boolean;
  providers: Readonly<Record<ProviderKey, ProviderReadinessEntry>>;
}

interface ReadinessInput {
  environment: DeploymentEnvironment;
  features: FeatureControls;
  providers: ProviderControls;
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function validSecret(value: string | undefined, minimumBytes: number): boolean {
  const candidate = value?.trim() ?? "";
  return new TextEncoder().encode(candidate).byteLength >= minimumBytes && !isKnownDevelopmentSecret(candidate);
}

function validPhoneTurnUrl(value: string | undefined): boolean {
  if (!isHttpsUrl(value)) return false;
  return new URL(value!.trim()).pathname === "/api/internal/phone/turn"
    && !new URL(value!.trim()).search;
}

function validCanaryRegistry(value: string | undefined): boolean {
  try {
    const parsed = JSON.parse(value?.trim() ?? "") as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return false;
    const entries = Object.entries(parsed as Record<string, unknown>);
    const numbers = new Set<string>();
    return entries.length > 0 && entries.length <= 25 && entries.every(([alias, phone]) => {
      if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(alias)
          || typeof phone !== "string"
          || !/^\+[1-9]\d{7,14}$/.test(phone)
          || numbers.has(phone)) return false;
      numbers.add(phone);
      return true;
    });
  } catch {
    return false;
  }
}

function inactive(mode: ProviderMode, required: boolean, contract: string): ProviderReadinessEntry {
  const ready = !required && mode === "disabled";
  return Object.freeze({
    mode,
    required,
    configured: false,
    adapterAvailable: true,
    ready,
    contract,
    issues: Object.freeze(ready ? [] : ["provider_disabled"]),
  });
}

function synthetic(
  mode: ProviderMode,
  required: boolean,
  environment: DeploymentEnvironment,
  contract: string,
): ProviderReadinessEntry {
  const ready = environment !== "production";
  return Object.freeze({
    mode,
    required,
    configured: ready,
    adapterAvailable: true,
    ready,
    contract,
    issues: Object.freeze(ready ? [] : ["synthetic_provider_forbidden"]),
  });
}

function live(
  mode: ProviderMode,
  required: boolean,
  contract: string,
  adapterAvailable: boolean,
  issues: string[],
): ProviderReadinessEntry {
  const configured = adapterAvailable && issues.length === 0;
  return Object.freeze({
    mode,
    required,
    configured,
    adapterAvailable,
    ready: configured,
    contract,
    issues: Object.freeze(issues),
  });
}

function entry(
  key: ProviderKey,
  mode: ProviderMode,
  required: boolean,
  environment: DeploymentEnvironment,
  env: NodeJS.ProcessEnv,
): ProviderReadinessEntry {
  const contracts: Record<ProviderKey, string> = {
    countySource: "county-source-governance-v1",
    language: "openai-responses-intent-v1",
    messaging: "twilio-messaging-v1",
    scanner: "document-scanner-v1",
    paymentHandoff: "jpm-hosted-checkout-v1",
    identityProofing: "clear-proofing-v1",
    telephony: "openai-realtime-sip-canary-v2",
  };
  if (mode === "disabled") return inactive(mode, required, contracts[key]);
  if (mode === "synthetic") return synthetic(mode, required, environment, contracts[key]);

  if (key === "language") {
    const issues: string[] = [];
    if (!validSecret(env.OPENAI_API_KEY, 20)) issues.push("openai_credentials_missing");
    const model = env.OPENAI_INTENT_MODEL?.trim();
    if (model && !/^gpt-5\.6(?:-(?:sol|terra|luna))?$/.test(model)) issues.push("model_contract_invalid");
    return live(mode, required, contracts[key], true, issues);
  }

  if (key === "countySource") {
    const issues = ["live_adapter_unavailable"];
    if (!isHttpsUrl(env.CIVYA_COUNTY_SOURCE_ENDPOINT)) issues.push("endpoint_missing");
    if (!validSecret(env.CIVYA_COUNTY_SOURCE_CREDENTIAL, 24)) issues.push("credentials_missing");
    return live(mode, required, contracts[key], false, issues);
  }
  if (key === "scanner") {
    return live(mode, required, contracts[key], false, ["live_adapter_unavailable"]);
  }
  if (key === "paymentHandoff") {
    const issues = ["provider_contract_unavailable"];
    if (!env.JPM_CHECKOUT_CONTRACT_VERSION?.trim()) issues.push("contract_version_missing");
    if (!isHttpsUrl(env.JPM_CHECKOUT_BASE_URL)) issues.push("endpoint_missing");
    if (!validSecret(env.JPM_CHECKOUT_CLIENT_SECRET, 24)) issues.push("credentials_missing");
    return live(mode, required, contracts[key], false, issues);
  }
  if (key === "identityProofing") {
    return live(mode, required, contracts[key], false, ["live_adapter_unavailable", "county_approval_required"]);
  }
  if (key === "messaging") {
    const issues: string[] = [];
    if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID?.trim() ?? "")) issues.push("account_missing");
    if (!validSecret(env.TWILIO_AUTH_TOKEN, 16)) issues.push("credentials_missing");
    const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    const sender = env.TWILIO_PHONE_NUMBER?.trim() || env.CIVYA_TWILIO_PHONE_NUMBER?.trim();
    if (service ? !/^MG[0-9a-f]{32}$/i.test(service) : !/^\+[1-9]\d{7,14}$/.test(sender ?? "")) {
      issues.push("sender_missing");
    }
    if (!isHttpsUrl(env.CIVYA_TWILIO_WEBHOOK_URL)) issues.push("status_callback_missing");
    try {
      const origin = new URL(env.CIVYA_PUBLIC_ORIGIN?.trim() ?? "");
      if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
        issues.push("public_origin_invalid");
      }
    } catch {
      issues.push("public_origin_invalid");
    }
    return live(mode, required, contracts[key], true, issues);
  }

  const issues: string[] = [];
  if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID?.trim() ?? "")) issues.push("twilio_account_missing");
  if (!validSecret(env.OPENAI_API_KEY, 20)) issues.push("openai_credentials_missing");
  if (!validSecret(env.OPENAI_WEBHOOK_SECRET, 24)) issues.push("openai_webhook_secret_missing");
  if (!validSecret(env.TWILIO_AUTH_TOKEN, 16)) issues.push("twilio_credentials_missing");
  if (!/^TK[0-9a-f]{32}$/i.test(env.TWILIO_SIP_TRUNK_SID?.trim() ?? "")) issues.push("sip_trunk_missing");
  if (!/^\+[1-9]\d{7,14}$/.test(env.CIVYA_TWILIO_PHONE_NUMBER?.trim() ?? "")) issues.push("phone_number_missing");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.CIVYA_WAYNE_TENANT_ID?.trim() ?? "")) {
    issues.push("tenant_binding_missing");
  }
  if (!validPhoneTurnUrl(env.CIVYA_PHONE_TURN_URL)) issues.push("phone_turn_endpoint_missing");
  if (!validSecret(env.CIVYA_PHONE_TURN_SERVICE_SECRET, 32)) issues.push("phone_turn_secret_missing");
  if (!validSecret(env.CIVYA_PHONE_DIGEST_SECRET, 32)) issues.push("phone_digest_secret_missing");
  const accessMode = env.CIVYA_PSTN_ACCESS_MODE?.trim();
  if (accessMode === "canary") {
    if (!validCanaryRegistry(env.CIVYA_PSTN_CANARY_TESTERS_JSON)) issues.push("canary_registry_missing");
  } else if (accessMode === "public") {
    if (!validBoundedInteger(env.CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR, 1, 20)
      || !validBoundedInteger(env.CIVYA_PSTN_MAX_DURATION_SECONDS, 60, 1_800)
      || !validBoundedInteger(env.CIVYA_PSTN_MAX_CONCURRENT_CALLS, 1, 10)
      || !validBoundedInteger(env.CIVYA_PSTN_MAX_TURNS, 1, 100)) {
      issues.push("public_admission_limits_missing");
    }
  } else {
    issues.push("phone_access_mode_missing");
  }
  if (env.CIVYA_CALL_RECORDING_MODE?.trim() !== "disabled") issues.push("recording_must_be_disabled");
  if (env.CIVYA_LANGUAGE_MODE !== "live") issues.push("language_provider_required");
  return live(mode, required, contracts[key], true, issues);
}

function validBoundedInteger(value: string | undefined, minimum: number, maximum: number): boolean {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) && String(parsed) === value?.trim() && parsed >= minimum && parsed <= maximum;
}

export function evaluateProviderReadiness(
  input: ReadinessInput,
  env: NodeJS.ProcessEnv = process.env,
): ProviderReadinessSnapshot {
  const required: Record<ProviderKey, boolean> = {
    countySource: input.providers.countySource !== "disabled",
    language: input.providers.language !== "disabled",
    messaging: input.features.messages || input.providers.messaging !== "disabled",
    scanner: input.features.documentScanning || input.providers.scanner !== "disabled",
    paymentHandoff: input.features.hostedHandoff || input.providers.paymentHandoff !== "disabled",
    identityProofing: input.features.identityProofing || input.providers.identityProofing !== "disabled",
    telephony: input.features.pstn || input.providers.telephony !== "disabled",
  };
  const providers = Object.freeze({
    countySource: entry("countySource", input.providers.countySource, required.countySource, input.environment, env),
    language: entry("language", input.providers.language, required.language, input.environment, env),
    messaging: entry("messaging", input.providers.messaging, required.messaging, input.environment, env),
    scanner: entry("scanner", input.providers.scanner, required.scanner, input.environment, env),
    paymentHandoff: entry("paymentHandoff", input.providers.paymentHandoff, required.paymentHandoff, input.environment, env),
    identityProofing: entry("identityProofing", input.providers.identityProofing, required.identityProofing, input.environment, env),
    telephony: entry("telephony", input.providers.telephony, required.telephony, input.environment, env),
  });
  return Object.freeze({
    ready: Object.values(providers).every((provider) => !provider.required || provider.ready),
    providers,
  });
}

export function providerReadinessIssues(snapshot: ProviderReadinessSnapshot): string[] {
  const issues: string[] = [];
  for (const [key, provider] of Object.entries(snapshot.providers)) {
    if (!provider.required || provider.ready) continue;
    issues.push(`Provider ${key} is not activation-ready (${provider.issues.join(", ")}).`);
  }
  return issues;
}
