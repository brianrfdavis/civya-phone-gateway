export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

export interface DocumentValidation {
  ok: boolean;
  contentType?: string;
  error?: string;
}

export function validateDocumentMetadata(file: {
  name: string;
  type: string;
  size: number;
}): DocumentValidation {
  const contentType = file.type.toLowerCase().split(";")[0].trim();
  if (!ALLOWED_DOCUMENT_TYPES.has(contentType)) {
    return { ok: false, error: "Use a PDF, JPEG, PNG, WebP, or plain-text file." };
  }
  if (!safeDocumentName(file.name)) return { ok: false, error: "The file name is invalid." };
  if (!Number.isSafeInteger(file.size) || file.size < 1) return { ok: false, error: "The file is empty." };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, error: "The file is larger than 10 MB." };
  return { ok: true, contentType };
}

function startsWith(content: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => content[index] === byte);
}

export function validateDocumentContent(file: {
  name: string;
  type: string;
  size: number;
  content: Uint8Array;
}): DocumentValidation {
  const metadata = validateDocumentMetadata(file);
  if (!metadata.ok || !metadata.contentType) return metadata;
  const contentType = metadata.contentType;
  if (file.content.length < 1) return { ok: false, error: "The file is empty." };

  const signatureMatches =
    (contentType === "application/pdf" && startsWith(file.content, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    || (contentType === "image/jpeg" && startsWith(file.content, [0xff, 0xd8, 0xff]))
    || (contentType === "image/png" && startsWith(file.content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (contentType === "image/webp"
      && new TextDecoder("ascii").decode(file.content.slice(0, 4)) === "RIFF"
      && new TextDecoder("ascii").decode(file.content.slice(8, 12)) === "WEBP")
    || (contentType === "text/plain" && !file.content.slice(0, 4_096).includes(0));

  if (!signatureMatches) {
    return { ok: false, error: "The file contents do not match the selected file type." };
  }
  return { ok: true, contentType };
}

export function safeDocumentName(value: string): string {
  const withoutPath = value.split(/[\\/]/).pop() || "document";
  const cleaned = withoutPath.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "document").slice(-120);
}

export function extractionDisposition(input: {
  classificationConfidence?: number;
  extractionConfidence?: number;
  scanStatus?: string;
}): { reviewRequired: boolean; reason?: string } {
  if (input.scanStatus !== "clean") return { reviewRequired: true, reason: "Security scan is not complete." };
  if ((input.classificationConfidence ?? 0) < 0.85) {
    return { reviewRequired: true, reason: "Document classification confidence is below 85%." };
  }
  if ((input.extractionConfidence ?? 0) < 0.9) {
    return { reviewRequired: true, reason: "Text extraction confidence is below 90%." };
  }
  return { reviewRequired: false };
}
