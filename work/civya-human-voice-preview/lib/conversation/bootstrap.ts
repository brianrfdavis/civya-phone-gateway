import type { SessionBootstrap } from "./contracts";

export function unauthenticatedBootstrap(input: { fictional?: boolean } = {}): SessionBootstrap {
  const fictional = input.fictional !== false;
  return {
    auth: { state: "none" },
    resume_context: {
      confirmed_facts: [],
      conversation_summary: "",
      recent_turns: [],
      current_workflow_state: "welcome",
    },
    next_action: { kind: "general" },
    persistence: {
      state: process.env.NODE_ENV === "production" ? "unavailable" : "degraded",
      message: "Start a conversation to create a private anonymous session.",
    },
    capabilities: {
      voice: Boolean(process.env.OPENAI_API_KEY),
      uploads: false,
      reminders: false,
      staff: false,
    },
    sandbox: { fictional, retention_days: fictional ? 30 : 0 },
  };
}

export function withAuthenticationState(
  bootstrap: SessionBootstrap,
  state: "anonymous" | "verified" | "declined",
): SessionBootstrap {
  return {
    ...bootstrap,
    auth: { ...bootstrap.auth, state },
    resident: bootstrap.resident
      ? { ...bootstrap.resident, authentication_state: state }
      : undefined,
    capabilities: {
      ...bootstrap.capabilities,
      uploads: state === "verified",
      reminders: state === "verified",
    },
  };
}
