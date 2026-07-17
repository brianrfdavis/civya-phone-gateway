import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireStaff } from "@/lib/security/guards";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { platform, staff: result } = await requireStaff("reviewer", request.headers.get("host"));
    const [casesResult, verifiedResult, reviewsResult] = await Promise.all([
      platform.client
        .from("cases")
        .select("id,status,urgency_level,next_best_action,updated_at,residents(first_name,last_name),case_facts(fact_key,fact_value)")
        .eq("tenant_id", result.tenant.id)
        .order("updated_at", { ascending: false })
        .limit(20),
      platform.client
        .from("case_outcome_projections")
        .select("case_id", { count: "exact", head: true })
        .eq("tenant_id", result.tenant.id)
        .eq("current_status", "verified"),
      platform.client
        .from("review_tasks")
        .select("id,priority,reason,status,residents(first_name,last_name)")
        .eq("tenant_id", result.tenant.id)
        .in("status", ["open", "in_review"])
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (casesResult.error) throw casesResult.error;
    if (reviewsResult.error) throw reviewsResult.error;
    if (verifiedResult.error) throw verifiedResult.error;
    const cases = (casesResult.data || []).map((kase) => {
      const residentValue = Array.isArray(kase.residents) ? kase.residents[0] : kase.residents;
      const resident = residentValue as { first_name?: string; last_name?: string } | null;
      const facts = Object.fromEntries((kase.case_facts || []).map((fact) => [fact.fact_key, String(fact.fact_value ?? "")]));
      const legacySimulatedStatus = !result.tenant.fictional && String(kase.status).startsWith("simulated_");
      return {
        id: kase.id,
        case_id: kase.id,
        resident_name: `${resident?.first_name || ""} ${resident?.last_name || ""}`.trim() || "(provisional)",
        property_address: facts.property_address,
        status: legacySimulatedStatus ? "human_review_required" : kase.status,
        urgency: kase.urgency_level,
        next_best_action: legacySimulatedStatus
          ? "A staff review is required before this legacy status can be treated as operational."
          : kase.next_best_action,
        updated_at: kase.updated_at,
      };
    });
    const reviews = (reviewsResult.data || []).map((review) => {
      const residentValue = Array.isArray(review.residents) ? review.residents[0] : review.residents;
      const resident = residentValue as { first_name?: string; last_name?: string } | null;
      return {
        id: review.id,
        task_id: review.id,
        priority: review.priority,
        reason: review.reason,
        status: review.status,
        resident_name: `${resident?.first_name || ""} ${resident?.last_name || ""}`.trim() || "(provisional)",
      };
    });
    return NextResponse.json(
      {
        authenticated: true,
        authorized: true,
        user: {
          display_name: result.principal.email?.split("@")[0] || "County reviewer",
          email: result.principal.email,
          role: result.role,
        },
        staff: {
          name: result.principal.email?.split("@")[0] || "County reviewer",
          email: result.principal.email,
          role: result.role,
        },
        tenant: result.tenant,
        summary: {
          open_reviews: result.counts.openReviews,
          active_cases: result.counts.activeCases,
          documents_needing_review: result.counts.documentsNeedingReview,
        },
        metrics: {
          active_cases: result.counts.activeCases,
          review_queue: result.counts.openReviews,
          documents_needing_review: result.counts.documentsNeedingReview,
          verified_outcomes: verifiedResult.count || 0,
        },
        cases,
        review_tasks: reviews,
        workspace: {
          environment: result.tenant.environment,
          fictional: result.tenant.fictional,
        },
        sandbox: {
          active: result.tenant.environment === "sandbox" && result.tenant.fictional,
          fictional: result.tenant.fictional,
        },
        activation: {
          county_source: getRuntimeConfig().providers.countySource,
          payment_handoff: getRuntimeConfig().providers.paymentHandoff,
          identity_proofing: getRuntimeConfig().providers.identityProofing,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
