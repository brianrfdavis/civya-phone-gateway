export type ProofingAction =
  | "save_nonsensitive_draft"
  | "view_sensitive_case"
  | "document_access"
  | "change_contact"
  | "external_handoff"
  | "delegate_access"
  | "assisted_recovery";

export type AssuranceOutcome = "verified" | "not_verified" | "needs_review" | "cancelled" | "unavailable";

export interface IdentityProofingRequest {
  proofingReference: string;
  caseReference: string;
  action: ProofingAction;
  policyVersion: string;
  consentReference: string;
  sessionBinding: string;
  locale: string;
}

export interface IdentityProofingResult {
  provider: "clear" | "synthetic";
  proofingReference: string;
  outcome: AssuranceOutcome;
  assuranceMethod: string;
  evidenceCategory: string;
  policyVersion: string;
  completedAt: string;
  rawEvidenceStored: false;
  mayRevealCase: boolean;
  assistedAlternativeRequired: boolean;
  safeReasonCode: string;
}

export interface IdentityProofingProvider {
  readonly provider: "clear" | "synthetic";
  readonly enabled: boolean;
  start(request: IdentityProofingRequest): Promise<IdentityProofingResult>;
}

export function validateProofingRequest(request: IdentityProofingRequest): void {
  if (!/^proof_[A-Za-z0-9_-]{8,120}$/.test(request.proofingReference)) throw new Error("Proofing reference must be opaque.");
  if (!/^opaque_[A-Za-z0-9_-]{8,120}$/.test(request.caseReference)) throw new Error("Case reference must be opaque.");
  if (!/^consent_[A-Za-z0-9_-]{8,120}$/.test(request.consentReference)) throw new Error("Proofing consent is required.");
  if (request.sessionBinding.length < 16) throw new Error("Proofing request must be session-bound.");
}
