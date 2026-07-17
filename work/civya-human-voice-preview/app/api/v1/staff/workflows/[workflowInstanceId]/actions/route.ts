import { NextRequest } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse, RequestError } from "@/lib/security/request";
import {
  bodyInteger,
  bodyObject,
  bodyString,
  workflowErrorResponse,
  workflowResponse,
} from "@/lib/workflows/http.server";
import {
  createSupabaseGovernedWorkflowRepository,
  GovernedWorkflowRepositoryError,
} from "@/lib/workflows/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_KEYS = new Set([
  "expected_row_version", "expectedRowVersion", "action_key", "actionKey",
  "to_state", "toState", "reason_code", "reasonCode", "correlation_id",
  "correlationId", "idempotency_key", "idempotencyKey", "redacted_metadata",
  "redactedMetadata", "completion_evidence_id", "completionEvidenceId",
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
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported workflow action field: ${key}.`);
    }
    const redactedMetadata = bodyObject(body, "redacted_metadata", "redactedMetadata");
    if (("redacted_metadata" in body || "redactedMetadata" in body) && !redactedMetadata) {
      throw new RequestError(400, "redacted_metadata must be a JSON object.");
    }
    const repository = createSupabaseGovernedWorkflowRepository();
    const actor = { type: "staff" as const, userId: platform.principal.userId };
    const before = await repository.read({ actor, workflowInstanceId });
    if (before.tenantId !== staff.tenant.id) {
      throw new RequestError(404, "The workflow was not found in this county workspace.", "not_found");
    }
    const mutation = await repository.advance({
      actor,
      workflowInstanceId,
      expectedRowVersion: bodyInteger(body, "expected_row_version", "expectedRowVersion"),
      actionKey: bodyString(body, "action_key", "actionKey"),
      toState: bodyString(body, "to_state", "toState"),
      reasonCode: bodyString(body, "reason_code", "reasonCode"),
      correlationId: bodyString(body, "correlation_id", "correlationId"),
      idempotencyKey: bodyString(body, "idempotency_key", "idempotencyKey")
        || request.headers.get("idempotency-key")
        || "",
      redactedMetadata,
      completionEvidenceId: bodyString(body, "completion_evidence_id", "completionEvidenceId") || null,
    });
    const snapshot = await repository.read({ actor, workflowInstanceId });
    return workflowResponse(snapshot, mutation);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
