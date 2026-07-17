/**
 * Realtime sees read-only lookups and explicit resident-requested actions.
 * Ordinary intake facts and conversation endings are committed by the
 * authoritative turn endpoint and are deliberately absent from this list.
 * The larger dispatcher surface remains only for guarded compatibility.
 */
export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "get_cached_answer",
    description:
      "Resident ASKED a question → call this with their words. On a hit, speak assistant_followup verbatim. Do NOT call for facts the resident gives you.",
    parameters: {
      type: "object",
      properties: {
        user_message: { type: "string" },
      },
      required: ["user_message"],
    },
  },
  {
    type: "function",
    name: "lookup_property_status",
    description:
      "Explicit read-only lookup against fictional demo property data. Ordinary address memory is handled by the authoritative turn endpoint; do not claim this lookup saved anything.",
    parameters: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
  },
  {
    type: "function",
    name: "screen_program_fit",
    description:
      "Deterministic routing. Pass every fact you know; narrate the returned outcomes only — never decide eligibility yourself. Use this after owner-occupant, notice/deadline, delinquency years, PRE/homestead, hardship, and prior-program facts are known or when the resident asks what path fits.",
    parameters: {
      type: "object",
      properties: {
        municipality: { type: "string" },
        relationship: { type: "string", enum: ["owner", "occupant", "heir", "renter", "family_member", "former_owner", "unknown"] },
        owner_occupied: { type: "boolean" },
        foreclosure_stage: { type: "string", enum: ["current", "delinquent", "forfeited", "show_cause", "foreclosure_judgment_pending", "redeemable_before_march_31", "foreclosed_after_april_1", "auctioned", "unknown"] },
        notices_received: { type: "array", items: { type: "string" } },
        household_signals: { type: "array", items: { type: "string", enum: ["low_income", "senior", "disabled", "veteran", "first_responder", "unemployed", "widowed", "medical_burden", "hardship"] } },
        legal_complexity: { type: "array", items: { type: "string", enum: ["deceased_owner", "probate", "title_dispute", "divorce", "land_contract", "bankruptcy", "eviction", "fraud", "legal_dispute"] } },
        delinquent_years: { type: "array", items: { type: "string" } },
        applied_hope_before: { type: "boolean" },
      },
    },
  },
  {
    type: "function",
    name: "generate_document_checklist",
    description: "Build/refresh the document checklist for the case's pathway. Before asking for sensitive documents, explain why they help. Speak the summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "simulate_payment_path",
    description:
      "Demo payment path only: no args → plan options; monthly_amount_usd → sets up the demo plan and completes a sample payment. Sample values only, never real card or bank numbers. For real deployment, route to the county payment processor handoff instead of collecting payment details.",
    parameters: {
      type: "object",
      properties: {
        monthly_amount_usd: { type: "string" },
        first_payment_date: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "route_to_partner",
    description: "Simulated warm referral: legal_aid, housing_counseling, application_help, veterans_affairs, or treasurer. Use for title/probate, urgent notices, hardship, application help, or payment-plan navigation.",
    parameters: {
      type: "object",
      properties: {
        partner_type: { type: "string", enum: ["legal_aid", "housing_counseling", "application_help", "veterans_affairs", "treasurer"] },
        summary: { type: "string" },
      },
      required: ["partner_type"],
    },
  },
  {
    type: "function",
    name: "schedule_callback",
    description: "Schedule a simulated callback at the resident's preferred time. Use when the resident asks for a person, has urgent risk, or seems overwhelmed.",
    parameters: {
      type: "object",
      properties: {
        preferred_time: { type: "string" },
        resident_name: { type: "string" },
      },
      required: ["preferred_time"],
    },
  },
  {
    type: "function",
    name: "submit_demo_intake",
    description:
      "Intake + documents complete → run the simulated submission and read the demo confirmation aloud. Always say it is simulated.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_case_summary",
    description: "Full current case state: status, intake, checklist, next step, and completion state. Use before summarizing progress or ending.",
    parameters: { type: "object", properties: {} },
  },
] as const;

/** Guarded compatibility tools routed through the case-mgmt dispatcher. */
export const CASE_MGMT_TOOLS = new Set([
  "save_intake_answer",
  "screen_program_fit",
  "generate_document_checklist",
  "upload_document_metadata",
  "simulate_payment_path",
  "route_to_partner",
  "schedule_callback",
  "create_human_followup_request",
  "flag_for_human_review",
  "submit_demo_intake",
  "get_case_summary",
  "end_or_save_conversation",
  // Legacy names kept for UI pages / back-compat (not registered with the model):
  "create_or_update_resident",
  "create_or_update_case",
  "record_contact_consent",
  "schedule_sms_reminder",
  "send_case_link",
  "create_human_review_task",
  "flag_case_for_review",
  "generate_packet_summary",
  "validate_packet_readiness",
  "prepare_simulated_submission",
  "submit_demo_packet",
  "generate_demo_confirmation",
  "calculate_demo_payment_options",
  "create_demo_payment_plan",
  "submit_demo_payment",
  "get_demo_payment_status",
  "complete_demo_enrollment",
  "classify_uploaded_document",
  "get_uploaded_documents",
  "get_missing_documents",
]);
