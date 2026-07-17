import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { requireProductionNamedSecret } from "./runtime-secrets";

const STAFF_AUTH_STATE_COOKIE = "civya_staff_auth";

export interface StaffAuthState {
  emailHash: string;
  tenantSlug: string;
  nonce: string;
  exp: number;
}

function signingKey(): string {
  if (process.env.CIVYA_ENVIRONMENT === "production") {
    return requireProductionNamedSecret("CIVYA_STAFF_AUTH_SECRET");
  }
  const value = process.env.CIVYA_STAFF_AUTH_SECRET
    || process.env.CIVYA_AUTH_UPGRADE_SECRET
    || process.env.CIVYA_DEMO_ACCESS_SECRET;
  if (!value && process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    return "civya-local-development-staff-auth-key";
  }
  if (!value) throw new Error("CIVYA_STAFF_AUTH_SECRET is not configured.");
  return value;
}

export function staffEmailHash(email: string): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(email.trim().toLowerCase())
    .digest("base64url");
}

function encodeState(state: StaffAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeState(value: string | undefined): StaffAuthState | null {
  if (!value) return null;
  const [payload, suppliedSignature] = value.split(".");
  if (!payload || !suppliedSignature) return null;

  try {
    const expectedSignature = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
    const expected = Buffer.from(expectedSignature);
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;

    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffAuthState;
    if (
      !state.emailHash
      || !/^[a-z0-9-]+$/.test(state.tenantSlug)
      || !state.nonce
      || !Number.isFinite(state.exp)
      || state.exp <= Date.now()
    ) return null;
    return state;
  } catch {
    return null;
  }
}

export function setStaffAuthState(response: NextResponse, state: StaffAuthState): void {
  response.cookies.set(STAFF_AUTH_STATE_COOKIE, encodeState(state), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
    sameSite: "strict",
    path: "/api/staff/auth",
    expires: new Date(state.exp),
  });
}

export function readStaffAuthState(req: NextRequest): StaffAuthState | null {
  return decodeState(req.cookies.get(STAFF_AUTH_STATE_COOKIE)?.value);
}

export function clearStaffAuthState(response: NextResponse): void {
  response.cookies.set(STAFF_AUTH_STATE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
    sameSite: "strict",
    path: "/api/staff/auth",
    expires: new Date(0),
  });
}
