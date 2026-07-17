import { resolveAnswer } from "@/lib/cache/resolver";
import { containsSensitiveMaterial } from "@/lib/conversation/policy";
import {
  OpenAIApprovedSpeechLocalizer,
  type ApprovedSpeechLocalization,
} from "@/lib/integrations/openai-language.server";
import {
  containsPrivateResearchQuestion,
  OpenAIOfficialSourceResearch,
  type OfficialResearchAnswer,
} from "@/lib/integrations/openai-official-research.server";
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
  source: "deterministic_policy" | "approved_content" | "official_research";
  source_layer: string;
  source_response_id?: string;
  source_domains?: string[];
  may_change_case_state: false;
}

export interface PublicPhoneTurnDependencies {
  resolve?: typeof resolveAnswer;
  research?: (input: {
    question: string;
    safetyIdentifier: string;
  }) => Promise<OfficialResearchAnswer | null>;
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
  if (!new Set(["deterministic_policy", "approved_content", "official_research"]).has(String(result.source))) {
    throw new Error("invalid_phone_turn_source");
  }
  if (typeof result.source_layer !== "string" || result.source_layer.length > 80 || result.may_change_case_state !== false) {
    throw new Error("invalid_phone_turn_authority");
  }
  if (result.source_response_id !== undefined
      && (typeof result.source_response_id !== "string" || !/^resp_[A-Za-z0-9_-]{4,200}$/.test(result.source_response_id))) {
    throw new Error("invalid_phone_turn_provenance");
  }
  if (result.source_domains !== undefined) {
    if (!Array.isArray(result.source_domains) || result.source_domains.length > 8
        || result.source_domains.some((domain) => typeof domain !== "string" || !/^[a-z0-9.-]{1,253}$/.test(domain))) {
      throw new Error("invalid_phone_turn_provenance");
    }
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
  // A supplied resolver owns the complete answer path unless its test or
  // caller explicitly injects research too. This preserves deterministic
  // dependency injection without allowing an unexpected live web request.
  const research = dependencies.research
    ?? (dependencies.resolve
      ? null
      : (value: { question: string; safetyIdentifier: string }) => new OpenAIOfficialSourceResearch().research(value));
  const localize = dependencies.localize ?? ((value) => new OpenAIApprovedSpeechLocalizer().localize(value));

  let intent = "public_information_menu";
  let canonicalSpeech = "I can help you make sense of the notice and work out the next step. Tell me what it says or what you're trying to do.";
  let effect: PublicPhoneEffect = "none";
  let offerSecureLink = false;
  let escalated = false;
  let source: PublicPhoneTurnResult["source"] = "deterministic_policy";
  let sourceLayer = "public_phone_policy";
  let sourceResponseId: string | undefined;
  let sourceDomains: string[] | undefined;
  let researchedLocalization: ApprovedSpeechLocalization | undefined;
  let officialResearchAttempted = false;

  if (IMMEDIATE_DANGER.test(input.transcript)) {
    intent = "immediate_danger";
    canonicalSpeech = "If anyone is in immediate danger, hang up and call 911 now. I can help with the property-tax issue once everyone is safe.";
    effect = "offer_human";
    escalated = true;
  } else if (containsSensitiveMaterial(input.transcript)
      || redactionDetected
      || containsPrivateResearchQuestion(input.transcript)) {
    intent = "sensitive_information_blocked";
    canonicalSpeech = "Let's keep private details off the phone line. I can text you a secure link so we can keep working, or connect you with a person.";
    effect = "offer_secure_link";
    offerSecureLink = true;
  } else {
    const resolved = await resolve(safeCallerText, "voice", {
      safetyIdentifier: input.call_reference_digest.slice(0, 48),
      // The Realtime model already chose the official-fact lane. Keep this
      // pass to local approved content only; never spend the phone deadline on
      // a second intent/embedding model before current-source research.
      languageMode: "synthetic",
    });
    if ((resolved.hit || resolved.escalated) && resolved.answer) {
      intent = SAFE_INTENT.test(resolved.intent ?? "") ? resolved.intent! : "approved_public_answer";
      canonicalSpeech = resolved.answer.trim().slice(0, 2_000);
      escalated = resolved.escalated;
      effect = resolved.escalated ? "offer_human" : "none";
      offerSecureLink = resolved.escalated;
      source = resolved.hit ? "approved_content" : "deterministic_policy";
      sourceLayer = resolved.layer;
    } else if (!resolved.escalated && research) {
      officialResearchAttempted = true;
      try {
        const researched = await research({
          question: safeCallerText,
          safetyIdentifier: input.call_reference_digest.slice(0, 48),
        });
        if (researched) {
          intent = "official_public_answer";
          canonicalSpeech = researched.spokenAnswer;
          source = "official_research";
          sourceLayer = "L4_official_web_search";
          sourceResponseId = researched.responseId;
          sourceDomains = [...researched.sourceDomains];
          researchedLocalization = {
            locale: researched.locale,
            confidence: 1,
            approvedText: researched.spokenAnswer,
            status: "source",
          };
        }
      } catch {
        // Timeouts, provider errors, unsupported answers, missing citations,
        // or unsafe formatting fail closed to the existing public menu.
      }
    }
  }

  let localized = researchedLocalization;
  if (!localized) {
    if (officialResearchAttempted && source === "deterministic_policy" && intent === "public_information_menu") {
      localized = { locale: "en", confidence: 0, approvedText: canonicalSpeech, status: "fallback" };
    } else {
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
    }
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
    ...(sourceResponseId ? { source_response_id: sourceResponseId } : {}),
    ...(sourceDomains ? { source_domains: sourceDomains } : {}),
    may_change_case_state: false,
  }, input.provider_item_id);
}
