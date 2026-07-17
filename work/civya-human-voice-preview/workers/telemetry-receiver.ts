import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isKnownDevelopmentSecret,
  PRODUCTION_SECRET_REQUIREMENTS,
} from "@/lib/security/runtime-secrets";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ATTRIBUTES = 24;
const TELEMETRY_CAPABILITY = "otlp.logs.receive";

const ALLOWED_RESOURCE_KEYS = new Set([
  "service.name",
  "service.version",
  "deployment.environment.name",
]);

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "civya.attempt",
  "civya.capability",
  "civya.code",
  "civya.config_version",
  "civya.duration_ms",
  "civya.environment",
  "civya.http_status",
  "civya.latency_ms",
  "civya.method",
  "civya.mode",
  "civya.operation",
  "civya.provider",
  "civya.release",
  "civya.reason_code",
  "civya.result",
  "civya.retryable",
  "civya.route",
  "civya.status",
  "civya.worker",
]);

const SENSITIVE_TERM = /(?:resident|case|email|phone|address|document|transcript|payload|secret|token|password|authorization|cookie|social[._-]?security|\bssn\b|date[._-]?of[._-]?birth)/i;
const SECRET_LIKE_VALUE = /(?:bearer\s|basic\s|sk-[A-Za-z0-9]|whsec_|api[._-]?key|client[._-]?secret|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_=-]{32,})/i;
const EMAIL_LIKE_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_LIKE_VALUE = /(?:^|\D)\+?\d[\d .()-]{7,}\d(?:$|\D)/;
const ADDRESS_LIKE_VALUE = /\b\d{1,6}\s+(?:[A-Za-z]+\s+){1,5}(?:st(?:reet)?|rd|road|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|ln|lane|ct|court|way)\b/i;

export interface TelemetryReceiverSnapshot {
  capability: typeof TELEMETRY_CAPABILITY;
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  maxBodyBytes: number;
  acceptedRequests: number;
  rejectedRequests: number;
  unauthorizedRequests: number;
  oversizedRequests: number;
  invalidRequests: number;
  lastAcceptedAt: string | null;
}

type SummaryWriter = (summary: Readonly<Record<string, string | number>>) => void;

interface AcceptedSummary {
  event: string;
  severity: string;
  service: string;
  environment: string;
  release: string;
  attributeCount: number;
}

interface ReceiverConfiguration {
  secret: string;
}

class ReceiverValidationError extends Error {
  constructor(readonly code: "invalid_envelope" | "sensitive_content") {
    super(code);
    this.name = "ReceiverValidationError";
  }
}

/**
 * Minimal OTLP/HTTP JSON log receiver for the Civya structured exporter.
 * It deliberately is not a general-purpose collector: accepting only the
 * current content-free envelope keeps resident data out of the log stream.
 */
export class TelemetryOtlpReceiver {
  private acceptedRequests = 0;
  private rejectedRequests = 0;
  private unauthorizedRequests = 0;
  private oversizedRequests = 0;
  private invalidRequests = 0;
  private lastAcceptedAt: string | null = null;

  constructor(
    private readonly configuration: ReceiverConfiguration | null,
    private readonly writeSummary: SummaryWriter = writeRedactedSummary,
  ) {}

  snapshot(): TelemetryReceiverSnapshot {
    const configured = this.configuration !== null;
    return Object.freeze({
      capability: TELEMETRY_CAPABILITY,
      enabled: configured,
      configured,
      ready: configured,
      maxBodyBytes: MAX_BODY_BYTES,
      acceptedRequests: this.acceptedRequests,
      rejectedRequests: this.rejectedRequests,
      unauthorizedRequests: this.unauthorizedRequests,
      oversizedRequests: this.oversizedRequests,
      invalidRequests: this.invalidRequests,
      lastAcceptedAt: this.lastAcceptedAt,
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url?.split("?", 1)[0];
    if (path !== "/v1/logs") return false;

    if (!this.configuration || request.method !== "POST") {
      this.reject(response, 400, "invalid_request");
      return true;
    }
    if (!authorized(request, this.configuration.secret)) {
      this.unauthorizedRequests += 1;
      this.reject(response, 401, "unauthorized", {
        "www-authenticate": "Bearer realm=\"civya-telemetry\"",
      });
      return true;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      this.invalidRequests += 1;
      this.reject(response, 415, "unsupported_media_type");
      return true;
    }

    const declaredLength = request.headers["content-length"];
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength)) {
        this.invalidRequests += 1;
        this.reject(response, 400, "invalid_request");
        return true;
      }
      if (Number(declaredLength) > MAX_BODY_BYTES) {
        request.resume();
        this.oversizedRequests += 1;
        this.reject(response, 413, "payload_too_large");
        return true;
      }
    }

    const body = await readBoundedBody(request);
    if (body === null) {
      this.oversizedRequests += 1;
      this.reject(response, 413, "payload_too_large");
      return true;
    }

    try {
      const envelope = JSON.parse(body.toString("utf8")) as unknown;
      const summary = validateEnvelope(envelope);
      this.acceptedRequests += 1;
      this.lastAcceptedAt = new Date().toISOString();
      this.writeSummary(Object.freeze({
        event: "civya.telemetry.received",
        source_event: summary.event,
        severity: summary.severity,
        service: summary.service,
        environment: summary.environment,
        release: summary.release,
        attribute_count: summary.attributeCount,
      }));
      respond(response, 200, {});
    } catch (error) {
      this.invalidRequests += 1;
      this.reject(
        response,
        400,
        error instanceof ReceiverValidationError ? error.code : "invalid_envelope",
      );
    }
    return true;
  }

  private reject(
    response: ServerResponse,
    status: 400 | 401 | 413 | 415,
    code: string,
    headers: Record<string, string> = {},
  ): void {
    this.rejectedRequests += 1;
    respond(response, status, { error: code }, headers);
  }
}

export function createTelemetryOtlpReceiver(
  env: NodeJS.ProcessEnv = process.env,
  writer?: SummaryWriter,
): TelemetryOtlpReceiver {
  const enabled = readBoolean(env.CIVYA_ENABLE_TELEMETRY_RECEIVER, false);
  if (!enabled) return new TelemetryOtlpReceiver(null, writer);

  const secret = env.CIVYA_TELEMETRY_INGEST_SECRET?.trim() ?? "";
  if (
    Buffer.byteLength(secret, "utf8") < 32
    || isKnownDevelopmentSecret(secret)
  ) {
    throw new Error("CIVYA_TELEMETRY_INGEST_SECRET is not securely configured.");
  }
  const reusedBy = PRODUCTION_SECRET_REQUIREMENTS
    .filter(({ name }) => name !== "CIVYA_TELEMETRY_INGEST_SECRET")
    .find(({ name }) => env[name]?.trim() === secret)?.name;
  if (reusedBy) {
    throw new Error("CIVYA_TELEMETRY_INGEST_SECRET must be distinct from every other authority key.");
  }
  return new TelemetryOtlpReceiver({ secret }, writer);
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw?.trim()) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("CIVYA_ENABLE_TELEMETRY_RECEIVER must be true or false.");
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const direct = singleHeader(request.headers["x-civya-telemetry-key"]);
  const authorization = singleHeader(request.headers.authorization);
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  const candidate = direct ?? bearer ?? "";
  return constantTimeEqual(candidate, expected);
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || /[,\r\n]/.test(value)) return null;
  return value;
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  return typeof value === "string"
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  return oversized ? null : Buffer.concat(chunks, bytes);
}

function validateEnvelope(input: unknown): AcceptedSummary {
  const envelope = exactObject(input, ["resourceLogs"]);
  const resourceLogs = exactArray(envelope.resourceLogs, 1, 1);
  const resourceLog = exactObject(resourceLogs[0], ["resource", "scopeLogs"]);

  const resource = exactObject(resourceLog.resource, ["attributes"]);
  const resourceAttributes = exactArray(resource.attributes, 3, 3);
  const resourceValues = readAttributes(resourceAttributes, ALLOWED_RESOURCE_KEYS, true);
  if (resourceValues.size !== ALLOWED_RESOURCE_KEYS.size) invalid();

  const service = requiredString(resourceValues, "service.name", 80, /^[A-Za-z0-9._-]+$/);
  const release = requiredString(resourceValues, "service.version", 80, /^[A-Za-z0-9._-]+$/);
  const environment = requiredString(
    resourceValues,
    "deployment.environment.name",
    32,
    /^(?:development|test|staging|production)$/,
  );

  const scopeLogs = exactArray(resourceLog.scopeLogs, 1, 1);
  const scopeLog = exactObject(scopeLogs[0], ["scope", "logRecords"]);
  const scope = exactObject(scopeLog.scope, ["name", "version"]);
  if (scope.name !== "civya.structured-logger" || scope.version !== "1") invalid();

  const records = exactArray(scopeLog.logRecords, 1, 1);
  const record = exactObject(records[0], [
    "timeUnixNano",
    "observedTimeUnixNano",
    "severityNumber",
    "severityText",
    "body",
    "attributes",
  ]);
  if (!isUnixNano(record.timeUnixNano) || !isUnixNano(record.observedTimeUnixNano)) invalid();
  if (![9, 13, 17].includes(record.severityNumber as number)) invalid();
  if (!["INFO", "WARN", "ERROR"].includes(record.severityText as string)) invalid();

  const expectedSeverity = record.severityNumber === 17
    ? "ERROR"
    : record.severityNumber === 13 ? "WARN" : "INFO";
  if (record.severityText !== expectedSeverity) invalid();

  const body = exactObject(record.body, ["stringValue"]);
  if (typeof body.stringValue !== "string" || !/^civya\.[a-z0-9_.-]{1,72}$/.test(body.stringValue)) invalid();
  assertSafeString(body.stringValue);

  const attributes = exactArray(record.attributes, 0, MAX_ATTRIBUTES);
  readAttributes(attributes, ALLOWED_ATTRIBUTE_KEYS, false);

  return {
    event: body.stringValue,
    severity: record.severityText as string,
    service,
    environment,
    release,
    attributeCount: attributes.length,
  };
}

function readAttributes(
  attributes: unknown[],
  allowlist: ReadonlySet<string>,
  resource: boolean,
): Map<string, string | number | boolean> {
  const result = new Map<string, string | number | boolean>();
  for (const item of attributes) {
    const attribute = exactObject(item, ["key", "value"]);
    if (typeof attribute.key !== "string") invalid();
    assertSafeKey(attribute.key);
    if (!allowlist.has(attribute.key) || result.has(attribute.key)) invalid();
    const value = readOtlpScalar(attribute.value, resource);
    result.set(attribute.key, value);
  }
  return result;
}

function readOtlpScalar(input: unknown, resource: boolean): string | number | boolean {
  const value = plainObject(input);
  const keys = Object.keys(value);
  if (keys.length !== 1) invalid();
  const key = keys[0];
  if (resource && key !== "stringValue") invalid();
  if (key === "stringValue") {
    if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 128) invalid();
    assertSafeString(value[key]);
    if (!/^[A-Za-z0-9_.:/{}-]+$/.test(value[key])) sensitive();
    return value[key];
  }
  if (key === "boolValue" && typeof value[key] === "boolean") return value[key];
  if (
    (key === "doubleValue" || key === "intValue")
    && typeof value[key] === "number"
    && Number.isFinite(value[key])
    && Math.abs(value[key]) <= 1_000_000_000_000
  ) return value[key];
  invalid();
}

function requiredString(
  values: Map<string, string | number | boolean>,
  key: string,
  maximum: number,
  pattern: RegExp,
): string {
  const value = values.get(key);
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

function assertSafeKey(key: string): void {
  if (key.length > 80 || SENSITIVE_TERM.test(key)) sensitive();
}

function assertSafeString(value: string): void {
  if (
    SENSITIVE_TERM.test(value)
    || SECRET_LIKE_VALUE.test(value)
    || EMAIL_LIKE_VALUE.test(value)
    || PHONE_LIKE_VALUE.test(value)
    || ADDRESS_LIKE_VALUE.test(value)
    || /[\r\n@]/.test(value)
  ) sensitive();
}

function isUnixNano(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d{12,29}$/.test(value);
}

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = plainObject(input);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return value;
}

function plainObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return input as Record<string, unknown>;
}

function exactArray(input: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) invalid();
  return input;
}

function invalid(): never {
  throw new ReceiverValidationError("invalid_envelope");
}

function sensitive(): never {
  throw new ReceiverValidationError("sensitive_content");
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function writeRedactedSummary(summary: Readonly<Record<string, string | number>>): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
