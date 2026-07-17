import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { classifyBrowserReturn } from "@/lib/integrations/payments";
import {
  consumeProductionPaymentReturn,
  PaymentActivationError,
  readPaymentActivationConfig,
  readPaymentLink,
  SupabasePaymentHandoffStore,
} from "@/lib/integrations/payment-handoff.server";
import { reachLivePaymentProviderBoundary } from "@/lib/integrations/payment-tenant-boundary.server";
import { requireVerifiedResident } from "@/lib/security/guards";
import { requestErrorResponse, RequestError } from "@/lib/security/request";
import { requireSyntheticSandboxHost } from "@/lib/security/synthetic-sandbox";
import { getSyntheticSecureLinkService } from "@/lib/secure-links/runtime";
import { resolveTenantSlug } from "@/lib/tenancy/resolve-tenant";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const runtimeConfig = getRuntimeConfig();
  const paymentMode = runtimeConfig.providers.paymentHandoff;
  if (paymentMode === "live") return returnFromLiveHandoff(request);
  if (paymentMode === "disabled") {
    return NextResponse.json(
      { error: "The official payment handoff is not enabled.", code: "payment_handoff_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
  }
  try {
    requireSyntheticSandboxHost(request, runtimeConfig);
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const sessionBinding = request.headers.get("x-civya-session-binding") ?? "";
    const claims = getSyntheticSecureLinkService().consume({
      token,
      expectedPurpose: "browser_return",
      sessionBinding,
    });
    const evidence = classifyBrowserReturn(claims.handoffId, new Date().toISOString());
    return NextResponse.json(
      { ...evidence, ignored_provider_status_parameters: true },
      { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The return state is invalid." },
      { status: 400, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
  }
}

async function returnFromLiveHandoff(request: NextRequest): Promise<NextResponse> {
  try {
    const config = readPaymentActivationConfig();
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const platform = await requireVerifiedResident();
    const claims = readPaymentLink(token, config, "return");
    if (claims.actorUserId !== platform.principal.userId) {
      throw new RequestError(403, "This payment return belongs to a different account.", "forbidden");
    }
    await requireCaseEntitlement(request, platform, claims.caseId);
    const configuredTenantSlug = resolveTenantSlug(request.headers.get("host"), getRuntimeConfig());
    const { data: tenant, error: tenantError } = await platform.client
      .from("tenants")
      .select("slug,environment,fictional")
      .eq("id", claims.tenantId)
      .single();
    const evidence = await reachLivePaymentProviderBoundary({
      tenant,
      tenantQueryFailed: Boolean(tenantError),
      configuredTenantSlug,
      providerBoundary: () => consumeProductionPaymentReturn(
        { token, actorUserId: platform.principal.userId },
        { config, store: new SupabasePaymentHandoffStore() },
      ),
    });
    return NextResponse.json(
      {
        ...evidence,
        ignored_provider_status_parameters: true,
        next_step: "Civya will confirm status only from signed provider or authenticated County reconciliation evidence.",
      },
      { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    if (error instanceof PaymentActivationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, activation_blocker: error.reason },
        { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
      );
    }
    return requestErrorResponse(error);
  }
}
