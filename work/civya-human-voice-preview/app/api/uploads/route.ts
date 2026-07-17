import { NextRequest, NextResponse } from "next/server";
import { safeDocumentName, validateDocumentMetadata } from "@/lib/documents/validation";
import {
  documentUploadIdempotencyHash,
  issueDocumentUploadGrant,
} from "@/lib/documents/upload-grant.server";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { createDocumentUploadGrant, createRequestPlatform } from "@/lib/platform";
import {
  rateLimitRequest,
  readJsonObject,
  RequestError,
  requestErrorResponse,
} from "@/lib/security/request";

export const runtime = "nodejs";

/**
 * Issue a short-lived, account/case-bound direct-to-Supabase upload grant.
 * File bytes never pass through this Vercel route.
 */
export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) {
      return NextResponse.json(
        { error: "A private session is required.", code: "authentication_required" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const entitlement = await requireCaseEntitlementSession(req, platform);
    await requireCaseEntitlement(req, platform, entitlement.caseId);
    const limited = rateLimitRequest(req, "document-upload-grant", 12, 60 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;

    const body = await readJsonObject(req, 8_000);
    const suppliedCaseId = typeof body.case_id === "string" ? body.case_id : "";
    if (suppliedCaseId && suppliedCaseId !== entitlement.caseId) {
      throw new RequestError(403, "The document does not belong to this session.", "forbidden");
    }
    const fileName = safeDocumentName(String(body.file_name || "document"));
    const declaredType = String(body.content_type || "").toLowerCase().split(";")[0].trim();
    const sizeBytes = Number(body.size_bytes);
    const sha256 = String(body.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new RequestError(400, "A SHA-256 document checksum is required.", "document_checksum_required");
    }
    const validation = validateDocumentMetadata({ name: fileName, type: declaredType, size: sizeBytes });
    if (!validation.ok || !validation.contentType) {
      throw new RequestError(validation.error?.includes("10 MB") ? 413 : 415, validation.error || "Unsupported document.");
    }
    const contentType = validation.contentType as
      | "application/pdf"
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "text/plain";
    const idempotencyKey = `upload:${sha256}:${fileName}`.slice(0, 200);

    const { data: existing, error: existingError } = await platform.client
      .from("documents")
      .select("id,original_file_name,document_type,classification_confidence,extraction_confidence,scan_status,review_required")
      .eq("case_id", entitlement.caseId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return NextResponse.json(
        {
          document_id: existing.id,
          file_name: existing.original_file_name,
          document_type: existing.document_type,
          classification_confidence: existing.classification_confidence,
          extraction_confidence: existing.extraction_confidence,
          scan_status: existing.scan_status,
          review_required: existing.review_required,
          idempotent_replay: true,
          upload_required: false,
          message: "This document was already stored; no duplicate copy was created.",
        },
        { headers: { "Cache-Control": "no-store", "Idempotent-Replay": "true" } },
      );
    }

    const request = {
      caseId: entitlement.caseId,
      fileName,
      contentType,
      sizeBytes,
      idempotencyKey,
    };
    const storageGrant = await createDocumentUploadGrant(platform, request);
    const applicationGrant = issueDocumentUploadGrant({
      userId: platform.principal.userId,
      tenantId: entitlement.tenantId,
      caseId: entitlement.caseId,
      bucket: storageGrant.bucket,
      path: storageGrant.path,
      fileName,
      contentType,
      sizeBytes,
      sha256,
      idempotencyKey,
    });
    const idempotencyHash = documentUploadIdempotencyHash(idempotencyKey);

    return NextResponse.json(
      {
        upload_required: true,
        bucket: storageGrant.bucket,
        path: storageGrant.path,
        upload_token: storageGrant.token,
        upload_url: storageGrant.signedUrl,
        finalize_token: applicationGrant.token,
        expires_at: new Date(applicationGrant.claims.expiresAt).toISOString(),
        upload_metadata: { sha256, idempotency_hash: idempotencyHash, quarantine: "pending" },
      },
      { status: 201, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
