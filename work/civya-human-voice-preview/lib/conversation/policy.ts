import type { AuthenticationState, AuthRequiredPayload } from "./contracts";

export const ACCOUNT_EXPLANATION =
  "Before we get into personal details, let's save your progress securely. That keeps your documents private and lets you come back without starting over. I'll pause while you enter your email and the six-digit code.";

const SENSITIVE_PATTERNS = [
  /\b(?:my\s+)?(?:name|address|parcel|phone|telephone|email|e-mail)\s+(?:is|are)\b/i,
  /\b(?:social security|ssn|driver'?s? license|state id|birth date|date of birth)\b/i,
  /\b(?:upload|attach|send)\b.{0,30}\b(?:document|notice|bill|id|statement|form)\b/i,
  /\b(?:remind me|text me|call me|email me|contact me)\b/i,
  /\b\d{1,6}\s+[A-Za-z][A-Za-z\s.'-]{1,40}\b(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|parkway|pkwy)\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/,
];

export const SENSITIVE_INTAKE_KEYS = new Set([
  "property_address",
  "parcel_id",
  "resident_name",
  "contact",
  "phone",
  "email",
  "id",
  "document",
  "reminder_consent",
]);

export function containsSensitiveMaterial(transcript: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(transcript));
}

export function requiresVerifiedAccount(input: {
  authState: AuthenticationState;
  transcript: string;
  nextFactKey?: string;
  action?: "turn" | "upload" | "reminder" | "saved_action";
}): boolean {
  if (input.authState === "verified") return false;
  if (input.action && input.action !== "turn") return true;
  if (input.nextFactKey && SENSITIVE_INTAKE_KEYS.has(input.nextFactKey)) return true;
  return containsSensitiveMaterial(input.transcript);
}

export function authRequiredPayload(input: {
  pendingTurnId: string;
  pendingQuestion?: string;
  reason?: AuthRequiredPayload["reason"];
}): AuthRequiredPayload {
  return {
    reason: input.reason ?? "sensitive_intake",
    spoken_explanation: ACCOUNT_EXPLANATION,
    pending_turn_id: input.pendingTurnId,
    pending_question: input.pendingQuestion ?? "What would you like help with next?",
    allowed: ["email_otp", "decline"],
  };
}

