import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) throw error;
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store", "Clear-Site-Data": '"cache"' } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
