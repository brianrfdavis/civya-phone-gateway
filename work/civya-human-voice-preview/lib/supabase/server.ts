import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { requireSupabasePublicConfig } from "./config";

/** Cookie-backed RLS client for Server Components and Route Handlers. */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = requireSupabasePublicConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot set cookies. Middleware/Route Handlers refresh them.
        }
      },
    },
  });
}

/** RLS client for callers that explicitly transport a Supabase access token. */
export function createSupabaseAccessTokenClient(accessToken: string): SupabaseClient {
  const { url, anonKey } = requireSupabasePublicConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
