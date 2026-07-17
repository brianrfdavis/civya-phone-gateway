import { NextRequest, NextResponse } from "next/server";
import { loadPublicStaffWorkspace, resolveStaffTenantSlug } from "@/lib/staff/access";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Host-bound presentation metadata only. No account or role information. */
export async function GET(request: NextRequest) {
  try {
    const tenantSlug = resolveStaffTenantSlug(request.headers.get("host"));
    const workspace = await loadPublicStaffWorkspace(tenantSlug);
    return NextResponse.json(
      { workspace },
      { headers: { "Cache-Control": "public, max-age=60", "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
