import { createHash } from "node:crypto";

export type PaymentLifecycleStatus =
  | "created"
  | "launched"
  | "pending"
  | "posted"
  | "returned"
  | "reversed"
  | "refunded"
  | "disputed"
  | "failed"
  | "unmatched";

export type PlanLifecycleStatus = "unknown" | "pending" | "active" | "delinquent" | "cancelled" | "completed";

export interface PaymentObligationReference {
  /** Opaque references only. Raw parcel identifiers do not cross this adapter. */
  obligationReference: string;
  parcelReference: string;
  taxYear: number;
}

export interface HostedPaymentHandoffRequest extends PaymentObligationReference {
  idempotencyKey: string;
  currency: "USD";
  amountMinor: number;
  returnSupported: boolean;
  /** Required by a contracted live adapter; ignored by the synthetic adapter. */
  returnUrl?: string;
  /** Opaque Civya correlation reference. It contains no case or parcel data. */
  clientCorrelationReference?: string;
}

export interface HostedPaymentSession {
  provider: "jpm_chase";
  providerSessionReference: string;
  destinationUrl: string;
  expiresAt: string;
  capturesPaymentCredentials: false;
  browserReturnAuthority: "advisory";
}

export interface HostedPaymentProvider {
  readonly provider: "jpm_chase";
  readonly idempotencySemantics: "synthetic" | "provider_enforced";
  createHostedSession(request: HostedPaymentHandoffRequest): Promise<HostedPaymentSession>;
}

/**
 * This is the narrow seam that the County/J.P. Morgan onboarding package must
 * implement. Civya intentionally does not guess an endpoint, authentication
 * scheme, request field, response field, or signature format.
 */
export interface ContractedJpmChaseCheckoutClient {
  readonly contractVersion: string;
  /** Must be confirmed in the executed provider contract before activation. */
  readonly idempotencySemantics: "provider_enforced";
  createHostedCheckout(request: {
    obligationReference: string;
    parcelReference: string;
    taxYear: number;
    currency: "USD";
    amountMinor: number;
    idempotencyKey: string;
    returnUrl: string;
    clientCorrelationReference: string;
  }): Promise<{
    providerSessionReference: string;
    destinationUrl: string;
    expiresAt: string;
  }>;
}

export interface LiveJpmChaseHostedAdapterOptions {
  client: ContractedJpmChaseCheckoutClient;
  contractVersion: string;
  publicOrigin: string;
  allowedDestinationOrigins: readonly string[];
  credentialsConfigured: boolean;
  now?: () => number;
}

export interface BrowserReturnEvidence {
  handoffReference: string;
  returnedAt: string;
  authority: "advisory";
  maySetCompletion: false;
  residentMessage: "Status is still being confirmed with Wayne County.";
}

export function classifyBrowserReturn(handoffReference: string, returnedAt: string): BrowserReturnEvidence {
  return {
    handoffReference,
    returnedAt,
    authority: "advisory",
    maySetCompletion: false,
    residentMessage: "Status is still being confirmed with Wayne County.",
  };
}

export interface AuthoritativePaymentRecord extends PaymentObligationReference {
  source: "wayne_county" | "jpm_chase";
  authority: "authoritative";
  sourceRevision: string;
  providerTransactionReference: string;
  paymentStatus: PaymentLifecycleStatus;
  planStatus: PlanLifecycleStatus;
  currency: "USD";
  amountMinor: number;
  postingDate?: string;
  effectiveDate?: string;
  returnOrReversalCode?: string;
}

export interface ReconciliationExpectation extends PaymentObligationReference {
  currency: "USD";
  expectedAmountMinor: number;
  expectedRecordCount?: number;
  expectedControlTotalMinor?: number;
}

export interface PaymentReconciliationDecision {
  matched: boolean;
  paymentStatus: PaymentLifecycleStatus;
  planStatus: PlanLifecycleStatus;
  verifiedCompletion: boolean;
  authority: "authoritative";
  exceptions: Array<
    | "wrong_obligation"
    | "wrong_parcel"
    | "wrong_tax_year"
    | "wrong_currency"
    | "amount_mismatch"
    | "count_control_mismatch"
    | "dollar_control_mismatch"
    | "nonfinal_status"
  >;
}

export function reconcileAuthoritativePayment(
  expectation: ReconciliationExpectation,
  record: AuthoritativePaymentRecord,
  controls?: { recordCount: number; controlTotalMinor: number },
): PaymentReconciliationDecision {
  if (record.authority !== "authoritative" || (record.source !== "wayne_county" && record.source !== "jpm_chase")) {
    throw new Error("Only an approved authoritative source record can enter payment reconciliation.");
  }
  const exceptions: PaymentReconciliationDecision["exceptions"] = [];
  if (record.obligationReference !== expectation.obligationReference) exceptions.push("wrong_obligation");
  if (record.parcelReference !== expectation.parcelReference) exceptions.push("wrong_parcel");
  if (record.taxYear !== expectation.taxYear) exceptions.push("wrong_tax_year");
  if (record.currency !== expectation.currency) exceptions.push("wrong_currency");
  if (record.amountMinor !== expectation.expectedAmountMinor) exceptions.push("amount_mismatch");
  if (expectation.expectedRecordCount !== undefined && (!controls || controls.recordCount !== expectation.expectedRecordCount)) {
    exceptions.push("count_control_mismatch");
  }
  if (expectation.expectedControlTotalMinor !== undefined && (!controls || controls.controlTotalMinor !== expectation.expectedControlTotalMinor)) {
    exceptions.push("dollar_control_mismatch");
  }
  const finalAndActive = record.paymentStatus === "posted" && record.planStatus === "active";
  if (!finalAndActive) exceptions.push("nonfinal_status");
  const identityExceptions = exceptions.filter((exception) => exception !== "nonfinal_status");
  return {
    matched: identityExceptions.length === 0,
    paymentStatus: identityExceptions.length === 0 ? record.paymentStatus : "unmatched",
    planStatus: identityExceptions.length === 0 ? record.planStatus : "unknown",
    verifiedCompletion: exceptions.length === 0 && finalAndActive,
    authority: "authoritative",
    exceptions,
  };
}

const PROHIBITED_PAYMENT_KEYS = /(?:card|cvv|cvc|pan|bank.?account|routing|account.?number|ach.?token|payment.?credential|security.?code|pass(?:word|code)|pin(?:_?code)?|online.?bank|bank.?login|login.?credential)/i;

export function assertNoPaymentCredentials(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    for (const candidate of value.match(/(?:\d[ -]?){13,19}/g) ?? []) {
      const digits = candidate.replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
        throw new Error(`Prohibited payment credential value at ${path}.`);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // This negative capability marker is part of the safe provider contract;
    // the only permitted value is literal false.
    if (key === "capturesPaymentCredentials" && child === false) continue;
    if (PROHIBITED_PAYMENT_KEYS.test(key)) throw new Error(`Prohibited payment credential field at ${path}.${key}.`);
    assertNoPaymentCredentials(child, `${path}.${key}`);
  }
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function stableReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function exactHttpsOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return url.origin;
}

function assertHostedRequest(request: HostedPaymentHandoffRequest): void {
  assertNoPaymentCredentials(request);
  if (!/^opaque_[A-Za-z0-9_-]{8,120}$/.test(request.obligationReference)) {
    throw new Error("The hosted handoff requires an opaque obligation reference.");
  }
  if (!/^opaque_[A-Za-z0-9_-]{8,120}$/.test(request.parcelReference)) {
    throw new Error("The hosted handoff requires an opaque parcel reference.");
  }
  if (!Number.isSafeInteger(request.taxYear) || request.taxYear < 1900 || request.taxYear > 2200) {
    throw new Error("The hosted handoff requires a valid tax year.");
  }
  if (!/^[A-Za-z0-9_.:-]{8,180}$/.test(request.idempotencyKey)) {
    throw new Error("The hosted handoff requires a safe idempotency key.");
  }
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    throw new Error("Amount must be a positive integer in minor currency units.");
  }
}

export class SyntheticJpmChaseHostedAdapter implements HostedPaymentProvider {
  readonly provider = "jpm_chase" as const;
  readonly idempotencySemantics = "synthetic" as const;
  private destinationOrigin: string;
  private now: () => number;

  constructor(options: { destinationOrigin?: string; now?: () => number } = {}) {
    this.destinationOrigin = options.destinationOrigin ?? "https://payments.example.invalid";
    this.now = options.now ?? (() => Date.now());
  }

  async createHostedSession(request: HostedPaymentHandoffRequest): Promise<HostedPaymentSession> {
    assertHostedRequest(request);
    const origin = new URL(this.destinationOrigin);
    if (origin.protocol !== "https:") throw new Error("Hosted payment destination must use HTTPS.");
    const destination = new URL("/synthetic/hosted-payment", origin);
    destination.searchParams.set("session", stableReference(request.idempotencyKey));
    const now = this.now();
    return {
      provider: "jpm_chase",
      providerSessionReference: `syn_jpm_${stableReference(request.idempotencyKey)}`,
      destinationUrl: destination.toString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
      capturesPaymentCredentials: false,
      browserReturnAuthority: "advisory",
    };
  }
}

/**
 * Production-shaped adapter for a County-contracted hosted checkout. The
 * provider-specific HTTP client is injected only after Wayne County/J.P.
 * Morgan supply and approve their actual integration contract.
 */
export class LiveJpmChaseHostedAdapter implements HostedPaymentProvider {
  readonly provider = "jpm_chase" as const;
  readonly idempotencySemantics = "provider_enforced" as const;
  private readonly options: LiveJpmChaseHostedAdapterOptions;
  private readonly publicOrigin: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(options: LiveJpmChaseHostedAdapterOptions) {
    this.options = options;
    if (options.client.idempotencySemantics !== "provider_enforced") {
      throw new Error("The J.P. Morgan Chase contract must guarantee idempotent hosted-session creation.");
    }
    if (!options.credentialsConfigured) {
      throw new Error("J.P. Morgan Chase hosted-checkout credentials are not configured.");
    }
    if (!options.contractVersion || options.contractVersion !== options.client.contractVersion) {
      throw new Error("The approved J.P. Morgan Chase contract version is not configured.");
    }
    this.publicOrigin = exactHttpsOrigin(options.publicOrigin, "Civya public origin");
    const origins = options.allowedDestinationOrigins.map((origin) => exactHttpsOrigin(origin, "Payment destination"));
    if (origins.length === 0 || new Set(origins).size !== origins.length) {
      throw new Error("At least one unique payment destination origin must be allowlisted.");
    }
    this.allowedOrigins = new Set(origins);
    this.now = options.now ?? (() => Date.now());
  }

  async createHostedSession(request: HostedPaymentHandoffRequest): Promise<HostedPaymentSession> {
    assertHostedRequest(request);
    if (!request.returnSupported || !request.returnUrl) {
      throw new Error("The live hosted handoff requires a one-time Civya return URL.");
    }
    const returnUrl = new URL(request.returnUrl);
    if (
      returnUrl.origin !== this.publicOrigin
      || returnUrl.protocol !== "https:"
      || returnUrl.username
      || returnUrl.password
      || returnUrl.pathname !== "/api/handoffs/return"
      || returnUrl.hash
      || [...returnUrl.searchParams.keys()].some((key) => key !== "token")
      || !returnUrl.searchParams.get("token")
    ) {
      throw new Error("The provider return URL is outside the exact Civya return boundary.");
    }
    if (!request.clientCorrelationReference || !/^pay_[0-9a-f]{32,64}$/.test(request.clientCorrelationReference)) {
      throw new Error("A safe payment correlation reference is required.");
    }

    const result = await this.options.client.createHostedCheckout({
      obligationReference: request.obligationReference,
      parcelReference: request.parcelReference,
      taxYear: request.taxYear,
      currency: request.currency,
      amountMinor: request.amountMinor,
      idempotencyKey: request.idempotencyKey,
      returnUrl: returnUrl.toString(),
      clientCorrelationReference: request.clientCorrelationReference,
    });
    assertNoPaymentCredentials(result);
    if (!/^[A-Za-z0-9_.:-]{8,500}$/.test(result.providerSessionReference)) {
      throw new Error("The hosted-checkout provider returned an invalid opaque session reference.");
    }
    const destination = new URL(result.destinationUrl);
    if (
      destination.protocol !== "https:"
      || destination.username
      || destination.password
      || !this.allowedOrigins.has(destination.origin)
      || destination.hash
    ) {
      throw new Error("The hosted-checkout provider returned a destination outside the exact origin allowlist.");
    }
    const expiresAt = Date.parse(result.expiresAt);
    const now = this.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now + 60_000 || expiresAt > now + 30 * 60_000) {
      throw new Error("The hosted-checkout provider returned an invalid session expiry.");
    }
    return {
      provider: "jpm_chase",
      providerSessionReference: result.providerSessionReference,
      destinationUrl: destination.toString(),
      expiresAt: new Date(expiresAt).toISOString(),
      capturesPaymentCredentials: false,
      browserReturnAuthority: "advisory",
    };
  }
}
