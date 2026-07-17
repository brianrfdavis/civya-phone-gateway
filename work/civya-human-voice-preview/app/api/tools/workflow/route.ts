import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { nextStep } from "@/lib/intake/engine";
import { requirePlatformSession } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
  await requirePlatformSession();
  if (!getRuntimeConfig().syntheticMode) {
    return NextResponse.json(
      { error: "This compatibility workflow is unavailable.", code: "workflow_unavailable" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await readJsonObject(req, 4_000);
  const currentState = typeof body.current_state === "string" ? body.current_state.slice(0, 120) : "";
  const userAnswer = typeof body.user_answer === "string" ? body.user_answer.slice(0, 2_000) : "";
  const result = nextStep(currentState, userAnswer);

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error); }
}
