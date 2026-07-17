import { NextRequest, NextResponse } from "next/server";
import { createRequestPlatform } from "@/lib/platform";
import { hasCaseEntitlementSession } from "@/lib/entitlement/guard";
import {
  clearEntitlementGrant,
  hashOpaqueReference,
  readEntitlementGrant,
  readPendingEntitlement,
  readEntitlementSelection,
  setEntitlementGrant,
} from "@/lib/entitlement/grant";
import { entitlementCapabilities } from "@/lib/entitlement/verifier";

export async function GET(req: NextRequest) {
  const platform = await createRequestPlatform().catch(() => null);
  if (!platform?.principal.isVerified) {
    return NextResponse.json(
      {
        account: { state: platform ? "anonymous" : "none" },
        entitlement: { state: "account_required" },
        capabilities: entitlementCapabilities(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const selection = readEntitlementSelection(req);
  if (selection?.userId === platform.principal.userId) {
    const response = NextResponse.json(
      {
        account: { state: "verified" },
        entitlement: { state: "selection_required", method: selection.method },
        resume: { pending_task: selection.pendingTask },
        case_selection_required: true,
        attached_case_id: selection.attachedCaseId,
        existing_active_case_id: selection.existingActiveCaseId,
        existing_case_available: selection.existingCaseAvailable,
        capabilities: entitlementCapabilities(),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
    // A pending choice is not an active-case authorization. Do not allow a
    // stale browser grant to survive while the user chooses the one case that
    // the transactional selection RPC will activate.
    clearEntitlementGrant(response);
    return response;
  }
  const valid = await hasCaseEntitlementSession(req, platform);
  let grant = valid ? readEntitlementGrant(req) : null;
  // Fictional sandbox access may be cached only from a still-active explicit
  // invitation. Production always requires a database entitlement row.
  if (!grant) {
    const pending = readPendingEntitlement(req);
    if (pending?.userId === platform.principal.userId
      && pending.caseAccess.tenantEnvironment === "sandbox"
      && pending.caseAccess.tenantFictional
      && !pending.transferToken) {
      const access = await platform.validateEntitlementCache({
        rowVersion: 0,
        tenantId: pending.caseAccess.tenantId,
        caseId: pending.caseAccess.caseId,
        purpose: pending.caseAccess.purpose,
        scopes: pending.caseAccess.scopes,
      }).catch(() => null);
      const expiresAt = access?.expiresAt ? Date.parse(access.expiresAt) : NaN;
      if (access?.authorized && access.accessType === "fictional_invitation"
        && Number.isFinite(expiresAt)) {
        grant = {
          userId: platform.principal.userId,
          rowVersion: 0,
          tenantId: pending.caseAccess.tenantId,
          caseId: pending.caseAccess.caseId,
          caseBindingHash: hashOpaqueReference(pending.caseAccess.caseId),
          purpose: pending.caseAccess.purpose,
          scopes: pending.caseAccess.scopes,
          accessType: "fictional_invitation",
          method: "invitation_code",
          exp: expiresAt,
        };
      }
    }
  }
  const response = NextResponse.json(
    {
      account: { state: "verified" },
      entitlement: grant
        ? { state: "verified", method: grant.method, expires_at: new Date(grant.exp).toISOString() }
        : { state: "required" },
      capabilities: entitlementCapabilities(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (grant) setEntitlementGrant(response, grant);
  else clearEntitlementGrant(response);
  return response;
}
