import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPaymentCredentials,
  LiveJpmChaseHostedAdapter,
  type ContractedJpmChaseCheckoutClient,
} from "../lib/integrations/payments";
import {
  consumeProductionPaymentLaunch,
  consumeProductionPaymentReturn,
  createProductionPaymentHandoff,
  PaymentActivationError,
  readPaymentActivationConfig,
  readPaymentLink,
  verifyAndReconcilePaymentWebhook,
  type AuthoritativePaymentObligationSource,
  type ContractedPaymentWebhookVerifier,
  type HostedHandoffRow,
  type PaymentActivationConfig,
  type PaymentHandoffStore,
  type RecordedProviderEvent,
  type VerifiedPaymentEvidence,
} from "../lib/integrations/payment-handoff.server";
import { reachLivePaymentProviderBoundary } from "../lib/integrations/payment-tenant-boundary.server";
import { readRuntimeConfig } from "../lib/config/runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const HANDOFF_ID = "44444444-4444-4444-8444-444444444444";
const LINK_ID_1 = "55555555-5555-4555-8555-555555555551";
const LINK_ID_2 = "55555555-5555-4555-8555-555555555552";
const PROVIDER_EVENT_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const NOW = Date.parse("2026-07-16T16:00:00.000Z");
const PROVIDER_REFERENCE = "jpm_session_opaque_000001";

const config: PaymentActivationConfig = {
  mode: "live",
  publicOrigin: "https://civya.example",
  allowedDestinationOrigins: ["https://payments.chase.example"],
  contractVersion: "wayne-jpm-v1",
  clientId: "client_approved",
  clientSecret: "client-secret-at-least-24-bytes",
  webhookSecret: "webhook-secret-at-least-24-bytes",
  linkSecret: "payment-link-secret-at-least-thirty-two-bytes",
};

const expectation = {
  obligationReference: "opaque_obligation_0001",
  parcelReference: "opaque_parcel_0001",
  taxYear: 2025,
  currency: "USD" as const,
  expectedAmountMinor: 12500,
  expectedRecordCount: 1,
  expectedControlTotalMinor: 12500,
};

class FakeObligationSource implements AuthoritativePaymentObligationSource {
  calls: Array<{ tenantId: string; caseId: string; actorUserId: string | null }> = [];

  async resolveCaseObligation(input: { tenantId: string; caseId: string; actorUserId: string | null }) {
    this.calls.push(input);
    return {
      authority: "authoritative" as const,
      source: "wayne_county" as const,
      sourceRevision: "wayne-obligation-revision-7",
      tenantId: input.tenantId,
      caseId: input.caseId,
      expectation,
    };
  }
}

class FakeStore implements PaymentHandoffStore {
  order: string[] = [];
  createInput: Parameters<PaymentHandoffStore["createHostedHandoff"]>[0] | null = null;
  links = new Map<string, {
    id: string;
    tenantId: string;
    actorUserId: string;
    handoffSessionId: string;
    consumed: boolean;
  }>();
  events: Array<Parameters<PaymentHandoffStore["recordHandoffEvent"]>[0]> = [];
  providerEvents: Array<Parameters<PaymentHandoffStore["recordProviderEvent"]>[0]> = [];
  markedProviderEvents: string[] = [];
  row: HostedHandoffRow | null = null;
  operation: {
    operationId: string;
    state: "planned" | "in_flight" | "succeeded" | "failed_unknown" | "failed_terminal";
    externalReference: string | null;
    duplicate: boolean;
    requestSha256: string;
  } | null = null;
  failNextHostedHandoff = false;

  async reserveExternalOperation(input: Parameters<PaymentHandoffStore["reserveExternalOperation"]>[0]) {
    this.order.push("reserve-external-operation");
    if (!this.operation) {
      this.operation = {
        operationId: OPERATION_ID,
        state: "planned",
        externalReference: null,
        duplicate: false,
        requestSha256: input.requestSha256,
      };
    } else {
      assert.equal(input.requestSha256, this.operation.requestSha256);
      this.operation.duplicate = true;
    }
    return { ...this.operation };
  }

  async finishExternalOperation(input: Parameters<PaymentHandoffStore["finishExternalOperation"]>[0]) {
    assert(this.operation);
    this.order.push(`external-operation-${input.state}`);
    this.operation.state = input.state;
    if (input.externalReference) this.operation.externalReference = input.externalReference;
    return { ...this.operation };
  }

  async createHostedHandoff(input: Parameters<PaymentHandoffStore["createHostedHandoff"]>[0]) {
    this.order.push("durable-handoff");
    if (this.failNextHostedHandoff) {
      this.failNextHostedHandoff = false;
      throw new Error("simulated crash after provider response");
    }
    this.createInput = input;
    this.row = {
      handoffSessionId: HANDOFF_ID,
      tenantId: TENANT_ID,
      caseId: CASE_ID,
      providerKey: "jpm_chase",
      providerSessionReferenceDigest: input.providerSessionReferenceDigest,
      destinationOrigin: input.destinationOrigin,
      browserState: "created",
      authoritativeState: "pending",
      rowVersion: 1,
      expiresAt: input.expiresAt,
    };
    return this.row;
  }

  async createSecureLink(input: Parameters<PaymentHandoffStore["createSecureLink"]>[0]) {
    const id = this.links.size === 0 ? LINK_ID_1 : LINK_ID_2;
    this.order.push(input.idempotencyKey.endsWith(":return-link") ? "durable-return-link" : "durable-launch-link");
    this.links.set(input.tokenDigest, {
      id,
      tenantId: input.tenantId,
      actorUserId: input.audienceAuthUserId,
      handoffSessionId: input.handoffSessionId,
      consumed: false,
    });
    return { secureLinkId: id, expiresAt: input.expiresAt };
  }

  async consumeSecureLink(input: Parameters<PaymentHandoffStore["consumeSecureLink"]>[0]) {
    const link = this.links.get(input.tokenDigest);
    if (!link || link.tenantId !== input.tenantId || link.actorUserId !== input.actorUserId || link.consumed) {
      return { consumed: false, reason: link?.consumed ? "already_consumed" : "invalid" };
    }
    link.consumed = true;
    return {
      consumed: true,
      secureLinkId: link.id,
      handoffSessionId: link.handoffSessionId,
      caseId: CASE_ID,
    };
  }

  async loadHostedHandoff(handoffSessionId: string) {
    return this.row?.handoffSessionId === handoffSessionId ? { ...this.row } : null;
  }

  async findHostedHandoff(tenantId: string, providerSessionReferenceDigest: string) {
    return this.row?.tenantId === tenantId && this.row.providerSessionReferenceDigest === providerSessionReferenceDigest
      ? { ...this.row }
      : null;
  }

  async recordHandoffEvent(input: Parameters<PaymentHandoffStore["recordHandoffEvent"]>[0]) {
    assert(this.row);
    assert.equal(input.expectedRowVersion, this.row.rowVersion);
    this.events.push(input);
    this.row = {
      ...this.row,
      rowVersion: this.row.rowVersion + 1,
      browserState: input.browserState ?? this.row.browserState,
      authoritativeState: input.authoritativeState ?? this.row.authoritativeState,
    };
    return {
      rowVersion: this.row.rowVersion,
      duplicate: false,
      browserState: this.row.browserState,
      authoritativeState: this.row.authoritativeState,
    };
  }

  async recordProviderEvent(input: Parameters<PaymentHandoffStore["recordProviderEvent"]>[0]): Promise<RecordedProviderEvent> {
    this.providerEvents.push(input);
    return { eventId: PROVIDER_EVENT_ID, state: "received", duplicate: false };
  }

  async markProviderEventProcessed(eventId: string) {
    this.markedProviderEvents.push(eventId);
  }
}

let failures = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
console.log("Production hosted-payment handoff contracts");

await check("activation requires every explicit live gate and exact HTTPS origins", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CIVYA_ENABLE_HOSTED_HANDOFF: "true",
    CIVYA_PAYMENT_HANDOFF_MODE: "live",
    CIVYA_SYNTHETIC_MODE: "false",
    CIVYA_PUBLIC_ORIGIN: config.publicOrigin,
    CIVYA_HANDOFF_ALLOWED_ORIGINS: config.allowedDestinationOrigins.join(","),
    CIVYA_PAYMENT_LINK_SECRET: config.linkSecret,
    JPM_CHECKOUT_CLIENT_ID: config.clientId,
    JPM_CHECKOUT_CLIENT_SECRET: config.clientSecret,
    JPM_CHECKOUT_CONTRACT_VERSION: config.contractVersion,
    JPM_CHECKOUT_WEBHOOK_SECRET: config.webhookSecret,
  };
  assert.deepEqual(readPaymentActivationConfig(env), config);
  assert.throws(
    () => readPaymentActivationConfig({ ...env, CIVYA_ENABLE_HOSTED_HANDOFF: "false" }),
    (error: unknown) => error instanceof PaymentActivationError && error.reason === "feature_disabled",
  );
  assert.throws(
    () => readPaymentActivationConfig({ ...env, CIVYA_HANDOFF_ALLOWED_ORIGINS: "https://payments.chase.example/path" }),
    (error: unknown) => error instanceof PaymentActivationError && error.reason === "destination_allowlist_invalid",
  );
  assert.throws(
    () => readPaymentActivationConfig({ ...env, JPM_CHECKOUT_CONTRACT_VERSION: "" }),
    (error: unknown) => error instanceof PaymentActivationError && error.reason === "contract_version_missing",
  );
  const legacyIgnored = readRuntimeConfig({
    ...env,
    CIVYA_ENVIRONMENT: "staging",
    CIVYA_ENABLE_HOSTED_HANDOFF: "false",
    CIVYA_PAYMENT_HANDOFF_MODE: "disabled",
    CIVYA_PROVIDER_MODE: "synthetic",
  });
  assert.equal(legacyIgnored.providers.paymentHandoff, "disabled");
  const explicitSynthetic = readRuntimeConfig({
    ...env,
    CIVYA_ENVIRONMENT: "test",
    CIVYA_ENABLE_HOSTED_HANDOFF: "false",
    CIVYA_SYNTHETIC_MODE: "true",
    CIVYA_PAYMENT_HANDOFF_MODE: "synthetic",
  });
  assert.equal(explicitSynthetic.providers.paymentHandoff, "synthetic");
});

await check("an exact production tenant reaches the provider boundary while missing or fictional fields fail closed", async () => {
  let providerCalls = 0;
  const result = await reachLivePaymentProviderBoundary({
    tenant: { slug: "wayne", environment: "production", fictional: false },
    tenantQueryFailed: false,
    configuredTenantSlug: "wayne",
    providerBoundary: () => {
      providerCalls += 1;
      return "provider-boundary-reached";
    },
  });
  assert.equal(result, "provider-boundary-reached");
  assert.equal(providerCalls, 1);

  const legacyShape = { slug: "wayne", environment: "production", is_fictional: false };
  await assert.rejects(
    reachLivePaymentProviderBoundary({
      tenant: legacyShape,
      tenantQueryFailed: false,
      configuredTenantSlug: "wayne",
      providerBoundary: () => {
        providerCalls += 1;
      },
    }),
    /not authorized/,
  );
  await assert.rejects(
    reachLivePaymentProviderBoundary({
      tenant: { slug: "wayne", environment: "production", fictional: true },
      tenantQueryFailed: false,
      configuredTenantSlug: "wayne",
      providerBoundary: () => {
        providerCalls += 1;
      },
    }),
    /not authorized/,
  );
  await assert.rejects(
    reachLivePaymentProviderBoundary({
      tenant: { slug: "wayne", environment: "production", fictional: false },
      tenantQueryFailed: true,
      configuredTenantSlug: "wayne",
      providerBoundary: () => {
        providerCalls += 1;
      },
    }),
    /not authorized/,
  );
  assert.equal(providerCalls, 1, "A rejected tenant crossed the live provider boundary.");
});

await check("live adapter uses only the injected contract and rejects off-allowlist destinations", async () => {
  let received: Record<string, unknown> | null = null;
  const client: ContractedJpmChaseCheckoutClient = {
    contractVersion: config.contractVersion,
    idempotencySemantics: "provider_enforced",
    async createHostedCheckout(request) {
      received = request;
      return {
        providerSessionReference: PROVIDER_REFERENCE,
        destinationUrl: "https://payments.chase.example/checkout?session=opaque",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      };
    },
  };
  const adapter = new LiveJpmChaseHostedAdapter({
    client,
    contractVersion: config.contractVersion,
    publicOrigin: config.publicOrigin,
    allowedDestinationOrigins: config.allowedDestinationOrigins,
    credentialsConfigured: true,
    now: () => NOW,
  });
  const session = await adapter.createHostedSession({
    ...expectation,
    amountMinor: expectation.expectedAmountMinor,
    idempotencyKey: "payment_handoff_0001",
    returnSupported: true,
    returnUrl: "https://civya.example/api/handoffs/return?token=opaque-return-token",
    clientCorrelationReference: `pay_${"a".repeat(64)}`,
  });
  assert.equal(session.destinationUrl, "https://payments.chase.example/checkout?session=opaque");
  assert.equal(session.capturesPaymentCredentials, false);
  assert(received);
  assertNoPaymentCredentials(received);
  assert.throws(() => assertNoPaymentCredentials({ password: "not-allowed", security_code: "not-allowed" }), /Prohibited/);
  assert.throws(() => assertNoPaymentCredentials({ value: "4111 1111 1111 1111" }), /Prohibited/);

  const evilClient: ContractedJpmChaseCheckoutClient = {
    ...client,
    async createHostedCheckout() {
      return {
        providerSessionReference: PROVIDER_REFERENCE,
        destinationUrl: "https://lookalike.example/checkout",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      };
    },
  };
  const evilAdapter = new LiveJpmChaseHostedAdapter({
    client: evilClient,
    contractVersion: config.contractVersion,
    publicOrigin: config.publicOrigin,
    allowedDestinationOrigins: config.allowedDestinationOrigins,
    credentialsConfigured: true,
    now: () => NOW,
  });
  await assert.rejects(() => evilAdapter.createHostedSession({
    ...expectation,
    amountMinor: expectation.expectedAmountMinor,
    idempotencyKey: "payment_handoff_0002",
    returnSupported: true,
    returnUrl: "https://civya.example/api/handoffs/return?token=opaque-return-token",
    clientCorrelationReference: `pay_${"b".repeat(64)}`,
  }), /allowlist/);
});

await check("durable handoff and one-time links exist before launch; browser return stays advisory", async () => {
  const store = new FakeStore();
  const source = new FakeObligationSource();
  let providerReturnUrl = "";
  const provider = {
    provider: "jpm_chase" as const,
    idempotencySemantics: "provider_enforced" as const,
    async createHostedSession(request: Parameters<LiveJpmChaseHostedAdapter["createHostedSession"]>[0]) {
      store.order.push("provider-session");
      providerReturnUrl = request.returnUrl ?? "";
      assert.equal(request.amountMinor, expectation.expectedAmountMinor);
      return {
        provider: "jpm_chase" as const,
        providerSessionReference: PROVIDER_REFERENCE,
        destinationUrl: "https://payments.chase.example/checkout?session=opaque",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
        capturesPaymentCredentials: false as const,
        browserReturnAuthority: "advisory" as const,
      };
    },
  };
  const result = await createProductionPaymentHandoff({
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    actorUserId: ACTOR_ID,
    idempotencyKey: "payment_handoff_0003",
  }, { config, provider, obligationSource: source, store, now: () => NOW });
  assert.deepEqual(store.order, [
    "reserve-external-operation",
    "external-operation-in_flight",
    "provider-session",
    "external-operation-succeeded",
    "durable-handoff",
    "durable-return-link",
    "durable-launch-link",
  ]);
  assert.equal(new URL(result.launchUrl).origin, config.publicOrigin);
  assert.equal(result.capturesPaymentCredentials, false);
  assert.equal(result.browserReturnAuthority, "advisory");
  assert(store.createInput);
  assert.equal(JSON.stringify(store.createInput).includes(PROVIDER_REFERENCE), false);
  assert.match(store.createInput.providerSessionReferenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(store.links.size, 2);

  const launchToken = new URL(result.launchUrl).searchParams.get("token") ?? "";
  const launchClaims = readPaymentLink(launchToken, config, "launch", NOW);
  assert.equal(launchClaims.handoffSessionId, HANDOFF_ID);
  const destination = await consumeProductionPaymentLaunch(
    { token: launchToken, actorUserId: ACTOR_ID },
    { config, store, now: () => NOW },
  );
  assert.equal(destination, "https://payments.chase.example/checkout?session=opaque");
  assert.equal(store.events[0].authoritativeState, "pending");
  await assert.rejects(() => consumeProductionPaymentLaunch(
    { token: launchToken, actorUserId: ACTOR_ID },
    { config, store, now: () => NOW },
  ), /already used/);

  const returnToken = new URL(providerReturnUrl).searchParams.get("token") ?? "";
  const returned = await consumeProductionPaymentReturn(
    { token: returnToken, actorUserId: ACTOR_ID },
    { config, store, now: () => NOW },
  );
  assert.equal(returned.authority, "advisory");
  assert.equal(returned.maySetCompletion, false);
  assert.equal(store.events[1].sourceType, "browser");
  assert.equal(store.events[1].authoritativeState, "pending");
  assert.equal(store.row?.authoritativeState, "pending");
});

await check("crash after provider response resumes through the durable idempotent operation", async () => {
  const store = new FakeStore();
  store.failNextHostedHandoff = true;
  const source = new FakeObligationSource();
  const returnedSessions: string[] = [];
  const returnUrls: string[] = [];
  const provider = {
    provider: "jpm_chase" as const,
    idempotencySemantics: "provider_enforced" as const,
    async createHostedSession(request: Parameters<LiveJpmChaseHostedAdapter["createHostedSession"]>[0]) {
      returnedSessions.push(PROVIDER_REFERENCE);
      returnUrls.push(request.returnUrl ?? "");
      return {
        provider: "jpm_chase" as const,
        providerSessionReference: PROVIDER_REFERENCE,
        destinationUrl: "https://payments.chase.example/checkout?session=opaque",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
        capturesPaymentCredentials: false as const,
        browserReturnAuthority: "advisory" as const,
      };
    },
  };
  const input = {
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    actorUserId: ACTOR_ID,
    idempotencyKey: "payment_handoff_crash_0001",
  };
  const dependencies = { config, provider, obligationSource: source, store, now: () => NOW };
  await assert.rejects(() => createProductionPaymentHandoff(input, dependencies), /simulated crash/);
  assert.equal(store.operation?.state, "succeeded");
  assert.equal(store.row, null);
  const retried = await createProductionPaymentHandoff(input, dependencies);
  assert.equal(retried.handoffSessionId, HANDOFF_ID);
  assert.equal(returnedSessions.length, 2);
  assert.equal(new Set(returnedSessions).size, 1);
  assert.equal(new Set(returnUrls).size, 1);
  assert.equal(store.operation?.externalReference, createHash("sha256").update(PROVIDER_REFERENCE).digest("hex"));
  assert.equal(store.links.size, 2);
});

await check("only a signed webhook with exact County reconciliation can confirm completion", async () => {
  const store = new FakeStore();
  const source = new FakeObligationSource();
  store.row = {
    handoffSessionId: HANDOFF_ID,
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    providerKey: "jpm_chase",
    providerSessionReferenceDigest: createHash("sha256").update(PROVIDER_REFERENCE).digest("hex"),
    destinationOrigin: "https://payments.chase.example",
    browserState: "returned",
    authoritativeState: "pending",
    rowVersion: 3,
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  };
  const rawBody = JSON.stringify({ opaque_event: "provider-owned-schema" });
  const evidence: VerifiedPaymentEvidence = {
    evidenceSource: "provider_webhook",
    signatureVerified: true,
    authenticatedPoll: false,
    tenantId: TENANT_ID,
    externalEventId: "payevt_000001",
    eventType: "payment_status_changed",
    providerSessionReference: PROVIDER_REFERENCE,
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
    redactedPayload: { statusFamily: "posted" },
    controls: { recordCount: 1, controlTotalMinor: expectation.expectedAmountMinor },
    record: {
      obligationReference: expectation.obligationReference,
      parcelReference: expectation.parcelReference,
      taxYear: expectation.taxYear,
      currency: "USD",
      amountMinor: expectation.expectedAmountMinor,
      source: "jpm_chase",
      authority: "authoritative",
      sourceRevision: "jpm-provider-revision-9",
      providerTransactionReference: "opaque_transaction_0001",
      paymentStatus: "posted",
      planStatus: "active",
    },
  };
  const verifier: ContractedPaymentWebhookVerifier = {
    contractVersion: config.contractVersion,
    async verify() {
      return evidence;
    },
  };
  const result = await verifyAndReconcilePaymentWebhook({
    rawBody,
    headers: new Headers({ "x-provider-signature": "provider-contract-owned" }),
    verifier,
    dependencies: { config, store, obligationSource: source },
  });
  assert.equal(result.decision.verifiedCompletion, true);
  assert.equal(store.row?.authoritativeState, "confirmed");
  assert.equal(store.providerEvents.length, 1);
  assert.equal(store.providerEvents[0].signatureVerified, true);
  assert.deepEqual(store.markedProviderEvents, [PROVIDER_EVENT_ID]);

  const unsignedVerifier: ContractedPaymentWebhookVerifier = {
    contractVersion: config.contractVersion,
    async verify() {
      return { ...evidence, signatureVerified: false };
    },
  };
  await assert.rejects(() => verifyAndReconcilePaymentWebhook({
    rawBody,
    headers: new Headers(),
    verifier: unsignedVerifier,
    dependencies: { config, store, obligationSource: source },
  }), /Unsigned/);
});

await check("route wiring is durable, entitlement-gated, advisory on return, and Stripe-free", () => {
  const files = [
    "lib/integrations/payments.ts",
    "lib/integrations/payment-handoff.server.ts",
    "lib/integrations/payment-tenant-boundary.server.ts",
    "app/api/handoffs/route.ts",
    "app/api/handoffs/launch/route.ts",
    "app/api/handoffs/return/route.ts",
    "app/api/webhooks/payments/route.ts",
  ];
  const source = files.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /\bstripe\b/i);
  assert.match(source, /civya_service_create_hosted_handoff/);
  assert.match(source, /civya_service_create_secure_link/);
  assert.match(source, /civya_service_consume_secure_link/);
  assert.match(source, /requireCaseEntitlement/);
  assert.match(source, /ignored_provider_status_parameters/);
  assert.match(source, /provider_contract_unavailable/);
  assert.match(source, /providers\.paymentHandoff/);
  assert.doesNotMatch(source, /CIVYA_PROVIDER_MODE/);

  for (const file of [
    "app/api/handoffs/route.ts",
    "app/api/handoffs/launch/route.ts",
    "app/api/handoffs/return/route.ts",
  ]) {
    const route = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(route, /requireSyntheticSandboxHost\(request, runtimeConfig\)/);
    assert.match(route, /\.select\("slug,environment,fictional"\)/);
    assert.match(route, /reachLivePaymentProviderBoundary/);
    assert.doesNotMatch(route, /is_fictional/);
  }
  const tenantBoundary = fs.readFileSync(
    path.join(ROOT, "lib/integrations/payment-tenant-boundary.server.ts"),
    "utf8",
  );
  assert.match(tenantBoundary, /input\.tenant\.environment !== "production"/);
  assert.match(tenantBoundary, /input\.tenant\.fictional !== false/);
});

console.log(failures === 0 ? "\nALL PAYMENT HANDOFF CONTRACT TESTS PASSED" : `\n${failures} PAYMENT HANDOFF CONTRACT TESTS FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

void main();
