import { CivyaPlatform, createRequestPlatform, PlatformDataError, staffBootstrap } from "@/lib/platform";
import type { StaffBootstrap } from "@/lib/platform/types";
import { resolveStaffTenantSlug } from "@/lib/staff/access";
import { TenantResolutionError } from "@/lib/tenancy/resolve-tenant";
import { headers } from "next/headers";
import { RequestError } from "./request";

export async function requirePlatformSession(): Promise<CivyaPlatform> {
  const platform = await createRequestPlatform();
  if (!platform) throw new RequestError(401, "Authentication required.", "authentication_required");
  return platform;
}

export async function requireVerifiedResident(): Promise<CivyaPlatform> {
  const platform = await requirePlatformSession();
  if (platform.principal.role !== "resident") {
    throw new RequestError(403, "This action is available only in the resident view.", "forbidden");
  }
  if (!platform.principal.isVerified) {
    throw new RequestError(403, "Email verification is required for this saved action.", "verification_required");
  }
  return platform;
}

export interface StaffAccess {
  platform: CivyaPlatform;
  staff: StaffBootstrap;
}

export async function requireStaff(
  minimum: "reviewer" | "admin" = "reviewer",
  rawHost?: string | null,
): Promise<StaffAccess> {
  const host = rawHost === undefined ? (await headers()).get("host") : rawHost;
  let tenantSlug: string;
  try {
    tenantSlug = resolveStaffTenantSlug(host);
  } catch (error) {
    if (error instanceof TenantResolutionError) {
      throw new RequestError(404, "This hostname is not assigned to an active county workspace.", error.code);
    }
    throw error;
  }
  const platform = await requirePlatformSession();
  try {
    const staff = await staffBootstrap(platform, tenantSlug);
    if (minimum === "admin" && staff.role !== "admin") {
      throw new RequestError(403, "County administrator access required.", "forbidden");
    }
    // The principal's generic role lookup may reflect a different tenant when
    // a person works across counties. Rebind and, when necessary, downgrade
    // the request platform to the exact role proven for this hostname.
    const scopedPrincipal = { ...platform.principal, role: staff.role };
    const scopedPlatform = new CivyaPlatform(platform.client, scopedPrincipal);
    return { platform: scopedPlatform, staff: { ...staff, principal: scopedPrincipal } };
  } catch (error) {
    if (error instanceof PlatformDataError) throw new RequestError(403, error.message, "forbidden");
    throw error;
  }
}
