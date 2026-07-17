export type PhoneResponseMode = "phone_fast" | "renderer";

export const PHONE_FAST_PROFILE_VERSION = "phone-fast-v2-2026-07-17";
export const RENDERER_PROFILE_VERSION = "renderer-v2-2026-07-17";
export const DEFAULT_PHONE_MODEL = "gpt-realtime-2.1";
export const DEFAULT_PHONE_VOICE = "marin";
export const PHONE_RESPONSE_MAX_OUTPUT_TOKENS = "inf" as const;
export const PHONE_MODEL_ALLOWLIST = new Set(["gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
export const PHONE_VOICE_ALLOWLIST = new Set(["cedar", "marin"]);
const OFFICIAL_LOOKUP_LANGUAGE = /\b(?:current|today|latest|official|deadline|due date|date due|rate|interest|fee|amount|balance|owe|owed|eligible|eligibility|qualify|available now|open now|status|approved|receive|received|receiving|phone number|contact|address|hours|payment confirmed|completed)\b/i;
const OFFICIAL_CONTEXT_QUESTION = /\b(?:when|where|which|who|how much|what time)\b.{0,100}\b(?:tax(?:es)?|treasurer|office|program|payment|plan|foreclos\w*|auction|hearing|notice)\b|\b(?:tax(?:es)?|treasurer|office|program|payment|plan|foreclos\w*|auction|hearing|notice)\b.{0,100}\b(?:when|where|which|who|how much|what time)\b/i;

export const PHONE_FAST_INSTRUCTIONS = `
# Role

You are Civya, a fast, capable voice advocate for Wayne County residents dealing
with property-tax questions. Be on the caller's side. Help them understand what
is happening, see realistic options, and take the next useful step.

# Voice and conversation

Sound warm, grounded, compassionate, and confident—like a knowledgeable
neighbor. Never sound bureaucratic, patronizing, scripted, timid, or clinical.
Do not recite disclaimers, narrate rules, or repeatedly explain limitations.

Answer first. Use short, familiar words, active voice, and one idea at a time.
Usually speak for one to three short sentences, then pause. Ask one useful
question only when it moves the caller forward. Respect the caller's dignity;
never shame, lecture, talk down to them, or make them repeat their story.
Respond in the caller's language when you can do so reliably.

Speak naturally with warm emotional presence. Never imitate a racial or
cultural stereotype. Always finish the sentence and thought before pausing.

You are an AI assistant. Never claim to be a human, county employee, lawyer, or
decision-maker. Keep that boundary silent unless the caller directly asks.

# Facts and help

Use your understanding for empathy, clarification, plain-language explanation,
brainstorming, and general navigation. Before stating any current or official
date, deadline, rate, program availability, eligibility result, contact detail,
property or case status, balance, or completed action, call
get_official_answer. Say a natural short bridge first, such as “Let me check
that.” After the tool returns, use its approved speech and do not add facts.

Never ask for a Social Security number, password, verification code, card
number, or bank information. If private case details are needed, offer the
secure link. If the caller asks for a person, a text link, or to end the call,
respond naturally; call control will carry out that request.
`.trim();

export const PHONE_RENDERER_INSTRUCTIONS = [
  "You are Civya's phone voice renderer.",
  "Never originate advice, facts, amounts, dates, case status, eligibility, identity decisions, or completion claims.",
  "Automatic response creation is disabled. Speak only the exact approved text provided in each response instruction.",
  "Do not add, omit, summarize, or paraphrase words. You have no authority to change a case or official record.",
].join(" ");

export const OFFICIAL_ANSWER_TOOL = Object.freeze({
  type: "function",
  name: "get_official_answer",
  description: [
    "Call once before stating any current or official Wayne County date, deadline, rate, program availability, eligibility result, contact detail, property or case status, balance, or completed action.",
    "Do not call for greetings, empathy, clarification, ordinary conversation, or general navigation.",
    "The server uses the caller's exact current turn, so this function takes no arguments.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
});

export function readPhoneResponseMode(env: NodeJS.ProcessEnv = process.env): PhoneResponseMode {
  return env.CIVYA_PHONE_RESPONSE_MODE?.trim() === "renderer" ? "renderer" : "phone_fast";
}

export function readPhoneModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CIVYA_PHONE_REALTIME_MODEL?.trim();
  if (configured && PHONE_MODEL_ALLOWLIST.has(configured)) return configured;
  return readPhoneResponseMode(env) === "renderer" ? "gpt-realtime-2.1-mini" : DEFAULT_PHONE_MODEL;
}

export function readPhoneVoice(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CIVYA_PHONE_REALTIME_VOICE?.trim();
  return configured && PHONE_VOICE_ALLOWLIST.has(configured) ? configured : DEFAULT_PHONE_VOICE;
}

export function phoneProfileVersion(mode: PhoneResponseMode): string {
  return mode === "phone_fast" ? PHONE_FAST_PROFILE_VERSION : RENDERER_PROFILE_VERSION;
}

export function phoneTurnRequiresOfficialLookup(transcript: string): boolean {
  return OFFICIAL_LOOKUP_LANGUAGE.test(transcript) || OFFICIAL_CONTEXT_QUESTION.test(transcript);
}

export function buildPhoneRealtimeSession(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const mode = readPhoneResponseMode(env);
  const direct = mode === "phone_fast";
  return {
    type: "realtime",
    model: readPhoneModel(env),
    reasoning: { effort: "low" },
    instructions: direct ? PHONE_FAST_INSTRUCTIONS : PHONE_RENDERER_INSTRUCTIONS,
    output_modalities: ["audio"],
    // Audio consumes output tokens quickly. A small numeric cap can stop a
    // spoken reply mid-sentence, so rely on the concise prompt and let the
    // Realtime service use the model's full per-turn allowance.
    max_output_tokens: PHONE_RESPONSE_MAX_OUTPUT_TOKENS,
    ...(direct ? {
      tools: [OFFICIAL_ANSWER_TOOL],
      tool_choice: "auto",
    } : {}),
    include: ["item.input_audio_transcription.logprobs"],
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-transcribe",
          prompt: "Wayne County property tax assistance. Preserve the caller's spoken language.",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: direct ? 500 : 650,
          create_response: false,
          interrupt_response: true,
          idle_timeout_ms: 20_000,
        },
      },
      output: { voice: readPhoneVoice(env) },
    },
  };
}
