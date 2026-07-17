import { redactTranscript } from "@/lib/platform/redaction";

const STRING_FIELDS = new Set([
  "event_type",
  "model",
  "turn_detection",
  "layer",
  "intent",
  "match_method",
  "tool",
  "phase",
  "reason",
  "when",
  "scope",
  "message",
]);
const NUMBER_FIELDS = new Set([
  "milliseconds",
  "resolve_ms",
  "similarity",
  "attempt",
  "reconnect_attempt",
  "tool_ms",
]);
const BOOLEAN_FIELDS = new Set(["escalated", "hit", "saved", "approved", "has_followup"]);

/** Allowlist and redact untrusted browser telemetry before immutable audit storage. */
export function safeOperationalPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (STRING_FIELDS.has(key) && typeof field === "string") {
      output[key] = redactTranscript(field).slice(0, key === "message" ? 300 : 100);
    }
    if (NUMBER_FIELDS.has(key) && typeof field === "number" && Number.isFinite(field)) output[key] = field;
    if (BOOLEAN_FIELDS.has(key) && typeof field === "boolean") output[key] = field;
  }
  return output;
}
