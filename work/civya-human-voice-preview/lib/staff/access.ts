import { getRuntimeConfig } from "@/lib/config/runtime";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveTenantSlug } from "@/lib/tenancy/resolve-tenant";
import type { StaffBootstrap } from "@/lib/platform/types";

export interface StaffEmailAuthorization {
  authorized: boolean;
  authUserId?: string;
  role?: "reviewer" | "admin";
  tenantId?: string;
  tenantSlug?: string;
  tenantName?: string;
  environment?: StaffBootstrap["tenant"]["environment"];
  fictional?: boolean;
}

export interface PublicStaffWorkspace {
  name: string;
  slug: string;
  environment: StaffBootstrap["tenant"]["environment"];
  fictional: boolean;
}

export function resolveStaffTenantSlug(rawHost: string | null): string {
  return resolveTenantSlug(rawHost, getRuntimeConfig());
}

/**
 * Service-only authorization lookup. Callers must keep the result private and
 * return the same public response whether authorization succeeds or fails.
 */
export async function authorizeStaffEmail(
  tenantSlug: string,
  email: string,
): Promise<StaffEmailAuthorization> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc("civya_service_authorize_staff_email", {
    p_tenant_slug: tenantSlug,
    p_email: email,
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { authorized: false };
  return data as StaffEmailAuthorization;
}

/** Public, host-bound tenant presentation data; no identities or roles. */
export async function loadPublicStaffWorkspace(tenantSlug: string): Promise<PublicStaffWorkspace> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("tenants")
    .select("name,slug,environment,fictional,status")
    .eq("slug", tenantSlug)
    .eq("status", "active")
    .single();
  if (error || !data || data.slug !== tenantSlug) {
    throw new Error("The county staff workspace is unavailable.");
  }
  return {
    name: data.name,
    slug: data.slug,
    environment: data.environment as PublicStaffWorkspace["environment"],
    fictional: data.fictional === true,
  };
}
