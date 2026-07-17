import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { getByIntent } from "@/lib/knowledge/loader";
import { requirePlatformSession } from "@/lib/security/guards";
import { readJsonObject, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
  await requirePlatformSession();
  const body = await readJsonObject(req, 2_000);
  const intent = typeof body.intent_name === "string" ? body.intent_name.trim().slice(0, 120) : "";
  const item = getByIntent(intent);
  const nonSynthetic = !getRuntimeConfig().syntheticMode;
  if (!item || (nonSynthetic && item.status !== "approved")
    || (nonSynthetic && /fictional|demo|simulat/i.test([
      item.approved_spoken_answer,
      item.long_answer,
      item.next_step_prompt,
      item.disclaimer,
    ].join(" ")))) {
    return NextResponse.json(
      { error: "That approved information is unavailable.", code: "knowledge_unavailable" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({
    intent: item.intent,
    approved_spoken_answer: item.approved_spoken_answer,
    long_answer: item.long_answer,
    disclaimer: item.disclaimer,
    next_step_prompt: item.next_step_prompt,
    source_url: item.source_url,
    last_reviewed: item.last_reviewed,
    status: item.status,
  }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error); }
}
