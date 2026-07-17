export type ProviderMode = "disabled" | "synthetic" | "production";

export type IntegrationProvider =
  | "openai"
  | "twilio"
  | "jpm_chase"
  | "docusign"
  | "wayne_county"
  | "document_scanner"
  | "clear";

export type EvidenceAuthority = "advisory" | "authoritative";

export interface ProviderRequestContext {
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  requestedAt: string;
  actor: "resident" | "staff" | "service";
}

export interface ProviderReceipt {
  provider: IntegrationProvider;
  providerReference: string;
  acceptedAt: string;
  duplicate: boolean;
  authority: EvidenceAuthority;
}

export interface ProviderFailure {
  code:
    | "disabled"
    | "invalid_request"
    | "unauthorized"
    | "rate_limited"
    | "timeout"
    | "unavailable"
    | "rejected"
    | "unknown";
  retryable: boolean;
  safeMessage: string;
  providerReference?: string;
}

export type ProviderResult<T> =
  | { ok: true; value: T; receipt: ProviderReceipt }
  | { ok: false; failure: ProviderFailure };

/**
 * External effects must be committed by the durable job/outbox layer. Provider
 * adapters return receipts; they never mutate resident workflow state directly.
 */
export interface ExternalEffectAdapter<TRequest, TResponse> {
  readonly provider: IntegrationProvider;
  readonly mode: ProviderMode;
  execute(request: TRequest, context: ProviderRequestContext): Promise<ProviderResult<TResponse>>;
}
