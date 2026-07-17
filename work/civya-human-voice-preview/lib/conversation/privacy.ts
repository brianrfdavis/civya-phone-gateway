const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g;
const SSN = /(?<!\d)\d{3}[ -]?\d{2}[ -]?\d{4}(?!\d)/g;
const LONG_ID = /(?<!\d)(?:\d[ -]?){8,20}(?!\d)/g;
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|parkway|pkwy)\b(?:[^.!?\n]{0,40})?/gi;

/**
 * Conversation history is useful for tone and continuity, but structured case
 * facts are the authoritative place for personal data. This redactor keeps the
 * conversational shape while removing common direct identifiers.
 */
export function redactTranscript(value: string): string {
  return value
    .replace(EMAIL, "[email redacted]")
    .replace(PHONE, "[phone redacted]")
    .replace(SSN, "[identifier redacted]")
    .replace(STREET_ADDRESS, "[address redacted]")
    .replace(LONG_ID, "[identifier redacted]")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 4_000);
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().split("@");
  if (!domain) return "•••";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

export function privacySafeKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

