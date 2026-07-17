import { emitTelemetryLog } from "./otlp";

const PROHIBITED_KEY = /(password|secret|token|authorization|cookie|card|bank|ssn|document|transcript|raw_text|payload|email|phone|address|parcel|resident|case_id)/i;
const SECRET_LIKE_VALUE = /(?:bearer\s|basic\s|sk-[A-Za-z0-9]|whsec_|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_=-]{48,})/i;

export type LogLevel = "info" | "warn" | "error";

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        PROHIBITED_KEY.test(key) ? "[REDACTED]" : redact(nested, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && SECRET_LIKE_VALUE.test(value)) return "[REDACTED]";
  if (typeof value === "string" && value.length > 512) return `${value.slice(0, 512)}…`;
  return value;
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const redactedFields = redact(fields) as Record<string, unknown>;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redactedFields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
  emitTelemetryLog(level, event, redactedFields);
}
