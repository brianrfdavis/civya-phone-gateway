import { createHash } from "node:crypto";

export type SignatureEnvelopeStatus =
  | "created"
  | "sent"
  | "delivered"
  | "completed"
  | "declined"
  | "voided"
  | "expired"
  | "unknown";

export interface SignatureHandoffRequest {
  handoffReference: string;
  templateVersion: string;
  signerReference: string;
  idempotencyKey: string;
  returnSupported: boolean;
}

export interface SignatureEnvelope {
  provider: "docusign";
  envelopeReference: string;
  destinationUrl: string;
  status: SignatureEnvelopeStatus;
  browserReturnAuthority: "advisory";
}

export interface SignatureStatusEvidence {
  envelopeReference: string;
  status: SignatureEnvelopeStatus;
  authority: "advisory";
  provesPaymentOrPlanCompletion: false;
  requiresCountyReconciliation: true;
}

export interface SignatureProvider {
  readonly provider: "docusign";
  createEnvelope(request: SignatureHandoffRequest): Promise<SignatureEnvelope>;
  getStatus(envelopeReference: string): Promise<SignatureStatusEvidence>;
}

function reference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function classifySignatureStatus(
  envelopeReference: string,
  status: SignatureEnvelopeStatus,
): SignatureStatusEvidence {
  return {
    envelopeReference,
    status,
    authority: "advisory",
    provesPaymentOrPlanCompletion: false,
    requiresCountyReconciliation: true,
  };
}

export class SyntheticDocuSignAdapter implements SignatureProvider {
  readonly provider = "docusign" as const;
  private destinationOrigin: string;
  private statuses = new Map<string, SignatureEnvelopeStatus>();

  constructor(destinationOrigin = "https://sign.example.invalid") {
    this.destinationOrigin = destinationOrigin;
  }

  async createEnvelope(request: SignatureHandoffRequest): Promise<SignatureEnvelope> {
    if (!/^opaque_[A-Za-z0-9_-]{8,120}$/.test(request.signerReference)) {
      throw new Error("Signer reference must be opaque.");
    }
    const envelopeReference = `syn_env_${reference(request.idempotencyKey)}`;
    this.statuses.set(envelopeReference, "sent");
    const destination = new URL("/synthetic/sign", this.destinationOrigin);
    destination.searchParams.set("session", reference(envelopeReference));
    return {
      provider: "docusign",
      envelopeReference,
      destinationUrl: destination.toString(),
      status: "sent",
      browserReturnAuthority: "advisory",
    };
  }

  async getStatus(envelopeReference: string): Promise<SignatureStatusEvidence> {
    return classifySignatureStatus(envelopeReference, this.statuses.get(envelopeReference) ?? "unknown");
  }
}
