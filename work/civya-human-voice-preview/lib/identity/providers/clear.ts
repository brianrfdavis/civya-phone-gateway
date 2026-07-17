import type { IdentityProofingProvider, IdentityProofingRequest, IdentityProofingResult } from "./contracts";
import { validateProofingRequest } from "./contracts";

/** CLEAR is intentionally disabled until Wayne approves procurement, assurance policy, privacy, and accessibility. */
export class DisabledClearIdentityAdapter implements IdentityProofingProvider {
  readonly provider = "clear" as const;
  readonly enabled = false;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async start(request: IdentityProofingRequest): Promise<IdentityProofingResult> {
    validateProofingRequest(request);
    return {
      provider: "clear",
      proofingReference: request.proofingReference,
      outcome: "unavailable",
      assuranceMethod: "disabled_pending_county_approval",
      evidenceCategory: "none",
      policyVersion: request.policyVersion,
      completedAt: new Date(this.now()).toISOString(),
      rawEvidenceStored: false,
      mayRevealCase: false,
      assistedAlternativeRequired: true,
      safeReasonCode: "clear_disabled",
    };
  }
}
