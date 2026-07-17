export type CallChannel = "pstn" | "browser_voice";
export type CallState = "offered" | "connected" | "listening" | "speaking" | "transferring" | "ended" | "failed";

export interface ApprovedSpeechDirective {
  id: string;
  text: string;
  source: "deterministic_policy" | "approved_content";
  locale: string;
  mayChangeCaseState: false;
}

export function approveSpeech(input: {
  id: string;
  text: string;
  source: ApprovedSpeechDirective["source"];
  locale: string;
}): ApprovedSpeechDirective {
  const text = input.text.trim();
  if (!text || text.length > 600) throw new Error("Approved call speech must contain 1-600 characters.");
  return { ...input, text, mayChangeCaseState: false };
}

const MODEL_AUTHORITY_KEYS = /^(?:amount|case_status|completion|deadline|eligible|identity_verified|payment_status|route|transfer|workflow_state)$/i;

export function assertModelProposalHasNoAuthority(value: unknown, path = "proposal"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MODEL_AUTHORITY_KEYS.test(key)) throw new Error(`Model authority violation at ${path}.${key}.`);
    assertModelProposalHasNoAuthority(child, `${path}.${key}`);
  }
}

export interface HumanTransferDirective {
  kind: "human_transfer";
  queue: "wayne_navigator" | "urgent_notice" | "identity_assistance" | "technical_support";
  reasonCode: string;
  priority: "normal" | "high" | "urgent";
  caseReference?: string;
  contactToken?: string;
  includeTranscriptSummary: boolean;
  requiresStaffAcceptance: true;
}

export function createHumanTransferDirective(input: Omit<HumanTransferDirective, "kind" | "requiresStaffAcceptance">): HumanTransferDirective {
  if (!/^[a-z0-9_]{3,80}$/.test(input.reasonCode)) throw new Error("Transfer reason must be a safe code.");
  if (input.caseReference && !/^opaque_[A-Za-z0-9_-]{8,120}$/.test(input.caseReference)) {
    throw new Error("Transfer case reference must be opaque.");
  }
  if (input.contactToken && !/^contact_[A-Za-z0-9_-]{8,120}$/.test(input.contactToken)) {
    throw new Error("Transfer contact token must be opaque.");
  }
  return { ...input, kind: "human_transfer", requiresStaffAcceptance: true };
}

export type CallFallbackReason =
  | "openai_unavailable"
  | "twilio_media_failed"
  | "low_transcription_confidence"
  | "language_not_supported"
  | "model_authority_boundary"
  | "identity_assistance_required"
  | "resident_requested_human"
  | "urgent_safety_signal";

export type CallFallbackDirective =
  | { kind: "deterministic_tts"; speech: ApprovedSpeechDirective }
  | { kind: "human_transfer"; queue: HumanTransferDirective["queue"]; reason: CallFallbackReason }
  | { kind: "sms_followup"; templateId: string; contactToken: string; reason: CallFallbackReason }
  | { kind: "callback_queue"; contactToken: string; reason: CallFallbackReason }
  | { kind: "end_safely"; reason: CallFallbackReason };

export function chooseCallFallback(input: {
  reason: CallFallbackReason;
  approvedSpeech?: ApprovedSpeechDirective;
  deterministicTtsAvailable: boolean;
  humanTransferAvailable: boolean;
  smsFollowup?: { consented: boolean; templateId: string; contactToken: string };
  callback?: { consented: boolean; contactToken: string };
}): CallFallbackDirective {
  const humanFirst = new Set<CallFallbackReason>([
    "model_authority_boundary",
    "identity_assistance_required",
    "resident_requested_human",
    "urgent_safety_signal",
  ]);
  if (humanFirst.has(input.reason) && input.humanTransferAvailable) {
    const queue: HumanTransferDirective["queue"] = input.reason === "identity_assistance_required"
      ? "identity_assistance"
      : input.reason === "urgent_safety_signal"
        ? "urgent_notice"
        : "wayne_navigator";
    return { kind: "human_transfer", queue, reason: input.reason };
  }
  if (input.deterministicTtsAvailable && input.approvedSpeech) {
    return { kind: "deterministic_tts", speech: input.approvedSpeech };
  }
  if (input.smsFollowup?.consented) {
    if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(input.smsFollowup.templateId)
      || !/^contact_[A-Za-z0-9_-]{8,120}$/.test(input.smsFollowup.contactToken)) {
      throw new Error("SMS fallback requires an approved template and opaque contact token.");
    }
    return {
      kind: "sms_followup",
      templateId: input.smsFollowup.templateId,
      contactToken: input.smsFollowup.contactToken,
      reason: input.reason,
    };
  }
  if (input.callback?.consented) {
    if (!/^contact_[A-Za-z0-9_-]{8,120}$/.test(input.callback.contactToken)) {
      throw new Error("Callback fallback requires an opaque contact token.");
    }
    return { kind: "callback_queue", contactToken: input.callback.contactToken, reason: input.reason };
  }
  if (input.humanTransferAvailable) return { kind: "human_transfer", queue: "technical_support", reason: input.reason };
  return { kind: "end_safely", reason: input.reason };
}

export interface CallProviderAdapter {
  readonly provider: "twilio";
  connect(input: { callReference: string; contactToken: string; idempotencyKey: string }): Promise<{ state: CallState }>;
  transfer(input: { callReference: string; directive: HumanTransferDirective; idempotencyKey: string }): Promise<{ state: CallState }>;
  end(input: { callReference: string; reasonCode: string; idempotencyKey: string }): Promise<{ state: "ended" }>;
}

export interface VoiceModelAdapter {
  readonly provider: "openai";
  readonly authority: "language_and_delivery_only";
  speak(callReference: string, directive: ApprovedSpeechDirective): Promise<{ state: "speaking"; responseReference: string }>;
}
