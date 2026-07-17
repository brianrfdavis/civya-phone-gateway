import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type SecureLinkPurpose = "external_handoff" | "browser_return";

export interface SecureLinkClaims {
  v: 1;
  purpose: SecureLinkPurpose;
  jti: string;
  handoffId: string;
  provider: string;
  destination?: string;
  sessionBindingHash: string;
  iat: number;
  exp: number;
}

export interface SingleUseLinkStore {
  /** Must be an atomic insert-if-absent in production. */
  consumeOnce(jti: string, expiresAtMs: number): boolean;
}

export class InMemorySingleUseLinkStore implements SingleUseLinkStore {
  private consumed = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  consumeOnce(jti: string, expiresAtMs: number): boolean {
    const now = this.now();
    for (const [key, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(key);
    if (this.consumed.has(jti)) return false;
    this.consumed.set(jti, expiresAtMs);
    return true;
  }
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function bindingHash(value: string): string {
  return createHash("sha256").update(`civya-session-binding-v1:${value}`).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SAFE_EXTERNAL_QUERY_KEYS = new Set(["flow", "locale", "return_state", "session", "state"]);

export function assertAllowlistedDestination(destination: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(destination);
  const normalizedOrigins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  if (url.protocol !== "https:" || !normalizedOrigins.has(url.origin)) {
    throw new Error("External destination is not on the exact HTTPS origin allowlist.");
  }
  if (url.username || url.password || url.hash) throw new Error("External destination contains prohibited URL components.");
  for (const key of url.searchParams.keys()) {
    if (!SAFE_EXTERNAL_QUERY_KEYS.has(key)) throw new Error(`External destination query key is not approved: ${key}.`);
  }
  return url;
}

export class SecureLinkService {
  private secret: string;
  private localBaseUrl: string;
  private allowedOrigins: string[];
  private store: SingleUseLinkStore;
  private now: () => number;

  constructor(options: {
    secret: string;
    localBaseUrl: string;
    allowedOrigins: string[];
    store: SingleUseLinkStore;
    now?: () => number;
  }) {
    if (Buffer.byteLength(options.secret) < 32) throw new Error("Secure-link secret must contain at least 32 bytes.");
    const local = new URL(options.localBaseUrl);
    if (local.protocol !== "https:" && local.hostname !== "localhost") {
      throw new Error("Secure links require HTTPS outside localhost.");
    }
    if (options.allowedOrigins.length === 0) throw new Error("At least one exact external origin must be allowlisted.");
    this.secret = options.secret;
    this.localBaseUrl = local.origin;
    this.allowedOrigins = options.allowedOrigins.map((origin) => new URL(origin).origin);
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: {
    purpose: SecureLinkPurpose;
    handoffId: string;
    provider: string;
    sessionBinding: string;
    destination?: string;
    ttlSeconds?: number;
  }): { token: string; url: string; expiresAt: string } {
    if (!/^opaque_[A-Za-z0-9_-]{8,120}$/.test(input.handoffId)) throw new Error("Handoff ID must be opaque.");
    if (input.sessionBinding.length < 16) throw new Error("Session binding is too short.");
    if (input.purpose === "external_handoff" && !input.destination) throw new Error("External handoff needs a destination.");
    if (input.destination) assertAllowlistedDestination(input.destination, this.allowedOrigins);
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
      throw new Error("Secure-link lifetime must be between 30 and 600 seconds.");
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims: SecureLinkClaims = {
      v: 1,
      purpose: input.purpose,
      jti: randomUUID(),
      handoffId: input.handoffId,
      provider: input.provider,
      destination: input.destination,
      sessionBindingHash: bindingHash(input.sessionBinding),
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    };
    const payload = encode(JSON.stringify(claims));
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const token = `${payload}.${signature}`;
    const path = input.purpose === "external_handoff" ? "/api/handoffs/launch" : "/api/handoffs/return";
    const url = new URL(path, this.localBaseUrl);
    url.searchParams.set("token", token);
    return { token, url: url.toString(), expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  consume(input: {
    token: string;
    expectedPurpose: SecureLinkPurpose;
    sessionBinding: string;
  }): SecureLinkClaims {
    const [payload, suppliedSignature, extra] = input.token.split(".");
    if (!payload || !suppliedSignature || extra) throw new Error("Malformed secure link.");
    const expectedSignature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    if (!safeEqual(suppliedSignature, expectedSignature)) throw new Error("Secure-link signature is invalid.");
    let claims: SecureLinkClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SecureLinkClaims;
    } catch {
      throw new Error("Secure-link payload is invalid.");
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    if (claims.v !== 1 || claims.purpose !== input.expectedPurpose) throw new Error("Secure-link purpose mismatch.");
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || claims.iat > nowSeconds + 30) {
      throw new Error("Secure link is expired or not yet valid.");
    }
    if (!safeEqual(claims.sessionBindingHash, bindingHash(input.sessionBinding))) {
      throw new Error("Secure link belongs to another session.");
    }
    if (claims.destination) assertAllowlistedDestination(claims.destination, this.allowedOrigins);
    if (!this.store.consumeOnce(claims.jti, claims.exp * 1000)) throw new Error("Secure link was already used.");
    return claims;
  }
}
