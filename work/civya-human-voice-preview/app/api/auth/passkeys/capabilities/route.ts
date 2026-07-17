import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { isSupabaseConfigured } from "@/lib/platform";

export async function GET() {
  const configured = isSupabaseConfigured()
    && process.env.CIVYA_AUTH_PASSKEY_ENABLED === "true"
    && getRuntimeConfig().syntheticMode;
  return NextResponse.json(
    {
      available: configured,
      browser_feature_detection_required: true,
      experimental_supabase_adapter: configured,
      unavailable_reason: configured
        ? undefined
        : "Passkeys are not configured for this Civya deployment. Email and configured account providers remain available.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
