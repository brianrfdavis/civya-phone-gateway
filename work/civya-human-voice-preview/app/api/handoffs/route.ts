import { NextRequest, NextResponse } from "next/server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { assertNoPaymentCredentials, SyntheticJpmChaseHostedAdapter } from "@/lib/integrations/payments";
import {
  PaymentActivationError,
  readPaymentActivationConfig,
  unavailableProductionPaymentDependencies,
} from "@/lib/integrations/payment-handoff.server";
import { reachLivePaymentProviderBoundary } from "@/lib/integrations/payment-tenant-boundary.server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireVerifiedResident } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import { requireSyntheticSandboxHost } from "@/lib/security/synthetic-sandbox";
import { getSyntheticSecureLinkService } from "@/lib/secure-links/runtime";
import { resolveTenantSlug } from "@/lib/tenancy/resolve-tenant";

export const runtime = "nodejs";

const ALLOWED_KEYS = new Set([
  "amount_minor",
  "handoff_id",
  "idempotency_key",
  "obligation_reference",
  "parcel_reference",
  "return_supported",
  "tax_year",
]);

const LIVE_ALLOWED_KEYS = new Set(["case_id", "idempotency_key", "workflow_instance_id"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const runtimeConfig = getRuntimeConfig();
  const paymentMode = runtimeConfig.providers.paymentHandoff;
  if (paymentMode === "live") return createLiveHandoff(request);
  if (paymentMode === "disabled") {
    return NextResponse.json(
      { error: "The official payment handoff is not enabled.", code: "payment_handoff_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
  }
  try {
    requireSyntheticSandboxHost(request, runtimeConfig);
    const sessionBinding = request.headers.get("x-civya-session-binding") ?? "";
    if (sessionBinding.length < 16) throw new Error("A server-derived session binding is required.");
    const body = await request.json() as Record<string, unknown>;
    for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) throw new Error(`Unsupported handoff field: ${key}.`);
    assertNoPaymentCredentials(body);
    const handoffId = String(body.handoff_id ?? "");
    const adapter = new SyntheticJpmChaseHostedAdapter({
      destinationOrigin: process.env.CIVYA_SYNTHETIC_PAYMENT_ORIGIN,
    });
    const providerSession = await adapter.createHostedSession({
      obligationReference: String(body.obligation_reference ?? ""),
      parcelReference: String(body.parcel_reference ?? ""),
      taxYear: Number(body.tax_year),
      idempotencyKey: String(body.idempotency_key ?? ""),
      currency: "USD",
      amountMinor: Number(body.amount_minor),
      returnSupported: body.return_supported === true,
    });
    const links = getSyntheticSecureLinkService();
    const launch = links.issue({
      purpose: "external_handoff",
      handoffId,
      provider: "jpm_chase",
      sessionBinding,
      destination: providerSession.destinationUrl,
      ttlSeconds: 300,
    });
    const browserReturn = body.return_supported === true
      ? links.issue({
          purpose: "browser_return",
          handoffId,
          provider: "jpm_chase",
          sessionBinding,
          ttlSeconds: 600,
        })
      : null;
    return NextResponse.json(
      {
        provider: "jpm_chase",
        launch_url: launch.url,
        expires_at: launch.expiresAt,
        browser_return_url: browserReturn?.url ?? null,
        browser_return_authority: "advisory",
        captures_payment_credentials: false,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The synthetic handoff could not be created." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

async function createLiveHandoff(request: NextRequest): Promise<NextResponse> {
  try {
    // These gates are evaluated before any case or provider work. Merely
    // setting a URL or a feature flag can never activate payments.
    readPaymentActivationConfig();
    const platform = await requireVerifiedResident();
    const body = await readJsonObject(request, 4_000);
    for (const key of Object.keys(body)) {
      if (!LIVE_ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported payment handoff field: ${key}.`);
    }
    assertNoPaymentCredentials(body);
    const caseId = typeof body.case_id === "string" ? body.case_id : "";
    const workflowInstanceId = typeof body.workflow_instance_id === "string" ? body.workflow_instance_id : undefined;
    const idempotencyKey = typeof body.idempotency_key === "string"
      ? body.idempotency_key
      : request.headers.get("idempotency-key") ?? "";
    if (!UUID.test(caseId)) throw new RequestError(400, "Choose a valid County case.");
    if (workflowInstanceId && !UUID.test(workflowInstanceId)) throw new RequestError(400, "Choose a valid payment workflow.");
    if (!/^[A-Za-z0-9_.:-]{8,180}$/.test(idempotencyKey)) {
      throw new RequestError(400, "A valid idempotency key is required.");
    }
    await requireCaseEntitlement(request, platform, caseId);
    const snapshot = await platform.loadCaseSnapshot(caseId);
    const configuredTenantSlug = resolveTenantSlug(request.headers.get("host"), getRuntimeConfig());
    const { data: tenant, error: tenantError } = await platform.client
      .from("tenants")
      .select("slug,environment,fictional")
      .eq("id", snapshot.tenantId)
      .single();
    // Wayne County/J.P. Morgan have not supplied an approved wire contract or
    // obligation source. The typed adapter/orchestrator is ready, but the live
    // route intentionally remains fail-closed rather than inventing fields.
    return await reachLivePaymentProviderBoundary({
      tenant,
      tenantQueryFailed: Boolean(tenantError),
      configuredTenantSlug,
      providerBoundary: () => {
        void workflowInstanceId;
        void idempotencyKey;
        unavailableProductionPaymentDependencies();
      },
    });
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
