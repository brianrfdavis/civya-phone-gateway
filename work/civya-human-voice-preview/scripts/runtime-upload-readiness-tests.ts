import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateRuntimeGate, isRuntimeOperationalPath } from "../lib/config/feature-gates";
import type { RuntimeConfig } from "../lib/config/runtime";
import {
  DOCUMENT_UPLOAD_BUCKET,
  DocumentUploadGrantError,
  issueDocumentUploadGrant,
  verifyDocumentUploadGrant,
} from "../lib/documents/upload-grant.server";
import { probeRuntimeReadiness } from "../lib/health/readiness.server";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

async function main() {
const features = {
  pauseAll: false,
  residentWeb: true,
  browserVoice: true,
  pstn: false,
  messages: false,
  documentScanning: false,
  hostedHandoff: false,
  identityProofing: false,
};

assert.equal(evaluateRuntimeGate({ features }, { pathname: "/api/uploads", method: "POST" }).allowed, true);
assert.equal(evaluateRuntimeGate(
  { features: { ...features, residentWeb: false } },
  { pathname: "/api/uploads", method: "POST" },
).allowed, false);
assert.equal(evaluateRuntimeGate(
  { features: { ...features, browserVoice: false } },
  { pathname: "/api/realtime/session", method: "POST" },
).allowed, false);
assert.equal(evaluateRuntimeGate(
  { features: { ...features, pauseAll: true } },
  { pathname: "/api/conversations/turn", method: "POST" },
).allowed, false);
for (const pathName of [
  "/api/health/ready",
  "/api/webhooks/twilio",
  "/api/internal/secure-links/phone",
  "/api/admin/retention/run",
  "/api/staff/bootstrap",
  "/api/v1/staff/workflows/000/actions",
  "/staff/operations",
]) {
  assert.equal(isRuntimeOperationalPath(pathName), true, `${pathName} should remain operational`);
  assert.equal(evaluateRuntimeGate(
    { features: { ...features, pauseAll: true, residentWeb: false } },
    { pathname: pathName, method: "POST" },
  ).allowed, true, `${pathName} should bypass only the runtime availability gate`);
}

const secret = "test-only-document-upload-secret-0123456789";
const now = Date.UTC(2026, 6, 16, 12, 0, 0);
const issued = issueDocumentUploadGrant({
  userId: "user-123",
  tenantId: "11111111-1111-4111-8111-111111111111",
  caseId: "22222222-2222-4222-8222-222222222222",
  bucket: DOCUMENT_UPLOAD_BUCKET,
  path: "11111111-1111-4111-8111-111111111111/resident/case/object",
  fileName: "notice.pdf",
  contentType: "application/pdf",
  sizeBytes: 1_024,
  sha256: "a".repeat(64),
  idempotencyKey: `upload:${"a".repeat(64)}:notice.pdf`,
}, { secret, now });
assert.equal(verifyDocumentUploadGrant(issued.token, { secret, now: now + 1_000 }).caseId, issued.claims.caseId);
assert.throws(
  () => verifyDocumentUploadGrant(`${issued.token.slice(0, -1)}x`, { secret, now: now + 1_000 }),
  (error: unknown) => error instanceof DocumentUploadGrantError && error.code === "upload_grant_invalid",
);
assert.throws(
  () => verifyDocumentUploadGrant(issued.token, { secret, now: issued.claims.expiresAt }),
  (error: unknown) => error instanceof DocumentUploadGrantError && error.code === "upload_grant_expired",
);

const runtime = {
  environment: "staging",
  releaseVersion: "test",
  configVersion: "test",
  syntheticMode: false,
  tenantHosts: { "test.invalid": "wayne" },
  features,
  providers: {
    countySource: "disabled",
    language: "disabled",
    messaging: "disabled",
    scanner: "disabled",
    paymentHandoff: "disabled",
    identityProofing: "disabled",
    telephony: "disabled",
  },
  telemetryConfigured: true,
  telemetryAdapter: "otlp-http-json",
  providerReadiness: { ready: true, providers: {} },
} as unknown as RuntimeConfig;
let platformProbed = false;
let telemetryProbed = false;
const hostedReadiness = await probeRuntimeReadiness(
  runtime,
  { ...process.env, CIVYA_ENVIRONMENT: "staging" } as NodeJS.ProcessEnv,
  {
  supabaseConfigured: () => true,
  platform: async () => {
    platformProbed = true;
    return {
      ok: false,
      configured: true,
      database: { ok: true, latencyMs: 2 },
      storage: { ok: false, latencyMs: 3, error: "bucket missing" },
    };
  },
  telemetry: async () => {
    telemetryProbed = true;
    return { ok: true, configured: true, adapter: "otlp-http-json", latencyMs: 4 };
  },
  },
);
assert.equal(platformProbed, true);
assert.equal(telemetryProbed, true);
assert.equal(hostedReadiness.ready, false);
assert.equal(hostedReadiness.database, "ready");
assert.equal(hostedReadiness.storage, "not_ready");
assert.equal(hostedReadiness.telemetry, "ready");

const grantRoute = read("app/api/uploads/route.ts");
const finalizeRoute = read("app/api/uploads/finalize/route.ts");
const client = read("lib/documents/upload-client.ts");
assert.doesNotMatch(grantRoute, /\.formData\(|\.arrayBuffer\(|uploadToSignedUrl/);
assert.match(client, /uploadToSignedUrl/);
assert.match(client, /\/api\/uploads\/finalize/);
assert.match(finalizeRoute, /inspectDocumentUploadObject/);
assert.match(finalizeRoute, /object\.sizeBytes !== claims\.sizeBytes/);
assert.match(finalizeRoute, /object\.contentType !== claims\.contentType/);
assert.match(finalizeRoute, /storedDigest !== claims\.sha256/);
assert.match(finalizeRoute, /scanStatus: "pending"/);
assert.match(finalizeRoute, /idempotent_replay/);
assert.match(read("app/page.tsx"), /uploadDocumentDirect/);
assert.match(read("app/case/[caseId]/page.tsx"), /uploadDocumentDirect/);
assert.match(read("next.config.ts"), /Content-Security-Policy/);
assert.match(read("next.config.ts"), /Strict-Transport-Security/);
assert.match(read("app/api/health/ready/route.ts"), /probeRuntimeReadiness/);
assert.match(read("lib/health/readiness.server.ts"), /checkPlatformHealth/);
assert.match(read("lib/health/readiness.server.ts"), /checkTelemetryHealth/);
assert.match(read("lib/health/readiness.server.ts"), /providerReadiness\.ready/);

console.log("Runtime gates and Vercel-safe direct document uploads: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
