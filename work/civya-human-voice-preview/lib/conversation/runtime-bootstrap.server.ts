import type { NextRequest } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireCaseEntitlementSession } from "@/lib/entitlement/guard";
import {
  bootstrapEntitledProductionCase,
  bootstrapSession,
  type CivyaPlatform,
} from "@/lib/platform";
import { RequestError } from "@/lib/security/request";

/**
 * Select the only bootstrap path allowed by the runtime. A non-synthetic
 * request can replay an exact entitled case, but can never fall back to the
 * sandbox RPC that creates a resident or case.
 */
export async function bootstrapAuthorizedResidentCase(
  request: NextRequest,
  platform: CivyaPlatform,
  channel: "voice" | "text" = "voice",
) {
  const config = getRuntimeConfig();
  if (config.syntheticMode) return bootstrapSession(platform, undefined, channel);

  const grant = await requireCaseEntitlementSession(request, platform);
  if (grant.accessType !== "case_entitlement" || !grant.entitlementId) {
    throw new RequestError(
      403,
      "Verify Wayne County case access before continuing.",
      "entitlement_required",
    );
  }
  return bootstrapEntitledProductionCase(
    platform,
    grant.caseId,
    grant.entitlementId,
    channel,
  );
}
