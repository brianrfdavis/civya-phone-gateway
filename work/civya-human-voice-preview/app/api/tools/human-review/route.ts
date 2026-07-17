import { NextResponse } from "next/server";
import { requireVerifiedResident } from "@/lib/security/guards";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

/** Compatibility endpoint; the Realtime client uses the durable dispatcher. */
export async function POST() {
  try {
    await requireVerifiedResident();
    return NextResponse.json(
      { error: "Use the authoritative saved-action flow to flag a review.", saved: false },
      { status: 409 },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
