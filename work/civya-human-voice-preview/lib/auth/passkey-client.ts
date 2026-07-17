"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabasePublicConfig } from "@/lib/supabase/config";

let client: ReturnType<typeof createBrowserClient> | undefined;

function passkeyClient() {
  if (client) return client;
  const { url, anonKey } = requireSupabasePublicConfig();
  client = createBrowserClient(url, anonKey, {
    auth: { experimental: { passkey: true } },
  });
  return client;
}

export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext
    && "PublicKeyCredential" in window
    && Boolean(navigator.credentials);
}

export async function signInWithCivyaPasskey(): Promise<void> {
  if (!browserSupportsPasskeys()) throw new Error("Passkeys are not supported in this browser or connection.");
  const { error } = await passkeyClient().auth.signInWithPasskey();
  if (error) throw error;
}

export async function registerCivyaPasskey(): Promise<void> {
  if (!browserSupportsPasskeys()) throw new Error("Passkeys are not supported in this browser or connection.");
  const { error } = await passkeyClient().auth.registerPasskey();
  if (error) throw error;
}
