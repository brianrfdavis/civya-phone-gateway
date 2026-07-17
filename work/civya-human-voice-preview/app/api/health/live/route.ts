import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let release = process.env.CIVYA_RELEASE_VERSION || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "development";
  try {
    release = getRuntimeConfig().releaseVersion;
  } catch {
    // Liveness intentionally proves only that the process can serve traffic.
  }
  return NextResponse.json(
    { status: "live", release, checked_at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
