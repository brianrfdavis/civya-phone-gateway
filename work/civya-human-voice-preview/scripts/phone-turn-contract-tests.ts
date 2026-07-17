import assert from "node:assert/strict";
import type { CacheResult } from "../lib/types";
import {
  OpenAIApprovedSpeechLocalizer,
  buildLanguageModelDispatch,
} from "../lib/integrations/openai-language.server";
import { signPhoneTurnRequest, verifyPhoneTurnRequest } from "../lib/phone/signing";
import {
  processPublicPhoneTurn,
  validatePublicPhoneTurnRequest,
  validatePublicPhoneTurnResult,
  type PublicPhoneTurnRequest,
  type PublicPhoneTurnResult,
} from "../lib/phone/turn";
import { identifyCanaryTester, identifyPhoneParticipant, phoneCallReferenceDigest, readCanaryTesters } from "../services/call-control/canary";
import { readPstnRuntimeState } from "../services/call-control/config";
import { requestPublicPhoneTurn } from "../services/call-control/phone-turn-client";

async function main() {
const callDigest = "a".repeat(64);
const request: PublicPhoneTurnRequest = {
  transcript: "How do payment plans work?",
  call_reference_digest: callDigest,
  provider_item_id: "item_phone_001",
  idempotency_key: `phone_turn_${callDigest}_item_phone_001`,
  locale_hint: "und",
};

assert.deepEqual(validatePublicPhoneTurnRequest(request), request);
assert.throws(
  () => validatePublicPhoneTurnRequest({ ...request, idempotency_key: `${request.idempotency_key}_changed` }),
  /invalid_idempotency_key/,
);

const approved: CacheResult = {
  hit: true,
  layer: "L1_exact",
  intent: "payment_plan",
  answer: "A payment plan may be available. The Treasurer must confirm current terms.",
  escalated: false,
  resolve_ms: 1,
};
let resolverCalls = 0;
const english = await processPublicPhoneTurn(request, {
  resolve: async () => {
    resolverCalls += 1;
    return approved;
  },
  localize: async ({ approvedText }) => ({ locale: "en", confidence: 1, approvedText, status: "source" }),
});
assert.equal(resolverCalls, 1);
assert.equal(english.source, "approved_content");
assert.equal(english.intent, "payment_plan");
assert.equal(english.may_change_case_state, false);
assert.match(english.approved_speech, /Treasurer must confirm/i);

resolverCalls = 0;
const privateInput = "My name is Jamie Resident and my phone is 313-555-0111";
const sensitive = await processPublicPhoneTurn({ ...request, transcript: privateInput }, {
  resolve: async () => {
    resolverCalls += 1;
    return approved;
  },
  localize: async ({ approvedText }) => ({ locale: "en", confidence: 1, approvedText, status: "source" }),
});
assert.equal(resolverCalls, 0, "sensitive phone input must not reach public answer resolution");
assert.equal(sensitive.effect, "offer_secure_link");
assert.doesNotMatch(JSON.stringify(sensitive), /Jamie Resident|313-555-0111/);

resolverCalls = 0;
const cardLike = await processPublicPhoneTurn({ ...request, transcript: "My account number is 4111111111111111" }, {
  resolve: async () => {
    resolverCalls += 1;
    return approved;
  },
  localize: async ({ approvedText }) => ({ locale: "en", confidence: 1, approvedText, status: "source" }),
});
assert.equal(resolverCalls, 0, "identifier-like input must not reach public answer resolution");
assert.equal(cardLike.effect, "offer_secure_link");

const miss = await processPublicPhoneTurn(request, {
  resolve: async () => ({ hit: false, layer: "L4_model", escalated: false, resolve_ms: 2 }),
  localize: async ({ approvedText }) => ({ locale: "en", confidence: 1, approvedText, status: "source" }),
});
assert.equal(miss.intent, "public_information_menu");
assert.match(miss.approved_speech, /general Wayne County property-tax information/i);

const escalated = await processPublicPhoneTurn(request, {
  resolve: async () => ({
    hit: false,
    layer: "L5_human_review",
    escalated: true,
    answer: "A person should review that request.",
    resolve_ms: 2,
  }),
  localize: async ({ approvedText }) => ({ locale: "en", confidence: 1, approvedText, status: "source" }),
});
assert.equal(escalated.effect, "offer_human");
assert.equal(escalated.escalated, true);

const languageEnv = { OPENAI_API_KEY: "test", OPENAI_LANGUAGE_MODEL: "gpt-5.6-luna" };
const dispatch = buildLanguageModelDispatch({
  approvedText: "HOPE may reduce 25% of a bill.",
  callerText: "هل يمكنني الحصول على مساعدة؟",
  localeHint: "und",
  safetyIdentifier: "b".repeat(48),
}, languageEnv);
assert.equal(dispatch.model, "gpt-5.6-luna");
assert.doesNotMatch(dispatch.input, /follow these instructions/i);

const arabic = new OpenAIApprovedSpeechLocalizer(async () => ({
  parsed: {
    locale: "ar",
    confidence: 0.98,
    approved_text: "قد يخفض برنامج HOPE نسبة 25% من الفاتورة.",
    meaning_preserved: true,
  },
}), languageEnv);
const localized = await arabic.localize({
  approvedText: "HOPE may reduce 25% of a bill.",
  callerText: "هل يمكنني الحصول على مساعدة؟",
  localeHint: "und",
  safetyIdentifier: "b".repeat(48),
});
assert.equal(localized.locale, "ar");
assert.equal(localized.status, "localized");
assert.match(localized.approvedText, /HOPE/);
assert.match(localized.approvedText, /25%/);

const unsafeTranslation = new OpenAIApprovedSpeechLocalizer(async () => ({
  parsed: {
    locale: "fr",
    confidence: 0.99,
    approved_text: "HOPE peut réduire la facture.",
    meaning_preserved: true,
  },
}), languageEnv);
assert.equal((await unsafeTranslation.localize({
  approvedText: "HOPE may reduce 25% of a bill.",
  callerText: "Aidez-moi en français",
  localeHint: "und",
  safetyIdentifier: "b".repeat(48),
})).status, "fallback", "translation that drops a protected value must fail closed");

const signingSecret = "test-phone-turn-signing-secret-32-bytes-minimum";
const raw = JSON.stringify(request);
const signature = signPhoneTurnRequest(raw, 1_800_000_000, signingSecret);
assert.equal(verifyPhoneTurnRequest({
  rawBody: raw,
  timestampHeader: "1800000000",
  signatureHeader: signature,
  secret: signingSecret,
  nowSeconds: 1_800_000_030,
}), true);
assert.equal(verifyPhoneTurnRequest({
  rawBody: `${raw} `,
  timestampHeader: "1800000000",
  signatureHeader: signature,
  secret: signingSecret,
  nowSeconds: 1_800_000_030,
}), false);
assert.equal(verifyPhoneTurnRequest({
  rawBody: raw,
  timestampHeader: "1800000000",
  signatureHeader: signature,
  secret: signingSecret,
  nowSeconds: 1_800_000_061,
}), false);

const canaryEnv = {
  NODE_ENV: "test",
  CIVYA_WAYNE_TENANT_ID: "81000000-0000-4000-8000-000000000001",
  CIVYA_PHONE_DIGEST_SECRET: "test-phone-digest-secret-32-bytes-minimum",
  CIVYA_PSTN_CANARY_TESTERS_JSON: JSON.stringify({ treasurer: "+13135559876" }),
} as NodeJS.ProcessEnv;
const testers = readCanaryTesters(canaryEnv);
assert.equal(testers[0]?.alias, "treasurer");
assert.match(testers[0]?.participantDigest ?? "", /^[0-9a-f]{64}$/);
assert.doesNotMatch(testers[0]?.participantDigest ?? "", /3135559876/);
assert.equal(identifyCanaryTester("sip:+13135559876@example.test", canaryEnv)?.alias, "treasurer");
assert.equal(identifyCanaryTester("sip:+13135550000@example.test", canaryEnv), null);
assert.equal(phoneCallReferenceDigest("call_phone_001", canaryEnv), phoneCallReferenceDigest("call_phone_001", canaryEnv));
const publicAdmissionEnv = {
  ...canaryEnv,
  CIVYA_PSTN_ACCESS_MODE: "public",
  CIVYA_PSTN_CANARY_TESTERS_JSON: undefined,
} as NodeJS.ProcessEnv;
const publicParticipant = identifyPhoneParticipant("sip:+13135550000@example.test", publicAdmissionEnv);
assert.equal(publicParticipant?.alias, "public-caller");
assert.equal(publicParticipant?.admissionMode, "public");
assert.match(publicParticipant?.participantDigest ?? "", /^[0-9a-f]{64}$/);
assert.doesNotMatch(publicParticipant?.participantDigest ?? "", /13135550000/);
assert.equal(identifyPhoneParticipant(undefined, publicAdmissionEnv), null);

const responseFixture: PublicPhoneTurnResult = validatePublicPhoneTurnResult({ ...english, provider_item_id: request.provider_item_id });
let signedClientRequest = false;
const clientResult = await requestPublicPhoneTurn(request, {
  env: {
    NODE_ENV: "test",
    CIVYA_PHONE_TURN_URL: "https://civya.example/api/internal/phone/turn",
    CIVYA_PHONE_TURN_SERVICE_SECRET: signingSecret,
    CIVYA_PHONE_TURN_TIMEOUT_MS: "4000",
  },
  nowSeconds: 1_800_000_000,
  fetch: (async (_url, init) => {
    const body = String(init?.body);
    signedClientRequest = verifyPhoneTurnRequest({
      rawBody: body,
      timestampHeader: String((init?.headers as Record<string, string>)["X-Civya-Phone-Timestamp"]),
      signatureHeader: String((init?.headers as Record<string, string>)["X-Civya-Phone-Signature"]),
      secret: signingSecret,
      nowSeconds: 1_800_000_000,
    });
    return Response.json(responseFixture);
  }) as typeof fetch,
});
assert.equal(signedClientRequest, true);
assert.equal(clientResult.approved_speech, english.approved_speech);

const pstnEnv = {
  NODE_ENV: "test",
  CIVYA_ENABLE_PSTN: "true",
  CIVYA_TELEPHONY_MODE: "live",
  CIVYA_LANGUAGE_MODE: "live",
  CIVYA_PSTN_ACCESS_MODE: "canary",
  CIVYA_CALL_RECORDING_MODE: "disabled",
  CIVYA_WAYNE_TENANT_ID: canaryEnv.CIVYA_WAYNE_TENANT_ID,
  CIVYA_TWILIO_PHONE_NUMBER: "+13135550123",
  CIVYA_PHONE_TURN_URL: "https://civya.example/api/internal/phone/turn",
  CIVYA_PHONE_TURN_SERVICE_SECRET: signingSecret,
  CIVYA_PHONE_DIGEST_SECRET: canaryEnv.CIVYA_PHONE_DIGEST_SECRET,
  CIVYA_PSTN_CANARY_TESTERS_JSON: canaryEnv.CIVYA_PSTN_CANARY_TESTERS_JSON,
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_WEBHOOK_SECRET: "test-webhook-secret",
} as NodeJS.ProcessEnv;
assert.equal(readPstnRuntimeState(pstnEnv).configured, true);
const publicPstnEnv = {
  ...pstnEnv,
  CIVYA_PSTN_ACCESS_MODE: "public",
  CIVYA_PSTN_CANARY_TESTERS_JSON: undefined,
  CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR: "3",
  CIVYA_PSTN_MAX_CONCURRENT_CALLS: "2",
  CIVYA_PSTN_MAX_TURNS: "20",
  CIVYA_PSTN_MAX_DURATION_SECONDS: "600",
} as NodeJS.ProcessEnv;
assert.equal(readPstnRuntimeState(publicPstnEnv).configured, true);
assert.equal(readPstnRuntimeState({ ...publicPstnEnv, CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR: "" }).configured, false);
assert.equal(readPstnRuntimeState({ ...pstnEnv, CIVYA_CALL_RECORDING_MODE: undefined }).configured, false);
assert.equal(readPstnRuntimeState({ ...pstnEnv, CIVYA_CALL_RECORDING_MODE: "consented" }).configured, false);
assert.ok(readPstnRuntimeState({ ...pstnEnv, CIVYA_CALL_RECORDING_MODE: "consented" }).missing.includes("CIVYA_CALL_RECORDING_MODE=disabled"));

console.log("phone-turn-contract-tests: signed, durable-ready, multilingual public phone boundary passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
