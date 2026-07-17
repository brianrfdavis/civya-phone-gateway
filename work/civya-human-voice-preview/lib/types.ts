/** Shared types for the Civya Phase 1 PoC. */

export interface KnowledgeItem {
  intent: string;
  /** Short, voice-safe, plain-language, pre-approved wording. */
  approved_spoken_answer: string;
  /** Longer detail suitable for web/SMS display. */
  long_answer: string;
  disclaimer: string;
  /** The obvious next action to offer the resident. */
  next_step_prompt: string;
  allowed_next_questions: string[];
  /** Phrases/topics that force escalation to human review. */
  escalation_triggers: string[];
  /** Example resident utterances used for exact + semantic matching. */
  example_utterances: string[];
  source_url: string;
  last_reviewed: string;
  /** All PoC content ships as "draft" until county-verified. */
  status: "draft" | "approved";
  channels: { voice: boolean; sms: boolean; web: boolean };
}

export type CacheLayer =
  | "L1_exact"
  | "L2_semantic"
  | "L3_workflow"
  | "L4_model"
  | "L5_human_review";

export interface CacheResult {
  hit: boolean;
  layer: CacheLayer;
  intent?: string;
  answer?: string;
  next_step_prompt?: string;
  disclaimer?: string;
  source_url?: string;
  status?: string;
  escalated: boolean;
  similarity?: number;
  match_method?: "exact" | "embedding" | "keyword" | "model";
  resolve_ms: number;
}

export interface ResidentProfile {
  profile_id: string;
  name: string;
  address: string;
  city: string;
  ownership_status: "owner" | "heir" | "occupant_non_owner";
  primary_residence: boolean;
  senior: boolean;
  tax_status: {
    current_year_delinquent: boolean;
    prior_year_delinquent: boolean;
    total_owed_usd: number;
    years_delinquent: string[];
    foreclosure_risk: "none" | "watch" | "imminent";
    foreclosure_deadline?: string;
  };
  programs_applied: string[];
  eligibility_indicators: string[];
  document_status: Record<string, "received" | "missing" | "not_needed">;
  recommended_next_step: string;
}

export interface EligibilityResult {
  profile_id: string;
  likely_path: string;
  path_label: string;
  reasons: string[];
  next_step: string;
  urgency: "normal" | "elevated" | "urgent";
  needs_human_followup: boolean;
  needs_legal_referral: boolean;
}

export interface WorkflowState {
  id: string;
  question?: string;
  field?: string;
  /** Map of normalized answer value -> next state id or "outcome:<id>". */
  next?: Record<string, string>;
  outcome?: {
    path: string;
    path_label: string;
    next_step: string;
    urgency: "normal" | "elevated" | "urgent";
    needs_human_followup?: boolean;
    needs_legal_referral?: boolean;
    document_checklist?: string[];
  };
}

export interface WorkflowStepResult {
  state_id: string;
  question?: string;
  done: boolean;
  outcome?: WorkflowState["outcome"];
}

export interface LoggedEvent {
  ts: string;
  session_id: string;
  turn_id?: string;
  type: string;
  [key: string]: unknown;
}

export interface HumanFollowupRequest {
  id: string;
  ts: string;
  session_id: string;
  profile_id?: string;
  reason: string;
  transcript_summary?: string;
  status: "open";
}
