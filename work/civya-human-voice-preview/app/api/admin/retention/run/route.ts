import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pruneExpiredDemoData } from "@/lib/platform";
import { requireStaff } from "@/lib/security/guards";
import { rateLimitRequest, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Daily retention worker; Vercel Cron supplies `Authorization: Bearer CRON_SECRET`. */
export async function GET(req: NextRequest) {
  try {
    const limited = rateLimitRequest(req, "retention-worker", 6, 60 * 60 * 1_000);
    if (limited) return limited;
    const expected = process.env.CRON_SECRET;
    const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const scheduled = Boolean(expected && supplied && secureEqual(supplied, expected));
    if (!scheduled) {
      if (!expected && (process.env.NODE_ENV === "production" || process.env.VERCEL)) {
        throw new RequestError(503, "Retention worker authentication is not configured.", "service_misconfigured");
      }
      const { staff } = await requireStaff("admin", req.headers.get("host"));
      if (!staff.tenant.fictional || staff.tenant.environment !== "sandbox") {
        throw new RequestError(403, "Manual demo retention is disabled outside the fictional sandbox.", "forbidden");
      }
    }
    const result = await pruneExpiredDemoData();
    return NextResponse.json(
      { ok: result.failures.length === 0, ...result, fictional: true },
      {
        status: result.failures.length === 0 ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
