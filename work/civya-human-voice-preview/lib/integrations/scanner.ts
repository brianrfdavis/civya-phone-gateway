export type ScanVerdict = "clean" | "malicious" | "unsupported" | "encrypted" | "timeout" | "error";

export interface DocumentScanRequest {
  storageObjectReference: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  idempotencyKey: string;
}

export interface SyntheticDocumentScanRequest extends DocumentScanRequest {
  /** Fixture control that is not part of the production scanner contract. */
  testVerdict?: ScanVerdict;
}

export interface DocumentScanResult {
  scanner: string;
  engineVersion: string;
  signatureVersion: string;
  verdict: ScanVerdict;
  scannedAt: string;
  mayRelease: boolean;
  requiresHumanReview: boolean;
  safeReasonCode: string;
}

export interface DocumentScanner {
  scan(request: DocumentScanRequest): Promise<DocumentScanResult>;
  health(): Promise<{ healthy: boolean; engineVersion: string; signatureVersion: string }>;
}

export class SyntheticDocumentScanner implements DocumentScanner {
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async scan(request: SyntheticDocumentScanRequest): Promise<DocumentScanResult> {
    if (!/^object_[A-Za-z0-9_-]{8,180}$/.test(request.storageObjectReference)) {
      throw new Error("Scanner accepts only an opaque private-object reference.");
    }
    if (!/^[a-f0-9]{64}$/i.test(request.sha256)) throw new Error("Scanner requires a SHA-256 digest.");
    if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes <= 0) throw new Error("Invalid scan size.");
    const verdict = request.testVerdict ?? "clean";
    const mayRelease = verdict === "clean";
    return {
      scanner: "synthetic-scanner",
      engineVersion: "synthetic-1",
      signatureVersion: "fixture-1",
      verdict,
      scannedAt: new Date(this.now()).toISOString(),
      mayRelease,
      requiresHumanReview: !mayRelease,
      safeReasonCode: mayRelease ? "clean" : `scan_${verdict}`,
    };
  }

  async health(): Promise<{ healthy: boolean; engineVersion: string; signatureVersion: string }> {
    return { healthy: true, engineVersion: "synthetic-1", signatureVersion: "fixture-1" };
  }
}
