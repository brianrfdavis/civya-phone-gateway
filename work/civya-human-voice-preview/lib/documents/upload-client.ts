"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeDocumentName, validateDocumentContent } from "./validation";

export interface DirectDocumentUploadResult {
  document_id: string;
  file_name: string;
  document_type: string;
  classification_confidence: number | null;
  extraction_confidence: number | null;
  scan_status: string;
  review_required: boolean;
  idempotent_replay?: boolean;
  message?: string;
  checklist_summary?: string;
  next_best_action?: string;
}

interface UploadGrantResponse extends Partial<DirectDocumentUploadResult> {
  error?: string;
  code?: string;
  upload_required?: boolean;
  bucket?: string;
  path?: string;
  upload_token?: string;
  finalize_token?: string;
  upload_metadata?: {
    sha256?: string;
    idempotency_hash?: string;
    quarantine?: string;
  };
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseJson(response: Response): Promise<UploadGrantResponse> {
  return await response.json().catch(() => ({})) as UploadGrantResponse;
}

/** Upload directly from the browser to private Supabase Storage, then finalize metadata server-side. */
export async function uploadDocumentDirect(file: File, caseId?: string): Promise<DirectDocumentUploadResult> {
  const bytes = await file.arrayBuffer();
  const validation = validateDocumentContent({
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    content: new Uint8Array(bytes),
  });
  if (!validation.ok || !validation.contentType) throw new Error(validation.error || "Unsupported document.");
  const sha256 = bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
  const fileName = safeDocumentName(file.name);

  const grantResponse = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      case_id: caseId,
      file_name: fileName,
      content_type: validation.contentType,
      size_bytes: file.size,
      sha256,
    }),
  });
  const grant = await responseJson(grantResponse);
  if (!grantResponse.ok || grant.error) throw new Error(grant.error || "The document upload could not be authorized.");
  if (!grant.upload_required && grant.document_id) return grant as DirectDocumentUploadResult;
  if (!grant.bucket || !grant.path || !grant.upload_token || !grant.finalize_token) {
    throw new Error("The document upload authorization was incomplete. Please try again.");
  }

  const upload = await createSupabaseBrowserClient().storage
    .from(grant.bucket)
    .uploadToSignedUrl(grant.path, grant.upload_token, file, {
      contentType: validation.contentType,
      cacheControl: "0",
      upsert: false,
      metadata: {
        sha256: grant.upload_metadata?.sha256 || sha256,
        idempotency_hash: grant.upload_metadata?.idempotency_hash || "",
        quarantine: "pending",
      },
    });

  // A concurrent retry can legitimately win the no-upsert race. Finalization
  // is authoritative and idempotent, so attempt it even after a storage error.
  const finalizeResponse = await fetch("/api/uploads/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ finalize_token: grant.finalize_token }),
  });
  const finalized = await responseJson(finalizeResponse);
  if (!finalizeResponse.ok || finalized.error) {
    if (upload.error) throw new Error(upload.error.message || "The document could not be uploaded.");
    throw new Error(finalized.error || "The document could not be finalized.");
  }
  return finalized as DirectDocumentUploadResult;
}
