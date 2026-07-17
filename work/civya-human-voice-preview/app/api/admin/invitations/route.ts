import { NextRequest, NextResponse } from "next/server";
import { createDemoInvitation } from "@/lib/platform";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_EXPIRY_MINUTES = 15;
const MAX_EXPIRY_MINUTES = 8 * 60;
const MAX_INVITATION_USES = 25;
const RESIDENT_SCOPE = "resident_demo";

export async function POST(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("admin", req.headers.get("host"));
    if (!staff.tenant.fictional || staff.tenant.environment !== "sandbox") {
      throw new RequestError(403, "Resident demo invitations are disabled outside the fictional sandbox.", "forbidden");
    }
    const body = await readJsonObject(req, 4_000);

    if ("tenant_id" in body || "tenantId" in body) {
      throw new RequestError(400, "The invitation tenant is determined by the signed-in county administrator.");
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label.length < 3 || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw new RequestError(400, "Enter a label between 3 and 80 characters.");
    }

    const expiresInMinutes = body.expires_in_minutes;
    if (
      typeof expiresInMinutes !== "number"
      || !Number.isInteger(expiresInMinutes)
      || expiresInMinutes < MIN_EXPIRY_MINUTES
      || expiresInMinutes > MAX_EXPIRY_MINUTES
    ) {
      throw new RequestError(400, "Invitation expiry must be between 15 minutes and 8 hours.");
    }

    const maxUses = body.max_uses;
    if (
      typeof maxUses !== "number"
      || !Number.isInteger(maxUses)
      || maxUses < 1
      || maxUses > MAX_INVITATION_USES
    ) {
      throw new RequestError(400, "Invitation uses must be between 1 and 25.");
    }

    const scopes = body.scopes;
    if (
      !Array.isArray(scopes)
      || scopes.length !== 1
      || scopes[0] !== RESIDENT_SCOPE
    ) {
      throw new RequestError(400, "Only resident-demo invitation access can be created here.");
    }

    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
    const invitation = await createDemoInvitation(platform, {
      tenantId: staff.tenant.id,
      label,
      expiresAt,
      maxUses,
      scopes: [RESIDENT_SCOPE],
    });

    return NextResponse.json(
      {
        ok: true,
        invite_path: `/invite/${encodeURIComponent(invitation.token)}`,
        expires_at: expiresAt,
        max_uses: maxUses,
        scopes: [RESIDENT_SCOPE],
        fictional: true,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
