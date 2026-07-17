import { requireStaff } from "@/lib/security/guards";
import { RequestError, requestErrorResponse } from "@/lib/security/request";
import { workflowErrorResponse, workflowResponse } from "@/lib/workflows/http.server";
import {
  createSupabaseGovernedWorkflowRepository,
  GovernedWorkflowRepositoryError,
} from "@/lib/workflows/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workflowInstanceId: string }> },
) {
  try {
    const { platform, staff } = await requireStaff("reviewer", request.headers.get("host"));
    const { workflowInstanceId } = await params;
    const snapshot = await createSupabaseGovernedWorkflowRepository().read({
      actor: { type: "staff", userId: platform.principal.userId },
      workflowInstanceId,
    });
    if (snapshot.tenantId !== staff.tenant.id) {
      throw new RequestError(404, "The workflow was not found in this county workspace.", "not_found");
    }
    return workflowResponse(snapshot);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
