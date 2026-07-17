import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  appendTurn,
  bootstrapSession,
  commitTurnResult,
  createAdminPlatform,
  finishConversation,
  loadCaseSnapshot,
  PlatformDataError,
  type CaseSnapshot,
} from "@/lib/platform";
import { nextIntakeQuestion, normalizeIntakeFact } from "@/lib/conversation/engine";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { requireVerifiedResident } from "@/lib/security/guards";
import { readJsonObject, RequestError, requestErrorResponse } from "@/lib/security/request";
import { evaluateRouting, type RoutingInput } from "@/lib/wayne-county/routingRules";

export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

const UNSUPPORTED_FACT_MUTATIONS = new Set([
  "lookup_property_status",
  "create_or_update_resident",
  "create_or_update_case",
  "upload_document_metadata",
  "classify_uploaded_document",
  "send_case_link",
]);

const DEFAULT_CHECKLIST = [
  { document_type: "tax_notice", label: "Property-tax notice" },
  { document_type: "photo_id", label: "Photo identification" },
  { document_type: "proof_of_occupancy", label: "Proof of occupancy" },
] as const;

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function idempotencyKey(req: NextRequest, body: JsonObject, tool: string, caseId: string): string {
  return text(req.headers.get("idempotency-key") || body.idempotency_key, 200)
    || `${tool}:${caseId}`;
}

async function updateCaseVersioned(
  admin: ReturnType<typeof createAdminPlatform>["client"],
  snapshot: CaseSnapshot,
  patch: JsonObject,
): Promise<number> {
  const { data, error } = await admin
    .from("cases")
    .update({ ...patch, row_version: snapshot.rowVersion + 1 })
    .eq("id", snapshot.id)
    .eq("resident_id", snapshot.residentId)
    .eq("tenant_id", snapshot.tenantId)
    .eq("row_version", snapshot.rowVersion)
    .select("row_version")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlatformDataError("The case changed while this action was saving.", "40001", true);
  return Number(data.row_version);
}

function intakeSummary(factCount: number, nextQuestion?: string): string {
  const collected = `${factCount} confirmed intake ${factCount === 1 ? "fact" : "facts"}`;
  return nextQuestion
    ? `${collected}. The next guided question is pending.`
    : `${collected}. No guided question is pending.`;
}

function intakeReceiptKey(clientTurnId: string, field: string, value: string, sourceText: string): string {
  const digest = createHash("sha256")
    .update(["civya-intake-v1", field, value, sourceText].join("\0"))
    .digest("hex");
  return `fast-user:${clientTurnId.slice(0, 110)}:${digest}`;
}

/**
 * Explicit saved actions only. Ordinary facts always go through the
 * authoritative conversation-turn transaction; this route never falls back
 * to the legacy JSON case store.
 */
export async function POST(req: NextRequest) {
  try {
    const platform = await requireVerifiedResident();
    const entitlement = await requireCaseEntitlementSession(req, platform);
    await platform.assertSyntheticSandboxCase(entitlement.caseId);
    const body = await readJsonObject(req);
    const tool = text(body.tool, 100);
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? body.args as JsonObject
      : {};
    if (!tool) throw new RequestError(400, "A tool name is required.");

    const bootstrap = await bootstrapSession(platform);
    if (!bootstrap.active_case || !bootstrap.conversation) {
      throw new RequestError(404, "No active case is available.", "case_not_found");
    }
    await requireCaseEntitlement(req, platform, bootstrap.active_case.id);
    const suppliedCaseId = text(args.case_id || body.case_id, 100);
    if (suppliedCaseId && suppliedCaseId !== bootstrap.active_case.id) {
      throw new RequestError(403, "The case does not belong to this resident session.", "forbidden");
    }
    let snapshot = await loadCaseSnapshot(platform, bootstrap.active_case.id);
    const admin = createAdminPlatform().client;
    const key = idempotencyKey(req, body, tool, snapshot.id);
    const facts = Object.fromEntries(snapshot.confirmedFacts.map((fact) => [fact.key, fact.value]));

    if (tool === "save_intake_answer") {
      const field = text(args.field, 80);
      const sourceText = text(args.source_text, 12_000);
      const clientTurnId = text(body.client_turn_id || args.client_turn_id, 200);
      const providerItemId = text(body.provider_item_id || args.provider_item_id, 200);
      const channel = body.channel === "text" ? "text" : "voice";
      if (!clientTurnId || !sourceText) {
        throw new RequestError(400, "A stable client turn and the resident's source words are required.");
      }
      const captured = normalizeIntakeFact(field, sourceText);
      if (!captured) {
        return NextResponse.json({
          saved: false,
          verification_state: "not_confirmed",
          spoken_text: "I don't want to save that as an answer. Could you say the answer in a different way?",
          assistant_followup: "I don't want to save that as an answer. Could you say the answer in a different way?",
          fictional: true,
        });
      }

      const stableTurnKey = intakeReceiptKey(clientTurnId, captured.key, captured.value, sourceText);
      let persisted;
      try {
        persisted = await appendTurn(platform, {
          conversation_id: bootstrap.conversation.id,
          provider_item_id: providerItemId || undefined,
          client_turn_id: clientTurnId,
          transcript: sourceText,
          channel,
          idempotency_key: stableTurnKey,
        });
      } catch (error) {
        // A different receipt digest with the same client turn hits the
        // conversation/client-turn uniqueness boundary. Fail closed instead
        // of racing two interpretations of one resident utterance.
        if (error instanceof PlatformDataError && error.code === "23505") {
          throw new RequestError(
            409,
            "That turn was already received with different intake data.",
            "idempotency_conflict",
          );
        }
        throw error;
      }
      if (persisted.duplicate && persisted.processingStatus === "committed" && persisted.processingResult) {
        if (persisted.idempotencyKey !== stableTurnKey) {
          throw new RequestError(
            409,
            "That turn was already committed with different intake data.",
            "idempotency_conflict",
          );
        }
        return NextResponse.json({
          ...persisted.processingResult,
          saved: true,
          spoken_text: persisted.processingResult.spoken_response,
          assistant_followup: persisted.processingResult.spoken_response,
          fictional: true,
          duplicate: true,
        });
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = nextIntakeQuestion({
          ...bootstrap.resume_context,
          confirmed_facts: snapshot.confirmedFacts,
          conversation_summary: snapshot.resumeSummary || bootstrap.resume_context.conversation_summary,
          current_workflow_state: snapshot.workflowState,
          next_question: snapshot.nextQuestion,
        });
        if (!current || current.key !== captured.key) {
          const spokenText = current
            ? `I didn't save that because it doesn't answer the current question. ${current.question}`
            : "I didn't save that because the guided intake is already complete.";
          return NextResponse.json({
            saved: false,
            verification_state: "unexpected_field",
            spoken_text: spokenText,
            assistant_followup: spokenText,
            fictional: true,
          });
        }
        const confirmed = [
          ...snapshot.confirmedFacts.filter((fact) => fact.key !== captured.key),
          { key: captured.key, value: captured.value, confirmed_at: new Date().toISOString() },
        ];
        const next = nextIntakeQuestion({
          ...bootstrap.resume_context,
          confirmed_facts: confirmed,
          conversation_summary: snapshot.resumeSummary || bootstrap.resume_context.conversation_summary,
          current_workflow_state: snapshot.workflowState,
          next_question: snapshot.nextQuestion,
        });
        const spokenText = next
          ? `Got it. ${next.question}`
          : "Got it. Your fictional demo intake is complete, and a reviewer can check the next step.";
        try {
          const committed = await commitTurnResult(platform, {
            userTurnId: persisted.id,
            expectedCaseVersion: snapshot.rowVersion,
            conversationId: bootstrap.conversation.id,
            clientTurnId,
            spokenResponse: spokenText,
            nextQuestion: next?.question,
            workflowState: next ? `awaiting_${next.key}` : "intake_complete",
            caseStatus: next ? "intake_in_progress" : "packet_ready",
            conversationSummary: intakeSummary(confirmed.length, next?.question),
            interactionState: "continue",
            confirmedFacts: { [captured.key]: captured.value },
          });
          return NextResponse.json({
            ...committed,
            saved: true,
            saved_field: captured.key,
            spoken_text: spokenText,
            assistant_followup: spokenText,
            fictional: true,
          });
        } catch (error) {
          if (attempt === 0 && error instanceof PlatformDataError && error.retryable) {
            snapshot = await loadCaseSnapshot(platform, bootstrap.active_case.id);
            continue;
          }
          throw error;
        }
      }
    }

    if (UNSUPPORTED_FACT_MUTATIONS.has(tool)) {
      return NextResponse.json(
        { error: "This fact must be handled by Civya's authoritative saved-turn flow.", saved: false },
        { status: 409 },
      );
    }

    if (tool === "get_case_summary") {
      return NextResponse.json({
        case_id: snapshot.id,
        case: {
          id: snapshot.id,
          status: snapshot.status,
          intake_facts: facts,
          next_best_action: snapshot.nextQuestion || snapshot.nextBestAction,
        },
        checklist: snapshot.checklist,
        fictional: true,
      });
    }

    if (tool === "screen_program_fit") {
      const result = evaluateRouting({
        municipality: text(args.municipality),
        relationship: (text(args.relationship) || "owner") as RoutingInput["relationship"],
        ownerOccupied: args.owner_occupied === true,
        preOnFile: (text(args.pre_on_file) || "unknown") as RoutingInput["preOnFile"],
        delinquentYears: Array.isArray(args.delinquent_years)
          ? args.delinquent_years.map(Number).filter(Number.isFinite)
          : [],
        foreclosureStage: (text(args.foreclosure_stage) || "unknown") as RoutingInput["foreclosureStage"],
        noticesReceived: Array.isArray(args.notices_received) ? args.notices_received.map(String) : [],
        householdSignals: Array.isArray(args.household_signals) ? args.household_signals.map(String) : [],
        documentsReady: args.documents_ready === true,
        legalComplexity: Array.isArray(args.legal_complexity) ? args.legal_complexity.map(String) : [],
      });
      return NextResponse.json({ ...result, fictional: true, determination: false });
    }

    if (tool === "generate_document_checklist") {
      for (const item of DEFAULT_CHECKLIST) {
        const { error } = await admin.from("checklist_items").upsert({
          tenant_id: snapshot.tenantId,
          resident_id: snapshot.residentId,
          case_id: snapshot.id,
          document_type: item.document_type,
          label: item.label,
          description: "Fictional demo checklist item; a reviewer confirms whether it is actually required.",
          status: "missing",
          idempotency_key: `${key}:${item.document_type}`.slice(0, 200),
        }, { onConflict: "case_id,document_type" });
        if (error) throw error;
      }
      return NextResponse.json({
        checklist: DEFAULT_CHECKLIST.map((item) => ({ ...item, status: "missing" })),
        review_required: true,
        fictional: true,
      });
    }

    if (tool === "get_missing_documents") {
      const { data, error } = await platform.client
        .from("checklist_items")
        .select("document_type,label,status")
        .eq("case_id", snapshot.id)
        .in("status", ["missing", "needs_review"]);
      if (error) throw error;
      return NextResponse.json({ missing_documents: data || [], fictional: true });
    }

    if (tool === "get_uploaded_documents") {
      const { data, error } = await platform.client
        .from("documents")
        .select("id,original_file_name,document_type,scan_status,review_required,created_at")
        .eq("case_id", snapshot.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return NextResponse.json({ documents: data || [], fictional: true });
    }

    if (tool === "record_contact_consent") {
      const consentType = ["sms", "email", "save_progress", "document_upload", "reminder"]
        .includes(text(args.consent_type)) ? text(args.consent_type) : "reminder";
      const { data, error } = await admin.from("consent").upsert({
        tenant_id: snapshot.tenantId,
        resident_id: snapshot.residentId,
        case_id: snapshot.id,
        consent_type: consentType,
        consent_text: "Resident consented in the fictional Civya county sandbox.",
        granted: args.granted !== false,
        source: "resident",
        idempotency_key: key,
      }, { onConflict: "resident_id,idempotency_key" }).select("id,granted").single();
      if (error) throw error;
      return NextResponse.json({ success: true, consent_record_id: data.id, granted: data.granted, fictional: true });
    }

    if (tool === "schedule_sms_reminder") {
      const { data: consent, error: consentError } = await admin.from("consent")
        .select("id")
        .eq("case_id", snapshot.id)
        .eq("granted", true)
        .in("consent_type", ["sms", "reminder"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (consentError) throw consentError;
      if (!consent) throw new RequestError(409, "Reminder consent is required first.", "consent_required");
      const hours = Math.max(1, Math.min(720, Number(args.hours_from_now) || 24));
      const scheduledFor = new Date(Date.now() + hours * 3_600_000).toISOString();
      const { data, error } = await admin.from("reminders").upsert({
        tenant_id: snapshot.tenantId,
        resident_id: snapshot.residentId,
        case_id: snapshot.id,
        consent_id: consent.id,
        channel: "sms",
        scheduled_for: scheduledFor,
        message_type: text(args.message_type, 80) || "case_reminder",
        redacted_message: "Fictional Civya reminder: return to your saved demo case.",
        status: "scheduled",
        idempotency_key: key,
      }, { onConflict: "case_id,idempotency_key" }).select("id,scheduled_for,status").single();
      if (error) throw error;
      return NextResponse.json({ success: true, reminder_id: data.id, scheduled_for: data.scheduled_for, status: data.status, fictional: true });
    }

    if ([
      "create_human_review_task",
      "create_human_followup_request",
      "flag_case_for_review",
      "flag_for_human_review",
      "route_to_partner",
      "schedule_callback",
    ].includes(tool)) {
      const reason = text(args.reason || args.summary, 500) ||
        (tool === "schedule_callback" ? "Resident requested a fictional callback." : "Resident requested fictional human review.");
      const { data, error } = await admin.from("review_tasks").upsert({
        tenant_id: snapshot.tenantId,
        resident_id: snapshot.residentId,
        case_id: snapshot.id,
        reason,
        priority: ["normal", "high", "urgent"].includes(text(args.priority)) ? text(args.priority) : "normal",
        status: "open",
        notes: [],
        dedupe_key: `${tool}:${key}`.slice(0, 200),
      }, { onConflict: "case_id,dedupe_key" }).select("id,status").single();
      if (error) throw error;
      await updateCaseVersioned(admin, snapshot, {
        review_required: true,
        review_reason: reason,
        status: "human_review_required",
        next_best_action: "Invited demo staff review this fictional request.",
      });
      return NextResponse.json({ success: true, task_id: data.id, status: data.status, external_outreach: false, fictional: true });
    }

    if (["generate_packet_summary", "validate_packet_readiness", "prepare_simulated_submission"].includes(tool)) {
      const missing = snapshot.checklist.filter((item) => item.status === "missing" || item.status === "needs_review");
      const ready = missing.length === 0 && snapshot.confirmedFacts.length > 0;
      if (tool !== "validate_packet_readiness") {
        await updateCaseVersioned(admin, snapshot, {
          status: ready ? "simulated_submission_ready" : snapshot.status,
          next_best_action: ready
            ? "Review the fictional packet, then run the simulated submission."
            : "Complete or review the remaining fictional checklist items.",
          completion_state: { ...snapshot.workflowDetails, packet: { ready, fictional: true } },
        });
      }
      return NextResponse.json({ ready, missing, summary: `Fictional packet with ${snapshot.confirmedFacts.length} confirmed facts.`, fictional: true });
    }

    if (["submit_demo_packet", "submit_demo_intake", "generate_demo_confirmation"].includes(tool)) {
      const confirmation = `DEMO-SUB-${snapshot.id.slice(0, 8).toUpperCase()}`;
      const { error } = await admin.from("simulated_transactions").upsert({
        tenant_id: snapshot.tenantId,
        resident_id: snapshot.residentId,
        case_id: snapshot.id,
        kind: "submission",
        status: "completed",
        fictional: true,
        idempotency_key: key,
        result: { confirmation_number: confirmation, official: false },
      }, { onConflict: "case_id,kind,idempotency_key" });
      if (error) throw error;
      await updateCaseVersioned(admin, snapshot, {
        status: "simulated_submitted",
        next_best_action: "Fictional submission complete. No county transaction occurred.",
      });
      return NextResponse.json({ ok: true, confirmation_number: confirmation, official: false, fictional: true });
    }

    if (tool === "calculate_demo_payment_options" || tool === "simulate_payment_path") {
      return NextResponse.json({
        options: [
          { months: 12, monthly_amount_usd: 100 },
          { months: 24, monthly_amount_usd: 55 },
        ],
        simulated: true,
        official_offer: false,
      });
    }

    if (tool === "create_demo_payment_plan") {
      const cents = Math.round(Number(args.monthly_amount_usd) * 100);
      if (!Number.isSafeInteger(cents) || cents < 1) throw new RequestError(400, "Enter a fictional monthly amount greater than zero.");
      const { error } = await admin.from("simulated_transactions").upsert({
        tenant_id: snapshot.tenantId,
        resident_id: snapshot.residentId,
        case_id: snapshot.id,
        kind: "payment",
        status: "pending",
        simulated_amount_cents: cents,
        fictional: true,
        idempotency_key: key,
        result: { monthly_amount_usd: cents / 100, official: false },
      }, { onConflict: "case_id,kind,idempotency_key" });
      if (error) throw error;
      await updateCaseVersioned(admin, snapshot, { status: "simulated_payment_pending" });
      return NextResponse.json({ success: true, status: "pending", monthly_amount_usd: cents / 100, fictional: true });
    }

    if (tool === "submit_demo_payment") {
      const { data: transaction, error: findError } = await admin.from("simulated_transactions")
        .select("id,result")
        .eq("case_id", snapshot.id)
        .eq("kind", "payment")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (findError) throw findError;
      if (!transaction) throw new RequestError(409, "Create the fictional payment plan first.");
      const confirmation = `DEMO-PAY-${snapshot.id.slice(0, 8).toUpperCase()}`;
      const { error } = await admin.from("simulated_transactions").update({
        status: "completed",
        result: { ...(transaction.result as JsonObject), confirmation_number: confirmation, official: false },
      }).eq("id", transaction.id);
      if (error) throw error;
      await updateCaseVersioned(admin, snapshot, { status: "simulated_payment_completed" });
      return NextResponse.json({ success: true, status: "completed", confirmation_number: confirmation, fictional: true });
    }

    if (tool === "get_demo_payment_status") {
      const { data, error } = await platform.client.from("simulated_transactions")
        .select("status,simulated_amount_cents,result,updated_at")
        .eq("case_id", snapshot.id)
        .eq("kind", "payment")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json({ status: data?.status || "not_started", transaction: data, fictional: true });
    }

    if (tool === "end_or_save_conversation") {
      await finishConversation(platform, bootstrap.conversation.id, snapshot.resumeSummary);
      return NextResponse.json({
        success: true,
        final: true,
        assistant_followup: "I've saved your fictional demo progress. You can return and continue from the same step.",
        continue_conversation: false,
      });
    }

    throw new RequestError(400, `Unknown or unavailable action: ${tool}`);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
