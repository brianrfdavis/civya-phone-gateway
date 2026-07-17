import { RequestError } from "@/lib/security/request";

export interface LivePaymentTenantRecord {
  slug?: unknown;
  environment?: unknown;
  fictional?: unknown;
}

/**
 * Keep the exact database field contract and the provider boundary adjacent.
 * Missing/renamed tenant fields fail closed; only an exact non-fictional
 * production row for the resolved hostname may invoke provider code.
 */
export async function reachLivePaymentProviderBoundary<Result>(input: {
  tenant: LivePaymentTenantRecord | null;
  tenantQueryFailed: boolean;
  configuredTenantSlug: string;
  providerBoundary: () => Result | Promise<Result>;
}): Promise<Result> {
  if (
    input.tenantQueryFailed
    || !input.tenant
    || input.tenant.slug !== input.configuredTenantSlug
    || input.tenant.environment !== "production"
    || input.tenant.fictional !== false
  ) {
    throw new RequestError(403, "This hostname is not authorized for that County case.", "forbidden");
  }
  return await input.providerBoundary();
}
