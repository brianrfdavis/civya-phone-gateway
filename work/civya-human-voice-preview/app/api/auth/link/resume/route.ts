import { NextRequest, NextResponse } from "next/server";
import { createRequestPlatform } from "@/lib/platform";
import { clearAccountResume, readAccountResume } from "@/lib/auth/flow-state";

export async function GET(req: NextRequest) {
  const platform = await createRequestPlatform().catch(() => null);
  const resume = readAccountResume(req);
  if (!platform?.principal.isVerified || !resume) {
    return NextResponse.json(
      { account: { state: platform?.principal.isVerified ? "verified" : "none" }, entitlement: { state: "required" } },
      { status: platform?.principal.isVerified ? 200 : 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const response = NextResponse.json(
    {
      account: { state: "verified", method: resume.method },
      entitlement: { state: "required" },
      resume: { pending_task: resume.pendingTask },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  clearAccountResume(response);
  return response;
}
