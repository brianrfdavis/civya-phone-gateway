export type ModelTask =
  | "realtime_voice"
  | "transcription"
  | "intent_extraction"
  | "grounded_summary"
  | "official_research";

export interface ModelTaskPolicy {
  task: ModelTask;
  defaultModel: string;
  allowedData: readonly string[];
  prohibitedAuthority: readonly string[];
  maxLatencyMs: number;
  maxInputTokens?: number;
  requiresStructuredOutput: boolean;
  fallback: "text" | "deterministic" | "human";
}

const registry: Record<ModelTask, ModelTaskPolicy> = {
  realtime_voice: {
    task: "realtime_voice",
    defaultModel: "gpt-realtime-2.1",
    allowedData: ["approved_spoken_text", "redacted_current_turn", "channel_state"],
    prohibitedAuthority: ["case_selection", "entitlement", "deadline", "amount", "eligibility", "handoff", "completion"],
    maxLatencyMs: 1_000,
    requiresStructuredOutput: false,
    fallback: "text",
  },
  transcription: {
    task: "transcription",
    defaultModel: "gpt-4o-transcribe",
    allowedData: ["ephemeral_audio"],
    prohibitedAuthority: ["identity", "entitlement", "case_fact", "completion"],
    maxLatencyMs: 2_500,
    requiresStructuredOutput: false,
    fallback: "text",
  },
  intent_extraction: {
    task: "intent_extraction",
    defaultModel: "gpt-5.6-luna",
    allowedData: ["redacted_resident_text", "approved_intent_taxonomy"],
    prohibitedAuthority: ["deadline", "amount", "eligibility", "routing", "completion"],
    maxLatencyMs: 1_500,
    maxInputTokens: 2_000,
    requiresStructuredOutput: true,
    fallback: "deterministic",
  },
  grounded_summary: {
    task: "grounded_summary",
    defaultModel: "gpt-5.6-terra",
    allowedData: ["redacted_turns", "approved_source_excerpts"],
    prohibitedAuthority: ["new_case_fact", "legal_advice", "deadline", "amount", "eligibility", "completion"],
    maxLatencyMs: 3_000,
    maxInputTokens: 6_000,
    requiresStructuredOutput: true,
    fallback: "human",
  },
  official_research: {
    task: "official_research",
    defaultModel: "gpt-5.6-sol",
    allowedData: ["redacted_public_question", "allowlisted_official_source_results"],
    prohibitedAuthority: ["private_case", "identity", "eligibility", "payment", "routing", "completion"],
    maxLatencyMs: 4_500,
    maxInputTokens: 2_000,
    requiresStructuredOutput: true,
    fallback: "deterministic",
  },
};

export function getModelTaskPolicy(task: ModelTask): ModelTaskPolicy {
  return registry[task];
}

export function listModelTaskPolicies(): readonly ModelTaskPolicy[] {
  return Object.values(registry);
}
