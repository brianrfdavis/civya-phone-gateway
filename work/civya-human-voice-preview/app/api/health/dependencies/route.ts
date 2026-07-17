import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getRuntimeConfig();
    const providers = Object.fromEntries(
      Object.entries(config.providerReadiness.providers).map(([name, provider]) => [name, {
        mode: provider.mode,
        required: provider.required,
        configured: provider.configured,
        adapter_available: provider.adapterAvailable,
        ready: provider.ready,
        contract: provider.contract,
        issues: provider.issues,
      }]),
    );
    return NextResponse.json(
      {
        status: config.providerReadiness.ready ? "ok" : "not_ready",
        providers,
        degradation: {
          voice: config.features.browserVoice ? "text_fallback" : "disabled",
          pstn: config.features.pstn ? "text_or_human_fallback" : "disabled",
        },
        checked_at: new Date().toISOString(),
      },
      {
        status: config.providerReadiness.ready ? 200 : 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch {
    return NextResponse.json(
      { status: "not_ready", code: "runtime_configuration_invalid" },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
