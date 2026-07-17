import type { IdentityProofingProvider, IdentityProofingRequest, IdentityProofingResult } from "./contracts";
import { validateProofingRequest } from "./contracts";

export class SyntheticIdentityProofingAdapter implements IdentityProofingProvider {
  readonly provider = "synthetic" as const;
  readonly enabled = true;
  private outcome: "verified" | "not_verified" | "needs_review";
  private now: () => number;

  constructor(options: { outcome?: "verified" | "not_verified" | "needs_review"; now?: () => number } = {}) {
    this.outcome = options.outcome ?? "needs_review";
    this.now = options.now ?? (() => Date.now());
  }

  async start(request: IdentityProofingRequest): Promise<IdentityProofingResult> {
    validateProofingRequest(request);
    return {
      provider: "synthetic",
      proofingReference: request.proofingReference,
      outcome: this.outcome,
      assuranceMethod: "synthetic_fixture",
      evidenceCategory: "synthetic_only",
      policyVersion: request.policyVersion,
      completedAt: new Date(this.now()).toISOString(),
      rawEvidenceStored: false,
      mayRevealCase: this.outcome === "verified",
      assistedAlternativeRequired: this.outcome !== "verified",
      safeReasonCode: `synthetic_${this.outcome}`,
    };
  }
}
