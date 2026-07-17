import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { toPublicRuntimeConfig } from "@/lib/config/public";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(toPublicRuntimeConfig(getRuntimeConfig()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Civya runtime configuration is unavailable.", code: "runtime_configuration_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
