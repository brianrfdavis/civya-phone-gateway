import { NextRequest, NextResponse } from "next/server";
import { createDocumentDownloadUrl, createRequestPlatform } from "@/lib/platform";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const residentRequest = platform.principal.role === "resident";
    const staffRequest = platform.principal.role === "reviewer" || platform.principal.role === "admin";
    if (!residentRequest && !staffRequest) {
      throw new RequestError(403, "Document access is not available for this account.", "forbidden");
    }
    if (residentRequest) await requireCaseEntitlementSession(req, platform);
    const { documentId } = await params;
    const { data: document, error: documentError } = await platform.client
      .from("documents")
      .select("id,case_id,scan_status,review_required")
      .eq("id", documentId)
      .single();
    if (documentError || !document) {
      throw new RequestError(404, "The requested document is unavailable.", "not_found");
    }
    if (residentRequest) await requireCaseEntitlement(req, platform, document.case_id);
    const staff = staffRequest;
    const quarantineReview = req.nextUrl.searchParams.get("purpose") === "quarantine_review";
    if (document.scan_status !== "clean" && !(staff && quarantineReview)) {
      throw new RequestError(
        423,
        staff
          ? "This file is quarantined. Open it only through the explicit staff review action."
          : "This document is still being checked and is not available for download.",
        "document_quarantined",
      );
    }
    const signedUrl = await createDocumentDownloadUrl(platform, documentId, 60);
    return NextResponse.json(
      {
        url: signedUrl,
        expires_in_seconds: 60,
        quarantine_review: document.scan_status !== "clean",
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
