"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabasePublicConfig } from "./config";

let browserClient: SupabaseClient | undefined;

export function createSupabaseBrowserClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const { url, anonKey } = requireSupabasePublicConfig();
  browserClient = createBrowserClient(url, anonKey);
  return browserClient;
}

export async function ensureAnonymousIdentity(captchaToken?: string): Promise<SupabaseClient> {
  const client = createSupabaseBrowserClient();
  const { data } = await client.auth.getSession();
  if (!data.session) {
    const { error } = await client.auth.signInAnonymously({ options: { captchaToken } });
    if (error) throw error;
  }
  return client;
}

/** Begin email verification while preserving the anonymous auth user id. */
export async function requestEmailUpgrade(email: string): Promise<void> {
  const client = createSupabaseBrowserClient();
  const { error } = await client.auth.updateUser({ email: email.trim().toLowerCase() });
  if (error) throw error;
}

/** Verify the six-digit email-change code; the auth user id remains unchanged. */
export async function verifyEmailUpgrade(email: string, token: string): Promise<void> {
  const client = createSupabaseBrowserClient();
  const { error } = await client.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.replace(/\D/g, ""),
    type: "email_change",
  });
  if (error) throw error;
}

/** Existing-account branch. Create a case transfer grant before calling this. */
export async function requestExistingAccountOtp(email: string, captchaToken?: string): Promise<void> {
  const client = createSupabaseBrowserClient();
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: false, captchaToken },
  });
  if (error) throw error;
}

export async function verifyExistingAccountOtp(email: string, token: string): Promise<void> {
  const client = createSupabaseBrowserClient();
  const { error } = await client.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.replace(/\D/g, ""),
    type: "email",
  });
  if (error) throw error;
}
