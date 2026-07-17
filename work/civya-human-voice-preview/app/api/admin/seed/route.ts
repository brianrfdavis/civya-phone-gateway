import { NextRequest, NextResponse } from "next/server";
import { resetTenantSandbox } from "@/lib/platform";
import { requireStaff } from "@/lib/security/guards";
import { RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

/** Admin-only, fictional-tenant-only reset. Versioned scenarios are preserved. */
export async function POST(request: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("admin", request.headers.get("host"));
    if (!staff.tenant.fictional || staff.tenant.environment !== "sandbox") {
      throw new RequestError(403, "Demo scenario reset is disabled outside the fictional sandbox.", "forbidden");
    }
    const result = await resetTenantSandbox(platform, staff.tenant.slug);
    return NextResponse.json({ ok: true, ...result, fictional_scenarios_preserved: true });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
