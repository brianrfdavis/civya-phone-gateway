import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { CivyaPlatform } from "@/lib/platform/repository";
import {
  configuredSyntheticTenantSlug,
  requireSyntheticSandboxHost,
} from "./synthetic-sandbox";

export const DEMO_ACCESS_COOKIE = "civya_demo_access";

interface DemoAccessClaims {
  tenant: string;
  exp: number;
  invitation: string;
}

function secret(): string | undefined {
  return process.env.CIVYA_DEMO_ACCESS_SECRET;
}

function signature(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function createDemoAccessToken(claims: DemoAccessClaims): string {
  const key = secret();
  if (!key) throw new Error("CIVYA_DEMO_ACCESS_SECRET is not configured.");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
}

export function verifyDemoAccessToken(token: string | undefined): DemoAccessClaims | null {
  const key = secret();
  if (!key || !token) return null;
  const [payload, suppliedSignature] = token.split(".");
  if (!payload || !suppliedSignature) return null;
  const expected = signature(payload, key);
  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DemoAccessClaims;
    if (!claims.tenant || !claims.invitation || !Number.isFinite(claims.exp) || claims.exp <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function hasDemoAccess(req: NextRequest): boolean {
  const hosted = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  const setting = process.env.CIVYA_REQUIRE_DEMO_ACCESS;
  if (setting !== "true" && (!hosted || setting === "false")) return true;
  const claims = verifyDemoAccessToken(req.cookies.get(DEMO_ACCESS_COOKIE)?.value);
  return claims?.tenant === configuredSyntheticTenantSlug();
}

/**
 * Bind a valid signed county invitation to the current Supabase identity.
 *
 * Middleware protects the web surface with the cookie; the durable grant is a
 * second boundary used by Postgres RLS and service-only workflow functions.
 * Keeping both expirations aligned prevents a copied/stale Auth session from
 * retaining access after the county invitation ends.
 */
export async function grantDemoAccessFromRequest(
  req: NextRequest,
  platform: CivyaPlatform,
): Promise<boolean> {
  const expectedTenant = requireSyntheticSandboxHost(req);
  const claims = verifyDemoAccessToken(req.cookies.get(DEMO_ACCESS_COOKIE)?.value);
  if (!claims || claims.tenant !== expectedTenant) return false;
  await platform.grantTenantAccess({
    tenantSlug: claims.tenant,
    invitationId: claims.invitation,
    expiresAt: new Date(claims.exp).toISOString(),
  });
  return true;
}

export function setDemoAccessCookie(
  response: NextResponse,
  claims: Omit<DemoAccessClaims, "exp"> & { expiresAt: Date },
): void {
  const exp = claims.expiresAt.getTime();
  response.cookies.set(
    DEMO_ACCESS_COOKIE,
    createDemoAccessToken({ tenant: claims.tenant, invitation: claims.invitation, exp }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: claims.expiresAt,
    },
  );
}
