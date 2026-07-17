import { NextRequest, NextResponse } from "next/server";
import { bootstrapAuthorizedResidentCase } from "@/lib/conversation/runtime-bootstrap.server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import {
  PlatformDataError,
  bootstrapEntitledProductionCase,
  bootstrapSession,
} from "@/lib/platform";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import {
  clearEntitlementSelection,
  hashOpaqueReference,
  readEntitlementSelection,
  setEntitlementGrant,
} from "@/lib/entitlement/grant";
import { requireVerifiedResident } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Select one saved case after an existing-email handoff without merging it. */
export async function POST(req: NextRequest) {
  try {
    const platform = await requireVerifiedResident();
    const body = await readJsonObject(req, 2_000);
    const caseId = typeof body.case_id === "string"
      ? body.case_id
      : typeof body.caseId === "string"
        ? body.caseId
        : "";
    if (!UUID.test(caseId)) throw new RequestError(400, "Choose a valid saved case.");
    const selection = readEntitlementSelection(req);
    if (selection) {
      if (selection.userId !== platform.principal.userId
        || ![selection.attachedCaseId, selection.existingActiveCaseId].includes(caseId)
        || (caseId === selection.existingActiveCaseId && !selection.existingCaseAvailable)) {
        throw new RequestError(403, "That saved case is not available from this choice.", "forbidden");
      }
      const selected = await platform.selectEntitledCase(selection.selectionId, caseId);
      if (!selected.authorized || !selected.accessType || !selected.tenantId
        || selected.caseId !== caseId || selected.purpose !== "case_access"
        || !selected.scopes || !Number.isSafeInteger(selected.rowVersion)) {
        throw new Error("The selected case did not return an authoritative entitlement.");
      }
      const cache = await platform.validateEntitlementCache({
        entitlementId: selected.entitlementId,
        rowVersion: selected.rowVersion || 0,
        tenantId: selected.tenantId,
        caseId,
        purpose: selected.purpose,
        scopes: selected.scopes,
      });
      const expiresAt = cache.expiresAt ? Date.parse(cache.expiresAt) : NaN;
      if (!cache.authorized || cache.accessType !== selected.accessType
        || cache.caseId !== caseId || !Number.isFinite(expiresAt)) {
        throw new Error("The selected case entitlement is not active.");
      }
      if (!getRuntimeConfig().syntheticMode
        && (cache.accessType !== "case_entitlement" || !cache.entitlementId)) {
        throw new RequestError(403, "Verify Wayne County case access before continuing.", "entitlement_required");
      }
      const bootstrap = cache.accessType === "case_entitlement" && cache.entitlementId
        ? await bootstrapEntitledProductionCase(platform, caseId, cache.entitlementId)
        : await bootstrapSession(platform);
      const response = NextResponse.json(
        { ok: true, bootstrap, selected_case_id: caseId, cases_merged: false },
        { headers: { "Cache-Control": "private, no-store" } },
      );
      setEntitlementGrant(response, {
        userId: platform.principal.userId,
        entitlementId: cache.entitlementId,
        grantIdHash: cache.entitlementId ? hashOpaqueReference(cache.entitlementId) : undefined,
        rowVersion: cache.rowVersion || 0,
        tenantId: selected.tenantId,
        caseId,
        caseBindingHash: hashOpaqueReference(caseId),
        purpose: "case_access",
        scopes: selected.scopes,
        accessType: cache.accessType,
        method: selection.method,
        exp: expiresAt,
      });
      clearEntitlementSelection(response);
      return response;
    }
    await requireCaseEntitlement(req, platform, caseId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await platform.loadCaseSnapshot(caseId);
      try {
        await platform.activateCase(caseId, snapshot.rowVersion);
        const bootstrap = await bootstrapAuthorizedResidentCase(req, platform);
        return NextResponse.json(
          { ok: true, bootstrap, selected_case_id: caseId, cases_merged: false },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      } catch (error) {
        if (attempt === 0 && error instanceof PlatformDataError && error.retryable) continue;
        throw error;
      }
    }
    throw new PlatformDataError("The saved case changed while it was being opened.", "concurrent_update", true);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
