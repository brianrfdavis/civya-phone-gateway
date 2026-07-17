import type { NextRequest } from "next/server";
import { getRuntimeConfig, type RuntimeConfig } from "@/lib/config/runtime";
import { resolveTenantSlug, TenantResolutionError } from "@/lib/tenancy/resolve-tenant";
import { RequestError } from "./request";

export const DEFAULT_SYNTHETIC_TENANT_SLUG = "wayne-county-demo";

export function configuredSyntheticTenantSlug(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CIVYA_DEMO_TENANT_SLUG?.trim() || DEFAULT_SYNTHETIC_TENANT_SLUG;
}

/**
 * Prove that a request is running on the one explicitly configured fictional
 * tenant. A synthetic provider flag by itself is never a tenant boundary.
 */
export function requireSyntheticSandboxHost(
  request: NextRequest,
  config: RuntimeConfig = getRuntimeConfig(),
): string {
  if (!config.syntheticMode || config.environment === "production") {
    throw new RequestError(404, "This sandbox action is unavailable.", "sandbox_only");
  }

  const expectedTenant = configuredSyntheticTenantSlug();
  try {
    const resolvedTenant = resolveTenantSlug(request.headers.get("host"), config);
    if (resolvedTenant !== expectedTenant) {
      throw new RequestError(404, "This sandbox action is unavailable.", "sandbox_only");
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof TenantResolutionError) {
      throw new RequestError(404, "This sandbox action is unavailable.", "sandbox_only");
    }
    throw error;
  }
  return expectedTenant;
}
