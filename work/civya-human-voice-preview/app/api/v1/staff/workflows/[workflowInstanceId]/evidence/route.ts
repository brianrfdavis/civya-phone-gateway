import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse, RequestError } from "@/lib/security/request";
import { bodyObject, bodyString, workflowErrorResponse } from "@/lib/workflows/http.server";
import {
  createSupabaseGovernedWorkflowRepository,
  GovernedWorkflowRepositoryError,
} from "@/lib/workflows/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_KEYS = new Set([
  "assurance_scope", "assuranceScope", "authoritative", "observed_at",
  "observedAt", "idempotency_key", "idempotencyKey", "redacted_evidence",
  "redactedEvidence",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowInstanceId: string }> },
) {
  try {
    const { platform, staff } = await requireStaff("reviewer", request.headers.get("host"));
    const { workflowInstanceId } = await params;
    const body = await readJsonObject(request, 12_000);
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported evidence field: ${key}.`);
    }
    const redactedEvidence = bodyObject(body, "redacted_evidence", "redactedEvidence");
    if (!redactedEvidence) throw new RequestError(400, "redacted_evidence must be a JSON object.");
    const assuranceScope = bodyString(body, "assurance_scope", "assuranceScope");
    if (assuranceScope !== "county_attested") {
      throw new RequestError(400, "Staff evidence must use the county_attested assurance scope.");
    }
    if (typeof body.authoritative !== "boolean") {
      throw new RequestError(400, "authoritative must be explicitly true or false.");
    }
    const observedAt = bodyString(body, "observed_at", "observedAt");
    const idempotencyKey = bodyString(body, "idempotency_key", "idempotencyKey")
      || request.headers.get("idempotency-key")
      || "";
    const evidenceSha256 = createHash("sha256").update(JSON.stringify({
      workflowInstanceId,
      assuranceScope,
      authoritative: body.authoritative,
      observedAt,
      redactedEvidence,
    })).digest("hex");
    const repository = createSupabaseGovernedWorkflowRepository();
    const actor = { type: "staff" as const, userId: platform.principal.userId };
    const before = await repository.read({ actor, workflowInstanceId });
    if (before.tenantId !== staff.tenant.id) {
      throw new RequestError(404, "The workflow was not found in this county workspace.", "not_found");
    }
    const result = await repository.recordCompletionEvidence({
      actor,
      workflowInstanceId,
      authorityType: "staff_attestation",
      assuranceScope,
      authoritative: body.authoritative,
      evidenceSha256,
      redactedEvidence,
      observedAt,
      idempotencyKey,
    });
    return NextResponse.json(
      {
        completion_evidence_id: result.completionEvidenceId,
        authoritative: result.authoritative,
        assurance_scope: result.assuranceScope,
        duplicate: result.duplicate,
        bound_to_completion: false,
        note: "Evidence does not change workflow state until an allowed transition binds it.",
      },
      {
        status: result.duplicate ? 200 : 201,
        headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
      },
    );
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
