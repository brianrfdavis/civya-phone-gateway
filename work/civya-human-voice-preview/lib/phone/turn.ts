import { resolveAnswer } from "@/lib/cache/resolver";
import { containsSensitiveMaterial } from "@/lib/conversation/policy";
import {
  OpenAIApprovedSpeechLocalizer,
  type ApprovedSpeechLocalization,
} from "@/lib/integrations/openai-language.server";
import { redactTranscript } from "@/lib/platform/redaction";

const DIGEST = /^[0-9a-f]{64}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{6,200}$/;
const BCP47 = /^(?:und|[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?)$/;
const SAFE_INTENT = /^[a-z0-9_]{2,100}$/;
const IMMEDIATE_DANGER = /\b(?:call 911|emergency|in immediate danger|someone is hurt|fire|suicide|kill myself)\b/i;

export type PublicPhoneEffect = "none" | "offer_secure_link" | "offer_human";

export interface PublicPhoneTurnRequest {
  transcript: string;
  call_reference_digest: string;
  provider_item_id: string;
  idempotency_key: string;
  locale_hint?: string;
}

export interface PublicPhoneTurnResult {
  version: "1";
  provider_item_id: string;
  intent: string;
  approved_speech: string;
  canonical_speech: string;
  locale: string;
  language_confidence: number;
  language_status: "source" | "localized" | "fallback";
  effect: PublicPhoneEffect;
  offer_secure_link: boolean;
  escalated: boolean;
  source: "deterministic_policy" | "approved_content";
  source_layer: string;
  may_change_case_state: false;
}

export interface PublicPhoneTurnDependencies {
  resolve?: typeof resolveAnswer;
  localize?: (input: {
    approvedText: string;
    callerText: string;
    localeHint?: string;
    safetyIdentifier: string;
  }) => Promise<ApprovedSpeechLocalization>;
}

export function validatePublicPhoneTurnRequest(value: unknown): PublicPhoneTurnRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_phone_turn_request");
  const body = value as Record<string, unknown>;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const callReferenceDigest = typeof body.call_reference_digest === "string" ? body.call_reference_digest : "";
  const providerItemId = typeof body.provider_item_id === "string" ? body.provider_item_id : "";
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  const localeHint = typeof body.locale_hint === "string" ? body.locale_hint : undefined;
  if (!transcript || transcript.length > 2_000) throw new Error("invalid_transcript");
  if (!DIGEST.test(callReferenceDigest)) throw new Error("invalid_call_reference");
  if (!ITEM_ID.test(providerItemId)) throw new Error("invalid_provider_item");
  if (idempotencyKey !== `phone_turn_${callReferenceDigest}_${providerItemId}`) {
    throw new Error("invalid_idempotency_key");
  }
  if (localeHint && !BCP47.test(localeHint)) throw new Error("invalid_locale_hint");
  return {
    transcript,
    call_reference_digest: callReferenceDigest,
    provider_item_id: providerItemId,
    idempotency_key: idempotencyKey,
    locale_hint: localeHint,
  };
}

export function validatePublicPhoneTurnResult(value: unknown, expectedItemId?: string): PublicPhoneTurnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_phone_turn_result");
  const result = value as Record<string, unknown>;
  if (result.version !== "1" || typeof result.provider_item_id !== "string" || !ITEM_ID.test(result.provider_item_id)) {
    throw new Error("invalid_phone_turn_result");
  }
  if (expectedItemId && result.provider_item_id !== expectedItemId) throw new Error("phone_turn_item_mismatch");
  if (typeof result.intent !== "string" || !SAFE_INTENT.test(result.intent)) throw new Error("invalid_phone_turn_intent");
  if (typeof result.approved_speech !== "string" || !result.approved_speech.trim() || result.approved_speech.length > 2_400) {
    throw new Error("invalid_phone_turn_speech");
  }
  if (typeof result.canonical_speech !== "string" || !result.canonical_speech.trim() || result.canonical_speech.length > 2_000) {
    throw new Error("invalid_phone_turn_canonical_speech");
  }
  if (typeof result.locale !== "string" || !BCP47.test(result.locale)) throw new Error("invalid_phone_turn_locale");
  if (typeof result.language_confidence !== "number" || result.language_confidence < 0 || result.language_confidence > 1) {
    throw new Error("invalid_phone_turn_language_confidence");
  }
  if (!new Set(["source", "localized", "fallback"]).has(String(result.language_status))) {
    throw new Error("invalid_phone_turn_language_status");
  }
  if (!new Set(["none", "offer_secure_link", "offer_human"]).has(String(result.effect))) {
    throw new Error("invalid_phone_turn_effect");
  }
  if (typeof result.offer_secure_link !== "boolean" || typeof result.escalated !== "boolean") {
    throw new Error("invalid_phone_turn_flags");
  }
  if (!new Set(["deterministic_policy", "approved_content"]).has(String(result.source))) {
    throw new Error("invalid_phone_turn_source");
  }
  if (typeof result.source_layer !== "string" || result.source_layer.length > 80 || result.may_change_case_state !== false) {
    throw new Error("invalid_phone_turn_authority");
  }
  return result as unknown as PublicPhoneTurnResult;
}

export async function processPublicPhoneTurn(
  request: PublicPhoneTurnRequest,
  dependencies: PublicPhoneTurnDependencies = {},
): Promise<PublicPhoneTurnResult> {
  const input = validatePublicPhoneTurnRequest(request);
  const safeCallerText = redactTranscript(input.transcript);
  const redactionDetected = /\[(?:EMAIL|PHONE|GOVERNMENT_ID|ADDRESS|PARCEL_ID|NAME|IDENTIFIER)\]/.test(safeCallerText);
  const resolve = dependencies.resolve ?? resolveAnswer;
  const localize = dependencies.localize ?? ((value) => new OpenAIApprovedSpeechLocalizer().localize(value));

  let intent = "public_information_menu";
  let canonicalSpeech = "I can help with general Wayne County property-tax information. I cannot look up or change a private case on this test phone line. You can ask a general question, request a secure link, or say person for human help.";
  let effect: PublicPhoneEffect = "none";
  let offerSecureLink = false;
  let escalated = false;
  let source: PublicPhoneTurnResult["source"] = "deterministic_policy";
  let sourceLayer = "public_phone_policy";

  if (IMMEDIATE_DANGER.test(input.transcript)) {
    intent = "immediate_danger";
    canonicalSpeech = "Civya is not an emergency service. If anyone is in immediate danger, hang up and call 911 now. For non-emergency help with a tax notice, ask for a person.";
    effect = "offer_human";
    escalated = true;
  } else if (containsSensitiveMaterial(input.transcript) || redactionDetected) {
    intent = "sensitive_information_blocked";
    canonicalSpeech = "For your privacy, I cannot use personal, payment, or case-specific details on this test phone line. I can send a secure link so you can sign in and continue safely, or you can ask for a person.";
    effect = "offer_secure_link";
    offerSecureLink = true;
  } else {
    const resolved = await resolve(safeCallerText, "voice", {
      safetyIdentifier: input.call_reference_digest.slice(0, 48),
      languageMode: "live",
    });
    if ((resolved.hit || resolved.escalated) && resolved.answer) {
      intent = SAFE_INTENT.test(resolved.intent ?? "") ? resolved.intent! : "approved_public_answer";
      canonicalSpeech = resolved.answer.trim().slice(0, 2_000);
      escalated = resolved.escalated;
      effect = resolved.escalated ? "offer_human" : "none";
      offerSecureLink = resolved.escalated;
      source = resolved.hit ? "approved_content" : "deterministic_policy";
      sourceLayer = resolved.layer;
    }
  }

  let localized: ApprovedSpeechLocalization;
  try {
    localized = await localize({
      approvedText: canonicalSpeech,
      callerText: safeCallerText,
      localeHint: input.locale_hint,
      safetyIdentifier: input.call_reference_digest.slice(0, 48),
    });
  } catch {
    localized = { locale: "en", confidence: 0, approvedText: canonicalSpeech, status: "fallback" };
  }

  return validatePublicPhoneTurnResult({
    version: "1",
    provider_item_id: input.provider_item_id,
    intent,
    approved_speech: localized.approvedText,
    canonical_speech: canonicalSpeech,
    locale: localized.locale,
    language_confidence: localized.confidence,
    language_status: localized.status,
    effect,
    offer_secure_link: offerSecureLink,
    escalated,
    source,
    source_layer: sourceLayer,
    may_change_case_state: false,
  }, input.provider_item_id);
}
