import { NextRequest } from "next/server";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
import { requestErrorResponse } from "@/lib/security/request";
import { workflowErrorResponse, workflowResponse } from "@/lib/workflows/http.server";
import {
  createSupabaseGovernedWorkflowRepository,
  GovernedWorkflowRepositoryError,
} from "@/lib/workflows/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowInstanceId: string }> },
) {
  try {
    const platform = await requireVerifiedResident();
    const actor = { type: "resident" as const, userId: platform.principal.userId };
    const { workflowInstanceId } = await params;
    const snapshot = await createSupabaseGovernedWorkflowRepository().read({
      actor,
      workflowInstanceId,
    });
    // The authorization-aware database read above revalidates the durable
    // entitlement. The browser session must independently carry the exact
    // case-bound grant before any saved state is returned.
    await requireCaseEntitlement(request, platform, snapshot.caseId);
    return workflowResponse(snapshot);
  } catch (error) {
    if (error instanceof GovernedWorkflowRepositoryError) return workflowErrorResponse(error);
    return requestErrorResponse(error);
  }
}
