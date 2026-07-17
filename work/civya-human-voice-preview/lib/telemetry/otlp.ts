export type TelemetryAdapter = "disabled" | "otlp-http-json";

export interface TelemetryConfigurationState {
  adapter: TelemetryAdapter;
  configured: boolean;
  issues: readonly string[];
}

export interface TelemetryHealth {
  ok: boolean;
  configured: boolean;
  adapter: TelemetryAdapter;
  latencyMs: number;
  error?: "not_configured" | "export_timeout" | "export_rejected" | "export_unavailable";
  httpStatus?: number;
}

interface OtlpConfiguration {
  adapter: "otlp-http-json";
  logsEndpoint: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  serviceName: string;
  environment: string;
  releaseVersion: string;
}

export type TelemetryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "attempt",
  "capability",
  "code",
  "config_version",
  "duration_ms",
  "environment",
  "http_status",
  "latency_ms",
  "method",
  "mode",
  "operation",
  "provider",
  "release",
  "reason_code",
  "result",
  "retryable",
  "route",
  "status",
  "worker",
]);

const SECRET_LIKE_VALUE = /(?:bearer\s|basic\s|sk-[A-Za-z0-9]|whsec_|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_=-]{32,})/i;

class TelemetryConfigurationError extends Error {
  constructor(readonly issue: string) {
    super(issue);
    this.name = "TelemetryConfigurationError";
  }
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TelemetryConfigurationError(`CIVYA_TELEMETRY_TIMEOUT_MS must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function decodeHeaderPart(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TelemetryConfigurationError(`OTEL_EXPORTER_OTLP_HEADERS contains an invalid ${label}.`);
  }
}

function parseHeaders(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw?.trim()) return Object.freeze({});
  const headers: Record<string, string> = {};
  for (const segment of raw.split(",")) {
    const equals = segment.indexOf("=");
    if (equals <= 0) throw new TelemetryConfigurationError("OTEL_EXPORTER_OTLP_HEADERS must use name=value entries.");
    const name = decodeHeaderPart(segment.slice(0, equals).trim(), "header name").toLowerCase();
    const value = decodeHeaderPart(segment.slice(equals + 1).trim(), "header value");
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$/.test(name) || /[\r\n]/.test(value)) {
      throw new TelemetryConfigurationError("OTEL_EXPORTER_OTLP_HEADERS contains an unsafe header.");
    }
    if (["content-length", "host", "transfer-encoding"].includes(name)) {
      throw new TelemetryConfigurationError(`OTEL_EXPORTER_OTLP_HEADERS cannot set ${name}.`);
    }
    if (Object.hasOwn(headers, name)) {
      throw new TelemetryConfigurationError(`OTEL_EXPORTER_OTLP_HEADERS repeats ${name}.`);
    }
    headers[name] = value;
  }
  return Object.freeze(headers);
}

function resolveLogsEndpoint(env: NodeJS.ProcessEnv): string {
  const exact = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const raw = exact || base;
  if (!raw) throw new TelemetryConfigurationError("OTLP telemetry requires an exporter endpoint.");

  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TelemetryConfigurationError("The OTLP telemetry endpoint must be a valid URL.");
  }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new TelemetryConfigurationError("The OTLP telemetry endpoint cannot contain credentials, query parameters, or a fragment.");
  }
  const production = env.CIVYA_ENVIRONMENT === "production";
  const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(localHttp && !production)) {
    throw new TelemetryConfigurationError("Production OTLP telemetry requires HTTPS.");
  }
  if (!exact) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/logs`.replace(/^\/\//, "/");
  }
  return endpoint.toString();
}

function loadConfiguration(env: NodeJS.ProcessEnv): OtlpConfiguration | null {
  const rawMode = env.CIVYA_TELEMETRY_MODE?.trim() || "disabled";
  if (rawMode === "disabled") return null;
  if (rawMode !== "otlp-http-json") {
    throw new TelemetryConfigurationError("CIVYA_TELEMETRY_MODE must be disabled or otlp-http-json.");
  }
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || "civya";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(serviceName)) {
    throw new TelemetryConfigurationError("OTEL_SERVICE_NAME must be a short service identifier.");
  }
  const config = {
    adapter: "otlp-http-json" as const,
    logsEndpoint: resolveLogsEndpoint(env),
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: boundedInteger(env.CIVYA_TELEMETRY_TIMEOUT_MS, 2_000, 250, 5_000),
    serviceName,
    environment: env.CIVYA_ENVIRONMENT?.trim() || "development",
    releaseVersion: env.CIVYA_RELEASE_VERSION?.trim() || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "development",
  };
  validateCivyaOwnedReceiver(config, env);
  return Object.freeze(config);
}

function validateCivyaOwnedReceiver(config: OtlpConfiguration, env: NodeJS.ProcessEnv): void {
  const rawOrigin = env.CIVYA_TELEMETRY_RECEIVER_ORIGIN?.trim();
  if (!rawOrigin) return;

  let ownedOrigin: URL;
  try {
    ownedOrigin = new URL(rawOrigin);
  } catch {
    throw new TelemetryConfigurationError("CIVYA_TELEMETRY_RECEIVER_ORIGIN must be an exact HTTPS origin.");
  }
  if (
    ownedOrigin.protocol !== "https:"
    || ownedOrigin.username
    || ownedOrigin.password
    || ownedOrigin.pathname !== "/"
    || ownedOrigin.search
    || ownedOrigin.hash
  ) {
    throw new TelemetryConfigurationError("CIVYA_TELEMETRY_RECEIVER_ORIGIN must be an exact HTTPS origin.");
  }

  const endpoint = new URL(config.logsEndpoint);
  if (endpoint.origin !== ownedOrigin.origin || endpoint.pathname !== "/v1/logs") {
    throw new TelemetryConfigurationError("The Civya-owned OTLP endpoint must be the receiver origin followed by /v1/logs.");
  }

  const secret = env.CIVYA_TELEMETRY_INGEST_SECRET?.trim() ?? "";
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new TelemetryConfigurationError("The Civya-owned OTLP receiver requires CIVYA_TELEMETRY_INGEST_SECRET with at least 32 bytes.");
  }
  const direct = config.headers["x-civya-telemetry-key"];
  const bearer = config.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (direct !== secret && bearer !== secret) {
    throw new TelemetryConfigurationError("The Civya-owned OTLP exporter must authenticate with its dedicated ingest secret.");
  }
}

export function inspectTelemetryConfiguration(env: NodeJS.ProcessEnv = process.env): TelemetryConfigurationState {
  try {
    const config = loadConfiguration(env);
    return Object.freeze({
      adapter: config?.adapter ?? "disabled",
      configured: config !== null,
      issues: Object.freeze([]),
    });
  } catch (error) {
    const issue = error instanceof TelemetryConfigurationError
      ? error.issue
      : "Telemetry configuration could not be validated.";
    return Object.freeze({ adapter: "disabled", configured: false, issues: Object.freeze([issue]) });
  }
}

function safeEventName(event: string): string {
  return /^[a-z][a-z0-9_.-]{1,79}$/.test(event) ? event : "application.event";
}

function safeAttributeValue(value: unknown): string | number | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length > 128 || /[\r\n@]/.test(value) || SECRET_LIKE_VALUE.test(value)) {
    return null;
  }
  return /^[A-Za-z0-9_.:/{}-]+$/.test(value) ? value : null;
}

function otlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: value };
}

function buildEnvelope(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
  config: OtlpConfiguration,
  now: number,
): Record<string, unknown> {
  const severity = level === "error" ? 17 : level === "warn" ? 13 : 9;
  const safeFields = Object.entries(fields)
    .filter(([key]) => ALLOWED_ATTRIBUTE_KEYS.has(key))
    .map(([key, value]) => [key, safeAttributeValue(value)] as const)
    .filter((entry): entry is readonly [string, string | number | boolean] => entry[1] !== null)
    .map(([key, value]) => ({ key: `civya.${key}`, value: otlpValue(value) }));
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: config.serviceName } },
          { key: "service.version", value: { stringValue: config.releaseVersion } },
          { key: "deployment.environment.name", value: { stringValue: config.environment } },
        ],
      },
      scopeLogs: [{
        scope: { name: "civya.structured-logger", version: "1" },
        logRecords: [{
          timeUnixNano: String(BigInt(now) * 1_000_000n),
          observedTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
          severityNumber: severity,
          severityText: level.toUpperCase(),
          body: { stringValue: safeEventName(event) },
          attributes: safeFields,
        }],
      }],
    }],
  };
}

async function send(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: TelemetryFetch; now?: number } = {},
): Promise<{ ok: boolean; status: number }> {
  const env = options.env ?? process.env;
  const config = loadConfiguration(env);
  if (!config) return { ok: false, status: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("telemetry_timeout"), config.timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(config.logsEndpoint, {
      method: "POST",
      headers: {
        ...config.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildEnvelope(level, event, fields, config, options.now ?? Date.now())),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    return { ok: await receiverAccepted(response), status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function receiverAccepted(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return false;
  const body = await response.text();
  if (body.length > 16_384) return false;
  if (!body.trim()) return true;
  try {
    const parsed = JSON.parse(body) as {
      partialSuccess?: { rejectedLogRecords?: number | string; errorMessage?: string };
      partial_success?: { rejected_log_records?: number | string; error_message?: string };
    };
    const rejected = Number(
      parsed.partialSuccess?.rejectedLogRecords
      ?? parsed.partial_success?.rejected_log_records
      ?? 0,
    );
    return Number.isFinite(rejected) && rejected === 0;
  } catch {
    return false;
  }
}

/** Awaitable export for jobs and controlled verification paths. */
export async function exportTelemetryLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: TelemetryFetch; now?: number } = {},
): Promise<{ ok: boolean; status: number }> {
  return send(level, event, fields, options);
}

/** Non-blocking application export. Failures are intentionally not recursively logged. */
export function emitTelemetryLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!inspectTelemetryConfiguration().configured) return;
  void exportTelemetryLog(level, event, fields).catch(() => undefined);
}

/**
 * A readiness probe succeeds only when the configured OTLP receiver accepts a
 * real, content-free log record within the bounded timeout.
 */
export async function checkTelemetryHealth(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: TelemetryFetch;
  now?: number;
} = {}): Promise<TelemetryHealth> {
  const started = Date.now();
  const state = inspectTelemetryConfiguration(options.env ?? process.env);
  if (!state.configured) {
    return { ok: false, configured: false, adapter: state.adapter, latencyMs: Date.now() - started, error: "not_configured" };
  }
  try {
    const result = await send("info", "civya.telemetry.health", {
      operation: "readiness_probe",
      status: "ok",
    }, options);
    return {
      ok: result.ok,
      configured: true,
      adapter: "otlp-http-json",
      latencyMs: Date.now() - started,
      ...(result.ok ? {} : { error: "export_rejected" as const, httpStatus: result.status }),
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message));
    return {
      ok: false,
      configured: true,
      adapter: "otlp-http-json",
      latencyMs: Date.now() - started,
      error: timedOut ? "export_timeout" : "export_unavailable",
    };
  }
}
