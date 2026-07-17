import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/profiles/dataset";
import { documentChecklist } from "@/lib/eligibility/rules";
import { bootstrapSession } from "@/lib/platform";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
  const platform = await requireVerifiedResident();
  const entitlement = await requireCaseEntitlementSession(req, platform);
  await platform.assertSyntheticSandboxCase(entitlement.caseId);
  const bootstrap = await bootstrapSession(platform);
  await requireCaseEntitlement(req, platform, bootstrap.active_case?.id || "");
  const body = await req.json();
  const profile = getProfile(body.profile_id ?? "");
  if (!profile) {
    return NextResponse.json(
      { error: "The requested profile is unavailable." },
      { status: 404 },
    );
  }
  const checklist = documentChecklist(profile);

  return NextResponse.json(checklist);
  } catch (error) { return requestErrorResponse(error); }
}
