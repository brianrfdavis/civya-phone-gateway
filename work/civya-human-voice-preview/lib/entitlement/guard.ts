import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { CASE_ACCESS_SCOPES } from "@/lib/auth/contracts";
import { getRuntimeConfig } from "@/lib/config/runtime";
import type { CivyaPlatform } from "@/lib/platform";
import { configuredSyntheticTenantSlug } from "@/lib/security/synthetic-sandbox";
import { resolveTenantSlug } from "@/lib/tenancy/resolve-tenant";
import {
  hashOpaqueReference,
  readEntitlementGrant,
  type CaseEntitlementGrant,
} from "@/lib/entitlement/grant";
import { RequestError } from "@/lib/security/request";

const ENTITLEMENT_ERROR = "Verify Wayne County case access before continuing.";
const ENTITLEMENT_CODE = "entitlement_required";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate only the account-bound grant. Routes may use this before a
 * tenant-scoped lookup whose result supplies the opaque case binding.
 * A protected response must still call requireCaseEntitlement with that
 * binding before it returns or mutates case-derived data.
 */
export async function requireCaseEntitlementSession(
  req: NextRequest,
  platform: CivyaPlatform,
): Promise<CaseEntitlementGrant> {
  const grant = await caseEntitlementSession(req, platform);
  if (!grant) throw entitlementRequired();
  return grant;
}

/** Validate both the account-bound grant and the route-resolved case binding. */
export async function requireCaseEntitlement(
  req: NextRequest,
  platform: CivyaPlatform,
  opaqueCaseBinding: string,
): Promise<CaseEntitlementGrant> {
  const grant = await requireCaseEntitlementSession(req, platform);
  if (!validOpaqueBinding(opaqueCaseBinding)) throw entitlementRequired();
  if (!constantTimeEqual(grant.caseId, opaqueCaseBinding)) {
    throw entitlementRequired();
  }
  return grant;
}

/**
 * Safe probe for bootstrap/general-information routes. A true result is not
 * case authorization: a case-derived response must still verify its binding.
 */
export async function hasCaseEntitlementSession(
  req: NextRequest,
  platform: CivyaPlatform,
): Promise<boolean> {
  return (await caseEntitlementSession(req, platform)) !== null;
}

async function caseEntitlementSession(
  req: NextRequest,
  platform: CivyaPlatform,
): Promise<CaseEntitlementGrant | null> {
  const principal = platform.principal;
  if (principal.role !== "resident" || !principal.isVerified || !principal.userId) return null;

  const grant = readEntitlementGrant(req);
  if (
    !grant
    || !Number.isFinite(grant.exp)
    || grant.exp <= Date.now()
    || !["notice_code", "invitation_code", "staff_assisted"].includes(grant.method)
    || !constantTimeEqual(grant.userId, principal.userId)
    || !UUID.test(grant.tenantId)
    || !UUID.test(grant.caseId)
    || !constantTimeEqual(grant.caseBindingHash, hashOpaqueReference(grant.caseId))
    || grant.purpose !== "case_access"
    || !Array.isArray(grant.scopes)
    || grant.scopes.length !== CASE_ACCESS_SCOPES.length
    || !CASE_ACCESS_SCOPES.every((scope, index) => grant.scopes[index] === scope)
    || !Number.isSafeInteger(grant.rowVersion)
    || !["case_entitlement", "fictional_invitation"].includes(grant.accessType)
    || (grant.accessType === "case_entitlement"
      && (!grant.entitlementId
        || !UUID.test(grant.entitlementId)
        || !grant.grantIdHash
        || !constantTimeEqual(grant.grantIdHash, hashOpaqueReference(grant.entitlementId))
        || grant.rowVersion < 1))
    || (grant.accessType === "fictional_invitation"
      && (grant.entitlementId !== undefined
        || grant.grantIdHash !== undefined
        || grant.rowVersion !== 0))
  ) {
    return null;
  }
  try {
    const status = await platform.validateEntitlementCache(grant);
    const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : NaN;
    if (!status.authorized
      || status.accessType !== grant.accessType
      || status.entitlementId !== grant.entitlementId
      || status.rowVersion !== grant.rowVersion
      || status.tenantId !== grant.tenantId
      || status.caseId !== grant.caseId
      || status.purpose !== grant.purpose
      || !Array.isArray(status.scopes)
      || status.scopes.length !== grant.scopes.length
      || !grant.scopes.every((scope, index) => status.scopes?.[index] === scope)
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
      || grant.exp > expiresAt + 1_000) {
      return null;
    }
    if (!await tenantBoundaryMatches(req, platform, grant)) return null;
  } catch {
    return null;
  }
  return grant;
}

async function tenantBoundaryMatches(
  req: NextRequest,
  platform: CivyaPlatform,
  grant: CaseEntitlementGrant,
): Promise<boolean> {
  const config = getRuntimeConfig();
  const fictionalGrant = grant.accessType === "fictional_invitation";

  // Deterministic unit tests exercise a production-shaped entitlement without
  // a database tenant fixture. No development or staging deployment inherits
  // that convenience: every hosted-capable runtime remains host-bound.
  if (!fictionalGrant && config.syntheticMode && config.environment === "test") return true;
  if (fictionalGrant && (!config.syntheticMode || config.environment === "production")) return false;

  const tenantSlug = resolveTenantSlug(req.headers.get("host"), config);
  if (fictionalGrant && tenantSlug !== configuredSyntheticTenantSlug()) return false;
  const { data: tenant, error } = await platform.client
    .from("tenants")
    .select("id,slug,environment,fictional,status")
    .eq("id", grant.tenantId)
    .single();
  if (error || !tenant || tenant.slug !== tenantSlug || tenant.status !== "active") return false;
  if (fictionalGrant) {
    return tenant.environment === "sandbox"
      && tenant.fictional === true
      && tenant.slug === configuredSyntheticTenantSlug();
  }
  return tenant.environment !== "sandbox" && tenant.fictional !== true;
}

function validOpaqueBinding(value: string): boolean {
  return typeof value === "string" && UUID.test(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function entitlementRequired(): RequestError {
  return new RequestError(403, ENTITLEMENT_ERROR, ENTITLEMENT_CODE);
}
