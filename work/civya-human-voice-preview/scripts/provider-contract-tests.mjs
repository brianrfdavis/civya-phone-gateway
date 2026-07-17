#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const webhooks = await load("lib/integrations/webhooks.ts");
const secureLinks = await load("lib/secure-links/index.ts");
const payments = await load("lib/integrations/payments.ts");
const calls = await load("services/call-control/contracts.ts");
const messaging = await load("lib/integrations/messaging.ts");
const scanner = await load("lib/integrations/scanner.ts");
const docusign = await load("lib/integrations/docusign.ts");

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("Provider, secure-link, reconciliation, and call-control contracts");

await check("Standard Webhooks verifies raw-body HMAC, replay window, and duplicate ID", () => {
  const nowMs = 1_750_000_000_000;
  const timestampSeconds = Math.floor(nowMs / 1000);
  const secret = `whsec_${Buffer.from("synthetic-standard-webhook-key-32", "utf8").toString("base64")}`;
  const rawBody = JSON.stringify({ id: "wh_evt_000001", type: "response.completed" });
  const signature = webhooks.signStandardWebhookForTest({ secret, eventId: "wh_evt_000001", timestampSeconds, rawBody });
  const guard = new webhooks.InMemoryWebhookReplayGuard();
  const input = {
    secret,
    rawBody,
    headers: {
      "webhook-id": "wh_evt_000001",
      "webhook-timestamp": String(timestampSeconds),
      "webhook-signature": `v1,${signature}`,
    },
    replayGuard: guard,
    nowMs,
  };
  assert.equal(webhooks.verifyStandardWebhook(input).valid, true);
  const duplicate = webhooks.verifyStandardWebhook(input);
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.reason, "duplicate");
  const stale = webhooks.verifyStandardWebhook({
    ...input,
    replayGuard: new webhooks.InMemoryWebhookReplayGuard(),
    headers: { ...input.headers, "webhook-timestamp": String(timestampSeconds - 301) },
  });
  assert.equal(stale.reason, "invalid_signature");
  const staleSignature = webhooks.signStandardWebhookForTest({
    secret,
    eventId: "wh_evt_000002",
    timestampSeconds: timestampSeconds - 301,
    rawBody,
  });
  const signedStale = webhooks.verifyStandardWebhook({
    ...input,
    replayGuard: new webhooks.InMemoryWebhookReplayGuard(),
    headers: {
      "webhook-id": "wh_evt_000002",
      "webhook-timestamp": String(timestampSeconds - 301),
      "webhook-signature": `v1,${staleSignature}`,
    },
  });
  assert.equal(signedStale.reason, "outside_replay_window");
});

await check("Twilio form and JSON validation cover exact URL, body digest, replay, and tamper", () => {
  const nowMs = 1_750_000_000_000;
  const timestampSeconds = Math.floor(nowMs / 1000);
  const authToken = "synthetic-twilio-auth-token";
  const url = "https://civya.example/api/webhooks/twilio";
  const parameters = { CallSid: "CA0000000001", CallStatus: "completed", SequenceNumber: "4" };
  const signature = webhooks.signTwilioWebhookForTest({ authToken, url, parameters });
  const verified = webhooks.verifyTwilioWebhook({
    authToken,
    signature,
    url,
    rawBody: new URLSearchParams(parameters).toString(),
    contentType: "application/x-www-form-urlencoded",
    parameters,
    eventId: "CA0000000001:4:completed",
    occurredAtSeconds: timestampSeconds,
    nowMs,
    replayGuard: new webhooks.InMemoryWebhookReplayGuard(),
    requireReplayTimestamp: true,
  });
  assert.equal(verified.valid, true);
  const jsonBody = JSON.stringify({ EventSid: "EV0000000001", state: "ended" });
  const digest = createHash("sha256").update(jsonBody).digest("hex");
  const jsonUrl = `${url}?bodySHA256=${digest}`;
  const jsonSignature = webhooks.signTwilioWebhookForTest({ authToken, url: jsonUrl });
  assert.equal(webhooks.verifyTwilioWebhook({
    authToken,
    signature: jsonSignature,
    url: jsonUrl,
    rawBody: jsonBody,
    contentType: "application/json",
    eventId: "EV0000000001",
    occurredAtSeconds: timestampSeconds,
    nowMs,
    replayGuard: new webhooks.InMemoryWebhookReplayGuard(),
    requireReplayTimestamp: true,
  }).valid, true);
  assert.equal(webhooks.verifyTwilioWebhook({
    authToken,
    signature: jsonSignature,
    url: jsonUrl,
    rawBody: `${jsonBody} `,
    contentType: "application/json",
    eventId: "EV0000000002",
    occurredAtSeconds: timestampSeconds,
    nowMs,
    replayGuard: new webhooks.InMemoryWebhookReplayGuard(),
    requireReplayTimestamp: true,
  }).reason, "invalid_body_digest");
});

await check("Secure handoff links are exact-origin, session-bound, expiring, and single use", () => {
  let nowMs = 1_750_000_000_000;
  const service = new secureLinks.SecureLinkService({
    secret: "synthetic-secure-link-secret-at-least-32-bytes",
    localBaseUrl: "https://civya.example",
    allowedOrigins: ["https://payments.example.invalid"],
    store: new secureLinks.InMemorySingleUseLinkStore(() => nowMs),
    now: () => nowMs,
  });
  const issued = service.issue({
    purpose: "external_handoff",
    handoffId: "opaque_handoff_0001",
    provider: "jpm_chase",
    sessionBinding: "session_binding_0000001",
    destination: "https://payments.example.invalid/hosted?session=syn_1",
    ttlSeconds: 60,
  });
  assert.equal(new URL(issued.url).origin, "https://civya.example");
  const claims = service.consume({
    token: issued.token,
    expectedPurpose: "external_handoff",
    sessionBinding: "session_binding_0000001",
  });
  assert.equal(claims.destination, "https://payments.example.invalid/hosted?session=syn_1");
  assert.throws(() => service.consume({
    token: issued.token,
    expectedPurpose: "external_handoff",
    sessionBinding: "session_binding_0000001",
  }), /already used/);
  assert.throws(() => service.issue({
    purpose: "external_handoff",
    handoffId: "opaque_handoff_0002",
    provider: "jpm_chase",
    sessionBinding: "session_binding_0000001",
    destination: "https://evil.example/hosted?session=syn_1",
  }), /allowlist/);
  assert.throws(() => service.issue({
    purpose: "external_handoff",
    handoffId: "opaque_handoff_0003",
    provider: "jpm_chase",
    sessionBinding: "session_binding_0000001",
    destination: "https://payments.example.invalid/hosted?parcel=123",
  }), /query key/);
  const expiring = service.issue({
    purpose: "browser_return",
    handoffId: "opaque_handoff_0004",
    provider: "jpm_chase",
    sessionBinding: "session_binding_0000001",
    ttlSeconds: 30,
  });
  nowMs += 31_000;
  assert.throws(() => service.consume({
    token: expiring.token,
    expectedPurpose: "browser_return",
    sessionBinding: "session_binding_0000001",
  }), /expired/);
});

await check("Browser return remains advisory; only matched authoritative active-plan status completes", async () => {
  const browser = payments.classifyBrowserReturn("opaque_handoff_0001", "2026-07-16T12:00:00.000Z");
  assert.equal(browser.authority, "advisory");
  assert.equal(browser.maySetCompletion, false);
  const expectation = {
    obligationReference: "opaque_obligation_0001",
    parcelReference: "opaque_parcel_0001",
    taxYear: 2025,
    currency: "USD",
    expectedAmountMinor: 12500,
    expectedRecordCount: 1,
    expectedControlTotalMinor: 12500,
  };
  const record = {
    ...expectation,
    amountMinor: expectation.expectedAmountMinor,
    source: "wayne_county",
    authority: "authoritative",
    sourceRevision: "wayne-fixture-1",
    providerTransactionReference: "opaque_transaction_0001",
    paymentStatus: "posted",
    planStatus: "active",
  };
  delete record.expectedAmountMinor;
  delete record.expectedRecordCount;
  delete record.expectedControlTotalMinor;
  assert.equal(payments.reconcileAuthoritativePayment(expectation, record, { recordCount: 1, controlTotalMinor: 12500 }).verifiedCompletion, true);
  const wrongParcel = payments.reconcileAuthoritativePayment(expectation, { ...record, parcelReference: "opaque_parcel_wrong" });
  assert.equal(wrongParcel.paymentStatus, "unmatched");
  assert.equal(wrongParcel.verifiedCompletion, false);
  assert.throws(() => payments.assertNoPaymentCredentials({ card_number: "4111111111111111" }), /Prohibited/);
  const adapter = new payments.SyntheticJpmChaseHostedAdapter({ now: () => 1_750_000_000_000 });
  const session = await adapter.createHostedSession({
    obligationReference: "opaque_obligation_0001",
    parcelReference: "opaque_parcel_0001",
    taxYear: 2025,
    idempotencyKey: "idem_handoff_0001",
    currency: "USD",
    amountMinor: 12500,
    returnSupported: true,
  });
  assert.equal(session.capturesPaymentCredentials, false);
  assert.equal(session.browserReturnAuthority, "advisory");
});

await check("Call contracts enforce approved speech, model authority, transfer, and fallback", () => {
  const speech = calls.approveSpeech({
    id: "approved_1",
    text: "I can connect you with a Wayne County navigator.",
    source: "deterministic_policy",
    locale: "en-US",
  });
  assert.equal(speech.mayChangeCaseState, false);
  assert.throws(() => calls.assertModelProposalHasNoAuthority({ intent: "help", payment_status: "posted" }), /authority violation/);
  const human = calls.chooseCallFallback({
    reason: "resident_requested_human",
    deterministicTtsAvailable: true,
    approvedSpeech: speech,
    humanTransferAvailable: true,
  });
  assert.equal(human.kind, "human_transfer");
  const tts = calls.chooseCallFallback({
    reason: "openai_unavailable",
    deterministicTtsAvailable: true,
    approvedSpeech: speech,
    humanTransferAvailable: false,
  });
  assert.equal(tts.kind, "deterministic_tts");
  const transfer = calls.createHumanTransferDirective({
    queue: "wayne_navigator",
    reasonCode: "resident_requested_human",
    priority: "high",
    caseReference: "opaque_case_0000001",
    includeTranscriptSummary: false,
  });
  assert.equal(transfer.requiresStaffAcceptance, true);
});

await check("Messaging, scanner, and DocuSign synthetic adapters preserve safe boundaries", async () => {
  const messenger = new messaging.SyntheticTwilioMessagingAdapter(() => 1_750_000_000_000);
  const message = {
    contactToken: "contact_00000001",
    template: {
      templateId: "reminder-1",
      version: "1",
      locale: "en-US",
      channel: "sms",
      allowedVariableNames: ["deadline_label"],
      containsSensitiveContent: false,
    },
    variables: { deadline_label: "tomorrow" },
    consentReference: "consent_00000001",
    idempotencyKey: "idem_message_0001",
    quietHoursCheckedAt: "2026-07-16T12:00:00.000Z",
  };
  assert.equal((await messenger.send(message)).duplicate, false);
  assert.equal((await messenger.send(message)).duplicate, true);
  const scanResult = await new scanner.SyntheticDocumentScanner(() => 1_750_000_000_000).scan({
    storageObjectReference: "object_00000001",
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    sizeBytes: 100,
    idempotencyKey: "idem_scan_0001",
    testVerdict: "malicious",
  });
  assert.equal(scanResult.mayRelease, false);
  assert.equal(scanResult.requiresHumanReview, true);
  const signature = docusign.classifySignatureStatus("syn_env_1", "completed");
  assert.equal(signature.provesPaymentOrPlanCompletion, false);
  assert.equal(signature.requiresCountyReconciliation, true);
});

await check("Route shells fail closed and encode advisory/authoritative boundaries", () => {
  assert.match(read("app/api/handoffs/return/route.ts"), /classifyBrowserReturn/);
  assert.match(read("app/api/webhooks/openai/route.ts"), /may_mutate_case_state: false/);
  const twilioRoute = read("app/api/webhooks/twilio/route.ts");
  assert.match(twilioRoute, /twilio\.validateRequest/);
  assert.match(twilioRoute, /claimProviderEvent/);
  assert.match(twilioRoute, /finishProviderEventClaim/);
  assert.match(twilioRoute, /providerEventId/);
  assert.match(read("app/api/webhooks/payments/route.ts"), /may_set_completion: false/);
  assert.match(read("app/api/identity/proofing/route.ts"), /DisabledClearIdentityAdapter/);
  assert.match(read("lib/secure-links/runtime.ts"), /Production must inject a durable atomic store/);
});

console.log(failures === 0 ? "\nALL PROVIDER CONTRACT TESTS PASSED" : `\n${failures} PROVIDER CONTRACT TESTS FAILED`);
process.exit(failures === 0 ? 0 : 1);
