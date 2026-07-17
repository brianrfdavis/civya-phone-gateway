import { NextRequest, NextResponse } from "next/server";
import { readRuntimeConfig } from "@/lib/config/runtime";
import { runSyntheticPaymentPlanSlice } from "@/lib/workflows/synthetic-slice";
import { rateLimitRequest, RequestError, requestErrorResponse } from "@/lib/security/request";
import { requireSyntheticSandboxHost } from "@/lib/security/synthetic-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const limited = rateLimitRequest(req, "synthetic-slice", 5, 60_000);
  if (limited) return limited;
  try {
    const config = readRuntimeConfig();
    if (!config.syntheticMode || config.environment === "production") {
      return NextResponse.json(
        { error: "Synthetic workflows are unavailable in production.", code: "synthetic_mode_disabled" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    requireSyntheticSandboxHost(req, config);
    const result = runSyntheticPaymentPlanSlice();
    return NextResponse.json(
      {
        batch_id: result.batchId,
        resident_id: result.residentId,
        case_id: result.caseId,
        workflow: result.workflow,
        operation_id: result.operationId,
        evidence: result.evidence,
        correlation_id: result.correlationId,
        chronology: result.chronology,
        staff_exception: result.staffException,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestError) return requestErrorResponse(error);
    return NextResponse.json(
      { error: "The synthetic slice is not configured safely.", code: "runtime_configuration_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
