/**
 * The authoritative profile sees read-only lookups and explicit
 * resident-requested actions. Direct profiles add narrow intake, account,
 * silence, and ending controls below. The larger dispatcher surface remains
 * only for guarded compatibility.
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

const DIRECT_CONTROL_TOOLS = [
  {
    type: "function",
    name: "wait_for_user",
    description:
      "Use only for silence, background media, a side conversation, or an unfinished thought. After calling, say nothing and keep listening.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "request_secure_account",
    description:
      "Call before asking for or saving a name, address, parcel, contact detail, income, document, reminder, or other private information. Choose only the field category; the app supplies the safe question, pauses the microphone, and opens the secure account step. Never ask for an email code aloud.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        field: {
          type: "string",
          enum: [
            "property_address",
            "resident_name",
            "contact",
            "income_range",
            "document",
            "reminder",
            "private_detail",
          ],
        },
      },
      required: ["reason", "field"],
    },
  },
  {
    type: "function",
    name: "save_intake_answer",
    description:
      "Save at most one current guided-intake fact per resident turn. Allowed fields: property_address, resident_name, contact, owner_occupancy, municipality, notice_type, delinquency_years, hardship, income_range, household_size. Include the resident's source words. Never call for a question, refusal, repeat request, unclear correction, guess, or words Civya supplied. Speak spoken_text exactly.",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: [
            "property_address",
            "resident_name",
            "contact",
            "owner_occupancy",
            "municipality",
            "notice_type",
            "delinquency_years",
            "hardship",
            "income_range",
            "household_size",
          ],
        },
        source_text: { type: "string" },
      },
      required: ["field", "source_text"],
    },
  },
] as const;

const DIRECT_END_TOOL = {
  type: "function",
  name: "end_or_save_conversation",
  description:
    "Call only after the resident clearly confirms they want to end. Save progress and speak the returned final text.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", enum: ["resident_done", "callback_scheduled", "completed"] },
    },
    required: ["reason"],
  },
} as const;

function cloneAndFreeze<T>(tools: T): T {
  const clone = JSON.parse(JSON.stringify(tools)) as T;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

const DIRECT_REALTIME_TOOLS = [
  ...DIRECT_CONTROL_TOOLS,
  ...REALTIME_TOOLS,
  DIRECT_END_TOOL,
] as const;

/** Improved direct-response profile. This is a distinct frozen tool manifest. */
export const FAST_REALTIME_TOOLS = cloneAndFreeze(DIRECT_REALTIME_TOOLS);

/** July 14 compatibility profile. Keep independent from future fast edits. */
export const LEGACY_FAST_REALTIME_TOOLS = cloneAndFreeze(DIRECT_REALTIME_TOOLS);
