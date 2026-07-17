const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const SSN = /(?<!\d)\d{3}[ -]?\d{2}[ -]?\d{4}(?!\d)/g;
const LONG_NUMBER = /(?<!\d)\d{12,19}(?!\d)/g;
const HYPHENATED_ID = /(?<![\w-])(?=[A-Z0-9-]{10,40}(?![\w-]))(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+(?![\w-])/gi;
const ADDRESS = /\b\d{1,6}\s+[A-Z0-9][A-Z0-9\s.'-]{1,60}\b(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|parkway|pkwy)\b[^,.!?;\n]*/gi;
const PARCEL = /\b(?:parcel(?:\s+(?:number|id))?|property\s+id)\s*(?:is|:|#)?\s*[A-Z0-9-]{4,}\b/gi;
const INTRODUCED_NAME = /\b(?:my name is|this is)\s+[A-ZÀ-Ž][A-ZÀ-Ž.'-]+(?:\s+[A-ZÀ-Ž][A-ZÀ-Ž.'-]+){1,3}\b/gi;

/**
 * Defense-in-depth redaction for durable conversational context. Structured
 * facts remain authoritative; raw audio is never passed to persistence.
 */
export function redactTranscript(text: string): string {
  return text
    .replace(EMAIL, "[EMAIL]")
    .replace(PHONE, "[PHONE]")
    .replace(SSN, "[GOVERNMENT_ID]")
    .replace(ADDRESS, "[ADDRESS]")
    .replace(PARCEL, "parcel [PARCEL_ID]")
    .replace(INTRODUCED_NAME, "my name is [NAME]")
    .replace(HYPHENATED_ID, "[IDENTIFIER]")
    .replace(LONG_NUMBER, "[IDENTIFIER]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}
