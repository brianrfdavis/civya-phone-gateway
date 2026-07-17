import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { isCaseAccessBinding, type CaseAccessBinding } from "@/lib/auth/contracts";
import { requireProductionNamedSecret } from "./runtime-secrets";

export const UPGRADE_STATE_COOKIE = "civya_auth_upgrade";

export interface UpgradeState {
  mode: "link_anonymous" | "existing_account";
  sourceUserId: string;
  residentId: string;
  caseId: string;
  conversationId: string;
  pendingTurnId?: string;
  transferToken?: string;
  caseAccess: CaseAccessBinding;
  emailHash: string;
  exp: number;
  nonce: string;
}

function key(): string {
  if (process.env.CIVYA_ENVIRONMENT === "production") {
    return requireProductionNamedSecret("CIVYA_AUTH_UPGRADE_SECRET");
  }
  const value = process.env.CIVYA_AUTH_UPGRADE_SECRET || process.env.CIVYA_DEMO_ACCESS_SECRET;
  if (!value && process.env.NODE_ENV !== "production") return "civya-local-development-upgrade-key";
  if (!value) throw new Error("CIVYA_AUTH_UPGRADE_SECRET is not configured.");
  return value;
}

export function emailChallengeHash(email: string): string {
  return crypto.createHmac("sha256", key()).update(email.trim().toLowerCase()).digest("base64url");
}

export function encodeUpgradeState(state: UpgradeState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const mac = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function decodeUpgradeState(value: string | undefined): UpgradeState | null {
  if (!value) return null;
  const [payload, supplied] = value.split(".");
  if (!payload || !supplied) return null;
  try {
    const expected = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UpgradeState;
    if (!state.sourceUserId || !state.residentId || !state.caseId || !state.conversationId
      || state.exp <= Date.now() || !isCaseAccessBinding(state.caseAccess)
      || state.caseAccess.caseId !== state.caseId || state.caseAccess.residentId !== state.residentId) return null;
    return state;
  } catch {
    return null;
  }
}

export function setUpgradeState(response: NextResponse, state: UpgradeState): void {
  response.cookies.set(UPGRADE_STATE_COOKIE, encodeUpgradeState(state), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth/email",
    expires: new Date(state.exp),
  });
}

export function readUpgradeState(req: NextRequest): UpgradeState | null {
  return decodeUpgradeState(req.cookies.get(UPGRADE_STATE_COOKIE)?.value);
}

export function clearUpgradeState(response: NextResponse): void {
  response.cookies.set(UPGRADE_STATE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth/email",
    expires: new Date(0),
  });
}
