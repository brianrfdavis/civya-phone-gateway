export type CaseStatus =
  | "started"
  | "intake_in_progress"
  | "documents_needed"
  | "packet_ready"
  | "simulated_submission_ready"
  | "simulated_submitted"
  | "simulated_payment_pending"
  | "simulated_payment_completed"
  | "follow_up_scheduled"
  | "human_review_required"
  | "closed";

export type AuthenticationState = "none" | "anonymous" | "verified" | "declined";
export type ConversationChannel = "voice" | "text";
export type PersistenceState = "saved" | "degraded" | "unavailable";
export type InteractionState =
  | "continue"
  | "auth_required"
  | "conversation_ended"
  | "general_only"
  | "retry";

export interface ResidentIdentity {
  id: string;
  authentication_state: AuthenticationState;
  masked_email?: string;
}

export interface ActiveCaseSummary {
  id: string;
  status: CaseStatus | string;
  row_version: number;
  next_best_action: string;
  property_address?: string;
  likely_pathways: string[];
  missing_documents: string[];
}

export interface RedactedTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  channel: ConversationChannel;
  created_at: string;
  redacted: true;
}

export interface ConfirmedFact {
  key: string;
  value: string;
  confirmed_at: string;
}

export interface ResumeContext {
  confirmed_facts: ConfirmedFact[];
  conversation_summary: string;
  recent_turns: RedactedTurn[];
  current_workflow_state: string;
  next_question?: string;
}

export interface SessionBootstrap {
  auth: {
    state: AuthenticationState;
    masked_email?: string;
    staff_role?: "reviewer" | "admin";
  };
  resident?: ResidentIdentity;
  active_case?: ActiveCaseSummary;
  conversation?: {
    id: string;
    status: "active" | "ended";
    pending_turn_id?: string;
  };
  resume_context: ResumeContext;
  next_action: {
    kind: "general" | "ask_question" | "auth_required" | "conversation_ended";
    question?: string;
  };
  auth_required?: AuthRequiredPayload;
  persistence: {
    state: PersistenceState;
    message?: string;
  };
  capabilities: {
    voice: boolean;
    uploads: boolean;
    reminders: boolean;
    staff: boolean;
  };
  tenant?: {
    id: string;
    slug: string;
    name: string;
    environment: "sandbox" | "development" | "staging" | "production";
    fictional: boolean;
  };
  sandbox: {
    fictional: boolean;
    retention_days: number;
  };
}

export interface TurnEnvelope {
  conversation_id?: string;
  provider_item_id?: string;
  client_turn_id: string;
  transcript: string;
  channel: ConversationChannel;
  idempotency_key: string;
  /** Present only when resuming a turn that was paused for verification. */
  pending_turn_id?: string;
}

export interface AuthRequiredPayload {
  reason: "sensitive_intake" | "document" | "reminder" | "saved_action";
  spoken_explanation: string;
  pending_turn_id: string;
  pending_question: string;
  allowed: ["email_otp", "decline"];
}

export interface TurnResult {
  conversation_id: string;
  client_turn_id: string;
  spoken_response: string;
  case_update?: ActiveCaseSummary;
  next_question?: string;
  /** Interaction lifecycle only. This is never an official outcome state. */
  interaction_state: InteractionState;
  auth_required?: AuthRequiredPayload;
  persistence: {
    state: PersistenceState;
    saved_at?: string;
    message?: string;
  };
  final?: boolean;
}

export interface EmailChallengeResult {
  ok: true;
  challenge_id: string;
  masked_email: string;
  expires_at: string;
  resend_after: string;
}
