import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  assertNoPaymentCredentials,
  classifyBrowserReturn,
  reconcileAuthoritativePayment,
  type AuthoritativePaymentRecord,
  type BrowserReturnEvidence,
  type ContractedJpmChaseCheckoutClient,
  type HostedPaymentProvider,
  type LiveJpmChaseHostedAdapterOptions,
  type PaymentReconciliationDecision,
  type ReconciliationExpectation,
  LiveJpmChaseHostedAdapter,
} from "./payments";

if (typeof window !== "undefined") {
  throw new Error("The production payment-handoff boundary is server-only.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,180}$/;
const LINK_PREFIX = "ph1";
const LINK_AAD = Buffer.from("civya-payment-handoff-v1", "utf8");
const PROVIDER_KEY = "jpm_chase";
const LINK_PURPOSE = "hosted_handoff";
const MAX_LINK_MS = 15 * 60_000;

export type PaymentActivationFailure =
  | "feature_disabled"
  | "provider_mode_not_live"
  | "synthetic_runtime"
  | "public_origin_invalid"
  | "destination_allowlist_invalid"
  | "credentials_missing"
  | "contract_version_missing"
  | "webhook_secret_missing"
  | "link_secret_missing"
  | "provider_contract_unavailable"
  | "county_obligation_source_unavailable";

export class PaymentActivationError extends Error {
  readonly code = "payment_handoff_unavailable";

  constructor(readonly reason: PaymentActivationFailure) {
    super("The official payment handoff is not available yet. No payment information was collected.");
    this.name = "PaymentActivationError";
  }
}

export interface PaymentActivationConfig {
  mode: "live";
  publicOrigin: string;
  allowedDestinationOrigins: readonly string[];
  contractVersion: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  linkSecret: string;
}

export interface AuthoritativeCaseObligation {
  authority: "authoritative";
  source: "wayne_county";
  sourceRevision: string;
  tenantId: string;
  caseId: string;
  expectation: ReconciliationExpectation;
}

export interface AuthoritativePaymentObligationSource {
  resolveCaseObligation(input: {
    tenantId: string;
    caseId: string;
    actorUserId: string | null;
  }): Promise<AuthoritativeCaseObligation>;
}

export interface HostedHandoffRow {
  handoffSessionId: string;
  tenantId: string;
  caseId: string;
  providerKey: string;
  providerSessionReferenceDigest: string;
  destinationOrigin: string;
  browserState: "created" | "opened" | "returned" | "abandoned" | "expired";
  authoritativeState: "pending" | "confirmed" | "failed";
  rowVersion: number;
  expiresAt: string;
}

export interface ConsumedPaymentLink {
  consumed: boolean;
  reason?: string;
  secureLinkId?: string;
  handoffSessionId?: string | null;
  caseId?: string | null;
}

export interface RecordedProviderEvent {
  eventId: string;
  state: string;
  duplicate: boolean;
}

export interface ExternalPaymentOperation {
  operationId: string;
  state: "planned" | "in_flight" | "succeeded" | "failed_unknown" | "failed_terminal";
  externalReference: string | null;
  duplicate: boolean;
}

export interface PaymentHandoffStore {
  reserveExternalOperation(input: {
    tenantId: string;
    idempotencyKey: string;
    requestSha256: string;
    requestMetadata: Record<string, unknown>;
  }): Promise<ExternalPaymentOperation>;
  finishExternalOperation(input: {
    operationId: string;
    state: "in_flight" | "succeeded" | "failed_unknown" | "failed_terminal";
    externalReference?: string | null;
    responseMetadata?: Record<string, unknown>;
    errorCode?: string | null;
  }): Promise<ExternalPaymentOperation>;
  createHostedHandoff(input: {
    actorUserId: string;
    caseId: string;
    workflowInstanceId: string | null;
    providerSessionReferenceDigest: string;
    destinationOrigin: string;
    returnNonceDigest: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<HostedHandoffRow>;
  createSecureLink(input: {
    tenantId: string;
    actorUserId: string | null;
    caseId: string;
    handoffSessionId: string;
    tokenDigest: string;
    audienceAuthUserId: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<{ secureLinkId: string; expiresAt: string }>;
  consumeSecureLink(input: {
    tenantId: string;
    tokenDigest: string;
    actorUserId: string;
  }): Promise<ConsumedPaymentLink>;
  loadHostedHandoff(handoffSessionId: string): Promise<HostedHandoffRow | null>;
  findHostedHandoff(tenantId: string, providerSessionReferenceDigest: string): Promise<HostedHandoffRow | null>;
  recordHandoffEvent(input: {
    handoffSessionId: string;
    expectedRowVersion: number;
    sourceType: "browser" | "provider_webhook" | "reconciliation" | "system";
    eventType: string;
    externalEventId: string | null;
    payloadSha256: string;
    redactedPayload: Record<string, unknown>;
    browserState: HostedHandoffRow["browserState"] | null;
    authoritativeState: HostedHandoffRow["authoritativeState"] | null;
  }): Promise<{ rowVersion: number; duplicate: boolean; browserState: string; authoritativeState: string }>;
  recordProviderEvent(input: {
    tenantId: string;
    externalEventId: string;
    eventType: string;
    payloadSha256: string;
    redactedPayload: Record<string, unknown>;
    signatureVerified: boolean;
  }): Promise<RecordedProviderEvent>;
  markProviderEventProcessed(eventId: string): Promise<void>;
}

export interface PaymentLinkClaims {
  kind: "launch" | "return";
  tenantId: string;
  caseId: string;
  actorUserId: string;
  expiresAt: number;
  idempotencyKey: string;
  handoffSessionId?: string;
  providerSessionReference?: string;
  destinationUrl?: string;
}

export interface ProductionPaymentHandoffDependencies {
  config: PaymentActivationConfig;
  provider: HostedPaymentProvider;
  obligationSource: AuthoritativePaymentObligationSource;
  store: PaymentHandoffStore;
  now?: () => number;
}

export interface VerifiedPaymentEvidence {
  evidenceSource: "provider_webhook" | "reconciliation";
  signatureVerified: boolean;
  authenticatedPoll: boolean;
  tenantId: string;
  externalEventId: string;
  eventType: string;
  providerSessionReference: string;
  payloadSha256: string;
  redactedPayload: Record<string, unknown>;
  record: AuthoritativePaymentRecord;
  controls?: { recordCount: number; controlTotalMinor: number };
}

export interface ContractedPaymentWebhookVerifier {
  readonly contractVersion: string;
  verify(input: { rawBody: string; headers: Headers }): Promise<VerifiedPaymentEvidence>;
}

export interface ContractedPaymentStatusPoller {
  readonly contractVersion: string;
  poll(input: { providerSessionReference: string; tenantId: string }): Promise<VerifiedPaymentEvidence>;
}

export function readPaymentActivationConfig(env: NodeJS.ProcessEnv = process.env): PaymentActivationConfig {
  if (env.CIVYA_ENABLE_HOSTED_HANDOFF !== "true") throw new PaymentActivationError("feature_disabled");
  if (env.CIVYA_PAYMENT_HANDOFF_MODE !== "live") throw new PaymentActivationError("provider_mode_not_live");
  if (env.CIVYA_SYNTHETIC_MODE === "true") {
    throw new PaymentActivationError("synthetic_runtime");
  }
  const publicOrigin = parseExactHttpsOrigin(env.CIVYA_PUBLIC_ORIGIN, "public_origin_invalid");
  const allowedDestinationOrigins = (env.CIVYA_HANDOFF_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseExactHttpsOrigin(origin, "destination_allowlist_invalid"));
  if (allowedDestinationOrigins.length === 0 || new Set(allowedDestinationOrigins).size !== allowedDestinationOrigins.length) {
    throw new PaymentActivationError("destination_allowlist_invalid");
  }
  const clientId = requiredSecret(env.JPM_CHECKOUT_CLIENT_ID, 8, "credentials_missing");
  const clientSecret = requiredSecret(env.JPM_CHECKOUT_CLIENT_SECRET, 24, "credentials_missing");
  const contractVersion = requiredSecret(env.JPM_CHECKOUT_CONTRACT_VERSION, 3, "contract_version_missing");
  const webhookSecret = requiredSecret(env.JPM_CHECKOUT_WEBHOOK_SECRET, 24, "webhook_secret_missing");
  const linkSecret = requiredSecret(env.CIVYA_PAYMENT_LINK_SECRET, 32, "link_secret_missing");
  return Object.freeze({
    mode: "live",
    publicOrigin,
    allowedDestinationOrigins: Object.freeze(allowedDestinationOrigins),
    contractVersion,
    clientId,
    clientSecret,
    webhookSecret,
    linkSecret,
  });
}

export function createLiveJpmChaseHostedAdapter(
  config: PaymentActivationConfig,
  client: ContractedJpmChaseCheckoutClient,
  options: Pick<LiveJpmChaseHostedAdapterOptions, "now"> = {},
): LiveJpmChaseHostedAdapter {
  return new LiveJpmChaseHostedAdapter({
    client,
    contractVersion: config.contractVersion,
    publicOrigin: config.publicOrigin,
    allowedDestinationOrigins: config.allowedDestinationOrigins,
    credentialsConfigured: Boolean(config.clientId && config.clientSecret),
    now: options.now,
  });
}

/**
 * Deliberately fails until the County/J.P. Morgan contract client and the
 * County-owned obligation source are implemented and release-approved.
 */
export function unavailableProductionPaymentDependencies(
  env: NodeJS.ProcessEnv = process.env,
): never {
  readPaymentActivationConfig(env);
  throw new PaymentActivationError("provider_contract_unavailable");
}

export async function createProductionPaymentHandoff(input: {
  tenantId: string;
  caseId: string;
  actorUserId: string;
  workflowInstanceId?: string | null;
  idempotencyKey: string;
}, dependencies: ProductionPaymentHandoffDependencies): Promise<{
  provider: "jpm_chase";
  handoffSessionId: string;
  launchUrl: string;
  expiresAt: string;
  browserReturnAuthority: "advisory";
  capturesPaymentCredentials: false;
}> {
  const now = dependencies.now?.() ?? Date.now();
  requireUuid(input.tenantId, "tenant");
  requireUuid(input.caseId, "case");
  requireUuid(input.actorUserId, "actor");
  if (input.workflowInstanceId) requireUuid(input.workflowInstanceId, "workflow instance");
  if (!SAFE_IDEMPOTENCY.test(input.idempotencyKey)) throw new Error("A safe handoff idempotency key is required.");

  const obligation = await dependencies.obligationSource.resolveCaseObligation({
    tenantId: input.tenantId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
  });
  assertAuthoritativeObligation(obligation, input.tenantId, input.caseId);
  if (dependencies.provider.idempotencySemantics !== "provider_enforced") {
    throw new Error("The live provider contract must guarantee idempotent hosted-session creation.");
  }
  const provisionalExpiresAt = now + MAX_LINK_MS;
  const returnToken = sealPaymentLink({
    kind: "return",
    tenantId: input.tenantId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    expiresAt: provisionalExpiresAt,
    idempotencyKey: input.idempotencyKey,
  }, dependencies.config.linkSecret);
  const returnUrl = localHandoffUrl(dependencies.config.publicOrigin, "/api/handoffs/return", returnToken);
  const correlationReference = `pay_${stableDigest(input.tenantId, input.caseId, input.idempotencyKey)}`;
  const providerRequest = {
    obligationReference: obligation.expectation.obligationReference,
    parcelReference: obligation.expectation.parcelReference,
    taxYear: obligation.expectation.taxYear,
    currency: obligation.expectation.currency,
    amountMinor: obligation.expectation.expectedAmountMinor,
    idempotencyKey: input.idempotencyKey,
    returnSupported: true,
    returnUrl,
    clientCorrelationReference: correlationReference,
  } as const;
  const requestSha256 = stableDigest(
    "jpm_chase.hosted_payment.create.v1",
    input.tenantId,
    input.caseId,
    obligation.sourceRevision,
    obligation.expectation.obligationReference,
    obligation.expectation.parcelReference,
    String(obligation.expectation.taxYear),
    String(obligation.expectation.expectedAmountMinor),
    returnUrl,
  );
  const operation = await dependencies.store.reserveExternalOperation({
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    requestSha256,
    requestMetadata: {
      caseId: input.caseId,
      sourceRevisionDigest: sha256Hex(obligation.sourceRevision),
      returnUrlDigest: sha256Hex(returnUrl),
      contractVersion: dependencies.config.contractVersion,
    },
  });
  if (operation.state === "failed_terminal") throw new Error("The hosted payment operation was terminally rejected.");
  if (operation.state !== "succeeded") {
    await dependencies.store.finishExternalOperation({
      operationId: operation.operationId,
      state: "in_flight",
      responseMetadata: { contractVersion: dependencies.config.contractVersion },
    });
  }
  let providerSession: Awaited<ReturnType<HostedPaymentProvider["createHostedSession"]>>;
  try {
    providerSession = await dependencies.provider.createHostedSession(providerRequest);
  } catch (error) {
    if (operation.state !== "succeeded") {
      await dependencies.store.finishExternalOperation({
        operationId: operation.operationId,
        state: "failed_unknown",
        responseMetadata: { outcome: "provider_result_unknown" },
        errorCode: "provider_result_unknown",
      }).catch(() => undefined);
    }
    throw error;
  }
  let destination: URL;
  let expiresAtMs: number;
  let expiresAt: string;
  let providerSessionReferenceDigest: string;
  try {
    assertNoPaymentCredentials(providerSession);
    if (!/^[A-Za-z0-9_.:-]{8,500}$/.test(providerSession.providerSessionReference)) {
      throw new Error("The hosted payment session reference is invalid.");
    }
    destination = assertAllowedDestination(providerSession.destinationUrl, dependencies.config.allowedDestinationOrigins);
    const providerExpiry = Date.parse(providerSession.expiresAt);
    if (!Number.isFinite(providerExpiry) || providerExpiry <= now) {
      throw new Error("The hosted payment session is already expired.");
    }
    expiresAtMs = Math.min(providerExpiry, provisionalExpiresAt);
    expiresAt = new Date(expiresAtMs).toISOString();
    providerSessionReferenceDigest = sha256Hex(providerSession.providerSessionReference);
  } catch (error) {
    if (operation.state !== "succeeded") {
      await dependencies.store.finishExternalOperation({
        operationId: operation.operationId,
        state: "failed_terminal",
        responseMetadata: { outcome: "provider_response_rejected" },
        errorCode: "provider_response_rejected",
      }).catch(() => undefined);
    }
    throw error;
  }
  if (operation.state === "succeeded") {
    if (operation.externalReference !== providerSessionReferenceDigest) {
      throw new Error("The idempotent provider response does not match the durable external operation.");
    }
  } else {
    await dependencies.store.finishExternalOperation({
      operationId: operation.operationId,
      state: "succeeded",
      externalReference: providerSessionReferenceDigest,
      responseMetadata: {
        destinationOrigin: destination.origin,
        expiresAt,
        contractVersion: dependencies.config.contractVersion,
      },
    });
  }
  const handoff = await dependencies.store.createHostedHandoff({
    actorUserId: input.actorUserId,
    caseId: input.caseId,
    workflowInstanceId: input.workflowInstanceId ?? null,
    providerSessionReferenceDigest,
    destinationOrigin: destination.origin,
    returnNonceDigest: sha256Hex(returnToken),
    expiresAt,
    idempotencyKey: input.idempotencyKey,
  });
  assertHandoffBinding(handoff, {
    tenantId: input.tenantId,
    caseId: input.caseId,
    providerSessionReferenceDigest,
    destinationOrigin: destination.origin,
  });
  const launchToken = sealPaymentLink({
    kind: "launch",
    tenantId: input.tenantId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    expiresAt: expiresAtMs,
    idempotencyKey: input.idempotencyKey,
    handoffSessionId: handoff.handoffSessionId,
    providerSessionReference: providerSession.providerSessionReference,
    destinationUrl: destination.toString(),
  }, dependencies.config.linkSecret);
  await dependencies.store.createSecureLink({
    tenantId: input.tenantId,
    actorUserId: null,
    caseId: input.caseId,
    handoffSessionId: handoff.handoffSessionId,
    tokenDigest: sha256Hex(returnToken),
    audienceAuthUserId: input.actorUserId,
    expiresAt,
    idempotencyKey: `${input.idempotencyKey}:return-link`,
  });
  await dependencies.store.createSecureLink({
    tenantId: input.tenantId,
    actorUserId: null,
    caseId: input.caseId,
    handoffSessionId: handoff.handoffSessionId,
    tokenDigest: sha256Hex(launchToken),
    audienceAuthUserId: input.actorUserId,
    expiresAt,
    idempotencyKey: `${input.idempotencyKey}:launch-link`,
  });
  return {
    provider: "jpm_chase",
    handoffSessionId: handoff.handoffSessionId,
    launchUrl: localHandoffUrl(dependencies.config.publicOrigin, "/api/handoffs/launch", launchToken),
    expiresAt,
    browserReturnAuthority: "advisory",
    capturesPaymentCredentials: false,
  };
}

export function readPaymentLink(
  token: string,
  config: PaymentActivationConfig,
  expectedKind: PaymentLinkClaims["kind"],
  now = Date.now(),
): PaymentLinkClaims {
  const claims = openPaymentLink(token, config.linkSecret);
  if (claims.kind !== expectedKind || claims.expiresAt <= now) throw new Error("The payment handoff link is invalid or expired.");
  return claims;
}

export async function consumeProductionPaymentLaunch(input: {
  token: string;
  actorUserId: string;
}, dependencies: Pick<ProductionPaymentHandoffDependencies, "config" | "store" | "now">): Promise<string> {
  const now = dependencies.now?.() ?? Date.now();
  const claims = readPaymentLink(input.token, dependencies.config, "launch", now);
  assertLinkActor(claims, input.actorUserId);
  if (!claims.handoffSessionId || !claims.destinationUrl || !claims.providerSessionReference) {
    throw new Error("The payment launch link is incomplete.");
  }
  const consumed = await dependencies.store.consumeSecureLink({
    tenantId: claims.tenantId,
    tokenDigest: sha256Hex(input.token),
    actorUserId: input.actorUserId,
  });
  if (!consumed.consumed || consumed.handoffSessionId !== claims.handoffSessionId) {
    throw new Error("The payment launch link is invalid, expired, or already used.");
  }
  const handoff = await dependencies.store.loadHostedHandoff(claims.handoffSessionId);
  if (!handoff) throw new Error("The payment handoff no longer exists.");
  const destination = assertAllowedDestination(claims.destinationUrl, dependencies.config.allowedDestinationOrigins);
  assertHandoffBinding(handoff, {
    tenantId: claims.tenantId,
    caseId: claims.caseId,
    providerSessionReferenceDigest: sha256Hex(claims.providerSessionReference),
    destinationOrigin: destination.origin,
  });
  if (Date.parse(handoff.expiresAt) <= now || handoff.authoritativeState !== "pending") {
    throw new Error("The payment handoff is no longer active.");
  }
  await dependencies.store.recordHandoffEvent({
    handoffSessionId: handoff.handoffSessionId,
    expectedRowVersion: handoff.rowVersion,
    sourceType: "browser",
    eventType: "hosted_payment_opened",
    externalEventId: consumed.secureLinkId ? `secure-link:${consumed.secureLinkId}` : null,
    payloadSha256: stableDigest("hosted_payment_opened", handoff.handoffSessionId),
    redactedPayload: { provider: PROVIDER_KEY, authority: "advisory" },
    browserState: "opened",
    authoritativeState: handoff.authoritativeState,
  });
  return destination.toString();
}

export async function consumeProductionPaymentReturn(input: {
  token: string;
  actorUserId: string;
}, dependencies: Pick<ProductionPaymentHandoffDependencies, "config" | "store" | "now">): Promise<BrowserReturnEvidence> {
  const now = dependencies.now?.() ?? Date.now();
  const claims = readPaymentLink(input.token, dependencies.config, "return", now);
  assertLinkActor(claims, input.actorUserId);
  const consumed = await dependencies.store.consumeSecureLink({
    tenantId: claims.tenantId,
    tokenDigest: sha256Hex(input.token),
    actorUserId: input.actorUserId,
  });
  if (!consumed.consumed || !consumed.handoffSessionId) {
    throw new Error("The payment return link is invalid, expired, or already used.");
  }
  const handoff = await dependencies.store.loadHostedHandoff(consumed.handoffSessionId);
  if (!handoff) throw new Error("The payment handoff no longer exists.");
  assertHandoffBinding(handoff, {
    tenantId: claims.tenantId,
    caseId: claims.caseId,
    providerSessionReferenceDigest: handoff.providerSessionReferenceDigest,
    destinationOrigin: handoff.destinationOrigin,
  });
  await dependencies.store.recordHandoffEvent({
    handoffSessionId: handoff.handoffSessionId,
    expectedRowVersion: handoff.rowVersion,
    sourceType: "browser",
    eventType: "hosted_payment_browser_returned",
    externalEventId: consumed.secureLinkId ? `secure-link:${consumed.secureLinkId}` : null,
    payloadSha256: stableDigest("hosted_payment_browser_returned", handoff.handoffSessionId),
    redactedPayload: { provider: PROVIDER_KEY, authority: "advisory", ignoredProviderParameters: true },
    browserState: "returned",
    authoritativeState: handoff.authoritativeState,
  });
  return classifyBrowserReturn(handoff.handoffSessionId, new Date(now).toISOString());
}

export async function verifyAndReconcilePaymentWebhook(input: {
  rawBody: string;
  headers: Headers;
  verifier: ContractedPaymentWebhookVerifier;
  dependencies: Pick<ProductionPaymentHandoffDependencies, "config" | "store" | "obligationSource">;
}): Promise<{ decision: PaymentReconciliationDecision; duplicate: boolean }> {
  if (input.verifier.contractVersion !== input.dependencies.config.contractVersion) {
    throw new PaymentActivationError("provider_contract_unavailable");
  }
  const evidence = await input.verifier.verify({ rawBody: input.rawBody, headers: input.headers });
  if (evidence.evidenceSource !== "provider_webhook" || !evidence.signatureVerified) {
    throw new Error("Unsigned or unsupported payment evidence was rejected.");
  }
  if (evidence.payloadSha256 !== sha256Hex(input.rawBody)) {
    throw new Error("Payment evidence body digest does not match the signed payload.");
  }
  return reconcileVerifiedPaymentEvidence(evidence, input.dependencies);
}

export async function reconcileVerifiedPaymentEvidence(
  evidence: VerifiedPaymentEvidence,
  dependencies: Pick<ProductionPaymentHandoffDependencies, "store" | "obligationSource">,
): Promise<{ decision: PaymentReconciliationDecision; duplicate: boolean }> {
  assertNoPaymentCredentials(evidence);
  requireUuid(evidence.tenantId, "tenant");
  if (!SAFE_IDEMPOTENCY.test(evidence.externalEventId)) throw new Error("Payment evidence requires a safe external event ID.");
  if (!SHA256.test(evidence.payloadSha256)) throw new Error("Payment evidence requires a SHA-256 payload digest.");
  if (!/^[A-Za-z0-9_.:-]{8,500}$/.test(evidence.providerSessionReference)) {
    throw new Error("Payment evidence requires a safe opaque provider-session reference.");
  }
  const evidenceAllowed = evidence.evidenceSource === "provider_webhook"
    ? evidence.signatureVerified
    : evidence.evidenceSource === "reconciliation" && evidence.authenticatedPoll;
  if (!evidenceAllowed) throw new Error("Payment evidence is not signed or authenticated.");
  const providerSessionReferenceDigest = sha256Hex(evidence.providerSessionReference);
  const handoff = await dependencies.store.findHostedHandoff(evidence.tenantId, providerSessionReferenceDigest);
  if (!handoff) throw new Error("Payment evidence does not match a durable hosted handoff.");

  let providerEvent: RecordedProviderEvent | null = null;
  if (evidence.evidenceSource === "provider_webhook") {
    providerEvent = await dependencies.store.recordProviderEvent({
      tenantId: evidence.tenantId,
      externalEventId: evidence.externalEventId,
      eventType: evidence.eventType,
      payloadSha256: evidence.payloadSha256,
      redactedPayload: evidence.redactedPayload,
      signatureVerified: true,
    });
  }
  const obligation = await dependencies.obligationSource.resolveCaseObligation({
    tenantId: handoff.tenantId,
    caseId: handoff.caseId,
    actorUserId: null,
  });
  assertAuthoritativeObligation(obligation, handoff.tenantId, handoff.caseId);
  const decision = reconcileAuthoritativePayment(obligation.expectation, evidence.record, evidence.controls);
  const terminalFailure = decision.matched && [
    "returned",
    "reversed",
    "refunded",
    "disputed",
    "failed",
  ].includes(decision.paymentStatus);
  const nextAuthoritativeState: HostedHandoffRow["authoritativeState"] = decision.verifiedCompletion
    ? "confirmed"
    : terminalFailure
      ? "failed"
      : handoff.authoritativeState;
  const event = await dependencies.store.recordHandoffEvent({
    handoffSessionId: handoff.handoffSessionId,
    expectedRowVersion: handoff.rowVersion,
    sourceType: evidence.evidenceSource,
    eventType: evidence.eventType,
    externalEventId: evidence.externalEventId,
    payloadSha256: evidence.payloadSha256,
    redactedPayload: {
      provider: PROVIDER_KEY,
      verifiedCompletion: decision.verifiedCompletion,
      paymentStatus: decision.paymentStatus,
      planStatus: decision.planStatus,
      exceptions: decision.exceptions,
      sourceRevisionDigest: sha256Hex(evidence.record.sourceRevision),
    },
    browserState: handoff.browserState,
    authoritativeState: nextAuthoritativeState,
  });
  if (providerEvent && providerEvent.state !== "processed") {
    await dependencies.store.markProviderEventProcessed(providerEvent.eventId);
  }
  return { decision, duplicate: providerEvent?.duplicate ?? event.duplicate };
}

export class SupabasePaymentHandoffStore implements PaymentHandoffStore {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async reserveExternalOperation(input: Parameters<PaymentHandoffStore["reserveExternalOperation"]>[0]): Promise<ExternalPaymentOperation> {
    const { data, error } = await this.supabase.rpc("civya_service_reserve_external_operation", {
      p_tenant_id: input.tenantId,
      p_provider_key: PROVIDER_KEY,
      p_operation_kind: "hosted_payment.create",
      p_idempotency_key: input.idempotencyKey,
      p_request_sha256: input.requestSha256,
      p_request_metadata: input.requestMetadata,
    });
    if (error) throw new Error(`Payment operation reservation failed (${error.code ?? "store_error"}).`);
    return mapExternalOperation(data);
  }

  async finishExternalOperation(input: Parameters<PaymentHandoffStore["finishExternalOperation"]>[0]): Promise<ExternalPaymentOperation> {
    const { data, error } = await this.supabase.rpc("civya_service_finish_external_operation", {
      p_operation_id: input.operationId,
      p_state: input.state,
      p_external_reference: input.externalReference ?? null,
      p_response_metadata: input.responseMetadata ?? {},
      p_error_code: input.errorCode ?? null,
    });
    if (error) throw new Error(`Payment operation update failed (${error.code ?? "store_error"}).`);
    return mapExternalOperation(data);
  }

  async createHostedHandoff(input: Parameters<PaymentHandoffStore["createHostedHandoff"]>[0]): Promise<HostedHandoffRow> {
    const { data, error } = await this.supabase.rpc("civya_service_create_hosted_handoff", {
      p_actor_user_id: input.actorUserId,
      p_case_id: input.caseId,
      p_workflow_instance_id: input.workflowInstanceId,
      p_handoff_type: "payment",
      p_provider_key: PROVIDER_KEY,
      p_provider_session_reference_digest: input.providerSessionReferenceDigest,
      p_destination_origin: input.destinationOrigin,
      p_return_nonce_digest: input.returnNonceDigest,
      p_expires_at: input.expiresAt,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw new Error(`Hosted-handoff persistence failed (${error.code ?? "store_error"}).`);
    const response = objectValue(data);
    const handoffSessionId = stringValue(response.handoffSessionId ?? response.handoff_session_id);
    if (!UUID.test(handoffSessionId)) throw new Error("Hosted-handoff persistence returned an invalid response.");
    const row = await this.loadHostedHandoff(handoffSessionId);
    if (!row) throw new Error("Hosted-handoff persistence did not commit a durable row.");
    return row;
  }

  async createSecureLink(input: Parameters<PaymentHandoffStore["createSecureLink"]>[0]): Promise<{ secureLinkId: string; expiresAt: string }> {
    const { data, error } = await this.supabase.rpc("civya_service_create_secure_link", {
      p_tenant_id: input.tenantId,
      p_actor_user_id: input.actorUserId,
      p_case_id: input.caseId,
      p_channel_session_id: null,
      p_handoff_session_id: input.handoffSessionId,
      p_purpose: LINK_PURPOSE,
      p_token_digest: input.tokenDigest,
      p_audience_auth_user_id: input.audienceAuthUserId,
      p_expires_at: input.expiresAt,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw new Error(`Payment-link persistence failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    const secureLinkId = stringValue(row.secureLinkId ?? row.secure_link_id);
    const expiresAt = stringValue(row.expiresAt ?? row.expires_at);
    if (!UUID.test(secureLinkId) || !expiresAt) throw new Error("Payment-link persistence returned an invalid response.");
    return { secureLinkId, expiresAt };
  }

  async consumeSecureLink(input: Parameters<PaymentHandoffStore["consumeSecureLink"]>[0]): Promise<ConsumedPaymentLink> {
    const { data, error } = await this.supabase.rpc("civya_service_consume_secure_link", {
      p_tenant_id: input.tenantId,
      p_token_digest: input.tokenDigest,
      p_purpose: LINK_PURPOSE,
      p_actor_user_id: input.actorUserId,
    });
    if (error) throw new Error(`Payment-link consumption failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    return {
      consumed: row.consumed === true,
      reason: optionalString(row.reason),
      secureLinkId: optionalString(row.secureLinkId ?? row.secure_link_id),
      handoffSessionId: nullableString(row.handoffSessionId ?? row.handoff_session_id),
      caseId: nullableString(row.caseId ?? row.case_id),
    };
  }

  async loadHostedHandoff(handoffSessionId: string): Promise<HostedHandoffRow | null> {
    const { data, error } = await this.supabase
      .from("hosted_handoff_sessions")
      .select("id,tenant_id,case_id,provider_key,provider_session_reference_digest,destination_origin,browser_state,authoritative_state,row_version,expires_at")
      .eq("id", handoffSessionId)
      .maybeSingle();
    if (error) throw new Error(`Hosted-handoff lookup failed (${error.code ?? "store_error"}).`);
    return data ? mapHandoffRow(data as Record<string, unknown>) : null;
  }

  async findHostedHandoff(tenantId: string, providerSessionReferenceDigest: string): Promise<HostedHandoffRow | null> {
    const { data, error } = await this.supabase
      .from("hosted_handoff_sessions")
      .select("id,tenant_id,case_id,provider_key,provider_session_reference_digest,destination_origin,browser_state,authoritative_state,row_version,expires_at")
      .eq("tenant_id", tenantId)
      .eq("provider_key", PROVIDER_KEY)
      .eq("provider_session_reference_digest", providerSessionReferenceDigest)
      .maybeSingle();
    if (error) throw new Error(`Hosted-handoff reconciliation lookup failed (${error.code ?? "store_error"}).`);
    return data ? mapHandoffRow(data as Record<string, unknown>) : null;
  }

  async recordHandoffEvent(input: Parameters<PaymentHandoffStore["recordHandoffEvent"]>[0]) {
    const { data, error } = await this.supabase.rpc("civya_service_record_handoff_event", {
      p_handoff_session_id: input.handoffSessionId,
      p_expected_row_version: input.expectedRowVersion,
      p_source_type: input.sourceType,
      p_event_type: input.eventType,
      p_external_event_id: input.externalEventId,
      p_payload_sha256: input.payloadSha256,
      p_redacted_payload: input.redactedPayload,
      p_browser_state: input.browserState,
      p_authoritative_state: input.authoritativeState,
    });
    if (error) throw new Error(`Hosted-handoff event persistence failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    return {
      rowVersion: numberValue(row.rowVersion ?? row.row_version),
      duplicate: row.duplicate === true,
      browserState: stringValue(row.browserState ?? row.browser_state),
      authoritativeState: stringValue(row.authoritativeState ?? row.authoritative_state),
    };
  }

  async recordProviderEvent(input: Parameters<PaymentHandoffStore["recordProviderEvent"]>[0]): Promise<RecordedProviderEvent> {
    const { data, error } = await this.supabase.rpc("civya_service_record_provider_event", {
      p_tenant_id: input.tenantId,
      p_provider_key: PROVIDER_KEY,
      p_external_event_id: input.externalEventId,
      p_event_type: input.eventType,
      p_payload_sha256: input.payloadSha256,
      p_redacted_payload: input.redactedPayload,
      p_signature_verified: input.signatureVerified,
    });
    if (error) throw new Error(`Payment provider-event persistence failed (${error.code ?? "store_error"}).`);
    const row = objectValue(data);
    const eventId = stringValue(row.id);
    if (!UUID.test(eventId)) throw new Error("Provider-event persistence returned an invalid response.");
    return { eventId, state: stringValue(row.state), duplicate: row.duplicate === true };
  }

  async markProviderEventProcessed(eventId: string): Promise<void> {
    const { data, error } = await this.supabase.rpc("civya_service_mark_provider_event", {
      p_event_id: eventId,
      p_state: "processed",
      p_job_id: null,
      p_error_code: null,
    });
    if (error || data !== true) throw new Error(`Payment provider-event completion failed (${error?.code ?? "store_error"}).`);
  }
}

export function sealPaymentLink(claims: PaymentLinkClaims, secret: string): string {
  validateClaims(claims);
  const plaintext = Buffer.from(JSON.stringify({
    kind: claims.kind,
    tenantId: claims.tenantId,
    caseId: claims.caseId,
    actorUserId: claims.actorUserId,
    expiresAt: claims.expiresAt,
    idempotencyKey: claims.idempotencyKey,
    handoffSessionId: claims.handoffSessionId,
    providerSessionReference: claims.providerSessionReference,
    destinationUrl: claims.destinationUrl,
  }), "utf8");
  const key = paymentLinkKey(secret);
  const iv = createHmac("sha256", key)
    .update("iv:")
    .update(createHash("sha256").update(plaintext).digest())
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(LINK_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${LINK_PREFIX}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

export function openPaymentLink(token: string, secret: string): PaymentLinkClaims {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== LINK_PREFIX || token.length > 4_000) throw new Error("Payment link is invalid.");
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", paymentLinkKey(secret), iv);
    decipher.setAAD(LINK_AAD);
    decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as PaymentLinkClaims;
    validateClaims(value);
    return value;
  } catch {
    throw new Error("Payment link is invalid.");
  }
}

function validateClaims(value: PaymentLinkClaims): void {
  if (!value || (value.kind !== "launch" && value.kind !== "return")) throw new Error("Payment link claims are invalid.");
  requireUuid(value.tenantId, "tenant");
  requireUuid(value.caseId, "case");
  requireUuid(value.actorUserId, "actor");
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error("Payment link expiry is invalid.");
  if (!SAFE_IDEMPOTENCY.test(value.idempotencyKey)) throw new Error("Payment link idempotency key is invalid.");
  if (value.kind === "launch") {
    if (!value.handoffSessionId || !UUID.test(value.handoffSessionId)) throw new Error("Payment link handoff is invalid.");
    if (!value.providerSessionReference || value.providerSessionReference.length > 500) throw new Error("Payment link provider reference is invalid.");
    if (!value.destinationUrl || value.destinationUrl.length > 2_000) throw new Error("Payment link destination is invalid.");
  } else if (value.handoffSessionId || value.providerSessionReference || value.destinationUrl) {
    throw new Error("Payment return link contains unsupported claims.");
  }
}

function paymentLinkKey(secret: string): Buffer {
  if (Buffer.byteLength(secret) < 32 || isPlaceholder(secret)) throw new Error("Payment-link secret is not configured.");
  return createHash("sha256").update(secret, "utf8").digest();
}

function parseExactHttpsOrigin(value: string | undefined, reason: PaymentActivationFailure): string {
  try {
    if (!value) throw new Error("missing");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("not-origin");
    }
    return url.origin;
  } catch {
    throw new PaymentActivationError(reason);
  }
}

function requiredSecret(value: string | undefined, minimumBytes: number, reason: PaymentActivationFailure): string {
  if (!value || Buffer.byteLength(value) < minimumBytes || isPlaceholder(value)) throw new PaymentActivationError(reason);
  return value;
}

function isPlaceholder(value: string): boolean {
  return /^(replace-|your-|https:\/\/example\.invalid|todo|tbd)/i.test(value.trim());
}

function localHandoffUrl(origin: string, pathname: string, token: string): string {
  const url = new URL(pathname, origin);
  url.searchParams.set("token", token);
  return url.toString();
}

function assertAllowedDestination(value: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || !allowedOrigins.includes(url.origin)
  ) throw new Error("The payment destination is outside the exact HTTPS origin allowlist.");
  return url;
}

function assertAuthoritativeObligation(value: AuthoritativeCaseObligation, tenantId: string, caseId: string): void {
  assertNoPaymentCredentials(value);
  if (
    value.authority !== "authoritative"
    || value.source !== "wayne_county"
    || value.tenantId !== tenantId
    || value.caseId !== caseId
    || !value.sourceRevision
  ) throw new Error("A current authoritative County obligation is required.");
  const expected = value.expectation;
  if (
    !/^opaque_[A-Za-z0-9_-]{8,120}$/.test(expected.obligationReference)
    || !/^opaque_[A-Za-z0-9_-]{8,120}$/.test(expected.parcelReference)
    || !Number.isSafeInteger(expected.taxYear)
    || expected.currency !== "USD"
    || !Number.isSafeInteger(expected.expectedAmountMinor)
    || expected.expectedAmountMinor <= 0
  ) throw new Error("The authoritative County obligation is incomplete.");
}

function assertHandoffBinding(handoff: HostedHandoffRow, expected: {
  tenantId: string;
  caseId: string;
  providerSessionReferenceDigest: string;
  destinationOrigin: string;
}): void {
  if (
    handoff.tenantId !== expected.tenantId
    || handoff.caseId !== expected.caseId
    || handoff.providerKey !== PROVIDER_KEY
    || handoff.providerSessionReferenceDigest !== expected.providerSessionReferenceDigest
    || handoff.destinationOrigin !== expected.destinationOrigin
  ) throw new Error("The durable payment handoff does not match the requested provider session.");
}

function assertLinkActor(claims: PaymentLinkClaims, actorUserId: string): void {
  requireUuid(actorUserId, "actor");
  if (claims.actorUserId !== actorUserId) throw new Error("The payment handoff belongs to a different account.");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableDigest(...values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value)), "utf8");
    hash.update(":", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function requireUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`A valid ${label} identifier is required.`);
}

function mapHandoffRow(row: Record<string, unknown>): HostedHandoffRow {
  const result: HostedHandoffRow = {
    handoffSessionId: stringValue(row.id),
    tenantId: stringValue(row.tenant_id),
    caseId: stringValue(row.case_id),
    providerKey: stringValue(row.provider_key),
    providerSessionReferenceDigest: stringValue(row.provider_session_reference_digest),
    destinationOrigin: stringValue(row.destination_origin),
    browserState: stringValue(row.browser_state) as HostedHandoffRow["browserState"],
    authoritativeState: stringValue(row.authoritative_state) as HostedHandoffRow["authoritativeState"],
    rowVersion: numberValue(row.row_version),
    expiresAt: stringValue(row.expires_at),
  };
  requireUuid(result.handoffSessionId, "handoff");
  requireUuid(result.tenantId, "tenant");
  requireUuid(result.caseId, "case");
  if (!SHA256.test(result.providerSessionReferenceDigest) || !result.destinationOrigin || !result.expiresAt || result.rowVersion < 1) {
    throw new Error("Hosted-handoff persistence returned an invalid row.");
  }
  return result;
}

function mapExternalOperation(value: unknown): ExternalPaymentOperation {
  const row = objectValue(value);
  const operationId = stringValue(row.id);
  const state = stringValue(row.state) as ExternalPaymentOperation["state"];
  if (!UUID.test(operationId) || !["planned", "in_flight", "succeeded", "failed_unknown", "failed_terminal"].includes(state)) {
    throw new Error("Payment operation persistence returned an invalid response.");
  }
  return {
    operationId,
    state,
    externalReference: nullableString(row.externalReference ?? row.external_reference) ?? null,
    duplicate: row.duplicate === true,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
