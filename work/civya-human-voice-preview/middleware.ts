import { NextRequest, NextResponse } from "next/server";
import { evaluateRuntimeGate, isRuntimeOperationalPath } from "@/lib/config/feature-gates";
import { getRuntimeConfig } from "@/lib/config/runtime";

const COOKIE = "civya_demo_access";
const PUBLIC_PREFIXES = [
  "/access",
  "/invite/",
  "/trust",
  "/services",
  "/staff/sign-in",
  "/api/invitations/exchange",
  "/api/staff/context",
  "/api/staff/auth/",
  "/api/health",
  "/api/admin/retention/run",
  "/api/webhooks/",
  "/api/handoffs/return",
  "/api/internal/secure-links/phone",
  "/api/secure-links/phone-resume",
  "/phone/resume",
];

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function validAccessCookie(
  token: string | undefined,
  secret: string,
  expectedTenant: string,
): Promise<boolean> {
  if (!token) return false;
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(supplied) as BufferSource,
      new TextEncoder().encode(payload),
    );
    if (!verified) return false;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as { exp?: number; tenant?: string };
    return Boolean(
      claims.tenant === expectedTenant &&
      claims.exp &&
      claims.exp > Date.now(),
    );
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  try {
    const gate = evaluateRuntimeGate(getRuntimeConfig(), {
      pathname: req.nextUrl.pathname,
      method: req.method,
    });
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.message, code: gate.code },
        { status: gate.status, headers: { "Cache-Control": "no-store, max-age=0", "Retry-After": "60" } },
      );
    }
  } catch {
    // Health, signed provider webhooks, and authorized staff/internal recovery
    // paths need to remain reachable so operators can diagnose and roll back a
    // bad runtime configuration. All resident surfaces fail closed.
    if (!isRuntimeOperationalPath(req.nextUrl.pathname)) {
      return NextResponse.json(
        { error: "Civya runtime configuration is invalid.", code: "runtime_configuration_invalid" },
        { status: 503, headers: { "Cache-Control": "no-store, max-age=0", "Retry-After": "60" } },
      );
    }
  }

  const environment = process.env.CIVYA_ENVIRONMENT || (process.env.NODE_ENV === "test" ? "test" : "development");
  const accessSetting = process.env.CIVYA_REQUIRE_DEMO_ACCESS;
  if (environment === "production" && accessSetting === "true") {
    return NextResponse.json(
      { error: "Production cannot run behind the fictional demo-access boundary.", code: "production_demo_boundary_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const accessRequired = environment !== "production" && accessSetting === "true";
  if (!accessRequired) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((prefix) => req.nextUrl.pathname === prefix || req.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const secret = process.env.CIVYA_DEMO_ACCESS_SECRET;
  const expectedTenant = process.env.CIVYA_DEMO_TENANT_SLUG || "wayne-county-demo";
  const allowed = secret && await validAccessCookie(
    req.cookies.get(COOKIE)?.value,
    secret,
    expectedTenant,
  );
  if (allowed) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "A valid county demo invitation is required.", code: "demo_access_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const destination = req.nextUrl.clone();
  destination.pathname = "/access";
  destination.search = "";
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|civya-logo.png).*)"],
};
