import type { NextRequest } from "next/server";
import type { Provider } from "@supabase/supabase-js";
import type { CivyaOAuthProvider } from "./contracts";

const PROVIDERS: Record<CivyaOAuthProvider, { supabase: Provider; env: string; label: string; scopes?: string }> = {
  google: { supabase: "google", env: "CIVYA_AUTH_GOOGLE_ENABLED", label: "Google", scopes: "openid email" },
  apple: { supabase: "apple", env: "CIVYA_AUTH_APPLE_ENABLED", label: "Apple", scopes: "name email" },
  linkedin: { supabase: "linkedin_oidc", env: "CIVYA_AUTH_LINKEDIN_ENABLED", label: "LinkedIn", scopes: "openid profile email" },
};

export function isCivyaOAuthProvider(value: unknown): value is CivyaOAuthProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export function oauthProviderConfig(provider: CivyaOAuthProvider) {
  const item = PROVIDERS[provider];
  return { ...item, enabled: process.env[item.env] === "true" };
}

export function oauthCapabilities() {
  return (Object.keys(PROVIDERS) as CivyaOAuthProvider[]).map((provider) => {
    const item = oauthProviderConfig(provider);
    return {
      provider,
      label: item.label,
      available: item.enabled,
      unavailable_reason: item.enabled ? undefined : "Not configured for this Civya deployment.",
    };
  });
}

export function trustedPublicOrigin(req: NextRequest): string {
  const configured = process.env.CIVYA_PUBLIC_ORIGIN?.trim();
  const candidate = configured || req.nextUrl.origin;
  const url = new URL(candidate);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!local && url.protocol !== "https:") throw new Error("CIVYA_PUBLIC_ORIGIN must use HTTPS.");
  if ((process.env.NODE_ENV === "production" || process.env.VERCEL) && !configured) {
    throw new Error("CIVYA_PUBLIC_ORIGIN is required for hosted account callbacks.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
