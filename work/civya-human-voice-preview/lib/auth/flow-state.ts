import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { AccountFlowState, AccountResumeState } from "./contracts";
import { isCaseAccessBinding } from "./contracts";
import { requireProductionNamedSecret } from "@/lib/security/runtime-secrets";

export const ACCOUNT_FLOW_COOKIE = "civya_account_flow";
export const ACCOUNT_RESUME_COOKIE = "civya_account_resume";

function secret(): string {
  if (process.env.CIVYA_ENVIRONMENT === "production") {
    return requireProductionNamedSecret("CIVYA_AUTH_FLOW_SECRET");
  }
  const value = process.env.CIVYA_AUTH_FLOW_SECRET
    || process.env.CIVYA_AUTH_UPGRADE_SECRET
    || process.env.CIVYA_DEMO_ACCESS_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    return "civya-local-account-flow-key-change-before-hosting";
  }
  throw new Error("CIVYA_AUTH_FLOW_SECRET is not configured.");
}

function key(): Buffer {
  return crypto.createHash("sha256").update(secret()).digest();
}

/** Encrypt and authenticate browser-carried flow state; pending prompts may be sensitive. */
export function sealFlowState(value: object): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ v: 1, ...value }), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function openFlowState<T extends { exp: number }>(value: string | undefined): T | null {
  if (!value) return null;
  const [version, ivPart, dataPart, tagPart] = value.split(".");
  if (version !== "v1" || !ivPart || !dataPart || !tagPart) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const decoded = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(decoded) as T & { v?: number };
    if (parsed.v !== 1 || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

const secure = () => process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

export function setAccountFlow(response: NextResponse, state: AccountFlowState): void {
  response.cookies.set(ACCOUNT_FLOW_COOKIE, sealFlowState(state), {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    path: "/api/auth",
    expires: new Date(state.exp),
  });
}

export function readAccountFlow(req: NextRequest): AccountFlowState | null {
  const state = openFlowState<AccountFlowState>(req.cookies.get(ACCOUNT_FLOW_COOKIE)?.value);
  return state && isCaseAccessBinding(state.caseAccess) ? state : null;
}

export function clearAccountFlow(response: NextResponse): void {
  response.cookies.set(ACCOUNT_FLOW_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    path: "/api/auth",
    expires: new Date(0),
  });
}

export function setAccountResume(response: NextResponse, state: AccountResumeState): void {
  response.cookies.set(ACCOUNT_RESUME_COOKIE, sealFlowState(state), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/auth/link/resume",
    expires: new Date(state.exp),
  });
}

export function readAccountResume(req: NextRequest): AccountResumeState | null {
  return openFlowState<AccountResumeState>(req.cookies.get(ACCOUNT_RESUME_COOKIE)?.value);
}

export function clearAccountResume(response: NextResponse): void {
  response.cookies.set(ACCOUNT_RESUME_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/auth/link/resume",
    expires: new Date(0),
  });
}
