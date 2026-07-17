import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CaseQueryRow {
  id: string;
  status: string;
  urgency_level: string;
  next_best_action: string;
  review_required: boolean;
  updated_at: string;
  residents: { first_name?: string; last_name?: string; email?: string; phone?: string } | Array<{ first_name?: string; last_name?: string; email?: string; phone?: string }> | null;
  case_facts: Array<{ fact_key: string; fact_value: unknown }>;
  documents: Array<{ id: string; review_required?: boolean }>;
  simulated_transactions?: Array<{ kind: string; status: string; result?: { confirmation_number?: string } | null }>;
}

export async function GET(request: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", request.headers.get("host"));
    const select = staff.tenant.fictional
      ? "id,resident_id,status,urgency_level,next_best_action,review_required,updated_at,residents(first_name,last_name,email,phone),case_facts(fact_key,fact_value),documents(id,review_required),simulated_transactions(kind,status,result)"
      : "id,resident_id,status,urgency_level,next_best_action,review_required,updated_at,residents(first_name,last_name,email,phone),case_facts(fact_key,fact_value),documents(id,review_required)";
    const { data: rawCases, error } = await platform.client
      .from("cases")
      .select(select as "*")
      .eq("tenant_id", staff.tenant.id)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    const cases = (rawCases || []) as unknown as CaseQueryRow[];
    const rows = cases.map((row) => {
      const residentValue = Array.isArray(row.residents) ? row.residents[0] : row.residents;
      const resident = residentValue as { first_name?: string; last_name?: string; email?: string; phone?: string } | null;
      const facts = Object.fromEntries((row.case_facts || []).map((fact) => [fact.fact_key, String(fact.fact_value ?? "")]));
      const transactions = staff.tenant.fictional
        ? row.simulated_transactions || []
        : [];
      const submission = transactions.find((item) => item.kind === "submission");
      const payment = transactions.find((item) => item.kind === "payment");
      const confirmation = (submission?.result as { confirmation_number?: string } | null)?.confirmation_number
        || (payment?.result as { confirmation_number?: string } | null)?.confirmation_number
        || "—";
      const legacySimulatedStatus = !staff.tenant.fictional && row.status.startsWith("simulated_");
      const status = legacySimulatedStatus ? "human_review_required" : row.status;
      return {
        case_id: row.id,
        resident_name: `${resident?.first_name || ""} ${resident?.last_name || ""}`.trim() || "(provisional)",
        contact: resident?.phone || resident?.email || "—",
        property_address: facts.property_address || "—",
        status,
        urgency: row.urgency_level,
        pathway: staff.tenant.fictional ? "Fictional guided review" : "County guided review",
        intake: `${Object.keys(facts).length}/10`,
        missing_count: 0,
        uploaded_count: row.documents?.length || 0,
        packet_ready: staff.tenant.fictional
          ? ["packet_ready", "simulated_submission_ready", "simulated_submitted", "simulated_payment_pending", "simulated_payment_completed"].includes(row.status)
          : row.status === "packet_ready",
        ...(staff.tenant.fictional ? {
          submission_status: submission?.status || "not_started",
          payment_status: payment?.status || "not_started",
          confirmation,
        } : {}),
        review_required: legacySimulatedStatus || row.review_required || row.documents?.some((document) => document.review_required) || false,
        next_best_action: legacySimulatedStatus
          ? "A staff review is required before this legacy status can be treated as operational."
          : row.next_best_action,
        last_activity: row.updated_at,
      };
    });
    return NextResponse.json(
      { cases: rows, tenant: staff.tenant },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
