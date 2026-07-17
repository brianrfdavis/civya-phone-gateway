import { NextRequest, NextResponse } from "next/server";
import { createAdminPlatform } from "@/lib/platform";
import { requireStaff } from "@/lib/security/guards";
import { RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

/** Marks due fictional reminders as simulated sends; no external message is delivered. */
export async function POST(request: NextRequest) {
  try {
    const { staff } = await requireStaff("admin", request.headers.get("host"));
    if (!staff.tenant.fictional || staff.tenant.environment !== "sandbox") {
      throw new RequestError(403, "Simulated reminder delivery is disabled outside the fictional sandbox.", "forbidden");
    }
    const admin = createAdminPlatform().client;
    const { data: due, error: dueError } = await admin.from("reminders")
      .select("id")
      .eq("tenant_id", staff.tenant.id)
      .eq("status", "scheduled")
      .lte("scheduled_for", new Date().toISOString())
      .limit(100);
    if (dueError) throw dueError;
    const ids = (due || []).map((item) => item.id);
    if (ids.length) {
      const { error } = await admin.from("reminders").update({
        status: "sent",
        provider_reference: "DEMO-NO-DELIVERY",
      }).in("id", ids).eq("tenant_id", staff.tenant.id);
      if (error) throw error;
    }
    return NextResponse.json({ sent: ids.length, fictional: true, external_delivery: false });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
