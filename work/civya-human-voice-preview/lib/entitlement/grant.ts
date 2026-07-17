import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import {
  isCaseAccessBinding,
  type CaseAccessBinding,
  type CaseAccessPurpose,
  type CaseAccessScope,
  type PendingAccountTask,
} from "@/lib/auth/contracts";
import { openFlowState, sealFlowState } from "@/lib/auth/flow-state";

export const ENTITLEMENT_PENDING_COOKIE = "civya_entitlement_pending";
export const ENTITLEMENT_GRANT_COOKIE = "civya_case_entitlement";
export const ENTITLEMENT_ASSISTANCE_COOKIE = "civya_entitlement_assistance";
export const ENTITLEMENT_SELECTION_COOKIE = "civya_entitlement_selection";

export interface PendingEntitlement {
  userId: string;
  sourceUserId: string;
  transferToken?: string;
  caseAccess: CaseAccessBinding;
  pendingTask?: PendingAccountTask;
  exp: number;
}

export interface CaseEntitlementGrant {
  userId: string;
  entitlementId?: string;
  grantIdHash?: string;
  rowVersion: number;
  tenantId: string;
  caseId: string;
  caseBindingHash: string;
  purpose: CaseAccessPurpose;
  scopes: readonly CaseAccessScope[];
  accessType: "case_entitlement" | "fictional_invitation";
  method: "notice_code" | "invitation_code" | "staff_assisted";
  exp: number;
}

export interface EntitlementAssistanceState {
  requestId: string;
  correlationId: string;
  userId: string;
  exp: number;
}

export interface EntitlementSelectionState {
  selectionId: string;
  userId: string;
  attachedCaseId: string;
  existingActiveCaseId: string;
  existingCaseAvailable: boolean;
  method: "notice_code" | "invitation_code" | "staff_assisted";
  pendingTask?: PendingAccountTask;
  exp: number;
}

const secure = () => process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

export function hashOpaqueReference(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function setPendingEntitlement(response: NextResponse, value: PendingEntitlement): void {
  response.cookies.set(ENTITLEMENT_PENDING_COOKIE, sealFlowState(value), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/entitlements",
    expires: new Date(value.exp),
  });
}

export function readPendingEntitlement(req: NextRequest): PendingEntitlement | null {
  const pending = openFlowState<PendingEntitlement>(req.cookies.get(ENTITLEMENT_PENDING_COOKIE)?.value);
  return pending && pending.userId && pending.sourceUserId && isCaseAccessBinding(pending.caseAccess)
    ? pending
    : null;
}

export function clearPendingEntitlement(response: NextResponse): void {
  response.cookies.set(ENTITLEMENT_PENDING_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/entitlements",
    expires: new Date(0),
  });
}

export function setEntitlementGrant(response: NextResponse, value: CaseEntitlementGrant): void {
  response.cookies.set(ENTITLEMENT_GRANT_COOKIE, sealFlowState(value), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/",
    expires: new Date(value.exp),
  });
}

export function readEntitlementGrant(req: NextRequest): CaseEntitlementGrant | null {
  const grant = openFlowState<CaseEntitlementGrant>(
    req.cookies.get(ENTITLEMENT_GRANT_COOKIE)?.value,
  );
  if (!grant?.caseId || grant.caseBindingHash !== hashOpaqueReference(grant.caseId)) {
    return null;
  }
  if (
    grant.accessType === "case_entitlement"
    && (!grant.entitlementId
      || !grant.grantIdHash
      || grant.grantIdHash !== hashOpaqueReference(grant.entitlementId))
  ) {
    return null;
  }
  return grant;
}

export function setEntitlementAssistance(
  response: NextResponse,
  value: EntitlementAssistanceState,
): void {
  response.cookies.set(ENTITLEMENT_ASSISTANCE_COOKIE, sealFlowState(value), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/entitlements/human",
    expires: new Date(value.exp),
  });
}

export function readEntitlementAssistance(req: NextRequest): EntitlementAssistanceState | null {
  const state = openFlowState<EntitlementAssistanceState>(
    req.cookies.get(ENTITLEMENT_ASSISTANCE_COOKIE)?.value,
  );
  return state?.requestId && state.correlationId && state.userId ? state : null;
}

export function clearEntitlementAssistance(response: NextResponse): void {
  response.cookies.set(ENTITLEMENT_ASSISTANCE_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api/entitlements/human",
    expires: new Date(0),
  });
}

export function setEntitlementSelection(
  response: NextResponse,
  value: EntitlementSelectionState,
): void {
  response.cookies.set(ENTITLEMENT_SELECTION_COOKIE, sealFlowState(value), {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api",
    expires: new Date(value.exp),
  });
}

export function readEntitlementSelection(req: NextRequest): EntitlementSelectionState | null {
  const state = openFlowState<EntitlementSelectionState>(
    req.cookies.get(ENTITLEMENT_SELECTION_COOKIE)?.value,
  );
  return state?.selectionId && state.userId && state.attachedCaseId
    && state.existingActiveCaseId && typeof state.existingCaseAvailable === "boolean"
    ? state
    : null;
}

export function clearEntitlementSelection(response: NextResponse): void {
  response.cookies.set(ENTITLEMENT_SELECTION_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/api",
    expires: new Date(0),
  });
}

export function clearEntitlementGrant(response: NextResponse): void {
  response.cookies.set(ENTITLEMENT_GRANT_COOKIE, "", {
    httpOnly: true,
    secure: secure(),
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
  });
}
