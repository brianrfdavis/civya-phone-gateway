import { NextRequest, NextResponse } from "next/server";
import {
  DocumentUploadGrantError,
  documentUploadIdempotencyHash,
  verifyDocumentUploadGrant,
} from "@/lib/documents/upload-grant.server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import {
  createRequestPlatform,
  inspectDocumentUploadObject,
  recordDocumentMetadata,
} from "@/lib/platform";
import {
  rateLimitRequest,
  readJsonObject,
  RequestError,
  requestErrorResponse,
} from "@/lib/security/request";

export const runtime = "nodejs";

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const nested = metadata.metadata && typeof metadata.metadata === "object"
    ? metadata.metadata as Record<string, unknown>
    : undefined;
  return String(metadata[key] ?? nested?.[key] ?? "").toLowerCase();
}

function replayResponse(existing: Record<string, unknown>) {
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
      message: "This document was already stored; no duplicate copy was created.",
    },
    { headers: { "Cache-Control": "no-store", "Idempotent-Replay": "true" } },
  );
}

export async function POST(req: NextRequest) {
  let invalidObject: { caseId: string; idempotencyKey: string; storagePath: string } | undefined;
  let platform: Awaited<ReturnType<typeof createRequestPlatform>> = null;
  try {
    const body = await readJsonObject(req, 24_000);
    const token = typeof body.finalize_token === "string" ? body.finalize_token : "";
    if (!token) throw new RequestError(400, "The upload authorization is required.", "upload_grant_invalid");
    let claims;
    try {
      claims = verifyDocumentUploadGrant(token);
    } catch (error) {
      if (error instanceof DocumentUploadGrantError) {
        const status = error.code === "upload_grant_expired" ? 410
          : error.code === "upload_grant_configuration_invalid" ? 503 : 403;
        throw new RequestError(status, error.message, error.code);
      }
      throw error;
    }

    platform = await createRequestPlatform();
    if (!platform || platform.principal.userId !== claims.userId) {
      throw new RequestError(403, "The upload authorization does not belong to this account.", "upload_grant_invalid");
    }
    const entitlement = await requireCaseEntitlement(req, platform, claims.caseId);
    if (entitlement.tenantId !== claims.tenantId) {
      throw new RequestError(403, "The upload authorization does not belong to this County tenant.", "upload_grant_invalid");
    }
    const limited = rateLimitRequest(req, "document-upload-finalize", 30, 60 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;

    const { data: existing, error: existingError } = await platform.client
      .from("documents")
      .select("id,original_file_name,document_type,classification_confidence,extraction_confidence,scan_status,review_required")
      .eq("case_id", claims.caseId)
      .eq("idempotency_key", claims.idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return replayResponse(existing as Record<string, unknown>);

    const lookup = {
      caseId: claims.caseId,
      idempotencyKey: claims.idempotencyKey,
      storagePath: claims.path,
    };
    const object = await inspectDocumentUploadObject(platform, lookup);
    invalidObject = lookup;
    const storedDigest = metadataString(object.metadata, "sha256");
    const storedIdempotencyHash = metadataString(object.metadata, "idempotency_hash");
    if (
      object.path !== claims.path
      || object.sizeBytes !== claims.sizeBytes
      || object.contentType !== claims.contentType
      || storedDigest !== claims.sha256
      || storedIdempotencyHash !== documentUploadIdempotencyHash(claims.idempotencyKey)
    ) {
      await platform.removeUnrecordedDocumentUpload(lookup).catch(() => undefined);
      invalidObject = undefined;
      throw new RequestError(
        422,
        "The stored object did not match its signed size, type, and checksum metadata. Upload it again.",
        "uploaded_object_mismatch",
      );
    }

    const document = await recordDocumentMetadata(platform, {
      caseId: claims.caseId,
      fileName: claims.fileName,
      contentType: claims.contentType,
      sizeBytes: claims.sizeBytes,
      idempotencyKey: claims.idempotencyKey,
      storagePath: claims.path,
      documentType: "unknown",
      scanStatus: "pending",
      reviewRequired: true,
      reviewReason: "Direct upload is quarantined until security scanning and human-reviewed extraction finish.",
    });
    invalidObject = undefined;

    return NextResponse.json(
      {
        document_id: document.id,
        file_name: claims.fileName,
        document_type: "unknown",
        classification_confidence: null,
        extraction_confidence: null,
        scan_status: "pending",
        review_required: true,
        message: "The document is stored privately and quarantined for review. No classification has been guessed.",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Only validation failures mark an object for cleanup. Transient metadata
    // persistence failures keep the quarantined object so the same signed
    // finalize request can be retried idempotently.
    if (invalidObject && platform && error instanceof RequestError && error.code === "uploaded_object_mismatch") {
      await platform.removeUnrecordedDocumentUpload(invalidObject).catch(() => undefined);
    }
    return requestErrorResponse(error);
  }
}
