import { NextRequest, NextResponse } from "next/server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { createAdminPlatform } from "@/lib/platform";
import { ReminderRepository, ReminderStoreError } from "@/lib/reminders/repository.server";
import { requireVerifiedResident } from "@/lib/security/guards";
import { RequestError, requestErrorResponse, rateLimitRequest } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ reminderId: string }> },
) {
  const limited = rateLimitRequest(request, "reminder_cancel", 12, 60_000);
  if (limited) return limited;
  try {
    const platform = await requireVerifiedResident();
    const { reminderId } = await params;
    const caseId = request.nextUrl.searchParams.get("case_id") ?? "";
    if (!UUID.test(caseId) || !UUID.test(reminderId)) {
      throw new RequestError(400, "Choose a valid reminder and County case.");
    }
    const grant = await requireCaseEntitlement(request, platform, caseId);
    const { data: tenantRow, error: tenantError } = await platform.client.from("cases")
      .select("tenant_id,tenants!inner(environment,fictional,status)")
      .eq("id", caseId)
      .single();
    if (tenantError || !tenantRow) throw new RequestError(404, "Case not found.", "case_not_found");
    const tenant = Array.isArray(tenantRow.tenants) ? tenantRow.tenants[0] : tenantRow.tenants;
    const production = tenant?.environment === "production" && tenant?.fictional === false;
    if (production) {
      if (!grant.entitlementId) throw new RequestError(403, "Case entitlement required.", "entitlement_required");
      const result = await new ReminderRepository(createAdminPlatform().client).cancel({
        actorUserId: platform.principal.userId,
        caseId,
        entitlementId: grant.entitlementId,
        reminderId,
      });
      return NextResponse.json(
        { ...result, simulated: false },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    await platform.assertSyntheticSandboxCase(caseId);
    const admin = createAdminPlatform().client;
    const { data, error } = await admin.from("reminders").update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      suppression_reason_code: "resident_cancelled",
    }).eq("id", reminderId).eq("case_id", caseId).in("status", ["scheduled", "queued"])
      .select("id,status").maybeSingle();
    if (error) throw error;
    return NextResponse.json({
      reminderId,
      status: data?.status ?? "unchanged",
      cancelled: Boolean(data),
      simulated: true,
      external_delivery: false,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ReminderStoreError) {
      const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 409;
      return NextResponse.json({ error: "That reminder could not be cancelled in its current state.", code: error.code }, {
        status,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    return requestErrorResponse(error);
  }
}

