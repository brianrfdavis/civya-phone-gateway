import assert from "node:assert/strict";

import { readPstnRuntimeState } from "../services/call-control/config";
import {
  DEFAULT_PHONE_MODEL,
  DEFAULT_PHONE_VOICE,
  OFFICIAL_ANSWER_TOOL,
  PHONE_FAST_INSTRUCTIONS,
  PHONE_FAST_PROFILE_VERSION,
  PHONE_MODEL_ALLOWLIST,
  PHONE_RENDERER_INSTRUCTIONS,
  PHONE_VOICE_ALLOWLIST,
  RENDERER_PROFILE_VERSION,
  buildPhoneRealtimeSession,
  phoneProfileVersion,
  phoneTurnRequiresOfficialLookup,
  readPhoneModel,
  readPhoneResponseMode,
  readPhoneVoice,
} from "../services/call-control/phone-fast";

interface RealtimeSessionFixture {
  type: string;
  model: string;
  reasoning: { effort: string };
  instructions: string;
  output_modalities: string[];
  max_output_tokens: number;
  tools?: Array<{
    type: string;
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
  }>;
  tool_choice?: string;
  include: string[];
  audio: {
    input: {
      transcription: { model: string; prompt: string };
      turn_detection: {
        type: string;
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
        create_response: boolean;
        interrupt_response: boolean;
        idle_timeout_ms: number;
      };
    };
    output: { voice: string };
  };
}

function buildSession(env: NodeJS.ProcessEnv): RealtimeSessionFixture {
  return buildPhoneRealtimeSession(env) as unknown as RealtimeSessionFixture;
}

function testEnvironment(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values };
}

function assertFastProfile(): void {
  const env = testEnvironment({ CIVYA_PHONE_RESPONSE_MODE: "phone_fast" });
  const session = buildSession(env);

  assert.equal(readPhoneResponseMode(env), "phone_fast");
  assert.equal(readPhoneModel(env), DEFAULT_PHONE_MODEL);
  assert.equal(readPhoneVoice(env), DEFAULT_PHONE_VOICE);
  assert.equal(phoneProfileVersion("phone_fast"), PHONE_FAST_PROFILE_VERSION);

  assert.equal(session.type, "realtime");
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.equal(session.audio.output.voice, "cedar");
  assert.deepEqual(session.reasoning, { effort: "low" });
  assert.deepEqual(session.output_modalities, ["audio"]);
  assert.equal(session.max_output_tokens, 256);
  assert.deepEqual(session.include, ["item.input_audio_transcription.logprobs"]);
  assert.equal(session.audio.input.transcription.model, "gpt-4o-transcribe");

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: false,
    interrupt_response: true,
    idle_timeout_ms: 20_000,
  });

  assert.equal(session.instructions, PHONE_FAST_INSTRUCTIONS);
  assert.match(session.instructions, /Answer first\./);
  assert.match(session.instructions, /short, familiar words, active voice, and one idea at a time/i);
  assert.match(session.instructions, /one to three short sentences/i);
  assert.match(session.instructions, /Before stating any current or official[\s\S]*call\s+get_official_answer/i);
  assert.ok(
    session.instructions.length <= 2_000,
    `phone_fast instructions grew beyond the 2,000-character latency budget (${session.instructions.length})`,
  );

  assert.equal(session.tool_choice, "auto");
  assert.equal(session.tools?.length, 1);
  assert.deepEqual(session.tools?.[0], OFFICIAL_ANSWER_TOOL);
  assert.equal(session.tools?.[0]?.name, "get_official_answer");
  assert.deepEqual(session.tools?.[0]?.parameters, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.equal(phoneTurnRequiresOfficialLookup("What is the current deadline?"), true);
  assert.equal(phoneTurnRequiresOfficialLookup("Did the Treasurer receive my payment?"), true);
  assert.equal(phoneTurnRequiresOfficialLookup("When are summer property taxes due?"), true);
  assert.equal(phoneTurnRequiresOfficialLookup("Where is the Treasurer's office?"), true);
  assert.equal(phoneTurnRequiresOfficialLookup("I feel overwhelmed and need help understanding this"), false);
}

function assertRendererProfile(): void {
  const env = testEnvironment({
    CIVYA_PHONE_RESPONSE_MODE: "renderer",
    CIVYA_PHONE_REALTIME_VOICE: "marin",
  });
  const session = buildSession(env);

  assert.equal(readPhoneResponseMode(env), "renderer");
  assert.equal(readPhoneModel(env), "gpt-realtime-2.1-mini");
  assert.equal(readPhoneVoice(env), "marin");
  assert.equal(phoneProfileVersion("renderer"), RENDERER_PROFILE_VERSION);

  assert.equal(session.model, "gpt-realtime-2.1-mini");
  assert.equal(session.audio.output.voice, "marin");
  assert.deepEqual(session.reasoning, { effort: "low" });
  assert.equal(session.max_output_tokens, 512);
  assert.equal(session.audio.input.turn_detection.silence_duration_ms, 650);
  assert.equal(session.audio.input.turn_detection.create_response, false);
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);

  assert.equal(session.instructions, PHONE_RENDERER_INSTRUCTIONS);
  assert.match(session.instructions, /phone voice renderer/i);
  assert.match(session.instructions, /Speak only the exact approved text/i);
  assert.match(session.instructions, /Never originate advice, facts/i);
  assert.equal(session.tools, undefined);
  assert.equal(session.tool_choice, undefined);
}

function validPstnEnvironment(): NodeJS.ProcessEnv {
  return testEnvironment({
    CIVYA_ENABLE_PSTN: "true",
    CIVYA_TELEPHONY_MODE: "live",
    CIVYA_LANGUAGE_MODE: "live",
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_WEBHOOK_SECRET: "test-webhook-secret",
    CIVYA_WAYNE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    CIVYA_TWILIO_PHONE_NUMBER: "+13135550123",
    CIVYA_PHONE_TURN_URL: "https://civya.example/api/internal/phone/turn",
    CIVYA_PHONE_TURN_SERVICE_SECRET: "t".repeat(32),
    CIVYA_PHONE_DIGEST_SECRET: "d".repeat(32),
    CIVYA_PHONE_RESPONSE_MODE: "phone_fast",
    CIVYA_PHONE_REALTIME_MODEL: "gpt-realtime-2.1",
    CIVYA_PHONE_REALTIME_VOICE: "cedar",
    CIVYA_PSTN_ACCESS_MODE: "public",
    CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR: "5",
    CIVYA_PSTN_MAX_DURATION_SECONDS: "900",
    CIVYA_PSTN_MAX_CONCURRENT_CALLS: "4",
    CIVYA_PSTN_MAX_TURNS: "40",
    CIVYA_CALL_RECORDING_MODE: "disabled",
  });
}

function assertInvalidAllowlistBehavior(): void {
  assert.ok(PHONE_MODEL_ALLOWLIST.has("gpt-realtime-2.1"));
  assert.ok(PHONE_MODEL_ALLOWLIST.has("gpt-realtime-2.1-mini"));
  assert.ok(!PHONE_MODEL_ALLOWLIST.has("unqualified-realtime-model"));
  assert.ok(PHONE_VOICE_ALLOWLIST.has("cedar"));
  assert.ok(PHONE_VOICE_ALLOWLIST.has("marin"));
  assert.ok(!PHONE_VOICE_ALLOWLIST.has("alloy"));

  const invalidProfileEnv = testEnvironment({ CIVYA_PHONE_RESPONSE_MODE: "experimental" });
  const invalidModelEnv = testEnvironment({
    CIVYA_PHONE_RESPONSE_MODE: "phone_fast",
    CIVYA_PHONE_REALTIME_MODEL: "unqualified-realtime-model",
  });
  const invalidVoiceEnv = testEnvironment({ CIVYA_PHONE_REALTIME_VOICE: "alloy" });

  // Session construction stays fail-safe by falling back to the approved fast profile.
  assert.equal(readPhoneResponseMode(invalidProfileEnv), "phone_fast");
  assert.equal(readPhoneModel(invalidModelEnv), DEFAULT_PHONE_MODEL);
  assert.equal(readPhoneVoice(invalidVoiceEnv), DEFAULT_PHONE_VOICE);

  const validState = readPstnRuntimeState(validPstnEnvironment());
  assert.equal(validState.configured, true, validState.missing.join(", "));

  const invalidProfileState = readPstnRuntimeState({
    ...validPstnEnvironment(),
    CIVYA_PHONE_RESPONSE_MODE: "experimental",
  });
  assert.equal(invalidProfileState.configured, false);
  assert.ok(invalidProfileState.missing.includes("CIVYA_PHONE_RESPONSE_MODE=phone_fast|renderer"));

  const invalidModelState = readPstnRuntimeState({
    ...validPstnEnvironment(),
    CIVYA_PHONE_REALTIME_MODEL: "unqualified-realtime-model",
  });
  assert.equal(invalidModelState.configured, false);
  assert.ok(invalidModelState.missing.includes("CIVYA_PHONE_REALTIME_MODEL=qualified"));

  const invalidVoiceState = readPstnRuntimeState({
    ...validPstnEnvironment(),
    CIVYA_PHONE_REALTIME_VOICE: "alloy",
  });
  assert.equal(invalidVoiceState.configured, false);
  assert.ok(invalidVoiceState.missing.includes("CIVYA_PHONE_REALTIME_VOICE=cedar|marin"));
}

assertFastProfile();
assertRendererProfile();
assertInvalidAllowlistBehavior();

console.log("phone fast profile tests passed");
