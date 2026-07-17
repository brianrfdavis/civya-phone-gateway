import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["open", "in_review", "resolved", "closed"]);

export async function GET(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", req.headers.get("host"));
    const { data, error } = await platform.client
      .from("review_tasks")
      .select("id,case_id,reason,priority,status,assigned_to,notes,created_at,cases(status,next_best_action,case_facts(fact_key,fact_value),documents(id,original_file_name,document_type,review_required)),residents(first_name,last_name)")
      .eq("tenant_id", staff.tenant.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const tasks = (data || []).map((row) => {
      const kaseValue = Array.isArray(row.cases) ? row.cases[0] : row.cases;
      const kase = kaseValue as {
        status?: string;
        next_best_action?: string;
        case_facts?: Array<{ fact_key: string; fact_value: unknown }>;
        documents?: Array<Record<string, unknown>>;
      } | null;
      const residentValue = Array.isArray(row.residents) ? row.residents[0] : row.residents;
      const resident = residentValue as { first_name?: string; last_name?: string } | null;
      const facts = Object.fromEntries((kase?.case_facts || []).map((fact) => [fact.fact_key, String(fact.fact_value ?? "")]));
      const storedNextAction = kase?.next_best_action || "";
      const nextBestAction = !staff.tenant.fictional && /fictional|demo|simulated/i.test(storedNextAction)
        ? "Review the case and confirm the next action against an authoritative source."
        : storedNextAction || (staff.tenant.fictional ? "Review the fictional case." : "Review the case.");
      return {
        task_id: row.id,
        case_id: row.case_id,
        reason: row.reason,
        priority: row.priority,
        status: row.status,
        assigned_to: row.assigned_to || "—",
        notes: Array.isArray(row.notes) ? row.notes : [],
        resident_name: `${resident?.first_name || ""} ${resident?.last_name || ""}`.trim() || "(provisional)",
        property_address: facts.property_address || "—",
        pathway: staff.tenant.fictional ? "Fictional guided review" : "County guided review",
        documents: kase?.documents || [],
        checklist_summary: kase?.documents?.some((document) => document.review_required)
          ? "One or more private documents require human review."
          : "No private documents are awaiting review.",
        next_best_action: nextBestAction,
        created_at: row.created_at,
      };
    });
    return NextResponse.json(
      { tasks, tenant: staff.tenant },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", req.headers.get("host"));
    const body = await readJsonObject(req);
    const taskId = typeof body.task_id === "string" ? body.task_id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!taskId || !STATUSES.has(status)) throw new RequestError(400, "A valid task and status are required.");
    const { data: existing, error: readError } = await platform.client
      .from("review_tasks")
      .select("id,notes,row_version")
      .eq("tenant_id", staff.tenant.id)
      .eq("id", taskId)
      .single();
    if (readError) throw readError;
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 1_000) : "";
    const notes = Array.isArray(existing.notes) ? existing.notes : [];
    if (note) notes.push({ text: note, at: new Date().toISOString(), by: platform.principal.userId });
    const { data, error } = await platform.client.from("review_tasks").update({
      status,
      assigned_to: status === "in_review" ? platform.principal.userId : null,
      notes,
      row_version: existing.row_version + 1,
    })
      .eq("id", taskId)
      .eq("tenant_id", staff.tenant.id)
      .eq("row_version", existing.row_version)
      .select("*")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, task: data });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
