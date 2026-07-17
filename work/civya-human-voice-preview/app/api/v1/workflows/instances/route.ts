import { NextRequest } from "next/server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse, RequestError } from "@/lib/security/request";
import {
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
  "case_id",
  "caseId",
  "workflow_key",
  "workflowKey",
  "correlation_id",
  "correlationId",
  "idempotency_key",
  "idempotencyKey",
]);

export async function POST(request: NextRequest) {
  try {
    const platform = await requireVerifiedResident();
    const body = await readJsonObject(request, 12_000);
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported workflow field: ${key}.`);
    }
    const caseId = bodyString(body, "case_id", "caseId");
    const workflowKey = bodyString(body, "workflow_key", "workflowKey");
    const correlationId = bodyString(body, "correlation_id", "correlationId");
    const idempotencyKey = bodyString(body, "idempotency_key", "idempotencyKey")
      || request.headers.get("idempotency-key")
      || "";
    // Cookie binding is a first boundary. The database RPC independently
    // revalidates the current durable entitlement before selecting a workflow
    // definition or writing anything.
    await requireCaseEntitlement(request, platform, caseId);
    const actor = { type: "resident" as const, userId: platform.principal.userId };
    const repository = createSupabaseGovernedWorkflowRepository();
    const mutation = await repository.start({
      actor,
      caseId,
      workflowKey: workflowKey as "payment_plan_navigation",
      correlationId,
      idempotencyKey,
    });
    const snapshot = await repository.read({ actor, workflowInstanceId: mutation.workflowInstanceId });
    return workflowResponse(snapshot, mutation, mutation.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
