import { NextRequest, NextResponse } from "next/server";
import { sameCaseAccessBinding } from "@/lib/auth/contracts";
import { createRequestPlatform } from "@/lib/platform";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import {
  entitlementCapabilities,
  normalizeEntitlementCode,
  validEntitlementCode,
  verifyCaseEntitlement,
  type EntitlementMethod,
} from "@/lib/entitlement/verifier";
import {
  clearPendingEntitlement,
  clearEntitlementGrant,
  clearEntitlementSelection,
  hashOpaqueReference,
  readPendingEntitlement,
  setEntitlementGrant,
  setEntitlementSelection,
} from "@/lib/entitlement/grant";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform?.principal.isVerified) {
      throw new RequestError(401, "Sign in to your Civya account before verifying case access.", "authentication_required");
    }
    const limited = rateLimitRequest(req, "case-entitlement", 6, 15 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;
    const pending = readPendingEntitlement(req);
    if (!pending || pending.userId !== platform.principal.userId) {
      throw new RequestError(409, "Start case verification again from your signed-in account.", "entitlement_state_required");
    }
    const body = await readJsonObject(req);
    const method = body.method;
    if (method !== "notice_code" && method !== "invitation_code") {
      throw new RequestError(400, "Choose a notice code or invitation code.", "invalid_method");
    }
    const capabilities = entitlementCapabilities();
    if (!capabilities[method]) {
      return NextResponse.json(
        {
          error: capabilities.unavailable_reason,
          code: "entitlement_provider_unavailable",
          entitlement: { state: "required" },
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const code = normalizeEntitlementCode(body.code);
    if (!validEntitlementCode(code)) {
      throw new RequestError(400, "Enter the complete code exactly as it appears on the notice or invitation.", "invalid_code");
    }
    // Recover a committed handoff before touching a potentially one-time
    // external code. This covers a lost HTTP response after the database
    // transaction committed but before the browser received its cookie.
    let finalized = await platform.recoverBoundCaseEntitlementHandoff({
      transferToken: pending.transferToken,
      binding: pending.caseAccess,
      method,
    });
    let verifierExpiresAt = finalized ? Date.parse(finalized.expiresAt) : NaN;
    if (!finalized) {
      const result = await verifyCaseEntitlement({
        userId: platform.principal.userId,
        method: method as EntitlementMethod,
        code,
        binding: pending.caseAccess,
      });
      if (!result) {
        return NextResponse.json(
          {
            error: "We could not verify access from that information. Check the code or ask a person for help.",
            code: "entitlement_not_verified",
            entitlement: { state: "required" },
          },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      if (!sameCaseAccessBinding(result.binding, pending.caseAccess)) {
        throw new RequestError(409, "Case verification did not match this request.", "entitlement_binding_mismatch");
      }
      // This RPC rechecks the authoritative tuple and consumes any transfer in
      // the same transaction that creates the proof, entitlement, receipt, and
      // (when needed) one-time case-selection record.
      finalized = await platform.finalizeBoundCaseEntitlement({
        transferToken: pending.transferToken,
        binding: pending.caseAccess,
        method,
        verifierGrantId: result.grantId,
        expiresAt: result.expiresAt,
      });
      verifierExpiresAt = result.expiresAt;
    }
    if (finalized.requiresCaseSelection) {
      if (!finalized.existingActiveCaseId
        || !finalized.selectionId
        || !finalized.selectionExpiresAt
        || finalized.existingActiveCaseId === pending.caseAccess.caseId
        || (finalized.accessType === "case_entitlement" && !finalized.entitlementId)) {
        throw new Error("The authoritative case selection context was incomplete.");
      }
      const selectionExpiry = Date.parse(finalized.selectionExpiresAt);
      if (!Number.isFinite(selectionExpiry) || selectionExpiry <= Date.now()) {
        throw new Error("The authoritative case selection context had expired.");
      }
      const response = NextResponse.json(
        {
          ok: true,
          account: { state: "verified" },
          entitlement: { state: "selection_required", method },
          resume: { pending_task: pending.pendingTask },
          case_selection_required: true,
          attached_case_id: pending.caseAccess.caseId,
          existing_active_case_id: finalized.existingActiveCaseId,
          existing_case_available: finalized.existingCaseAvailable === true,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
      setEntitlementSelection(response, {
        selectionId: finalized.selectionId,
        userId: platform.principal.userId,
        attachedCaseId: pending.caseAccess.caseId,
        existingActiveCaseId: finalized.existingActiveCaseId,
        existingCaseAvailable: finalized.existingCaseAvailable === true,
        method,
        pendingTask: pending.pendingTask,
        exp: selectionExpiry,
      });
      clearEntitlementGrant(response);
      clearPendingEntitlement(response);
      return response;
    }
    const cache = await platform.validateEntitlementCache({
      entitlementId: finalized.entitlementId,
      rowVersion: finalized.rowVersion,
      tenantId: pending.caseAccess.tenantId,
      caseId: pending.caseAccess.caseId,
      purpose: pending.caseAccess.purpose,
      scopes: pending.caseAccess.scopes,
    });
    const persistedExpiry = cache.expiresAt ? Date.parse(cache.expiresAt) : NaN;
    if (!cache.authorized || !cache.accessType || !Number.isFinite(persistedExpiry)) {
      throw new Error("The authoritative entitlement was not active after verification.");
    }
    if (!Number.isFinite(verifierExpiresAt)) {
      throw new Error("The authoritative entitlement expiry was invalid.");
    }
    const expiresAt = Math.min(verifierExpiresAt, persistedExpiry);

    const response = NextResponse.json(
      {
        ok: true,
        account: { state: "verified" },
        entitlement: { state: "verified", method, expires_at: new Date(expiresAt).toISOString() },
        resume: { pending_task: pending?.pendingTask },
        case_selection_required: false,
        attached_case_id: pending.caseAccess.caseId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    setEntitlementGrant(response, {
      userId: platform.principal.userId,
      entitlementId: cache.entitlementId,
      grantIdHash: cache.entitlementId ? hashOpaqueReference(cache.entitlementId) : undefined,
      rowVersion: cache.rowVersion || 0,
      tenantId: pending.caseAccess.tenantId,
      caseId: pending.caseAccess.caseId,
      caseBindingHash: hashOpaqueReference(pending.caseAccess.caseId),
      purpose: pending.caseAccess.purpose,
      scopes: pending.caseAccess.scopes,
      accessType: cache.accessType,
      method,
      exp: expiresAt,
    });
    clearEntitlementSelection(response);
    clearPendingEntitlement(response);
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
