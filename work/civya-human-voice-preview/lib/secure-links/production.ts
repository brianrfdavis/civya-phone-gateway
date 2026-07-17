import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PHONE_RESUME_PURPOSE = "staff_callback" as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_PATTERN = /^phone_resume_[0-9a-f]{64}$/;

export interface DurableSecureLinkResult {
  secureLinkId: string;
  purpose: string;
  expiresAt: string;
}

export interface ConsumedSecureLinkResult {
  consumed: boolean;
  reason?: string;
  secureLinkId?: string;
  purpose?: string;
  caseId?: string | null;
  channelSessionId?: string | null;
  handoffSessionId?: string | null;
}

/**
 * Phone-resume tokens are deterministic per call-side idempotency key so a
 * process restart can safely retry without persisting plaintext link material.
 * Only the token digest is written to Postgres.
 */
export function derivePhoneResumeToken(input: {
  secret: string;
  tenantId: string;
  idempotencyKey: string;
}): string {
  if (Buffer.byteLength(input.secret) < 32) throw new Error("Secure-link secret must contain at least 32 bytes.");
  if (!isUuid(input.tenantId)) throw new Error("A valid tenant identifier is required.");
  if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) throw new Error("Phone-resume idempotency key is invalid.");
  return createHmac("sha256", input.secret)
    .update(`civya-phone-resume-v1:${input.tenantId}:${input.idempotencyKey}`)
    .digest("base64url");
}

export function secureLinkTokenDigest(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Secure-link token is invalid.");
  return createHash("sha256").update(token).digest("hex");
}

export function createPhoneResumeUrl(origin: string, token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Secure-link token is invalid.");
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Phone-resume links require HTTPS outside local development.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Civya public origin must be an exact origin.");
  url.pathname = "/phone/resume";
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export class ProductionSecureLinkStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async createPhoneResume(input: {
    tenantId: string;
    tokenDigest: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<DurableSecureLinkResult> {
    const { data, error } = await this.supabase.rpc("civya_service_create_secure_link", {
      p_tenant_id: input.tenantId,
      p_actor_user_id: null,
      p_case_id: null,
      p_channel_session_id: null,
      p_handoff_session_id: null,
      p_purpose: PHONE_RESUME_PURPOSE,
      p_token_digest: input.tokenDigest,
      p_audience_auth_user_id: null,
      p_expires_at: input.expiresAt,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw new Error(`Secure-link persistence failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    const secureLinkId = stringValue(row.secureLinkId ?? row.secure_link_id);
    const expiresAt = stringValue(row.expiresAt ?? row.expires_at);
    if (!secureLinkId || !expiresAt) throw new Error("Secure-link persistence returned an invalid response.");
    return { secureLinkId, purpose: stringValue(row.purpose) || PHONE_RESUME_PURPOSE, expiresAt };
  }

  async consumePhoneResume(input: { tenantId: string; token: string }): Promise<ConsumedSecureLinkResult> {
    const { data, error } = await this.supabase.rpc("civya_service_consume_secure_link", {
      p_tenant_id: input.tenantId,
      p_token_digest: secureLinkTokenDigest(input.token),
      p_purpose: PHONE_RESUME_PURPOSE,
      p_actor_user_id: null,
    });
    if (error) throw new Error(`Secure-link consumption failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    return {
      consumed: row.consumed === true,
      reason: optionalString(row.reason),
      secureLinkId: optionalString(row.secureLinkId ?? row.secure_link_id),
      purpose: optionalString(row.purpose),
      caseId: nullableString(row.caseId ?? row.case_id),
      channelSessionId: nullableString(row.channelSessionId ?? row.channel_session_id),
      handoffSessionId: nullableString(row.handoffSessionId ?? row.handoff_session_id),
    };
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
