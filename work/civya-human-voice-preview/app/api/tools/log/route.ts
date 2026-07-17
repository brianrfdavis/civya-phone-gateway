import { NextRequest, NextResponse } from "next/server";
import { bootstrapAuthorizedResidentCase } from "@/lib/conversation/runtime-bootstrap.server";
import { loadCaseSnapshot } from "@/lib/platform";
import { summarize } from "@/lib/logging/metrics";
import { safeOperationalPayload } from "@/lib/logging/safe-operational-payload";
import type { LoggedEvent } from "@/lib/types";
import { privacySafeKey } from "@/lib/conversation/privacy";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { requirePlatformSession, requireStaff } from "@/lib/security/guards";
import { rateLimitRequest, readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";

const EVENT_TYPES = new Set([
  "session_started",
  "session_ended",
  "reconnect",
  "reconnect_succeeded",
  "continuation",
  "latency",
  "model_used",
  "error",
  "turn_failed",
  "tool_result",
  "turn_resolved",
  "next_step_delivered",
  "doc_checklist_delivered",
  "human_followup_created",
]);
/** POST: append a strict, redacted operational event to Supabase. */
export async function POST(req: NextRequest) {
  try {
    const platform = await requirePlatformSession();
    const limited = rateLimitRequest(req, "operational-log", 240, 60_000, platform.principal.userId);
    if (limited) return limited;
    await requireCaseEntitlementSession(req, platform);
    const body = await readJsonObject(req, 8_000);
    const type = typeof body.type === "string" ? body.type.slice(0, 80) : "";
    if (!EVENT_TYPES.has(type)) throw new RequestError(400, "Unsupported operational event type.");
    const bootstrap = await bootstrapAuthorizedResidentCase(req, platform);
    if (!bootstrap.active_case || !bootstrap.resident) throw new RequestError(404, "No active case.");
    await requireCaseEntitlement(req, platform, bootstrap.active_case.id);
    const snapshot = await loadCaseSnapshot(platform, bootstrap.active_case.id);
    const sessionId = typeof body.session_id === "string" ? privacySafeKey(body.session_id) : "unknown";
    const turnId = typeof body.turn_id === "string" && body.turn_id
      ? privacySafeKey(body.turn_id)
      : undefined;
    const now = new Date().toISOString();
    await platform.appendAuditEvent({
      tenantId: snapshot.tenantId,
      residentId: snapshot.residentId,
      caseId: snapshot.id,
      eventType: type,
      source: "agent",
      payload: {
        session_id: sessionId,
        ...(turnId ? { turn_id: turnId } : {}),
        ...safeOperationalPayload(body.data),
      },
    });
    return NextResponse.json({ ok: true, ts: now });
  } catch (error) {
    return requestErrorResponse(error);
  }
}

/** GET: tenant-scoped metrics for invited reviewer/admin accounts. */
export async function GET(req: NextRequest) {
  try {
    const { platform, staff } = await requireStaff("reviewer", req.headers.get("host"));
    const { data, error } = await platform.client
      .from("audit_events")
      .select("created_at,event_type,redacted_payload")
      .eq("tenant_id", staff.tenant.id)
      .order("created_at", { ascending: false })
      .limit(2_000);
    if (error) throw error;
    const events: LoggedEvent[] = (data || []).map((row) => {
      const payload = row.redacted_payload && typeof row.redacted_payload === "object" && !Array.isArray(row.redacted_payload)
        ? row.redacted_payload as Record<string, unknown>
        : {};
      return {
        ts: row.created_at,
        session_id: typeof payload.session_id === "string" ? payload.session_id : "unknown",
        turn_id: typeof payload.turn_id === "string" ? payload.turn_id : undefined,
        type: row.event_type,
        ...payload,
      };
    });
    return NextResponse.json(summarize(events), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
