import { NextRequest } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse, RequestError } from "@/lib/security/request";
import {
  bodyInteger,
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

const SEVERITIES = new Set(["low", "normal", "high", "urgent"]);
const ALLOWED_KEYS = new Set([
  "expected_row_version", "expectedRowVersion", "action_key", "actionKey",
  "exception_type", "exceptionType", "severity", "reason_code", "reasonCode",
  "redacted_summary", "redactedSummary", "correlation_id", "correlationId",
  "dedupe_key", "dedupeKey", "idempotency_key", "idempotencyKey",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowInstanceId: string }> },
) {
  try {
    const { platform, staff } = await requireStaff("reviewer", request.headers.get("host"));
    const { workflowInstanceId } = await params;
    const body = await readJsonObject(request, 8_000);
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported exception field: ${key}.`);
    }
    const severity = bodyString(body, "severity");
    if (!SEVERITIES.has(severity)) throw new RequestError(400, "Choose a valid exception severity.");
    const actor = { type: "staff" as const, userId: platform.principal.userId };
    const repository = createSupabaseGovernedWorkflowRepository();
    const before = await repository.read({ actor, workflowInstanceId });
    if (before.tenantId !== staff.tenant.id) {
      throw new RequestError(404, "The workflow was not found in this county workspace.", "not_found");
    }
    const raised = await repository.raiseException({
      actor,
      workflowInstanceId,
      expectedRowVersion: bodyInteger(body, "expected_row_version", "expectedRowVersion"),
      actionKey: bodyString(body, "action_key", "actionKey"),
      exceptionType: bodyString(body, "exception_type", "exceptionType"),
      severity: severity as "low" | "normal" | "high" | "urgent",
      reasonCode: bodyString(body, "reason_code", "reasonCode"),
      redactedSummary: bodyString(body, "redacted_summary", "redactedSummary"),
      assignedToAuthUserId: platform.principal.userId,
      correlationId: bodyString(body, "correlation_id", "correlationId"),
      dedupeKey: bodyString(body, "dedupe_key", "dedupeKey"),
      idempotencyKey: bodyString(body, "idempotency_key", "idempotencyKey")
        || request.headers.get("idempotency-key")
        || "",
    });
    const snapshot = await repository.read({ actor, workflowInstanceId });
    return workflowResponse(snapshot, raised, raised.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
