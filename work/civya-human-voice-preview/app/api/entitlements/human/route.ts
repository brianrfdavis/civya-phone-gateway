import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createRequestPlatform } from "@/lib/platform";
import {
  clearEntitlementAssistance,
  clearPendingEntitlement,
  hashOpaqueReference,
  readEntitlementAssistance,
  readPendingEntitlement,
  setEntitlementAssistance,
  setEntitlementGrant,
} from "@/lib/entitlement/grant";
import { humanEntitlementHelp } from "@/lib/entitlement/verifier";
import { rateLimitRequest, RequestError, requestErrorResponse } from "@/lib/security/request";

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform?.principal.isVerified) {
      throw new RequestError(401, "Sign in before requesting assisted case verification.", "authentication_required");
    }
    const limited = rateLimitRequest(req, "assisted-entitlement", 4, 60 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;
    const pending = readPendingEntitlement(req);
    if (!pending || pending.userId !== platform.principal.userId) {
      throw new RequestError(409, "Start case verification again before asking for help.", "entitlement_state_required");
    }
    const correlationId = crypto.randomUUID();
    const request = await platform.createEntitlementAssistance({
      binding: pending.caseAccess,
      transferToken: pending.transferToken,
      correlationId,
    });
    if (!request.requestId || !request.correlationId || !request.expiresAt) {
      throw new Error("The assistance queue did not return a durable request.");
    }
    const response = NextResponse.json(
      {
        ok: true,
        entitlement: { state: "staff_assisted_pending" },
        message: humanEntitlementHelp(),
        correlation_id: request.correlationId,
        sla_due_at: request.slaDueAt,
        disclosure: "No Wayne County case information has been opened or disclosed.",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
    setEntitlementAssistance(response, {
      requestId: request.requestId,
      correlationId: request.correlationId,
      userId: platform.principal.userId,
      exp: Date.parse(request.expiresAt),
    });
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform?.principal.isVerified) {
      throw new RequestError(401, "Sign in to check assisted verification.", "authentication_required");
    }
    const state = readEntitlementAssistance(req);
    if (!state || state.userId !== platform.principal.userId) {
      throw new RequestError(404, "No active assisted verification request was found.", "assistance_unavailable");
    }
    const status = await platform.entitlementAssistanceStatus(state.requestId);
    if (!status.found || status.correlationId !== state.correlationId) {
      throw new RequestError(404, "No active assisted verification request was found.", "assistance_unavailable");
    }
    const response = NextResponse.json(
      {
        ok: true,
        entitlement: { state: status.state === "approved" ? "verified" : `staff_assisted_${status.state}` },
        correlation_id: status.correlationId,
        sla_due_at: status.slaDueAt,
        message: status.state === "approved"
          ? "Your time-limited case access is ready."
          : status.state === "denied"
            ? "Staff could not establish case access from this request."
            : humanEntitlementHelp(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    const access = status.access;
    const expiresAt = access?.expiresAt ? Date.parse(access.expiresAt) : NaN;
    if (status.state === "approved" && access?.authorized && access.accessType
      && access.tenantId && access.caseId && access.purpose === "case_access"
      && access.scopes && Number.isFinite(expiresAt) && Number.isSafeInteger(access.rowVersion)) {
      setEntitlementGrant(response, {
        userId: platform.principal.userId,
        entitlementId: access.entitlementId,
        grantIdHash: access.entitlementId ? hashOpaqueReference(access.entitlementId) : undefined,
        rowVersion: access.rowVersion || 0,
        tenantId: access.tenantId,
        caseId: access.caseId,
        caseBindingHash: hashOpaqueReference(access.caseId),
        purpose: access.purpose,
        scopes: access.scopes,
        accessType: access.accessType,
        method: "staff_assisted",
        exp: expiresAt,
      });
      clearPendingEntitlement(response);
      clearEntitlementAssistance(response);
    } else if (["denied", "expired", "cancelled"].includes(status.state)) {
      clearEntitlementAssistance(response);
    }
    return response;
  } catch (error) {
    return requestErrorResponse(error);
  }
}
