import type { RuntimeConfig } from "@/lib/config/runtime";

export class TenantResolutionError extends Error {
  constructor(
    readonly code: "unknown_tenant_host" | "invalid_tenant_host",
    message: string,
  ) {
    super(message);
    this.name = "TenantResolutionError";
  }
}

export function normalizeRequestHost(rawHost: string | null): string {
  if (!rawHost) throw new TenantResolutionError("invalid_tenant_host", "A trusted request hostname is required.");
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!host || host.includes("/") || host.includes("\\") || host.includes("@") || host.includes("\0")) {
    throw new TenantResolutionError("invalid_tenant_host", "The request hostname is invalid.");
  }
  return host;
}

export function resolveTenantSlug(rawHost: string | null, config: RuntimeConfig): string {
  const host = normalizeRequestHost(rawHost);
  const slug = config.tenantHosts[host];
  if (!slug) {
    throw new TenantResolutionError("unknown_tenant_host", "This Civya hostname is not assigned to an active tenant.");
  }
  return slug;
}
