import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", req.headers.get("host"));
    const suppliedTenantId = req.nextUrl.searchParams.get("tenant_id");
    if (suppliedTenantId && (!UUID.test(suppliedTenantId) || suppliedTenantId !== staff.tenant.id)) {
      throw new RequestError(403, "The requested queue does not belong to this county workspace.", "forbidden");
    }
    const requests = await platform.listEntitlementAssistance(staff.tenant.id, 50);
    return NextResponse.json(
      { queue: "identity_review", tenant: staff.tenant, requests },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", req.headers.get("host"));
    const body = await readJsonObject(req);
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const expectedRowVersion = Number(body.expected_row_version);
    const decision = body.decision;
    const resolutionCode = typeof body.resolution_code === "string"
      ? body.resolution_code.trim().toLowerCase().slice(0, 64)
      : undefined;
    if (!UUID.test(requestId) || !Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1
      || !["claim", "approve", "deny"].includes(String(decision))) {
      throw new RequestError(400, "A valid queue action is required.", "invalid_request");
    }
    const { data: queued, error: queueError } = await platform.client
      .from("entitlement_assistance_requests")
      .select("id")
      .eq("id", requestId)
      .eq("tenant_id", staff.tenant.id)
      .maybeSingle();
    if (queueError) throw queueError;
    if (!queued) throw new RequestError(404, "The requested queue item was not found in this county workspace.", "not_found");
    const result = await platform.resolveEntitlementAssistance({
      requestId,
      expectedRowVersion,
      decision: decision as "claim" | "approve" | "deny",
      resolutionCode,
    });
    return NextResponse.json(
      { ok: true, request: result },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
