import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabasePublicConfig, requireSupabaseServiceRoleKey } from "./config";

/** Server-only service client. Never expose this client or key to the browser. */
export function createSupabaseAdminClient(): SupabaseClient {
  const { url } = requireSupabasePublicConfig();
  return createClient(url, requireSupabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
