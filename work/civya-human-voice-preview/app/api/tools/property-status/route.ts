import { NextRequest, NextResponse } from "next/server";
import { findDemoResident } from "@/lib/wayne-county/demoResidents";
import { bootstrapSession } from "@/lib/platform";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

/**
 * Read-only lookup of the versioned fictional property dataset. The address
 * itself is saved only by the authoritative turn transaction, never by this
 * optional model tool.
 */
export async function POST(req: NextRequest) {
  try {
    const platform = await requireVerifiedResident();
    const entitlement = await requireCaseEntitlementSession(req, platform);
    await platform.assertSyntheticSandboxCase(entitlement.caseId);
    const bootstrap = await bootstrapSession(platform);
    await requireCaseEntitlement(req, platform, bootstrap.active_case?.id || "");
    const body = await readJsonObject(req);
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 180) : "";
    if (!address) throw new RequestError(400, "An address is required.");
    const started = performance.now();
    const match = findDemoResident(address);
    if (!match) {
      const spokenText =
        "I don't see a matching fictional demo record. We can still continue without claiming a property match.";
      return NextResponse.json({
        matched: false,
        saved: false,
        lookup_ms: Math.round(performance.now() - started),
        assistant_followup: spokenText,
        spoken_text: spokenText,
        verification_state: "not_found",
        authority: "versioned fictional Wayne County demo dataset",
        source: "civya://wayne-county-demo/property-scenarios",
        retrieved_at: new Date().toISOString(),
        scope: "fictional_property_lookup",
        fictional: true,
      });
    }
    const spokenText = `I found the fictional demo property in ${match.municipality}.`;
    return NextResponse.json({
      matched: true,
      saved: false,
      lookup_ms: Math.round(performance.now() - started),
      property: {
        address: match.address,
        municipality: match.municipality,
        parcel_id: match.parcelId,
        foreclosure_stage: match.foreclosureStage,
        delinquent_years: match.delinquentYears,
        balance_due_demo: match.balanceDueDemo,
      },
      assistant_followup: spokenText,
      spoken_text: spokenText,
      verification_state: "verified",
      authority: "versioned fictional Wayne County demo dataset",
      source: "civya://wayne-county-demo/property-scenarios",
      retrieved_at: new Date().toISOString(),
      scope: "fictional_property_lookup",
      fictional: true,
    });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
