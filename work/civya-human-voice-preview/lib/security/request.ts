import { NextRequest, NextResponse } from "next/server";
import { privacySafeKey } from "@/lib/conversation/privacy";
import { PlatformDataError } from "@/lib/platform/repository";
import { rateLimitHeaders, takeRateLimit } from "./rate-limit";

export function requestIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

export function rateLimitRequest(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  identity?: string,
): NextResponse | null {
  const key = `${scope}:${privacySafeKey(identity || requestIp(req))}`;
  const result = takeRateLimit(key, limit, windowMs);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please wait a moment and try again.", code: "rate_limited" },
    { status: 429, headers: rateLimitHeaders(result) },
  );
}

export async function readJsonObject(req: NextRequest, maxBytes = 24_000): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > maxBytes) throw new RequestError(413, "Request is too large.");
  let value: unknown;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new RequestError(413, "Request is too large.");
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export class RequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "invalid_request") {
    super(message);
  }
}

export function requestErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof PlatformDataError) {
    const status = error.code === "forbidden" || error.code === "verification_required" ||
      error.code === "demo_access_required" || error.code === "42501" || error.code === "28000"
      ? 403
      : error.code === "P0002" || error.code === "PGRST116"
        ? 404
        : error.retryable || error.code === "concurrent_update" || error.code === "23505"
          ? 409
          : 503;
    const publicMessage = status === 503
      ? "Civya couldn't complete that request safely. Your saved progress was not changed."
      : error.message;
    return NextResponse.json(
      { error: publicMessage, code: error.code || "service_error", retryable: error.retryable || undefined },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("Civya request failed", error instanceof Error ? error.message : String(error));
  return NextResponse.json(
    { error: "Civya couldn't complete that request safely. Your saved progress was not changed.", code: "service_error" },
    { status: 503 },
  );
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
