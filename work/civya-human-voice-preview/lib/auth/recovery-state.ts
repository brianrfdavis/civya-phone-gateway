import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const ACCOUNT_RECOVERY_COOKIE = "civya_account_recovery";

export interface AccountRecoveryState {
  challengeId: string;
  correlationId: string;
  emailDigest: string;
  nonce: string;
  exp: number;
}

function secret(): string {
  const value = process.env.CIVYA_ACCOUNT_RECOVERY_SECRET
    || process.env.CIVYA_AUTH_FLOW_SECRET
    || process.env.CIVYA_AUTH_UPGRADE_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    return "civya-local-recovery-key-change-before-hosting";
  }
  throw new Error("CIVYA_ACCOUNT_RECOVERY_SECRET is not configured.");
}

function key(): Buffer {
  return crypto.createHash("sha256").update(`recovery-state-v1\0${secret()}`).digest();
}

export function normalizeRecoveryEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : "";
}

export function recoveryEmailDigest(email: string): string {
  return crypto.createHash("sha256").update(`civya-recovery-email-v1|${email}`).digest("hex");
}

export function recoveryNonceDigest(nonce: string): string {
  return crypto.createHash("sha256").update(`civya-recovery-nonce-v1|${nonce}`).digest("hex");
}

function encode(state: AccountRecoveryState): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

function decode(value: string | undefined): AccountRecoveryState | null {
  if (!value) return null;
  const [version, iv, data, tag] = value.split(".");
  if (version !== "v1" || !iv || !data || !tag) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const state = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8")) as AccountRecoveryState;
    return state.challengeId && state.correlationId && /^[0-9a-f]{64}$/.test(state.emailDigest)
      && state.nonce && Number.isFinite(state.exp) && state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}

const secure = () => process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

export function setAccountRecoveryState(response: NextResponse, state: AccountRecoveryState): void {
  response.cookies.set(ACCOUNT_RECOVERY_COOKIE, encode(state), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/auth/recovery",
    expires: new Date(state.exp),
  });
}

export function readAccountRecoveryState(req: NextRequest): AccountRecoveryState | null {
  return decode(req.cookies.get(ACCOUNT_RECOVERY_COOKIE)?.value);
}

export function clearAccountRecoveryState(response: NextResponse): void {
  response.cookies.set(ACCOUNT_RECOVERY_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/auth/recovery",
    expires: new Date(0),
  });
}
