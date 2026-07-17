import { NextRequest } from "next/server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
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
  residentWorkflowActionReason,
} from "@/lib/workflows/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_KEYS = new Set([
  "expected_row_version",
  "expectedRowVersion",
  "action_key",
  "actionKey",
  "to_state",
  "toState",
  "correlation_id",
  "correlationId",
  "idempotency_key",
  "idempotencyKey",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowInstanceId: string }> },
) {
  try {
    const platform = await requireVerifiedResident();
    const actor = { type: "resident" as const, userId: platform.principal.userId };
    const { workflowInstanceId } = await params;
    const body = await readJsonObject(request, 12_000);
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported workflow action field: ${key}.`);
    }
    const repository = createSupabaseGovernedWorkflowRepository();
    const before = await repository.read({ actor, workflowInstanceId });
    await requireCaseEntitlement(request, platform, before.caseId);
    if (before.workflowKey !== "payment_plan_navigation") {
      throw new RequestError(409, "This defined workflow has not been activated as a persisted resident service.", "workflow_not_activated");
    }
    const actionKey = bodyString(body, "action_key", "actionKey");
    const toState = bodyString(body, "to_state", "toState");
    const mutation = await repository.advance({
      actor,
      workflowInstanceId,
      expectedRowVersion: bodyInteger(body, "expected_row_version", "expectedRowVersion"),
      actionKey,
      toState,
      reasonCode: residentWorkflowActionReason(actionKey, toState),
      correlationId: bodyString(body, "correlation_id", "correlationId"),
      idempotencyKey: bodyString(body, "idempotency_key", "idempotencyKey")
        || request.headers.get("idempotency-key")
        || "",
      completionEvidenceId: null,
    });
    const snapshot = await repository.read({ actor, workflowInstanceId });
    return workflowResponse(snapshot, mutation);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
