import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { validateDocumentContent, safeDocumentName } from "@/lib/documents/validation";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import {
  bootstrapSession,
  createDocumentUploadGrant,
  createRequestPlatform,
  recordDocumentMetadata,
} from "@/lib/platform";
import { rateLimitRequest, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let orphanedUpload: { caseId: string; idempotencyKey: string; storagePath: string } | undefined;
  let platform: Awaited<ReturnType<typeof createRequestPlatform>> = null;
  try {
    const declaredLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > 11 * 1024 * 1024) {
      throw new RequestError(413, "Document uploads are limited to 10 MB.");
    }
    platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "A private session is required.", code: "authentication_required" }, { status: 401 });
    await requireCaseEntitlementSession(req, platform);
    const limited = rateLimitRequest(req, "document-upload", 12, 60 * 60 * 1_000, platform.principal.userId);
    if (limited) return limited;

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new RequestError(400, "Choose a document to upload.");
    const bootstrap = await bootstrapSession(platform);
    if (!bootstrap.active_case) throw new Error("No active case is available for this document.");
    await requireCaseEntitlement(req, platform, bootstrap.active_case.id);
    const suppliedCaseId = String(form.get("case_id") || "");
    if (suppliedCaseId && suppliedCaseId !== bootstrap.active_case.id) {
      throw new RequestError(403, "The document does not belong to this session.", "forbidden");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const validation = validateDocumentContent({
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      content: bytes,
    });
    if (!validation.ok || !validation.contentType) {
      throw new RequestError(validation.error?.includes("10 MB") ? 413 : 415, validation.error || "Unsupported document.");
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const idempotencyKey = req.headers.get("idempotency-key")?.slice(0, 200)
      || `upload:${digest}:${safeDocumentName(file.name)}`.slice(0, 200);
    const { data: existing, error: existingError } = await platform.client
      .from("documents")
      .select("id,original_file_name,document_type,classification_confidence,extraction_confidence,scan_status,review_required")
      .eq("case_id", bootstrap.active_case.id)
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
          message: "This document was already stored; no duplicate copy was created.",
        },
        { headers: { "Cache-Control": "no-store", "Idempotent-Replay": "true" } },
      );
    }
    const request = {
      caseId: bootstrap.active_case.id,
      fileName: safeDocumentName(file.name),
      contentType: validation.contentType,
      sizeBytes: file.size,
      idempotencyKey,
    };

    const grant = await createDocumentUploadGrant(platform, request);
    orphanedUpload = {
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      storagePath: grant.path,
    };
    const { error: uploadError } = await platform.client.storage
      .from(grant.bucket)
      .uploadToSignedUrl(grant.path, grant.token, bytes, {
        contentType: request.contentType,
        // The path is derived from the case and idempotency key, so a retry
        // replaces only the same logical upload and never creates a copy.
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const document = await recordDocumentMetadata(platform, {
      ...request,
      storagePath: grant.path,
      documentType: "unknown",
      scanStatus: "pending",
      reviewRequired: true,
      reviewReason: "Awaiting security scan and human-reviewed extraction; Civya will not guess from the filename.",
    });
    orphanedUpload = undefined;

    return NextResponse.json(
      {
        document_id: document.id,
        file_name: request.fileName,
        document_type: "unknown",
        classification_confidence: null,
        extraction_confidence: null,
        scan_status: "pending",
        review_required: true,
        message: "The document is stored privately and queued for review. No classification has been guessed.",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (orphanedUpload && platform) {
      await platform.removeUnrecordedDocumentUpload(orphanedUpload).catch(() => undefined);
    }
    return requestErrorResponse(error);
  }
}
