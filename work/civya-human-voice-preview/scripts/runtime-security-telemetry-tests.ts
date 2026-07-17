#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readRuntimeConfig, RuntimeConfigurationError } from "../lib/config/runtime";
import { probeRuntimeReadiness } from "../lib/health/readiness.server";
import { requireProductionNamedSecret, validateProductionSecrets } from "../lib/security/runtime-secrets";
import {
  checkTelemetryHealth,
  exportTelemetryLog,
  inspectTelemetryConfiguration,
  type TelemetryFetch,
} from "../lib/telemetry/otlp";

const secret = (label: string) => `civya-prod-${label}-${"7eA!".repeat(10)}`;
type LooseEnvironment = Record<string, string | undefined>;

function productionEnv(overrides: LooseEnvironment = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    CIVYA_ENVIRONMENT: "production",
    CIVYA_SYNTHETIC_MODE: "false",
    CIVYA_TENANT_HOSTS: JSON.stringify({ "services.waynecounty.example": "wayne-county" }),
    CIVYA_RELEASE_VERSION: "release-2026-07-16",
    CIVYA_CONFIG_VERSION: "wayne-controlled-launch-v1",
    CIVYA_TELEMETRY_MODE: "otlp-http-json",
    CIVYA_TELEMETRY_RECEIVER_ORIGIN: "https://telemetry.civya.invalid",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://telemetry.civya.invalid/v1/logs",
    CIVYA_ENTITLEMENT_VERIFY_URL: "https://identity.waynecounty.example/civya/verify",
    CIVYA_AUTH_FLOW_SECRET: secret("auth-flow"),
    CIVYA_AUTH_UPGRADE_SECRET: secret("auth-upgrade"),
    CIVYA_STAFF_AUTH_SECRET: secret("staff-auth"),
    CIVYA_ENTITLEMENT_VERIFY_SECRET: secret("entitlement"),
    CIVYA_DOCUMENT_UPLOAD_SECRET: secret("document-upload"),
    CIVYA_TELEMETRY_INGEST_SECRET: secret("telemetry-ingest"),
    OTEL_EXPORTER_OTLP_HEADERS: `x-civya-telemetry-key=${encodeURIComponent(secret("telemetry-ingest"))}`,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function runtimeIssues(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    readRuntimeConfig(env);
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) return error.issues;
    throw error;
  }
  assert.fail("Expected runtime configuration to fail.");
}

async function main(): Promise<void> {
  console.log("Runtime security, provider capability, and telemetry contracts");

  const local = readRuntimeConfig({
    NODE_ENV: "test",
    CIVYA_ENVIRONMENT: "test",
    CIVYA_SYNTHETIC_MODE: "true",
  });
  assert.equal(local.providers.countySource, "synthetic");
  assert.equal(local.providerReadiness.ready, true);
  console.log("  PASS  synthetic and test defaults remain available");

  const production = readRuntimeConfig(productionEnv());
  assert.equal(production.telemetryConfigured, true);
  assert.equal(production.telemetryAdapter, "otlp-http-json");
  assert.equal(production.providerReadiness.ready, true);
  console.log("  PASS  production accepts distinct secrets and an explicit telemetry adapter");

  const missingSecretIssues = runtimeIssues(productionEnv({ CIVYA_STAFF_AUTH_SECRET: "" }));
  assert.ok(missingSecretIssues.some((issue) => issue.includes("requires CIVYA_STAFF_AUTH_SECRET")));
  const weakSecretIssues = runtimeIssues(productionEnv({ CIVYA_AUTH_FLOW_SECRET: "replace-with-a-long-random-secret" }));
  assert.ok(weakSecretIssues.some((issue) => issue.includes("known development or placeholder")));
  const duplicateSecretIssues = runtimeIssues(productionEnv({
    CIVYA_STAFF_AUTH_SECRET: secret("auth-flow"),
  }));
  assert.ok(duplicateSecretIssues.some((issue) => issue.includes("must be distinct")));
  const missingIngestIssues = runtimeIssues(productionEnv({ CIVYA_TELEMETRY_INGEST_SECRET: "" }));
  assert.ok(missingIngestIssues.some((issue) => issue.includes("CIVYA_TELEMETRY_INGEST_SECRET")));
  const reusedIngest = secret("auth-flow");
  const reusedIngestIssues = runtimeIssues(productionEnv({
    CIVYA_TELEMETRY_INGEST_SECRET: reusedIngest,
    OTEL_EXPORTER_OTLP_HEADERS: `x-civya-telemetry-key=${encodeURIComponent(reusedIngest)}`,
  }));
  assert.ok(reusedIngestIssues.some((issue) => issue.includes("must be distinct")));
  assert.deepEqual(validateProductionSecrets(productionEnv()), []);
  console.log("  PASS  missing, weak, placeholder, and duplicate production secrets fail closed");

  assert.throws(
    () => requireProductionNamedSecret("CIVYA_AUTH_FLOW_SECRET", productionEnv({
      CIVYA_AUTH_FLOW_SECRET: "",
      CIVYA_AUTH_UPGRADE_SECRET: secret("fallback-must-not-work"),
    })),
    /not securely configured/,
  );
  console.log("  PASS  an adjacent auth secret cannot substitute for an exact production key");

  const endpointOnlyIssues = runtimeIssues(productionEnv({
    CIVYA_TELEMETRY_MODE: "",
    SENTRY_DSN: "https://public@example.invalid/1",
  }));
  assert.ok(endpointOnlyIssues.some((issue) => issue.includes("endpoint or Sentry DSN alone is insufficient")));
  assert.equal(inspectTelemetryConfiguration({
    NODE_ENV: "production",
    CIVYA_ENVIRONMENT: "production",
    CIVYA_TELEMETRY_MODE: "otlp-http-json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://telemetry.example.test",
  }).configured, false);
  console.log("  PASS  telemetry needs an explicit implemented adapter and production HTTPS");

  const livePayment = readRuntimeConfig({
    NODE_ENV: "test",
    CIVYA_ENVIRONMENT: "staging",
    CIVYA_SYNTHETIC_MODE: "false",
    CIVYA_PAYMENT_HANDOFF_MODE: "live",
  });
  assert.equal(livePayment.providerReadiness.providers.paymentHandoff.ready, false);
  assert.ok(livePayment.providerReadiness.providers.paymentHandoff.issues.includes("provider_contract_unavailable"));
  const messagingIssues = runtimeIssues(productionEnv({ CIVYA_MESSAGING_MODE: "live" }));
  assert.ok(messagingIssues.some((issue) => issue.includes("Provider messaging is not activation-ready")));
  console.log("  PASS  live mode alone cannot make an unavailable or unconfigured provider ready");

  let capturedUrl = "";
  let capturedBody = "";
  let capturedHeaders: HeadersInit | undefined;
  const acceptingFetch: TelemetryFetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    capturedHeaders = init?.headers;
    return new Response(null, { status: 202 });
  };
  const telemetryEnv = productionEnv({
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${encodeURIComponent(secret("telemetry-ingest"))},x-scope=civya-prod`,
  });
  const exported = await exportTelemetryLog("error", "civya.provider.failed", {
    provider: "twilio",
    route: "/api/webhooks/twilio",
    code: "provider_unavailable",
    resident: "Jane Resident",
    email: "jane@example.com",
    payload: { transcript: "private resident statement" },
    authorization: "Bearer should-never-export",
  }, { env: telemetryEnv, fetchImpl: acceptingFetch, now: 1_700_000_000_000 });
  assert.deepEqual(exported, { ok: true, status: 202 });
  assert.equal(capturedUrl, "https://telemetry.civya.invalid/v1/logs");
  assert.doesNotMatch(capturedBody, /Jane|jane@|private resident|should-never-export/i);
  assert.match(capturedBody, /provider_unavailable/);
  assert.equal(new Headers(capturedHeaders).get("content-type"), "application/json");
  console.log("  PASS  the OTLP exporter sends a real allowlisted log without resident content or secrets");

  const health = await checkTelemetryHealth({ env: telemetryEnv, fetchImpl: acceptingFetch });
  assert.equal(health.ok, true);
  assert.equal(health.configured, true);
  const rejected = await checkTelemetryHealth({
    env: telemetryEnv,
    fetchImpl: async () => new Response(null, { status: 401 }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "export_rejected");
  assert.equal(rejected.httpStatus, 401);
  const partiallyRejected = await checkTelemetryHealth({
    env: telemetryEnv,
    fetchImpl: async () => new Response(JSON.stringify({
      partialSuccess: { rejectedLogRecords: 1, errorMessage: "record rejected" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(partiallyRejected.ok, false);
  assert.equal(partiallyRejected.error, "export_rejected");
  console.log("  PASS  readiness verifies receiver acceptance and fails on rejected exports");

  const healthyPlatform = {
    ok: true,
    configured: true,
    database: { ok: true, latencyMs: 3 },
    storage: { ok: true, latencyMs: 4 },
  };
  const acceptedTelemetry = {
    ok: true,
    configured: true,
    adapter: "otlp-http-json" as const,
    latencyMs: 2,
  };
  const ready = await probeRuntimeReadiness(production, productionEnv(), {
    platform: async () => healthyPlatform,
    telemetry: async () => acceptedTelemetry,
  });
  assert.equal(ready.ready, true);
  const telemetryDown = await probeRuntimeReadiness(production, productionEnv(), {
    platform: async () => healthyPlatform,
    telemetry: async () => ({
      ...acceptedTelemetry,
      ok: false,
      error: "export_unavailable" as const,
    }),
  });
  assert.equal(telemetryDown.ready, false);
  assert.equal(telemetryDown.telemetry, "not_ready");
  const providerDown = await probeRuntimeReadiness(livePayment, {
    NODE_ENV: "production",
    CIVYA_ENVIRONMENT: "staging",
  }, {
    platform: async () => healthyPlatform,
    telemetry: async () => acceptedTelemetry,
  });
  assert.equal(providerDown.ready, false);
  assert.equal(providerDown.providers, "not_ready");
  console.log("  PASS  the single hosted readiness gate requires database, storage, telemetry, and adapter capability");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
