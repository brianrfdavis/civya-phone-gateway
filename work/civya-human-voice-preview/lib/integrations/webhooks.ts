import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type HeaderBag = Headers | Record<string, string | undefined>;

export interface WebhookVerificationResult {
  valid: boolean;
  eventId?: string;
  timestampSeconds?: number;
  duplicate?: boolean;
  reason?:
    | "missing_headers"
    | "invalid_timestamp"
    | "outside_replay_window"
    | "invalid_signature"
    | "invalid_body_digest"
    | "duplicate"
    | "missing_replay_identity";
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function standardWebhookKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : null;
  if (!encoded) return Buffer.from(secret, "utf8");
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length > 0) return decoded;
  } catch {
    // The verifier will calculate a nonmatching signature and fail closed.
  }
  return Buffer.from(secret, "utf8");
}

export class InMemoryWebhookReplayGuard {
  private seen = new Map<string, number>();

  checkAndRecord(input: {
    eventId: string;
    timestampSeconds: number;
    nowMs?: number;
    toleranceSeconds?: number;
  }): WebhookVerificationResult {
    const nowMs = input.nowMs ?? Date.now();
    const toleranceSeconds = input.toleranceSeconds ?? 300;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(input.timestampSeconds)) {
      return { valid: false, reason: "invalid_timestamp" };
    }
    if (Math.abs(nowSeconds - input.timestampSeconds) > toleranceSeconds) {
      return { valid: false, reason: "outside_replay_window" };
    }
    if (!/^[A-Za-z0-9_.:-]{6,200}$/.test(input.eventId)) {
      return { valid: false, reason: "missing_replay_identity" };
    }
    for (const [eventId, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(eventId);
    }
    if (this.seen.has(input.eventId)) {
      return {
        valid: false,
        eventId: input.eventId,
        timestampSeconds: input.timestampSeconds,
        duplicate: true,
        reason: "duplicate",
      };
    }
    this.seen.set(input.eventId, nowMs + toleranceSeconds * 2_000);
    return {
      valid: true,
      eventId: input.eventId,
      timestampSeconds: input.timestampSeconds,
      duplicate: false,
    };
  }
}

export function signStandardWebhookForTest(input: {
  secret: string;
  eventId: string;
  timestampSeconds: number;
  rawBody: string;
}): string {
  const message = `${input.eventId}.${input.timestampSeconds}.${input.rawBody}`;
  return createHmac("sha256", standardWebhookKey(input.secret)).update(message).digest("base64");
}

export function verifyStandardWebhook(input: {
  secret: string;
  rawBody: string;
  headers: HeaderBag;
  nowMs?: number;
  toleranceSeconds?: number;
  replayGuard: InMemoryWebhookReplayGuard;
}): WebhookVerificationResult {
  const eventId = readHeader(input.headers, "webhook-id");
  const timestampText = readHeader(input.headers, "webhook-timestamp");
  const signatureHeader = readHeader(input.headers, "webhook-signature");
  if (!eventId || !timestampText || !signatureHeader || !input.secret) {
    return { valid: false, reason: "missing_headers" };
  }
  const timestampSeconds = Number(timestampText);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const expected = signStandardWebhookForTest({
    secret: input.secret,
    eventId,
    timestampSeconds,
    rawBody: input.rawBody,
  });
  const supplied = [...signatureHeader.matchAll(/(?:^|\s)v1,([^\s,]+)/g)].map((match) => match[1]);
  if (!supplied.some((signature) => constantTimeEqual(signature, expected))) {
    return { valid: false, eventId, timestampSeconds, reason: "invalid_signature" };
  }
  return input.replayGuard.checkAndRecord({
    eventId,
    timestampSeconds,
    nowMs: input.nowMs,
    toleranceSeconds: input.toleranceSeconds,
  });
}

export type TwilioParameters = Record<string, string | string[]>;

function twilioFormMessage(url: string, parameters: TwilioParameters): string {
  let message = url;
  for (const key of Object.keys(parameters).sort()) {
    const values = Array.isArray(parameters[key]) ? parameters[key] : [parameters[key]];
    for (const value of values) message += `${key}${value}`;
  }
  return message;
}

export function signTwilioWebhookForTest(input: {
  authToken: string;
  url: string;
  parameters?: TwilioParameters;
}): string {
  const message = input.parameters ? twilioFormMessage(input.url, input.parameters) : input.url;
  return createHmac("sha1", input.authToken).update(message).digest("base64");
}

export function verifyTwilioWebhook(input: {
  authToken: string;
  signature: string | undefined;
  url: string;
  rawBody: string;
  contentType: string;
  parameters?: TwilioParameters;
  eventId?: string;
  occurredAtSeconds?: number;
  nowMs?: number;
  toleranceSeconds?: number;
  replayGuard: InMemoryWebhookReplayGuard;
  requireReplayTimestamp?: boolean;
}): WebhookVerificationResult {
  if (!input.authToken || !input.signature) return { valid: false, reason: "missing_headers" };
  const isJson = input.contentType.toLowerCase().includes("application/json");
  if (isJson) {
    const url = new URL(input.url);
    const suppliedDigest = url.searchParams.get("bodySHA256");
    const calculatedDigest = createHash("sha256").update(input.rawBody).digest("hex");
    if (!suppliedDigest || !constantTimeEqual(suppliedDigest, calculatedDigest)) {
      return { valid: false, reason: "invalid_body_digest" };
    }
  }
  const expected = signTwilioWebhookForTest({
    authToken: input.authToken,
    url: input.url,
    parameters: isJson ? undefined : input.parameters ?? {},
  });
  if (!constantTimeEqual(input.signature, expected)) {
    return { valid: false, reason: "invalid_signature" };
  }
  if (!input.eventId || input.occurredAtSeconds === undefined) {
    return input.requireReplayTimestamp
      ? { valid: false, reason: "missing_replay_identity" }
      : { valid: true, eventId: input.eventId, timestampSeconds: input.occurredAtSeconds };
  }
  return input.replayGuard.checkAndRecord({
    eventId: input.eventId,
    timestampSeconds: input.occurredAtSeconds,
    nowMs: input.nowMs,
    toleranceSeconds: input.toleranceSeconds,
  });
}
